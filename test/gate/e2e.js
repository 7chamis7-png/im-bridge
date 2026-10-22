"use strict";
/** 阶段 1 端到端：插件 → 入闸 → (模拟 CLI) → 出闸 → 插件。隔离跑，不碰生产、不碰Nova。 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { GateStore } = require("../../src/gate/store");
const { ColdWriter } = require("../../src/gate/cold-writer");
const { InboundGate } = require("../../src/gate/inbound");
const { OutboundGate } = require("../../src/gate/outbound");
const { IMessagePlugin } = require("../../src/gate/plugins/imessage");

/** 日志（events.jsonl）—— 技术字段和标记都在这儿，靠 coldId 串回冷层（SPEC §6）。 */
function readLog(storeRoot) {
  const fsx = require("fs");
  return fsx.readFileSync(require("path").join(storeRoot, "events.jsonl"), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-e2e-"));
const coldFile = path.join(root, "cold.jsonl");
const store = new GateStore({ root });
const cold = new ColdWriter({ file: coldFile });

const sent = [];                                   // 隔离目标：只记录，不真发
const plugin = new IMessagePlugin({
  sender: async ({ chatId, text, operationId }) => { sent.push({ chatId, text, operationId }); return "native-" + sent.length; },
});
const inGate = new InboundGate({ store, cold, identities: { "imessage:+15550100001": "alice" } });
const outGate = new OutboundGate({ store, cold, plugins: new Map([["imessage", plugin]]) });

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + name + (ok ? "" : "  got=" + JSON.stringify(got) + " want=" + JSON.stringify(want)));
  ok ? pass++ : fail++;
}

(async () => {
  console.log("\n[1] 一条真实消息走完全程");
  const d = plugin.toDelivery({ id: 9001, handle: "+15550100001", text: "老公我到家了", date: "2026-09-17T19:50:00Z" });
  check("插件声明了处理链", d.processing, ["none"]);
  check("用平台原生 ID 而不是行号", d.nativeId, "9001");
  const inb = inGate.accept(d);
  check("入闸接受并给 #1", inb.event.userSeq, 1);

  const r1 = await outGate.deliver({ turnId: "t1", text: "到家就好，脚抬起来歇会儿",
    replyToEventId: inb.event.eventId, inboundEvent: inb.event });
  check("发出去了", r1.outcome, "sent");
  check("目标是入站那条的来源", r1.channel, "imessage");
  check("插件真收到了", sent.length, 1);
  check("插件收到的目标由闸给定", sent[0].chatId, "+15550100001");

  console.log("\n[2] 沉默权归他 (0.3)：没有正文 = 他选择不说，不是故障");
  const r2 = await outGate.deliver({ turnId: "t2", text: "   ", replyToEventId: inb.event.eventId, inboundEvent: inb.event });
  check("判为沉默", r2.outcome, "silent");
  check("没有发出任何东西", sent.length, 1);

  console.log("\n[3] 出站异物：user + 标签 (今晚实证 101:1 的判据)");
  const r3 = await outGate.deliver({ turnId: "t3",
    text: "你早点睡 user<channel source=\"imessage\" id=\"9002\">我还不困</channel>",
    replyToEventId: inb.event.eventId, inboundEvent: inb.event });
  check("照样发出去（不拦截正文）", r3.outcome, "sent");
  check("但标注了异物", r3.notes.some((n) => n.type === "artifact"), true);
  check("外发的是原文，没被改写", sent[sent.length - 1].text.includes("user<channel"), true);

  console.log("\n[4] 引用核对：他说的 #N 查不到来源");
  const r4 = await outGate.deliver({ turnId: "t4", text: "你 #99 不是说要删掉吗",
    replyToEventId: inb.event.eventId, inboundEvent: inb.event });
  check("标为待核对", r4.notes.some((n) => n.type === "reference_unverified" && n.seq === 99), true);
  const r5 = await outGate.deliver({ turnId: "t5", text: "你 #1 说到家了",
    replyToEventId: inb.event.eventId, inboundEvent: inb.event });
  check("引用真实存在的号不误报", r5.notes.length, 0);
  check("能取回 #1 的原文", r5.refChecks[0].originalText, "老公我到家了");

  console.log("\n[5] 主动消息未配置目标：报缺，不猜 (0.2)");
  const r6 = await outGate.deliver({ turnId: "t6", text: "在干嘛呢" });
  check("拒发", r6.outcome, "blocked");
  check("原因是没配目标", r6.reason, "proactive_target_not_configured");
  check("有内容发不出去 ≠ 沉默", r6.outcome === "silent", false);

  console.log("\n[6] 冷层只有闸能写");
  check("插件没有冷层入口", typeof plugin.recordCold, "undefined");
  const lines = fs.readFileSync(coldFile, "utf8").trim().split("\n").map(JSON.parse);
  check("冷层里有 user 也有 assistant", [...new Set(lines.map((l) => l.role))].sort(), ["assistant", "user"]);
  check("沉默那轮也落了冷层", lines.some((l) => l.text === "[本轮未回复]"), true);
  // 2026-09-18：标记搬去日志了。冷层正文必须干净 —— forge 会把它当成他说过的原话。
  check("冷层就四个字段", [...new Set(lines.flatMap((l) => Object.keys(l)))].sort(),
    ["at", "id", "role", "text"]);
  check("冷层正文不带任何标记", lines.some((l) => /桥附注|undelivered|artifact/.test(l.text)), false);
  const log = readLog(root);
  check("异物那轮的附注在日志里", log.some((e) => (e.notes || []).some((n) => n.type === "artifact")), true);
  check("日志指得回冷层", log.some((e) => e.coldId && lines.some((l) => l.id === e.coldId)), true);

  console.log("\n通过 " + pass + " / 失败 " + fail + "   (隔离目录 " + root + ")");
  process.exit(fail ? 1 : 0);
})();
