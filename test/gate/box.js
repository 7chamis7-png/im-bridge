"use strict";
/**
 * 盒子五条口（2026-09-18）
 *
 * 测的是**契约本身**：五条口齐不齐、空轮进不进得去、他不说话时下游知不知道。
 * 真盒子（claude / codex）住在桥外面，那份由宿主自己验。
 */
const { BOX_CONTRACT, assertBox, assertTurnIn, makeFakeBox } = require("../../src/gate/box");
const { makeEnvelope } = require("../../src/gate/envelope");

/** 一个最小的真信封（盒子吃的就是它） */
const env = (trace_id, text, extra = {}) => makeEnvelope({
  trace_id, source: { kind: "user", platform: "telegram", chat_id: "861", sender_id: "861" },
  payload: { text }, ...extra,
});

let pass = 0, fail = 0;
const check = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};
const throws = (n, fn, re) => {
  try { fn(); check(n, "没抛错", "该抛错"); }
  catch (e) { check(n, re.test(e.message), true); }
};

console.log("[1] 装配体检：缺口子要在接线那一刻就说，不许等她说话时才炸");
check("五条口", Object.keys(BOX_CONTRACT).length, 5);
throws("盒子没给", () => assertBox(null), /盒子没给/);
throws("一条口都没有", () => assertBox({}), /deliver|送一轮/);
const half = { deliver: () => {}, onReply: () => {}, fullness: () => {} };
try { assertBox(half); check("缺两条要抛", "没抛", "该抛"); }
catch (e) {
  check("点名缺的那两条", /onTurnDone/.test(e.message) && /rotate/.test(e.message), true);
  check("不冤枉已经有的", /deliver（/.test(e.message), false);
  pass += 0;
}
check("齐了就放行", assertBox(makeFakeBox()) !== null, true);

console.log("\n[2] 进盒子的那一轮：一定错的两种当场挡下");
throws("没有 trace_id", () => assertTurnIn({ role: "user", source: { kind: "user", sender_id: "861" }, payload: { text: "在吗" } }), /trace_id/);
throws("空轮（既没正文也没媒体）", () => env("t1", "  "), /空轮/);
check("只有媒体也算数", makeEnvelope({ trace_id: "t1", source: { kind: "user", sender_id: "861" }, payload: { media: [{ kind: "image" }] } }).trace_id, "t1");

(async () => {
  console.log("\n[3] 一轮跑完：话拿得出来，轮结束说得清楚");
  const box = makeFakeBox({ answer: () => "七点二十 我叫你" });
  const replies = [], dones = [];
  box.onReply((r) => replies.push(r));
  box.onTurnDone((d) => dones.push(d));
  const r = await box.deliver(env("tr-1", "明天几点的火车"));
  check("拿到轮号和舱号", Boolean(r.turnId && r.threadId), true);
  check("他的话出来了", replies.map((x) => x.text), ["七点二十 我叫你"]);
  check("话上带着 trace_id（一条 grep 看全程）", replies[0].trace_id, "tr-1");
  check("这一轮说完了", dones.length, 1);
  check("不是沉默", dones[0].silent, false);

  console.log("\n[4] 他选择不说 —— 下游必须知道，不能干等");
  const quiet = makeFakeBox({ answer: () => null });
  const qReplies = [], qDones = [];
  quiet.onReply((x) => qReplies.push(x));
  quiet.onTurnDone((x) => qDones.push(x));
  await quiet.deliver(env("tr-2", "在吗"));
  check("一句话都没出来", qReplies.length, 0);
  check("但轮结束照样发", qDones.length, 1);
  check("而且明说是沉默", qDones[0].silent, true);

  console.log("\n[5] 分段说话：几段就几次");
  const multi = makeFakeBox({ answer: () => ["第一段", "第二段", "   "] });
  const mReplies = [];
  multi.onReply((x) => mReplies.push(x.text));
  await multi.deliver(env("tr-3", "说两句"));
  check("空白段不算一句", mReplies, ["第一段", "第二段"]);

  console.log("\n[6] 开新舱 / 看水位");
  const b2 = makeFakeBox({ fullnessRatio: 0.83 });
  const before = b2._threadId();
  const rot = await b2.rotate({ reason: "满了" });
  check("换了舱号", rot.threadId !== before, true);
  check("理由带着走", rot.reason, "满了");
  check("水位问得到", b2.fullness().ratio, 0.83);

  console.log("\n[7] 假盒子不起进程 —— 一整轮要快到可以随便跑");
  const t0 = Date.now();
  const fast = makeFakeBox();
  for (let i = 0; i < 200; i += 1) await fast.deliver(env("t" + i, "第" + i + "句"));
  const ms = Date.now() - t0;
  check("200 轮跑完（毫秒级）", ms < 1000, true);
  check("每一轮都记了账", fast._seen.length, 200);
  console.log(`      200 轮用时 ${ms}ms`);

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
