"use strict";
/** 一键回退开关：读不到一律回老路。隔离跑，不碰生产。 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { KillSwitch } = require("../../src/gate/killswitch");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-ks-"));
const flag = path.join(root, ".gate-enabled");
let pass = 0, fail = 0;
const check = (n, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(g)} want=${JSON.stringify(w)}`));
  ok ? pass++ : fail++;
};

let clock = 0;
const ks = new KillSwitch({ flagFile: flag, ttlMs: 1000, now: () => clock });

console.log("\n[1] 默认关着——文件不在就走老路（fail-safe）");
check("没文件 = 关", ks.enabled(), false);

console.log("\n[2] 放文件 = 新桥接管");
fs.writeFileSync(flag, "");
clock += 2000;
check("有文件 = 开", ks.enabled(), true);

console.log("\n[3] 删文件 = 下一轮就回老路，不用重启");
fs.unlinkSync(flag);
clock += 2000;
check("删掉 = 关", ks.enabled(), false);

console.log("\n[4] TTL 内不重复打文件系统");
fs.writeFileSync(flag, "");
check("TTL 没到，还用缓存的旧值", ks.enabled(), false);
clock += 2000;
check("TTL 过了，读到新值", ks.enabled(), true);

console.log("\n[5] 目录整个没了也不炸，按关处理");
const ks2 = new KillSwitch({ flagFile: "/nonexistent-dir-xyz/.gate-enabled", now: () => clock });
check("路径不存在 = 关", ks2.enabled(), false);
const ks3 = new KillSwitch({ flagFile: root, now: () => clock });   // 指向目录不是文件
check("指向目录不是文件 = 关", ks3.enabled(), false);

console.log("\n[6] 只在状态变化时出日志，不刷屏");
const ks4 = new KillSwitch({ flagFile: flag, ttlMs: 0, now: () => clock });
check("第一次有话说", /已接管/.test(ks4.transition() || ""), true);
check("状态没变就闭嘴", ks4.transition(), null);
fs.unlinkSync(flag);
check("变回去了才再出一行", /走老路/.test(ks4.transition() || ""), true);

console.log(`\n通过 ${pass} / 失败 ${fail}   (隔离目录 ${root})`);
process.exit(fail ? 1 : 0);
