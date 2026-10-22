"use strict";
// 2026-10-22：codex 人格（Iris）/new 换舱也带「底子」，跟 claude（Nova）同一份（Alice：「Iris的 forge 肯定要跟Nova一样」）。
//   真盒子（adapters/box-runtime.js）⇄ cli.sock ⇄ 真 cli 宿主 + 真插头表（cli-host/engines.js，跟 codex-main.js 同装法）⇄ 假 app-server
// 盯住：
//   [1] /new 后新 thread 的第一条 inject = 底子（buildForgeBaseText 同一个函数拼的），各段都在，后面紧跟暖尾巴
//   [2] IB 身份底座已经在开发者指令里 → 底子里不再带第二份；开发者指令里恰好一份
//   [3] 排除名单仍生效（她勾掉的那轮不在尾巴里），用掉后清空
//   [4] 数据隔离：同机另一个角色（Nova）的目录里埋了暗号，HOME 也指过去 —— Iris的底子 / 开发者指令 / 任何 RPC 里都不许出现
//   [5] 续旧 thread / 同一张单再来：不再垫底子
//   [6] forge 关着：不带底子（跟 claude 一样：forge 关 = 没底子）
//   [7] 盒子递给 claude 插头的选项里剥掉 forgeBase（BRIDGE_ONLY_KEYS）
const fs = require("fs"); const os = require("os"); const path = require("path");

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { if (ok) { pass++; console.log("  OK   " + n); } else { fail++; console.log("  FAIL " + n + "  " + extra); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 4000) => { const t = Date.now() + ms; while (Date.now() < t) { if (fn()) return true; await sleep(20); } return false; };

const FAKE = path.join(__dirname, "lib", "fake-codex-appserver.js");
fs.chmodSync(FAKE, 0o755);
const top = fs.mkdtempSync(path.join(os.tmpdir(), "codex-new-base-"));

// ——— 另一个角色（Nova）：同机，目录里全是暗号；HOME 也指到这儿，任何「回落 ~/…」都会把暗号带出来 ———
const NOVA_MARK = "NOVA-ONLY-7f3a";
const fakeHome = path.join(top, "home"); fs.mkdirSync(fakeHome);
for (const d of [".nova", "nova", ".nova-gate", "identity-brain-v02", "nova-notebook", ".nova/diary", "nova/diary"]) fs.mkdirSync(path.join(fakeHome, d), { recursive: true });
for (const f of [".nova/memory.md", "nova/memory.md", ".nova/operations.md", "nova/operations.md", ".nova/body-state.txt",
  "identity-brain-v02/injection.txt", ".nova-gate/cold.jsonl"]) fs.writeFileSync(path.join(fakeHome, f), `${NOVA_MARK} ${f}\n`);
fs.writeFileSync(path.join(fakeHome, "nova-notebook", "store.js"), `exports.render = () => "${NOVA_MARK} notebook";`);

// ——— Iris自己的目录 ———
const root = path.join(top, "iris-gate"); fs.mkdirSync(root);
const mem = path.join(top, "iris"); fs.mkdirSync(path.join(mem, "diary"), { recursive: true });
const ws = mem;
const stateDir = path.join(root, "state"); fs.mkdirSync(stateDir);
const codexHome = path.join(top, "codex-home"); fs.mkdirSync(codexHome);
fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: {} }));
fs.writeFileSync(path.join(mem, "memory.md"), "HZ-MEMORY 他记着的事");
fs.writeFileSync(path.join(mem, "operations.md"), "HZ-OPS 执行规则");
fs.writeFileSync(path.join(mem, "body-state.txt"), "HZ-BODY");
const { INTERNAL_TZ } = require("../../src/core/outward-tz");
const today = new Intl.DateTimeFormat("en-CA", { timeZone: INTERNAL_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
fs.writeFileSync(path.join(mem, "diary", `${today}.md`), "HZ-DIARY 今天的日记");
const ibFile = path.join(top, "iris-identity.txt");
fs.writeFileSync(ibFile, "HZ-IB 我是Iris的身份底座");
const nbDir = path.join(top, "nb"); fs.mkdirSync(nbDir);
fs.writeFileSync(path.join(nbDir, "store.js"), 'exports.render = ({ file } = {}) => file ? "HZ-NOTEBOOK " + require("path").basename(file) : "DEFAULT-LEAK";');
const toolsJson = path.join(root, "tools.json");
fs.writeFileSync(toolsJson, JSON.stringify({ forge: true }));
const now = Date.now();
const cold = [
  { id: "c1-user", role: "user", at: new Date(now - 600000).toISOString(), text: "冷层她#1" },
  { id: "c1-asst", role: "assistant", at: new Date(now - 599000).toISOString(), text: "冷层他#1" },
  { id: "c2-user", role: "user", at: new Date(now - 500000).toISOString(), text: "勾掉的那句" },
  { id: "c2-asst", role: "assistant", at: new Date(now - 499000).toISOString(), text: "冷层他#2" },
];
fs.writeFileSync(path.join(root, "cold.jsonl"), cold.map((r) => JSON.stringify(r)).join("\n") + "\n");
fs.writeFileSync(path.join(root, "tail-exclude.json"), JSON.stringify({ schema: "im-bridge.tail-exclude.v1", updatedAt: new Date().toISOString(),
  entries: [{ id: "c2-user", role: "user", at: cold[2].at }] }));
const threadFile = path.join(stateDir, "codex-thread.json");
fs.writeFileSync(threadFile, JSON.stringify({ schema: "nova.codex-thread.v1", threadId: "real-1" }));
const sessionsFile = path.join(stateDir, "sessions.json");
const BK = "telegram:1:1";
fs.writeFileSync(sessionsFile, JSON.stringify({ bindings: { [BK]: { activeWorkspaceRoot: ws,
  threadIdByWorkspaceRootByRuntime: { claudecode: { [ws]: "real-1" } },
  runtimeParamsByWorkspaceRootByRuntime: { claudecode: { [ws]: { model: "gpt-5.6-sol", modelProvider: "" } } } } } }));
const rpcFile = path.join(top, "rpc.jsonl");

for (const k of Object.keys(process.env)) if (/^(NOVA_|GATE_|CODEX_|FORGE_|CYBERBOSS_)/.test(k)) delete process.env[k];
Object.assign(process.env, { HOME: fakeHome, GATE_ROOT: root, GATE_ENGINE: "codex", GATE_MODEL: "gpt-5.6-sol",
  FAKE_CODEX_LOG: rpcFile, FAKE_CODEX_KNOWN: "real-1", NOVA_CLI_SOCKET: path.join(root, "cli.sock"),
  GATE_COLD_FILE: path.join(root, "cold.jsonl"), CODEX_HOME: codexHome, CODEX_COMMAND: FAKE, NOVA_STATE_DIR: path.join(top, "hz-state"),
  OUTWARD_TZ: "Asia/Shanghai", OUTWARD_LOCALE: "zh-CN" });

const { createCliHost } = require("../../cli-host/server");
const { createEngineFactories, stripBridgeKeys } = require("../../cli-host/engines");
const { createImBridgeRuntimeAdapter } = require("../../adapters/box-runtime");
const { forgeBaseConfig } = require("../../src/host/box-build");
const { buildForgeBaseText, omitForgeBaseSection } = require("../../src/box/instructions");

const rpc = () => { try { return fs.readFileSync(rpcFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const count = (m) => rpc().filter((c) => c.method === m).length;
const itemText = (it) => (it.content || []).map((b) => b.text || "").join("");

function makeHost() {
  // 跟 cli-host/codex-main.js 同一个装法（插头表 + IB 身份底座接进开发者指令）
  return createCliHost({
    socketPath: process.env.NOVA_CLI_SOCKET, ingressPath: path.join(stateDir, "im-bridge-ingress.json"),
    claudePath: "/usr/bin/true", scope: "codex", engine: "codex",
    fallbackEnsure: () => ({ workspaceRoot: ws, ingressPath: path.join(stateDir, "im-bridge-ingress.json"), sdkOptions: {} }),
    engines: createEngineFactories({ env: process.env, stateDir, workspace: ws, identityInjectionFile: ibFile }),
  });
}

(async () => {
  let host = makeHost();
  await host.listen();
  // 盒子的 config 跟生产同一份口径（box-build forgeBaseConfig）
  const cfg = { root, coldFile: path.join(root, "cold.jsonl"), workspaceRoot: ws, memoryDir: mem, identityInjectionFile: ibFile,
    notebookModule: path.join(nbDir, "store"), notebookFile: path.join(top, "hz-notebook.json") };
  const config = { sessionsFile, stateDir, claudeModel: "gpt-5.6-sol", claudeCommand: "/usr/bin/true", ...forgeBaseConfig(cfg) };
  const rt = createImBridgeRuntimeAdapter(config);
  await rt.initialize();
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

  await say("换舱前一句");
  check("换舱前续旧 thread，没 inject 任何东西", count("thread/inject_items") === 0 && count("thread/start") === 0);

  console.log("[1] /new → 新 thread 第一条 = 底子，后面紧跟暖尾巴");
  const r = await rt.startFreshSharedSession({ workspaceRoot: ws, reason: "测试 /new" });
  check("换舱回执点名底子（describeForgeBase）", r.base && r.base.sections.some((s) => s.name === "LONG-TERM MEMORY"), JSON.stringify(r.base));
  await say("换舱后第一句");
  const inj = rpc().filter((c) => c.method === "thread/inject_items");
  check("inject 了一次", inj.length === 1, String(inj.length));
  const items = inj.length ? inj[0].params.items : [];
  const first = items[0] ? itemText(items[0]) : "";
  const expected = omitForgeBaseSection(buildForgeBaseText(config), "身份底座");
  check("第一条是 user、正文 = buildForgeBaseText 拼的那份（去掉开发者指令里已有的 IB）", items[0] && items[0].role === "user" && first === expected,
    first.slice(0, 200));
  for (const [sec, mark] of [["WECHAT SESSION INSTRUCTIONS", "HZ-OPS"], ["## LONG-TERM MEMORY", "HZ-MEMORY"], ["## PENDING PROMISES", "HZ-NOTEBOOK hz-notebook.json"],
    ["## RECENT DIARY", "HZ-DIARY"], ["## BODY STATE", "HZ-BODY"]]) {
    check(`底子里有 ${sec}（${mark}）`, first.includes(sec) && first.includes(mark));
  }
  check("底子以收尾那句结束（下面紧接真实对话）", /以上是你的底座与场景/.test(first.split("\n").pop()));
  const rest = items.slice(1).map(itemText).join("|");
  check("底子后面是暖尾巴（冷层原话）", /冷层她#1[\s\S]*冷层他#1[\s\S]*冷层他#2/.test(rest), rest);
  check("底子只有一份（尾巴里没第二份）", !items.slice(1).some((it) => /LONG-TERM MEMORY/.test(itemText(it))));

  console.log("[2] IB 身份底座：开发者指令里恰好一份，底子里不再带");
  const starts = rpc().filter((c) => c.method === "thread/start");
  const dev = starts.length ? String(starts[starts.length - 1].params.developerInstructions || "") : "";
  check("开发者指令里有 IB，且只一份", dev.split("HZ-IB").length === 2, dev);
  check("底子里没有身份底座段", !first.includes("身份底座") && !first.includes("HZ-IB"));

  console.log("[3] 排除名单");
  check("勾掉的那句没进尾巴", !rest.includes("勾掉的那句"));
  const ex = JSON.parse(fs.readFileSync(path.join(root, "tail-exclude.json"), "utf8"));
  check("名单用掉后清空", !ex.entries || ex.entries.length === 0, JSON.stringify(ex));

  console.log("[4] 数据隔离：另一个角色的东西一个字都不出现");
  const all = fs.readFileSync(rpcFile, "utf8");
  check("所有 RPC（开发者指令 / inject / 每一轮）里没有Nova目录的暗号", !all.includes(NOVA_MARK));
  check("盒子拼的底子里也没有", !buildForgeBaseText(config).includes(NOVA_MARK));
  check("笔记本读的是她自己的文件（不是模块默认文件）", !all.includes("DEFAULT-LEAK"));

  console.log("[5] 续 / 同一张单再来：不再垫");
  const injBefore = count("thread/inject_items");
  await say("换舱后第二句");
  const disk = JSON.parse(fs.readFileSync(threadFile, "utf8"));
  await host.shutdown();
  host = makeHost(); await host.listen();
  await host._internals.ensure({ workspaceRoot: ws, threadId: "", model: "gpt-5.6-sol",
    ingressPath: path.join(stateDir, "im-bridge-ingress.json"), sdkOptions: { freshThread: disk.rotatedFor, forgeBase: "SHOULD-NOT-APPEAR" } });
  check("续旧 thread 不再 inject 底子", count("thread/inject_items") === injBefore && !fs.readFileSync(rpcFile, "utf8").includes("SHOULD-NOT-APPEAR"));

  console.log("[6] forge 关着：/new 不带底子");
  try { await rt.close(); } catch {}
  await host.shutdown();
  fs.writeFileSync(toolsJson, JSON.stringify({ forge: false }));
  host = makeHost(); await host.listen();
  const rt2 = createImBridgeRuntimeAdapter(config);
  await rt2.initialize();
  await rt2.startFreshSharedSession({ workspaceRoot: ws, reason: "forge 关" });
  const injMid = count("thread/inject_items");
  const startMid = count("thread/start");
  const before = count("turn/start");
  await rt2.sendTurn({ bindingKey: BK, workspaceRoot: ws, text: "关着 forge 说一句", metadata: {} });
  await waitFor(() => count("turn/start") > before);
  check("开了新 thread", count("thread/start") === startMid + 1);
  check("没 inject", count("thread/inject_items") === injMid);
  const lastTurn = rpc().filter((c) => c.method === "turn/start").pop();
  check("第一轮正文里没有底子（forge 关 = 跟 claude 一样不带）", !JSON.stringify(lastTurn.params).includes("LONG-TERM MEMORY"));

  console.log("[7] claude 插头拿不到 forgeBase");
  check("stripBridgeKeys 剥掉 forgeBase", !("forgeBase" in stripBridgeKeys({ forgeBase: "x", model: "m" })));

  try { await rt2.close(); } catch {}
  await host.shutdown();
  console.log(`\ncodex /new 带底子：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
