"use strict";
/**
 * 工具插件（2026-09-18 Alice：「每个工具都做成插件 用的时候接上就好了 不动核心代码」）
 *
 * 验两件事：扔进目录就生效；**两条硬规矩挡得住**——
 *   1. 工具名是意图不是地址（telegram_reply 那种不许重新长出来）
 *   2. 投递归出闸（intent 和 handler 不许同时给）
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadTools, validate } = require("../../src/gate/tools");

let pass = 0, fail = 0;
const check = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

console.log("[1] 现役这几个装得上");
{
  const r = loadTools();
  check("装上的工具", r.list.map((t) => t.name).sort(),
    ["call", "hang_up", "react", "reply", "send_file", "send_image", "send_sticker", "send_voice"]);
  check("没有装不上的", r.errors, []);
  check("每个都说清了意图", r.list.every((t) => t.intent && !t.handler), true);
  check("都带 channel 可选参数（她让他发哪儿时用）",
    r.list.every((t) => t.schema.properties.channel), true);
  check("channel 不是必填（不给就原路返回）",
    r.list.every((t) => !(t.schema.required || []).includes("channel")), true);
}

console.log("\n[2] 硬规矩：工具名是意图，不是地址");
{
  const base = { description: "x", intent: "send_text" };
  for (const bad of ["telegram_reply", "wechat_send", "imessage_reply", "qq_push", "weixin_reply"]) {
    const why = validate({ ...base, name: bad });
    check("挡住 " + bad, /不许带渠道/.test(why), true);
  }
  check("正常名字放行", validate({ ...base, name: "reply" }), "");
}

console.log("\n[3] 硬规矩：投递归出闸，不许自己发");
{
  const why = validate({ name: "x", description: "x", intent: "send_text", handler: async () => {} });
  check("intent+handler 同时给要挡", /只能有一个/.test(why), true);
  check("都不给也要挡", /不知道要干嘛/.test(validate({ name: "x", description: "x" })), true);
  check("干活类只给 handler 可以",
    validate({ name: "diary_read", description: "x", handler: async () => {} }), "");
}

console.log("\n[4] 坏插件不拖垮整包");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tools-"));
  fs.writeFileSync(path.join(dir, "good.js"), 'module.exports={name:"good",description:"d",intent:"send_text"};');
  fs.writeFileSync(path.join(dir, "boom.js"), 'throw new Error("我坏了");');
  fs.writeFileSync(path.join(dir, "nameless.js"), 'module.exports={description:"d",intent:"send_text"};');
  const r = loadTools({ dir });
  check("好的照样装上", r.list.map((t) => t.name), ["good"]);
  check("坏的各记一笔", r.errors.length, 2);
  check("说得出为什么", /require 炸了/.test(r.errors.find((e) => e.file === "boom.js").why), true);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n[5] 关掉一个工具 = 一个字段，不动核心");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tools-off-"));
  fs.writeFileSync(path.join(dir, "on.js"), 'module.exports={name:"on",description:"d",intent:"send_text"};');
  fs.writeFileSync(path.join(dir, "off.js"), 'module.exports={name:"off",description:"d",intent:"send_text",enabled:false};');
  check("enabled:false 的不装", loadTools({ dir }).list.map((t) => t.name), ["on"]);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
