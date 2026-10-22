"use strict";
// 开局文本里的「## PENDING PROMISES」这一段确实是笔记本渲染出来的（2026-09-22
// 笔记本改成「当下/意图卡」两板块 + 到期日 + 置顶「她最近」之后，顺带验一下
// instructions.js 这头不用改代码就能自动跟着新格式走——它只是原样转发
// store.render() 的输出，见 src/box/instructions.js 的 loadPendingPromises()）。
// 盯的事：①置顶排最前 ②当下排意图卡前面 ③到期/延期次数带得出来 ④笔记本空着不炸、不留空壳标题
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildOpeningTurnText } = require("../../src/box/instructions");

// 指向这次任务实际改过的 nova-notebook 副本（不是生产的 /root/nova-notebook，
// 那份还没升级），这样测的是「新版 store 装上之后 instructions.js 能不能正常转发」。
const NOTEBOOK_MODULE = "/root/.cache/phase2/nova-notebook/store";
const nb = require(NOTEBOOK_MODULE);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "instructions-nb-"));

function bjDatePlus(n) {
  const d = new Date(Date.now() + 8 * 3600e3 + n * 86400000);
  return d.toISOString().slice(0, 10);
}

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => {
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : "  " + extra));
  ok ? pass++ : fail++;
};

console.log("[1] 笔记本空着 → 开局文本里没有 PENDING PROMISES 这一段（不给空壳标题）");
{
  const nbFile = path.join(tmp, "empty.json");
  fs.writeFileSync(nbFile, "[]");
  const text = buildOpeningTurnText({ notebookModule: NOTEBOOK_MODULE, notebookFile: nbFile }, "你好");
  check("没有 PENDING PROMISES 标题", !text.includes("## PENDING PROMISES"), text);
}

console.log("[2] 置顶 → 当下 → 意图卡，顺序照笔记本自己的规矩来；带到期/延期次数");
{
  const nbFile = path.join(tmp, "full.json");
  nb.herRecentSet({ state: "状态测试", busy: "在忙测试", wants: "想要测试", file: nbFile });
  const nowEntry = nb.open({ title: "当下条目", board: "now", expires: bjDatePlus(3), file: nbFile });
  nb.open({ title: "意图卡条目", kind: "promise", board: "intent", expires: bjDatePlus(20), file: nbFile });
  nb.extend(nowEntry.id, { expires: bjDatePlus(4), file: nbFile });

  const text = buildOpeningTurnText({ notebookModule: NOTEBOOK_MODULE, notebookFile: nbFile }, "你好");
  check("有 PENDING PROMISES 段", text.includes("## PENDING PROMISES"), text);

  const section = text.split("## PENDING PROMISES")[1].split("\n\n## ")[0];
  const iPinned = section.indexOf("📌 她最近");
  const iNow = section.indexOf("### 当下");
  const iIntent = section.indexOf("### 意图卡");
  check("置顶最先出现", iPinned >= 0 && iPinned < iNow, section);
  check("当下在意图卡前面", iNow >= 0 && iNow < iIntent, section);
  check("置顶三个字段都在", section.includes("状态：状态测试") && section.includes("在忙：在忙测试") && section.includes("她想要：想要测试"), section);
  check("当下条目带到期日", section.includes("到期 " + bjDatePlus(4)), section);
  check("当下条目带延期次数", section.includes("已延期1次"), section);
  check("意图卡条目也在", section.includes("意图卡条目"), section);
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
