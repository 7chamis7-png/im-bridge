"use strict";

/**
 * Phone plugin: a voice call treated as just another channel.
 *
 * Treating the call as a channel reuses the whole gate: inbound speech is
 * logged and bound to turns, and replies go through the normal outbound gate.
 *
 * Both ends are audio; text is only the intermediate form:
 *
 * ```
 *   call audio out -> loopback sound card monitor -> VAD -> local STT --+
 *                                                                     v
 *                                                        inbound of this leg (text)
 *                                                                     v
 *                                                        gate -> agent -> outbound gate
 *                                                                     v
 *   call mic in <- virtual mic <- virtual sink <- TTS <- strip [tags] <-+
 * ```
 *
 * All audio work happens in a separate call process (e.g. a Pipecat pipeline;
 * not part of this repo). This leg only exchanges text with it.
 *
 * Why inbound uses files and outbound uses a socket:
 * - Inbound must not be lost: spooled to disk, cursor advanced by the shared layer.
 * - Outbound expires: speaking after the call has ended is wrong. If the call
 *   process isn't connected, fail immediately so the outbound gate records it
 *   as undelivered instead of replaying it on the next call.
 *
 * Dialing/hanging up are UI actions of the WeChat leg (start_call/end_call);
 * this leg only handles speech once a call is live.
 *
 * Call-process socket protocol (one JSON object per line; any reply line = ack):
 *
 * - Full segment, from this plugin, after the agent finishes a segment:
 *     {"type":"say","operationId":"…","text":"…"}
 * - Streamed sentence, from the box while the turn is still being written
 *   (src/host/phone-stream.js; only for turns whose inbound came from this leg):
 *     {"type":"say","text":"…","stream":true,"turnId":"…"}
 *
 * The full segment always arrives too, so delivery and the cold log stay
 * exact. The call process should speak `stream:true` frames immediately and,
 * when the full segment arrives, skip the text it already spoke from stream
 * frames (speak only the remainder, if any). A call process that ignores
 * `stream:true` frames keeps the old behaviour.
 */

const fs = require("fs");
const net = require("net");
const path = require("path");

const { notSent } = require("../errors");

class PhonePlugin {
  /**
   * @param {object} opts
   * @param {string} [opts.inboxDir] where the call process spools transcribed owner speech
   * @param {string} [opts.socketPath] call process socket for outbound speech
   * @param {string} [opts.peerId] owner identity on this leg (must match GATE_OWNER_PHONE_ID)
   * @param {number} [opts.sendTimeoutMs] reply timeout before a send counts as undelivered
   * @param {function} [opts.log]
   */
  constructor({ inboxDir = "", socketPath = "", peerId = "", sendTimeoutMs = 8000, log = () => {} } = {}) {
    this.channel = "phone";
    this.transport = "pipecat";
    this.inboxDir = inboxDir;
    this.socketPath = socketPath;
    this.peerId = peerId;
    this.sendTimeoutMs = sendTimeoutMs;
    this.log = log;
    // §7.3 platform support. A call only carries audio; files/stickers/reactions have nowhere to go.
    this.capabilities = {
      send_text: "supported",            // spoken aloud (text -> speech in the call process)
      send_file: "unsupported",
      send_voice: "unsupported",         // the call itself is voice
      send_sticker: "unsupported",
      send_generated_image: "unsupported",
      react: "unsupported",
      // dialing/hang-up belong to the WeChat leg; unsupported here by design
      start_call: "unsupported",
      end_call: "unsupported",
    };
  }

  #files() {
    try {
      return fs.readdirSync(this.inboxDir).filter((f) => /^\d{12}\.json$/.test(f)).sort();
    } catch { return []; }
  }

  /** Poll spooled speech. Advancing the cursor belongs to the shared layer. */
  async poll({ since = 0 } = {}) {
    if (!String(this.inboxDir || "").trim()) return { items: [], cursor: since };
    const cur = Number(since) || 0;
    const items = [];
    for (const f of this.#files()) {
      const seq = Number(f.slice(0, 12));
      const full = path.join(this.inboxDir, f);
      if (seq <= cur) {                          // already consumed
        try { fs.unlinkSync(full); } catch { /* retry next time */ }
        continue;
      }
      let rec;
      try { rec = JSON.parse(fs.readFileSync(full, "utf8")); }
      catch {
        // a corrupt file must neither block the queue nor vanish silently
        try { fs.renameSync(full, full + ".bad"); } catch { /* ignore */ }
        this.log("[电话] 收件箱里有一条坏文件，已改名留证：" + f);
        continue;
      }
      items.push({ update_id: seq, cursor: seq, message: rec.raw || rec });
    }
    return { items, cursor: items.length ? items[items.length - 1].cursor : cur };
  }

  /**
   * Raw call-process event -> standard delivery.
   *
   * §0.5: this text is transcribed, not typed, and must be declared as such so
   * downstream (including the agent) knows it may contain recognition errors.
   */
  toDelivery(raw) {
    const id = String((raw && raw.peerId) || this.peerId || "");
    return {
      channel: this.channel,
      accountId: (raw && raw.accountId) || "phone",
      senderId: id,
      chatId: id,
      chatType: "private",
      nativeId: raw && raw.id != null ? String(raw.id) : "",
      receivedAt: (raw && raw.at) || new Date().toISOString(),
      text: String((raw && raw.text) || ""),
      media: [],
      processing: ["transcribed"],
    };
  }

  /**
   * Outbound: hand the agent's text to the call process to speak.
   *
   * If it cannot be delivered, throw notSent so the outbound gate records it.
   * Never queue it for a later call.
   */
  async send({ operationId, chatId, text, intent = "send_text" }) {
    if (!chatId) throw notSent("插件收到的目标为空——出闸应当先解析目标");
    if (intent !== "send_text") {
      throw notSent("phone leg can only speak, cannot handle intent " + intent);
    }
    const say = String(text || "").trim();
    if (!say) throw notSent("没有要说的话");
    if (!String(this.socketPath || "").trim()) throw notSent("电话这条腿没配 socket，递不过去");

    const payload = JSON.stringify({ type: "say", operationId, text: say }) + "\n";
    const res = await new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const sock = net.createConnection(this.socketPath);
      const timer = setTimeout(() => { try { sock.destroy(); } catch { /* already closed */ } finish({ ok: false, why: "通话进程没回音" }); }, this.sendTimeoutMs);
      let buf = "";
      sock.on("connect", () => sock.write(payload));
      sock.on("data", (c) => {
        buf += c.toString("utf8");
        const i = buf.indexOf("\n");
        if (i < 0) return;
        clearTimeout(timer);
        try { finish(JSON.parse(buf.slice(0, i))); }
        catch (e) { finish({ ok: false, why: "通话进程回的不是 JSON：" + ((e && e.message) || e) }); }
        try { sock.end(); } catch { /* already closed */ }
      });
      sock.on("error", (e) => {
        clearTimeout(timer);
        // ENOENT/ECONNREFUSED means no call in progress, not a fault
        const why = (e && (e.code === "ENOENT" || e.code === "ECONNREFUSED"))
          ? "现在没有通话" : ("连不上通话进程：" + ((e && e.message) || e));
        finish({ ok: false, why });
      });
    });
    if (!res || !res.ok) throw notSent("这句话没说出去 —— " + ((res && res.why) || "通话进程没接"));
    // speech has no message id to reference later
    return { nativeId: null, sentAs: "spoken" };
  }

  /**
   * Ready only while a call is actually live (the socket exists).
   * "Configured" is not enough: without a call every send would fail.
   */
  health() {
    const wired = Boolean(this.inboxDir && this.socketPath);
    let live = false;
    try { live = fs.statSync(this.socketPath).isSocket(); } catch { /* no call */ }
    return {
      platform: "supported",
      plugin: wired ? "wired" : "unwired",
      availability: live ? "ready" : "offline",
    };
  }
}

module.exports = { PhonePlugin };

/** Plugin descriptor. Not attached unless inbox dir and socket are configured. */
module.exports.leg = {
  name: "phone",
  slot: "phone",
  configKeys: [
    ["GATE_PHONE_INBOX_DIR", "directory where the call process spools transcribed owner speech"],
    ["GATE_PHONE_SOCKET", "call process socket; agent replies are sent here to be spoken"],
  ],
  // directory polling does not block; keep the interval short for low latency
  poll: { idleMsKey: "GATE_PHONE_IDLE_MS", idleMsDefault: 300 },
  make({ env, log }) {
    return new PhonePlugin({
      inboxDir: env.GATE_PHONE_INBOX_DIR,
      socketPath: env.GATE_PHONE_SOCKET,
      peerId: env.GATE_OWNER_PHONE_ID || "",
      sendTimeoutMs: Number(env.GATE_PHONE_SEND_TIMEOUT_MS || 8000),
      log,
    });
  },
};
