"use strict";
/**
 * 盒子整条线的固定剧本（S1/S2a 测试共用）：真 nova-cli 宿主（cli-host/server）+ 真 socket + 真盒子适配器
 * （adapters/box-runtime）+ 真盒子（gate-box-claudecode），只有 CLI 是假的 —— 假 CLI 吐的是
 * **真实形状**的 SDK 帧（test/fixtures/real/sdk-frames-2.1.292-tool-turn.jsonl，S0 实抓、正文占位）。
 *
 * `root` 可以指到别的代码树（比如 9a332e7 的 worktree）：拿老代码跑同一个剧本生成「金标准」，
 * 新代码关着开关跑出来必须逐字节一样。
 *
 * 时间钉死（Date.now 固定），所以 turnId / at 都是确定的。
 */
const fs = require("fs"); const os = require("os"); const path = require("path");

const NOW = 1792500000000;
const FIX = path.join(__dirname, "..", "..", "fixtures", "real");

function loadFrames(file, suffix = "") {
  return fs.readFileSync(path.join(FIX, file), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    .map((f) => (suffix && f.uuid ? { ...f, uuid: f.uuid + suffix } : f));
}

/**
 * @param {object} o
 * @param {string} o.root          代码树根目录
 * @param {object|null} [o.history] 全本记账员（只有新代码认）
 * @param {function} [o.emitFor]   (frames, decode, enq, emit) => Promise —— 自定义怎么吐（S2a 用来吐中性事件）
 * @param {object[][]} [o.turns]   每一轮吐哪些帧
 */
async function runBoxScenario({ root, history = null, emitFor = null, turns = null, dir = null, env = {} } = {}) {
  dir = dir || fs.mkdtempSync(path.join(os.tmpdir(), "box-scenario-"));
  process.env.HOME = dir;
  process.env.FORGE_PREPARED_FILE = path.join(dir, "forge-prepared.json");
  process.env.GATE_ROOT = dir;
  process.env.NOVA_CLI_SOCKET = path.join(dir, "cli.sock");
  delete process.env.FORGE_ENABLED;
  delete process.env.GATE_HALLUC_SCRUB;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  globalThis.fetch = async () => ({ ok: true });
  const realNow = Date.now;
  Date.now = () => NOW;

  const { createCliHost } = require(path.join(root, "cli-host/server"));
  const { createImBridgeRuntimeAdapter } = require(path.join(root, "adapters/box-runtime"));
  const { makeClaudeCodeBox } = require(path.join(root, "src/host/gate-box-claudecode"));
  const { makeEnvelope } = require(path.join(root, "src/gate/envelope"));
  const { decode } = require(path.join(root, "runtime/decode"));

  // 第三轮用老夹具（2.1.278 形状，工具前先说一句「Let me check.」→ 有正文候选 + 最终正文两段）
  const plan = turns || [loadFrames("sdk-frames-2.1.292-tool-turn.jsonl"), loadFrames("sdk-frames-2.1.292-tool-turn.jsonl", "-t2"),
    loadFrames("../sdk-tool-turn.jsonl")];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let turnNo = 0;

  const defaultEmit = async (frames, enq, emit) => {
    const bindings = [{ uuid: enq.uuid, message: enq.message, origin: enq.origin }];
    for (const f of frames) for (const event of decode(f)) { await emit({ event, bindings }); await sleep(2); }
  };

  function factory(cfg) {
    const rt = {
      enqueue(p) {
        const frames = plan[turnNo++] || [];
        setTimeout(() => { (emitFor || defaultEmit)(frames, p, (x) => cfg.onEvent(x), decode).catch((e) => console.error("剧本吐帧出错", e)); }, 5);
        return { uuid: p.uuid, state: "pending" };
      },
      start: async () => {}, stop: async () => {}, close: async () => {},
      get: () => null, list: () => [],
      status: () => ({ running: true, stopping: false, initialized: true, sessionId: "sess-fixed" }),
      setModel: async () => {}, done: new Promise(() => {}),
    };
    return rt;
  }

  const host = createCliHost({ socketPath: process.env.NOVA_CLI_SOCKET, ingressPath: path.join(dir, "state", "im-bridge-ingress.json"),
    claudePath: process.execPath, runtimeFactory: factory });
  await host.listen();
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const WS = path.join(dir, "ws");
  const sessionsFile = path.join(stateDir, "sessions.json");
  const adapter = createImBridgeRuntimeAdapter({ sessionsFile, stateDir, claudeModel: "m", claudeCommand: process.execPath, history });

  const events = []; const replies = []; const dones = [];
  const tee = Object.create(adapter);
  tee.onEvent = (fn) => adapter.onEvent((e, x) => { events.push(JSON.parse(JSON.stringify(e))); return fn(e, x); });
  const box = makeClaudeCodeBox({ runtime: tee, bindingKey: "k", workspaceRoot: WS, model: "m", history });
  box.onReply((r) => replies.push(r));
  box.onTurnDone((d) => dones.push(d));

  const png = path.join(dir, "pic.png");
  fs.writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64"));
  const envs = [
    makeEnvelope({ trace_id: "ev-scn-1", source: { kind: "user", platform: "telegram", chat_id: "1000", sender_id: "1000", native_id: "11" },
      identity: "alice", payload: { text: "«正文·12字»" }, seq: 7001, created_at: "2026-10-21T01:00:00.000Z" }),
    makeEnvelope({ trace_id: "ev-scn-2", source: { kind: "user", platform: "telegram", chat_id: "1000", sender_id: "1000", native_id: "12" },
      identity: "alice", payload: { text: "«正文·5字»", media: [{ kind: "image", mime: "image/png", filePath: png }] }, seq: 7002,
      created_at: "2026-10-21T01:01:00.000Z" }),
    makeEnvelope({ trace_id: "sys-scn-3", source: { kind: "system", producer: "heart:checkin" },
      payload: { text: "«正文·30字»" }, created_at: "2026-10-21T01:02:00.000Z" }),
  ];
  const results = [];
  for (let i = 0; i < envs.length; i += 1) {
    results.push(await box.deliver(envs[i]));
    for (let k = 0; k < 400 && dones.length < i + 1; k += 1) await sleep(10);
  }
  await adapter.close();
  try { await host.shutdown(); } catch { /* 无所谓 */ }
  Date.now = realNow;
  return { dir, out: { results, events, replies, dones } };
}

module.exports = { runBoxScenario, loadFrames, NOW, FIX };

if (require.main === module) {
  // 生成金标准：node test/gate/lib/box-scenario.js <代码树根> <输出.json>
  const [root, out] = process.argv.slice(2);
  runBoxScenario({ root: path.resolve(root) }).then(({ out: o }) => {
    fs.writeFileSync(out, JSON.stringify(o, null, 1) + "\n");
    console.log(`金标准：events ${o.events.length} 条、replies ${o.replies.length}、dones ${o.dones.length} → ${out}`);
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
