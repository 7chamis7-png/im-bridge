"use strict";
/**
 * 能力面三层：共用的 / 每个插头都要表态的 / 只有某个插头才有的。
 * 重点验一条：**插头专属的东西在给不了的渠道上，必须明说，不许静默丢。**
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
// 2026-09-18 加了 start_call（打电话）——加意图就得所有插头表态，这条规矩本身也在测
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

// ⚠️ 2026-09-18：原 [4][5] 两段（插头专属参数在给不了的渠道上必须明说、并进冷层）
// 依赖已删掉的「工具收编表」——那张表把工具名写死在闸里，违反铁律 2。
// **能力本身没作废**，它属于投递口（见 docs/SPEC.md §8）：重写投递口时按这两段的
// 断言补回来——正文照发、专属参数不混进不认识它的渠道、返回里明说没出去、冷层留痕。
(async () => {
  console.log(`\n通过 ${pass} / 失败 ${fail}   (隔离目录 ${root})`);
  process.exit(fail ? 1 : 0);
})();
