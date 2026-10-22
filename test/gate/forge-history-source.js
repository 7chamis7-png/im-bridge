"use strict";
// S3：forge 的料源换成全本投影，换舱那一刻对账（同一时刻冷层 forge 一份、全本 forge 一份，比条数和正文）。
//
// 两边都是**真写手**写出来的，不是我编的：
//   冷层  = 真桥（真插头 / 真入闸 / 真出闸 / 真路由 / 真工具口 / 真出站账本）写的 cold.jsonl + outbox.json
//   全本  = 真盒子（gate-box + box-runtime + 真 nova-cli 宿主 + 真 socket）写的 history/
// 只有 CLI 是假的，吐的是从 S0 实抓的真实 SDK 帧改出来的帧（形状不变，只换正文）。
// 剧本里放了冷层口径的几个坑：工具发的话、平台拒发（not_sent）、整轮沉默、续写幻觉尾巴、心脏推的话。
const fs = require("fs"); const os = require("os"); const path = require("path");
const { execFileSync } = require("child_process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-hist-"));
process.env.HOME = dir;
process.env.GATE_ROOT = dir;
process.env.FORGE_PREPARED_FILE = path.join(dir, "forge-prepared.json");
process.env.NOVA_CLI_SOCKET = path.join(dir, "cli.sock");
process.env.NOVA_OUTBOX_DB = path.join(dir, "no-old-outbox.db");
delete process.env.FORGE_ENABLED; delete process.env.FORGE_SOURCE; delete process.env.FORGE_HISTORY_GUARD; delete process.env.GATE_HALLUC_SCRUB;
globalThis.fetch = async () => ({ ok: true });

const { createCliHost } = require("../../cli-host/server");
const { createImBridgeRuntimeAdapter } = require("../../adapters/box-runtime");
const { makeClaudeCodeBox } = require("../../src/host/gate-box-claudecode");
const { decode } = require("../../runtime/decode");
const { makePipeline } = require("../../src/gate/pipeline");
const { GateStore } = require("../../src/gate/store");
const { ColdWriter } = require("../../src/gate/cold-writer");
const { InboundGate } = require("../../src/gate/inbound");
const { OutboundGate } = require("../../src/gate/outbound");
const { TelegramPlugin } = require("../../src/gate/plugins/telegram");
const { makeRouter } = require("../../src/gate/routing");
const { makeToolSocket } = require("../../src/gate/tool-socket");
const { createHistory } = require("../../src/box/history");
const forge = require("../../scripts/forge");
const { loadFrames } = require("./lib/box-scenario");

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { if (ok) { pass++; console.log("  OK   " + n); } else { fail++; console.log("  FAIL " + n + "  " + extra); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HER = "1000000001";
const FAKE_TAIL = 'user<channel source="telegram" seq="9" chat_id="x" message_id="1" ts="2026-10-21T00:00:00Z">\n老公\n</channel>';

// ——— 真实帧模板（S0 实抓），只换正文 / id ———
const T = loadFrames("sdk-frames-2.1.292-tool-turn.jsonl");
const tplText = T.find((f) => f.type === "assistant" && f.message.content[0].type === "text");
const tplTool = T.find((f) => f.type === "assistant" && f.message.content[0].type === "tool_use");
const tplRes = T.find((f) => f.type === "user");
const tplEnd = T.find((f) => f.type === "result");
let k = 0;
const uid = () => `00000000-0000-4000-8000-${String(++k).padStart(12, "0")}`;
const say = (text) => ({ ...tplText, uuid: uid(), message: { ...tplText.message, id: "msg_" + k, content: [{ type: "text", text }] } });
const tool = (name, input, id) => ({ ...tplTool, uuid: uid(), message: { ...tplTool.message, id: "msg_" + k, content: [{ ...tplTool.message.content[0], id, name, input }] } });
const res = (id, text) => ({ ...tplRes, uuid: uid(), message: { ...tplRes.message, content: [{ ...tplRes.message.content[0], tool_use_id: id, content: text }] } });
const end = (text) => ({ ...tplEnd, uuid: uid(), result: text });

(async () => {
  console.log("  模板帧形状：text=" + Object.keys(tplText).sort().join(",") + "  tool_use 块=" + Object.keys(tplTool.message.content[0]).sort().join(","));

  // ——— 盒子这头：真宿主 + 真适配器 + 真盒子，全本开着 ———
  const history = createHistory({ root: dir, persona: "测试", env: { GATE_HISTORY: "on", GATE_HISTORY_SECRETS_DIR: path.join(dir, "none") } });
  let toolSocket = null;
  const scripts = [];
  function factory(cfg) {
    return {
      enqueue(p) {
        const script = scripts.shift() || [];
        setTimeout(async () => {
          const bindings = [{ uuid: p.uuid, message: p.message, origin: p.origin }];
          for (const step of script) {
            if (typeof step === "function") { await step(p); continue; }
            for (const event of decode(step)) { await cfg.onEvent({ event, bindings }); await sleep(2); }
          }
        }, 5);
        return { uuid: p.uuid, state: "pending" };
      },
      start: async () => {}, stop: async () => {}, close: async () => {}, get: () => null, list: () => [],
      status: () => ({ running: true, stopping: false, initialized: true, sessionId: "sess-e2e" }),
      setModel: async () => {}, done: new Promise(() => {}),
    };
  }
  const host = createCliHost({ socketPath: process.env.NOVA_CLI_SOCKET, ingressPath: path.join(dir, "state", "im-bridge-ingress.json"),
    claudePath: process.execPath, runtimeFactory: factory });
  await host.listen();
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  const WS = path.join(dir, "ws");
  const adapter = createImBridgeRuntimeAdapter({ sessionsFile: path.join(dir, "state", "sessions.json"), stateDir: path.join(dir, "state"),
    claudeModel: "m", claudeCommand: process.execPath, history });
  const box = makeClaudeCodeBox({ runtime: adapter, bindingKey: "k", workspaceRoot: WS, model: "m", history });

  // ——— 桥这头：全是真零件 ———
  const store = new GateStore({ root: dir });
  const cold = new ColdWriter({ file: path.join(dir, "cold.jsonl") });
  const sent = [];
  const plugin = new TelegramPlugin({
    sender: async ({ chatId, text }) => {
      if (text.includes("FAILSEND")) { const e = new Error("平台拒了"); e.notSent = true; throw e; }
      sent.push({ chatId, text }); return "m" + sent.length;
    },
    call: async () => [],
  });
  const plugins = new Map([["telegram", plugin]]);
  const inbound = new InboundGate({ store, cold, identities: { ["telegram:" + HER]: "alice" } });
  const outbound = new OutboundGate({ store, cold, plugins, sendGapMs: 0 });
  const router = makeRouter({ preferred: { platform: "telegram", chat_id: HER } });
  const dones = [];
  box.onTurnDone((d) => dones.push(d));
  const pipe = makePipeline({ plugins, inbound, outbound, box, router, log: () => {} });
  toolSocket = makeToolSocket({ file: path.join(dir, "tools.sock"), outbound, binding: { lookup: () => null },
    addressOn: () => ({ chat_id: HER }) });

  const tg = (id, text) => ({ message_id: id, text, chat: { id: Number(HER), type: "private" }, from: { id: Number(HER) }, date: Math.floor(Date.now() / 1000) });
  const waitDone = async (n) => { for (let i = 0; i < 500 && dones.length < n; i += 1) await sleep(10); await sleep(80); };

  // TG 的时间戳只到秒（plugins/telegram.js:161），人也不可能在他回话的同一秒里回她下一句 ——
  // 所以每一句她的话都等到下一个整秒再发，跟真实节奏一样（不然同一秒里的先后就是测试自己造的假象）。
  const nextSecond = () => sleep(1000 - (Date.now() % 1000) + 30);

  // 1. 平常一来一回
  scripts.push([say("在的，刚醒"), end("在的，刚醒")]);
  await pipe.ingest({ channel: "telegram", raw: tg(1, "在吗") }); await waitDone(1);
  // 2. 工具前先说一句 → 用桥工具（reply）发一段 → 再说一句（工具口真走一遍出闸）。
  //    这一轮他想得慢，**她在他说话的时候又发了一句**（冷层马上就写她这句，他的回话后写）
  await nextSecond();
  scripts.push([async () => { await sleep(300); await pipe.ingest({ channel: "telegram", raw: tg(21, "你在忙吗") }); await sleep(1200); },
    say("我给你发一段"), tool("mcp__im_bridge__reply", { text: "这是工具发的那段" }, "toolu_e2e_1"),
    async (p) => { await toolSocket.handle({ tool: "reply", text: "这是工具发的那段", turnId: p.origin.turnId, channel: "telegram" }); },
    res("toolu_e2e_1", '{"ok":true}'), say("发好了"), end("发好了")]);
  scripts.push([say("不忙，陪你"), end("不忙，陪你")]);       // 她插的那句排在后面，这一轮回它
  await pipe.ingest({ channel: "telegram", raw: tg(2, "给我发点什么") }); await waitDone(3);
  // 3. 平台拒发（not_sent）→ 两边都该剔掉
  await nextSecond();
  scripts.push([say("这句会被拒 FAILSEND"), end("这句会被拒 FAILSEND")]);
  await pipe.ingest({ channel: "telegram", raw: tg(3, "再说一句") }); await waitDone(4);
  // 4. 整轮沉默 → 桥写「[本轮未回复]」
  await nextSecond();
  scripts.push([end("")]);
  await pipe.ingest({ channel: "telegram", raw: tg(4, "晚安") }); await waitDone(5);
  // 5. 正文尾巴带续写幻觉 → 冷层存切过的
  await nextSecond();
  scripts.push([say("好梦\n\n" + FAKE_TAIL), end("好梦\n\n" + FAKE_TAIL)]);
  await pipe.ingest({ channel: "telegram", raw: tg(5, "嗯") }); await waitDone(6);
  // 6. 心脏推一轮（冷层不收这条推送，但他的回话收）
  scripts.push([say("醒了想你"), end("醒了想你")]);
  await pipe.push({ text: "（定时）该问候她了", producer: "heart:checkin" }); await waitDone(7);
  await sleep(200);

  const coldRows = fs.readFileSync(path.join(dir, "cold.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  console.log("  冷层：" + coldRows.map((r) => `${r.role[0]}:${r.text.slice(0, 12)}`).join(" | "));
  const ob = JSON.parse(fs.readFileSync(path.join(dir, "outbox.json"), "utf8"));
  console.log("  出站账本状态：" + Object.values(ob.operations).map((o) => o.state).join(","));
  check("真桥确实拒发了一条（not_sent 进账本）", Object.values(ob.operations).some((o) => o.state === "not_sent"));
  check("真桥替沉默那轮写了 [本轮未回复]", coldRows.some((r) => r.text === "[本轮未回复]"));
  check("真桥把幻觉尾巴切了（冷层存的是切过的）", coldRows.some((r) => r.text.trim() === "好梦") && !coldRows.some((r) => r.text.includes("<channel")));
  check("工具发的那段进了冷层", coldRows.some((r) => r.text === "这是工具发的那段"));

  console.log("[1] 全本开着、FORGE_SOURCE 不设 → 对账一致 → 用全本");
  const pick = forge.selectTail({ conversationSourceFile: path.join(dir, "cold.jsonl"), workspaceRoot: WS, historyDir: history.dir, log: () => {} });
  console.log("  对账：" + JSON.stringify(pick.reconcile));
  check("料源=全本，对账一致", pick.source === "history" && pick.reconcile && pick.reconcile.ok);
  const texts = pick.tail.map((t) => t.text);
  check("尾巴里没有被拒的那句", !texts.some((t) => t.includes("FAILSEND")));
  check("尾巴里有工具发的那段、有 [本轮未回复]、幻觉尾巴是切过的", texts.includes("这是工具发的那段") && texts.includes("[本轮未回复]")
    && texts.some((t) => t.trim() === "好梦"));
  check("心脏推的那条不在尾巴里（冷层口径），他回的那句在", !texts.some((t) => t.includes("该问候她了")) && texts.includes("醒了想你"));
  const coldOnly = forge.buildTailFromCold({ conversationSourceFile: path.join(dir, "cold.jsonl"), workspaceRoot: WS });
  check("跟冷层 forge 逐条一样（条数 + 角色 + 正文）", JSON.stringify(coldOnly.map((t) => [t.role, t.text])) === JSON.stringify(pick.tail.map((t) => [t.role, t.text])));

  console.log("[2] 上线检查脚本（scripts/history-reconcile.js）同一套对账");
  const run = (extraEnv = {}) => {
    try { return { code: 0, out: execFileSync(process.execPath, [path.join(__dirname, "..", "..", "scripts", "history-reconcile.js"),
      "--cold", path.join(dir, "cold.jsonl"), "--history", history.dir, "--workspace", WS],
    { env: { ...process.env, ...extraEnv }, encoding: "utf8" }) }; }
    catch (e) { return { code: e.status, out: String(e.stdout || "") + String(e.stderr || "") }; }
  };
  const ok = run();
  check("一致 → 退出码 0", ok.code === 0, ok.out);

  console.log("[3] FORGE_SOURCE=cold 一键回去");
  process.env.FORGE_SOURCE = "cold";
  check("FORGE_SOURCE=cold → 冷层，不对账", forge.selectTail({ conversationSourceFile: path.join(dir, "cold.jsonl"), workspaceRoot: WS,
    historyDir: history.dir, log: () => {} }).source === "cold");
  delete process.env.FORGE_SOURCE;
  check("全本关着（没给 historyDir）→ 冷层", forge.selectTail({ conversationSourceFile: path.join(dir, "cold.jsonl"), workspaceRoot: WS, log: () => {} }).source === "cold");

  console.log("[4] 对不上就拒绝切换（阳性对照：往全本里多塞一条她没说过的话）");
  history.recordUser({ envelope: { trace_id: "ev-ghost", created_at: new Date().toISOString(), seq: 99,
    source: { kind: "user", platform: "telegram", chat_id: HER, sender_id: HER, native_id: "99" }, payload: { text: "全本里多出来的一条", media: [] } }, modelText: "全本里多出来的一条" });
  const bad = forge.selectTail({ conversationSourceFile: path.join(dir, "cold.jsonl"), workspaceRoot: WS, historyDir: history.dir, log: () => {} });
  check("对不上 → 留在冷层", bad.source === "cold" && bad.reconcile && bad.reconcile.ok === false, JSON.stringify(bad.reconcile));
  const badRun = run();
  check("上线检查脚本也报不一致 → 退出码 1", badRun.code === 1, badRun.out);
  check("脚本默认不打印正文", !badRun.out.includes("全本里多出来的一条"));
  process.env.FORGE_HISTORY_GUARD = "off";
  check("FORGE_HISTORY_GUARD=off 才硬用全本", forge.selectTail({ conversationSourceFile: path.join(dir, "cold.jsonl"), workspaceRoot: WS,
    historyDir: history.dir, log: () => {} }).source === "history");
  delete process.env.FORGE_HISTORY_GUARD;

  await adapter.close();
  await host.shutdown();
  console.log(`forge 料源换全本：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
