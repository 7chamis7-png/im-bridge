"use strict";
// check-in 空闲触发（2026-09-22 Alice：「设计成空闲时间触发」「45-55min」）。
// 盯的事：①冷层最后一条之后空满 N 才敲 ②睡最多 poll 就醒来重算 ③中途有人开口就重新计时
// ④敲完还空着，从这次 check-in 起再空满 N 又敲 ⑤只读文件尾巴、半截行跳过 ⑥冷层读不到拿启动时刻兜底
// ⑦接线：心脏那一拍没空够只看一眼不推，空够了真推出一条
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const c = require("../../src/producers/checkin");
const { makeCheckinBeat } = require("../../src/heart/beats/checkin");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "checkin-idle-"));
const MIN = 60 * 1000;
const T0 = Date.parse("2026-09-22T10:00:00Z");
const row = (at, role = "user", text = "嗯") => JSON.stringify({ id: "x" + at, role, at: new Date(at).toISOString(), text });

const cfg = path.join(tmp, "cfg.json");
fs.writeFileSync(cfg, JSON.stringify({ minIntervalMs: 45 * MIN, maxIntervalMs: 55 * MIN }));

// ---- 1. readLastActivityAt：最后一条完整记录；半截行跳过；读不到给 0 ----
{
  const cold = path.join(tmp, "cold1.jsonl");
  fs.writeFileSync(cold, row(T0 - 10 * MIN) + "\n" + row(T0, "assistant") + "\n" + '{"id":"半截","ro');
  assert.strictEqual(c.readLastActivityAt(cold), T0, "半截的最后一行跳过，取前面完整那条（任一角色都算）");
  // 尾巴切在一行中间：只读 30 字节时拿不到完整行 → 0，不瞎猜
  assert.strictEqual(c.readLastActivityAt(cold, 30), 0);
  assert.strictEqual(c.readLastActivityAt(path.join(tmp, "不存在.jsonl")), 0);
  assert.strictEqual(c.readLastActivityAt(""), 0);
}

// ---- 2. 空闲闹钟：空满 N 才到点；睡最多 poll ----
{
  const cold = path.join(tmp, "cold2.jsonl");
  fs.writeFileSync(cold, row(T0) + "\n");
  let now = T0 + 1 * MIN;
  const clock = c.makeIdleClock({ coldFile: cold, configFile: cfg, pollMs: 5 * MIN, rand: () => 0, nowFn: () => now });
  // rand=0 → N 取下限 45 分钟；起点是冷层最后一条（T0），不是启动时刻（T0+1）……
  // ……但启动时刻更晚，所以起点 = max(T0, 启动时刻) = T0+1
  assert.strictEqual(clock.peek().base, T0 + 1 * MIN);
  assert.strictEqual(clock.peek().thresholdMs, 45 * MIN);
  assert.strictEqual(clock.nextDelayMs(), 5 * MIN, "离到点还远，最多睡 5 分钟就醒来重算");
  assert.strictEqual(clock.isDue(), false);
  now = T0 + 44 * MIN;
  assert.strictEqual(clock.nextDelayMs(), 2 * MIN, "剩 2 分钟就睡 2 分钟");
  now = T0 + 46 * MIN;
  assert.strictEqual(clock.isDue(), true, "空满 45 分钟到点");
  assert.strictEqual(clock.nextDelayMs(), 0);
}

// ---- 3. 中途有人开口 → 从那条消息重新计时，并重新掷 N ----
{
  const cold = path.join(tmp, "cold3.jsonl");
  fs.writeFileSync(cold, row(T0 - 60 * MIN) + "\n");
  let now = T0;
  let r = 0;
  const clock = c.makeIdleClock({ coldFile: cold, configFile: cfg, rand: () => r, nowFn: () => now });
  assert.strictEqual(clock.peek().base, T0, "冷层比启动早 → 从启动算");
  now = T0 + 30 * MIN;
  fs.appendFileSync(cold, row(T0 + 30 * MIN, "user") + "\n");   // 她回来了
  r = 1 - 1e-12;   // 取到区间上限
  assert.strictEqual(clock.peek().base, T0 + 30 * MIN, "她一开口就从那条重新计时");
  assert.strictEqual(clock.peek().thresholdMs, 55 * MIN, "起点变了就重新掷 N");
  now = T0 + 80 * MIN;
  assert.strictEqual(clock.isDue(), false, "从她那条起才 50 分钟，没到 55");
  // 他回她也算对话
  fs.appendFileSync(cold, row(T0 + 81 * MIN, "assistant") + "\n");
  now = T0 + 82 * MIN;
  assert.strictEqual(clock.peek().base, T0 + 81 * MIN);
}

// ---- 4. 敲完还空着：从这次 check-in 起再空满 N 又敲 ----
{
  const cold = path.join(tmp, "cold4.jsonl");
  fs.writeFileSync(cold, row(T0) + "\n");
  let now = T0 + 50 * MIN;
  const clock = c.makeIdleClock({ coldFile: cold, configFile: cfg, rand: () => 0, nowFn: () => now });
  // 启动在 T0+50 → 起点是启动时刻；拨到 T0+96 到点
  now = T0 + 96 * MIN;
  assert.strictEqual(clock.isDue(), true);
  clock.fired(now);
  assert.strictEqual(clock.isDue(), false, "刚敲完不会马上再敲");
  assert.strictEqual(clock.peek().base, T0 + 96 * MIN);
  now = T0 + 96 * MIN + 45 * MIN;
  assert.strictEqual(clock.isDue(), true, "一直空着，隔一个 N 再敲");
}

// ---- 5. 接线：心脏那一拍 —— 没空够只看一眼，空够了真推 ----
(async () => {
  const dir = path.join(tmp, "producers");
  fs.mkdirSync(dir);
  const cold = path.join(tmp, "cold5.jsonl");
  fs.writeFileSync(cold, row(Date.now()) + "\n");   // 她刚说过话
  const beat = makeCheckinBeat({ dir, configFile: cfg, coldFile: cold,
    textsFile: path.join(tmp, "无.md"), stateFile: path.join(tmp, "state.json") });
  const first = await beat.tick();
  assert.strictEqual(first.skipped, true, "刚说过话：只看一眼不推");
  assert.strictEqual(fs.readdirSync(dir).length, 0, "投递口里一条都没有");
  const wait = beat.nextDelayMs();
  assert.ok(wait > 0 && wait <= c.DEFAULT_IDLE_POLL_MS, "睡的时长在 (0, 5 分钟] 里：" + wait);

  // 把冷层拨回一小时前 → 起点变成启动时刻……所以用一个更早启动的拍子来验真推
  fs.writeFileSync(cold, row(Date.now() - 120 * MIN) + "\n");
  fs.writeFileSync(cfg, JSON.stringify({ minIntervalMs: 1, maxIntervalMs: 1 }));
  const beat2 = makeCheckinBeat({ dir, configFile: cfg, coldFile: cold,
    textsFile: path.join(tmp, "无.md"), stateFile: path.join(tmp, "state2.json") });
  await new Promise((res) => setTimeout(res, 20));
  const second = await beat2.tick();
  assert.ok(!second.skipped && second.id, "空够了：真推出一条");
  assert.strictEqual(fs.readdirSync(dir).length, 1, "投递口里正好一条");
  // 推完后把区间调回 45 分钟：下一轮从这次 check-in 起算，重新掷 N 时读到的是新区间
  fs.writeFileSync(cfg, JSON.stringify({ minIntervalMs: 45 * MIN, maxIntervalMs: 55 * MIN }));
  const again = await beat2.tick();
  assert.strictEqual(fs.readdirSync(dir).length, 1, "刚推完紧接着再敲：不重复推（" + JSON.stringify(again.skipped) + "）");

  console.log("checkin-idle: 全部通过");
})().catch((e) => { console.error(e); process.exit(1); });
