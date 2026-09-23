"use strict";

/**
 * iMessage feeder process — the platform half of the iMessage leg.
 *
 * ```
 *   owner → Photon/Spectrum ──→ this process ──→ inbox dir ──→ gate imessage plugin
 *                                   ▲
 *                                   └── separate socket: the agent's replies come back here
 * ```
 *
 * ## Why a separate process
 *
 * The plugin intentionally does not require spectrum-ts (so it stays testable and
 * replaceable). The SDK also allows only one connection per project: two SDK
 * instances would compete for the same inbound messages.
 *
 * Same shape as the phone leg (plugins/phone.js): inbound via files, outbound via socket.
 *   - inbound written to disk = nothing is lost on crash
 *   - outbound over a socket = the result is known immediately
 *
 * ## Rules
 *
 *   1. Allow-list: inbound from handles not in AGENT_IMESSAGE_ALLOWED_HANDLES is
 *      ignored and outbound to them is refused (empty list = no restriction).
 *   2. `spaces`: handle → space, learned from inbound messages. Photon does not
 *      allow opening new conversations; without a known space we try to create
 *      one, which will usually fail, and the error is passed back as-is.
 *   3. Outbound without `to`: if exactly one conversation is known, use it.
 *   4. Voice: < 512 bytes is treated as broken audio and refused.
 *   5. Inbound with no text but an attachment → `content.read()`:
 *        - audio → transcribe, marked `【语音转写】` so it is not mistaken for typed text
 *        - empty / failed transcription → still tell the agent a message arrived,
 *          never drop it silently
 *        - other attachments → say what type it was and that it cannot be opened here
 *   6. Truly empty → skip and log.
 *
 * ## Deliberately not done here
 *
 *   - Writing the cold layer: the gate is the only cold-layer writer.
 *   - Building `<channel>` tags: done by the box.
 *   - Deciding who the owner is: identity belongs to the gate
 *     (`GATE_OWNER_IMESSAGE_ID`, comma-separated); this process only reports the
 *     real handle.
 */

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const { IMessagePlugin } = require("../gate/plugins/imessage");

const log = (m) => console.log(new Date().toISOString() + " | [iMessage] " + m);

/** Refuse to start with missing config — never guess defaults. */
function readConfig(env = process.env) {
  const need = [
    ["GATE_IMESSAGE_INBOX_DIR", "推来的消息落哪个目录（桥从这儿捞）"],
    ["GATE_IMESSAGE_SOCKET", "监听哪个 socket（桥把 agent 的回复递到这儿）"],
    ["PHOTON_PROJECT_ID", "Photon 项目 id"],
    ["PHOTON_PROJECT_SECRET", "Photon 项目密钥"],
  ];
  const missing = need.filter(([k]) => !String(env[k] || "").trim());
  if (missing.length) {
    throw new Error("iMessage 喂料进程缺配置，一个都不许猜：\n"
      + missing.map(([k, why]) => "  " + k + "  —— " + why).join("\n"));
  }
  return {
    inboxDir: env.GATE_IMESSAGE_INBOX_DIR,
    socketPath: env.GATE_IMESSAGE_SOCKET,
    projectId: env.PHOTON_PROJECT_ID,
    projectSecret: env.PHOTON_PROJECT_SECRET,
    // Allow-list of handles (phone numbers / Apple ID emails), comma-separated
    allowed: String(env.AGENT_IMESSAGE_ALLOWED_HANDLES || "")
      .split(",").map((s) => s.trim()).filter(Boolean),
  };
}

function writeLine(sock, obj) {
  try { sock.write(JSON.stringify(obj) + "\n"); return true; } catch { return false; }
}

async function main() {
  const cfg = readConfig();
  // Reuse the plugin's receive(): atomic writes and sequencing already live there
  const inbox = new IMessagePlugin({ inboxDir: cfg.inboxDir, log });

  const { Spectrum, text: textContent, voice: voiceContent } = require("spectrum-ts");
  const { imessage } = require("spectrum-ts/providers/imessage");

  const app = await Spectrum({
    projectId: cfg.projectId,
    projectSecret: cfg.projectSecret,
    providers: [imessage.config()],
  });
  const im = imessage(app);
  log("连上 Spectrum 了。认的号：" + (cfg.allowed.join(" / ") || "(没限制)"));

  /** handle → space, learned from inbound (Photon does not allow opening new conversations). */
  const spaces = new Map();

  const allow = (handle) => !cfg.allowed.length || cfg.allowed.includes(handle);

  /** Space for sending to this handle; tries to create one if unknown (usually refused; error propagates). */
  async function spaceFor(handle) {
    let space = spaces.get(handle);
    if (space) return space;
    const user = await im.user(handle);
    space = await im.space.create(user);
    spaces.set(handle, space);
    return space;
  }

  // --- Outbound: the gate hands the agent's replies to this socket ---
  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", async (chunk) => {
      buf += chunk.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); }
        catch (e) { writeLine(sock, { ok: false, why: "不是 JSON：" + e.message }); continue; }
        try {
          // No target: use the only known conversation, if there is exactly one
          let handle = String(msg.chatId || "").trim();
          if (!handle && spaces.size === 1) handle = [...spaces.keys()][0];
          if (!handle) {
            throw new Error("没有目标（已知会话 " + spaces.size + " 个"
              + (spaces.size ? "：" + [...spaces.keys()].join(",") : "，还没有人发过消息进来") + "）");
          }
          if (!allow(handle)) throw new Error("不在认的号里：" + handle);

          if (msg.type === "send_voice") {
            const b64 = String(msg.audioBase64 || "");
            if (!b64) throw new Error("缺 audioBase64");
            const bufAudio = Buffer.from(b64, "base64");
            // Too short to be real audio — would arrive as silence
            if (bufAudio.length < 512) throw new Error(`音频只有 ${bufAudio.length} 字节，不对劲，没敢发`);
            const space = await spaceFor(handle);
            // TTS produces mp3; iMessage voice bubbles need m4a. The SDK's voice()
            // converts via ffmpeg and sends a real voice bubble, not a file attachment.
            await space.send(voiceContent(bufAudio, { mimeType: String(msg.mimeType || "audio/mpeg") }));
            log(`语音发出 → ${handle}（${bufAudio.length} 字节）`);
            writeLine(sock, { ok: true, nativeId: null });
            continue;
          }

          const say = String(msg.text || "").trim();
          if (!say) throw new Error("没有要发的正文");
          const space = await spaceFor(handle);
          await space.send(textContent(say));
          log(`发出 → ${handle}（${say.length} 字）`);
          // The SDK returns no message id on this path (channel limitation): report null
          writeLine(sock, { ok: true, nativeId: null });
        } catch (e) {
          const why = (e && e.message) || String(e);
          log("发送失败：" + why.slice(0, 160));
          writeLine(sock, { ok: false, why });
        }
      }
    });
    sock.on("error", (e) => log("出站连接出错：" + ((e && e.message) || e)));
  });

  try { fs.unlinkSync(cfg.socketPath); } catch { /* not there */ }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.socketPath, () => { server.removeListener("error", reject); resolve(); });
  });
  fs.chmodSync(cfg.socketPath, 0o600);
  log("出站口开在 " + cfg.socketPath);
  log("收件箱 " + cfg.inboxDir);

  const bye = (sig) => {
    log("收到 " + sig + "，关门。");
    try { server.close(); } catch { /* ignore */ }
    try { fs.unlinkSync(cfg.socketPath); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGINT", () => bye("SIGINT"));
  process.on("SIGTERM", () => bye("SIGTERM"));

  // --- Inbound ---
  for await (const [space, message] of app.messages) {
    const from = String(message?.sender?.id || "");
    if (!allow(from)) { log("忽略不认的号 from=" + from); continue; }
    spaces.set(from, space);

    let body = message?.content?.text;
    const content = message?.content;
    let attachmentKind = "";

    // No text but an attachment: never drop silently
    if ((!body || !String(body).trim()) && content && typeof content.read === "function") {
      const mime = String(content.mimeType || "");
      const isAudio = /^audio\//i.test(mime)
        || /\.(m4a|caf|amr|mp3|wav|ogg)$/i.test(String(content.name || ""));
      let tmp = "";
      try {
        const bytes = await content.read();
        const ext = (mime.split("/")[1] || "m4a").replace(/[^a-z0-9]/gi, "") || "m4a";
        tmp = path.join(os.tmpdir(), `im-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.${ext}`);
        fs.writeFileSync(tmp, bytes);
        if (isAudio) {
          attachmentKind = "voice";
          const { transcribeAudioFile } = require("../services/transcription-service");
          const said = String(await transcribeAudioFile(tmp) || "").trim();
          if (said) {
            // Mark as a transcript so it is not mistaken for typed text
            body = "【语音转写】" + said;
            log(`语音转写成功 from=${from}（${said.length} 字）`);
          } else {
            body = "【owner 发来一段语音，转写出来是空的 —— 可以直接问 owner 说了什么】";
            log("⚠️ 语音转写为空 from=" + from);
          }
        } else {
          attachmentKind = "file";
          body = `【owner 发来一个附件（${mime || "类型未知"}），iMessage 这条通道现在只认语音和文字，`
            + "这里打不开 —— 需要的话请 owner 换个渠道发】";
          log(`非语音附件 from=${from} mime=${mime}`);
        }
      } catch (e) {
        // Even on failure, the agent must know a message arrived
        body = "【owner 发来一段语音，但没取到/没转出来 —— 别当作没说话，问一句】";
        log(`附件处理失败 from=${from}：${(e && e.message) || e}`);
      } finally {
        if (tmp) { try { fs.unlinkSync(tmp); } catch { /* temp file */ } }
      }
    }

    if (!body || !String(body).trim()) { log("真·空消息，跳过 from=" + from); continue; }

    // Hand to the plugin. Field names must match the plugin's `toDelivery`
    // (handle / id / date / text); see test/gate/imessage-wiring.js.
    const { seq } = inbox.receive({
      handle: from,
      id: String(message?.id || ""),
      date: new Date().toISOString(),
      text: String(body),
      accountId: "imessage",
      ...(attachmentKind ? { attachmentKind } : {}),
    });
    log(`收到 from=${from}（${String(body).length} 字），落收件箱 #${seq}`);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error("[iMessage] 挂了：", (e && e.message) || e); process.exit(1); });
}

module.exports = { main, readConfig };
