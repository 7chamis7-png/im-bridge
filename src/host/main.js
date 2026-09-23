"use strict";

/**
 * Main process (im-gate): powers up the bridge and keeps it running.
 *
 * This file is not part of the bridge (it lives in src/host/). The bridge
 * (src/gate/) is a set of parts; this is the switch that wires them up.
 *
 * Nothing is hard-coded: every path, id and token comes from environment
 * variables. Pointing the same code at a different bot and session is a config
 * change, not a code change. Missing required config fails loudly and names the
 * missing key instead of guessing a default.
 *
 * One codebase, one process per agent. The only backend-specific part is the
 * box, selected via `GATE_BOX` (see BOXES). Adding a backend = add a
 * `gate-box-<name>.js` and register it in BOXES. Several agents are never put in
 * the same process: failures stay isolated, and restarting one agent does not
 * interrupt another.
 *
 * Usage:
 *   node src/host/main.js          run
 *   node src/host/main.js --check  health check only, then exit
 */

const fs = require("fs");
const path = require("path");

const { buildGate } = require("../gate/wire");
const { makeWatch } = require("./watch");
const { buildSharedCapabilities } = require("./gate-capabilities");
const { buildClosingNote } = require("../producers/closing-turn");
const { loadLegs } = require("../gate/plugins");
const { makeToolSocket } = require("../gate/tool-socket");
const { homePath } = require("../core/paths");

/**
 * Box registry: switching backends only touches this table.
 *
 * Each entry provides how to create a box (`make`) and the backend's own
 * command set (`commands`, not part of the bridge).
 *
 * Every entry is lazy (`require` inside a function): when the gate runs with
 * `GATE_BOX=remote` it never loads any backend-specific code, which keeps the
 * bridge self-contained.
 */
const BOXES = {
  claudecode: {
    make: (...a) => require("./gate-box-claudecode").makeClaudeCodeBox(...a),
    commands: (...a) => require("./gate-commands-claudecode").registerClaudeCodeCommands(...a),
    // No `runtime` here: host/box-host.js installs it when starting the box process.
  },
  /**
   * The box lives in another process (box-host.js); the gate only connects to it.
   * Restarting the gate therefore does not interrupt the agent's session.
   *
   * `remote: true` tells buildEverything not to create a runtime in this process.
   */
  remote: {
    remote: true,
    // Commands are backend-specific too; swap this line when changing backends.
    commands: (...a) => require("./gate-commands-claudecode").registerClaudeCodeCommands(...a),
  },
};

const log = (m) => console.log(new Date().toISOString() + " | " + m);

/** Required config — refuse to start without it, never guess. */
const REQUIRED = [
  ["GATE_ROOT", "桥自己的存储目录（账本/游标/死信/冷层都在它底下）"],
  // Only the bridge's own settings live here. Each channel plugin declares its
  // own config (see gate/plugins/index.js); adding a leg never touches this list.
  ["GATE_BINDING_KEY", "接哪条会话（sessions.json 里的绑定键）"],
  ["GATE_WORKSPACE_ROOT", "那条会话的工作目录"],
  ["GATE_PREFERRED_CHAT_ID", "agent 主动说话时发去哪（路由第 4 档）"],
];

/** Text-to-speech (ElevenLabs). Without a key this returns null, so
 *  synthesize_voice is not registered and send_voice is rejected explicitly
 *  instead of sending silence. */
function makeTts(outputDir) {
  if (!String(process.env.ELEVENLABS_API_KEY || "").trim()) return null;
  try {
    const { TtsService } = require("../services/tts-service");
    return new TtsService({ config: { ttsOutputDir: outputDir } });
  } catch (e) {
    log("TTS unavailable (synthesize_voice not registered): " + ((e && e.message) || e));
    return null;
  }
}

/** Image generation. Same rule: no key, not registered. */
function makeImageGen() {
  const key = process.env.AGENT_IMAGE_API_KEY || process.env.OPENAI_API_KEY || "";
  if (!String(key).trim()) return null;
  try {
    const { ImageGenerationService } = require("../services/image-generation-service");
    return new ImageGenerationService({ config: {
      imageApiKey: key,
      imageModel: process.env.AGENT_IMAGE_MODEL || "",
      imageOutputDir: process.env.AGENT_IMAGE_OUTPUT_DIR || homePath("images"),
    } });
  } catch (e) {
    log("image generation unavailable (generate_image not registered): " + ((e && e.message) || e));
    return null;
  }
}

/**
 * Owner identities per channel: `GATE_OWNER_<CHANNEL>_ID`, e.g.
 * GATE_OWNER_TELEGRAM_ID / GATE_OWNER_WECHAT_ID. Values may be comma-separated:
 * one person often has several ids on one channel (e.g. iMessage phone number
 * and Apple ID email). Recognizing only one would silently block the others.
 *
 * Who the owner is belongs to the host, not to the channel plugins.
 *
 * @returns {Object<string, string[]>} channel → owner ids on that channel
 */
function readOwners(env) {
  const owners = {};
  for (const [k, v] of Object.entries(env)) {
    const m = /^GATE_OWNER_([A-Z0-9_]+)_ID$/.exec(k);
    if (!m || !String(v || "").trim()) continue;
    const ids = String(v).split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length) owners[m[1].toLowerCase().replace(/_/g, "-")] = ids;
  }
  return owners;
}

function readConfig(env = process.env) {
  const kind = String(env.GATE_BOX || "claudecode");
  if (!BOXES[kind]) {
    throw new Error("不认识这个底座：GATE_BOX=" + kind
      + "\n  认识的：" + Object.keys(BOXES).join(" / ")
      + "\n  加一个 = 写 src/host/gate-box-<名字>.js，在 main.js 的 BOXES 里登记一行");
  }
  const missing = REQUIRED.filter(([k]) => !String(env[k] || "").trim());
  if (missing.length) {
    const lines = missing.map(([k, why]) => "  " + k + "  —— " + why);
    throw new Error("主进程缺配置，一个都不许猜：\n" + lines.join("\n"));
  }
  const root = env.GATE_ROOT;
  const list = (k) => String(env[k] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    root,
    ownerId: String(env.GATE_OWNER_TELEGRAM_ID || ""),
    ownerName: env.GATE_OWNER_NAME || "owner",
    bindingKey: env.GATE_BINDING_KEY,
    workspaceRoot: env.GATE_WORKSPACE_ROOT,
    preferredChatId: String(env.GATE_PREFERRED_CHAT_ID),
    botId: env.GATE_BOT_ID || "",
    botUsername: env.GATE_BOT_USERNAME || "",
    model: env.GATE_MODEL || "",
    // Group allow-list keys are `<channel>:<group id>` (see gate/group.js)
    groupsAllowed: list("GATE_GROUPS_ALLOWED"),
    groupsAlwaysWake: list("GATE_GROUPS_ALWAYS_WAKE"),
    // Display names for groups, stored under `telegram:group:<id>`
    groupNames: parseGroupNames(env.GATE_GROUP_NAMES || ""),
    coldFile: env.GATE_COLD_FILE || path.join(root, "cold.jsonl"),
    // The agent's memory files (memory.md, last-scene.md, operations.md,
    // channels/, ...). Read when a new session is opened.
    memoryDir: env.GATE_MEMORY_DIR || homePath("memory"),
    // Optional extra identity text injected when a new session opens.
    identityInjectionFile: env.GATE_IDENTITY_INJECTION_FILE || "",
    gateEnabledFile: env.GATE_ENABLED_FILE || path.join(root, ".gate-enabled"),
    heartbeatFile: env.GATE_HEARTBEAT_FILE || path.join(root, "heartbeat.json"),
    heartbeatMs: Number(env.GATE_HEARTBEAT_MS || 15_000),
    // Watchdog interval. Reports only, never restarts (see watch.js).
    // 0 = disabled (e.g. when an external watch process is used instead).
    watchMs: Number(env.GATE_WATCH_MS ?? 30_000),
    pollTimeoutSec: Number(env.GATE_POLL_TIMEOUT_SEC || 25),
    producersDir: env.GATE_PRODUCERS_DIR || path.join(root, "producers"),
    // Backend + persona: both come from config, the code stays the same.
    boxKind: env.GATE_BOX || "claudecode",
    owners: readOwners(env),               // owner ids per channel
    // Optional system prompt file (passed as the session's system prompt).
    // Different from GATE_PERSONA, which controls the per-session opening injection.
    systemPromptFile: env.GATE_SYSTEM_PROMPT_FILE || "",
    // Extra MCP servers living outside the bridge: a JSON file in the same format
    // as mcp-im-bridge.json, merged in when the gate starts.
    // Needed because mcp-im-bridge.json is rewritten on every gate start; entries
    // added to it by hand would silently disappear after a restart.
    extraMcpFile: env.GATE_EXTRA_MCP || "",
    // Fallback model: without one, a turn rejected by the primary model produces
    // no answer at all.
    fallbackModel: env.GATE_FALLBACK_MODEL || "",
    persona: env.GATE_PERSONA || "",       // a directory, or a .js exporting {name, opening}
    personaName: env.GATE_PERSONA_NAME || "",
    claudeCommand: env.GATE_CLAUDE_COMMAND || "claude",
    claudePermissionMode: env.GATE_CLAUDE_PERMISSION_MODE || "default",
  };
}

/**
 * Read the extra MCP servers file (`GATE_EXTRA_MCP`).
 *
 * Format: `{ "mcpServers": { "<name>": {command, args, env} | {type, url} } }`.
 *
 * A broken file never blocks startup (one tool package's typo should not take the
 * whole agent down), but it is always logged loudly: silently dropping it would
 * leave the agent with missing tools and no trace in the logs.
 */
function readExtraMcp(file, log = () => {}) {
  if (!file) return {};
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    log("[mcp] ⚠️ GATE_EXTRA_MCP file unreadable, none of these tools will be available: " + file
      + " (" + String(e.message).split("\n")[0] + ")");
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    log("[mcp] ⚠️ GATE_EXTRA_MCP is not valid JSON, none of these tools will be available: " + file
      + " (" + String(e.message).split("\n")[0] + ")");
    return {};
  }
  const servers = parsed && typeof parsed === "object" ? parsed.mcpServers : null;
  if (!servers || typeof servers !== "object") {
    log("[mcp] ⚠️ GATE_EXTRA_MCP has no mcpServers section, nothing mounted: " + file);
    return {};
  }
  const out = {};
  for (const [name, spec] of Object.entries(servers)) {
    // Accept both local stdio servers (`command`) and remote MCP servers (`url`).
    if (!spec || typeof spec !== "object" || (!spec.command && !spec.url)) {
      log("[mcp] ⚠️ skipping " + name + " — neither command nor url");
      continue;
    }
    out[name] = spec;
  }
  return out;
}

/** `-10001=family,-10002=work` → { "telegram:group:-10001": "family", ... } */
function parseGroupNames(raw) {
  const out = {};
  for (const part of String(raw).split(",")) {
    const [id, name] = part.split("=").map((s) => (s || "").trim());
    if (id && name) out["telegram:group:" + id] = name;
  }
  return out;
}

async function buildEverything(cfg) {
  // --- Box (all backend-specific work stays inside it; the bridge doesn't know it) ---
  const backend = BOXES[cfg.boxKind];

  // Box in another process: no runtime here, no CLI spawn, just connect.
  if (backend.remote) {
    const { makeRemoteBox } = require("./box-remote");
    const remote = makeRemoteBox({
      socketFile: process.env.GATE_BOX_SOCKET || path.join(cfg.root, "box.sock"),
      cursorFile: path.join(cfg.root, "cursor-box.json"),
      log,
    });
    log("box runs in another process (im-box); connecting — restarting the gate does not interrupt the agent");
    return assemble({ cfg, backend, runtime: remote.runtime, box: remote.box, remoteBox: remote });
  }

  // The in-process box path was removed: BOXES.claudecode has no `runtime`
  // (host/box-host.js installs it). Run im-box and connect via box.sock.
  throw new Error("桥不再自带盒子：GATE_BOX 只能是 remote（现在是 " + cfg.boxKind + "）。盒子在 im-box 里，桥连 box.sock 过去。");
}

/**
 * Assemble the rest of the bridge once a box exists.
 */
async function assemble({ cfg, backend, runtime, box, remoteBox = null }) {

  // --- Plugins: scan the directory, plug in every leg whose config is complete ---
  // Adding a leg never touches this file; each plugin declares its own config.
  const { legs, idle } = loadLegs({ env: process.env, log });
  for (const it of idle) {
    if (it.lacks && it.lacks.length && it.why === "配置只填了一半") {
      log("⚠️ " + it.name + " 这条腿没插上：缺 " + it.lacks.map(([k]) => k).join(" "));
    }
  }
  const pluginSlots = {};
  for (const l of legs) pluginSlots[l.slot] = l.plugin;

  // --- Assembly ---
  const gate = buildGate({
    root: cfg.root,
    coldFile: cfg.coldFile,
    box,
    // ttsService / imageGeneration must be passed in explicitly; otherwise
    // synthesize_voice / generate_image are never registered and send_voice is
    // rejected by outbound with capability_not_registered.
    capabilities: buildSharedCapabilities({
      fileStoreRoot: path.join(cfg.root, "files"),
      runtimeAdapter: runtime,
      config: {
        ttsOutputDir: path.join(cfg.root, "voice"),
        imageApiKey: process.env.AGENT_IMAGE_API_KEY || process.env.OPENAI_API_KEY || "",
        imageModel: process.env.AGENT_IMAGE_MODEL || "",
      },
      ttsService: makeTts(path.join(cfg.root, "voice")),
      imageGeneration: makeImageGen(),
    }),
    producersDir: cfg.producersDir,
    // Gap between reply segments: 700ms by default for all channels. WeChat uses a
    // random 1–3s gap instead: fixed, fast bursts look automated to platform risk
    // controls. Configurable via env; takes effect on gate restart.
    sendGapByChannel: {
      wechat: {
        min: Number(process.env.GATE_WECHAT_GAP_MIN_MS || 1000),
        max: Number(process.env.GATE_WECHAT_GAP_MAX_MS || 3000),
      },
    },
    // Closing turn before a session rotation: gives the agent a chance to save
    // notes / requests / state that must survive into the next session. The bridge
    // only pushes it; the text lives in producers/closing-turn.js.
    closingNote: ({ reason }) => buildClosingNote({ reason }),
    enforceEnabled: true,
    plugins: pluginSlots,
    identities: {
      // Owner identity per leg. Only real platform ids are trusted, never display
      // names (anyone can pick any nickname).
      ...Object.fromEntries(
        Object.entries(cfg.owners).flatMap(([ch, ids]) => ids.map((id) => [ch + ":" + id, cfg.ownerName]))),
      ...cfg.groupNames,
    },
    files: { gateEnabled: cfg.gateEnabledFile },
    preferredRoute: { platform: "telegram", chat_id: cfg.preferredChatId },
    groups: cfg.groupsAllowed.length
      ? { allowed: cfg.groupsAllowed, alwaysWake: cfg.groupsAlwaysWake }
      : null,
    owner: cfg.ownerName,
    log,
  });

  // --- Tool socket: when the agent calls a tool, the bridge sends on its behalf ---
  // Tools only say "I want to send this"; channel, capabilities, cold layer and
  // ledgers are all handled by outbound. Tools never talk to platforms directly.
  const toolSocketFile = path.join(cfg.root, "tools.sock");
  const toolSocket = makeToolSocket({
    file: toolSocketFile,
    outbound: gate.outbound,
    binding: gate.binding,
    activeTurn: () => gate.pipe.activeTurn(),
    addressOn: (ch) => gate.router.addressOn(ch),
    log,
  });

  // A separate mcp-config for the bridge tools, independent of the runtime's own
  // project settings.
  // This file is rewritten on every gate start. Don't edit it by hand — changes
  // would silently disappear on restart. Use GATE_EXTRA_MCP for extra servers.
  const mcpFile = path.join(cfg.root, "mcp-im-bridge.json");
  const mcpServers = {
    im_bridge: {
      command: process.execPath,
      args: [path.join(__dirname, "..", "gate", "tools", "mcp-server.js")],
      env: { GATE_TOOL_SOCKET: toolSocketFile },
      // Always loaded, never deferred. The CLI defers MCP tools once their schemas
      // exceed ~10% of context, forcing a ToolSearch round-trip before each use.
      // These are the agent's "mouth" (reply/react/send_voice/send_image/
      // send_sticker/call…), used every turn, so deferring them wastes a call per turn.
      // Cost: the schemas always occupy context, and box startup waits for the
      // server (max 5s, local socket). Rarely used tools stay deferred.
      alwaysLoad: true,
    },
  };
  for (const [name, spec] of Object.entries(readExtraMcp(cfg.extraMcpFile, log))) {
    if (name === "im_bridge") {                  // never let extra config override the bridge's own server
      log("[mcp] skipping im_bridge from extra config — reserved");
      continue;
    }
    mcpServers[name] = spec;
    log("[mcp] extra server mounted: " + name);
  }
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers }, null, 2) + "\n", { mode: 0o600 });

  // The backend's own commands (model / undo / ...) are not part of the bridge;
  // attach them after assembly.
  // /undo needs to pause intake first (so nothing is written back after deletion).
  // It uses its own flag ("do legs keep polling"), not the killswitch, which
  // stays the operator's one-switch rollback.
  const intake = { paused: false };
  const pauseIntake = async ({ timeoutMs = 30000, stepMs = 200 } = {}) => {
    intake.paused = true;
    const t0 = Date.now();
    for (;;) {
      let pending = 0;
      try { pending = Number((gate.pipe.progress() || {}).pending) || 0; } catch { pending = 0; }
      if (!pending) return { ok: true, waitedMs: Date.now() - t0 };
      if (Date.now() - t0 > timeoutMs) {
        intake.paused = false;                       // could not drain: restore and change nothing
        return { ok: false, why: `等了 ${Math.round(timeoutMs / 1000)} 秒，还有 ${pending} 轮在途` };
      }
      await new Promise((r) => setTimeout(r, stepMs));
    }
  };
  const resumeIntake = () => { intake.paused = false; };

  const added = backend.commands(gate.pipe.commands, {
    runtime, box, workspaceRoot: cfg.workspaceRoot,
    gateRoot: cfg.root, pauseIntake, resumeIntake,
    // Without this, /undo and /stop always see an empty thread id.
    threadId: () => { try { return (box && box.fullness() || {}).threadId || ""; } catch { return ""; } },
  });

  return { gate, box, runtime, remoteBox, commandsAdded: added, legs, idle, toolSocket, mcpFile, intake };
}

/**
 * Heartbeat for the watchdog: "am I doing work".
 *
 * Publishes counters (turns actually completed), not connection status: a
 * connection can look healthy while every send times out.
 */
function writeHeartbeat(cfg, { gate, box, startedAt }) {
  const s = gate.pipe.stats();
  const body = {
    at: new Date().toISOString(),
    pid: process.pid,
    upSec: Math.round((Date.now() - startedAt) / 1000),
    enabled: gate.enabled(),
    stats: s,
    progress: gate.pipe.progress(),
    held: gate.pipe.held().length,
    undelivered: gate.undelivered ? gate.undelivered.summary() : null,
    fullness: (() => { try { return box.fullness(); } catch { return null; } })(),
  };
  const tmp = cfg.heartbeatFile + ".tmp-" + process.pid;
  fs.mkdirSync(path.dirname(cfg.heartbeatFile), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2), "utf8");
  fs.renameSync(tmp, cfg.heartbeatFile);   // atomic: readers never see a partial file
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const cfg = readConfig();

  log("桥的家在 " + cfg.root);
  log("persona " + (cfg.persona || "(none — the agent starts with no persona)")
    + "   backend " + cfg.boxKind);
  // Never run two gates on the same session: two processes resuming the same
  // session corrupt its transcript. We only log which session is bound; no
  // process-list heuristics.
  log("接会话 " + cfg.bindingKey + "  工作目录 " + cfg.workspaceRoot);
  log("认人：" + (Object.entries(cfg.owners).map(([c, ids]) => c + ":" + ids.join("/")).join("  ") || "（一条腿都没认人）")
    + " = " + cfg.ownerName);
  log("群：" + (cfg.groupsAllowed.length ? cfg.groupsAllowed.join(" ") : "（没配，不收群消息）"));

  const { gate, commandsAdded, box, runtime, legs, idle, toolSocket, intake } = await buildEverything(cfg);
  log("腿：" + (legs.map((l) => l.name).join(" + ") || "（一条都没插上）")
    + (idle.length ? "   没插上：" + idle.map((i) => i.name + "(" + i.why + ")").join(" ") : ""));
  const pre = gate.preflight();
  log("点名：" + JSON.stringify(pre.插头 || pre));
  log("命令：" + gate.pipe.commands.names().join(" /"));
  log("开关：" + (gate.enabled() ? "**开着，会接管**" : "关着（暂停接收，游标不前进）"));

  // --- Model fallback alert: notify the operator when the agent is routed to a
  // different model (capacity / automatic fallback) or hits the session limit.
  // Hooks into the box's onReply/onTurnDone; no polling process needed.
  // The requested model is re-read from sessions.json on every comparison
  // (/model writes there without touching GATE_MODEL), so this works even when
  // GATE_MODEL is unset. See model-fallback-alert.js.
  try {
    const { makeModelFallbackAlert } = require("./model-fallback-alert");
    const { makeTelegramPush } = require("./push-notify");
    const stateFile = process.env.GATE_MODEL_ALERT_STATE_FILE || path.join(cfg.root, "model-fallback-alert.json");
    const push = makeTelegramPush({
      token: process.env.GATE_NOTIFY_BOT_TOKEN || "",
      secretFile: process.env.GATE_NOTIFY_BOT_SECRET || "",
      chatId: process.env.GATE_NOTIFY_CHAT_ID || "",
      log,
    });
    const alerter = makeModelFallbackAlert({
      getSessionsFile: () => { try { return (runtime.describe() || {}).sessionsFile || ""; } catch { return ""; } },
      bindingKey: cfg.bindingKey,
      workspaceRoot: cfg.workspaceRoot,
      fallbackModel: cfg.model,
      stateFile,
      notify: push,
      log,
    });

    // /model is an explicit switch, unrelated to observed turns: wrap
    // runtime.setModelForWorkspace (what /model calls). The runtime is a shared
    // singleton and methods are looked up at call time, so wrapping it here,
    // before any command can run, is sufficient.
    if (typeof runtime.setModelForWorkspace === "function") {
      const rawSetModel = runtime.setModelForWorkspace;
      runtime.setModelForWorkspace = async (args) => {
        const r = await rawSetModel(args);
        try { alerter.onModelCommand({ toModel: args && args.model }); }
        catch (err) { log("[model-alert] onModelCommand 挂钩出错（不挡这次切换）：" + ((err && err.message) || err)); }
        return r;
      };
    }

    // turnIds that produced a genuine reply. Without one there is no observed
    // model to compare (silent turn, or a fully synthetic turn such as a session
    // limit); fullness().model would still hold the previous turn's value.
    const genuineSeenByTurn = new Set();
    box.onReply((e) => {
      try {
        if (!e || !e.turnId) return;
        if (e.genuine === false) alerter.onReplyObserved({ genuine: false, text: e.text, turnId: e.turnId, at: e.at });
        else genuineSeenByTurn.add(e.turnId);
      } catch (err) { log("[model-alert] onReply 处理出错（不挡这一轮）：" + ((err && err.message) || err)); }
    });
    box.onTurnDone((e) => {
      try {
        const turnId = e && e.turnId;
        if (turnId && !e.failed && genuineSeenByTurn.has(turnId)) {
          const actual = (box.fullness() || {}).model || "";
          alerter.onModelObserved({ actual, turnId, at: e.at });
        }
        if (turnId) genuineSeenByTurn.delete(turnId);
      } catch (err) { log("[model-alert] onTurnDone 处理出错（不挡这一轮）：" + ((err && err.message) || err)); }
    });
    log("[model-alert] 已挂上：请求模型优先读 sessions.json，读不到退回 GATE_MODEL="
      + (cfg.model || "(没配)") + "，状态存 " + stateFile);
  } catch (e) { log("[model-alert] 装不上（不挡起桥）：" + ((e && e.message) || e)); }

  if (checkOnly) {
    // IPC servers keep the event loop alive: exit explicitly after the check.
    log("--check 只体检，不跑。");
    process.exit(0);
  }

  await toolSocket.start();
  log("工具口：" + [...toolSocket.tools.keys()].join(" ") + "（agent 调工具时，桥代为发送）");

  const startedAt = Date.now();
  // One receive loop per leg. The plugin declares how to poll: long polling
  // blocks by itself, database readers need an idle delay to avoid busy-looping.
  const running = legs.map(({ name, poll }) => {
    const run = {};
    if (poll && poll.idleMsKey) run.idleMs = Number(process.env[poll.idleMsKey] || poll.idleMsDefault || 0);
    else if (poll && poll.idleMs) run.idleMs = poll.idleMs;
    if (poll && poll.timeoutSecKey) run.timeoutSec = Number(process.env[poll.timeoutSecKey] || poll.timeoutSecDefault || 25);
    // `intake.paused` is the temporary gate used by /undo (pause, drain, apply,
    // resume). The killswitch (operator rollback) is independent of it.
    return { name, leg: gate.attach({ channel: name, enabled: () => gate.enabled() && !intake.paused }), run };
  });
  if (gate.enabled()) await gate.pipe.recover();
  let maintenanceBusy = false;
  const maintenance = setInterval(async () => {
    if (maintenanceBusy || !gate.enabled()) return;
    maintenanceBusy = true;
    try {
      await gate.pipe.recover();
      await gate.drainProducers();
    } catch (e) { log("队列处理失败：" + e.message); }
    finally { maintenanceBusy = false; }
  }, 1000);
  const beat = setInterval(() => {
    try { writeHeartbeat(cfg, { gate, box, startedAt }); } catch (e) { log("心跳写不出去：" + e.message); }
  }, cfg.heartbeatMs);
  writeHeartbeat(cfg, { gate, box, startedAt });

  // --- Watchdog: reads our own heartbeat to see whether work is getting done ---
  // It only reports. Restarts are left to the operator: a restart may cut off a
  // turn the agent is in the middle of.
  let watchTimer = null;
  if (cfg.watchMs > 0) {
    const watch = makeWatch({
      heartbeatFile: cfg.heartbeatFile,
      // High-water closing turn: at 85% the agent is asked to wrap up (notes,
      // recent state, accepted requests) while the session is still healthy,
      // instead of waiting for /new. Once per session.
      highWaterRatio: Number(process.env.GATE_HIGH_WATER_RATIO || 0.85),
      // Waterline: first ask the box to trim the tool chain; if that cannot free
      // enough (GATE_TRIM_MIN_GAIN_TOKENS, default 80k), run the same path as /new
      // (closing turn + rotation + receipt). Disabled by default (0); enable with
      // e.g. GATE_AUTO_ROTATE_RATIO=0.3.
      waterlineRatio: Number(process.env.GATE_AUTO_ROTATE_RATIO ?? 0),
      waterlineCooldownMs: Number(process.env.GATE_AUTO_ROTATE_COOLDOWN_MS || 30 * 60_000),
      onWaterline: async ({ ratio, used, threadId }) => {
        const pct = Math.round(ratio * 100);
        const busy = gate.pipe.busy();
        if (busy.busy) { log(`[水位] ${pct}% 撞线，${busy.why}，5 分钟后再看`); return { retrySoon: true }; }
        const minGain = Number(process.env.GATE_TRIM_MIN_GAIN_TOKENS) || 80_000;
        let r = null;
        try { r = await box.trim({ currentTokens: used, minGain }); }
        catch (e) { log(`[水位] 裁工具链那条口出错：${(e && e.message) || e}`); r = { trimmed: false, reason: (e && e.message) || String(e) }; }
        if (r && r.busy) { log(`[水位] ${pct}% 撞线，${r.reason}，5 分钟后再看`); return { retrySoon: true }; }
        if (r && r.trimmed) {
          const mb = (n) => (Number(n) / 1048576).toFixed(1);
          const line = `✂️ 水位 ${pct}% 撞线，裁了工具链：估省 ${Math.round((r.gain || 0) / 1000)}k，文件 ${mb(r.before)}MB → ${mb(r.after)}MB。没换舱，会话继续。备份 ${path.basename(r.backup || "")}`;
          log("[水位] " + line);
          try { await gate.pipe.tellOwner(line, { by: "waterline" }); } catch (e) { log("[水位] 回执发不出去：" + ((e && e.message) || e)); }
          return;
        }
        const why = `水位 ${pct}%，${(r && r.reason) || "裁不了"}`;
        log(`[水位] ${why} → 自动换舱`);
        const cmd = gate.pipe.commands.match("/new " + why);
        const out = cmd ? await gate.pipe.commands.run(cmd) : { text: "（/new 命令不在）" };
        try { await gate.pipe.tellOwner(`🔄 ${why}，自动换舱。${(out && out.text) || ""}`, { by: "waterline" }); }
        catch (e) { log("[水位] 回执发不出去：" + ((e && e.message) || e)); }
      },
      onHighWater: ({ ratio, threadId }) => {
        const pct = Math.round(ratio * 100);
        log("[守护] 水位 " + pct + "%，先推一轮收尾（会话 " + String(threadId).slice(0, 8) + "）");
        gate.pipe.push({ text: buildClosingNote({ reason: "水位 " + pct + "%", mode: "highwater" }), producer: "换舱收尾·水位" })
          .catch((e) => log("[守护] 水位线收尾没推出去：" + ((e && e.message) || e)));
      },
      // Where to report is a host decision; currently the log.
      notify: (m) => log(m.replace(/\n/g, " | ")),
      log,
    });
    watchTimer = setInterval(() => {
      try { watch.tick(); } catch (e) { log("[守护] 自己出错了：" + ((e && e.message) || e)); }
    }, cfg.watchMs);
    log("守护：每 " + Math.round(cfg.watchMs / 1000) + " 秒看一次（只推不动，不会自动重启）");
  }

  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    log("收到 " + sig + "，停腿，不再捞新的。");
    for (const { leg } of running) { try { leg.stop(); } catch { /* keep going */ } }
    try { await toolSocket.stop(); } catch { /* keep going */ }
    clearInterval(maintenance);
    if (watchTimer) clearInterval(watchTimer);
    // Let the current turn finish — cutting it off is worse than a few seconds' delay
    try {
      await gate.pipe.stop();
      if (typeof runtime.close === "function") await runtime.close();
      clearInterval(beat);
      process.exit(0);
    } catch (e) { log("停机收尾失败，任务已保留：" + e.message); }
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log("起来了。" + running.map((l) => l.name).join(" + ") + " 开始自己捞消息。");
  // Independent loops per leg (a DB reader returns in <1s, TG long polling
  // blocks 25s). One leg failing must not take down another: run() already
  // retries internally, so leaving it means stop() was called.
  await Promise.all(running.map(({ name, leg, run }) => leg.run(run)
    .catch((e) => log("[" + name + "] 这条腿退出了：" + ((e && e.message) || e)))));
}

if (require.main === module) {
  main().catch((e) => { console.error("\n" + (e && e.message ? e.message : e) + "\n"); process.exit(1); });
}

module.exports = { readConfig, parseGroupNames, readOwners, readExtraMcp, BOXES };
