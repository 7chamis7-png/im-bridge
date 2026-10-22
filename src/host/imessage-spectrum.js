"use strict";

/**
 * iMessage 喂料进程（2026-09-19）—— 这条腿的**平台那一半**
 *
 * ```
 *   她 → Photon/Spectrum ──→ 这个进程 ──→ 收件箱目录 ──→ 桥的 imessage 插头
 *                                ▲
 *                                └── box.sock 之外的另一个口：他的话从这儿递回来
 * ```
 *
 * ## 为什么单独一个进程
 *
 * 插头**故意不 require spectrum-ts**（它自己的注释写着「连 SDK 的活不在这儿…
 * 这样插头能测、也换得掉」）。而且 SDK 有个硬约束：
 * **全机只有这一条连接，两个 SDK 实例会抢同一批入站** —— 所以老的
 * `cyberboss-imessage` 必须先停，这个才能起。
 *
 * 形状照电话那条腿抄的（`plugins/phone.js`）：**入站走文件、出站走 socket**。
 *   · 入站落盘 = 崩了不丢（她的话不能没）
 *   · 出站走 socket = 要当场知道成没成，不能"写个文件就当发了"
 *
 * ## 从老桥搬过来的规则（`adapters/channel/imessage/bridge.js`，逐条核对过）
 *
 * 搬的是**规则**不是代码。难的那段（SDK 调用）好抄，紧跟着的几个 if 最容易漏
 * 且不报错 —— 所以下面每条都写明白：
 *
 *   1. 白名单：不在 `ALLOWED` 里的入站忽略、出站拒发
 *   2. `spaces` 表：handle → space，收到过才记得住。**Photon 不许主动开新会话**，
 *      没有现成 space 只能试着 create，大概率被拒，错误原样回给调用方
 *   3. 出站没给 `to`：只有一个已知会话就用它（这条通道一辈子只有她一个人）
 *   4. 语音：< 512 字节当坏音频拒发（别发出去一段静音）
 *   5. 入站没正文但有附件 → `content.read()`：
 *        · 音频 → 转写，标成`【语音转写】`（别让他以为是她打字打的）
 *        · 转写为空 / 取不到 → **也要告诉他她说过话**，绝不静默吞
 *        · 其他附件 → 说清楚是什么类型、这条通道打不开
 *      （老桥原来是 `if (!text) continue`，实测丢了 36 次，同期文本才 39 次）
 *   6. 真的什么都没有 → 跳过并记一行日志
 *
 * ## 故意**不**搬的（老世界专属，搬过来就是把老毛病一起搬）
 *
 *   · `injectUserMessage` 走 runtime socket —— 新世界由桥送进盒子
 *   · `recordCold` / ConversationMemoryService —— **闸是唯一冷层写手**（铁律）
 *   · 拼 `<channel>` 标签 —— 新世界由盒子做（`gate-box-claudecode` 的 withOrigin）
 *   · `PRIVATE_NOTE` —— 防伪归信封和闸
 *   · ⚠️ **`from_is_alice="true"` 写死** —— 插头注释点名批评过的反面教材。
 *     认人归桥（`GATE_OWNER_IMESSAGE_ID`，可以写多个号），这儿只报**真实 handle**。
 */

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const { IMessagePlugin } = require("../gate/plugins/imessage");

const log = (m) => console.log(
  new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 19) + " 京时 | [iMessage] " + m,
);

/** 缺一个都别启动 —— 不许拿默认值猜（铁律 1）。 */
function readConfig(env = process.env) {
  const need = [
    ["GATE_IMESSAGE_INBOX_DIR", "推来的消息落哪个目录（桥从这儿捞）"],
    ["GATE_IMESSAGE_SOCKET", "监听哪个口子（桥把他的话递到这儿）"],
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
    // 白名单沿用老桥那个键，切换那天不用改 .env
    allowed: String(env.NOVA_IMESSAGE_ALLOWED_HANDLES || "")
      .split(",").map((s) => s.trim()).filter(Boolean),
  };
}

function writeLine(sock, obj) {
  try { sock.write(JSON.stringify(obj) + "\n"); return true; } catch { return false; }
}

async function main() {
  const cfg = readConfig();
  // 只借它的 `receive()` —— 原子落盘和序号那套逻辑已经在插头里，别抄第二份
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

  /** handle → space。**收到过消息才记得住** —— Photon 不许主动开新会话。 */
  const spaces = new Map();

  const allow = (handle) => !cfg.allowed.length || cfg.allowed.includes(handle);

  /** 拿到能往这个号发东西的 space。没有就试着建（多半被拒，错误照实往上抛）。 */
  async function spaceFor(handle) {
    let space = spaces.get(handle);
    if (space) return space;
    const user = await im.user(handle);
    space = await im.space.create(user);
    spaces.set(handle, space);
    return space;
  }

  // ——— 出站：桥把他的话递到这儿 ———
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
          // 没给目标就用唯一那个已知会话（这条通道一辈子只有她一个人，
          // 老桥 2026-09-15 就是栽在"缺 to"上）
          let handle = String(msg.chatId || "").trim();
          if (!handle && spaces.size === 1) handle = [...spaces.keys()][0];
          if (!handle) {
            throw new Error("没有目标（已知会话 " + spaces.size + " 个"
              + (spaces.size ? "：" + [...spaces.keys()].join(",") : "，她还没发过消息进来") + "）");
          }
          if (!allow(handle)) throw new Error("不在认的号里：" + handle);

          if (msg.type === "send_voice") {
            const b64 = String(msg.audioBase64 || "");
            if (!b64) throw new Error("缺 audioBase64");
            const bufAudio = Buffer.from(b64, "base64");
            // 太短的一定是坏的 —— 发出去就是一段静音，她只能干听
            if (bufAudio.length < 512) throw new Error(`音频只有 ${bufAudio.length} 字节，不对劲，没敢发`);
            const space = await spaceFor(handle);
            // ElevenLabs 出 mp3，iMessage 语音气泡要 m4a —— SDK 的 voice() 内部
            // 走 ensureM4a 用 ffmpeg 转，再 uploadVoice + sendAttachment({isAudioMessage:true})，
            // 是**真语音气泡**，不是附件。
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
          // iMessage 这条路 SDK 不回消息 ID —— 是渠道限制，不是故障，照实说 null
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

  try { fs.unlinkSync(cfg.socketPath); } catch { /* 没有就算了 */ }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.socketPath, () => { server.removeListener("error", reject); resolve(); });
  });
  fs.chmodSync(cfg.socketPath, 0o600);
  log("出站口开在 " + cfg.socketPath);
  log("收件箱 " + cfg.inboxDir);

  const bye = (sig) => {
    log("收到 " + sig + "，关门。");
    try { server.close(); } catch { /* 无所谓 */ }
    try { fs.unlinkSync(cfg.socketPath); } catch { /* 无所谓 */ }
    process.exit(0);
  };
  process.on("SIGINT", () => bye("SIGINT"));
  process.on("SIGTERM", () => bye("SIGTERM"));

  // ——— 入站 ———
  for await (const [space, message] of app.messages) {
    const from = String(message?.sender?.id || "");
    if (!allow(from)) { log("忽略不认的号 from=" + from); continue; }
    spaces.set(from, space);

    let body = message?.content?.text;
    const content = message?.content;
    let attachmentKind = "";

    // 没正文但有附件 —— **绝不静默丢**（老桥原来 `if (!text) continue`，丢了 36 次）
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
            // 标出来是转写 —— 别让他以为这是她打字打的
            body = "【语音转写】" + said;
            log(`语音转写成功 from=${from}（${said.length} 字）`);
          } else {
            body = "【她发来一段语音，转写出来是空的 —— 你可以直接问她说了什么】";
            log("⚠️ 语音转写为空 from=" + from);
          }
        } else {
          attachmentKind = "file";
          body = `【她发来一个附件（${mime || "类型未知"}），iMessage 这条通道现在只认语音和文字，`
            + "你这儿打不开 —— 需要的话让她换个渠道发】";
          log(`非语音附件 from=${from} mime=${mime}`);
        }
      } catch (e) {
        // 失败也要让他知道她说过话
        body = "【她发来一段语音，但我这儿没取到/没转出来 —— 别当她没说话，问她一句】";
        log(`附件处理失败 from=${from}：${(e && e.message) || e}`);
      } finally {
        if (tmp) { try { fs.unlinkSync(tmp); } catch { /* 临时文件，清不掉算了 */ } }
      }
    }

    if (!body || !String(body).trim()) { log("真·空消息，跳过 from=" + from); continue; }

    // 交给插头落盘。**字段名照插头的 `toDelivery` 来**（handle / id / date / text），
    // 对不上就是那种"测试全绿、接上就空"的接线 bug。
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
