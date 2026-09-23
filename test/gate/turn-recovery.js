"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { makeTurnQueue } = require("../../src/gate/turn-queue");
const { TurnStore } = require("../../src/gate/turn-store");
const { makeEnvelope } = require("../../src/gate/envelope");
const { makeFakeBox } = require("../../src/gate/box");
const tick = () => new Promise(setImmediate);
const env = (id) => makeEnvelope({ trace_id: id, source: { kind: "system" }, payload: { text: id } });
const route = (chat) => ({ ok: true, target: { platform: "telegram", chat_id: chat } });
const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gate-turn-test-")), "turns.json");
function controlled() {
  let reply, done;
  const seen = [];
  return { seen,
    onReply(fn) { reply = fn; }, onTurnDone(fn) { done = fn; },
    async deliver(e) { seen.push(e); return { turnId: "t-" + e.trace_id, threadId: "thread" }; },
    reply(id, text) { return reply({ turnId: "t-" + id, threadId: "thread", text }); },
    done(id, extra = {}) { done({ turnId: "t-" + id, threadId: "thread", silent: false, ...extra }); },
    emitReply(event) { return reply(event); },
    emitDone(event) { return done(event); },
  };
}
function build(box, overrides = {}) {
  const replies = [], done = [];
  const q = makeTurnQueue({ file: file(), box,
    onReply: async (task, event) => { replies.push({ chat: task.route.target.chat_id, ...event }); },
    onDone: async (task, event) => { done.push(event); }, ...overrides });
  return { q, replies, done };
}

test("synchronous replies bind to explicit route before deliver returns", async () => {
  const { q, replies } = build(makeFakeBox({ answer: () => ["a", "b", "c"] }));
  await q.submit(env("one"), route("explicit"));
  assert.deepEqual(replies.map((r) => r.chat), ["explicit", "explicit", "explicit"]);
  assert.equal(new Set(replies.map((r) => r.outputId)).size, 3);
  assert.equal(q.progress().pending, 0);
});

test("queue keeps later input durable and does not replace active route", async () => {
  const box = controlled(); const { q, replies } = build(box);
  await q.submit(env("a"), route("A"));
  assert.equal((await q.submit(env("b"), route("B"))).queued, true);
  assert.equal(q.progress().pending, 2);
  assert.equal(q.context().id, "a");
  await box.reply("a", "first"); box.done("a"); await tick();
  assert.deepEqual(box.seen.map((e) => e.trace_id), ["a", "b"]);
  await box.reply("b", "second"); box.done("b"); await tick();
  assert.deepEqual(replies.map((r) => r.chat), ["A", "B"]);
  assert.equal(q.progress().pending, 0);
});

test("explicit rejection can be retried using original input and route", async () => {
  const box = controlled(); let attempts = 0;
  box.deliver = async () => { if (++attempts === 1) throw Object.assign(new Error("offline"), { notAccepted: true }); return { turnId: "t-a" }; };
  const { q } = build(box);
  await assert.rejects(q.submit(env("a"), route("A")), /offline/);
  assert.equal(q.busy(), false);
  await q.submit(env("a"), route("WRONG"));
  assert.equal(attempts, 2); assert.equal(q.context().route.target.chat_id, "A");
});

test("ambiguous rejection is visible and cannot auto replay or start later task", async () => {
  const box = controlled(); let attempts = 0;
  box.deliver = async () => { attempts++; throw new Error("lost ack"); };
  const { q } = build(box);
  await assert.rejects(q.submit(env("a"), route("A")), /lost ack/);
  assert.equal((await q.submit(env("a"), route("A"))).state, "unknown");
  await q.submit(env("b"), route("B")); await q.recover();
  assert.equal(attempts, 1); assert.equal(q.progress().unknown, 1);
  // the watchdog must be able to say which turn is unknown and why, not just a count
  const p = q.progress();
  assert.equal(p.ledger, "turns.json");
  assert.equal(p.unknownRows.length, 1);
  assert.equal(p.unknownRows[0].id, "a");
  assert.match(p.unknownRows[0].reason, /lost ack/);
  assert.equal(typeof p.unknownRows[0].text, "string");
  assert.equal(p.oldestPending && p.oldestPending.id, "b");
  await assert.rejects(q.reconcile("a", { notAccepted: true }), /证据/);
});

test("restart retains queued inputs and quarantines interrupted acceptance", async () => {
  const f = file(); const store = new TurnStore({ file: f });
  store.ensure(env("a"), route("A")); store.update("a", { state: "accepted", turnId: "t-a" });
  store.ensure(env("b"), route("B"));
  const box = controlled(); const { q } = build(box, { file: f });
  await q.recover(); assert.equal(box.seen.length, 0);
  assert.equal(q.store.get("a").state, "unknown");
  await q.reconcile("a", { evidence: "runtime transcript confirms completion" });
  assert.deepEqual(box.seen.map((e) => e.trace_id), ["b"]);
});

test("completed duplicate remains deduplicated after restart", async () => {
  const f = file(); const first = build(makeFakeBox(), { file: f });
  await first.q.submit(env("a"), route("A"));
  const box = controlled(); const second = build(box, { file: f });
  assert.equal((await second.q.submit(env("a"), route("A"))).duplicate, true);
  assert.equal(box.seen.length, 0);
});

test("turn completion waits for output delivery before opening next task", async () => {
  let release; const barrier = new Promise((r) => { release = r; });
  const box = controlled(); const { q } = build(box, { onReply: () => barrier });
  await q.submit(env("a"), route("A")); await q.submit(env("b"), route("B"));
  box.reply("a", "pending"); box.done("a"); await tick();
  assert.equal(box.seen.length, 1); assert.equal(q.progress().pending, 2);
  release(); await tick(); assert.equal(box.seen.length, 2);
});

test("closed switch retains queued task without executing it", async () => {
  let enabled = false; const box = controlled(); const { q } = build(box, { enabled: () => enabled });
  await q.submit(env("a"), route("A")); assert.equal(box.seen.length, 0);
  enabled = true; await q.recover(); assert.equal(box.seen.length, 1);
});

test("failed box turn is terminal failure, never silent", async () => {
  const box = controlled(); const { q, done } = build(box);
  await q.submit(env("a"), route("A")); box.done("a", { failed: true, reason: "error" }); await tick();
  assert.equal(q.store.get("a").state, "failed"); assert.equal(done[0].silent, false);
});

test("malformed durable inbox fails visibly rather than resetting dedupe", () => {
  const f = file(); fs.writeFileSync(f, "{");
  assert.throws(() => new TurnStore({ file: f }), SyntaxError);
});

test("reply delivery failure quarantines the turn and does not stay busy", async () => {
  const box = controlled();
  const { q } = build(box, { onReply: async () => { throw new Error("outbound failed"); } });
  await q.submit(env("a"), route("A"));
  await q.submit(env("b"), route("B"));
  box.reply("a", "reply"); box.done("a"); await tick(); await tick();
  assert.equal(q.busy(), false);
  assert.equal(q.store.get("a").state, "unknown");
  assert.deepEqual(box.seen.map((e) => e.trace_id), ["a"]);
  await q.reconcile("a", { evidence: "outbound failure reviewed" }); await tick();
  assert.deepEqual(box.seen.map((e) => e.trace_id), ["a", "b"]);
});

test("onDone failure quarantines the turn and later work waits for reconciliation", async () => {
  const box = controlled();
  const { q } = build(box, { onDone: async () => { throw new Error("finalize failed"); } });
  await q.submit(env("a"), route("A"));
  await q.submit(env("b"), route("B"));
  box.done("a"); await tick(); await tick();
  assert.equal(q.busy(), false);
  assert.equal(q.store.get("a").state, "unknown");
  assert.deepEqual(box.seen.map((e) => e.trace_id), ["a"]);
  await q.reconcile("a", { evidence: "completion callback failure reviewed" }); await tick();
  assert.deepEqual(box.seen.map((e) => e.trace_id), ["a", "b"]);
});

test("resumed unknown turn waits for late reply delivery before completing", async () => {
  const f = file(); const store = new TurnStore({ file: f });
  store.ensure(env("a"), route("A"));
  store.update("a", { state: "unknown", turnId: "t-a", threadId: "thread" });
  const box = controlled(); let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const { q } = build(box, { file: f, onReply: () => barrier });
  await q.submit(env("b"), route("B"));
  box.reply("a", "late reply"); box.done("a"); await tick();
  assert.equal(q.store.get("a").state, "unknown");
  assert.deepEqual(box.seen.map((e) => e.trace_id), []);
  release(); await tick(); await tick();
  assert.equal(q.store.get("a").state, "completed");
  assert.deepEqual(box.seen.map((e) => e.trace_id), ["b"]);
});

test("trace and turn mismatch is rejected without mutating the task", async () => {
  const box = controlled(); const { q, replies, done } = build(box);
  await q.submit(env("a"), route("A"));
  box.emitReply({ trace_id: "a", turnId: "t-other", threadId: "thread", text: "wrong" });
  box.emitDone({ trace_id: "a", turnId: "t-other", threadId: "thread", silent: false });
  await tick();
  assert.equal(q.store.get("a").replyCount, undefined);
  assert.equal(q.store.get("a").state, "accepted");
  assert.equal(replies.length, 0); assert.equal(done.length, 0);
  box.done("a"); await tick();
  assert.equal(q.store.get("a").state, "completed");
});

test("queued task events cannot execute before submission", async () => {
  let enabled = false; const box = controlled();
  const { q, replies, done } = build(box, { enabled: () => enabled });
  await q.submit(env("a"), route("A"));
  box.emitReply({ trace_id: "a", turnId: "t-a", threadId: "thread", text: "premature" });
  box.emitDone({ trace_id: "a", turnId: "t-a", threadId: "thread", silent: false });
  await tick();
  assert.equal(q.store.get("a").state, "queued");
  assert.equal(replies.length, 0); assert.equal(done.length, 0);
  enabled = true; await q.recover();
  assert.deepEqual(box.seen.map((e) => e.trace_id), ["a"]);
});

test("盒子重启后补发的事件没带 turnId：恰好一条在跑就归它", async () => {
  const box = controlled(); const { q, replies, done } = build(box);
  await q.submit(env("a"), route("A"));
  assert.equal(q.store.get("a").state, "accepted");
  // box restarted: turn table lost, events come back with an empty turnId
  await box.emitReply({ turnId: "", threadId: "thread", text: "更正函发了" });
  box.emitDone({ turnId: "", threadId: "thread", silent: false });
  await tick(); await tick();
  assert.deepEqual(replies.map((r) => [r.chat, r.text]), [["A", "更正函发了"]]);
  assert.equal(done.length, 1);
  assert.equal(q.store.get("a").state, "completed");
  assert.equal(q.store.get("a").turnId, "t-a", "空 turnId 不许覆盖账本里记的号");
});

test("空 turnId 事件：在跑的不止一条就不猜", async () => {
  const box = controlled(); const { q, replies } = build(box);
  const store = new TurnStore({ file: file() });
  // two unknown rows (typical after a restart), then start the queue on this ledger
  store.ensure(env("x"), route("X")); store.update("x", { state: "unknown", turnId: "t-x" });
  store.ensure(env("y"), route("Y")); store.update("y", { state: "unknown", turnId: "t-y" });
  const q2 = makeTurnQueue({ file: store.file, box, onReply: async (t, e) => replies.push(e), onDone: async () => {} });
  await box.emitReply({ turnId: "", threadId: "thread", text: "谁的？" });
  assert.equal(replies.length, 0);
  assert.equal(q2.store.get("x").state, "unknown"); assert.equal(q2.store.get("y").state, "unknown");
  void q;
});
