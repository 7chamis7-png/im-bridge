"use strict";
/**
 * The cold layer (conversation log) only records genuine model replies.
 *
 * A CLI-generated refusal ("API Error: ... safeguards flagged ...") must be delivered to the
 * owner but must not be written to the cold layer as an assistant turn: the cold layer may be
 * replayed into a new session as real history, which would plant a fake memory. The same
 * applies to bridge-generated command panels (/status /help /model).
 *
 * This is a wiring test, not a unit test. Every check has a positive control first (prove the
 * cold layer is writable), then proves the blocked case is blocked - "0 rows" alone could
 * just mean the writer is broken.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { makeOutlet } = require("../../src/gate/outlet");
const { GateStore } = require("../../src/gate/store");
const { ColdWriter } = require("../../src/gate/cold-writer");
const { OutboundGate } = require("../../src/gate/outbound");
const { makeRouter } = require("../../src/gate/routing");
const { makeEnvelope } = require("../../src/gate/envelope");
const { isSyntheticMessage } = require("../../adapters/box-runtime");
const { decode } = require("../../runtime/decode");

let pass = 0, fail = 0;
const check = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-cold-real-"));
const OWNER_ID = "10001";

/** Shape of a CLI-generated refusal as it appears in a transcript (body shortened). */
const REAL_REFUSAL_MESSAGE = {
  model: "<synthetic>",
  role: "assistant",
  stop_reason: "refusal",
  stop_details: { type: "refusal", category: "cyber" },
  content: [{
    type: "text",
    text: "API Error: Claude's safeguards flagged this message (https://www.anthropic.com/legal/aup)."
      + " Our intentionally broad safeguards allow us to deliver more capabilities faster,"
      + " but can sometimes flag legitimate coding, cybersecurity, and biology tasks.",
  }],
  usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
};

function build(dir, channel = "telegram") {
  const storeRoot = path.join(root, dir);
  const store = new GateStore({ root: storeRoot });
  const coldFile = path.join(storeRoot, "cold.jsonl");
  const cold = new ColdWriter({ file: coldFile });
  const sent = [];
  const plugin = {
    channel,
    capabilities: { send_text: "supported" },
    health: () => ({ platform: "supported", plugin: "wired", availability: "ready" }),
    send: async (a) => { sent.push(a); return { nativeId: "n1" }; },
  };
  const plugins = new Map([[channel, plugin]]);
  const outbound = new OutboundGate({ store, cold, plugins });
  const inbound = makeEnvelope({
    trace_id: "tr-in", source: { kind: "user", platform: channel, chat_id: OWNER_ID, sender_id: OWNER_ID },
    payload: { text: "hello?" }, identity: "owner",
  });
  const router = makeRouter({ preferred: { platform: channel, chat_id: OWNER_ID } });
  router.noteInbound(inbound);
  const outlet = makeOutlet({ outbound, router, plugins, currentTurn: () => ({ turnId: "t1", inbound }) });
  const readCold = () => fs.existsSync(coldFile)
    ? fs.readFileSync(coldFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const readEvents = () => {
    const f = path.join(storeRoot, "events.jsonl");
    return fs.existsSync(f)
      ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
  };
  return { outbound, outlet, sent, readCold, readEvents, inbound };
}

(async () => {
  console.log("[1] the check reads the envelope, not the body text");
  {
    check("refusal detected", isSyntheticMessage(REAL_REFUSAL_MESSAGE), true);
    check("null is not synthetic", isSyntheticMessage(null), false);
    check("model=<synthetic> only", isSyntheticMessage({ model: "<synthetic>" }), true);
    check("stop_reason=refusal only", isSyntheticMessage({ model: "claude-model-x", stop_reason: "refusal" }), true);
    check("positive control: a real reply is not synthetic", isSyntheticMessage({ model: "claude-model-x", stop_reason: "end_turn" }), false);
    // Different wording must still be detected - that is why there is no keyword list.
    check("different wording still detected", isSyntheticMessage({
      ...REAL_REFUSAL_MESSAGE, content: [{ type: "text", text: "a completely different error text" }],
    }), true);
  }

  console.log("\n[2] decode flags CLI-generated frames (cliGenerated)");
  {
    // The adapter treats a turn as synthetic if either cliGenerated or isSyntheticMessage holds.
    const mk = (extra) => decode({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "x" }] }, ...extra })[0];
    check("frame with CLI error", mk({ error: { message: "AUP" } }).cliGenerated, true);
    check("frame marked isSynthetic", mk({ isSynthetic: true }).cliGenerated, true);
    check("positive control: a real reply is not synthetic", mk({}).cliGenerated, false);
    check("positive control: non-assistant frames are not flagged", decode({ type: "result", isSynthetic: true })[0].cliGenerated, false);
  }

  console.log("\n[3] outbound: refusal is sent but not written to the cold layer (goes to the event log)");
  {
    const { outbound, sent, readCold, readEvents, inbound } = build("refusal");
    const refusalText = REAL_REFUSAL_MESSAGE.content[0].text;

    // Positive control: a real reply does reach the cold layer.
    await outbound.deliver({
      turnId: "t-good", outputId: "o-good", replyToEventId: inbound.trace_id,
      inboundEvent: { eventId: inbound.trace_id, channel: "telegram", chatId: OWNER_ID, accountId: "" },
      text: "here, what's up", intent: "send_text",
    });
    check("positive control: real reply written", readCold().length, 1);
    check("positive control: text matches", readCold()[0].text, "here, what's up");
    check("positive control: role is assistant", readCold()[0].role, "assistant");

    // Now the refusal.
    await outbound.deliver({
      turnId: "t-bad", outputId: "o-bad", replyToEventId: inbound.trace_id,
      inboundEvent: { eventId: inbound.trace_id, channel: "telegram", chatId: OWNER_ID, accountId: "" },
      text: refusalText, intent: "send_text",
      cold: { write: false, reason: "not_model_reply" },
    });
    check("cold layer still has 1 row (refusal not written)", readCold().length, 1);
    check("no 'safeguards' in the cold layer", readCold().some((r) => r.text.includes("safeguards")), false);
    // Still delivered - the owner must see that the turn was blocked.
    check("but the owner received both messages", sent.length, 2);
    check("the second message is the refusal", sent[1].text.includes("safeguards"), true);
    // A skip must leave a trace.
    const skipped = readEvents().filter((e) => e.kind === "cold.skipped");
    check("event log has cold.skipped", skipped.length, 1);
    check("trace contains the text", skipped[0].text.includes("safeguards"), true);
    check("trace records the reason", skipped[0].reason, "not_model_reply");
  }

  console.log("\n[4] command panels (/status /help /model) are not written - that is the bridge speaking");
  {
    const { outlet, sent, readCold } = build("cmd");

    // Positive control: text sent via the tool path is written.
    await outlet.deliver({ intent: "send_text", text: "a reply from the agent", by: "tool" });
    check("positive control: tool text written", readCold().length, 1);

    const r = await outlet.deliver({ intent: "send_text", text: "🧵 session 00000000…\n🤖 model claude-model-x", by: "command" });
    check("panel was sent to the owner", r.outcome, "sent");
    check("owner received two messages", sent.length, 2);
    check("cold layer still has 1 row (panel not written)", readCold().length, 1);
    check("panel not in the cold layer", readCold().some((c) => c.text.includes("🧵")), false);
  }

  console.log("\n[5] default: no cold option = write");
  {
    const { outbound, readCold, inbound } = build("default");
    await outbound.deliver({
      turnId: "t", outputId: "o", replyToEventId: inbound.trace_id,
      inboundEvent: { eventId: inbound.trace_id, channel: "telegram", chatId: OWNER_ID, accountId: "" },
      text: "no cold option", intent: "send_text",
    });
    check("no cold option -> written", readCold().length, 1);

    const b = build("default2");
    await b.outbound.deliver({
      turnId: "t", outputId: "o", replyToEventId: b.inbound.trace_id,
      inboundEvent: { eventId: b.inbound.trace_id, channel: "telegram", chatId: OWNER_ID, accountId: "" },
      text: "cold.write=true", intent: "send_text", cold: { write: true },
    });
    check("explicit write:true -> written", b.readCold().length, 1);
  }

  console.log("\n[6] box -> main loop hop (hand-written field names)");
  {
    const { makeClaudeCodeBox } = require("../../src/host/gate-box-claudecode");
    const rt = (() => {
      let l = null;
      return {
        onEvent(fn) { l = fn; return () => { l = null; }; },
        async sendTurn() { return { turnId: "t1", threadId: "th-1" }; },
        async startFreshSharedSession() { return { threadId: "th-2" }; },
        emit(type, payload) { if (l) l({ type, payload }); },
      };
    })();
    const b = makeClaudeCodeBox({ runtime: rt, bindingKey: "bk", workspaceRoot: "/tmp/iso-cold", log: () => {} });
    const got = [];
    b.onReply((e) => got.push(e));
    await b.deliver(makeEnvelope({
      trace_id: "tr-6", source: { kind: "user", platform: "telegram", chat_id: OWNER_ID, sender_id: OWNER_ID },
      payload: { text: "hello?" }, seq: 1,
    }));

    rt.emit("runtime.turn.completed", { turnId: "t1", threadId: "th-1", text: "here, what's up" });
    check("positive control: real reply reached the main loop", got.length, 1);
    check("positive control: genuine=true", got[0].genuine, true);

    rt.emit("runtime.turn.completed", {
      turnId: "t1", threadId: "th-1", synthetic: true,
      text: "API Error: Claude's safeguards flagged this message",
    });
    check("refusal also reached the main loop (still sent)", got.length, 2);
    check("but genuine=false", got[1].genuine, false);
    // A mismatched field name fails silently, so pin the name itself.
    check("field is named genuine", Object.keys(got[1]).includes("genuine"), true);
  }

  console.log(`\npassed ${pass}, failed ${fail}`);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
