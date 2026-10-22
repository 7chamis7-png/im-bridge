"use strict";
// 暖尾巴排除名单（2026-10-22 Alice：「暖尾巴可选」）
//   [1] forge 的料（selectTail）：排除的轮不进、没排除的照旧；冷层文件一个字节不变
//   [2] claude 那条路：forgeOpening 合成的新舱里没有排除的轮
//   [3] 料源 = 全本时（记录 id 跟冷层不同）按 正文 + 角色 + 时间 认出来
//   [4] codex 那条路端到端：真盒子 ⇄ 真 cli 宿主 + 真 codex 插头 ⇄ 假 app-server，/new 之后 inject 的尾巴里没有排除的轮，名单用完清空、记一笔
const fs = require("fs"); const os = require("os"); const path = require("path"); const crypto = require("crypto");

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { if (ok) { pass++; console.log("  OK   " + n); } else { fail++; console.log("  FAIL " + n + "  " + extra); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 4000) => { const t = Date.now() + ms; while (Date.now() < t) { if (fn()) return true; await sleep(20); } return false; };

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tail-exclude-"));
const ws = path.join(root, "ws"); fs.mkdirSync(ws);
const stateDir = path.join(root, "state"); fs.mkdirSync(stateDir);
const bin = path.join(root, "bin"); fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\necho '2.1.292 (Claude Code)'\n", { mode: 0o755 });
fs.writeFileSync(path.join(root, "forge-state.json"), JSON.stringify({ validatedVersion: "2.1.292" }));
fs.writeFileSync(path.join(root, "tools.json"), JSON.stringify({ forge: true }));
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const cold = [];
for (let k = 1; k <= 3; k++) {
  const t = now - (40 - k * 10) * 60_000;
  cold.push({ id: `c${k}-user`, role: "user", at: iso(t), text: `她第${k}轮` });
  cold.push({ id: `c${k}-asst`, role: "assistant", at: iso(t + 20_000), text: `他第${k}轮` });
}
const coldFile = path.join(root, "cold.jsonl");
fs.writeFileSync(coldFile, cold.map((r) => JSON.stringify(r)).join("\n") + "\n");
const coldSha = () => crypto.createHash("sha256").update(fs.readFileSync(coldFile)).digest("hex");
const coldBefore = coldSha();
const coldStat = fs.statSync(coldFile);

const rpcFile = path.join(root, "rpc.jsonl");
const threadFile = path.join(stateDir, "codex-thread.json");
fs.writeFileSync(threadFile, JSON.stringify({ schema: "nova.codex-thread.v1", threadId: "real-1" }));
const auth = path.join(root, "auth.json");
fs.writeFileSync(auth, JSON.stringify({ auth_mode: "chatgpt", tokens: {} }));
Object.assign(process.env, { HOME: root, PATH: `${bin}:${process.env.PATH}`, GATE_ROOT: root, GATE_ENGINE: "codex", GATE_MODEL: "gpt-5.6-sol",
  FORGE_STATE_FILE: path.join(root, "forge-state.json"), FORGE_PREPARED_FILE: path.join(root, "forge-prepared.json"),
  NOVA_STATE_DIR: path.join(root, "nova-state"), NOVA_OUTBOX_DB: path.join(root, "no-old-outbox.db"),
  FAKE_CODEX_LOG: rpcFile, FAKE_CODEX_KNOWN: "real-1", NOVA_CLI_SOCKET: path.join(root, "cli.sock"),
  GATE_COLD_FILE: coldFile, OUTWARD_TZ: "Asia/Shanghai", OUTWARD_LOCALE: "zh-CN" });
delete process.env.GATE_HISTORY; delete process.env.FORGE_ENABLED; delete process.env.FORGE_SOURCE;

const forge = require("../../scripts/forge");
const tx = require("../../src/box/tail-exclude");
const exFile = tx.tailExcludeFile(root);
const texts = (tail) => tail.map((t) => t.text.replace(/^\[[^\]]*\]\s+/, ""));
const turn2 = cold.filter((r) => r.id.startsWith("c2-")).map(tx.entryOf);

(async () => {
  console.log("[1] selectTail：排除的轮不进、没排除的照旧");
  const args = { conversationSourceFile: coldFile, workspaceRoot: ws, withBody: false, oldOutboxDb: false, log: () => {} };
  const all = forge.selectTail(args).tail;
  check("没名单：三轮六条全在", texts(all).join(",") === "她第1轮,他第1轮,她第2轮,他第2轮,她第3轮,他第3轮", texts(all).join(","));
  tx.writeTailExclude(exFile, turn2);
  check("名单文件 0600", (fs.statSync(exFile).mode & 0o777) === 0o600);
  const cut = forge.selectTail(args).tail;
  check("排掉第 2 轮（她那句 + 他的回答）", texts(cut).join(",") === "她第1轮,他第1轮,她第3轮,他第3轮", texts(cut).join(","));
  check("exclude:false（面板列候选）不排", forge.selectTail({ ...args, exclude: false }).tail.length === 6);
  check("尾巴条目带着冷层 id（面板认轮用）", cut[0].sourceId === "c1-user" && cut[0].rawText === "她第1轮");
  check("冷层文件一个字节没变", coldSha() === coldBefore && fs.statSync(coldFile).mtimeMs === coldStat.mtimeMs);

  console.log("\n[2] claude：forgeOpening 合成的新舱里没有排掉的轮");
  const r = forge.forgeOpening({ baseText: "底子", conversationSourceFile: coldFile, workspace: ws, model: "claude-fable-5", notify: null, force: true });
  check("合成成功", r.ok, JSON.stringify(r));
  const synth = r.ok ? fs.readFileSync(r.jsonlPath, "utf8") : "";
  check("新舱里有第 1、3 轮", synth.includes("她第1轮") && synth.includes("他第3轮"));
  check("新舱里没有第 2 轮", !synth.includes("她第2轮") && !synth.includes("他第2轮"));
  check("名单还在（合成成功之后由盒子 consume，不在 selectTail 里清）", tx.readTailExclude(exFile).entries.length === 2);

  console.log("\n[3] 料源 = 全本（id 不同）：按正文 + 角色 + 时间认");
  const hist = path.join(root, "hist-like.jsonl");
  fs.writeFileSync(hist, cold.map((x) => JSON.stringify({ ...x, id: "h-" + x.id, at: iso(Date.parse(x.at) + 1500) })).join("\n") + "\n");
  const h = forge.buildTailFromCold({ conversationSourceFile: hist, workspaceRoot: ws, withBody: false, oldOutboxDb: false });
  check("全本口径的记录也排掉了第 2 轮", texts(h).join(",") === "她第1轮,他第1轮,她第3轮,他第3轮", texts(h).join(","));
  const far = path.join(root, "far.jsonl");
  fs.writeFileSync(far, cold.map((x) => JSON.stringify({ ...x, id: "f-" + x.id, at: iso(Date.parse(x.at) - 3600_000) })).join("\n") + "\n");
  const f2 = forge.buildTailFromCold({ conversationSourceFile: far, workspaceRoot: ws, withBody: false, oldOutboxDb: false });
  check("同样的话、隔了一小时说的不误伤", f2.length === 6, String(f2.length));

  console.log("\n[4] codex 端到端：/new 之后 inject 的尾巴");
  const FAKE = path.join(__dirname, "lib", "fake-codex-appserver.js");
  fs.chmodSync(FAKE, 0o755);
  const sessionsFile = path.join(stateDir, "sessions.json");
  const BK = "telegram:1:1";
  fs.writeFileSync(sessionsFile, JSON.stringify({ bindings: { [BK]: { activeWorkspaceRoot: ws,
    threadIdByWorkspaceRootByRuntime: { claudecode: { [ws]: "real-1" } },
    runtimeParamsByWorkspaceRootByRuntime: { claudecode: { [ws]: { model: "gpt-5.6-sol", modelProvider: "" } } } } } }));
  const { createCliHost } = require("../../cli-host/server");
  const { createCodexRuntime } = require("../../cli-host/codex-runtime");
  const { createImBridgeRuntimeAdapter } = require("../../adapters/box-runtime");
  const { makeClaudeCodeBox } = require("../../src/host/gate-box-claudecode");
  const rpc = () => { try { return fs.readFileSync(rpcFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const count = (m) => rpc().filter((c) => c.method === m).length;
  const host = createCliHost({
    socketPath: process.env.NOVA_CLI_SOCKET, ingressPath: path.join(stateDir, "im-bridge-ingress.json"),
    claudePath: "/usr/bin/true", scope: "codex", engine: "codex",
    fallbackEnsure: () => ({ workspaceRoot: ws, ingressPath: path.join(stateDir, "im-bridge-ingress.json"), sdkOptions: {} }),
    runtimeFactory(cfg) {
      return createCodexRuntime({ ...cfg, cwd: cfg.cwd || ws, threadFile, authFile: auth, codexPath: FAKE, home: root, sdkOptions: cfg.sdkOptions || {} });
    },
  });
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
  await say("第一句");
  await box.rotate({ reason: "测试换舱" });
  await say("换舱后第一句");
  const inj = rpc().filter((c) => c.method === "thread/inject_items");
  const injected = inj.length ? JSON.stringify(inj[inj.length - 1].params.items) : "";
  check("inject 了尾巴", inj.length === 1, String(inj.length));
  check("第 1、3 轮进了新 thread", injected.includes("她第1轮") && injected.includes("他第3轮"));
  check("第 2 轮没进新 thread", !injected.includes("她第2轮") && !injected.includes("他第2轮"), injected.slice(0, 300));
  check("用完名单清空（只对这一次）", tx.readTailExclude(exFile).entries.length === 0);
  const used = tx.readUsedLog(exFile);
  check("记了一笔：谁用的、排了几条", used.length === 1 && used[0].usedBy === "forge/codex" && used[0].count === 2, JSON.stringify(used));
  check("冷层文件还是一个字节没变", coldSha() === coldBefore);
  check("下一次（名单空了）三轮全回来", forge.selectTail(args).tail.length === 6);
  await host.shutdown();
  try { await rt.close(); } catch { /* */ }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
