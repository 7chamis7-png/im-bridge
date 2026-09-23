"use strict";
/**
 * Closing turn before rotation: the agent writes down what should carry over.
 * Checks: (1) order (closing turn before rotate) (2) a failing closing turn never
 * blocks the rotation (3) the bridge doesn't own the wording
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
  const r = await cmds.run(cmds.match("/new 手动换"));
  check("收尾在换舱之前", order, ["收尾", "换舱"]);
  check("回话里报了新舱", r.text.includes("新舱id"), true);
  check("回话里说了收了尾", r.text.includes("收了尾"), true);
}

console.log("[2] closing turn throws — rotate anyway");
{
  const order = [];
  const box = { rotate: async () => { order.push("换舱"); return { threadId: "x" }; },
    deliver: async () => {}, fullness: () => ({}) };
  const cmds = makeCommands({ box, beforeRotate: async () => { throw new Error("卡住了"); } });
  const r = await cmds.run(cmds.match("/new"));
  check("还是换了", order, ["换舱"]);
  check("但把原因说清楚", r.text.includes("卡住了"), true);
  check("说明照样换了", r.text.includes("照样换了"), true);
}

// Closing turn accepted but interrupted by the CLI — the receipt must not claim it completed
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

// highwater mode: session not closing yet
{
  console.log("\n[2.6] 水位线那一轮的措辞");
  const { buildClosingNote } = require("../../src/producers/closing-turn");
  const hw = buildClosingNote({ reason: "水位 85%", mode: "highwater" });
  check("says nearly full", hw.includes("nearly full") && hw.includes("水位 85%"), true);
  check("doesn't say rotating", hw.includes("about to be rotated"), false);
  check("three items still there", hw.includes("Open threads") && hw.includes("CLAUDE.md") && hw.includes("How the owner is doing"), true);
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

console.log("[4] the rotation reason is passed through verbatim");
{
  let got = null;
  const box = { rotate: async () => ({ threadId: "z" }), deliver: async () => {}, fullness: () => ({}) };
  const cmds = makeCommands({ box, beforeRotate: async (a) => { got = a; } });
  await cmds.run(cmds.match("/new 太满了"));
  check("理由传下去了", got.reason, "太满了");
  const note = buildClosingNote({ reason: "太满了" });
  check("reason appears in the note", note.includes("太满了"), true);
}

console.log("[5] note content: three items, agent holds the pen");
{
  const note = buildClosingNote({});
  check("1 open threads", note.includes("Open threads"), true);
  check("2 standing requests → CLAUDE.md", note.includes("CLAUDE.md"), true);
  check("3 how the owner is doing", note.includes("How the owner is doing"), true);
  check("says nothing else carries over", note.includes("Nothing else carries over"), true);
  check("no report requested", note.includes("report back to the owner"), true);
  check("unsure items have a place (watching)", note.includes("watching"), true);
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
})();
