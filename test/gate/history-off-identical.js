"use strict";
// 全本开关关着（默认）时，盒子整条线的输出跟改动前（9a332e7）**逐字节一样**。
// 金标准 test/fixtures/real/box-golden-9a332e7.json 是拿 9a332e7 的代码树跑同一个剧本生成的：
//   git worktree add /tmp/imb-baseline 9a332e7 && node test/gate/lib/box-scenario.js /tmp/imb-baseline <输出>
// 剧本吐的是 S0 实抓的真实 SDK 帧（正文占位），走真 socket、真适配器、真盒子。
// 顺带：开关开着时，给她 / 给桥的东西也必须一样（全本只多记账，不改行为）。
const fs = require("fs"); const path = require("path");
const { runBoxScenario, FIX } = require("./lib/box-scenario");

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { if (ok) { pass++; console.log("  OK   " + n); } else { fail++; console.log("  FAIL " + n + "  " + extra); } };
const ROOT = path.join(__dirname, "..", "..");
const golden = fs.readFileSync(path.join(FIX, "box-golden-9a332e7.json"), "utf8");
const dump = (o) => JSON.stringify(o, null, 1) + "\n";

(async () => {
  const { createHistory, historyMode } = require("../../src/box/history");
  for (const v of [undefined, "", "off", "0", "shadow", "false"]) {
    const env = v === undefined ? {} : { GATE_HISTORY: v, GATE_ROOT: "/tmp/x" };
    check(`GATE_HISTORY=${JSON.stringify(v)} → 关`, historyMode(env) === "off" && createHistory({ root: "/tmp/x", env }) === null);
  }

  console.log("[1] 关着：跟 9a332e7 逐字节比");
  delete process.env.GATE_HISTORY;
  const off = await runBoxScenario({ root: ROOT, history: null });
  const offDump = dump(off.out);
  check("输出跟金标准逐字节一样", offDump === golden,
    `长度 ${offDump.length} vs ${golden.length}`);
  check("关着时一个全本文件都没有", !fs.existsSync(path.join(off.dir, "history")));
  check("剧本确实跑出了东西（不是空对空）", off.out.replies.length === 4 && off.out.dones.length === 3 && off.out.events.length > 20);

  console.log("[2] 开着：给桥的东西也一样，只多记账");
  const dir2 = fs.mkdtempSync(path.join(require("os").tmpdir(), "box-scenario-on-"));
  const history = createHistory({ root: dir2, persona: "测试", env: { GATE_HISTORY: "on", GATE_HISTORY_SECRETS_DIR: path.join(dir2, "no-secrets") } });
  check("GATE_HISTORY=on → 有记账员", Boolean(history));
  const on = await runBoxScenario({ root: ROOT, history, dir: dir2 });
  check("开着时给桥 / 给她的输出跟金标准逐字节一样", dump(on.out) === golden);
  const files = fs.readdirSync(path.join(dir2, "history"));
  check("开着时全本写出来了", files.some((f) => /^items-\d{4}-\d{2}\.jsonl$/.test(f)), files.join(","));

  console.log(`全本关着逐字节一致：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
