"use strict";

/**
 * Build a box: runtime + the five box methods + persona injection.
 *
 * Used by `box-host.js` (the im-box process). The bridge process never builds
 * a box itself; it connects to im-box over box.sock.
 *
 * Lives under `src/host/` (not the bridge), so it is allowed to know about claude.
 */

const fs = require("fs");
const path = require("path");

/** Tail of the cold log — material for the persona's opening. Read-only. */
function readColdTail(file, n) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip bad lines */ }
  }
  return out.slice(-n);
}

/**
 * @param {object} o
 * @param {object} o.cfg      result of main.js readConfig()
 * @param {object} o.backend  BOXES[kind]
 * @param {object} o.persona  result of loadPersona()
 * @param {function} o.log
 * @returns {Promise<{runtime, box}>}
 */
async function buildBox({ cfg, backend, persona, log = () => {} }) {
  // The runtime opens files/sockets under stateDir and assumes it exists.
  const stateDir = path.join(cfg.root, "state");
  fs.mkdirSync(stateDir, { recursive: true });

  const memoryDir = cfg.memoryDir;
  const runtime = backend.runtime({
    stateDir,
    sessionsFile: path.join(stateDir, "sessions.json"),
    // Cold log: source for recent excerpts / session rebuild. Read-only for the runtime.
    conversationSourceFile: cfg.coldFile,
    sessionHandoffStateFile: path.join(stateDir, "handoff.json"),
    enableSessionHandoff: false,
    workspaceRoot: cfg.workspaceRoot,
    // Base-context sources (see src/box/instructions.js). Every path must be
    // passed: an unreadable path silently drops that section.
    memoryFile: path.join(memoryDir, "memory.md"),
    agentStateFile: path.join(memoryDir, "agent-state.txt"),
    operationsFile: path.join(memoryDir, "operations.md"),   // rules for all channels
    channelsDir: path.join(memoryDir, "channels"),           // channels/*.md, sorted by name
    diaryDir: path.join(memoryDir, "diary"),
    identityInjectionFile: cfg.identityInjectionFile || "",
    // Fingerprint of the identity file actually loaded into a session.
    injectionManifestFile: path.join(stateDir, "injection-loaded.json"),
    // Optional notebook module for the PENDING PROMISES section.
    notebookModule: cfg.notebookModule || process.env.AGENT_NOTEBOOK_MODULE || "",
    notebookFile: cfg.notebookFile || process.env.AGENT_NOTEBOOK_FILE || "",
    // Template placeholders for instruction files ({{USER_NAME}} / {{USER_PRONOUN}}).
    userName: cfg.ownerName || "owner",
    userPronoun: process.env.GATE_OWNER_PRONOUN || "",
    // Opening injection belongs to box + persona. The runtime's own opening
    // pack must stay off, otherwise it wraps the persona text inside
    // `Current user message:` and labels it as the user's words.
    disableOpeningPack: true,
    claudeCommand: cfg.claudeCommand,
    claudeModel: cfg.model,
    claudeConfigDir: "",
    claudeExtraArgs: [
      ...(cfg.systemPromptFile ? ["--system-prompt-file", cfg.systemPromptFile] : []),
      ...(cfg.fallbackModel ? ["--fallback-model", cfg.fallbackModel] : []),
      // Optional Claude Code plugin directory (e.g. a plugin that adjusts the
      // harness's own system prompt or reminders). Unset = no plugin, no code change.
      ...(process.env.GATE_PLUGIN_DIR ? ["--plugin-dir", process.env.GATE_PLUGIN_DIR] : []),
      // The bridge's own tools get a separate MCP config.
      "--mcp-config", path.join(cfg.root, "mcp-im-bridge.json"),
    ],
    // Note: "bypassPermissions" makes the CLI pass --dangerously-skip-permissions,
    // which the CLI refuses when running as root.
    claudePermissionMode: cfg.claudePermissionMode,
    claudeDisableVerbose: false,
  });
  if (typeof runtime.initialize === "function") await runtime.initialize();

  const box = backend.make({
    runtime, bindingKey: cfg.bindingKey, workspaceRoot: cfg.workspaceRoot,
    model: cfg.model, persona, log,
    // The host supplies material (cold tail); the persona decides how to use it.
    personaContext: async () => ({ coldTail: (n = 40) => readColdTail(cfg.coldFile, n) }),
  });

  return { runtime, box };
}

module.exports = { buildBox, readColdTail };
