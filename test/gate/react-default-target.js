"use strict";
// 2026-09-20 Nova报的：「react 第一次调用说『要知道点哪一条』，但说明书写的是默认点她本轮那条」。
//
// 病根是四跳里断了一跳：她那条消息的平台号（TG 的 message_id）一路从入站带到轮次绑定，
// 到工具口就没人往下传了，TG 腿只好抛「点表情要知道点哪一条（message_id）」。
// 两头各自都对、中间那张表没人问过 —— 又是「接线层没人测」那一类。
//
// 这条测试盯的就是那一跳：不给 message_id，出闸拿到的 extras 里得有她本轮那条的号。
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
    assert.strictEqual(sent[0].extras.message_id, "40680", "不给就默认点她本轮那条");
    assert.strictEqual(sent[0].toolArgs.emoji, "❤️", "表情照旧走 toolArgs");
  }

  {
    // 显式给了就听他的（别拿默认值把他指定的那条顶掉）
    const { sock, sent } = makeSock(BOUND);
    await sock.handle({ id: "2", tool: "react", args: { emoji: "👍", message_id: "12345" } });
    assert.strictEqual(sent[0].extras.message_id, "12345", "显式给的优先");
  }

  {
    // 阳性对照：老的轮次绑定没有 nativeId（这个字段 9-20 才加），别硬编一个号出来
    const { sock, sent } = makeSock({ eventId: "ev-2", channel: "telegram", chatId: "c1" });
    await sock.handle({ id: "3", tool: "react", args: { emoji: "😂" } });
    assert.ok(!sent[0].extras.message_id, "查不到号就不填，让腿照旧明说");
  }

  {
    // 阳性对照：只有 react 用这个默认值，别的意图不许被塞
    const { sock, sent } = makeSock(BOUND);
    await sock.handle({ id: "4", tool: "reply", text: "在呢" });
    assert.ok(!sent[0].extras.message_id, "回话不是点表情，不带这个号");
  }

  {
    // ⚠️ 改投到别的腿时**绝不带**：号是平台内部的，换条腿就指向别人的消息
    const { sock, sent } = makeSock(BOUND, {
      address: () => ({ chat_id: "wx-1", accountId: "" }),
    });
    await sock.handle({ id: "5", tool: "react", args: { emoji: "❤️" }, channel: "wechat" });
    assert.ok(!sent[0].extras.message_id, "换了腿就不许带这个号");
  }

  console.log("react-default-target: 5/5 通过");
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
