"use strict";
// check-in owner_sleep branch: during the owner's sleep hours the branchesSleep pool is
// used, which adds an `owner_sleep` branch sent bare (no header).
// Checks: (1) never outside the window (2) inside, drawn by weight from the sleep pool
// (3) sent without the header (4) deck: no repeat until exhausted (5) no owner_sleep
// section → branch disabled, nothing invented (6) ownerSleep config, invalid → default
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const c = require("../../src/producers/checkin");

process.env.GATE_TZ_OFFSET_HOURS = "8";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "checkin-owner-sleep-"));
const texts = path.join(tmp, "texts.md");
fs.writeFileSync(texts, "## header\n开头\n\n## heart\n正文心里话\n\n## cave\n正文洞穴\n\n## fun\n正文娱乐{menu}\n\n## owner_sleep\n翻了个身\n说了句梦话\n");
const cfg = path.join(tmp, "cfg.json");
// default pool: heart only; sleep pool heart 0.6 / owner_sleep 0.4 → rand<0.6 heart, ≥0.6 owner_sleep
fs.writeFileSync(cfg, JSON.stringify({ branches: { heart: 1, cave: 0, fun: 0, egg: 0 },
  branchesSleep: { heart: 0.6, cave: 0, fun: 0, egg: 0, owner_sleep: 0.4 }, ownerSleep: { from: 4, to: 12 } }));
const bj = (h) => new Date(Date.UTC(2026, 8, 22, (h - 8 + 24) % 24, 30));   // h:30 at UTC+8

async function once({ hour, rand, textsFile = texts, state = path.join(tmp, "s-" + Math.random() + ".json") }) {
  const dir = fs.mkdtempSync(path.join(tmp, "out-"));
  const ck = c.makeCheckin({ dir, configFile: cfg, textsFile, stateFile: state, rand });
  const r = await ck.tick({ now: bj(hour) });
  const text = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), "utf8")).text;
  return { r, text };
}

(async () => {
  // ---- 6. 配置 ----
  assert.deepStrictEqual(c.readOwnerSleep(cfg), { from: 4, to: 12 });
  assert.strictEqual(c.readWeightsFromConfig(cfg, "branchesSleep", c.DEFAULT_SLEEP_BRANCH_WEIGHTS).owner_sleep, 0.4, "weight lives in the sleep pool");
  assert.strictEqual(c.readBranchWeights(cfg).owner_sleep, undefined, "default pool has no owner_sleep");
  const sum = Object.values(c.DEFAULT_SLEEP_BRANCH_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, "sleep pool defaults sum to 1: " + sum);
  const bad = path.join(tmp, "bad.json");
  fs.writeFileSync(bad, JSON.stringify({ ownerSleep: { from: 30, to: 12 } }));
  assert.deepStrictEqual(c.readOwnerSleep(bad), c.DEFAULT_OWNER_SLEEP, "invalid → default");
  assert.deepStrictEqual(c.readOwnerSleep(path.join(tmp, "无.json")), c.DEFAULT_OWNER_SLEEP);

  // ---- 1. outside the window (14:00): never, even on a hit roll ----
  {
    const { r, text } = await once({ hour: 14, rand: () => 0.9 });
    assert.ok(!r.ownerSleepLine);
    assert.ok(!text.includes("翻了个身") && !text.includes("梦话"), text);
  }
  // ---- 2. inside the window (06:00): roll decides ----
  {
    const hit = await once({ hour: 6, rand: () => 0.9 });
    assert.ok(hit.r.ownerSleepLine, "hit → owner_sleep");
    assert.strictEqual(hit.r.branch, "owner_sleep");
    // ---- 3. sent bare: the whole message is the one line ----
    assert.strictEqual(hit.text, hit.r.ownerSleepLine);
    const miss = await once({ hour: 6, rand: () => 0.1 });
    assert.ok(!miss.r.ownerSleepLine, "0.1 lands on heart");
    assert.ok(miss.text.startsWith("开头") && miss.text.includes("正文心里话"), "miss → normal check-in");
  }
  // window is [from, to): 12:00 excluded, 04:00 included
  assert.ok(!(await once({ hour: 12, rand: () => 0.9 })).r.ownerSleepLine);
  assert.ok((await once({ hour: 4, rand: () => 0.9 })).r.ownerSleepLine);

  // ---- 4. deck: two draws with the same state file give both lines ----
  {
    const state = path.join(tmp, "deck.json");
    const a = await once({ hour: 6, rand: () => 0.9, state });
    const b = await once({ hour: 6, rand: () => 0.9, state });
    assert.notStrictEqual(a.r.ownerSleepLine, b.r.ownerSleepLine, "no repeat until the deck is exhausted");
  }
  // ---- 5. no owner_sleep section: branch disabled ----
  {
    const noSec = path.join(tmp, "nosec.md");
    fs.writeFileSync(noSec, "## header\n开头\n\n## heart\n正文心里话\n");
    const { r, text } = await once({ hour: 6, rand: () => 0.9, textsFile: noSec });
    assert.ok(!r.ownerSleepLine);
    assert.ok(text.startsWith("开头"), "no owner_sleep texts → normal check-in");
  }
  console.log("checkin-owner-sleep: ok");
})().catch((e) => { console.error(e); process.exit(1); });
