"use strict";
// check-in 的骰子分支 + HEADER 占位符 + fun 菜单抽取（2026-09-22 加）。
// 盯的事：①三分支权重按配置抽 ②HEADER 空占位符整行丢 ③pending 默认不渲染但算法还在
// ④文案文件缺失/缺段退默认，不推空消息 ⑤fun 菜单不重复抽、数量受 funMenu 配置管
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const c = require("../../src/producers/checkin");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "checkin-branches-"));

// ---- 1. rollBranch：权重比例决定落点 ----
{
  const weights = { heart: 0.4, cave: 0.3, fun: 0.3 };
  assert.strictEqual(c.rollBranch(weights, () => 0), "heart");
  assert.strictEqual(c.rollBranch(weights, () => 0.39), "heart");
  assert.strictEqual(c.rollBranch(weights, () => 0.41), "cave");
  assert.strictEqual(c.rollBranch(weights, () => 0.69), "cave");
  assert.strictEqual(c.rollBranch(weights, () => 0.71), "fun");
  assert.strictEqual(c.rollBranch(weights, () => 0.999), "fun");
  // 权重全零/全负 → 不除零、给第一个键
  assert.strictEqual(c.rollBranch({ heart: 0, cave: 0, fun: 0 }, () => 0.5), "heart");
}

// ---- 2. readBranchWeights：配置文件里的 branches 键，缺哪个补默认 ----
// （2026-09-22 晚加了 egg 第四支，下面几个用例跟着从三支改成四支）
{
  const cfg = path.join(tmp, "cfg1.json");
  fs.writeFileSync(cfg, JSON.stringify({ branches: { heart: 1, fun: 0 } }));
  const w = c.readBranchWeights(cfg);
  assert.strictEqual(w.heart, 1);
  assert.strictEqual(w.fun, 0);
  assert.strictEqual(w.cave, c.DEFAULT_BRANCH_WEIGHTS.cave, "没给的 cave 补默认值");
  assert.strictEqual(w.egg, c.DEFAULT_BRANCH_WEIGHTS.egg, "没给的 egg 也补默认值");

  // 读不到 / 没有 branches 键 → 整体退默认
  assert.deepStrictEqual(c.readBranchWeights(path.join(tmp, "不存在.json")), c.DEFAULT_BRANCH_WEIGHTS);

  // 四个都显式给 0（合法数值，但全零）→ 整体退默认（不然骰子除零）
  const cfg2 = path.join(tmp, "cfg2.json");
  fs.writeFileSync(cfg2, JSON.stringify({ branches: { heart: 0, cave: 0, fun: 0, egg: 0 } }));
  assert.deepStrictEqual(c.readBranchWeights(cfg2), c.DEFAULT_BRANCH_WEIGHTS);

  // 给的是非法值（负数）→ 那一个键退回它自己的默认，不是整体清零
  // （egg 没提到 → 也补它自己的默认，不是 0）
  const cfg2b = path.join(tmp, "cfg2b.json");
  fs.writeFileSync(cfg2b, JSON.stringify({ branches: { heart: 0, cave: -1, fun: 0 } }));
  assert.deepStrictEqual(c.readBranchWeights(cfg2b),
    { heart: 0, cave: c.DEFAULT_BRANCH_WEIGHTS.cave, fun: 0, egg: c.DEFAULT_BRANCH_WEIGHTS.egg });
}

// ---- 2b. excludeLastBranch：不许连续两次抽到同一支，除非只有它自己有权重 ----
{
  const w = { heart: 0.25, cave: 0.30, fun: 0.30, egg: 0.15 };
  const excluded = c.excludeLastBranch(w, "cave");
  assert.strictEqual(excluded.cave, 0, "上一次是 cave，这次权重清零");
  assert.strictEqual(excluded.heart, 0.25, "别的分支不动");
  // 没有上一次（第一次跑）→ 原样返回
  assert.deepStrictEqual(c.excludeLastBranch(w, ""), w);
  // 只有一个分支有权重 → 就算是上一次那支，也不清零（不然骰子会盲选）
  const onlyHeart = { heart: 1, cave: 0, fun: 0, egg: 0 };
  assert.deepStrictEqual(c.excludeLastBranch(onlyHeart, "heart"), onlyHeart);
  // rollBranch 拿到全排除后的权重也不该崩：多轮抽，cave 永远抽不到
  for (let i = 0; i < 50; i += 1) {
    assert.notStrictEqual(c.rollBranch(excluded, Math.random), "cave");
  }
}

// ---- 3. renderHeader：占位符解出来是空 → 整行丢；有值 → 替换 ----
{
  const tpl = ["A {x}", "B {y}", "C"].join("\n");
  assert.strictEqual(c.renderHeader(tpl, { x: "1", y: "" }), "A 1\nC");
  assert.strictEqual(c.renderHeader(tpl, { x: "", y: "" }), "C");
  assert.strictEqual(c.renderHeader(tpl, { x: "1", y: "2" }), "A 1\nB 2\nC");
}

// ---- 4. fmtSinceLast / fmtDrives / fmtLastUserLine：没有就空，有就按格式给 ----
{
  const now = new Date("2026-09-22T03:00:00.000Z");
  assert.strictEqual(c.fmtSinceLast(now, 0), "");
  assert.strictEqual(c.fmtSinceLast(now, now.getTime() - 5 * 60000), "5 分钟");
  assert.strictEqual(c.fmtSinceLast(now, now.getTime() - 65 * 60000), "1 小时 5 分钟");

  assert.strictEqual(c.fmtDrives(null), "");
  assert.strictEqual(c.fmtDrives({}), "");
  assert.strictEqual(c.fmtDrives({ drives: { libido: 0.812, stress: 0.3 } }), "libido 0.81 · stress 0.3");

  assert.strictEqual(c.fmtLastUserLine(now, 0, "x"), "");
  const lastUserAt = now.getTime() - 37 * 60000;
  const line = c.fmtLastUserLine(now, lastUserAt, "今天有点累  早点睡了");
  assert.ok(/^我上次说话是 \d\d:\d\d 37分钟前 我说的是「今天有点累 早点睡了」$/.test(line), line);
  // 没有原话 → 只给时间点，没有「我说的是」
  const line2 = c.fmtLastUserLine(now, lastUserAt, "");
  assert.ok(!line2.includes("我说的是"), line2);
}

// ---- 5. readTexts：文件缺失/缺段 → 退默认；有的段用文件里的 ----
{
  assert.deepStrictEqual(c.readTexts(path.join(tmp, "不存在.md")).header, c.DEFAULT_TEXTS.header);
  const md = path.join(tmp, "texts.md");
  fs.writeFileSync(md, "## header\n只有这一段\n");
  const t = c.readTexts(md);
  assert.strictEqual(t.header, "只有这一段");
  assert.strictEqual(t.heart, c.DEFAULT_TEXTS.heart, "缺的段退默认");
  assert.strictEqual(t.cave, c.DEFAULT_TEXTS.cave);
  assert.strictEqual(t.fun, c.DEFAULT_TEXTS.fun);
  assert.deepStrictEqual(t.fun_menu, c.DEFAULT_FUN_MENU, "没有 fun_menu 段 → 退内置菜单");
  // 彩蛋各池子同一个规矩：没写就退内置副本（2026-09-22 晚加）
  assert.deepStrictEqual(t.egg_notes, c.DEFAULT_EGG_NOTES);
  assert.deepStrictEqual(t.egg_deeptalk_day, c.DEFAULT_EGG_DEEPTALK_DAY);
  assert.deepStrictEqual(t.egg_deeptalk_night, c.DEFAULT_EGG_DEEPTALK_NIGHT);
  assert.deepStrictEqual(t.egg_dare, c.DEFAULT_EGG_DARE);
  assert.strictEqual(t.egg_hidden, c.DEFAULT_EGG_HIDDEN);

  // 有内容的时候，逐段都读得出来（一行一条）
  const md2 = path.join(tmp, "texts2.md");
  fs.writeFileSync(md2, [
    "## egg_notes", "纸条甲", "纸条乙",
    "## egg_deeptalk_day", "白天问题",
    "## egg_deeptalk_night", "深夜问题",
    "## egg_dare", "大冒险甲",
    "## egg_dare_night", "大冒险乙（夜间专供）",
    "## egg_hidden", "隐藏事件唯一一行",
  ].join("\n"));
  const t2 = c.readTexts(md2);
  assert.deepStrictEqual(t2.egg_notes, ["纸条甲", "纸条乙"]);
  assert.deepStrictEqual(t2.egg_deeptalk_day, ["白天问题"]);
  assert.deepStrictEqual(t2.egg_deeptalk_night, ["深夜问题"]);
  assert.deepStrictEqual(t2.egg_dare, ["大冒险甲"]);
  assert.deepStrictEqual(t2.egg_dare_night, ["大冒险乙（夜间专供）"]);
  assert.strictEqual(t2.egg_hidden, "隐藏事件唯一一行");
}

// ---- 6. drawMenu / formatMenu：不重复、数量在 [min,max]、超过池子不报错 ----
{
  const pool = ["a", "b", "c", "d", "e"];
  for (let i = 0; i < 20; i += 1) {
    const drawn = c.drawMenu(pool, { min: 2, max: 4 }, Math.random);
    assert.ok(drawn.length >= 2 && drawn.length <= 4, drawn);
    assert.strictEqual(new Set(drawn).size, drawn.length, "不许重复");
    for (const x of drawn) assert.ok(pool.includes(x));
  }
  // min/max 都超过池子大小 → 整池给，不报错、不卡死
  assert.strictEqual(c.drawMenu(["only-one"], { min: 3, max: 5 }, Math.random).length, 1);
  assert.deepStrictEqual(c.drawMenu([], { min: 3, max: 5 }, Math.random), []);
  assert.strictEqual(c.formatMenu(["x", "y"]), "1. x\n2. y");
}

// ---- 7. readFunMenuRange：配置文件 funMenu 键，读不到退 3~5 ----
{
  assert.deepStrictEqual(c.readFunMenuRange(path.join(tmp, "不存在.json")), c.DEFAULT_FUN_MENU_RANGE);
  const cfg = path.join(tmp, "cfg3.json");
  fs.writeFileSync(cfg, JSON.stringify({ funMenu: { min: 2, max: 2 } }));
  assert.deepStrictEqual(c.readFunMenuRange(cfg), { min: 2, max: 2 });
}

// ---- 8. 端到端 tick()：HEADER + 分支正文拼出来的样子 ----
async function main() {
  // 8a. 默认文案（textsFile 指向不存在的文件，走内置副本），骰子强制落 heart
  {
    const dir = fs.mkdtempSync(path.join(tmp, "dir-"));
    const chk = c.makeCheckin({
      dir, configFile: path.join(tmp, "无.json"), textsFile: path.join(tmp, "无.md"),
      coldFile: path.join(tmp, "无.jsonl"), desireUrl: "", rand: () => 0.01,
    });
    const r = await chk.tick();
    assert.strictEqual(r.branch, "heart");
    const f = fs.readdirSync(dir)[0];
    const text = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).text;
    assert.ok(text.includes("【说心里话】"), text);
    assert.ok(text.includes("现在 "), text);
    assert.ok(!text.includes("你手上挂着的"), "9-22 起默认不渲染 pending 这一行：" + text);
    assert.ok(!text.includes("{"), "不该留生字的占位符：" + text);
    assert.ok(text.includes("我手机静音了 吵不到我"), "heart 正文要在：" + text);
  }

  // 8b. fun 分支：抽出来的菜单编号要在正文里，且来自自定义 fun_menu
  {
    const dir = fs.mkdtempSync(path.join(tmp, "dir-"));
    const cfg = path.join(tmp, "cfg-fun.json");
    fs.writeFileSync(cfg, JSON.stringify({ funMenu: { min: 2, max: 2 } }));
    const md = path.join(tmp, "texts-fun.md");
    fs.writeFileSync(md, "## fun\n菜单来了：\n{menu}\n## fun_menu\n选项甲\n选项乙\n选项丙\n");
    const chk = c.makeCheckin({
      dir, configFile: cfg, textsFile: md, coldFile: path.join(tmp, "无2.jsonl"),
      // 0.7 落在默认权重 heart .25/cave .30/fun .30/egg .15 的 fun 桶（[0.55,0.85)）里
      desireUrl: "", rand: () => 0.7,
    });
    const r = await chk.tick({ now: new Date("2026-09-22T06:30:00Z") });   // 北京 14:30，固定在白天池子
    assert.strictEqual(r.branch, "fun");
    const f = fs.readdirSync(dir)[0];
    const text = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).text;
    assert.ok(/1\. (选项甲|选项乙|选项丙)\n2\. (选项甲|选项乙|选项丙)/.test(text), text);
    assert.ok(!text.includes("{menu}"), "menu 占位符要被替换掉：" + text);
  }

  // 8c. pending 算法仍在跑（透传进 vars），只是模板默认不含 {pending}——
  //     用一个自定义 HEADER 把它加回来验证「能力还在」
  {
    const dir = fs.mkdtempSync(path.join(tmp, "dir-"));
    const md = path.join(tmp, "texts-pending.md");
    fs.writeFileSync(md, "## header\nH {branch_name}\n挂着：{pending}\n");
    const chk = c.makeCheckin({
      dir, configFile: path.join(tmp, "无3.json"), textsFile: md, coldFile: path.join(tmp, "无3.jsonl"),
      desireUrl: "", pendingText: () => "「测试待办」", rand: () => 0.01,
    });
    const r = await chk.tick();
    const f = fs.readdirSync(dir)[0];
    const text = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).text;
    assert.ok(text.includes("挂着：「测试待办」"), "加回这行就能看到 pending，说明算法没删：" + text);
  }

  // 8d. 文案文件整个是垃圾内容（没有任何 ## 段落）→ 照样退回内置副本，不推空/不崩
  {
    const dir = fs.mkdtempSync(path.join(tmp, "dir-"));
    const md = path.join(tmp, "garbage.md");
    fs.writeFileSync(md, "这不是我们认得的格式，也没有任何 ## 分段\n随便写点什么\n");
    const chk = c.makeCheckin({
      dir, configFile: path.join(tmp, "无4.json"), textsFile: md, coldFile: path.join(tmp, "无4.jsonl"),
      // 同上，0.7 落在 fun 桶里（不能再用 0.99 了，那会落进新加的 egg 桶）
      desireUrl: "", rand: () => 0.7,
    });
    const r = await chk.tick();
    const f = fs.readdirSync(dir)[0];
    const text = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).text;
    assert.ok(text.trim().length > 0, "不许推空消息");
    assert.ok(text.includes("娱乐时间"), text);
  }

  console.log("checkin-branches: ok");
}

main().catch((e) => { console.error(e); process.exit(1); });
