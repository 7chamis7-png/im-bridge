"use strict";
/**
 * 这座桥最值钱的部分：公共能力注册一次，所有渠道共用。
 * 重点验「接第五个前端时，转写/合成一行都不用写」。隔离跑。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { GateStore } = require("../../src/gate/store");
const { ColdWriter } = require("../../src/gate/cold-writer");
const { InboundGate } = require("../../src/gate/inbound");
const { OutboundGate } = require("../../src/gate/outbound");
const { Capabilities } = require("../../src/gate/capabilities");
const { TelegramPlugin } = require("../../src/gate/plugins/telegram");
const { WeChatPlugin } = require("../../src/gate/plugins/wechat");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-caps-"));
const store = new GateStore({ root });
const cold = new ColdWriter({ file: path.join(root, "cold.jsonl") });

// ===== 公共能力：每样只注册一份 =====
let ttsCalls = 0, asrCalls = 0;
const caps = new Capabilities();
caps.register("synthesize_voice", async ({ text }) => { ttsCalls += 1; return { kind: "voice", bytes: text.length }; });
caps.register("transcribe", async () => { asrCalls += 1; return "这是转出来的文字"; });

const sent = [];
const mk = (ch) => async (a) => { sent.push({ ch, ...a }); return ch + "-" + sent.length; };

// ===== 第五个渠道：只写平台收发 + 能力声明，一行转写/合成都没有 =====
class SignalPlugin {
  constructor({ sender, caps: c }) {
    this.channel = "signal";
    this.sender = sender;
    this.caps = c;                       // 公共能力从注册表取，不自己实现
    this.capabilities = { send_text: "supported", send_voice: "supported", send_file: "supported" };
  }
  async toDelivery(raw) {
    let text = raw.text || "";
    const processing = [];
    const media = [];
    if (raw.voiceRef) {
      media.push({ kind: "voice", ref: raw.voiceRef });
      text = await this.caps.call("transcribe", { ref: raw.voiceRef });   // ← 共用，没自己写
      processing.push("transcribed");
    }
    if (!processing.length) processing.push("none");
    return { channel: this.channel, accountId: "sig", senderId: raw.from, chatId: raw.from,
      chatType: "private", nativeId: String(raw.id), receivedAt: new Date().toISOString(),
      text, media, processing };
  }
  async send({ chatId, text, intent, asset, operationId }) {
    return this.sender({ chatId, text, intent, asset, operationId });
  }
  health() { return { platform: "supported", plugin: "wired", availability: "ready" }; }
}

const tg = new TelegramPlugin({ sender: mk("telegram"), transcribe: async () => caps.call("transcribe", {}) });
const wx = new WeChatPlugin({ sender: mk("wechat") });
const sg = new SignalPlugin({ sender: mk("signal"), caps });

const inGate = new InboundGate({ store, cold, identities: { "signal:+111": "alice", "telegram:1000000001": "alice", "wechat:Alice-wx": "alice" } });
const outGate = new OutboundGate({ store, cold, caps,
  plugins: new Map([["telegram", tg], ["wechat", wx], ["signal", sg]]) });

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + name + (ok ? "" : "  got=" + JSON.stringify(got) + " want=" + JSON.stringify(want)));
  ok ? pass++ : fail++;
}

(async () => {
  console.log("\n[1] 能力只能有一份实现");
  let threw = false;
  try { caps.register("transcribe", async () => "另一份"); } catch { threw = true; }
  check("重复注册直接报错", threw, true);
  check("注册表里有哪些", caps.list(), ["synthesize_voice", "transcribe"]);

  console.log("\n[2] 第五个渠道：语音转写一行没写，直接就有");
  const d = await sg.toDelivery({ id: 1, from: "+111", voiceRef: "sig-voice-1" });
  check("转写生效", d.text, "这是转出来的文字");
  check("声明了 transcribed", d.processing, ["transcribed"]);
  check("用的是公共实现（调用计数 +1）", asrCalls, 1);
  const ev = inGate.accept(d);
  check("入闸接受", ev.event.verdict, "accepted");

  console.log("\n[3] 发语音：支持的渠道正常走");
  const r1 = await outGate.deliver({ turnId: "v1", intent: "send_voice", text: "晚安",
    replyToEventId: ev.event.eventId, inboundEvent: ev.event });
  check("发出去了", r1.outcome, "sent");
  check("公共 TTS 被调用一次", ttsCalls, 1);
  check("插件拿到了生成好的资产", sent[sent.length - 1].asset.kind, "voice");

  console.log("\n[4] 不支持的渠道：预检拦住，而且一分钱不花 (7.1)");
  // ⚠️ 2026-09-18 换了例子：这里原来拿「微信发语音」当"平台不支持"的样板，
  //    但那天微信**能发语音了**（虚拟麦克风让它自己录）。立意没变 ——
  //    **平台给不了的意图，要在花钱之前就拦住**，只是改用微信真给不了的那个：
  //    消息表情回应（微信压根没有这个功能）。
  const wxEv = inGate.accept(wx.toDelivery({ local_id: 1, local_type: 1, create_time: 1789600000,
    sender: "Alice-wx", raw: Buffer.from("在吗", "utf8") }));
  const before = ttsCalls;
  const sentBefore = sent.length;
  const r2 = await outGate.deliver({ turnId: "v2", intent: "react", text: "❤️",
    replyToEventId: wxEv.event.eventId, inboundEvent: wxEv.event });
  check("明确拒绝", r2.outcome, "blocked");
  check("原因是平台不支持", r2.reason, "platform_unsupported");
  check("没白调公共能力（没花钱）", ttsCalls - before, 0);
  check("没有偷偷改投别的渠道", sent.length - sentBefore, 0);

  // 微信现在**能**发语音了，这条顺手钉住，免得哪天又被改回 unsupported
  check("微信 send_voice 已经是 supported", wx.capabilities.send_voice, "supported");

  console.log("\n[5] 缺公共能力时说清缺哪一份，不降级成发文字");
  const bare = new OutboundGate({ store, cold, caps: new Capabilities(),
    plugins: new Map([["signal", sg]]) });
  const sigEv = inGate.accept(await sg.toDelivery({ id: 2, from: "+111", text: "hi" }));
  const r3 = await bare.deliver({ turnId: "v3", intent: "send_voice", text: "喂",
    replyToEventId: sigEv.event.eventId, inboundEvent: sigEv.event });
  check("拒绝并指名缺件", [r3.reason, r3.detail.need], ["capability_not_registered", "synthesize_voice"]);

  console.log("\n[6] 纯文本不需要公共能力，照常走");
  const r4 = await outGate.deliver({ turnId: "t1", text: "睡了",
    replyToEventId: sigEv.event.eventId, inboundEvent: sigEv.event });
  check("正常发出", r4.outcome, "sent");

  console.log("\n通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})();
