"use strict";
// S5 /engine 跨厂商换引擎（设计稿 §5.3，Alice 10-21：跨厂商 = 一次正规换舱）—— 端到端接线：
//   真盒子（adapters/box-runtime.js + gate-box-claudecode）⇄ cli.sock ⇄ 真单宿主（cli-host/server.js + engines.js）
//   插头：claude = 假 CLI（吐真形状的 SDK 帧）；codex = 真插头 + 真驱动 ⇄ 假 app-server；DeepSeek = 真插头 + 桩 fetch
// 盯住：
//   [1] /model 只管同一家：别家的模型拒绝并指 /engine；登记表里没有的拒绝
//   [2] 钱闸：按量计费没开 allow → 拒，原引擎原舱不动
//   [3] claude → codex：宿主不重启换芯、新 thread、尾巴（底子 + 冷层）inject 进去；回执写清模型/窗口/垫了几轮/降级/全量重算；
//       sessions.json 改成新模型新舱；/status 分母跟着登记表变
//   [4] 换引擎期间来的话排着，起好了递给新引擎
//   [5] 新引擎起不来（钥匙不在）→ 回原引擎原舱、说清卡在哪
//   [6] codex → DeepSeek：新对话本、尾巴当历史；看不见图 → 图换成 [图片]
//   [7] DeepSeek → claude：合成新舱（不 resume 旧舱）、逐条核对过；宿主还是同一个
//   [8] 窗口太小装不下人格包 + 最低尾巴 → 拒
const fs = require("fs"); const os = require("os"); const path = require("path");

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { if (ok) { pass++; console.log("  OK   " + n); } else { fail++; console.log("  FAIL " + n + "  " + extra); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 5000) => { const t = Date.now() + ms; while (Date.now() < t) { if (await fn()) return true; await sleep(20); } return false; };

const FAKE = path.join(__dirname, "lib", "fake-codex-appserver.js");
fs.chmodSync(FAKE, 0o755);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-switch-"));
const ws = path.join(root, "ws"); fs.mkdirSync(ws);
const stateDir = path.join(root, "state"); fs.mkdirSync(stateDir);
const bin = path.join(root, "bin"); fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\necho '2.1.292 (Claude Code)'\n", { mode: 0o755 });
const secrets = path.join(root, "secrets"); fs.mkdirSync(secrets);
const rolloutDir = path.join(root, "rollouts"); fs.mkdirSync(rolloutDir);
const rpcFile = path.join(root, "rpc.jsonl");
const auth = path.join(root, "auth.json");
fs.writeFileSync(auth, JSON.stringify({ auth_mode: "chatgpt", tokens: {} }));
fs.writeFileSync(path.join(root, "forge-state.json"), JSON.stringify({ validatedVersion: "2.1.292" }));
const now = Date.now();
const cold = [];
for (let i = 1; i <= 6; i += 1) {
  cold.push({ id: `c${i}-user`, role: "user", at: new Date(now - 700000 + i * 60000).toISOString(), text: `冷层她#${i}` });
  cold.push({ id: `c${i}-asst`, role: "assistant", at: new Date(now - 700000 + i * 60000 + 1000).toISOString(), text: `冷层他#${i}` });
}
fs.writeFileSync(path.join(root, "cold.jsonl"), cold.map((r) => JSON.stringify(r)).join("\n") + "\n");
const modelsFile = path.join(root, "models.json");
const models = { v: 1, default: "claude-fable-5[1m]", models: [
  { id: "claude-fable-5[1m]", label: "Fable 5", engine: "claude-cli", window: 1000000, vision: true, tools: true, billing: "subscription" },
  { id: "claude-opus-5-5[1m]", label: "Opus 5.5", engine: "claude-cli", window: 1000000, vision: true, tools: true, billing: "subscription" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", engine: "codex-appserver", window: 872000, verified: true, vision: true, tools: true,
    billing: "subscription", codexConfig: { model_context_window: 872000 } },
  { id: "deepseek-chat", label: "DeepSeek", engine: "openai-chat", window: 128000, vision: false, tools: true, billing: "api",
    requiresAllow: "DEEPSEEK_ALLOW_BILLING", secret: "deepseek", baseUrl: "https://api.deepseek.com" },
  { id: "tiny", engine: "openai-chat", window: 9000, billing: "subscription", secret: "deepseek" },
] };
fs.writeFileSync(modelsFile, JSON.stringify(models));
const sessionsFile = path.join(stateDir, "sessions.json");
const BK = "telegram:1:1";
fs.writeFileSync(sessionsFile, JSON.stringify({ bindings: { [BK]: { activeWorkspaceRoot: ws,
  threadIdByWorkspaceRootByRuntime: { claudecode: { [ws]: "claude-old" } },
  runtimeParamsByWorkspaceRootByRuntime: { claudecode: { [ws]: { model: "claude-fable-5[1m]", modelProvider: "" } } } } } }));

Object.assign(process.env, { HOME: root, PATH: `${bin}:${process.env.PATH}`, GATE_ROOT: root, GATE_MODELS_FILE: modelsFile,
  FORGE_STATE_FILE: path.join(root, "forge-state.json"), FORGE_PREPARED_FILE: path.join(root, "forge-prepared.json"),
  FAKE_CODEX_LOG: rpcFile, FAKE_CODEX_ROLLOUT_DIR: rolloutDir, NOVA_CLI_SOCKET: path.join(root, "cli.sock"),
  GATE_COLD_FILE: path.join(root, "cold.jsonl"), OUTWARD_TZ: "Asia/Shanghai", OUTWARD_LOCALE: "zh-CN",
  CODEX_COMMAND: FAKE, CODEX_AUTH_FILE: auth, CODEX_HOME_DIR: root, GATE_ENGINE_SWITCH_MIN_TURNS: "1" });
for (const k of ["GATE_HISTORY", "FORGE_ENABLED", "GATE_MODEL", "GATE_ENGINE", "DEEPSEEK_ALLOW_BILLING", "GATE_BOX_CONTEXT_LIMIT"]) delete process.env[k];

const dsCalls = [];
globalThis.fetch = async (url, opts) => {
  if (String(url).includes("deepseek")) {
    dsCalls.push(JSON.parse(opts.body));
    return { ok: true, status: 200, async text() { return JSON.stringify({ model: "deepseek-chat", choices: [{ message: { role: "assistant", content: "DS嗯" } }] }); } };
  }
  return { ok: true };   // 脉
};

const { createCliHost } = require("../../cli-host/server");
const { createEngineFactories } = require("../../cli-host/engines");
const { createImBridgeRuntimeAdapter } = require("../../adapters/box-runtime");
const { makeClaudeCodeBox } = require("../../src/host/gate-box-claudecode");
const { decode } = require("../../runtime/decode");

const claudeStarts = [];
function fakeClaude(cfg) {
  const me = { resume: (cfg.sdkOptions || {}).resume || "", systemPrompt: (cfg.sdkOptions || {}).systemPrompt || "", closed: false, turns: [] };
  claudeStarts.push(me);
  const sid = me.resume || `claude-new-${claudeStarts.length}`;
  return {
    enqueue(p) {
      me.turns.push(p);
      setTimeout(async () => {
        const bindings = [{ uuid: p.uuid, message: p.message, origin: p.origin }];
        const frames = [
          { type: "assistant", uuid: `fr-${p.uuid}`, session_id: sid, message: { id: `m-${p.uuid}`, model: "claude-fable-5", role: "assistant",
            content: [{ type: "text", text: "C嗯" }], usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
          { type: "result", subtype: "success", is_error: false, result: "C嗯", session_id: sid },
        ];
        for (const f of frames) for (const event of decode(f)) await cfg.onEvent({ event, bindings });
      }, 5);
      return { uuid: p.uuid, state: "pending" };
    },
    start: async () => {}, stop: async () => {}, close: async () => { me.closed = true; },
    get: () => null, list: () => [],
    status: () => ({ running: true, stopping: false, initialized: true, sessionId: sid }),
    setModel: async () => {}, done: new Promise(() => {}),
  };
}

const rpc = () => { try { return fs.readFileSync(rpcFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const count = (m) => rpc().filter((c) => c.method === m).length;
const binding = () => JSON.parse(fs.readFileSync(sessionsFile, "utf8")).bindings[BK];
const sessModel = () => binding().runtimeParamsByWorkspaceRootByRuntime.claudecode[ws].model;
const sessThread = () => binding().threadIdByWorkspaceRootByRuntime.claudecode[ws] || "";

(async () => {
  const host = createCliHost({ socketPath: process.env.NOVA_CLI_SOCKET, ingressPath: path.join(stateDir, "im-bridge-ingress.json"),
    claudePath: process.execPath, scope: "box", engine: "claude",
    engines: createEngineFactories({ env: process.env, stateDir, workspace: ws, secretsDir: secrets, overrides: { claude: fakeClaude } }) });
  await host.listen();
  const rt = createImBridgeRuntimeAdapter({ sessionsFile, stateDir, claudeModel: "", claudeCommand: process.execPath,
    conversationSourceFile: path.join(root, "cold.jsonl"), workspaceRoot: ws, modelsFile });
  await rt.initialize();
  const box = makeClaudeCodeBox({ runtime: rt, bindingKey: BK, workspaceRoot: ws, model: "" });
  const done = [];
  rt.onEvent((e) => { if (e.type === "runtime.turn.completed") done.push(e.payload); });
  const say = async (text, attachments = []) => {
    const n = done.length;
    await rt.sendTurn({ bindingKey: BK, workspaceRoot: ws, text, attachments, metadata: {} });
    await waitFor(() => done.length > n);
    await sleep(60);
    return done[done.length - 1];
  };

  console.log("[0] 起点：claude 那舱 claude-old");
  const t0 = await say("第一句");
  check("第一句 claude 接的（续的是 claude-old）", t0 && t0.text === "C嗯" && claudeStarts[0].resume === "claude-old", JSON.stringify(t0));
  check("describe 报 claude-cli、窗口 100 万", rt.describe().engine === "claude-cli" && rt.describe().window === 1000000, JSON.stringify(rt.describe()));

  console.log("[1] /model 只管同一家");
  let err = "";
  try { await rt.setModelForWorkspace({ workspaceRoot: ws, model: "gpt-5.6-sol" }); } catch (e) { err = e.message; }
  check("别家的模型 → 拒绝，指 /engine", /\/engine gpt-5\.6-sol/.test(err), err);
  err = "";
  try { await rt.setModelForWorkspace({ workspaceRoot: ws, model: "claude-opus-9" }); } catch (e) { err = e.message; }
  check("登记表里没有 → 拒绝", /登记表里没有/.test(err), err);
  const hot = await rt.setModelForWorkspace({ workspaceRoot: ws, model: "claude-opus-5-5[1m]" });
  check("同一家 → 热切（live）", hot.applied === "live" && sessModel() === "claude-opus-5-5[1m]", JSON.stringify(hot));

  console.log("[2] 钱闸");
  err = "";
  try { await box.rotate({ reason: "换引擎", engine: { model: "deepseek-chat" } }); } catch (e) { err = e.message; }
  check("按量计费没开 allow → 拒（卡在「钱闸」）", /卡在「钱闸」[\s\S]*DEEPSEEK_ALLOW_BILLING/.test(err), err);
  check("原引擎原舱不动", claudeStarts.length === 1 && !claudeStarts[0].closed && sessThread() === "claude-old");

  console.log("[3] claude → codex");
  const r3 = await box.rotate({ reason: "她换引擎", engine: { model: "gpt-5.6-sol" } });
  const rc = r3.engineSwitch || {};
  check("回执：新模型 / 引擎 / 窗口 / 全量重算", rc.model === "gpt-5.6-sol" && rc.engine === "codex-appserver" && rc.window === 872000 && rc.fullRecompute === true, JSON.stringify(rc));
  check("回执：垫了几轮、料源、降级清单", rc.turns >= 6 && rc.source === "cold" && Array.isArray(rc.degraded) && rc.degraded.some((d) => /思考块/.test(d)), JSON.stringify(rc));
  check("旧 claude 插头关了；同一个宿主换芯", claudeStarts[0].closed === true && host._internals.live.engine === "codex-appserver");
  check("开了新 thread、没 resume 旧的", count("thread/start") === 1 && count("thread/resume") === 0);
  const inj = rpc().filter((c) => c.method === "thread/inject_items");
  check("尾巴 inject 进去（冷层原话）", inj.length === 1 && JSON.stringify(inj[0].params.items).includes("冷层他#6"));
  check("codex 启动参数带登记表的窗口", rpc().some((c) => (c.argv || []).join(" ").includes("model_context_window=872000")));
  check("sessions.json：新模型 + 新舱号", sessModel() === "gpt-5.6-sol" && sessThread() === rc.threadId && rc.threadId.startsWith("thr-"), sessThread());
  check("/status 分母跟着登记表变（87.2 万）", box.fullness().limit === 872000, JSON.stringify(box.fullness()));
  check("换引擎流水记了一笔", fs.readFileSync(path.join(stateDir, "engine-switches.jsonl"), "utf8").includes('"engine":"codex-appserver"'));
  const t3 = await say("换完第一句");
  check("下一句 codex 在新 thread 上答", t3 && t3.text === "嗯。" && rpc().filter((c) => c.method === "turn/start").pop().params.threadId === rc.threadId, JSON.stringify(t3));

  console.log("[5] 新引擎起不来 → 回原引擎原舱");
  process.env.DEEPSEEK_ALLOW_BILLING = "1";
  const startsBefore = count("thread/start");
  err = "";
  try { await box.rotate({ reason: "换引擎", engine: { model: "deepseek-chat" } }); } catch (e) { err = e.message; }
  check("钥匙不在 → 卡在「起新引擎」、说回到了原来那个", /卡在「起新引擎」[\s\S]*没有钥匙文件[\s\S]*已回到 gpt-5\.6-sol/.test(err), err);
  check("回的是原来那条 thread（没新开）", host._internals.live.engine === "codex-appserver" && count("thread/start") === startsBefore
    && sessThread() === rc.threadId && sessModel() === "gpt-5.6-sol");
  const t5 = await say("还在吗");
  check("回去之后照常答", t5 && t5.text === "嗯。");

  console.log("[4][6] codex → DeepSeek（换的时候她又说了一句）");
  fs.writeFileSync(path.join(secrets, "deepseek.secret"), "sk-test\n", { mode: 0o600 });
  const switching = box.rotate({ reason: "换引擎", engine: { model: "deepseek-chat" } });
  await sleep(5);
  const parkedN = done.length;
  const parked = rt.sendTurn({ bindingKey: BK, workspaceRoot: ws, text: "换的时候说的", metadata: {} });
  const r6 = await switching;
  await parked;
  await waitFor(() => done.length > parkedN);
  check("回执：DeepSeek / 12.8 万 / 看不见图 / 窗口未核实", r6.engineSwitch.engine === "openai-chat" && r6.engineSwitch.window === 128000
    && r6.engineSwitch.degraded.some((d) => /看不见图/.test(d)) && r6.engineSwitch.degraded.some((d) => /未从引擎核实/.test(d)), JSON.stringify(r6.engineSwitch));
  check("[4] 换的时候说的那句排着，递给了新引擎", dsCalls.length >= 1 && JSON.stringify(dsCalls[0].messages).includes("换的时候说的"));
  const sent = JSON.stringify(dsCalls[0].messages);
  check("DeepSeek 第一请求带着尾巴（冷层原话）", sent.includes("冷层他#6") && sent.includes("冷层她#1"));
  const img = path.join(root, "pic.png"); fs.writeFileSync(img, Buffer.from("89504e47", "hex"));
  await say("看图", [{ isImage: true, absolutePath: img, contentType: "image/png" }]);
  check("[6] 看不见图：图换成 [图片]", JSON.stringify(dsCalls[dsCalls.length - 1].messages).includes("[图片]"));

  console.log("[7] DeepSeek → claude（合成新舱，不 resume 旧舱）");
  const r7 = await box.rotate({ reason: "换回来", engine: { model: "claude-fable-5[1m]" } });
  const sid7 = r7.engineSwitch.threadId;
  const synth = path.join(root, ".claude", "projects", ws.replace(/\//g, "-"), sid7 + ".jsonl");
  const lines = fs.existsSync(synth) ? fs.readFileSync(synth, "utf8").trim().split("\n") : [];
  check("合成了一份新 transcript，带着冷层尾巴", lines.length > 6 && lines.join("\n").includes("冷层他#6"), String(lines.length));
  const last = claudeStarts[claudeStarts.length - 1];
  check("claude 插头 resume 的是新合成的那舱（不是 claude-old）", last.resume === sid7 && sid7 !== "claude-old");
  check("sessions.json 改回 claude", sessModel() === "claude-fable-5[1m]" && sessThread() === sid7);
  const t7 = await say("回来了");
  check("回来第一句 claude 答", t7 && t7.text === "C嗯");

  console.log("[8] 窗口太小");
  err = "";
  try { await box.rotate({ reason: "换引擎", engine: { model: "tiny" } }); } catch (e) { err = e.message; }
  check("装不下人格包 + 最低尾巴 → 卡在「算窗口」", /卡在「算窗口」/.test(err), err);
  check("同一家用 /engine → 拒", await box.rotate({ reason: "x", engine: { model: "claude-opus-5-5[1m]" } }).then(() => false, (e) => /同一家换模型用 \/model/.test(e.message)));

  try { await rt.close(); } catch {}
  await host.shutdown();
  console.log(`\n换引擎：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
