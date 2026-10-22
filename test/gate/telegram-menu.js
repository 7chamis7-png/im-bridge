"use strict";
// TG 菜单跟命令表同一份（10-21）：起来时 setMyCommands = commands.list()，常用的排前面；
// 设不上只记日志不抛（菜单是方便，不是收发链路）。
const { makeCommands } = require("../../src/gate/commands");
const { syncTelegramMenu } = require("../../src/gate/telegram-menu");

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { if (ok) { pass++; console.log("  OK   " + n); } else { fail++; console.log("  FAIL " + n + "  " + extra); } };

(async () => {
  const commands = makeCommands({ box: { rotate: async () => ({}), fullness: () => ({}) } });
  commands.register("usage", async () => ({}), { desc: "看额度" });
  commands.register("zzz_extra", async () => ({}), { desc: "后加的" });
  commands.register("Bad-Name", async () => ({}), { desc: "TG 不认的名字" });

  const calls = [];
  const logs = [];
  const r = await syncTelegramMenu({ commands, call: async (m, p) => { calls.push([m, p]); return true; }, log: (s) => logs.push(s) });
  const menu = calls[0] && calls[0][1].commands;
  check("调的是 setMyCommands", calls.length === 1 && calls[0][0] === "setMyCommands");
  check("命令表里有的都上了菜单（TG 不认的名字除外）",
    commands.names().filter((n) => /^[a-z0-9_]+$/.test(n)).every((n) => menu.some((m) => m.command === n)), JSON.stringify(menu));
  check("TG 不认的名字不上", !menu.some((m) => /-/.test(m.command)));
  check("常用的排前面：status 在 usage 前，usage 在 new 前",
    menu.findIndex((m) => m.command === "status") < menu.findIndex((m) => m.command === "usage")
    && menu.findIndex((m) => m.command === "usage") < menu.findIndex((m) => m.command === "new"));
  check("没列进顺序表的跟在最后", menu[menu.length - 1].command === "zzz_extra");
  check("描述用注册时的 desc", menu.find((m) => m.command === "usage").description === "看额度");
  check("成功回 ok", r.ok === true);

  const r2 = await syncTelegramMenu({ commands, call: async () => { throw new Error("网断了"); }, log: (s) => logs.push(s) });
  check("设不上不抛，回 ok:false 并记日志", r2.ok === false && logs.some((s) => s.includes("没设上")));

  // 没按钮的渠道：按钮写成文字（pipeline.buttonsAsText）
  const { buttonsAsText } = require("../../src/gate/pipeline");
  const t = buttonsAsText([[{ text: "✓ Fable 5", callback_data: "/model claude-fable-5[1m]" }], [{ text: "Opus 5.5", callback_data: "/model claude-opus-5-5[1m]" }]]);
  check("按钮转文字：每个选项一行带完整命令", t.includes("✓ Fable 5：/model claude-fable-5[1m]") && t.includes("Opus 5.5：/model claude-opus-5-5[1m]"), t);
  check("没有按钮就不加字", buttonsAsText([]) === "");

  console.log(`\nTG 菜单：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
