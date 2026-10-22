"use strict";
// 织梦（2026-09-24 Alice：「每天50%的可能性做梦」「跟我第一句话一起推给他」「人偶尔也会记得完整的梦」）
// 盯的事：①窗口外不掷 ②窗口里第一拍掷一次、一天只掷一次 ③没到点 / 她没睡满 idle 不动锅
// ④他夜里自己的话不算她醒着 ⑤炖好锁匣子、不推 ⑥她炖后第一句 → 单独一条便条，不碰冷层
// ⑦过 expireHour 她没来 → 作废 ⑧锅里出来格式不对 → 今晚不梦，不推半锅
// ⑨残片分布：0 块 / 1 块 / 3~5 / 6~8 / 全篇 都掷得到，≥3 块必混一块蠢的
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const d = require("../../src/heart/beats/dream");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dream-"));
const BJ = 8 * 3600e3;
const MIN = 60e3;
const bj = (date, h, m = 0) => Date.parse(date + "T00:00:00Z") - BJ + h * 3600e3 + m * MIN;
const row = (role, at, text) => JSON.stringify({ id: "x" + at, role, at: new Date(at).toISOString(), text });

const POT = "【全文】\n" + "你站在一个菜市场里，摊位全是洗衣机。".repeat(8)
  + "\n【碎片池】\n粉色的洗衣机门\n~牛肉自己说它一点三公斤\n碎纸机说：碎你呀\n~四百一十六块硬币\n拍到第九下\n签不完的名字";

function setup(name, { pot = POT, cfg = {} } = {}) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, "prod"), { recursive: true });
  const cold = path.join(dir, "cold.jsonl");
  const lines = [
    row("user", bj("2026-09-20", 12), "我决定去住电竞酒店呀呀呀"),
    row("user", bj("2026-09-24", 22), "老公我洗漱好躺下了 我乖不乖"),
  ];
  fs.writeFileSync(cold, lines.join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "cfg.json"), JSON.stringify({ chance: 0.5, window: { from: 4, to: 12 }, idleMinutes: 60, expireHour: 18, ...cfg }));
  fs.writeFileSync(path.join(dir, "prompt.md"), "<!-- 注释 -->料：{cold}|{old}|{jar}|{town}|{type}");
  let T = 0;
  let weaves = 0;
  let lastPrompt = "";
  const beat = d.makeDreamBeat({
    dir: path.join(dir, "prod"), configFile: path.join(dir, "cfg.json"), promptFile: path.join(dir, "prompt.md"),
    stateFile: path.join(dir, "state.json"), boxDir: path.join(dir, "box"), coldFile: cold,
    jarFile: path.join(dir, "没有罐子.md"), transcriptDir: path.join(dir, "没有记录"),
    now: () => T, rnd: () => 0.1, weave: async (p) => { weaves += 1; lastPrompt = p; return pot; },
  });
  return {
    dir, beat,
    at: (t) => { T = t; },
    add: (role, at, text) => fs.appendFileSync(cold, row(role, at, text) + "\n"),
    notes: () => fs.readdirSync(path.join(dir, "prod")).filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, "prod", f), "utf8"))),
    state: () => JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")),
    coldLines: () => fs.readFileSync(cold, "utf8").split("\n").filter(Boolean).length,
    weaves: () => weaves,
    prompt: () => lastPrompt,
  };
}

(async () => {
  // ---- 1~7. 一整晚 ----
  {
    const s = setup("night");
    s.at(bj("2026-09-25", 3));
    assert.deepStrictEqual(await s.beat.tick(), { idle: "not-window" }, "窗口外不掷");

    s.at(bj("2026-09-25", 4, 1));
    assert.deepStrictEqual(await s.beat.tick(), { rolled: true }, "rnd 0.1 < 0.5 → 掷中");
    const st = s.state();
    assert.strictEqual(st.night, "2026-09-25");
    assert.ok(st.weaveAfter > bj("2026-09-25", 4) && st.weaveAfter < bj("2026-09-25", 12), "动锅时刻在窗口里");
    assert.strictEqual(st.type, "甜梦");

    s.at(st.weaveAfter - MIN);
    assert.deepStrictEqual(await s.beat.tick(), { waiting: "time" }, "没到点不动锅");

    s.at(st.weaveAfter + MIN);
    s.add("user", st.weaveAfter - 10 * MIN, "睡不着啊老公你在吗");
    let r = await s.beat.tick();
    assert.strictEqual(r.waiting, "idle", "她 10 分钟前还说话 → 不动锅");

    s.at(st.weaveAfter + 80 * MIN);
    s.add("assistant", st.weaveAfter + 75 * MIN, "（checkin：我在这儿守着）");
    const before = s.coldLines();
    r = await s.beat.tick();
    assert.deepStrictEqual(r, { woven: true }, "他自己夜里的话不算她醒着，她空满一小时就动锅");
    assert.strictEqual(s.weaves(), 1);
    assert.ok(!s.prompt().includes("注释"), "提示词里的 <!-- --> 注释不送进锅");
    assert.ok(s.prompt().includes("睡不着啊老公你在吗"), "冷层切片进了锅");
    assert.strictEqual(s.notes().length, 0, "炖好只锁匣子，不推");
    const box = JSON.parse(fs.readFileSync(path.join(s.dir, "box", "2026-09-25.json"), "utf8"));
    assert.ok(box.full.startsWith("你站在"));
    assert.strictEqual(box.pool.length, 6);
    assert.strictEqual(box.pool.filter((p) => p.dumb).length, 2, "~ 记号认成蠢片段");

    assert.deepStrictEqual(await s.beat.tick(), { waiting: "her" }, "她还没醒");
    assert.strictEqual(s.weaves(), 1, "不重复炖");

    s.at(st.weaveAfter + 120 * MIN);
    s.add("user", st.weaveAfter + 110 * MIN, "早 老公");
    r = await s.beat.tick();
    assert.ok(r.delivered, "她醒来第一句 → 推");
    const notes = s.notes();
    assert.strictEqual(notes.length, 1, "只推一条");
    assert.strictEqual(notes[0].producer, "织梦");
    assert.ok(notes[0].text.startsWith("【醒来】"));
    assert.ok(!notes[0].text.includes("早 老公"), "不拼她的原话");
    assert.strictEqual(s.coldLines(), before + 1, "冷层只多了她那一句，织梦一个字没写进去");

    assert.deepStrictEqual(await s.beat.tick(), { done: true }, "推完就收");
    assert.strictEqual(s.notes().length, 1);

    s.at(bj("2026-09-25", 13));
    assert.deepStrictEqual(await s.beat.tick(), { done: true }, "同一天不再掷");
  }

  // ---- 7. 过了 expireHour 她没来 → 作废 ----
  {
    const s = setup("expire", { cfg: { idleMinutes: 0 } });
    s.at(bj("2026-09-25", 4, 1));
    await s.beat.tick();
    s.at(bj("2026-09-25", 11, 59));
    assert.deepStrictEqual(await s.beat.tick(), { woven: true });
    s.at(bj("2026-09-25", 18, 1));
    assert.deepStrictEqual(await s.beat.tick(), { expired: "2026-09-25" });
    assert.strictEqual(s.notes().length, 0, "作废不推");
  }

  // ---- 8. 锅里格式不对 → 今晚不梦 ----
  {
    const s = setup("burnt", { pot: "我是一段没有格式的东西", cfg: { idleMinutes: 0 } });
    s.at(bj("2026-09-25", 4, 1));
    await s.beat.tick();
    s.at(bj("2026-09-25", 11, 59));
    assert.deepStrictEqual(await s.beat.tick(), { failed: true });
    assert.ok(/格式不对/.test(s.state().error));
    assert.deepStrictEqual(await s.beat.tick(), { done: true }, "糊了不重试");
    s.add("user", bj("2026-09-25", 12, 30), "早");
    s.at(bj("2026-09-25", 12, 31));
    await s.beat.tick();
    assert.strictEqual(s.notes().length, 0, "不推半锅");
  }

  // ---- 窗口过了她一直醒着 → 不梦 ----
  {
    const s = setup("awake");
    s.at(bj("2026-09-25", 4, 1));
    await s.beat.tick();
    for (let h = 5; h < 12; h += 1) s.add("user", bj("2026-09-25", h, 30), "还没睡");
    s.at(bj("2026-09-25", 11, 50));
    assert.strictEqual((await s.beat.tick()).waiting, "idle");
    s.at(bj("2026-09-25", 12, 1));
    assert.deepStrictEqual(await s.beat.tick(), { skipped: true });
    assert.strictEqual(s.weaves(), 0);
  }

  // ---- 没掷中 ----
  {
    const s = setup("miss", { cfg: { chance: 0 } });
    s.at(bj("2026-09-25", 4, 1));
    assert.deepStrictEqual(await s.beat.tick(), { rolled: false });
    s.at(bj("2026-09-25", 9));
    assert.deepStrictEqual(await s.beat.tick(), { done: true });
  }

  // ---- 9. 残片分布 ----
  {
    const cfg = d.readConfig(path.join(tmp, "不存在的配置.json"));
    const pool = "abcdefghij".split("").map((t, i) => ({ text: t, dumb: i < 2 }));
    const seen = new Set();
    for (let i = 0; i < 5000; i += 1) {
      const p = d.pickFragments(pool, cfg.fragments, Math.random);
      seen.add(p === null ? "full" : p.length);
      if (p && p.length >= 3) assert.ok(p.some((q) => q.dumb), "≥3 块必混一块蠢的");
    }
    for (const k of [0, 1, 3, 5, 6, 8, "full"]) assert.ok(seen.has(k), "掷得到 " + k);
    assert.ok(!seen.has(2), "默认分布里没有 2 块这一档");
    assert.ok(d.buildNote([]).includes("想不起来"));
    assert.ok(d.buildNote(null, "整篇的梦").includes("整篇的梦"));
  }

  console.log("织梦：全过");
})().catch((e) => { console.error(e); process.exit(1); });
