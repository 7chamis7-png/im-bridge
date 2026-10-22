"use strict";
/**
 * 发不出去的账（2026-09-18）—— 出站那半
 *
 * 核心那条：**「确定没出去」和「不知道发没发」必须分开**。
 * 前者可以重来，后者绝不能自动重来 —— 9-17 实发撞见过「报超时其实已经发出去了」，
 * 三个平台都不认幂等键，自动重发 = 她收到两遍同一句话。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { makeUndelivered } = require("../../src/gate/undelivered");
const { GateStore } = require("../../src/gate/store");
const { ColdWriter } = require("../../src/gate/cold-writer");
const { OutboundGate } = require("../../src/gate/outbound");
const { notSent } = require("../../src/gate/errors");

let pass = 0, fail = 0;
const check = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-undeliv-"));
const turn = (extra = {}) => ({
  turnId: "t1", replyToEventId: "e1",
  inboundEvent: { eventId: "e1", channel: "telegram", chatId: "861", accountId: "tg" },
  text: "她该收到这句", intent: "send_text", ...extra,
});

function build(dir, send) {
  const store = new GateStore({ root: path.join(root, dir) });
  const cold = new ColdWriter({ file: path.join(root, dir, "cold.jsonl") });
  const undelivered = makeUndelivered({ file: path.join(root, dir, "undelivered.jsonl") });
  const plugin = {
    channel: "telegram",
    capabilities: { send_text: "supported", send_voice: "unsupported" },
    health: () => ({ platform: "supported", plugin: "wired", availability: "ready" }),
    send,
  };
  const gate = new OutboundGate({ store, cold, plugins: new Map([["telegram", plugin]]), undelivered });
  return { gate, undelivered };
}

(async () => {
  console.log("[1] 路径不许猜");
  {
    let msg = "";
    try { makeUndelivered({}); } catch (e) { msg = e.message; }
    check("当场报", /不许用默认值猜/.test(msg), true);
  }

  console.log("\n[2] 平台不支持 → blocked，可以换个方式再说");
  {
    const { gate, undelivered } = build("a", async () => ({ nativeId: "1" }));
    const r = await gate.deliver(turn({ intent: "send_voice" }));
    check("outcome=blocked", r.outcome, "blocked");
    const rows = undelivered.list();
    check("记了一条", rows.length, 1);
    check("正文留着（要补发就靠它）", rows[0].text, "她该收到这句");
    check("**可以重来**", rows[0].retriable, true);
  }

  console.log("\n[3] 还没碰到平台就挂了 → not_sent，可以重试/换条腿");
  {
    const { gate, undelivered } = build("b", async () => { throw notSent("文件不在"); });
    const r = await gate.deliver(turn());
    check("state=not_sent", r.state, "not_sent");
    check("记进账", undelivered.list()[0].state, "not_sent");
    check("**可以重来**", undelivered.retriable().length, 1);
    check("不在「等人核对」里", undelivered.needsCheck().length, 0);
  }

  console.log("\n[4] 超时/断线 → unknown，**绝不自动重发**");
  {
    const { gate, undelivered } = build("c", async () => { throw new Error("ETIMEDOUT"); });
    const r = await gate.deliver(turn());
    check("state=unknown", r.state, "unknown");
    const row = undelivered.list()[0];
    check("记进账", row.state, "unknown");
    check("**不许自动重来**", row.retriable, false);
    check("落在「等人核对」那一堆", undelivered.needsCheck().length, 1);
    check("可重来那一堆是空的", undelivered.retriable().length, 0);
  }

  console.log("\n[5] 发出去了就不该进这本账");
  {
    const { gate, undelivered } = build("d", async () => ({ nativeId: "m1" }));
    const r = await gate.deliver(turn());
    check("sent", r.outcome, "sent");
    check("账上一条都没有", undelivered.list().length, 0);
  }

  console.log("\n[6] 一眼看清欠着多少");
  {
    const { gate, undelivered } = build("e", async () => { throw new Error("ETIMEDOUT"); });
    await gate.deliver(turn());
    await gate.deliver(turn({ turnId: "t2" }));
    await gate.deliver(turn({ turnId: "t3", intent: "send_voice" }));
    const s = undelivered.summary();
    check("总共三条", s.total, 3);
    check("两条等人核对", s["等人核对"], 2);
    check("一条可以重来", s["可以重来"], 1);
  }

  console.log("\n[7] 不给这本账也不许炸（老装配还没传它）");
  {
    const store = new GateStore({ root: path.join(root, "f") });
    const cold = new ColdWriter({ file: path.join(root, "f", "cold.jsonl") });
    const gate = new OutboundGate({
      store, cold,
      plugins: new Map([["telegram", {
        channel: "telegram", capabilities: { send_text: "supported" },
        health: () => ({ platform: "supported", plugin: "wired", availability: "ready" }),
        send: async () => { throw new Error("ETIMEDOUT"); },
      }]]),
    });
    const r = await gate.deliver(turn());
    check("照常返回结果，不抛", r.state, "unknown");
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}   (隔离目录 ${root})`);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
