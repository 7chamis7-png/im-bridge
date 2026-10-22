"use strict";

/**
 * 面板测试 / 截图用的假数据：临时目录里造两个角色（alpha / beta），全是编的，**不碰真实数据**。
 * beta 的 env 里笔记本文件故意指进 alpha 的目录（模拟 10-22 那次「B 的笔记本混进 A 的底子」）。
 *
 *   const fx = makeFixture();  fx.env  → 喂给 createServer 的 env
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

function makeFixture({ now = Date.now(), crossLeak = true, missingRole = true, betaNoNotebook = false, names = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "panel-fx-"));
  const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); return p; };
  const iso = (ms) => new Date(ms).toISOString();
  const H = 3600_000;

  // 共用的「笔记本代码模块」（模拟外部笔记本模块的 store.js：给什么文件读什么文件）
  const store = w(path.join(home, "notebook-code", "store.js"),
    'const fs=require("fs");exports.render=({file}={})=>{try{const j=JSON.parse(fs.readFileSync(file,"utf8"));return j.items.map((x)=>"- "+x).join("\\n")}catch{return ""}};');

  const roles = {
    alpha: { name: names.alpha || "晨星", model: "claude-fable-5[1m]", used: 284000, limit: 1000000 },
    beta: { name: names.beta || "暮雨", model: "gpt-5.6-sol", used: 91000, limit: 872000 },
  };
  const pm2 = [];
  const envFiles = {};
  for (const [id, r] of Object.entries(roles)) {
    const gate = path.join(home, `.${id}-gate`);
    const state = path.join(home, `.${id}`);
    const ws = path.join(home, id);
    const ident = path.join(home, `${id}-identity`, "injection.txt");
    // 底子的料（假的）
    w(path.join(state, "operations.md"), `## 执行规则\n${r.name}的假执行规则：先回答再干活。\n`);
    w(path.join(state, "channels", "telegram.md"), `### Telegram\n${r.name}在 Telegram 上的假规矩。\n`);
    w(path.join(state, "memory.md"), `# 长期记忆\n\n${r.name}的假长期记忆：喜欢下雨天。\n`);
    w(path.join(state, "body-state.txt"), `${r.name}的假身体状态：平静`);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
    w(path.join(state, "diary", `${today}.md`), `${r.name}今天的假日记：看了一场雪。`);
    if (id === "beta") {   // beta 的日记按年分目录摆（diary/YYYY/YYYY-MM-DD.md），底子两种摆法都认
      const yesterday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now - 86400_000));
      w(path.join(state, "diary", yesterday.slice(0, 4), `${yesterday}.md`), `${r.name}昨天的假日记（按年放的）：去海边。`);
    }
    w(path.join(state, "notebook.json"), JSON.stringify({ items: [`${r.name}的假待办：记得买花`] }));
    w(ident, `${r.name}的假身份底座：我是${r.name}。`);
    // 桥的状态（假的）
    w(path.join(gate, "state", "sessions.json"), JSON.stringify({ bindings: { [`bind-${id}`]: {
      activeWorkspaceRoot: ws, runtimeParamsByWorkspaceRootByRuntime: { claudecode: { [ws]: { model: r.model } } } } } }));
    w(path.join(gate, "heartbeat.json"), JSON.stringify({ at: iso(now - 20_000), fullness: { used: r.used, limit: r.limit, ratio: r.used / r.limit, model: r.model, threadId: "t-" + id } }));
    const ingress = id === "alpha"
      ? [{ uuid: "a1", state: "completed", payload: { origin: { channel: "telegram", turnId: `turn-${now - 5 * H}-1` } }, error: null },
        { uuid: "a2", state: "uncertain", payload: { origin: { channel: "wechat", turnId: `turn-${now - 3 * H}-2` } }, error: "假错误：可能已提交，需人工对账。" },
        { uuid: "a3", state: "pending", payload: { origin: { channel: "telegram", turnId: `turn-${now - 600_000}-3` } }, error: null }]
      : [{ uuid: "b1", state: "completed", payload: { origin: { channel: "telegram", turnId: `turn-${now - H}-1` } }, error: null }];
    w(path.join(gate, "state", "im-bridge-ingress.json"), JSON.stringify({ version: 1, records: ingress }));
    const ev = [
      { kind: "user_input", at: iso(now - 70 * 60_000), text: "假的入站正文" },
      { kind: "outbound.confirmed", at: iso(now - 65 * 60_000) },
      { kind: "outbound.unknown", at: iso(now - 30 * H), channel: "telegram", error: "假的：超出 24 小时窗口" },
    ];
    if (id === "alpha") {
      ev.push({ kind: "turn.failed", at: iso(now - 2 * H), channel: "telegram", turnId: "turn-x", error: "假错误：API 超时" });
      ev.push({ kind: "outbound.blocked", at: iso(now - 4 * H), channel: "wechat", reason: "假原因：白名单" });
    }
    ev.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    w(path.join(gate, "events.jsonl"), ev.map((e) => JSON.stringify(e)).join("\n") + "\n");
    w(path.join(gate, "model-fallback-alert.json"), JSON.stringify({ schema: "im-bridge.model-fallback-alert.v1",
      modelStatus: id === "alpha" ? "fallback" : "normal", lastActual: id === "alpha" ? "claude-opus-4-8" : "", sessionLimitAlerted: false, updatedAt: iso(now - 90 * 60_000) }));
    // 卡住的消息（gate/pending.js 读的那几本账）。正文故意写长：页面上只许露前 20 字。
    const LONG = "这是一句很长很长的假正文，后半句绝对不能出现在面板上：秘密尾巴";
    const turn = (tid, state, at, extra = {}) => ({ id: tid, schema_version: 1, state, queuedAt: iso(at), updatedAt: iso(at),
      envelope: { trace_id: tid, payload: { text: LONG }, source: { kind: "user" } }, route: {}, ...extra });
    const turns = id === "alpha"
      ? { "t-ok": turn("t-ok", "completed", now - 9 * H),
        "t-unknown": turn("t-unknown", "unknown", now - 5 * H, { reason: "进程中断；盒子是否完成需要核对，不自动重投" }),
        "t-rej": turn("t-rej", "rejected", now - 2 * H, { reason: "盒子忙，拒收", autoRetry: true, attempts: 2, retryAt: iso(now + 10 * 60_000) }) }
      : { "t-old": turn("t-old", "rejected", now - 26 * H, { reason: "旧账：盒子拒收" }) };
    w(path.join(gate, "turns.json"), JSON.stringify(turns));
    if (id === "alpha") {
      w(path.join(gate, "undelivered.jsonl"), [
        { at: iso(now - 3 * H), state: "unknown", operationId: "op-1", channel: "telegram", text: "他回她的一句很长很长的话，后半句也不能露出来：尾巴", reason: "超时，不知道发没发" },
        { at: iso(now - 8 * H), state: "blocked", operationId: "op-2", channel: "wechat", text: "已经补发过的", reason: "白名单" },
        { at: iso(now - 7 * H), state: "resolved", operationId: "op-2" },
      ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    } else {
      const dead = [
        { at: iso(now - 6 * H), cursor: 101, raw: { text: "死信里的一句很长很长很长很长的假正文，尾巴不许露：秘密" }, error: "媒体下载失败" },
        { at: iso(now - 30 * H), cursor: 77, raw: { text: "已经处理过的死信" }, error: "旧错误" },
      ];
      w(path.join(gate, "dead-telegram.jsonl"), dead.map((e) => JSON.stringify(e)).join("\n") + "\n");
      const key = (e) => "dead:telegram:" + e.cursor + ":" + crypto.createHash("sha1").update(JSON.stringify(e.raw)).digest("hex").slice(0, 12);
      w(path.join(gate, "handled-dead-letters.jsonl"), JSON.stringify({ at: iso(now - 20 * H), key: key(dead[1]), action: "dropped" }) + "\n");
    }
    if (id === "alpha") {
      w(path.join(gate, "state", "injection-loaded.json"), JSON.stringify({ schema: "im-bridge.injection-loaded.v1", at: iso(now - 6 * H),
        threadId: "1e672183-fake", workspace: ws, injection: { file: ident, sha256: "0".repeat(64), bytes: 40, mtime: iso(now - 48 * H) },
        sections: [{ name: "执行规则", chars: 60 }, { name: "身份底座", chars: 20 }, { name: "LONG-TERM MEMORY", chars: 25 }], total: 160 }));
    }
    const errLog = w(path.join(home, "pm2-logs", `${id}-gate-error.log`), "假的旧错误一行\n");
    for (const [suffix, status] of [["gate", "online"], ["box", "online"], ["cli", id === "beta" ? "stopped" : "online"]]) {
      pm2.push({ name: `${id}-${suffix}`, pm2_env: { status, pm_uptime: now - (suffix === "cli" ? 50 : 3) * H, restart_time: 2,
        pm_err_log_path: suffix === "gate" ? errLog : "", SECRET_TOKEN: ["pm2-env", "secret-should-never-render"].join("-") } });
    }
    // 2026-10-22：人格 / 系统提示 / 冷层（整舱预演和暖尾巴勾选要用）。alpha 走 claude，beta 走 codex。
    w(path.join(ws, id === "alpha" ? "CLAUDE.md" : "AGENTS.md"), `# ${r.name}\n${r.name}的假人格：说话慢一点。\n`);
    w(path.join(gate, "tools.json"), JSON.stringify({ persona: r.name, personaFile: path.join(state, "persona.md"), forge: true }));
    w(path.join(state, "persona.md"), `# 我是${r.name}\n${r.name}的假人格文件：温柔，记性好。\n`);
    w(path.join(gate, "system-prompt.md"), `${r.name}的假系统提示：先听再说。\n`);
    const M = 60_000;
    const cold = [];
    for (let k = 0; k < 4; k++) {
      const t0 = now - (50 - k * 10) * M;
      cold.push({ id: `cold-${id}-${k}-user`, role: "user", at: iso(t0), text: `${r.name}第${k + 1}轮她的假话：今天下雨了吗？这句故意写长一点，看看前六十个字会不会被截断显示，所以再多写几个字凑够长度，后面这半句应该被折叠起来。` });
      cold.push({ id: `cold-${id}-${k}-reply-1-assistant`, role: "assistant", at: iso(t0 + 30_000), text: `${r.name}第${k + 1}轮的假回答：下了，我陪你听雨。` });
    }
    w(path.join(gate, "cold.jsonl"), cold.map((e) => JSON.stringify(e)).join("\n") + "\n");
    // 模型登记表（换舱选模型；跟 TG /model 读的同一份）。alpha 有同一家的两个 + 别家一个，beta 只有一个
    w(path.join(gate, "models.json"), JSON.stringify(id === "alpha" ? { v: 1, default: "claude-fable-5[1m]", models: [
      { id: "claude-fable-5[1m]", label: "Fable 5", engine: "claude-cli", window: 1000000, vision: true, tools: true, billing: "subscription" },
      { id: "claude-opus-5-5[1m]", label: "Opus 5.5", engine: "claude-cli", window: 1000000, vision: true, tools: true, billing: "subscription" },
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", engine: "codex-appserver", window: 872000, vision: true, tools: true, billing: "subscription" },
    ] } : { v: 1, default: "gpt-5.6-sol", models: [
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", engine: "codex-appserver", window: 872000, vision: true, tools: true, billing: "subscription" },
    ] }));
    // 他自己写的东西（「他写的东西」入口要列）+ 桥的运行账本（不许改）+ 一个凭据（不许改）
    w(path.join(state, "notes", "备忘.md"), `${r.name}的假备忘：周五买花。\n`);
    w(path.join(state, "secrets", "api.secret"), "fake-secret-value");
    w(path.join(state, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
    const notebookFile = crossLeak && id === "beta" ? path.join(home, ".alpha", "notebook.json") : path.join(state, "notebook.json");
    envFiles[id] = w(path.join(gate, `${id}-env.sh`), [
      "set -a",
      `export GATE_ROOT=${gate}`,
      `export NOVA_STATE_DIR=${state}`,
      `export GATE_WORKSPACE_ROOT=${ws}`,
      `export GATE_BINDING_KEY=bind-${id}`,
      "export GATE_PREFERRED_CHAT_ID=1",
      `export GATE_AGENT_DISPLAY_NAME=${r.name}`,
      `export GATE_IDENTITY_INJECTION_FILE=${ident}`,
      `export GATE_SYSTEM_PROMPT_FILE=${path.join(gate, "system-prompt.md")}`,
      ...(id === "beta" ? ["export GATE_ENGINE=codex", "export GATE_MODEL=gpt-5.6-sol"] : []),
      ...(betaNoNotebook && id === "beta" ? [] : [`export NOVA_NOTEBOOK_MODULE=${store.replace(/\.js$/, "")}`, `export NOVA_NOTEBOOK_FILE=${notebookFile}`]),
      "set +a", "",
    ].join("\n"));
  }
  const pm2Json = w(path.join(home, "pm2.json"), JSON.stringify(pm2));
  const chars = [`alpha:${envFiles.alpha}`, `beta:${envFiles.beta}`];
  if (missingRole) chars.push(`gamma:${path.join(home, ".gamma-gate", "gamma-env.sh")}`);
  const env = {
    HOME: home, PATH: process.env.PATH,
    PANEL_STATE_DIR: path.join(home, ".im-bridge-panel"),
    PANEL_CHARACTERS: chars.join(","),
    PANEL_PM2_JSON: pm2Json,
    PANEL_ACCENTS: "alpha:ruby,beta:sapphire",
  };
  return { home, env, envFiles, now };
}

module.exports = { makeFixture };
