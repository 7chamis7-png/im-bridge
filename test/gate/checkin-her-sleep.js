"use strict";
// check-in「她睡着时的动作」（2026-09-22 Alice：「睡眠时间 在你怀里动了动 说了一句梦话 说渴要喝水」「4-12点」「要概率」）。
// 她同日定：它是 check-in 的第五个分支「她的动静」（「为啥不能加在checkin里面呢」「他出现的时候其他checkin不出现 概率算在一起」）。
// 盯的事：①钟点外不出 ②钟点内用睡着池子（五支）抽，抽中才出；钟点外用白天池子（四支） ③出的时候不带开头，整条就是她的一个动静
// ④一副牌抽完才重复 ⑤文案没配 her_sleep 段就不加、不编兜底 ⑥herSleep 配置可改、不合法退默认
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const c = require("../../src/producers/checkin");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "checkin-her-sleep-"));
const texts = path.join(tmp, "texts.md");
fs.writeFileSync(texts, "## header\n开头\n\n## heart\n正文心里话\n\n## cave\n正文洞穴\n\n## fun\n正文娱乐{menu}\n\n## her_sleep\n她在你怀里动了动\n她迷迷糊糊说渴\n");
const cfg = path.join(tmp, "cfg.json");
// 白天池子只有 heart；睡着池子 heart 0.6 / her_sleep 0.4 → rand<0.6 落 heart，≥0.6 落她的动静
fs.writeFileSync(cfg, JSON.stringify({ branches: { heart: 1, cave: 0, fun: 0, egg: 0 },
  branchesSleep: { heart: 0.6, cave: 0, fun: 0, egg: 0, her_sleep: 0.4 }, herSleep: { from: 4, to: 12 } }));
const bj = (h) => new Date(Date.UTC(2026, 8, 22, (h - 8 + 24) % 24, 30));   // 京时 h 点半

async function once({ hour, rand, textsFile = texts, state = path.join(tmp, "s-" + Math.random() + ".json") }) {
  const dir = fs.mkdtempSync(path.join(tmp, "out-"));
  const ck = c.makeCheckin({ dir, configFile: cfg, textsFile, stateFile: state, rand });
  const r = await ck.tick({ now: bj(hour) });
  const text = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), "utf8")).text;
  return { r, text };
}

(async () => {
  // ---- 6. 配置 ----
  assert.deepStrictEqual(c.readHerSleep(cfg), { from: 4, to: 12 });
  assert.strictEqual(c.readWeightsFromConfig(cfg, "branchesSleep", c.DEFAULT_SLEEP_BRANCH_WEIGHTS).her_sleep, 0.4, "份量在睡着池子里");
  assert.strictEqual(c.readBranchWeights(cfg).her_sleep, undefined, "白天池子没有她的动静");
  const sum = Object.values(c.DEFAULT_SLEEP_BRANCH_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, "睡着池子默认值加起来等于 1：" + sum);
  const bad = path.join(tmp, "bad.json");
  fs.writeFileSync(bad, JSON.stringify({ herSleep: { from: 30, to: 12 } }));
  assert.deepStrictEqual(c.readHerSleep(bad), c.DEFAULT_HER_SLEEP, "不合法的项全退默认");
  assert.deepStrictEqual(c.readHerSleep(path.join(tmp, "无.json")), c.DEFAULT_HER_SLEEP);

  // ---- 1. 钟点外（京时 14 点）：哪怕掷中也不加 ----
  {
    const { r, text } = await once({ hour: 14, rand: () => 0.9 });
    assert.ok(!r.herSleepLine);
    assert.ok(!text.includes("她在你怀里") && !text.includes("说渴"), text);
  }
  // ---- 2. 钟点内（京时 6 点）：掷中（0 < 0.4）加；掷不中（0.9）不加 ----
  {
    const hit = await once({ hour: 6, rand: () => 0.9 });
    assert.ok(hit.r.herSleepLine, "掷中应该出她的动静");
    assert.strictEqual(hit.r.branch, "her_sleep");
    // ---- 3. check-in 里的一个分支，但不带开头：整条就是她的一个动静 ----
    assert.strictEqual(hit.text, hit.r.herSleepLine);
    const miss = await once({ hour: 6, rand: () => 0.1 });
    assert.ok(!miss.r.herSleepLine, "0.1 落在 heart 那段");
    assert.ok(miss.text.startsWith("开头") && miss.text.includes("正文心里话"), "没掷中照常 check-in");
  }
  // 12 点整不算（区间左闭右开），4 点整算
  assert.ok(!(await once({ hour: 12, rand: () => 0.9 })).r.herSleepLine);
  assert.ok((await once({ hour: 4, rand: () => 0.9 })).r.herSleepLine);

  // ---- 4. 一副牌：同一个状态文件连抽两次，两句都出现，不重复 ----
  {
    const state = path.join(tmp, "deck.json");
    const a = await once({ hour: 6, rand: () => 0.9, state });
    const b = await once({ hour: 6, rand: () => 0.9, state });
    assert.notStrictEqual(a.r.herSleepLine, b.r.herSleepLine, "抽完一副才重复");
  }
  // ---- 5. 文案没有 her_sleep 段：不加，不编 ----
  {
    const noSec = path.join(tmp, "nosec.md");
    fs.writeFileSync(noSec, "## header\n开头\n\n## heart\n正文心里话\n");
    const { r, text } = await once({ hour: 6, rand: () => 0.9, textsFile: noSec });
    assert.ok(!r.herSleepLine);
    assert.ok(text.startsWith("开头"), "没配动作就照常 check-in");
  }
  console.log("checkin-her-sleep: 全部通过");
})().catch((e) => { console.error(e); process.exit(1); });
