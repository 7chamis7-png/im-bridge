"use strict";
// undo 删历史后必须让 CLI 重认叶子（2026-09-21 修断链根因）+ 文件侧删完链不断（回归）
const assert = require("assert");
const fs = require("fs"); const os = require("os"); const path = require("path");
const { planUndo, applyUndo } = require("../../src/host/undo");
const { registerClaudeCodeCommands } = require("../../src/host/gate-commands-claudecode");
let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { if (ok) { pass++; console.log("  OK   " + n); } else { fail++; console.log("  FAIL " + n + "  " + extra); } };

// —— 造一个隔离的 HOME + gateRoot：3 轮对话 M0/M1/M2 ——
const home = fs.mkdtempSync(path.join(os.tmpdir(), "undo-home-"));
const gateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "undo-gate-"));
const ws = "/root/nova"; const tid = "sess1";
const slug = ws.replace(/[/.]/g, "-");
const projDir = path.join(home, ".claude", "projects", slug);
fs.mkdirSync(projDir, { recursive: true });
const tpath = path.join(projDir, tid + ".jsonl");

let parent = null; const rows = [];
const push = (o) => { const uuid = o.uuid; rows.push({ parentUuid: parent, ...o }); parent = uuid; };
function turn(mid, text) {
  push({ uuid: "in" + mid, type: "user", message: { role: "user", content: `<channel source="telegram" message_id="${mid}">${text}</channel>` } });
  push({ uuid: "as" + mid, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "回 " + mid }] } });
}
turn("M0", "第0句"); turn("M1", "第1句"); turn("M2", "第2句");
fs.writeFileSync(tpath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
// events.jsonl：三条 user_input
const ev = ["M0", "M1", "M2"].map((m) => JSON.stringify({ kind: "user_input", eventId: "ev-" + m, nativeId: m, channel: "telegram", chatId: "1", receivedAt: "2026-09-21T00:00:00Z", text: "第" + m }));
fs.writeFileSync(path.join(gateRoot, "events.jsonl"), ev.join("\n") + "\n");
const origHome = process.env.HOME; process.env.HOME = home;   // transcriptPathOf 用 os.homedir()→HOME
os.homedir = () => home;

const chainIntact = (file) => {
  const rs = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const ids = new Set(rs.map((r) => r.uuid).filter(Boolean));
  return rs.every((r) => !r.parentUuid || ids.has(r.parentUuid));
};

console.log("[1] 删末轮：文件链不断，末轮的行没了");
{
  const plan = planUndo({ gateRoot, workspaceRoot: ws, threadId: tid, target: { kind: "last" } });
  check("圈到 M2 那轮 2 行", plan.footprint.transcript.lines.length === 2, String(plan.footprint.transcript.lines.length));
  check("末轮 relink 为 null（后面没有行了）", plan.footprint.transcript.relink === null);
  const r = applyUndo({ plan });
  check("apply ok，删了 2 行 transcript", r.ok && r.removed.transcript === 2);
  const left = fs.readFileSync(tpath, "utf8");
  check("M2 的行没了", !left.includes('"asM2"') && !left.includes("message_id=\"M2\""));
  check("链完整", chainIntact(tpath));
}

console.log("[2] 删中间轮：后继接到存活的前驱，链不断");
{
  fs.writeFileSync(tpath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n"); // 复原三轮
  const plan = planUndo({ gateRoot, workspaceRoot: ws, threadId: tid, target: { kind: "event", eventId: "ev-M1" } });
  check("relink 存在（要把 M2 接回 M0 的尾）", !!plan.footprint.transcript.relink, JSON.stringify(plan.footprint.transcript.relink));
  const r = applyUndo({ plan });
  check("apply ok", r.ok && r.removed.transcript === 2);
  const left = fs.readFileSync(tpath, "utf8");
  check("M1 没了、M0 M2 还在", !left.includes('"asM1"') && left.includes('"asM0"') && left.includes('"inM2"'));
  check("链完整（inM2 接到了 asM0）", chainIntact(tpath));
}

(async () => {
  console.log("[3] handler：删了 transcript 行就调 box.reloadCli");
  fs.writeFileSync(tpath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const calls = [];
  const box = { fullness: () => ({ threadId: tid }), reloadCli: async (o) => { calls.push(o); return { reloaded: true }; } };
  const reg = {};
  const commands = { register: (name, fn) => { reg[name] = fn; }, match: (t) => ({ name: "undo", rest: t.replace(/^\/undo\s*/, "") }), run: (c) => reg[c.name]({ rest: c.rest }) };
  registerClaudeCodeCommands(commands, { runtime: {}, box, workspaceRoot: ws, gateRoot, threadId: () => tid,
    pauseIntake: async () => ({ ok: true }), resumeIntake: () => {} });
  await reg.undo({ rest: "" });          // 预览
  const out = await reg.undo({ rest: "ok" });  // 确认
  check("撤销完成", /撤销完成/.test(out.text), out.text);
  check("box.reloadCli 被调了一次", calls.length === 1 && calls[0].workspaceRoot === ws);

  console.log("[4] handler：他正在说话 reloadCli busy → 回执带警告");
  fs.writeFileSync(tpath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const box2 = { fullness: () => ({ threadId: tid }), reloadCli: async () => ({ reloaded: false, busy: true }) };
  const reg2 = {};
  const cmd2 = { register: (name, fn) => { reg2[name] = fn; }, match: (t) => ({ name: "undo", rest: t.replace(/^\/undo\s*/, "") }), run: (c) => reg2[c.name]({ rest: c.rest }) };
  registerClaudeCodeCommands(cmd2, { runtime: {}, box: box2, workspaceRoot: ws, gateRoot, threadId: () => tid, pauseIntake: async () => ({ ok: true }), resumeIntake: () => {} });
  await reg2.undo({ rest: "" });
  const out2 = await reg2.undo({ rest: "ok" });
  check("回执提醒 CLI 没重连", /没能重连|正在说话/.test(out2.text), out2.text);

  process.env.HOME = origHome;
  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
