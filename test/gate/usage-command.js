"use strict";
// /usage 命令（Alice 10-21）：现在这家引擎的订阅额度 —— 5 小时 / 每周各用了百分之几、什么时候重置；
// 按量计费的（DeepSeek）显示余额（总额 + 币种 + 赠送 / 充值）。查不到就明说查不到，不编数字。
//   [1] 回执格式（只照搬查到的数）
//   [2] 命令表：/usage 跟 /model /engine 在同一张表、/help 里有
//   [3] 端到端：桥命令 → 盒子 → cli.sock → 引擎宿主 → 活着的 codex 插头 → 假 app-server 的 account/rateLimits/read
const fs = require("fs"); const os = require("os"); const path = require("path");

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { if (ok) { pass++; console.log("  OK   " + n); } else { fail++; console.log("  FAIL " + n + "  " + extra); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 4000) => { const t = Date.now() + ms; while (Date.now() < t) { if (fn()) return true; await sleep(20); } return false; };

process.env.OUTWARD_TZ = "Asia/Shanghai"; process.env.OUTWARD_LOCALE = "zh-CN";
const { makeCommands } = require("../../src/gate/commands");
const { registerClaudeCodeCommands, describeUsage } = require("../../src/host/gate-commands-claudecode");

(async () => {
  console.log("[1] 回执格式");
  {
    const sub = describeUsage({ ok: true, engine: "claude-cli", model: "claude-fable-5[1m]", kind: "subscription", windows: [
      { name: "5 小时", usedPercent: 37, resetsAt: "2026-10-21T13:00:00.000Z" },
      { name: "每周", usedPercent: 12.3, resetsAt: "2026-10-24T16:00:00.000Z" }] });
    check("订阅：引擎 + 模型 + 两个窗口的百分比", /Claude（CLI） · claude-fable-5\[1m\]/.test(sub) && /5 小时：用了 37%/.test(sub) && /每周：用了 12\.3%/.test(sub), sub);
    check("重置时间按她的时区（10-25 00:00）", /10-25 00:00 重置/.test(sub), sub);
    const api = describeUsage({ ok: true, engine: "openai-chat", model: "deepseek-chat", kind: "api",
      balances: [{ currency: "CNY", total: "12.34", granted: "2.00", toppedUp: "10.34" }], available: true });
    check("按量计费：说没有订阅额度 + 余额 / 币种 / 赠送 / 充值", /按量计费，没有订阅额度/.test(api) && /余额 12\.34 CNY（赠送 2\.00 · 充值 10\.34）/.test(api), api);
    const none = describeUsage({ ok: false, engine: "codex-appserver", why: "codex 没在跑（额度要问活着的 app-server）" });
    check("查不到：明说 + 原因，没有百分号", /查不到：codex 没在跑/.test(none) && !/%/.test(none), none);
    const noReset = describeUsage({ ok: true, engine: "codex-appserver", kind: "subscription", windows: [{ name: "5 小时", usedPercent: 3, resetsAt: null }] });
    check("没给重置时间就说没给，不编", /重置时间没给/.test(noReset), noReset);
  }

  console.log("[2] 命令表");
  {
    const commands = makeCommands({ box: { rotate: async () => ({}) } });
    let asked = 0;
    const runtime = { describe: () => ({ model: "claude-fable-5[1m]", engine: "claude-cli" }),
      usage: async () => { asked += 1; return { ok: true, engine: "claude-cli", model: "claude-fable-5[1m]", kind: "subscription",
        windows: [{ name: "5 小时", usedPercent: 1, resetsAt: null }] }; } };
    registerClaudeCodeCommands(commands, { runtime, box: { fullness: () => ({}) }, workspaceRoot: "/tmp/ws", gateRoot: os.tmpdir() });
    const help = await commands.run({ name: "help" });
    check("/help 里有 /usage（菜单就是注册表）", /\/usage/.test(help.text) && commands.names().includes("usage"));
    const r = await commands.run(commands.match("/usage"));
    check("/usage 问了一次运行时、照搬回执", asked === 1 && /5 小时：用了 1%/.test(r.text), r.text);
    const broken = makeCommands({ box: null });
    registerClaudeCodeCommands(broken, { runtime: { describe: () => ({}), usage: async () => { throw new Error("盒子没回 usage"); } },
      workspaceRoot: "/tmp/ws", gateRoot: os.tmpdir() });
    const b = await broken.run(broken.match("/usage"));
    check("盒子不回 → 查不到 + 原因", /查不到：盒子没回 usage/.test(b.text), b.text);
  }

  console.log("[3] 端到端：盒子 → 引擎宿主 → 活着的 codex");
  {
    const FAKE = path.join(__dirname, "lib", "fake-codex-appserver.js");
    fs.chmodSync(FAKE, 0o755);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-e2e-"));
    const ws = path.join(root, "ws"); fs.mkdirSync(ws);
    const stateDir = path.join(root, "state"); fs.mkdirSync(stateDir);
    const auth = path.join(root, "auth.json"); fs.writeFileSync(auth, JSON.stringify({ auth_mode: "chatgpt" }));
    Object.assign(process.env, { GATE_ROOT: root, GATE_ENGINE: "codex", GATE_MODEL: "gpt-5.6-sol", NOVA_CLI_SOCKET: path.join(root, "cli.sock"),
      FAKE_CODEX_LOG: path.join(root, "rpc.jsonl"), GATE_COLD_FILE: path.join(root, "cold.jsonl") });
    delete process.env.GATE_HISTORY; delete process.env.FORGE_ENABLED; delete process.env.GATE_MODELS_FILE;
    globalThis.fetch = async () => ({ ok: true });
    const { createCliHost } = require("../../cli-host/server");
    const { createCodexRuntime } = require("../../cli-host/codex-runtime");
    const { createImBridgeRuntimeAdapter } = require("../../adapters/box-runtime");
    const host = createCliHost({ socketPath: process.env.NOVA_CLI_SOCKET, ingressPath: path.join(stateDir, "im-bridge-ingress.json"),
      claudePath: "/usr/bin/true", scope: "codex", engine: "codex",
      runtimeFactory: (cfg) => createCodexRuntime({ ...cfg, cwd: cfg.cwd || ws, threadFile: path.join(stateDir, "codex-thread.json"),
        authFile: auth, codexPath: FAKE, home: root, sdkOptions: cfg.sdkOptions || {} }) });
    await host.listen();
    const rt = createImBridgeRuntimeAdapter({ sessionsFile: path.join(stateDir, "sessions.json"), stateDir,
      claudeModel: "gpt-5.6-sol", claudeCommand: "/usr/bin/true" });
    await rt.initialize();
    await waitFor(() => false, 200);
    const before = await rt.usage();
    check("codex 还没起 → 查不到（不为查额度起一个 app-server）", before.ok === false && /没在跑/.test(before.why || ""), JSON.stringify(before));
    await rt.sendTurn({ bindingKey: "k", workspaceRoot: ws, text: "在吗", metadata: {} });
    await waitFor(() => { try { return fs.readFileSync(path.join(root, "rpc.jsonl"), "utf8").includes("turn/start"); } catch { return false; } });
    const u = await rt.usage();
    check("起着 → 5 小时 42% / 每周 7.5%，模型名带上", u.ok === true && u.engine === "codex-appserver" && u.model === "gpt-5.6-sol"
      && u.windows[0].usedPercent === 42 && u.windows[1].usedPercent === 7.5, JSON.stringify(u));
    const text = describeUsage(u);
    check("回执能直接给她看", /codex · gpt-5\.6-sol/.test(text) && /5 小时：用了 42%/.test(text) && /档位：pro/.test(text), text);
    try { await rt.close(); } catch {}
    await host.shutdown();
  }

  console.log(`\n/usage：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
