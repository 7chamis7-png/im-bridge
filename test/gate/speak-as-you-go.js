"use strict";
// 2026-11-01 边说边发：工具前那段在调工具那一刻就发；旁白也发；最终文本扣掉已发的不重复。
const assert = require("assert");
const { makeClaudeCodeBox } = require("../../src/host/gate-box-claudecode");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; } catch (e) { fail++; console.log("✗ " + name + "\n  " + e.message); } }

function setup() {
  let l = null;
  const rt = {
    sendTurn: async () => ({}), respondApproval: async () => {},
    onEvent(fn) { l = fn; return () => { l = null; }; },
    emit(type, payload) { if (l) l({ type, payload }); },
  };
  const b = makeClaudeCodeBox({ runtime: rt, bindingKey: "bk", workspaceRoot: "/tmp/iso-speak", log: () => {} });
  const out = [], done = [];
  b.onReply((r) => out.push(r.text));
  b.onTurnDone((d) => done.push(d));
  return { rt, out, done };
}

t("工具前那段在许可时就发，不等收尾", () => {
  const { rt, out } = setup();
  rt.emit("runtime.reply.candidate", { turnId: "t1", text: "我先去看看" });
  assert.deepStrictEqual(out, []);
  rt.emit("runtime.approval.requested", { requestId: "r1", toolName: "x" });
  assert.deepStrictEqual(out, ["我先去看看"]);
  rt.emit("runtime.reply.candidate", { turnId: "t1", text: "看完了 是这样" });
  rt.emit("runtime.turn.completed", { turnId: "t1", text: "看完了 是这样" });
  assert.deepStrictEqual(out, ["我先去看看", "看完了 是这样"]);
});

t("工具前的旁白也发", () => {
  const { rt, out } = setup();
  rt.emit("runtime.reply.candidate", { turnId: "t1", text: "拍好了", narration: true });
  rt.emit("runtime.approval.requested", { requestId: "r1" });
  rt.emit("runtime.turn.completed", { turnId: "t1", text: "好啦" });
  assert.deepStrictEqual(out, ["拍好了", "好啦"]);
});

t("最后一次工具之后的旁白，有正文时照老规矩不发", () => {
  const { rt, out } = setup();
  rt.emit("runtime.reply.candidate", { turnId: "t1", text: "嗯我想想", narration: true });
  rt.emit("runtime.reply.candidate", { turnId: "t1", text: "在的" });
  rt.emit("runtime.turn.completed", { turnId: "t1", text: "在的" });
  assert.deepStrictEqual(out, ["在的"]);
});

t("最终文本带上了已发的那段 → 扣掉再发", () => {
  const { rt, out } = setup();
  rt.emit("runtime.reply.candidate", { turnId: "t1", text: "第一段" });
  rt.emit("runtime.approval.requested", { requestId: "r1" });
  rt.emit("runtime.turn.completed", { turnId: "t1", text: "第一段\n\n第二段" });
  assert.deepStrictEqual(out, ["第一段", "第二段"]);
});

t("最终文本全是已发的 → 不再发", () => {
  const { rt, out } = setup();
  rt.emit("runtime.reply.candidate", { turnId: "t1", text: "就这句" });
  rt.emit("runtime.approval.requested", { requestId: "r1" });
  rt.emit("runtime.turn.completed", { turnId: "t1", text: "就这句" });
  assert.deepStrictEqual(out, ["就这句"]);
});

t("没工具的普通一轮跟以前一样", () => {
  const { rt, out, done } = setup();
  rt.emit("runtime.reply.candidate", { turnId: "t1", text: "哎 在" });
  rt.emit("runtime.turn.completed", { turnId: "t1", text: "哎 在" });
  assert.deepStrictEqual(out, ["哎 在"]);
  assert.strictEqual(done[0].silent, false);
});

t("被 /stop 打断：工具前已发的不丢、不重发", () => {
  const { rt, out, done } = setup();
  rt.emit("runtime.reply.candidate", { turnId: "t1", text: "我站你旁边了" });
  rt.emit("runtime.approval.requested", { requestId: "r1" });
  rt.emit("runtime.turn.failed", { turnId: "t1", text: "CLI 中断" });
  assert.deepStrictEqual(out, ["我站你旁边了"]);
  assert.strictEqual(done[0].failed, true);
});

t("连着调两个工具：每段各发一次", () => {
  const { rt, out } = setup();
  rt.emit("runtime.reply.candidate", { turnId: "t1", text: "A" });
  rt.emit("runtime.approval.requested", { requestId: "r1" });
  rt.emit("runtime.approval.requested", { requestId: "r2" });
  rt.emit("runtime.reply.candidate", { turnId: "t1", text: "B" });
  rt.emit("runtime.approval.requested", { requestId: "r3" });
  rt.emit("runtime.turn.completed", { turnId: "t1", text: "C" });
  assert.deepStrictEqual(out, ["A", "B", "C"]);
});

console.log(`通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
