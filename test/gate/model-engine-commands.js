"use strict";
// S5 命令层（Alice 10-21 改的需求）：
//   /model  只做同一家内换模型（热切 setModel），按钮只列当前引擎下登记的；选别家的拒绝并指 /engine
//   /engine 跨厂商 = 一次正规换舱：先问盒子能不能换（预检）→ 先垫一句「排上了」→ 收尾轮 → 盒子换舱到新引擎 → 回执
//   钱闸、登记表查不到、同一家走错命令 —— 都在收尾轮之前拒
const fs = require("fs"); const os = require("os"); const path = require("path");
const { makeCommands } = require("../../src/gate/commands");
const { registerClaudeCodeCommands, COMMAND_NAMES } = require("../../src/host/gate-commands-claudecode");

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { if (ok) { pass++; console.log("  OK   " + n); } else { fail++; console.log("  FAIL " + n + "  " + extra); } };

const root = fs.mkdtempSync(path.join(os.tmpdir(), "model-engine-cmd-"));
const withReg = path.join(root, "with"); fs.mkdirSync(withReg);
const noReg = path.join(root, "without"); fs.mkdirSync(noReg);
fs.writeFileSync(path.join(withReg, "models.json"), JSON.stringify({ v: 1, default: "claude-fable-5[1m]", models: [
  { id: "claude-fable-5[1m]", label: "Fable 5", engine: "claude-cli", window: 1000000, billing: "subscription", vision: true, tools: true },
  { id: "claude-opus-5-5[1m]", label: "Opus 5.5", engine: "claude-cli", window: 1000000, billing: "subscription", vision: true, tools: true },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", engine: "codex-appserver", window: 872000, verified: true, billing: "subscription", vision: true, tools: true },
  { id: "deepseek-chat", label: "DeepSeek", engine: "openai-chat", window: 128000, billing: "api", requiresAllow: "DEEPSEEK_ALLOW_BILLING", secret: "deepseek" },
] }));
delete process.env.DEEPSEEK_ALLOW_BILLING;
delete process.env.GATE_MODELS_FILE;

function rig({ gateRoot = withReg, rotateImpl = null, dryRunImpl = null, describe = { model: "claude-fable-5[1m]", engine: "claude-cli" } } = {}) {
  const log = { setModel: [], rotate: [], closing: 0, cancel: 0, said: [] };
  const box = {
    fullness: () => ({ model: "claude-fable-5", threadId: "th-1" }),
    async rotate(opts) {
      log.rotate.push(opts);
      if (opts.engine && opts.engine.dryRun) { if (dryRunImpl) return dryRunImpl(opts); return { dryRun: true }; }
      if (rotateImpl) return rotateImpl(opts);
      return { threadId: "thr-new", engineSwitch: { from: { model: "claude-fable-5[1m]", engine: "claude-cli" }, model: opts.engine.model,
        label: "GPT-5.6 Sol", engine: "codex-appserver", window: 872000, verified: true, threadId: "thr-new-123456", turns: 12, records: 30,
        droppedTurns: 0, source: "history", base: true, degraded: ["思考块 / 加密 reasoning 带不过去（只认同一家）"], fullRecompute: true } };
    },
  };
  const commands = makeCommands({ box, beforeRotate: async () => { log.closing += 1; return { state: "completed" }; } });
  const runtime = {
    describe: () => describe,
    setModelForWorkspace: async ({ model }) => { log.setModel.push(model); return { model, applied: "live" }; },
    cancelTurn: async () => { log.cancel += 1; },
  };
  registerClaudeCodeCommands(commands, { runtime, box, workspaceRoot: "/tmp/ws", gateRoot, threadId: () => "th-1" });
  const run = (text) => { const m = commands.match(text); return commands.run(m, { say: async (t) => { log.said.push(t); } }); };
  return { commands, run, log };
}

(async () => {
  console.log("[0] 命令名集中在一处，/help 跟注册表同一份");
  {
    const { commands, run } = rig();
    check("COMMAND_NAMES 有 model / engine / usage", COMMAND_NAMES.model === "model" && COMMAND_NAMES.engine === "engine" && COMMAND_NAMES.usage === "usage");
    const help = await run("/help");
    check("/help 列出 /model 和 /engine", /\/model/.test(help.text) && /\/engine/.test(help.text), help.text);
    check("注册表里有 engine", commands.names().includes("engine"));
  }

  console.log("[1] 没有登记表：/model /engine 都换不了，明说");
  {
    const { run, log } = rig({ gateRoot: noReg });
    const a = await run("/model");
    check("/model 看：说没有登记表、没有按钮", /没有模型登记表/.test(a.text) && !(a.buttons || []).length, a.text);
    const b = await run("/model claude-opus-5-5[1m]");
    check("/model 换：拒，没调 setModel", b.ok === false && /没有模型登记表/.test(b.text) && log.setModel.length === 0, b.text);
    const c = await run("/engine gpt-5.6-sol");
    check("/engine：拒，没收尾、没换舱", c.ok === false && log.closing === 0 && log.rotate.length === 0, c.text);
  }

  console.log("[2] /model：同一家热切，按钮只列当前引擎");
  {
    const { run, log } = rig();
    const a = await run("/model");
    const ids = (a.buttons || []).map((b) => b.callback_data);
    check("按钮 = 当前引擎（claude）下的两条", ids.length === 2 && ids.every((d) => /^\/model claude-/.test(d)), JSON.stringify(ids));
    check("当前那个打勾", (a.buttons || []).some((b) => b.text.startsWith("✓ ") && b.callback_data === "/model claude-fable-5[1m]"));
    check("提示换别家用 /engine", /\/engine/.test(a.text));
    const b = await run("/model gpt-5.6-sol");
    check("选别家 → 拒，指 /engine gpt-5.6-sol", b.ok === false && /\/engine gpt-5\.6-sol/.test(b.text) && log.setModel.length === 0, b.text);
    const c = await run("/model claude-opus-9");
    check("登记表里没有 → 拒", c.ok === false && /登记表里没有/.test(c.text));
    const d = await run("/model claude-opus-5-5[1m]");
    check("同一家 → setModel（热切）", d.ok !== false && log.setModel[0] === "claude-opus-5-5[1m]" && /下一轮生效/.test(d.text), d.text);
    check("/model 从不换舱", log.rotate.length === 0 && log.closing === 0);
  }

  console.log("[3] /engine 看：按钮列别家的，按量计费标出来");
  {
    const { run } = rig();
    const a = await run("/engine");
    const ids = (a.buttons || []).map((b) => b.callback_data);
    check("按钮 = 别家的两条（codex、DeepSeek）", ids.length === 2 && ids.includes("/engine gpt-5.6-sol") && ids.includes("/engine deepseek-chat"), JSON.stringify(ids));
    check("DeepSeek 标了 💰未开", (a.buttons || []).some((b) => /DeepSeek 💰未开/.test(b.text)));
  }

  console.log("[4] /engine 拒的几种：都在收尾轮之前");
  {
    const { run, log } = rig();
    const a = await run("/engine deepseek-chat");
    check("按量计费没开 → 拒（钱闸）", a.ok === false && /DEEPSEEK_ALLOW_BILLING/.test(a.text), a.text);
    const b = await run("/engine claude-opus-5-5[1m]");
    check("同一家 → 拒，指 /model", b.ok === false && /\/model claude-opus-5-5\[1m\]/.test(b.text), b.text);
    const c = await run("/engine nope");
    check("登记表里没有 → 拒", c.ok === false && /登记表里没有/.test(c.text));
    check("一次收尾、一次换舱都没跑", log.closing === 0 && log.rotate.length === 0);
    const pinned = rig({ describe: { model: "gpt-5.6-sol", engine: "codex-appserver", pinned: true } });
    const p = await pinned.run("/engine claude-fable-5[1m]");
    check("GATE_MODEL 钉着 → 拒", p.ok === false && /钉死/.test(p.text), p.text);
  }

  console.log("[5] /engine 盒子预检不过 → 不跑收尾轮");
  {
    const { run, log } = rig({ dryRunImpl: () => { throw new Error("卡在「算窗口」：装不下"); } });
    const a = await run("/engine gpt-5.6-sol");
    check("拒，原因照搬盒子的「卡在哪」", a.ok === false && /卡在「算窗口」/.test(a.text) && /还在原来的/.test(a.text), a.text);
    check("预检问了一次、没收尾、没真换", log.rotate.length === 1 && log.rotate[0].engine.dryRun === true && log.closing === 0);
  }

  console.log("[6] /engine 换：先垫一句 → 收尾 → 换舱 → 回执");
  {
    const { run, log } = rig();
    const a = await run("/engine gpt-5.6-sol");
    check("先垫了一句「排上了…等这一轮说完」", log.said.length === 1 && /排上了[\s\S]*等这一轮说完/.test(log.said[0]), JSON.stringify(log.said));
    check("跟 /new 一样跑了收尾轮", log.closing === 1);
    check("盒子收到真换舱（带 engine.model）", log.rotate.length === 2 && log.rotate[1].engine.model === "gpt-5.6-sol" && !log.rotate[1].engine.dryRun);
    for (const [name, re] of [["新模型", /GPT-5\.6 Sol（gpt-5\.6-sol）/], ["引擎", /Claude（CLI） → codex/], ["窗口", /窗口 872,000/],
      ["垫了几轮", /垫了最近 12 轮（30 条原话，料源 全本）/], ["降级", /降级：思考块/], ["全量重算", /第一轮全量重算/], ["收尾", /收了尾/]]) {
      check(`回执写了${name}`, re.test(a.text), a.text);
    }
    check("没叫停（不带 now）", log.cancel === 0);
  }

  console.log("[7] /engine X now：先叫停再换");
  {
    const { run, log } = rig();
    await run("/engine gpt-5.6-sol now");
    check("cancelTurn 了一次，然后照样收尾 + 换舱", log.cancel === 1 && log.closing === 1 && log.rotate[1].engine.model === "gpt-5.6-sol");
    check("垫的那句说「先叫停」", /先叫停/.test(log.said[0]));
  }

  console.log("[8] 盒子换的时候失败 → 回执说清卡在哪、还在原来的");
  {
    const { run } = rig({ rotateImpl: () => { throw new Error("卡在「起新引擎」：没有钥匙文件；已回到 claude-fable-5[1m]"); } });
    const a = await run("/engine gpt-5.6-sol");
    check("没换成 + 卡在哪 + 已回到", a.ok === false && /没换成[\s\S]*卡在「起新引擎」[\s\S]*已回到/.test(a.text), a.text);
  }

  console.log(`\n/model /engine 命令：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
