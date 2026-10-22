"use strict";
// 笔记本到期提醒接进 check-in HEADER（2026-09-22 晚）。跟 heart-checkin-notebook.js
// 用同一个「读标题」的思路，但这里测的是新加的 expiredNotebookLine() / listExpired()
// 那条链——指向这次任务实际改过的 nova-notebook 副本（生产的 /root/nova-notebook
// 还没升级到有 listExpired，那边的旧测试用 try/catch 兜底验证了「没有这个函数也不炸」，
// 这份测的是「有这个函数之后，到期提醒真的接得上」）。
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { expiredNotebookLine, makeCheckinBeat } = require("../../src/heart/beats/checkin");

const NOTEBOOK_MODULE = "/root/.cache/phase2/nova-notebook/store";
const nb = require(NOTEBOOK_MODULE);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "checkin-expiry-"));

function bjDatePlus(n) {
  const d = new Date(Date.now() + 8 * 3600e3 + n * 86400000);
  return d.toISOString().slice(0, 10);
}

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => {
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : "  " + extra));
  ok ? pass++ : fail++;
};

console.log("[1] expiredNotebookLine：没有到期条目 → 空字符串");
{
  const nbFile = path.join(tmp, "none-expired.json");
  nb.open({ title: "还没到期", board: "now", expires: bjDatePlus(3), file: nbFile });
  const line = expiredNotebookLine({ moduleId: NOTEBOOK_MODULE, file: nbFile });
  check("空字符串", line === "", line);
}

console.log("[2] expiredNotebookLine：有到期条目 → 拼出「你有N条到期了」这一行，最多列 4 个标题");
{
  const nbFile = path.join(tmp, "expired.json");
  const ids = [];
  for (let i = 0; i < 5; i += 1) {
    ids.push(nb.open({ title: "到期条" + i, board: "now", expires: bjDatePlus(1), file: nbFile }).id);
  }
  // 直接改底层文件，把这 5 条的 expires 都拨到过去（模拟真的到期了）
  const raw = JSON.parse(fs.readFileSync(nbFile, "utf8"));
  for (const it of raw.entries) it.expires = "2020-01-01";
  fs.writeFileSync(nbFile, JSON.stringify(raw));

  const line = expiredNotebookLine({ moduleId: NOTEBOOK_MODULE, file: nbFile });
  check("带「你有5条到期了」", line.startsWith("你有5条到期了："), line);
  check("带「延期还是去掉」的问法", line.endsWith("延期还是去掉？"), line);
  const titleCount = (line.match(/「到期条\d」/g) || []).length;
  check("最多列 4 个标题（哪怕 5 条到期）", titleCount, 4);
}

console.log("[3] 模块装不上 / 没有 listExpired → 不炸，返回空字符串（旧版 store 的兜底）");
{
  const l1 = expiredNotebookLine({ moduleId: "/nonexistent/store", file: "无所谓" });
  check("不存在的模块", l1 === "", l1);
  // 造一个没有 listExpired 的假 store，模拟「生产还没升级」那种情况
  const fakeStoreFile = path.join(tmp, "fake-store.js");
  fs.writeFileSync(fakeStoreFile, "module.exports = { list: () => [] };\n");
  const l2 = expiredNotebookLine({ moduleId: fakeStoreFile, file: "无所谓" });
  check("模块没有 listExpired 函数", l2 === "", l2);
}

async function main() {
console.log("[4] makeCheckinBeat 接上之后，tick() 的正文里真的带出这一行（跟「悬着的」那半平级）");
{
  const nbFile = path.join(tmp, "beat.json");
  nb.open({ title: "早就该处理", board: "now", expires: bjDatePlus(1), file: nbFile });
  const raw = JSON.parse(fs.readFileSync(nbFile, "utf8"));
  raw.entries[0].expires = "2020-01-01";
  fs.writeFileSync(nbFile, JSON.stringify(raw));

  const dir = fs.mkdtempSync(path.join(tmp, "producers-"));
  const beat = makeCheckinBeat({
    dir, configFile: path.join(tmp, "nope-cfg.json"), textsFile: path.join(tmp, "nope-texts.md"),
    coldFile: path.join(tmp, "nope-cold.jsonl"), notebookModule: NOTEBOOK_MODULE, notebookFile: nbFile,
    desireUrl: "http://127.0.0.1:1",
    // 2026-09-22 起 check-in 改成空闲触发：这里验的是正文内容，塞个「立刻到点」的闹钟
    clock: { nextDelayMs: () => 0, isDue: () => true, fired() {}, peek: () => ({}) },
  });
  assert.strictEqual(beat.name, "check-in");
  await beat.tick();
  const f = fs.readdirSync(dir)[0];
  const text = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).text;
  check("正文里带出到期提醒那一行", text.includes("你有1条到期了：「早就该处理」"), text);
  check("到期提醒接在「你的驱力」那行附近（HEADER 里，不是正文里）", text.indexOf("你有1条到期了") < text.indexOf("\n\n"), text);
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
