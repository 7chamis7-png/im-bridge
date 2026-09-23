"use strict";

/* Focused durability checks for the outbound gate.  This test only uses a
 * temp root and fake plugins; it never talks to a platform. */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { GateStore } = require("../../src/gate/store");
const { ColdWriter } = require("../../src/gate/cold-writer");
const { OutboundGate } = require("../../src/gate/outbound");
const { makeUndelivered } = require("../../src/gate/undelivered");
const { makeSegmenter } = require("../../src/gate/segment");
const { notSent } = require("../../src/gate/errors");

function setup(root, send) {
  const store = new GateStore({ root });
  const cold = new ColdWriter({ file: path.join(root, "cold.jsonl") });
  const undelivered = makeUndelivered({ file: path.join(root, "undelivered.jsonl") });
  const plugin = { channel: "telegram", capabilities: { send_text: "supported" },
    health: () => ({ platform: "supported", plugin: "wired", availability: "ready" }), send };
  return { store, cold, undelivered, plugin };
}

function turn(extra = {}) {
  return { turnId: "same-turn", operationId: "op-recovery", replyToEventId: "in-1",
    inboundEvent: { eventId: "in-1", channel: "telegram", chatId: "chat" }, text: "a\n\nb", ...extra };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-outbound-recovery-"));
  try {
    let calls = 0;
    const first = setup(path.join(root, "partial"), async () => {
      calls += 1;
      if (calls === 2) throw notSent("before platform");
      return "native-" + calls;
    });
    const gate = new OutboundGate({ ...first, plugins: new Map([["telegram", first.plugin]]),
      segmenter: makeSegmenter({ minChars: 1 }), sendGapMs: 0 });
    const partial = await gate.deliver(turn());
    assert.equal(partial.state, "partial");
    assert.equal(first.undelivered.retriable().length, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "partial", "outbox.json"))).operations["op-recovery"].segments[0].state, "sent");
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "partial", "cold.jsonl"), "utf8").trim()).text, "a\n\nb");

    const retried = await gate.deliver(turn());
    assert.equal(retried.outcome, "sent");
    assert.equal(calls, 3); // segment one is never duplicated
    assert.equal(first.undelivered.list().length, 0);
    assert.deepEqual(await gate.deliver(turn()), retried); // stable sent operation

    const crashRoot = path.join(root, "crash");
    fs.mkdirSync(crashRoot, { recursive: true });
    fs.writeFileSync(path.join(crashRoot, "outbox.json"), JSON.stringify({ version: 1, operations: {
      "op-crash": { operationId: "op-crash", outputId: "out-crash", turnId: "crash-turn", coldId: "cold-out-crash-assistant",
        state: "submitted", payload: { intent: "send_text", channel: "telegram", chatId: "chat", text: "crashed" },
        segments: [{ index: 0, text: "crashed", operationId: "op-crash", state: "running" }] },
    }}));
    const recovered = setup(crashRoot, async () => { throw new Error("must not send"); });
    const recoveryGate = new OutboundGate({ ...recovered, plugins: new Map([["telegram", recovered.plugin]]) });
    assert.equal(recovered.undelivered.list().length, 1);
    assert.equal(recovered.undelivered.needsCheck()[0].state, "unknown");
    const unknown = await recoveryGate.deliver(turn({ operationId: "op-crash", outputId: "out-crash", text: "crashed" }));
    assert.equal(unknown.state, "unknown");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("outbound recovery: ok");
})().catch((error) => { console.error(error); process.exitCode = 1; });
