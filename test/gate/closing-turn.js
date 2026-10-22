"use strict";
/**
 * 换舱收尾（2026-09-19）—— 关舱之前先让他自己把带得走的东西写下来
 * 盯三件事：①顺序（先收尾后换舱）②收尾崩了绝不挡住换舱 ③桥不认识文案
 */
const { makeCommands } = require("../../src/gate/commands");
const { buildClosingNote } = require("../../src/producers/closing-turn");

let pass = 0, fail = 0;
const check = (n, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(g)} want=${JSON.stringify(w)}`));
  ok ? pass++ : fail++;
};

(async () => {

console.log("[1] 顺序：先收尾，收完才换");
{
  const order = [];
  const box = { rotate: async () => { order.push("换舱"); return { threadId: "新舱id" }; },
    deliver: async () => {}, fullness: () => ({}) };
  const cmds = makeCommands({ box, beforeRotate: async () => { order.push("收尾"); return { state: "completed" }; } });
  const r = await cmds.run(cmds.match("/new 她让换的"));
  check("收尾在换舱之前", order, ["收尾", "换舱"]);
  check("回话里报了新舱", r.text.includes("新舱id"), true);
  check("回话里说了收了尾", r.text.includes("收了尾"), true);
}

console.log("[2] 收尾崩了 —— 照样换（她让换就得换得成）");
{
  const order = [];
  const box = { rotate: async () => { order.push("换舱"); return { threadId: "x" }; },
    deliver: async () => {}, fullness: () => ({}) };
  const cmds = makeCommands({ box, beforeRotate: async () => { throw new Error("他卡住了"); } });
  const r = await cmds.run(cmds.match("/new"));
  check("还是换了", order, ["换舱"]);
  check("但把原因说清楚", r.text.includes("他卡住了"), true);
  check("说明照样换了", r.text.includes("照样换了"), true);
}

// 2026-09-21：收尾轮送进去了但被 CLI 中断（今天 12:39 真事）—— 回执不许说「收了尾」
{
  console.log("\n[2.5] 收尾轮没跑成 —— 如实说，不报「收了尾 0 秒」");
  const box = { rotate: async () => ({ threadId: "w", base: { total: 123, sections: [{ name: "执行规则", chars: 100 }, { name: "LONG-TERM MEMORY", chars: 23 }] } }) };
  const cmds = makeCommands({ box, beforeRotate: async () => ({ state: "failed", reason: "CLI 中断（error_during_execution）" }) });
  const r = await cmds.run(cmds.match("/new"));
  check("不说收了尾", r.text.includes("收了尾"), false);
  check("说了没跑成 + 原因", r.text.includes("没跑成") && r.text.includes("CLI 中断"), true);
  check("照样换了", r.text.includes("照样换了"), true);
  check("带底子点名单", r.text.includes("底子 2 段 123 字") && r.text.includes("LONG-TERM MEMORY 23"), true);
}

// 水位模式：舱还没关，措辞不许说「要关了」
{
  console.log("\n[2.6] 水位线那一轮的措辞");
  const { buildClosingNote } = require("../../src/producers/closing-turn");
  const hw = buildClosingNote({ reason: "水位 85%", mode: "highwater" });
  check("说快满了", hw.includes("快满了") && hw.includes("水位 85%"), true);
  check("不说要关了", hw.includes("要关了"), false);
  check("三件事照旧", hw.includes("notebook_list") && hw.includes("CLAUDE.md") && hw.includes("她最近"), true);
}

console.log("[3] 不给收尾钩子 —— 老样子直接换（向后兼容）");
{
  const order = [];
  const box = { rotate: async () => { order.push("换舱"); return { threadId: "y" }; },
    deliver: async () => {}, fullness: () => ({}) };
  const cmds = makeCommands({ box });
  const r = await cmds.run(cmds.match("/new"));
  check("直接换", order, ["换舱"]);
  check("不提收尾", r.text.includes("收"), false);
}

console.log("[4] 她换舱的理由原样带给他，不加工");
{
  let got = null;
  const box = { rotate: async () => ({ threadId: "z" }), deliver: async () => {}, fullness: () => ({}) };
  const cmds = makeCommands({ box, beforeRotate: async (a) => { got = a; } });
  await cmds.run(cmds.match("/new 太满了"));
  check("理由传下去了", got.reason, "太满了");
  const note = buildClosingNote({ reason: "太满了" });
  check("文案里带上她的理由", note.includes("太满了"), true);
}

console.log("[5] 文案：三件事都在，而且笔在他手里");
{
  const note = buildClosingNote({});
  check("①笔记本", note.includes("notebook_list") && note.includes("notebook_note"), true);
  check("②她说过的要求 → CLAUDE.md", note.includes("CLAUDE.md"), true);
  check("③她最近怎么样 → 笔记本「她最近」", note.includes("她最近") && note.includes("notebook_note"), true);
  check("说清楚别的带不走", note.includes("别的都不跟过去"), true);
  check("不让他把收尾变成交给她的作业", note.includes("不用跟她汇报"), true);
  check("拿不准的有去处（观察中）", note.includes("观察中"), true);
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
})();
