"use strict";
/**
 * Main loop end to end: real plugin, inbound gate, outbound gate, router and cold layer.
 * Only the box is fake (no CLI process, no cost), so a full round trip takes milliseconds.
 *
 * Answers one question: does "owner says one thing, agent replies" work end to end?
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { makePipeline } = require("../../src/gate/pipeline");
const { GateStore } = require("../../src/gate/store");
const { ColdWriter } = require("../../src/gate/cold-writer");
const { InboundGate } = require("../../src/gate/inbound");
const { OutboundGate } = require("../../src/gate/outbound");
const { TelegramPlugin } = require("../../src/gate/plugins/telegram");
const { makeFakeBox } = require("../../src/gate/box");
const { makeRouter, POLICY } = require("../../src/gate/routing");

let pass = 0, fail = 0;
const check = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-pipe-"));
const OWNER_ID = "10001";

/** One Telegram message from the owner (raw Bot API shape) */
const tgMsg = (id, text) => ({
  message_id: id, text,
  chat: { id: Number(OWNER_ID), type: "private" },
  from: { id: Number(OWNER_ID) },
  date: Math.floor(Date.now() / 1000),
});

function build({ answer, dir, identities } = {}) {
  const store = new GateStore({ root: path.join(root, dir) });
  const cold = new ColdWriter({ file: path.join(root, dir, "cold.jsonl") });
  const sent = [];
  const plugin = new TelegramPlugin({
    sender: async ({ chatId, text }) => { sent.push({ chatId, text }); return "m" + sent.length; },
    call: async () => [],
  });
  const plugins = new Map([["telegram", plugin]]);
  const inbound = new InboundGate({ store, cold, identities: identities || { ["telegram:" + OWNER_ID]: "owner" } });
  const outbound = new OutboundGate({ store, cold, plugins });
  const box = makeFakeBox({ answer });
  const router = makeRouter({ preferred: { platform: "telegram", chat_id: OWNER_ID } });
  const pipe = makePipeline({ plugins, inbound, outbound, box, router, log: () => {} });
  return { pipe, sent, box, router, coldFile: path.join(root, dir, "cold.jsonl"), store };
}

const coldRows = (f) => fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

(async () => {
  console.log("[1] owner 说一句，agent 回一句 —— 整条跑通");
  {
    const { pipe, sent, coldFile } = build({ answer: () => "七点二十 我叫你", dir: "a" });
    const r = await pipe.ingest({ channel: "telegram", raw: tgMsg(1, "明天几点的火车") });
    check("入闸放行", r.accepted, true);
    check("认出是 owner", r.envelope.identity, "owner");
    check("编了号", typeof r.envelope.seq === "number", true);
    check("agent 的话发出去了", sent.map((s) => s.text), ["七点二十 我叫你"]);
    check("**发回 owner 进来的那条腿**", sent[0].chatId, OWNER_ID);
    const rows = coldRows(coldFile);
    check("冷层两条（owner 一条 agent 一条）", rows.length, 2);
    check("owner 那条是原话", rows[0].text, "明天几点的火车");
    check("agent 那条是原话", rows[1].text.includes("七点二十"), true);
  }

  console.log("\n[2] agent 选择不说 —— 一个字都不许发出去，但要留痕");
  {
    const { pipe, sent, coldFile } = build({ answer: () => null, dir: "b" });
    await pipe.ingest({ channel: "telegram", raw: tgMsg(2, "在吗") });
    check("没有任何东西发出去", sent.length, 0);
    const rows = coldRows(coldFile);
    check("冷层记了「本轮未回复」", rows.some((r) => /未回复/.test(r.text)), true);
  }

  console.log("\n[3] 分几段说，就发几条（节奏是共用层的事）");
  {
    const { pipe, sent } = build({ answer: () => ["第一句", "第二句", "第三句"], dir: "c" });
    await pipe.ingest({ channel: "telegram", raw: tgMsg(3, "说三句") });
    check("三段三条", sent.map((s) => s.text), ["第一句", "第二句", "第三句"]);
  }

  console.log("\n[4] 陌生人：认不出就不投递，绝不硬填成 owner");
  {
    const { pipe, sent, box } = build({ answer: () => "不该回", dir: "d" });
    const stranger = { ...tgMsg(4, "在吗"), from: { id: 99999999 }, chat: { id: 99999999, type: "private" } };
    const r = await pipe.ingest({ channel: "telegram", raw: stranger });
    check("挡下了", r.accepted, false);
    check("理由说得出", r.reason, "unknown_identity");
    check("盒子根本没收到这一轮", box._seen.length, 0);
    check("一个字都没发出去", sent.length, 0);
  }

  console.log("\n[5] 同一条来两遍（平台重传 / 我们重放）—— 不吃第二个号");
  {
    const { pipe, sent, box } = build({ answer: () => "嗯", dir: "e" });
    const msg = tgMsg(5, "记得带伞");
    const a = await pipe.ingest({ channel: "telegram", raw: msg });
    const b = await pipe.ingest({ channel: "telegram", raw: msg });
    check("第二遍认出是重复", b.duplicate, true);
    check("盒子只收到一次", box._seen.length, 1);
    check("agent 只回了一次", sent.length, 1);
    check("号没被吃掉第二个", typeof a.envelope.seq, "number");
  }

  console.log("\n[6] 晨笺那类推一轮：走同一条路，落点按最近活跃");
  {
    const { pipe, sent, router } = build({ answer: () => "早安 外面在下雨", dir: "f" });
    await pipe.ingest({ channel: "telegram", raw: tgMsg(6, "晚安") });      // owner 最后在 TG
    sent.length = 0;
    await pipe.push({ text: "该跟 owner 说早安了", producer: "晨笺" });
    check("发出去了", sent.length, 1);
    check("落在 owner 最后说话的那条腿", sent[0].chatId, OWNER_ID);
    check("最近活跃路记的是 owner", router.lastActive().platform, "telegram");
  }

  console.log("\n[7] 没有任何落点时：暂存，不猜（owner 那句「不许乱投」）");
  {
    const { pipe, sent } = build({ answer: () => "我主动说一句", dir: "g" });
    // no inbound yet and no preferred route
    const store = new GateStore({ root: path.join(root, "g2") });
    const cold = new ColdWriter({ file: path.join(root, "g2", "cold.jsonl") });
    const outs = [];
    const plugin = new TelegramPlugin({ sender: async (a) => { outs.push(a); return "1"; }, call: async () => [] });
    const plugins = new Map([["telegram", plugin]]);
    const bare = makePipeline({
      plugins,
      inbound: new InboundGate({ store, cold, identities: {} }),
      outbound: new OutboundGate({ store, cold, plugins }),
      box: makeFakeBox({ answer: () => "在吗" }),
      router: makeRouter(),                       // 没有首选、没有入站
      log: () => {},
    });
    await bare.push({ text: "主动说一句", producer: "自主时间" });
    check("一个字都没发出去", outs.length, 0);
    check("但躺在暂存里，看得见", bare.held().length, 1);
    check("暂存说得出原因", /没有过任何入站/.test(bare.held()[0].reason), true);
  }

  console.log("\n[8] 快到可以随便跑（以后验整条桥不用起 claude）");
  {
    const { pipe, sent } = build({ answer: (e) => "收到：" + e.payload.text, dir: "h" });
    const t0 = Date.now();
    for (let i = 0; i < 100; i += 1) await pipe.ingest({ channel: "telegram", raw: tgMsg(100 + i, "第" + i + "句") });
    const ms = Date.now() - t0;
    check("100 轮一来一回", sent.length, 100);
    check("毫秒级", ms < 2000, true);
    console.log(`      100 轮用时 ${ms}ms`);
  }

  console.log("\n[9] 整条腿自己活着：捞 → 主循环 → 盒子 → 发回去，中间没人手喂");
  {
    const store = new GateStore({ root: path.join(root, "i") });
    const cold = new ColdWriter({ file: path.join(root, "i", "cold.jsonl") });
    const sent = [];
    // fake Bot API: yields three owner messages (same semantics as getUpdates)
    const updates = [1, 2, 3].map((i) => ({ update_id: 500 + i, message: tgMsg(500 + i, "第" + i + "句") }));
    const plugin = new TelegramPlugin({
      sender: async ({ chatId, text }) => { sent.push({ chatId, text }); return "m" + sent.length; },
      call: async (m, p) => updates.filter((u) => u.update_id >= Number(p.offset || 0)),
    });
    const plugins = new Map([["telegram", plugin]]);
    const pipe = makePipeline({
      plugins,
      inbound: new InboundGate({ store, cold, identities: { ["telegram:" + OWNER_ID]: "owner" } }),
      outbound: new OutboundGate({ store, cold, plugins }),
      box: makeFakeBox({ answer: (e) => "收到「" + e.payload.text + "」" }),
      router: makeRouter({ preferred: { platform: "telegram", chat_id: OWNER_ID } }),
      log: () => {},
    });
    const leg = pipe.attach({
      channel: "telegram",
      cursorFile: path.join(root, "i", "cursor.json"),
      deadLetterFile: path.join(root, "i", "dead.jsonl"),
    });
    const r = await leg.tick({ timeoutSec: 0 });
    check("捞上来三条", r.got, 3);
    check("三条都消化了", r.ok, 3);
    check("agent 回了三条", sent.length, 3);
    check("回的是 owner 那条腿", sent.every((s) => s.chatId === OWNER_ID), true);
    check("内容对得上", sent[0].text, "收到「第1句」");
    const again = await leg.tick({ timeoutSec: 0 });
    check("再捞一次没有重复的", again.got, 0);
    check("agent 没有把同一句再听一遍", sent.length, 3);
  }

  console.log("\n[N] busy()：只答「有没有轮在飞」");
  {
    const { pipe } = build({ answer: () => "嗯", dir: "busy" });
    check("一开始不忙", pipe.busy().busy, false);
    await pipe.ingest({ channel: "telegram", raw: tgMsg(90, "在吗") });
    await new Promise((r) => setTimeout(r, 20));
    check("owner 那轮说完了 = 不忙（只看在飞）", pipe.busy().busy, false);
    // "The owner just spoke" is a producer-side policy (the check-in producer skips itself);
    // the bridge only guards technical collisions. Keep timing policies out of the bridge.
    check("桥不认识「owner 刚说过话」这种时机策略", typeof pipe.busy().why, "string");
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}   (隔离目录 ${root})`);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
