"use strict";
// Watch waterline hooks: 30% waterline (trim/rotate) and 85% high-water closing turn; cooldown, retrySoon, disabled.
const fs = require("fs"); const os = require("os"); const path = require("path");
const { makeWatch } = require("../../src/host/watch");
let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { if (ok) { pass++; console.log("  OK   " + n); } else { fail++; console.log("  FAIL " + n + "  " + extra); } };
const tick = async (w) => { w.tick(); await new Promise((r) => setTimeout(r, 5)); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-"));
  const hbFile = path.join(dir, "heartbeat.json");
  let T = 1_000_000_000_000;
  const hb = (ratio, threadId = "t1") => fs.writeFileSync(hbFile, JSON.stringify({ at: new Date(T).toISOString(), upSec: 100, progress: { pending: 0 }, stats: {}, fullness: { used: ratio * 1e6, limit: 1e6, ratio, threadId } }));
  const calls = []; let retry = false; const high = [];
  const w = makeWatch({ heartbeatFile: hbFile, notify: () => {}, now: () => T,
    onWaterline: async (x) => { calls.push(x); return retry ? { retrySoon: true } : undefined; },
    onHighWater: (x) => high.push(x) });

  console.log("[1] 没撞线不动");
  hb(0.2); await tick(w); check("0.2 不触发", calls.length === 0);

  console.log("[2] 撞线触发一次，冷却期内不重复");
  hb(0.35); await tick(w); check("0.35 触发", calls.length === 1 && calls[0].threadId === "t1" && calls[0].used === 350000);
  T += 60_000; hb(0.36); await tick(w); check("1 分钟后不再触发", calls.length === 1);
  T += 30 * 60_000; hb(0.37); await tick(w); check("31 分钟后再触发", calls.length === 2);

  console.log("[3] agent 正在说话 → 5 分钟后再看");
  retry = true; T += 31 * 60_000; hb(0.38); await tick(w); check("触发（返回 retrySoon）", calls.length === 3);
  T += 2 * 60_000; hb(0.38); await tick(w); check("2 分钟后还不看", calls.length === 3);
  T += 4 * 60_000; hb(0.38); await tick(w); check("6 分钟后看了", calls.length === 4);
  retry = false;

  console.log("[4] 换了会话各算各的");
  hb(0.4, "t2"); await tick(w); check("新会话立刻触发", calls.length === 5 && calls[4].threadId === "t2");

  console.log("[5] 85% 收尾另一条线，只推一次");
  T += 31 * 60_000; hb(0.86, "t2"); await tick(w); check("85% 推收尾", high.length === 1);
  hb(0.9, "t2"); await tick(w); check("同会话不再推", high.length === 1);

  console.log("[6] waterlineRatio=0 关掉");
  const w2 = makeWatch({ heartbeatFile: hbFile, notify: () => {}, now: () => T, waterlineRatio: 0, onWaterline: () => calls.push("no") });
  hb(0.5, "t3"); await tick(w2); check("关掉不触发", !calls.includes("no"));

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
