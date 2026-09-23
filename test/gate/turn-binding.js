"use strict";
/** Turn binding: readable across processes, survives restarts, unknown -> null. */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { TurnBinding } = require("../../src/gate/turn-binding");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-tb-"));
const file = path.join(root, "turn-bindings.json");
let pass = 0, fail = 0;
const check = (n, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(g)} want=${JSON.stringify(w)}`));
  ok ? pass++ : fail++;
};
const ev = (id, ch) => ({ eventId: id, channel: ch, chatId: "c1", accountId: "a1" });

const b = new TurnBinding({ file });
console.log("\n[1] 记下来、查得到");
b.bind("th1", "t1", ev("e1", "wechat"));
check("查到 e1", b.lookup("th1", "t1").eventId, "e1");
check("渠道也带着", b.lookup("th1", "t1").channel, "wechat");

console.log("\n[2] 查不到就是 null —— 不猜、不给默认值");
check("没绑过", b.lookup("th1", "t999"), null);
check("空 threadId", b.lookup("", ""), null);

console.log("\n[3] 跨进程读得到（工具进程是独立进程，这条是它存在的理由）");
const out = execFileSync(process.execPath, ["-e",
  `const {TurnBinding}=require("${path.resolve(__dirname, "../../src/gate/turn-binding")}");` +
  `process.stdout.write(new TurnBinding({file:${JSON.stringify(file)}}).lookup("th1","t1").eventId)`],
  { encoding: "utf8" });
check("另一个进程也读到 e1", out.trim(), "e1");

console.log("\n[4] 重启不丢（新实例照样读得到）");
check("新实例读到", new TurnBinding({ file }).lookup("th1", "t1").eventId, "e1");

console.log("\n[5] 只留最近 500 轮，文件不会长到没边");
for (let i = 0; i < 520; i++) b.bind("th2", "n" + i, ev("e" + i, "telegram"));
const size = Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))).length;
check("条数封顶", size <= 500, true);
check("最新的还在", b.lookup("th2", "n519").eventId, "e519");
check("最老的被挤掉", b.lookup("th2", "n0"), null);

console.log(`\n通过 ${pass} / 失败 ${fail}   (隔离目录 ${root})`);
process.exit(fail ? 1 : 0);
