"use strict";

/* 段间间隔：微信随机 1~3 秒，别的渠道不变。
 * 2026-09-20 微信因 Frida 被处罚后，Alice要微信段间随机 1~3 秒（0.7 秒定值太机器）。
 * 判准：① 微信真的落在区间里、而且会变（不是定值）② Telegram 不受影响还是 700ms。 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { GateStore } = require("../../src/gate/store");
const { ColdWriter } = require("../../src/gate/cold-writer");
const { OutboundGate } = require("../../src/gate/outbound");
const { makeSegmenter } = require("../../src/gate/segment");

function makeGate(root, channel, opts) {
  const store = new GateStore({ root });
  const cold = new ColdWriter({ file: path.join(root, "cold.jsonl") });
  const stamps = [];
  const plugin = { channel, capabilities: { send_text: "supported" },
    health: () => ({ platform: "supported", plugin: "wired", availability: "ready" }),
    send: async () => { stamps.push(Date.now()); return "n-" + stamps.length; } };
  const gate = new OutboundGate({ store, cold, plugins: new Map([[channel, plugin]]),
    segmenter: makeSegmenter({ minChars: 1 }), ...opts });
  return { gate, stamps };
}

function turn(channel) {
  // 三段，产生两个段间间隔
  return { turnId: "t", operationId: "op-" + channel, replyToEventId: "in",
    inboundEvent: { eventId: "in", channel, chatId: "c" }, text: "a\n\nb\n\nc" };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-send-gap-"));
  try {
    // ① 微信：随机区间 1000~3000，跑几轮，间隔要落在区间里、而且不总是同一个值
    const gaps = [];
    for (let i = 0; i < 6; i += 1) {
      const r = path.join(root, "wx-" + i);
      const { gate, stamps } = makeGate(r, "wechat", {
        sendGapByChannel: { wechat: { min: 1000, max: 3000 } } });
      await gate.deliver(turn("wechat"));
      assert.equal(stamps.length, 3, "该发 3 段");
      const g1 = stamps[1] - stamps[0];
      gaps.push(g1);
      // 落在区间里（给 150ms 余量，段本身也耗一点时间）
      assert.ok(g1 >= 950 && g1 <= 3200, `微信段间 ${g1}ms 不在 1~3 秒区间`);
    }
    const uniq = new Set(gaps.map((g) => Math.round(g / 100)));
    assert.ok(uniq.size >= 2, `微信段间应该是随机的，6 次却几乎一样：${gaps.join(",")}`);
    console.log("  ✓ 微信段间随机 1~3 秒（样本 " + gaps.map((g) => (g / 1000).toFixed(1)).join("/") + "）");

    // ② Telegram：没配覆盖，还是走默认 700ms 定值，不受微信改动影响
    {
      const r = path.join(root, "tg");
      const { gate, stamps } = makeGate(r, "telegram", {
        sendGapMs: 700,
        sendGapByChannel: { wechat: { min: 1000, max: 3000 } } });
      await gate.deliver(turn("telegram"));
      const g = stamps[1] - stamps[0];
      assert.ok(g >= 650 && g <= 850, `Telegram 该是 700ms 定值，却 ${g}ms`);
      console.log("  ✓ Telegram 不受影响，仍 700ms（实测 " + g + "ms）");
    }

    // ③ 定值也还能用（min==max 或直接给数字），不掷随机
    {
      const r = path.join(root, "fixed");
      const { gate, stamps } = makeGate(r, "wechat", {
        sendGapByChannel: { wechat: 500 } });
      await gate.deliver(turn("wechat"));
      const g = stamps[1] - stamps[0];
      assert.ok(g >= 450 && g <= 650, `定值 500ms，却 ${g}ms`);
      console.log("  ✓ 定值覆盖也能用（500ms → 实测 " + g + "ms）");
    }

    console.log("send-gap: 通过");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((e) => { console.error("✗", e.message); process.exit(1); });
