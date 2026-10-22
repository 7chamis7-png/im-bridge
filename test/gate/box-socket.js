"use strict";
/**
 * box.sock 两头接线（2026-09-20 晚）
 *
 * 判准：**错误过线不能变形，欠的话不能少。**
 * 16:35 那次就是 `notAccepted` 掉在 box.sock 上 → 桥记 unknown → 队列堵死。
 * 这里拿假盒子把 serveBox（盒子那头）和 makeRemoteBox（桥那头）真的用 socket 连起来测，
 * 不 mock 线本身 —— 接线层单测两头各自造数据是抓不到这种 bug 的。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { serveBox } = require("../../src/host/box-host");
const { makeRemoteBox } = require("../../src/host/box-remote");
const { BoxJournal } = require("../../src/host/box-journal");

let pass = 0, fail = 0;
const check = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 3000) {
  const t = Date.now() + timeout;
  while (Date.now() < t) { if (fn()) return true; await sleep(20); }
  return false;
}

/** 假盒子：五条口都有，deliver 的行为由测试拨。 */
function fakeBox() {
  const replyHs = [], doneHs = [];
  let mode = "ok";
  return {
    setMode: (m) => { mode = m; },
    say: (e) => replyHs.forEach((h) => h(e)),
    finish: (e) => doneHs.forEach((h) => h(e)),
    async deliver(env) {
      if (mode === "notAccepted") { const e = new Error("现在没有活着的 CLI —— 先 ensure。"); e.notAccepted = true; throw e; }
      if (mode === "plain") throw new Error("盒子里别的东西炸了");
      return { turnId: "t-" + env.trace_id };
    },
    async rotate() { return { rotated: true }; },
    fullness: () => ({ used: 1, limit: 10 }),
    onReply(fn) { replyHs.push(fn); return () => {}; },
    onTurnDone(fn) { doneHs.push(fn); return () => {}; },
  };
}
const runtime = {
  describe: () => ({ id: "fake", model: "m" }),
  getTurnCapabilities: () => ({ nativeImageInput: false, toolImageRead: false }),
  async setModelForWorkspace() { return {}; },
  async cancelTurn() { return {}; },
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "box-sock-"));
  const sockFile = path.join(dir, "box.sock");
  const box = fakeBox();
  const journal = new BoxJournal({ file: path.join(dir, "journal.jsonl") });
  const served = serveBox({ box, runtime, journal, sockFile, workspaceRoot: "/ws", model: "m", log: () => {} });
  await served.listen();

  console.log("[1] 正常一问一答");
  const remote = makeRemoteBox({ socketFile: sockFile, cursorFile: path.join(dir, "cursor.json"), log: () => {}, timeoutMs: 2000 });
  check("连上", await until(() => remote.box._state().connected), true);
  check("deliver 回结果", await remote.box.deliver({ trace_id: "a" }), { turnId: "t-a" });
  await until(() => remote.box.fullness() !== null);
  check("快照推过来了（fullness 同步可读）", remote.box.fullness(), { used: 1, limit: 10 });
  check("runtime.describe 走快照", remote.runtime.describe(), { id: "fake", model: "m" });

  console.log("[2] 错误过线：标记不能掉（16:35 那个 bug）");
  box.setMode("notAccepted");
  let err = null;
  try { await remote.box.deliver({ trace_id: "b" }); } catch (e) { err = e; }
  check("抛了", Boolean(err), true);
  check("notAccepted 标记还在", err && err.notAccepted, true);
  check("原话还在", err && /没有活着的 CLI/.test(err.message), true);
  box.setMode("plain");
  err = null;
  try { await remote.box.deliver({ trace_id: "c" }); } catch (e) { err = e; }
  check("普通错误不长出 notAccepted", err && err.notAccepted, undefined);
  check("普通错误带原话", err && err.message, "盒子里别的东西炸了");
  box.setMode("ok");

  console.log("[3] 不认识的口 / 坏帧 不掀桌");
  err = null;
  try { await remote.runtime.cancelTurn({}); } catch (e) { err = e; }
  check("cancelTurn 走得通", err, null);
  check("之后还能正常 deliver", await remote.box.deliver({ trace_id: "d" }), { turnId: "t-d" });

  console.log("[4] 他说的话：办完才划账；桥不在时记着，回来补");
  const got = [];
  remote.box.onReply(async (e) => { got.push(e.text); });
  box.say({ text: "一" });
  check("在线时直接到", await until(() => got.length === 1), true);
  remote.box.close();
  await sleep(50);
  box.say({ text: "二" });
  box.say({ text: "三" });
  check("桥走了盒子记着", journal.pending() >= 2, true);
  const remote2 = makeRemoteBox({ socketFile: sockFile, cursorFile: path.join(dir, "cursor.json"), log: () => {}, timeoutMs: 2000 });
  const got2 = [];
  remote2.box.onReply(async (e) => { got2.push(e.text); });
  check("重连后欠的两条补回来", await until(() => got2.length === 2), true);
  check("补的是二、三，不重放一", got2, ["二", "三"]);
  check("补完划账", await until(() => journal.pending() === 0), true);
  remote2.box.close();

  served.close();
  console.log(`\nbox.sock 接线：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("✗", e); process.exit(1); });
