"use strict";
// S3c（2026-10-21）：Iris（codex）改由桥换舱 —— 端到端接线：
//   真盒子（adapters/box-runtime.js）⇄ cli.sock ⇄ 真 cli 宿主（cli-host/server.js）+ 真 codex 插头 + 真驱动 ⇄ 假 app-server
// 盯住：
//   [1] sessions.json 里的旧标签被改成 codex 实际在的那条（原来日志「resume=旧 id」是假象）；盒子改对标签不白重起引擎
//   [2] 水位撞线：codex 不裁（不白停引擎），直接换舱
//   [3] /new 换舱 = 开新 thread（不再 resume 旧的）+ forge inject 冷层尾巴；codex-thread.json 记旧号可回滚；换舱单撕掉
//   [4] client 重连会把同一份 ensure 重发：同一张单不换第二次；cli 重启（新宿主）也不换第二次
//   [5] 没换舱单时 sessions.json 没号（群隔离会话 / 首次）→ 不拿他的主线程去换
//   [6] 换舱后桥读到旧水位不再二次换舱（盒子 rotate 清掉旧舱读数）
const fs = require("fs"); const os = require("os"); const path = require("path");

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { if (ok) { pass++; console.log("  OK   " + n); } else { fail++; console.log("  FAIL " + n + "  " + extra); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 4000) => { const t = Date.now() + ms; while (Date.now() < t) { if (fn()) return true; await sleep(20); } return false; };

const FAKE = path.join(__dirname, "lib", "fake-codex-appserver.js");
fs.chmodSync(FAKE, 0o755);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rotate-"));
const ws = path.join(root, "ws"); fs.mkdirSync(ws);
const stateDir = path.join(root, "state"); fs.mkdirSync(stateDir);
const rpcFile = path.join(root, "rpc.jsonl");
const auth = path.join(root, "auth.json");
fs.writeFileSync(auth, JSON.stringify({ auth_mode: "chatgpt", tokens: {} }));
fs.writeFileSync(path.join(root, "tools.json"), JSON.stringify({ forge: true }));
const now = Date.now();
fs.writeFileSync(path.join(root, "cold.jsonl"), [
  { id: "c1-user", role: "user", at: new Date(now - 600000).toISOString(), text: "冷层她#1" },
  { id: "c1-asst", role: "assistant", at: new Date(now - 599000).toISOString(), text: "冷层他#1" },
].map((r) => JSON.stringify(r)).join("\n") + "\n");
const threadFile = path.join(stateDir, "codex-thread.json");
fs.writeFileSync(threadFile, JSON.stringify({ schema: "nova.codex-thread.v1", threadId: "real-1" }));
const sessionsFile = path.join(stateDir, "sessions.json");
const BK = "telegram:1:1";
fs.writeFileSync(sessionsFile, JSON.stringify({ bindings: { [BK]: { activeWorkspaceRoot: ws,
  threadIdByWorkspaceRootByRuntime: { claudecode: { [ws]: "stale-0" } },
  runtimeParamsByWorkspaceRootByRuntime: { claudecode: { [ws]: { model: "gpt-5.6-sol", modelProvider: "" } } } } } }));

Object.assign(process.env, { GATE_ROOT: root, GATE_ENGINE: "codex", GATE_MODEL: "gpt-5.6-sol",
  FAKE_CODEX_LOG: rpcFile, FAKE_CODEX_KNOWN: "real-1", NOVA_CLI_SOCKET: path.join(root, "cli.sock"),
  GATE_COLD_FILE: path.join(root, "cold.jsonl"), OUTWARD_TZ: "Asia/Shanghai", OUTWARD_LOCALE: "zh-CN" });
delete process.env.GATE_HISTORY; delete process.env.FORGE_ENABLED;

const { createCliHost } = require("../../cli-host/server");
const { createCodexRuntime } = require("../../cli-host/codex-runtime");
const { createImBridgeRuntimeAdapter } = require("../../adapters/box-runtime");
const { makeClaudeCodeBox } = require("../../src/host/gate-box-claudecode");

const rpc = () => { try { return fs.readFileSync(rpcFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const count = (m) => rpc().filter((c) => c.method === m).length;
const sessLabel = () => JSON.parse(fs.readFileSync(sessionsFile, "utf8")).bindings[BK].threadIdByWorkspaceRootByRuntime.claudecode[ws] || "";
const threadDisk = () => JSON.parse(fs.readFileSync(threadFile, "utf8"));

let made = 0;
function makeHost() {
  return createCliHost({
    socketPath: process.env.NOVA_CLI_SOCKET, ingressPath: path.join(stateDir, "im-bridge-ingress.json"),
    claudePath: "/usr/bin/true", scope: "codex", engine: "codex",
    fallbackEnsure: () => ({ workspaceRoot: ws, ingressPath: path.join(stateDir, "im-bridge-ingress.json"), sdkOptions: {} }),
    // 跟 cli-host/codex-main.js 同一个装法
    runtimeFactory(cfg) {
      made += 1;
      return createCodexRuntime({ ...cfg, cwd: cfg.cwd || ws, threadFile, authFile: auth, codexPath: FAKE, home: root,
        sdkOptions: cfg.sdkOptions || {} });
    },
  });
}

(async () => {
  let host = makeHost();
  await host.listen();
  const rt = createImBridgeRuntimeAdapter({ sessionsFile, stateDir, claudeModel: "gpt-5.6-sol", claudeCommand: "/usr/bin/true" });
  await rt.initialize();
  const box = makeClaudeCodeBox({ runtime: rt, bindingKey: BK, workspaceRoot: ws, model: "gpt-5.6-sol" });
  const say = async (text) => {
    const before = count("turn/start");
    await rt.sendTurn({ bindingKey: BK, workspaceRoot: ws, text, metadata: {} });
    await waitFor(() => count("turn/start") > before);
    await waitFor(() => {
      try { return JSON.parse(fs.readFileSync(path.join(stateDir, "im-bridge-ingress.json"), "utf8")).records.every((x) => x.state === "completed"); }
      catch { return false; }
    });
    await sleep(80);
  };

  console.log("[1] sessions.json 旧标签 stale-0、codex 实际在 real-1");
  await say("第一句");
  check("codex 续的是 codex-thread.json 那条（real-1），不是盒子的旧标签", rpc().some((c) => c.method === "thread/resume" && c.params.threadId === "real-1")
    && !rpc().some((c) => c.method === "thread/resume" && c.params.threadId === "stale-0"));
  check("sessions.json 标签改成 real-1", sessLabel() === "real-1", sessLabel());
  check("没多开 thread", count("thread/start") === 0);
  await say("第二句");
  check("标签改对之后第二轮：没白重起引擎（只起过 1 个插头）", made === 1, String(made));

  console.log("[2] 水位撞线：codex 不裁");
  const tr = await rt.trimTranscript({ workspaceRoot: ws, currentTokens: 320000 });
  check("trim 回「裁不了」、不是 noSession/busy", tr.trimmed === false && !tr.noSession && !tr.busy && /codex/.test(tr.reason), JSON.stringify(tr));
  check("没停引擎（还是那 1 个插头、app-server 没退）", made === 1 && new Set(rpc().map((c) => c.pid)).size === 1);

  console.log("[3] /new 换舱");
  // 先让盒子有一份旧舱水位，[6] 要用
  const fullBefore = box.fullness();
  check("换舱前盒子有旧舱水位（= last 那次请求 56,112）", fullBefore.used === 56112 && fullBefore.threadId === "real-1", JSON.stringify(fullBefore));
  const r = await box.rotate({ reason: "水位 37%，codex 没有工具链可裁" });
  check("盒子开了换舱单", fs.existsSync(path.join(stateDir, "codex-rotate.json")));
  check("sessions.json 清了", sessLabel() === "");
  const fullAfter = box.fullness();
  check("[6] 换完舱旧舱的水位读数清掉（桥不会拿旧读数再换一次）", !fullAfter.used && !fullAfter.threadId, JSON.stringify(fullAfter));
  const startsBefore = count("thread/start");
  await say("换舱后第一句");
  const disk = threadDisk();
  check("开了一条新 thread（不再 resume 旧的）", count("thread/start") === startsBefore + 1 && disk.threadId !== "real-1" && disk.threadId.startsWith("thr-"), JSON.stringify(disk));
  check("codex-thread.json 记着旧号（回滚用）+ 用过的单", disk.previousThreadId === "real-1" && !!disk.rotatedFor);
  check("换舱流水记了一笔 real-1 → 新号", fs.readFileSync(path.join(stateDir, "codex-rotations.jsonl"), "utf8").includes(`"from":"real-1","to":"${disk.threadId}"`));
  const inj = rpc().filter((c) => c.method === "thread/inject_items");
  check("forge 往新 thread 里 inject 了冷层尾巴", inj.length === 1 && inj[0].params.threadId === disk.threadId
    && JSON.stringify(inj[0].params.items).includes("冷层他#1"), JSON.stringify(inj.map((c) => c.params.items.length)));
  check("换舱单撕掉了", !fs.existsSync(path.join(stateDir, "codex-rotate.json")));
  check("sessions.json 标签 = 新 thread", sessLabel() === disk.threadId, sessLabel());
  await say("换舱后第二句");
  check("第二句接着新 thread 说，没再换", count("thread/start") === startsBefore + 1
    && rpc().filter((c) => c.method === "turn/start").pop().params.threadId === disk.threadId);

  console.log("[4] 同一张单再来不换第二次");
  const token = disk.rotatedFor;
  const again = await host._internals.ensure({ workspaceRoot: ws, threadId: "", model: "gpt-5.6-sol",
    ingressPath: path.join(stateDir, "im-bridge-ingress.json"), sdkOptions: { freshThread: token } });
  check("活着的就是拿这张单起的 → 复用", again.reused === true);
  await host.shutdown();
  host = makeHost(); await host.listen();     // cli 宿主重启（iris-cli restart）
  const startsMid = count("thread/start");
  await host._internals.ensure({ workspaceRoot: ws, threadId: "", model: "gpt-5.6-sol",
    ingressPath: path.join(stateDir, "im-bridge-ingress.json"), sdkOptions: { freshThread: token } });
  check("新宿主收到同一张单（client 重连重发 lastEnsure）：只续，不再开", count("thread/start") === startsMid
    && threadDisk().threadId === disk.threadId, JSON.stringify(threadDisk()));

  console.log("[5] 没有换舱单、sessions.json 也没号（群隔离 / 首次）→ 不动他的主线程");
  await host.shutdown();
  host = makeHost(); await host.listen();
  await host._internals.ensure({ workspaceRoot: ws, threadId: "", model: "gpt-5.6-sol",
    ingressPath: path.join(stateDir, "im-bridge-ingress.json"), sdkOptions: {} });
  check("照旧续 codex-thread.json 那条", count("thread/start") === startsMid && threadDisk().threadId === disk.threadId);

  try { await rt.close(); } catch {}
  await host.shutdown();
  console.log(`\ncodex 桥换舱：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
