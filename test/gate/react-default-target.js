"use strict";
// A reaction without message_id defaults to the owner's message of this turn.
// The platform-native id is carried from inbound -> turn binding -> tool socket ->
// outbound extras; this test pins the tool-socket hop.
const assert = require("assert");
const { makeToolSocket } = require("../../src/gate/tool-socket");

const TOOLS = new Map([
  ["react", { name: "react", intent: "react" }],
  ["reply", { name: "reply", intent: "send_text" }],
]);

function makeSock(bound, { address } = {}) {
  const sent = [];
  const sock = makeToolSocket({
    file: "/tmp/unused.sock", tools: TOOLS,
    outbound: { deliver: async (t) => { sent.push(t); return { outcome: "sent", channel: t.inboundEvent?.channel }; } },
    binding: { lookup: () => bound },
    activeTurn: () => ({ threadId: "th", turnId: "tu" }),
    ...(address ? { addressOn: address } : {}),
  });
  return { sock, sent };
}

const BOUND = { eventId: "ev-1", channel: "telegram", chatId: "c1", nativeId: "40680" };

(async () => {
  {
    const { sock, sent } = makeSock(BOUND);
    await sock.handle({ id: "1", tool: "react", args: { emoji: "❤️" } });
    assert.strictEqual(sent[0].extras.message_id, "40680", "不给就默认点 owner 本轮那条");
    assert.strictEqual(sent[0].toolArgs.emoji, "❤️", "表情照旧走 toolArgs");
  }

  {
    // an explicit message_id wins over the default
    const { sock, sent } = makeSock(BOUND);
    await sock.handle({ id: "2", tool: "react", args: { emoji: "👍", message_id: "12345" } });
    assert.strictEqual(sent[0].extras.message_id, "12345", "显式给的优先");
  }

  {
    // older bindings have no nativeId: don't invent one
    const { sock, sent } = makeSock({ eventId: "ev-2", channel: "telegram", chatId: "c1" });
    await sock.handle({ id: "3", tool: "react", args: { emoji: "😂" } });
    assert.ok(!sent[0].extras.message_id, "查不到号就不填，让腿照旧明说");
  }

  {
    // only react gets this default
    const { sock, sent } = makeSock(BOUND);
    await sock.handle({ id: "4", tool: "reply", text: "在呢" });
    assert.ok(!sent[0].extras.message_id, "回话不是点表情，不带这个号");
  }

  {
    // never carried to another channel: native ids are platform-internal
    const { sock, sent } = makeSock(BOUND, {
      address: () => ({ chat_id: "wx-1", accountId: "" }),
    });
    await sock.handle({ id: "5", tool: "react", args: { emoji: "❤️" }, channel: "wechat" });
    assert.ok(!sent[0].extras.message_id, "换了腿就不许带这个号");
  }

  console.log("react-default-target: 5/5 通过");
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
