"use strict";

/**
 * iMessage plugin.
 *
 * Per SPEC §0.1 a plugin does exactly two things:
 *   inbound:  fetch from the platform + all platform-specific processing, then deliver
 *   outbound: turn the gate's target + content into a platform action
 *
 * It has no access to the cold log, does not assign ids, and never chooses
 * the recipient (the outbound gate does). Per §0.5 each delivery declares
 * which processing steps were applied.
 *
 * The actual Spectrum SDK connection lives in a separate feeder process
 * (src/host/imessage-spectrum.js); this plugin talks to it over a socket.
 */

const fs = require("fs");
const net = require("net");
const path = require("path");

const { notSent } = require("../errors");

class IMessagePlugin {
  /**
   * @param {object} opts
   * @param {function} opts.sender  test stub that "sends" to iMessage
   * @param {string} [opts.inboxDir] pushed messages are spooled here (see `receive`).
   *   Without it this leg can send but not receive.
   * @param {function} [opts.log]
   */
  constructor({ sender = null, inboxDir = "", socketPath = "", sendTimeoutMs = 20_000, log = () => {} } = {}) {
    this.channel = "imessage";
    // `sender` is a test seam. Production uses `socketPath`: the Spectrum connection
    // is owned exclusively by the feeder process, because two SDK instances on one
    // account would compete for the same inbound events.
    this.sender = sender;
    this.inboxDir = inboxDir;
    this.socketPath = socketPath;
    this.sendTimeoutMs = sendTimeoutMs;
    this.log = log;
    // §7.3 platform support: what the protocol offers, not what this plugin implements
    this.capabilities = {
      send_text: "supported",
      send_file: "supported",
      // The platform supports real voice bubbles (sendAttachment with isAudioMessage).
      send_voice: "supported",
      send_sticker: "unsupported",
      send_generated_image: "supported",     // images are attachments, same path as send_file
      react: "unsupported",
      // FaceTime is out of scope
      start_call: "unsupported",
      end_call: "unsupported",
    };
  }

  /**
   * Receive: this leg is push-based, not pull-based.
   *
   * Telegram and WeChat can be polled; the Spectrum SDK is subscription-based.
   * So pushed events are spooled to disk first and `poll()` reads from disk:
   *   · on disk = survives crashes (an in-memory buffer would not)
   *   · `poll()` keeps the same interface as other legs
   *   · one file per message + tmp->rename, same shape as the producer inbox
   *
   * The SDK connection is not here (no spectrum-ts require); the host calls
   * `receive(raw)` for each event. This keeps the plugin testable and swappable.
   *
   * @param {object} raw raw platform event
   * @returns {{seq:number, file:string}}
   */
  receive(raw) {
    if (!String(this.inboxDir || "").trim()) {
      throw new Error("iMessage plugin needs inboxDir to receive messages (no default is guessed)");
    }
    fs.mkdirSync(this.inboxDir, { recursive: true, mode: 0o700 });
    // sequence continues across restarts
    const seq = this.#nextSeq();
    const name = String(seq).padStart(12, "0") + ".json";
    const full = path.join(this.inboxDir, name);
    const tmp = path.join(this.inboxDir, "." + name + ".tmp-" + process.pid);
    fs.writeFileSync(tmp, JSON.stringify({ seq, at: new Date().toISOString(), raw }), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, full);          // atomic: never leaves a half-written file
    return { seq, file: full };
  }

  #files() {
    try {
      return fs.readdirSync(this.inboxDir)
        .filter((f) => /^\d{12}\.json$/.test(f))
        .sort();
    } catch { return []; }
  }

  /**
   * Sequence numbers are strictly increasing. "max on disk + 1" alone is wrong:
   * consumed files are deleted, so an empty inbox would restart at 1, which is
   * already behind the shared cursor and would be silently dropped as "seen".
   * A `.last-seq` counter is persisted; next = max(onDisk, saved) + 1.
   */
  #nextSeq() {
    const all = this.#files();
    const onDisk = all.length ? Number(all[all.length - 1].slice(0, 12)) : 0;
    let saved = 0;
    try { saved = Number(fs.readFileSync(path.join(this.inboxDir, ".last-seq"), "utf8").trim()) || 0; } catch { /* first run */ }
    const seq = Math.max(onDisk, saved) + 1;
    try { fs.writeFileSync(path.join(this.inboxDir, ".last-seq"), String(seq), { mode: 0o600 }); } catch { /* fall back to on-disk max next time */ }
    return seq;
  }

  /**
   * Poll: read unconsumed messages from disk.
   *
   * Advancing the cursor after processing belongs to the shared layer (receiver.js).
   * Files with `seq <= since` were already confirmed and are removed here.
   */
  async poll({ since = 0 } = {}) {
    if (!String(this.inboxDir || "").trim()) return { items: [], cursor: since };
    const cur = Number(since) || 0;
    const items = [];
    for (const f of this.#files()) {
      const seq = Number(f.slice(0, 12));
      const full = path.join(this.inboxDir, f);
      if (seq <= cur) {                       // already consumed
        try { fs.unlinkSync(full); } catch { /* retry next time */ }
        continue;
      }
      let rec;
      try { rec = JSON.parse(fs.readFileSync(full, "utf8")); }
      catch {
        // a corrupt file must neither block the queue nor vanish silently
        try { fs.renameSync(full, full + ".bad"); } catch { /* ignore */ }
        this.log("[imessage] 收件箱里有一条坏文件，已改名留证：" + f);
        continue;
      }
      items.push({ update_id: seq, cursor: seq, message: rec.raw });
    }
    return { items, cursor: items.length ? items[items.length - 1].cursor : cur };
  }

  /** Raw platform event -> standard delivery. iMessage text is plain, no decoding needed. */
  toDelivery(raw) {
    const hasText = Boolean(raw && raw.text);
    const media = [];
    if (raw && raw.attachmentKind) media.push({ kind: raw.attachmentKind, ref: raw.attachmentPath || "" });

    return {
      channel: this.channel,
      accountId: (raw && raw.accountId) || "imessage",
      // real platform identity, never hard-coded
      senderId: (raw && raw.handle) || "",
      chatId: (raw && raw.handle) || "",
      chatType: "private",
      nativeId: raw && raw.id != null ? String(raw.id) : "",  // native platform id, not a file line number
      receivedAt: (raw && raw.date) || new Date().toISOString(),
      text: hasText ? String(raw.text) : "",
      media,
      // §0.5 processing declaration: plain text, nothing applied
      processing: ["none"],
    };
  }

  /**
   * Outbound: target and content come from the outbound gate and must not be altered.
   *
   * Default deny: only explicitly implemented intents are handled; others fail
   * instead of being degraded to text (guarded by test/gate/plugin-intents.js).
   * "Platform supports it" and "this plugin implements it" are different things.
   */
  async send({ operationId, chatId, text, intent = "send_text" }) {
    if (!chatId) throw notSent("插件收到的目标为空——出闸应当先解析目标");
    if (intent !== "send_text") {
      throw notSent("iMessage leg does not implement intent " + intent + " (platform supports it, plugin does not)");
    }
    const say = String(text || "");
    // test stub first; production goes through the feeder socket
    if (typeof this.sender === "function") {
      const nativeId = await this.sender({ chatId, text: say, operationId });
      return { nativeId: nativeId || null };
    }
    if (!String(this.socketPath || "").trim()) {
      throw notSent("iMessage leg has no socket configured (is the im-imessage feeder running?)");
    }
    const res = await this.#ask({ type: "send_text", operationId, chatId, text: say });
    if (!res || !res.ok) throw notSent("这条没发出去 —— " + ((res && res.why) || "喂料进程没接"));
    return { nativeId: res.nativeId || null };
  }

  /** Send one request to the feeder and wait for the reply. One connection per request. */
  #ask(payload) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const sock = net.createConnection(this.socketPath);
      const timer = setTimeout(() => {
        try { sock.destroy(); } catch { /* already closed */ }
        finish({ ok: false, why: "喂料进程没回音（等了 " + Math.round(this.sendTimeoutMs / 1000) + " 秒）" });
      }, this.sendTimeoutMs);
      let buf = "";
      sock.on("connect", () => sock.write(JSON.stringify(payload) + "\n"));
      sock.on("data", (c) => {
        buf += c.toString("utf8");
        const i = buf.indexOf("\n");
        if (i < 0) return;
        clearTimeout(timer);
        try { finish(JSON.parse(buf.slice(0, i))); }
        catch (e) { finish({ ok: false, why: "喂料进程回的不是 JSON：" + ((e && e.message) || e) }); }
        try { sock.end(); } catch { /* already closed */ }
      });
      sock.on("error", (e) => {
        clearTimeout(timer);
        const why = (e && (e.code === "ENOENT" || e.code === "ECONNREFUSED"))
          ? "feeder process not running (im-imessage)" : ("连不上喂料进程：" + ((e && e.message) || e));
        finish({ ok: false, why });
      });
    });
  }

  health() {
    // Must match what send() actually uses: a test `sender` or a production `socketPath`.
    const canSend = typeof this.sender === "function" || Boolean(String(this.socketPath || "").trim());
    return { platform: "supported", plugin: "wired", availability: canSend ? "ready" : "offline" };
  }
}

module.exports = { IMessagePlugin };

/** Plugin descriptor. Not attached unless the inbox dir and socket are configured. */
module.exports.leg = {
  name: "imessage",
  slot: "imessage",
  configKeys: [
    ["GATE_IMESSAGE_INBOX_DIR", "directory where the feeder spools incoming iMessages"],
    ["GATE_IMESSAGE_SOCKET", "feeder socket used to send outbound messages"],
  ],
  poll: { idleMs: 1500 },
  make({ env, log }) {
    return new IMessagePlugin({
      inboxDir: env.GATE_IMESSAGE_INBOX_DIR,
      socketPath: env.GATE_IMESSAGE_SOCKET,
      sendTimeoutMs: Number(env.GATE_IMESSAGE_SEND_TIMEOUT_MS || 20_000),
      log,
    });
  },
};
