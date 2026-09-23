"use strict";
/**
 * Capability surface: shared / declared by every plugin / plugin-specific.
 * Key check: plugin-specific extras on channels without them are reported, never dropped.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { GateStore } = require("../../src/gate/store");
const { ColdWriter } = require("../../src/gate/cold-writer");
const { OutboundGate } = require("../../src/gate/outbound");
const { Capabilities } = require("../../src/gate/capabilities");
const { classifyArgs, describePlugin, missingShared, COMMON_INTENTS } = require("../../src/gate/surface");
const { TelegramPlugin } = require("../../src/gate/plugins/telegram");
const { WeChatPlugin } = require("../../src/gate/plugins/wechat");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-surface-"));
let pass = 0, fail = 0;
const check = (n, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(g)} want=${JSON.stringify(w)}`));
  ok ? pass++ : fail++;
};

console.log("\n[1] 第 3 层分类：按钮只有 TG 认");
const tg = classifyArgs({ args: { text: "选一个", inline_keyboard: [{ text: "A", callback_data: "a" }] }, channel: "telegram" });
check("TG 上按钮进 extras", Object.keys(tg.extras), ["inline_keyboard"]);
check("TG 上没有不支持项", tg.unsupported.length, 0);
const wx = classifyArgs({ args: { text: "选一个", inline_keyboard: [{ text: "A", callback_data: "a" }] }, channel: "wechat" });
check("微信上按钮不进 extras", Object.keys(wx.extras).length, 0);
check("微信上按钮进 unsupported", wx.unsupported.map((u) => u.name), ["inline_keyboard"]);
check("并且说得出谁才有", wx.unsupported[0].honoredBy, ["telegram"]);
check("正文照常留在 content", tg.content.text, "选一个");
check("空按钮数组不算数，不报噪音", classifyArgs({ args: { inline_keyboard: [] }, channel: "wechat" }).unsupported.length, 0);

console.log("\n[2] 第 2 层：每个插头对 6 个通用意图都要表态");
for (const p of [new TelegramPlugin({}), new WeChatPlugin({})]) {
  const d = describePlugin(p);
  check(`${d.channel} 没有漏表态的通用意图`, d.undeclared, []);
}
// start_call: adding an intent requires every plugin to declare it; this rule is tested too
  check("通用意图现在 8 个", COMMON_INTENTS.length, 8);
check("TG 有专属花样", describePlugin(new TelegramPlugin({})).extras.length > 0, true);
check("微信一个专属花样都没有", describePlugin(new WeChatPlugin({})).extras, []);

console.log("\n[3] 第 1 层：共用能力没注册要点得出名字，别等运行时才发现");
const caps = new Capabilities();
check("一个没注册时全部点名", missingShared(caps).sort(), ["acoustic", "file_store", "generate_image", "synthesize_voice", "transcribe"]);
caps.register("synthesize_voice", async () => ({}));
check("注册一个就少一个", missingShared(caps).includes("synthesize_voice"), false);
let dup = "";
try { caps.register("synthesize_voice", async () => ({})); } catch (e) { dup = e.message; }
check("同名第二份实现直接报错（只有一份是硬要求）", /不允许第二份/.test(dup), true);

// Unsupported plugin-specific args are covered by the outlet tests (test/gate/outlet.js):
// text is still sent, extras never leak to channels that don't know them, and the
// result states explicitly that they did not go out.
(async () => {
  console.log(`\n通过 ${pass} / 失败 ${fail}   (隔离目录 ${root})`);
  process.exit(fail ? 1 : 0);
})();
