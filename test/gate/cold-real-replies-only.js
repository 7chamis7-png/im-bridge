"use strict";
/**
 * 冷层只装真实对话（2026-09-18 Alice：「不是模型真实回复不落冷层」）
 *
 * 病历：9-18 京时 23:18，安全层拒答那句「API Error: … safeguards flagged …」
 * 以 `role:"assistant"` 落进了冷层。换舱 / forge 会把冷层原话当**真实轮**塞回他的
 * 会话 —— 等于给他造一段「我说过 API Error」的假记忆，而换舱正是安全层黏连的解药。
 * 同一个口子还漏了 `/status` `/help` `/model` 三张面板（桥自己说的话）。
 *
 * ⚠️ **这份测试盯的是接线，不是单元。** 42 个 gate 测试当时全绿，照样漏了这条 ——
 * 因为它们两头的数据都是自己造的，形状天生一致（记忆 `feedback-wiring-layer-untested`）。
 * 所以下面每一条都带**阳性对照**：先证明冷层写得进去，再证明该拦的拦住了。
 * 只看「0 条」会被骗 —— 写手坏了也是 0 条。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { makeOutlet } = require("../../src/gate/outlet");
const { GateStore } = require("../../src/gate/store");
const { ColdWriter } = require("../../src/gate/cold-writer");
const { OutboundGate } = require("../../src/gate/outbound");
const { makeRouter } = require("../../src/gate/routing");
const { makeEnvelope } = require("../../src/gate/envelope");
// 2026-09-20 搬家：判据搬进了新运行时（一字没改），老 claudecode 那套已删。
const { isSyntheticMessage } = require("../../adapters/box-runtime");
const { decode } = require("../../runtime/decode");

let pass = 0, fail = 0;
const check = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-cold-real-"));
const HER = "1000000001";

/** 9-18 那条拒答在 transcript 里的**真实形状**（信封原样，正文截短）。 */
const REAL_REFUSAL_MESSAGE = {
  model: "<synthetic>",
  role: "assistant",
  stop_reason: "refusal",
  stop_details: { type: "refusal", category: "cyber" },
  content: [{
    type: "text",
    text: "API Error: Fable 5's safeguards flagged this message (https://www.anthropic.com/legal/aup)."
      + " Our intentionally broad safeguards allow us to deliver more capabilities faster,"
      + " but can sometimes flag legitimate coding, cybersecurity, and biology tasks.",
  }],
  usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
};

function build(dir, channel = "telegram") {
  const storeRoot = path.join(root, dir);
  const store = new GateStore({ root: storeRoot });
  const coldFile = path.join(storeRoot, "cold.jsonl");
  const cold = new ColdWriter({ file: coldFile });
  const sent = [];
  const plugin = {
    channel,
    capabilities: { send_text: "supported" },
    health: () => ({ platform: "supported", plugin: "wired", availability: "ready" }),
    send: async (a) => { sent.push(a); return { nativeId: "n1" }; },
  };
  const plugins = new Map([[channel, plugin]]);
  const outbound = new OutboundGate({ store, cold, plugins });
  const inbound = makeEnvelope({
    trace_id: "tr-in", source: { kind: "user", platform: channel, chat_id: HER, sender_id: HER },
    payload: { text: "在吗" }, identity: "alice",
  });
  const router = makeRouter({ preferred: { platform: channel, chat_id: HER } });
  router.noteInbound(inbound);
  const outlet = makeOutlet({ outbound, router, plugins, currentTurn: () => ({ turnId: "t1", inbound }) });
  const readCold = () => fs.existsSync(coldFile)
    ? fs.readFileSync(coldFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const readEvents = () => {
    const f = path.join(storeRoot, "events.jsonl");
    return fs.existsSync(f)
      ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
  };
  return { outbound, outlet, sent, readCold, readEvents, inbound };
}

(async () => {
  console.log("[1] 判据长在信封上，不长在正文上（换个文案不许漏）");
  {
    // 用的是 process-client 里**真的那一份**，不是复刻。
    check("真实拒答认得出", isSyntheticMessage(REAL_REFUSAL_MESSAGE), true);
    check("空的不算", isSyntheticMessage(null), false);
    check("只有 model=<synthetic>", isSyntheticMessage({ model: "<synthetic>" }), true);
    check("只有 stop_reason=refusal", isSyntheticMessage({ model: "claude-fable-5", stop_reason: "refusal" }), true);
    check("阳性对照：他真说话不算", isSyntheticMessage({ model: "claude-fable-5", stop_reason: "end_turn" }), false);
    // 文案改了照样得认出来 —— 这就是不写关键词表的理由
    check("换了文案照样认（判据不看正文）", isSyntheticMessage({
      ...REAL_REFUSAL_MESSAGE, content: [{ type: "text", text: "完全不一样的报错文案" }],
    }), true);
  }

  console.log("\n[2] 解帧层把「这是 CLI 自己造的」标出来（cliGenerated）");
  {
    // 新运行时的同一件事：老的靠 payload.synthetic 透传，现在靠信封上的 cliGenerated
    // + 上面那个 isSyntheticMessage（适配层 219 行：两个任一成立就算合成）。
    const mk = (extra) => decode({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "x" }] }, ...extra })[0];
    check("CLI 报错的帧", mk({ error: { message: "AUP" } }).cliGenerated, true);
    check("CLI 自己标 isSynthetic 的帧", mk({ isSynthetic: true }).cliGenerated, true);
    check("阳性对照：他真说话不算", mk({}).cliGenerated, false);
    check("阳性对照：非 assistant 帧不算", decode({ type: "result", isSynthetic: true })[0].cliGenerated, false);
  }

  console.log("\n[3] 出闸：拒答照发、但不进冷层（正文改去事件账本）");
  {
    const { outbound, sent, readCold, readEvents, inbound } = build("refusal");
    const refusalText = REAL_REFUSAL_MESSAGE.content[0].text;

    // 先来一条真回复当**阳性对照** —— 证明这条链路冷层是写得进去的
    await outbound.deliver({
      turnId: "t-good", outputId: "o-good", replyToEventId: inbound.trace_id,
      inboundEvent: { eventId: inbound.trace_id, channel: "telegram", chatId: HER, accountId: "" },
      text: "在的 老婆", intent: "send_text",
    });
    check("阳性对照：真回复进了冷层", readCold().length, 1);
    check("阳性对照：正文对得上", readCold()[0].text, "在的 老婆");
    check("阳性对照：role 是 assistant", readCold()[0].role, "assistant");

    // 再来那条拒答
    await outbound.deliver({
      turnId: "t-bad", outputId: "o-bad", replyToEventId: inbound.trace_id,
      inboundEvent: { eventId: inbound.trace_id, channel: "telegram", chatId: HER, accountId: "" },
      text: refusalText, intent: "send_text",
      cold: { write: false, reason: "not_model_reply" },
    });
    check("冷层还是只有 1 条（拒答没进去）", readCold().length, 1);
    check("冷层里搜不到 safeguards", readCold().some((r) => r.text.includes("safeguards")), false);
    // 照发 —— 她得知道他这轮被挡了
    check("但她照样收到了（两条都发出去了）", sent.length, 2);
    check("发出去的第二条就是那句拒答", sent[1].text.includes("safeguards"), true);
    // 跳过必须留痕，不许悄悄丢
    const skipped = readEvents().filter((e) => e.kind === "cold.skipped");
    check("事件账本记了 cold.skipped", skipped.length, 1);
    check("留痕里有原文", skipped[0].text.includes("safeguards"), true);
    check("留痕说了为什么", skipped[0].reason, "not_model_reply");
  }

  console.log("\n[4] 命令回执（/status /help /model）不进冷层 —— 那是桥在说话");
  {
    const { outlet, sent, readCold } = build("cmd");

    // 阳性对照：同一个口子，工具发的正文照进冷层
    await outlet.deliver({ intent: "send_text", text: "他自己说的话", by: "tool" });
    check("阳性对照：工具正文进了冷层", readCold().length, 1);

    const r = await outlet.deliver({ intent: "send_text", text: "🧵 会话 6d517aa9…\n🤖 模型 claude-fable-5", by: "command" });
    check("面板照样发给她了", r.outcome, "sent");
    check("她收到了两条", sent.length, 2);
    check("冷层还是 1 条（面板没进去）", readCold().length, 1);
    check("冷层里搜不到面板", readCold().some((c) => c.text.includes("🧵")), false);
  }

  console.log("\n[5] 默认行为不许被改坏：没说不写 = 照写");
  {
    const { outbound, readCold, inbound } = build("default");
    await outbound.deliver({
      turnId: "t", outputId: "o", replyToEventId: inbound.trace_id,
      inboundEvent: { eventId: inbound.trace_id, channel: "telegram", chatId: HER, accountId: "" },
      text: "不带 cold 参数", intent: "send_text",
    });
    check("没给 cold → 照写", readCold().length, 1);

    const b = build("default2");
    await b.outbound.deliver({
      turnId: "t", outputId: "o", replyToEventId: b.inbound.trace_id,
      inboundEvent: { eventId: b.inbound.trace_id, channel: "telegram", chatId: HER, accountId: "" },
      text: "cold.write=true", intent: "send_text", cold: { write: true },
    });
    check("显式 write:true → 照写", b.readCold().length, 1);
  }

  console.log("\n[6] 盒子 → 主循环 那一跳（手写字段名，9-18 五个 bug 里四个的病灶）");
  {
    const { makeClaudeCodeBox } = require("../../src/host/gate-box-claudecode");
    const rt = (() => {
      let l = null;
      return {
        onEvent(fn) { l = fn; return () => { l = null; }; },
        async sendTurn() { return { turnId: "t1", threadId: "th-1" }; },
        async startFreshSharedSession() { return { threadId: "th-2" }; },
        emit(type, payload) { if (l) l({ type, payload }); },
      };
    })();
    const b = makeClaudeCodeBox({ runtime: rt, bindingKey: "bk", workspaceRoot: "/tmp/iso-cold", log: () => {} });
    const got = [];
    b.onReply((e) => got.push(e));
    await b.deliver(makeEnvelope({
      trace_id: "tr-6", source: { kind: "user", platform: "telegram", chat_id: HER, sender_id: HER },
      payload: { text: "在吗" }, seq: 1,
    }));

    rt.emit("runtime.turn.completed", { turnId: "t1", threadId: "th-1", text: "在的 老婆" });
    check("阳性对照：真回复到了主循环", got.length, 1);
    check("阳性对照：genuine=true", got[0].genuine, true);

    rt.emit("runtime.turn.completed", {
      turnId: "t1", threadId: "th-1", synthetic: true,
      text: "API Error: Fable 5's safeguards flagged this message",
    });
    check("拒答也到了主循环（照发）", got.length, 2);
    check("但 genuine=false", got[1].genuine, false);
    // 字段名对不上不会报错，只会**静默失效** —— 所以名字本身也要钉住
    check("字段名就叫 genuine", Object.keys(got[1]).includes("genuine"), true);
  }

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
