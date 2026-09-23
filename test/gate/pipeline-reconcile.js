"use strict";
/**
 * Wiring check: does the pipeline really reconcile unacknowledged turns using the outbox
 * ledger as evidence? Runs a real pipeline, outbound gate and ledger with a fake box,
 * simulating a bridge restart in the middle of a turn.
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
const { makeRouter } = require("../../src/gate/routing");

let pass = 0, fail = 0;
const check = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-pipe-rec-"));
const OWNER_ID = "10001";
const dir = path.join(root, "gate");
const turnsFile = path.join(dir, "turns.json");

const tgMsg = (id, text) => ({
  message_id: id, text,
  chat: { id: Number(OWNER_ID), type: "private" },
  from: { id: Number(OWNER_ID) },
  date: Math.floor(Date.now() / 1000),
});

function build(answer) {
  const store = new GateStore({ root: dir });
  const cold = new ColdWriter({ file: path.join(dir, "cold.jsonl") });
  const sent = [];
  const plugin = new TelegramPlugin({
    sender: async ({ chatId, text }) => { sent.push({ chatId, text }); return "m" + sent.length; },
    call: async () => [],
  });
  const plugins = new Map([["telegram", plugin]]);
  const inbound = new InboundGate({ store, cold, identities: { ["telegram:" + OWNER_ID]: "owner" } });
  const outbound = new OutboundGate({ store, cold, plugins });
  const pipe = makePipeline({ plugins, inbound, outbound, box: makeFakeBox({ answer }),
    router: makeRouter({ preferred: { platform: "telegram", chat_id: OWNER_ID } }), log: () => {} });
  return { pipe, sent, outbound };
}

const turns = () => JSON.parse(fs.readFileSync(turnsFile, "utf8"));

(async () => {
  console.log("[1] 先正常跑完一轮，出站账本里留下这一轮的投递记录");
  let doneRow;
  {
    const { pipe, sent, outbound } = build(() => "嗯 我在");
    await pipe.ingest({ channel: "telegram", raw: tgMsg(1, "在吗") });
    check("发出去了", sent.length, 1);
    doneRow = Object.values(turns())[0];
    check("这一轮记着 turnId", Boolean(doneRow.turnId), true);
    check("出站账本认得这个 turnId",
      outbound.outbox.all().some((o) => o.turnId === doneRow.turnId), true);
  }

  console.log("\n[2] 把它改回 unknown —— 模拟「投递完成前进程被杀」");
  {
    const rows = turns();
    rows[doneRow.id] = { ...rows[doneRow.id], state: "unknown", reason: "进程中断；盒子是否完成需要核对，不自动重投" };
    fs.writeFileSync(turnsFile, JSON.stringify(rows));
    check("账本里确实是 unknown", turns()[doneRow.id].state, "unknown");
  }

  console.log("\n[3] 重开一座桥：应当凭出站账本自己认掉，不用人来按");
  {
    const { pipe, sent } = build(() => "第二句");
    await pipe.recover();
    const row = turns()[doneRow.id];
    check("自动认成 completed", row.state, "completed");
    check("来源标成 auto", row.reconciledBy, "auto");
    check("证据里点名了 operationId", /operationId=/.test(row.evidence || ""), true);

    // after reconciliation, new messages must be delivered again (a stuck unknown would make this 0)
    await pipe.ingest({ channel: "telegram", raw: tgMsg(2, "醒了没") });
    check("重启后照常收发", sent.map((s) => s.text), ["第二句"]);
  }

  console.log("\n[4] 出站账本里查无此轮时：不许自作主张认掉");
  {
    const rows = turns();
    const id = "orphan-turn";
    rows[id] = { id, schema_version: 1, envelope: { trace_id: id }, route: { ok: true },
      state: "unknown", turnId: "turn-从来没发出去过", queuedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), reason: "结果不明" };
    fs.writeFileSync(turnsFile, JSON.stringify(rows));

    const { pipe, sent } = build(() => "不该发");
    await pipe.recover();
    check("查不到证据 → 还是 unknown", turns()[id].state, "unknown");
    await pipe.ingest({ channel: "telegram", raw: tgMsg(3, "喂") });
    check("并且照旧挡着后面的话（等人核对）", sent.length, 0);
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
