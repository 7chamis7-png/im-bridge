"use strict";
// S2a 盒子双认：同一份真实帧，翻成通用事件（imb.event.v1）再喂给盒子，盒子给桥 / 给她的东西必须跟 Claude 帧那条路
// **逐字节一样**（金标准就是 history-off-identical 用的那份，9a332e7 跑出来的）。再测 Claude 帧里没有的几种形状：
// codex 的 commentary / final 两段、失败、拒答、子代理、边写边念。
const fs = require("fs"); const os = require("os"); const path = require("path");
const { runBoxScenario, FIX } = require("./lib/box-scenario");

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { if (ok) { pass++; console.log("  OK   " + n); } else { fail++; console.log("  FAIL " + n + "  " + extra); } };
const ROOT = path.join(__dirname, "..", "..");
const golden = fs.readFileSync(path.join(FIX, "box-golden-9a332e7.json"), "utf8");
const dump = (o) => JSON.stringify(o, null, 1) + "\n";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { claudeToNeutral } = require("../../src/box/history-claude");
  const { isNarration, isSyntheticMessage } = require("../../adapters/box-runtime");
  const { createHistory } = require("../../src/box/history");
  const { readHistoryItems } = require("../../src/box/history-writer");

  // 真帧 → decode → 通用事件，带上 turn（cli 台账号）。wrap 决定包法。
  const neutralEmit = (wrap) => async (frames, enq, emit, decode) => {
    const bindings = [{ uuid: enq.uuid, message: enq.message, origin: enq.origin }];
    for (const f of frames) for (const event of decode(f)) {
      for (const n of claudeToNeutral(event, { isNarration, isSyntheticMessage })) {
        const ev = { ...n, turn: enq.uuid };
        await emit(wrap === "bare" ? { ...ev, origin: enq.origin } : { event: ev, bindings });
        await sleep(2);
      }
    }
  };

  console.log("[1] 通用事件（信封包法）→ 跟 Claude 帧那条路逐字节一样");
  const a = await runBoxScenario({ root: ROOT, emitFor: neutralEmit("wrapped") });
  check("输出跟金标准逐字节一样", dump(a.out) === golden);
  console.log("  第一条通用事件的形状：" + Object.keys(claudeToNeutral(require("../../runtime/decode").decode(
    JSON.parse(fs.readFileSync(path.join(FIX, "sdk-frames-2.1.292-tool-turn.jsonl"), "utf8").split("\n")[4]))[0],
    { isNarration, isSyntheticMessage })[0]).sort().join(","));

  console.log("[2] 裸事件（{v, turn, origin}）→ 也一样");
  const b = await runBoxScenario({ root: ROOT, emitFor: neutralEmit("bare") });
  check("输出跟金标准逐字节一样", dump(b.out) === golden);

  console.log("[3] 全本开着：通用事件那条路记下来的跟 Claude 帧那条路一样");
  const d1 = fs.mkdtempSync(path.join(os.tmpdir(), "neutral-h1-"));
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "neutral-h2-"));
  const env = (d) => ({ GATE_HISTORY: "on", GATE_HISTORY_SECRETS_DIR: path.join(d, "none") });
  await runBoxScenario({ root: ROOT, history: createHistory({ root: d1, env: env(d1) }), dir: d1 });
  await runBoxScenario({ root: ROOT, history: createHistory({ root: d2, env: env(d2) }), dir: d2, emitFor: neutralEmit("wrapped") });
  // 每次跑都不一样的只有：时间戳、cli 台账号（randomUUID）、临时目录 —— 抹掉这三样再逐条比
  const strip = (items, d) => items.map(({ at, turn, ...rest }) => JSON.stringify(rest)
    .replace(/"e:[0-9a-f-]{36}"/g, '"e:*"').split(d).join("<dir>"));
  const i1 = strip(readHistoryItems(path.join(d1, "history")), d1);
  const i2 = strip(readHistoryItems(path.join(d2, "history")), d2);
  check("两条路记下的全本一条不差（抹掉时间戳 / 台账号 / 临时目录比）", i1.length > 10 && JSON.stringify(i1) === JSON.stringify(i2), `${i1.length} vs ${i2.length}`);

  console.log("[4] Claude 帧里没有的形状（codex / 失败 / 拒答 / 子代理 / 边写边念）");
  const N = (o) => ({ v: "imb.event.v1", engine: "codex-appserver", sidechain: false, ...o });
  const plan = [
    // 第 1 轮：commentary + final —— 只有 final 当正文
    [N({ kind: "text", id: "c1", text: "我先查一下", deliverHint: "commentary", generatedBy: "model", model: "gpt-5.6-sol" }),
      N({ kind: "tool.call", id: "call_1", name: "exec", server: "", args: { input: "ls" } }),
      N({ kind: "tool.result", callId: "call_1", isError: false, text: "ok", images: [] }),
      N({ kind: "text", id: "f1", text: "查完了", deliverHint: "text", generatedBy: "model", model: "gpt-5.6-sol" }),
      N({ kind: "usage", input: 1000, output: 10, cacheRead: 800, cacheWrite: null, context: 1010, model: "gpt-5.6-sol" }),
      N({ kind: "turn.end", status: "ok", synthetic: false, errors: [] })],
    // 第 2 轮：只有 commentary —— 拿它兜底（她不能空手）
    [N({ kind: "text", id: "c2", text: "只有过程话", deliverHint: "commentary", generatedBy: "model" }),
      N({ kind: "turn.end", status: "ok", synthetic: false, errors: [] })],
    // 第 3 轮：失败
    [N({ kind: "turn.end", status: "error", synthetic: false, errors: ["codex 这轮超时"], subtype: "error_during_execution" })],
  ];
  const c = await runBoxScenario({ root: ROOT, turns: plan, emitFor: async (evs, enq, emit) => {
    for (const ev of evs) { await emit({ event: { ...ev, turn: enq.uuid }, bindings: [{ uuid: enq.uuid, origin: enq.origin }] }); await sleep(2); }
  } });
  const texts = c.out.replies.map((r) => r.text);
  check("commentary + final：只投 final，commentary 不投", texts[0] === "查完了" && !texts.includes("我先查一下"), JSON.stringify(texts));
  check("只有 commentary：拿 commentary 兜底投出去", texts[1] === "只有过程话", JSON.stringify(texts));
  check("失败：报 failed，不当沉默", c.out.dones[2] && c.out.dones[2].failed === true && /超时/.test(c.out.dones[2].reason), JSON.stringify(c.out.dones[2]));
  const ctx = c.out.events.find((e) => e.type === "runtime.context.updated");
  check("水位用插头给的 context（1010），cacheWrite=null 记 0", ctx && ctx.payload.currentTokens === 1010 && ctx.payload.cacheCreationInputTokens === 0, JSON.stringify(ctx && ctx.payload));

  const plan2 = [
    [N({ kind: "text", id: "s1", text: "子代理的话", deliverHint: "text", generatedBy: "model", sidechain: true }),
      N({ kind: "text.delta", text: "边" }), N({ kind: "text.delta", text: "写" }), N({ kind: "text.delta", end: true }),
      N({ kind: "text", id: "x1", text: "抱歉，这个我不能继续。", deliverHint: "text", generatedBy: "engine" }),
      N({ kind: "turn.end", status: "refused", synthetic: true, errors: [] })],
  ];
  const e = await runBoxScenario({ root: ROOT, turns: plan2, emitFor: async (evs, enq, emit) => {
    for (const ev of evs) { await emit({ ...ev, turn: enq.uuid, origin: enq.origin }); await sleep(2); }
  } });
  const t2 = e.out.replies.map((r) => r.text);
  check("子代理的话不投", !t2.includes("子代理的话"), JSON.stringify(t2));
  check("引擎造的（拒答）照投，但标 genuine=false（不进冷层）", e.out.replies.some((r) => r.text.startsWith("抱歉") && r.genuine === false));
  const deltas = e.out.events.filter((x) => x.type === "runtime.reply.delta").map((x) => x.payload.end ? "<end>" : x.payload.text);
  check("text.delta → runtime.reply.delta（电话边写边念那条）", deltas.join("") === "边写<end>", JSON.stringify(deltas));

  console.log(`盒子双认：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
