"use strict";
// 2026-11-01 合并窗口：她连着发的几条，最后一条之后 3 秒没新的才投，有新的合成一轮。
const assert = require("assert");
const fs = require("fs"); const os = require("os"); const path = require("path");
const { makeTurnQueue } = require("../../src/gate/turn-queue");
const { makeEnvelope } = require("../../src/gate/envelope");

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; } catch (e) { fail++; console.log("✗ " + name + "\n  " + e.stack.split("\n").slice(0,3).join("\n  ")); } }

function env(id, text, { platform = "wechat", chat = "her", media = [], kind = "user" } = {}) {
  return makeEnvelope({ trace_id: id, source: { kind, platform, chat_id: chat, sender_id: kind === "user" ? "her" : "" },
    payload: { text, media } });
}
function setup(merge = { windowMs: 3000, maxWaitMs: 30000 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "turn-merge-"));
  let clock = 1_000_000;
  const delivered = []; let rh, dh, n = 0;
  const box = {
    async deliver(e) { delivered.push(e); return { turnId: "turn-" + (++n), threadId: "th" }; },
    onReply(fn) { rh = fn; }, onTurnDone(fn) { dh = fn; },
  };
  const q = makeTurnQueue({ file: path.join(dir, "turns.json"), box, onReply: async () => {}, onDone: async () => {},
    merge, now: () => clock });
  // ensure() 用真实时间写 queuedAt；测试里用假钟，所以入队后把 queuedAt 改成假钟的时间
  const submit = async (e) => { const r = await q.submit(e, { ok: true, target: { platform: "wechat", chat_id: "her" } });
    q.store.update(e.trace_id, { queuedAt: new Date(clock).toISOString() }); return r; };
  const done = (turnId) => dh({ turnId, threadId: "th", silent: false });
  return { q, delivered, submit, tick: (ms) => { clock += ms; }, done };
}

(async () => {
  await t("单条：等满 3 秒才投", async () => {
    const s = setup();
    await s.submit(env("a", "在吗"));
    assert.strictEqual(s.delivered.length, 0);
    s.tick(2000); await s.q.recover(); assert.strictEqual(s.delivered.length, 0);
    s.tick(1100); await s.q.recover(); assert.strictEqual(s.delivered.length, 1);
    assert.strictEqual(s.delivered[0].payload.text, "在吗");
  });

  await t("连着三条（字+图+字）合成一轮，媒体按顺序", async () => {
    const s = setup();
    await s.submit(env("a", "看这个"));
    s.tick(1000); await s.submit(env("b", "", { media: [{ kind: "image", path: "/x/1.jpg" }] }));
    s.tick(2000); await s.submit(env("c", "好看吗"));
    s.tick(2500); await s.q.recover(); assert.strictEqual(s.delivered.length, 0, "最后一条还没满 3 秒");
    s.tick(600); await s.q.recover();
    assert.strictEqual(s.delivered.length, 1);
    assert.strictEqual(s.delivered[0].payload.text, "看这个\n好看吗");
    assert.deepStrictEqual(s.delivered[0].payload.media.map((m) => m.path), ["/x/1.jpg"]);
    assert.strictEqual(s.q.store.get("b").state, "completed"); assert.strictEqual(s.q.store.get("b").mergedInto, "a");
    assert.strictEqual(s.q.store.get("c").mergedInto, "a");
  });

  await t("封顶：一直在发也最多压 30 秒", async () => {
    const s = setup();
    await s.submit(env("a", "1"));
    for (let i = 0; i < 15; i++) { s.tick(2000); await s.submit(env("m" + i, "x" + i)); await s.q.recover(); }
    s.tick(1000); await s.q.recover();
    assert.strictEqual(s.delivered.length, 1);
  });

  await t("不同聊天不合（群和私聊分开）", async () => {
    const s = setup();
    await s.submit(env("a", "私聊"));
    s.tick(500); await s.submit(env("b", "群里", { chat: "grp@chatroom" }));
    s.tick(3100); await s.q.recover();
    assert.strictEqual(s.delivered.length, 1); assert.strictEqual(s.delivered[0].payload.text, "私聊");
  });

  await t("电话不等", async () => {
    const s = setup();
    await s.submit(env("a", "喂", { platform: "phone", chat: "p" }));
    assert.strictEqual(s.delivered.length, 1);
  });

  await t("系统推的（生产者）不等", async () => {
    const s = setup();
    await s.submit(env("a", "提醒", { kind: "system", platform: "" }));
    assert.strictEqual(s.delivered.length, 1);
  });

  await t("他正忙时排着的也合：这轮完了把攒的合成下一轮", async () => {
    const s = setup();
    await s.submit(env("a", "第一句")); s.tick(3100); await s.q.recover();
    assert.strictEqual(s.delivered.length, 1);
    await s.submit(env("b", "第二句")); s.tick(1000); await s.submit(env("c", "第三句"));
    s.tick(5000);
    s.done("turn-1"); await new Promise((r) => setTimeout(r, 20)); await s.q.recover();
    assert.strictEqual(s.delivered.length, 2);
    assert.strictEqual(s.delivered[1].payload.text, "第二句\n第三句");
  });

  await t("windowMs=0 跟以前一样：立刻投、不合", async () => {
    const s = setup({ windowMs: 0 });
    await s.submit(env("a", "1")); assert.strictEqual(s.delivered.length, 1);
  });

  await t("合并后的信封落了盘：重启读回来还是合并版", async () => {
    const s = setup();
    await s.submit(env("a", "甲")); s.tick(500); await s.submit(env("b", "乙"));
    s.tick(3100); await s.q.recover();
    const disk = JSON.parse(fs.readFileSync(s.q.store.file, "utf8"));
    const rows = disk.rows || disk;
    assert.strictEqual(rows.a.envelope.payload.text, "甲\n乙");
  });

  console.log(`通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
