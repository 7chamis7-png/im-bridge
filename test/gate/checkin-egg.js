"use strict";
// 彩蛋分支（2026-09-22 晚加）：notes/oldquote/deeptalk/dare/hidden 五个子类型、
// 抽卡牌堆（notes/deeptalk_day/deeptalk_night/dare_day/dare_night 各一副，抽了不放回，
// 抽空重洗）、深夜窗口可配（默认京时 22:00~10:00）、分支/牌堆状态跨「重启」（新构造）持久。
// 盯的事：①egg 权重能被强制命中 ②每个子类型渲染格式对 ③一副牌抽完不重复、抽空重洗
// ④dare 白天只用 egg_dare、深夜合并 egg_dare_night ⑤nightHours 配置生效 ⑥不连续同分支
// ⑦ stateFile 给了就能跨「进程重启」找回牌堆和上一次的分支
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const c = require("../../src/producers/checkin");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "checkin-egg-"));

/** 只强制一个分支/子类型有权重，别的清零——骰子怎么转都落它身上，不用管 rand 具体值。 */
function forceOnly(defaults, key) {
  const out = {};
  for (const k of Object.keys(defaults)) out[k] = k === key ? 1 : 0;
  return out;
}

function writeCfg(file, obj) {
  // 2026-09-22 起她睡着的钟点（京时 4~12 点）用 branchesSleep 池子：强制分支时两个池子一起强制，
  // 不然落在那段钟点的用例会抽到睡着池子的默认值
  if (obj.branches && !obj.branchesSleep) obj = { ...obj, branchesSleep: { ...obj.branches, her_sleep: 0 } };
  fs.writeFileSync(file, JSON.stringify(obj));
}

function lastText(dir) {
  const files = fs.readdirSync(dir).sort();
  const f = files[files.length - 1];
  return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).text;
}

async function main() {
  // ---- 1. egg 分支能被强制命中，HEADER 里 {branch_name} 显示「彩蛋」----
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
      desireUrl: "", rand: () => 0.3,
    });
    const r = await chk.tick();
    assert.strictEqual(r.branch, "egg");
    assert.strictEqual(r.eggType, "notes");
    const text = lastText(dir);
    assert.ok(text.includes("【彩蛋】"), text);
    assert.ok(text.includes("纸条甲") || text.includes("纸条乙"), text);
  }

  // ---- 2. deeptalk：白天走 egg_deeptalk_day，深夜走 egg_deeptalk_night ----
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
      desireUrl: "", rand: () => 0.3,
    });
    // 京时 10:00（白天）
    const rDay = await chk.tick({ now: new Date("2026-09-22T02:00:00.000Z") });
    assert.strictEqual(rDay.eggType, "deeptalk");
    const dayText = lastText(dir);
    assert.ok(dayText.includes("Deep Talk 时间："), dayText);
    assert.ok(dayText.includes("白天问题"), dayText);
    assert.ok(dayText.includes("抽到了就回答我吧"), dayText);

    // 京时 04:00（默认夜间窗 22:00~10:00 内）——直接新开一个不记「上一支」的实例，
    // 免得 excludeLastBranch 把 egg 排掉（这里只有 egg 有权重，理论上不会排掉，双保险而已）
    const rNight = await chk.tick({ now: new Date("2026-09-21T20:00:00.000Z") });
    assert.strictEqual(rNight.eggType, "deeptalk");
    const nightText = lastText(dir);
    assert.ok(nightText.includes("深夜问题"), nightText);
  }

  // ---- 3. dare：白天只抽 egg_dare；深夜是 egg_dare ∪ egg_dare_night 合成一副牌 ----
  {
    const dir = fs.mkdtempSync(path.join(tmp, "dir-"));
    const cfg = path.join(tmp, "cfg-egg3.json");
    writeCfg(cfg, {
      branches: forceOnly(c.DEFAULT_BRANCH_WEIGHTS, "egg"),
      eggs: forceOnly(c.DEFAULT_EGG_WEIGHTS, "dare"),
    });
    const md = path.join(tmp, "texts-egg3.md");
    fs.writeFileSync(md, "## egg_dare\n白天大冒险\n## egg_dare_night\n夜间专供大冒险\n");
    const chk = c.makeCheckin({
      dir, configFile: cfg, textsFile: md, coldFile: path.join(tmp, "无3.jsonl"),
      desireUrl: "", rand: () => 0.3,
    });
    const rDay = await chk.tick({ now: new Date("2026-09-22T02:00:00.000Z") }); // 京时 10:00 白天
    assert.strictEqual(rDay.eggType, "dare");
    const dayText = lastText(dir);
    assert.ok(dayText.includes("大冒险：白天大冒险"), dayText);
    assert.ok(!dayText.includes("夜间专供"), "白天不该抽到夜间专供池：" + dayText);
    assert.ok(dayText.includes("做到了就发给我"), dayText);

    // 白天池只有一条，抽干净了；换深夜应该还能抽到（合并池两条，减去白天那条也还有一条）
    const rNight = await chk.tick({ now: new Date("2026-09-21T20:00:00.000Z") }); // 京时 04:00 深夜
    assert.strictEqual(rNight.eggType, "dare");
    assert.ok(lastText(dir).includes("大冒险："), lastText(dir));
  }

  // ---- 4. hidden：抽中就是那一行，HEADER 后面不多不少 ----
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
      desireUrl: "", rand: () => 0.3,
    });
    const r = await chk.tick();
    assert.strictEqual(r.eggType, "hidden");
    const text = lastText(dir);
    const body = text.split("\n\n").slice(1).join("\n\n");
    assert.strictEqual(body, "隐藏事件触发：测试用语", "hidden 后面不该有别的解释：" + text);
  }

  // ---- 5. oldquote：从冷层里抽她 3 天前说的旧话，8~120 字，不是 [图片] 这类 ----
  {
    const dir = fs.mkdtempSync(path.join(tmp, "dir-"));
    const cfg = path.join(tmp, "cfg-egg5.json");
    writeCfg(cfg, {
      branches: forceOnly(c.DEFAULT_BRANCH_WEIGHTS, "egg"),
      eggs: forceOnly(c.DEFAULT_EGG_WEIGHTS, "oldquote"),
    });
    const cold = path.join(tmp, "cold-oldquote.jsonl");
    const oldAt = "2026-09-01T00:00:00.000Z";   // 比 now 早超过 3 天
    const recentAt = "2026-09-21T23:00:00.000Z"; // 太新，不该被抽到
    const rows = [
      { id: "1", role: "user", at: oldAt, text: "这是一条够长也够旧的测试旧话" },
      { id: "2", role: "user", at: oldAt, text: "[图片]" },                // 该被跳过
      { id: "3", role: "user", at: oldAt, text: "短" },                    // 太短，跳过
      { id: "4", role: "assistant", at: oldAt, text: "这条是Nova说的够长够旧但角色不对" },
      { id: "5", role: "user", at: recentAt, text: "这条够长但太新了不该被抽中噢" },
    ];
    fs.writeFileSync(cold, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const chk = c.makeCheckin({
      dir, configFile: cfg, textsFile: path.join(tmp, "无5.md"), coldFile: cold,
      desireUrl: "", rand: () => 0.3,
    });
    const r = await chk.tick({ now: new Date("2026-09-22T00:00:00.000Z") });
    assert.strictEqual(r.eggType, "oldquote");
    const text = lastText(dir);
    // 只看「翻旧账」那一句本身（不是 HEADER 里「我上次说话」那行——那行本来就该
    // 带出最后一条真实入站的原话，就算太新，那是 fmtLastUserLine 的职责，不是这里在测的）
    const body = text.split("\n\n").slice(1).join("\n\n");
    assert.ok(body.includes("翻旧账：你还记得"), body);
    assert.ok(body.includes("这是一条够长也够旧的测试旧话"), "该抽到那条合格的旧话：" + body);
    assert.ok(!body.includes("太新了"), "太新的不该被翻旧账抽到：" + body);
  }

  // ---- 6. 一副牌：抽完不重复，池子耗尽自动重洗 ----
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
      desireUrl: "", rand: Math.random,
    });
    const picks = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await chk.tick();
      picks.push(lastText(dir).split("\n\n")[1]);
    }
    assert.deepStrictEqual(picks.slice().sort(), ["丙", "乙", "甲"], "三张牌抽完应该正好是那三张，不重复：" + picks);
    // 第四次：牌堆已经空了，应该重新洗一整副，还是那三张之一
    const r4 = await chk.tick();
    const pick4 = lastText(dir).split("\n\n")[1];
    assert.ok(["甲", "乙", "丙"].includes(pick4), pick4);
  }

  // ---- 7. 文件里删掉一行 → 从牌堆里摘掉；新加一行 → 直接补进当前牌堆 ----
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
      desireUrl: "", rand: () => 0,   // 每次都抽 remaining[0]，行为可预期
    });
    await chk.tick();   // 抽掉一张，剩两张在牌堆里
    // 文件删掉「乙」，新加「丁」
    fs.writeFileSync(md, "## egg_notes\n甲\n丙\n丁\n");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    // tick() 内部会在下一次抽牌前对账，这里先摸一眼上一轮存的状态形状是对的
    assert.ok(Array.isArray(state.decks.notes.remaining));
    for (let i = 0; i < 5; i += 1) {
      const r = await chk.tick();
      const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      assert.ok(!st.decks.notes.remaining.includes("乙"), "被删掉的「乙」不该再出现在牌堆里");
      assert.ok(!st.decks.notes.pool.includes("乙"), "对账后 pool 也不该再有「乙」");
    }
  }

  // ---- 8. nightHours 可配：改成 0~6 之后，京时 4 点就不算深夜了 ----
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
      desireUrl: "", rand: () => 0.3,
    });
    // 京时 04:00 —— 默认窗口下是深夜，但配了 nightHours:{0,6} 依然是深夜（4 在 [0,6) 里）
    const r1 = await chk.tick({ now: new Date("2026-09-21T20:00:00.000Z") });
    assert.ok(lastText(dir).includes("深夜问题"), lastText(dir));
    // 京时 10:00 —— 默认窗口下算深夜（22~10 跨午夜），但配了 {0,6} 之后不算了
    const r2 = await chk.tick({ now: new Date("2026-09-22T02:00:00.000Z") });
    assert.ok(lastText(dir).includes("白天问题"), "nightHours 配置生效，10 点不该再算深夜：" + lastText(dir));
  }

  // ---- 9. 不连续同分支：只有两支有权重时必然交替 ----
  {
    const dir = fs.mkdtempSync(path.join(tmp, "dir-"));
    const cfg = path.join(tmp, "cfg-egg9.json");
    writeCfg(cfg, { branches: { heart: 1, cave: 1, fun: 0, egg: 0 } });
    const chk = c.makeCheckin({
      dir, configFile: cfg, textsFile: path.join(tmp, "无9.md"), coldFile: path.join(tmp, "无9b.jsonl"),
      desireUrl: "", rand: Math.random,
    });
    let prev = "";
    for (let i = 0; i < 10; i += 1) {
      const r = await chk.tick();
      assert.notStrictEqual(r.branch, prev, "不许连续两次同一支");
      prev = r.branch;
    }
  }

  // ---- 10. stateFile：跨「进程重启」（新构造一个 makeCheckin）还能接着上次的牌堆 / 分支 ----
  {
    const dir = fs.mkdtempSync(path.join(tmp, "dir-"));
    const stateFile = path.join(tmp, "state-restart.json");
    const cfg1 = path.join(tmp, "cfg-restart1.json");
    writeCfg(cfg1, { branches: { heart: 1, cave: 0, fun: 0, egg: 0 } });
    const chk1 = c.makeCheckin({
      dir, configFile: cfg1, textsFile: path.join(tmp, "无10.md"), stateFile,
      coldFile: path.join(tmp, "无10b.jsonl"), desireUrl: "", rand: () => 0.3,
    });
    const r1 = await chk1.tick();
    assert.strictEqual(r1.branch, "heart");

    // 「重启」：换一份权重（heart/cave 都有权重），新构造一个 makeCheckin 指向同一个 stateFile
    const cfg2 = path.join(tmp, "cfg-restart2.json");
    writeCfg(cfg2, { branches: { heart: 1, cave: 1, fun: 0, egg: 0 } });
    const chk2 = c.makeCheckin({
      dir, configFile: cfg2, textsFile: path.join(tmp, "无10.md"), stateFile,
      coldFile: path.join(tmp, "无10b.jsonl"), desireUrl: "", rand: () => 0.3,
    });
    const r2 = await chk2.tick();
    assert.strictEqual(r2.branch, "cave", "重启后记得上一次是 heart，这次该被排除掉：" + r2.branch);

    // 牌堆那半也一样：chk1 抽过一张 notes 牌，chk3（模拟重启）不该再抽到同一张
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
      coldFile: path.join(tmp, "无10c.jsonl"), desireUrl: "", rand: () => 0,
    });
    await chkA.tick();
    const firstPick = lastText(dir).split("\n\n")[1];
    // 重启：新构造一个指向同一个 stateFile2 的实例，牌堆只剩一张，必然是另一张
    const chkB = c.makeCheckin({
      dir, configFile: cfgNotes, textsFile: mdNotes, stateFile: stateFile2,
      coldFile: path.join(tmp, "无10c.jsonl"), desireUrl: "", rand: () => 0,
    });
    await chkB.tick();
    const secondPick = lastText(dir).split("\n\n")[1];
    assert.notStrictEqual(firstPick, secondPick, "牌堆该跨重启记住抽过什么：" + firstPick + " vs " + secondPick);
  }

  console.log("checkin-egg: ok");
}

main().catch((e) => { console.error(e); process.exit(1); });
