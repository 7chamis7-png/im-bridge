"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildGate } = require("../../src/gate/wire");
const { makeFakeBox } = require("../../src/gate/box");
const { TelegramPlugin } = require("../../src/gate/plugins/telegram");
const { makeClaudeCodeBox } = require("../../src/host/gate-box-claudecode");
const { FileStore } = require("../../src/gate/file-store");
const tick = () => new Promise(setImmediate);
const raw = (id, chat = 1, text = "hello") => ({ message_id: id, text, chat: { id: chat, type: "private" }, from: { id: 1 }, date: 1 });
const read = (f) => fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
function build(extra = {}) {
  const root = extra.root || fs.mkdtempSync(path.join(os.tmpdir(), "gate-reliability-"));
  const sent = [];
  const plugin = new TelegramPlugin({ sender: async (x) => { sent.push(x); return "m" + sent.length; }, call: async () => [] });
  const gate = buildGate({ root, coldFile: path.join(root, "cold.jsonl"), files: { gateEnabled: path.join(root, "enabled") },
    identities: { "telegram:1": "owner" }, owner: "owner", box: makeFakeBox(), plugins: { telegram: plugin },
    preferredRoute: { platform: "telegram", chat_id: "default" }, sendGapMs: 0, ...extra });
  return { gate, root, plugin, sent };
}

test("one turn with multiple replies preserves each output and unique operations", async () => {
  const { gate, root, sent } = build({ box: makeFakeBox({ answer: () => ["first", "second", "third"] }) });
  await gate.pipe.ingest({ channel: "telegram", raw: raw(1) });
  assert.equal(sent.length, 3);
  assert.deepEqual(read(path.join(root, "cold.jsonl")).filter((r) => r.role === "assistant").map((r) => r.text), ["first", "second", "third"]);
  assert.equal(new Set(sent.map((r) => r.operationId)).size, 3);
});

test("registered input retries an explicitly rejected box without losing or duplicating cold", async () => {
  const box = makeFakeBox(); const original = box.deliver; let attempts = 0;
  box.deliver = async (e) => { if (++attempts === 1) throw Object.assign(new Error("offline"), { notAccepted: true }); return original(e); };
  const { gate, root } = build({ box });
  // 2026-10-22：拒收不再抛给收信人（那会进死信、没人再捡）—— 行已落进 turns.json，队列自己退避重投。
  const first = await gate.pipe.ingest({ channel: "telegram", raw: raw(1) });
  assert.equal(first.state, "rejected");
  assert.match(first.reason, /offline/);
  await gate.pipe.ingest({ channel: "telegram", raw: raw(1) });
  assert.equal(attempts, 2);
  assert.equal(read(path.join(root, "cold.jsonl")).filter((r) => r.role === "user").length, 1);
  assert.equal(gate.pipe.progress().pending, 0);
});

test("cold write failure can be repaired by replay even after registration and numbering", async () => {
  const { gate, root } = build(); const write = gate.cold.write.bind(gate.cold); let once = true;
  gate.cold.write = (o) => { if (once) { once = false; throw new Error("disk interrupted"); } return write(o); };
  await assert.rejects(gate.pipe.ingest({ channel: "telegram", raw: raw(1) }), /disk/);
  await gate.pipe.ingest({ channel: "telegram", raw: raw(1) });
  assert.equal(read(path.join(root, "cold.jsonl")).filter((r) => r.role === "user").length, 1);
  assert.equal(gate.store.maxSeq("alice"), 1);
});

test("dedupe distinguishes same native message number in different chats", async () => {
  const { gate } = build();
  await gate.pipe.ingest({ channel: "telegram", raw: raw(1, 1) });
  const second = await gate.pipe.ingest({ channel: "telegram", raw: raw(1, 2) });
  assert.equal(second.envelope.seq, 2);
});

test("sequence recovers from journal if state snapshot lags behind", async () => {
  const first = build(); await first.gate.pipe.ingest({ channel: "telegram", raw: raw(1) });
  fs.writeFileSync(path.join(first.root, "state.json"), JSON.stringify({ seqByScope: {}, eventCount: 0 }));
  const second = build({ root: first.root });
  const result = await second.gate.pipe.ingest({ channel: "telegram", raw: raw(2) });
  assert.equal(result.envelope.seq, 2);
});

test("explicit producer target is bound before synchronous box callbacks", async () => {
  const { gate, sent } = build();
  await gate.pipe.push({ id: "producer-once", text: "wake", producer: "test", target: { platform: "telegram", chat_id: "explicit" } });
  await gate.pipe.push({ id: "producer-once", text: "wake", producer: "test", target: { platform: "telegram", chat_id: "wrong" } });
  assert.deepEqual(sent.map((r) => r.chatId), ["explicit"]);
});

test("closed host switch neither polls nor acknowledges inputs", async () => {
  const { gate } = build({ enforceEnabled: true });
  let polled = 0; gate.outbound.plugins.get("telegram").poll = async () => { polled++; return { items: [] }; };
  const leg = gate.attach({ channel: "telegram", enabled: () => gate.enabled() });
  assert.equal((await leg.tick()).paused, true); assert.equal(polled, 0);
  assert.equal(gate.pipe.tasks().length, 0);
});

test("hydrated image and voice reach real box adapter with offline services", async () => {
  let received;
  const runtime = { onEvent() {}, async sendTurn(input) { received = input; return { turnId: "media", threadId: "thread" }; } };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-media-roundtrip-"));
  const box = makeClaudeCodeBox({ runtime, bindingKey: "test", workspaceRoot: root });
  const fileStore = new FileStore({ root: path.join(root, "files") });
  const file_store = async () => {}; file_store.store = fileStore;
  const { gate, plugin } = build({ root, box, capabilities: { file_store, transcribe: async () => ({ text: "remember the umbrella" }) } });
  plugin.toDelivery = async () => ({ channel: "telegram", accountId: "bot", senderId: "1", chatId: "1", chatType: "private",
    nativeId: "1", text: "caption", processing: ["none"], media: [{ kind: "image", ref: "img" }, { kind: "voice", ref: "voice" }] });
  plugin.fetchMedia = async (item) => ({ bytes: item.kind === "image" ? Buffer.from([137,80,78,71,13,10,26,10,0]) : Buffer.from("RIFF0000WAVEaudio") });
  await gate.pipe.ingest({ channel: "telegram", raw: {} });
  assert.match(received.text, /caption/); assert.match(received.text, /remember the umbrella/);
  // 2026-09-18：递给运行时的是对象（absolutePath/contentType/isImage），不是路径字符串 ——
  // 只比路径的话，「图收不到」也照样绿（切桥当天就是这么漏过去的）。
  assert.equal(received.attachments.length, 1);
  const att = received.attachments[0];
  assert.ok(fs.existsSync(att.absolutePath), "附件路径要真存在");
  assert.ok(att.isImage, "运行时要认得出这是图");
  assert.ok(String(att.contentType || "").startsWith("image/"), "要带 contentType");
});
