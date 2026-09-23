"use strict";
// egg branch: notes/oldquote/deeptalk/dare/hidden sub-types, decks (draw without
// replacement, reshuffle when empty), configurable night window, and state that
// survives a "restart" (a new makeCheckin on the same stateFile).
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const c = require("../../src/producers/checkin");

process.env.GATE_TZ_OFFSET_HOURS = "8";   // the times below are written as UTC+8 wall-clock
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "checkin-egg-"));

/** Only `key` gets weight, so the die always lands on it. */
function forceOnly(defaults, key) {
  const out = {};
  for (const k of Object.keys(defaults)) out[k] = k === key ? 1 : 0;
  return out;
}

function writeCfg(file, obj) {
  // Force the sleep-hours pool too, otherwise cases inside the sleep window use its defaults.
  if (obj.branches && !obj.branchesSleep) obj = { ...obj, branchesSleep: { ...obj.branches, owner_sleep: 0 } };
  fs.writeFileSync(file, JSON.stringify(obj));
}

function lastText(dir) {
  const files = fs.readdirSync(dir).sort();
  const f = files[files.length - 1];
  return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).text;
}

async function main() {
  // ---- 1. egg can be forced; header shows its branch name ----
  {
    const dir = fs.mkdtempSync(path.join(tmp, "dir-"));
    const cfg = path.join(tmp, "cfg-egg1.json");
    writeCfg(cfg, {
      branches: forceOnly(c.DEFAULT_BRANCH_WEIGHTS, "egg"),
      eggs: forceOnly(c.DEFAULT_EGG_WEIGHTS, "notes"),
    });
    const md = path.join(tmp, "texts-egg1.md");
    fs.writeFileSync(md, "## egg_notes\n纸条甲\n纸条乙\n");
    const chk = c.makeCheckin({
      dir, configFile: cfg, textsFile: md, coldFile: path.join(tmp, "无.jsonl"),
      drivesUrl: "", rand: () => 0.3,
    });
    const r = await chk.tick();
    assert.strictEqual(r.branch, "egg");
    assert.strictEqual(r.eggType, "notes");
    const text = lastText(dir);
    assert.ok(text.includes("[Surprise]"), text);
    assert.ok(text.includes("纸条甲") || text.includes("纸条乙"), text);
  }

  // ---- 2. deeptalk: day pool vs. night pool ----
  {
    const dir = fs.mkdtempSync(path.join(tmp, "dir-"));
    const cfg = path.join(tmp, "cfg-egg2.json");
    writeCfg(cfg, {
      branches: forceOnly(c.DEFAULT_BRANCH_WEIGHTS, "egg"),
      eggs: forceOnly(c.DEFAULT_EGG_WEIGHTS, "deeptalk"),
    });
    const md = path.join(tmp, "texts-egg2.md");
    fs.writeFileSync(md, "## egg_deeptalk_day\n白天问题\n## egg_deeptalk_night\n深夜问题\n");
    const chk = c.makeCheckin({
      dir, configFile: cfg, textsFile: md, coldFile: path.join(tmp, "无2.jsonl"),
      drivesUrl: "", rand: () => 0.3,
    });
    // 10:00 (day)
    const rDay = await chk.tick({ now: new Date("2026-09-22T02:00:00.000Z") });
    assert.strictEqual(rDay.eggType, "deeptalk");
    const dayText = lastText(dir);
    assert.ok(dayText.includes("Deep talk:"), dayText);
    assert.ok(dayText.includes("白天问题"), dayText);
    assert.ok(dayText.includes("Answer if you like."), dayText);

    // 04:00 (inside the default 22:00–10:00 night window)
    const rNight = await chk.tick({ now: new Date("2026-09-21T20:00:00.000Z") });
    assert.strictEqual(rNight.eggType, "deeptalk");
    const nightText = lastText(dir);
    assert.ok(nightText.includes("深夜问题"), nightText);
  }

  // ---- 3. dare: day uses egg_dare; night uses egg_dare ∪ egg_dare_night ----
  {
    const dir = fs.mkdtempSync(path.join(tmp, "dir-"));
    const cfg = path.join(tmp, "cfg-egg3.json");
    writeCfg(cfg, {
      branches: forceOnly(c.DEFAULT_BRANCH_WEIGHTS, "egg"),
      eggs: forceOnly(c.DEFAULT_EGG_WEIGHTS, "dare"),
    });
    const md = path.join(tmp, "texts-egg3.md");
    fs.writeFileSync(md, "## egg_dare\n白天大冒险\n## egg_dare_night\n夜间大冒险\n");
    const chk = c.makeCheckin({
      dir, configFile: cfg, textsFile: md, coldFile: path.join(tmp, "无3.jsonl"),
      drivesUrl: "", rand: () => 0.3,
    });
    const rDay = await chk.tick({ now: new Date("2026-09-22T02:00:00.000Z") }); // 10:00 day
    assert.strictEqual(rDay.eggType, "dare");
    const dayText = lastText(dir);
    assert.ok(dayText.includes("Dare: 白天大冒险"), dayText);
    assert.ok(!dayText.includes("夜间"), "day must not draw from the night pool: " + dayText);
    assert.ok(dayText.includes("Send it over"), dayText);

    // night deck is separate and still has cards
    const rNight = await chk.tick({ now: new Date("2026-09-21T20:00:00.000Z") }); // 04:00 night
    assert.strictEqual(rNight.eggType, "dare");
    assert.ok(lastText(dir).includes("Dare: "), lastText(dir));
  }

  // ---- 4. hidden: exactly that one line after the header ----
  {
    const dir = fs.mkdtempSync(path.join(tmp, "dir-"));
    const cfg = path.join(tmp, "cfg-egg4.json");
    writeCfg(cfg, {
      branches: forceOnly(c.DEFAULT_BRANCH_WEIGHTS, "egg"),
      eggs: forceOnly(c.DEFAULT_EGG_WEIGHTS, "hidden"),
    });
    const md = path.join(tmp, "texts-egg4.md");
    fs.writeFileSync(md, "## egg_hidden\n隐藏事件触发：测试用语\n");
    const chk = c.makeCheckin({
      dir, configFile: cfg, textsFile: md, coldFile: path.join(tmp, "无4.jsonl"),
      drivesUrl: "", rand: () => 0.3,
    });
    const r = await chk.tick();
    assert.strictEqual(r.eggType, "hidden");
    const text = lastText(dir);
    const body = text.split("\n\n").slice(1).join("\n\n");
    assert.strictEqual(body, "隐藏事件触发：测试用语", "nothing else after hidden: " + text);
  }

  // ---- 5. oldquote: owner message ≥3 days old, 8–120 chars, not a [media] placeholder ----
  {
    const dir = fs.mkdtempSync(path.join(tmp, "dir-"));
    const cfg = path.join(tmp, "cfg-egg5.json");
    writeCfg(cfg, {
      branches: forceOnly(c.DEFAULT_BRANCH_WEIGHTS, "egg"),
      eggs: forceOnly(c.DEFAULT_EGG_WEIGHTS, "oldquote"),
    });
    const cold = path.join(tmp, "cold-oldquote.jsonl");
    const oldAt = "2026-09-01T00:00:00.000Z";   // > 3 days before now
    const recentAt = "2026-09-21T23:00:00.000Z"; // too recent
    const rows = [
      { id: "1", role: "user", at: oldAt, text: "这是一条够长也够旧的测试旧话" },
      { id: "2", role: "user", at: oldAt, text: "[图片]" },                // skipped
      { id: "3", role: "user", at: oldAt, text: "短" },                    // too short
      { id: "4", role: "assistant", at: oldAt, text: "这条够长够旧但角色是 assistant" },
      { id: "5", role: "user", at: recentAt, text: "这条够长但太新了不该被抽中噢" },
    ];
    fs.writeFileSync(cold, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const chk = c.makeCheckin({
      dir, configFile: cfg, textsFile: path.join(tmp, "无5.md"), coldFile: cold,
      drivesUrl: "", rand: () => 0.3,
    });
    const r = await chk.tick({ now: new Date("2026-09-22T00:00:00.000Z") });
    assert.strictEqual(r.eggType, "oldquote");
    const text = lastText(dir);
    // Only look at the body (the header's last-user line legitimately quotes the newest message).
    const body = text.split("\n\n").slice(1).join("\n\n");
    assert.ok(body.includes("Old quote: on 2026-09-01 the owner said"), body);
    assert.ok(body.includes("这是一条够长也够旧的测试旧话"), "should pick the one eligible quote: " + body);
    assert.ok(!body.includes("太新了"), "too-recent message must not be picked: " + body);
  }

  // ---- 6. deck: no repeats until exhausted, then reshuffle ----
  {
    const dir = fs.mkdtempSync(path.join(tmp, "dir-"));
    const cfg = path.join(tmp, "cfg-egg6.json");
    writeCfg(cfg, {
      branches: forceOnly(c.DEFAULT_BRANCH_WEIGHTS, "egg"),
      eggs: forceOnly(c.DEFAULT_EGG_WEIGHTS, "notes"),
    });
    const md = path.join(tmp, "texts-egg6.md");
    fs.writeFileSync(md, "## egg_notes\n甲\n乙\n丙\n");
    const chk = c.makeCheckin({
      dir, configFile: cfg, textsFile: md, coldFile: path.join(tmp, "无6.jsonl"),
      drivesUrl: "", rand: Math.random,
    });
    const picks = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await chk.tick();
      picks.push(lastText(dir).split("\n\n")[1]);
    }
    assert.deepStrictEqual(picks.slice().sort(), ["丙", "乙", "甲"], "three draws = the three cards: " + picks);
    // fourth draw: reshuffled
    const r4 = await chk.tick();
    const pick4 = lastText(dir).split("\n\n")[1];
    assert.ok(["甲", "乙", "丙"].includes(pick4), pick4);
  }

  // ---- 7. removed line leaves the deck; added line joins it ----
  {
    const dir = fs.mkdtempSync(path.join(tmp, "dir-"));
    const cfg = path.join(tmp, "cfg-egg7.json");
    writeCfg(cfg, {
      branches: forceOnly(c.DEFAULT_BRANCH_WEIGHTS, "egg"),
      eggs: forceOnly(c.DEFAULT_EGG_WEIGHTS, "notes"),
    });
    const md = path.join(tmp, "texts-egg7.md");
    fs.writeFileSync(md, "## egg_notes\n甲\n乙\n丙\n");
    const stateFile = path.join(tmp, "state-egg7.json");
    const chk = c.makeCheckin({
      dir, configFile: cfg, textsFile: md, stateFile, coldFile: path.join(tmp, "无7.jsonl"),
      drivesUrl: "", rand: () => 0,   // always draw remaining[0]
    });
    await chk.tick();
    // remove 乙, add 丁
    fs.writeFileSync(md, "## egg_notes\n甲\n丙\n丁\n");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.ok(Array.isArray(state.decks.notes.remaining));
    for (let i = 0; i < 5; i += 1) {
      const r = await chk.tick();
      const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      assert.ok(!st.decks.notes.remaining.includes("乙"), "removed card must leave remaining");
      assert.ok(!st.decks.notes.pool.includes("乙"), "removed card must leave pool");
    }
  }

  // ---- 8. nightHours is configurable ----
  {
    const dir = fs.mkdtempSync(path.join(tmp, "dir-"));
    const cfg = path.join(tmp, "cfg-egg8.json");
    writeCfg(cfg, {
      branches: forceOnly(c.DEFAULT_BRANCH_WEIGHTS, "egg"),
      eggs: forceOnly(c.DEFAULT_EGG_WEIGHTS, "deeptalk"),
      nightHours: { from: 0, to: 6 },
    });
    const md = path.join(tmp, "texts-egg8.md");
    fs.writeFileSync(md, "## egg_deeptalk_day\n白天问题\n## egg_deeptalk_night\n深夜问题\n");
    const chk = c.makeCheckin({
      dir, configFile: cfg, textsFile: md, coldFile: path.join(tmp, "无8.jsonl"),
      drivesUrl: "", rand: () => 0.3,
    });
    // 04:00 is inside [0,6)
    const r1 = await chk.tick({ now: new Date("2026-09-21T20:00:00.000Z") });
    assert.ok(lastText(dir).includes("深夜问题"), lastText(dir));
    // 10:00 is outside [0,6)
    const r2 = await chk.tick({ now: new Date("2026-09-22T02:00:00.000Z") });
    assert.ok(lastText(dir).includes("白天问题"), "nightHours applies; 10:00 is day: " + lastText(dir));
  }

  // ---- 9. no branch twice in a row: two weighted branches alternate ----
  {
    const dir = fs.mkdtempSync(path.join(tmp, "dir-"));
    const cfg = path.join(tmp, "cfg-egg9.json");
    writeCfg(cfg, { branches: { heart: 1, cave: 1, fun: 0, egg: 0 } });
    const chk = c.makeCheckin({
      dir, configFile: cfg, textsFile: path.join(tmp, "无9.md"), coldFile: path.join(tmp, "无9b.jsonl"),
      drivesUrl: "", rand: Math.random,
    });
    let prev = "";
    for (let i = 0; i < 10; i += 1) {
      const r = await chk.tick();
      assert.notStrictEqual(r.branch, prev, "same branch twice in a row");
      prev = r.branch;
    }
  }

  // ---- 10. stateFile survives a restart (new makeCheckin) ----
  {
    const dir = fs.mkdtempSync(path.join(tmp, "dir-"));
    const stateFile = path.join(tmp, "state-restart.json");
    const cfg1 = path.join(tmp, "cfg-restart1.json");
    writeCfg(cfg1, { branches: { heart: 1, cave: 0, fun: 0, egg: 0 } });
    const chk1 = c.makeCheckin({
      dir, configFile: cfg1, textsFile: path.join(tmp, "无10.md"), stateFile,
      coldFile: path.join(tmp, "无10b.jsonl"), drivesUrl: "", rand: () => 0.3,
    });
    const r1 = await chk1.tick();
    assert.strictEqual(r1.branch, "heart");

    // "restart" with heart+cave weighted, same stateFile
    const cfg2 = path.join(tmp, "cfg-restart2.json");
    writeCfg(cfg2, { branches: { heart: 1, cave: 1, fun: 0, egg: 0 } });
    const chk2 = c.makeCheckin({
      dir, configFile: cfg2, textsFile: path.join(tmp, "无10.md"), stateFile,
      coldFile: path.join(tmp, "无10b.jsonl"), drivesUrl: "", rand: () => 0.3,
    });
    const r2 = await chk2.tick();
    assert.strictEqual(r2.branch, "cave", "last branch (heart) remembered across restart: " + r2.branch);

    // decks too
    const cfgNotes = path.join(tmp, "cfg-restart3.json");
    writeCfg(cfgNotes, {
      branches: forceOnly(c.DEFAULT_BRANCH_WEIGHTS, "egg"),
      eggs: forceOnly(c.DEFAULT_EGG_WEIGHTS, "notes"),
    });
    const mdNotes = path.join(tmp, "texts-restart.md");
    fs.writeFileSync(mdNotes, "## egg_notes\n甲\n乙\n");
    const stateFile2 = path.join(tmp, "state-restart-notes.json");
    const chkA = c.makeCheckin({
      dir, configFile: cfgNotes, textsFile: mdNotes, stateFile: stateFile2,
      coldFile: path.join(tmp, "无10c.jsonl"), drivesUrl: "", rand: () => 0,
    });
    await chkA.tick();
    const firstPick = lastText(dir).split("\n\n")[1];
    // restart: only the other card is left
    const chkB = c.makeCheckin({
      dir, configFile: cfgNotes, textsFile: mdNotes, stateFile: stateFile2,
      coldFile: path.join(tmp, "无10c.jsonl"), drivesUrl: "", rand: () => 0,
    });
    await chkB.tick();
    const secondPick = lastText(dir).split("\n\n")[1];
    assert.notStrictEqual(firstPick, secondPick, "deck state survives restart: " + firstPick + " vs " + secondPick);
  }

  console.log("checkin-egg: ok");
}

main().catch((e) => { console.error(e); process.exit(1); });
