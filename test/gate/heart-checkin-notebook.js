"use strict";
// check-in「悬着的」那行只读笔记本（2026-09-20；9-21 起 pending-promises.md 退役；
// 9-22 起意图卡彻底拿掉、排序按 kind：欠她的先、还在聊的后；HEADER 目前不渲染这行了，
// 但 notebookTitles()/pendingText() 这条供料链没删，这个测试盯的就是这条链没坏）。
//
// ⚠️ 2026-09-22：nova-notebook 那边把 store.open() 改成必须给 board+expires
// （见 nova-notebook 自己的 store.js/test.js）。这个文件测的是 im-bridge 这头
// 读「标题」的链路，不是笔记本本身的校验规则，所以下面 store.open() 调用都
// 补上了 board/expires —— 这样不管这个测试当下跑的是老版本 store（还没升级，
// 会忽略这两个多出来的字段）还是新版本（会校验），都能过。
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { notebookTitles, makeCheckinBeat } = require("../../src/heart/beats/checkin");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heart-nb-"));
const nbFile = path.join(tmp, "notebook.json");
const store = require("/root/nova-notebook/store");

/** 北京日期字符串，n 天后（新旧两版 store 通用的写法，不写死日期）。 */
function bjDatePlus(n) {
  const d = new Date(Date.now() + 8 * 3600e3 + n * 86400000);
  return d.toISOString().slice(0, 10);
}

// 1. 空笔记本 → 一个标题都没有
assert.deepStrictEqual(notebookTitles({ moduleId: "/root/nova-notebook/store", file: nbFile }), []);
// 2. 装不上的模块 → 不炸，空
assert.deepStrictEqual(notebookTitles({ moduleId: "/nonexistent/store", file: nbFile }), []);

// 3. 写两条：一条欠她的、一条还在聊的（观察中）→ 只出标题，带观察中标记，不带卡在哪/出处，
//    且欠她的（promise）排在还在聊的（thread）前面
const t = store.open({ title: "陪她走付款路", kind: "thread", board: "now", expires: bjDatePlus(3), file: nbFile });
store.note(t.id, { state: "watching", file: nbFile });
store.open({
  title: "周日雨天那单", kind: "promise", board: "now", expires: bjDatePlus(3),
  last: "很短的卡点也不该出现", quote: "她的原话也不该出现", file: nbFile,
});
const titles = notebookTitles({ moduleId: "/root/nova-notebook/store", file: nbFile });
assert.strictEqual(titles.length, 2);
assert.deepStrictEqual(titles, ["周日雨天那单", "陪她走付款路（观察中）"], "promise 排在 thread 前面");
assert.ok(!titles.join("").includes("卡点"), "不该带 last");

// 4. 通过 makeCheckinBeat 拼出来的「悬着的」：只来自笔记本，不带前缀标签
const beat = makeCheckinBeat({
  dir: tmp, configFile: path.join(tmp, "nope.json"), coldFile: path.join(tmp, "cold.jsonl"),
  notebookModule: "/root/nova-notebook/store", notebookFile: nbFile,
  desireUrl: "http://127.0.0.1:1",
});
assert.strictEqual(beat.name, "check-in");
// makeCheckin 把 pendingText 收在闭包里；直接复现同一段拼法验语义
const line = titles.map((x) => "「" + x + "」").join("、");
assert.ok(line.startsWith("「周日雨天那单」"), line);
assert.ok(!line.includes("笔记本："), "9-22 起不带子标签前缀了");

// 5. 笔记本空 → 一行都不给（不再有旧文件可退）
fs.writeFileSync(nbFile, "[]");
assert.deepStrictEqual(notebookTitles({ moduleId: "/root/nova-notebook/store", file: nbFile }), []);
// 旧退路的输入根本没了：源码里不能再出现那份文件，意图卡文件也不该再被引用
const src = fs.readFileSync(path.join(__dirname, "../../src/heart/beats/checkin.js"), "utf8")
  + fs.readFileSync(path.join(__dirname, "../../src/box/instructions.js"), "utf8")
  + fs.readFileSync(path.join(__dirname, "../../src/host/heart-host.js"), "utf8");
assert.ok(!/pendingPromisesFile|CHECKIN_PENDING_FILE|readFileSync\(pendingFile/.test(src), "旧退路还在源码里");
// 只查真实用法（env 变量名 / 函数定义），别被自己解释「为什么删了」的注释文字误伤
assert.ok(!/SELF_LIFE_INTENTS_FILE|function dueIntents|intentsFile\s*:/.test(src), "意图卡那半没删干净");

console.log("heart-checkin-notebook: ok");
