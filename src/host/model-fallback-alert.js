"use strict";

/**
 * Model fallback alert: notify the operator when the runtime silently answers
 * with a different model than the one requested.
 *
 * Lives in src/host/: the gate only sees "which model answered this turn";
 * whether to say something, and to whom, is a host decision (same rule as watch.js).
 *
 * It hooks into the box's existing `onTurnDone` / `onReply` events instead of
 * polling transcript files. The box reports the actual model per turn (taken from
 * the transcript's message.model, skipping `<synthetic>` placeholders).
 *
 * Two independent conditions:
 *   1. Fallback: the turn was answered, but by a model other than the requested
 *      one (capacity routing, or an automatic retry on the fallback model after
 *      a refusal). The cause is not distinguishable from here, and the alert
 *      says so instead of guessing.
 *   2. Session limit: no real model answered; the CLI produced a `<synthetic>`
 *      "session limit" message. There is no model to compare, so it has its own
 *      gate keyed on that message text.
 *
 * Anti-spam: a fallback is an episode, not a point. Entering fallback alerts once;
 * subsequent fallback turns stay silent; returning to the requested model alerts
 * once more. Episode state is persisted so a restart does not re-alert.
 *
 * Never blocks a turn: notify failures only log, and every callback is wrapped in
 * try/catch (a throwing onTurnDone handler would make box-remote replay the event).
 *
 * The requested model is not a fixed value: `/model` switches models at runtime
 * by writing sessions.json without touching GATE_MODEL. So every comparison
 * re-reads sessions.json for the current bindingKey + workspaceRoot and only falls
 * back to GATE_MODEL when that fails. If the owner explicitly `/model`-switches to
 * the fallback model currently in use during an episode, that is an explicit
 * choice, not a recovery: `onModelCommand` quietly resets the episode.
 */

const fs = require("fs");
const path = require("path");

/** Text of the synthetic session-limit message. `.` matches both straight and curly apostrophes. */
const SESSION_LIMIT_RE = /you.?ve\s+hit\s+your\s+session\s+limit/i;

/**
 * Normalize model names by stripping the context-window suffix: config values
 * carry `[1m]`, while the transcript's message.model is the bare name.
 */
function bareModel(m) {
  return String(m || "").trim().replace(/\[[^\]]*\]$/, "");
}

/**
 * Read the requested model from sessions.json without SessionStore (its
 * constructor creates directories; this is read-only). Disk layout:
 *   `bindings[key].runtimeParamsByWorkspaceRootByRuntime.<runtimeId>[workspaceRoot].model`
 *
 * Falls back to `fallbackModel` (GATE_MODEL) when unavailable. Never throws.
 *
 * @param {object} o
 * @param {string} o.sessionsFile
 * @param {string} o.bindingKey
 * @param {string} o.workspaceRoot
 * @param {string} [o.runtimeId]      same default as SessionStore
 * @param {string} [o.fallbackModel]  used when sessions.json has nothing
 * @returns {string}
 */
function resolveRequestedModel({ sessionsFile, bindingKey, workspaceRoot, runtimeId = "claudecode", fallbackModel = "" } = {}) {
  try {
    if (sessionsFile && bindingKey && workspaceRoot) {
      const raw = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
      const m = raw && raw.bindings && raw.bindings[bindingKey]
        && raw.bindings[bindingKey].runtimeParamsByWorkspaceRootByRuntime
        && raw.bindings[bindingKey].runtimeParamsByWorkspaceRootByRuntime[runtimeId]
        && raw.bindings[bindingKey].runtimeParamsByWorkspaceRootByRuntime[runtimeId][workspaceRoot]
        && raw.bindings[bindingKey].runtimeParamsByWorkspaceRootByRuntime[runtimeId][workspaceRoot].model;
      if (typeof m === "string" && m.trim()) return m.trim();
    }
  } catch { /* fall back to the configured model */ }
  return String(fallbackModel || "").trim();
}

/**
 * Pure reducer: observation in, new state + optional alert out. No fs / network.
 *
 * @param {{modelStatus:"normal"|"fallback", lastActual:string, sessionLimitAlerted:boolean}} state
 * @param {object} obs  `{type:"model", actual, requested, turnId, at}` or
 *                       `{type:"session_limit", turnId, text, at}`
 * @returns {{state:object, alert:null|object}}
 */
function decide(state, obs) {
  const s = {
    modelStatus: state.modelStatus === "fallback" ? "fallback" : "normal",
    lastActual: String(state.lastActual || ""),
    sessionLimitAlerted: !!state.sessionLimitAlerted,
  };

  if (obs && obs.type === "model") {
    const reqN = bareModel(obs.requested);
    const actN = bareModel(obs.actual);
    // Unknown requested or actual model: stay silent rather than guess
    if (!reqN || !actN) return { state: s, alert: null };

    // A real answer means the session limit is not hit right now: reset that gate
    s.sessionLimitAlerted = false;

    if (actN === reqN) {
      if (s.modelStatus === "fallback") {
        const prevActual = s.lastActual;
        s.modelStatus = "normal";
        s.lastActual = "";
        return { state: s, alert: { kind: "fallback_recovery", actual: obs.actual,
          requested: obs.requested, prevActual, turnId: obs.turnId, at: obs.at } };
      }
      return { state: s, alert: null };
    }

    // Answered by a different model
    if (s.modelStatus !== "fallback") {
      s.modelStatus = "fallback";
      s.lastActual = obs.actual;
      return { state: s, alert: { kind: "fallback_start", actual: obs.actual,
        requested: obs.requested, turnId: obs.turnId, at: obs.at } };
    }
    s.lastActual = obs.actual;                           // still in the same episode: silent
    return { state: s, alert: null };
  }

  if (obs && obs.type === "session_limit") {
    if (s.sessionLimitAlerted) return { state: s, alert: null };
    s.sessionLimitAlerted = true;
    return { state: s, alert: { kind: "session_limit", turnId: obs.turnId, text: obs.text, at: obs.at } };
  }

  return { state: s, alert: null };
}

/** Timestamp for alert text: local time of the host (set TZ to change it). */
function formatStamp(atMs) {
  const d = new Date(Number(atMs) || Date.now());
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Turn an alert into operator-facing text. */
function composeAlertText(alert) {
  const stamp = formatStamp(alert.at);
  const turnLine = alert.turnId ? "\nturn " + alert.turnId : "";
  if (alert.kind === "fallback_start") {
    return "⚠️ agent 掉档了（模型被替换）\n" + stamp
      + "\n请求 " + (alert.requested || "?") + " → 实际 " + (alert.actual || "?")
      + "\n原因：不确定（容量高峰 / 安全层拦截都有可能，CLI 没给理由字段）"
      + turnLine;
  }
  if (alert.kind === "fallback_recovery") {
    return "✅ agent 回到 " + (alert.requested || "请求的模型") + " 了\n" + stamp
      + "\n" + (alert.prevActual || "?") + " → " + (alert.actual || "?")
      + turnLine;
  }
  if (alert.kind === "session_limit") {
    return "🈳 agent 这一轮额度用完了\n" + stamp
      + "\n（session limit，不是模型掉档，是账号额度到顶——换模型治不了，得等额度恢复）"
      + turnLine;
  }
  return "";
}

function loadState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      modelStatus: raw.modelStatus === "fallback" ? "fallback" : "normal",
      lastActual: String(raw.lastActual || ""),
      sessionLimitAlerted: !!raw.sessionLimitAlerted,
    };
  } catch { return { modelStatus: "normal", lastActual: "", sessionLimitAlerted: false }; }
}

function saveState(file, state, log) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({
      schema: "im-bridge.model-fallback-alert.v1",
      ...state,
      updatedAt: new Date().toISOString(),
    }, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    log("[model-alert] could not save state (will retry): " + ((e && e.message) || e));
  }
}

/**
 * Create a fallback alerter. It only notifies; it never takes action (same
 * rule as watch.js).
 *
 * @param {object} o
 * @param {function} [o.getSessionsFile]  () => path of sessions.json (from
 *   `runtime.describe().sessionsFile`); without it only `fallbackModel` is used.
 * @param {string} [o.bindingKey]      `GATE_BINDING_KEY`
 * @param {string} [o.workspaceRoot]   `GATE_WORKSPACE_ROOT`
 * @param {string} [o.runtimeId]       same default as SessionStore ("claudecode")
 * @param {string} [o.fallbackModel]   used when sessions.json has nothing (`GATE_MODEL`)
 * @param {string} o.stateFile         persisted episode state (no re-alert after restart)
 * @param {function} o.notify          (text) => any; the host decides where it goes
 * @param {function} [o.log]
 */
function makeModelFallbackAlert({ getSessionsFile = () => "", bindingKey = "", workspaceRoot = "",
  runtimeId = "claudecode", fallbackModel = "", stateFile, notify, log = () => {} } = {}) {
  if (!String(stateFile || "").trim()) throw new Error("model fallback alert needs a stateFile (otherwise a restart re-alerts the same episode)");
  if (typeof notify !== "function") throw new Error("model fallback alert needs a notify function");

  let state = loadState(stateFile);

  function currentRequested() {
    let sessionsFile = "";
    try { sessionsFile = (typeof getSessionsFile === "function" ? getSessionsFile() : getSessionsFile) || ""; }
    catch { sessionsFile = ""; }
    return resolveRequestedModel({ sessionsFile, bindingKey, workspaceRoot, runtimeId, fallbackModel });
  }

  function fire(alert) {
    saveState(stateFile, state, log);
    try { notify(composeAlertText(alert)); }
    catch (e) { log("[model-alert] notify failed (turn not affected): " + ((e && e.message) || e)); }
  }

  return {
    /** A synthetic reply: only checks whether it looks like a session limit. */
    onReplyObserved({ genuine, text, turnId, at } = {}) {
      try {
        if (genuine !== false) return;
        if (!SESSION_LIMIT_RE.test(String(text || ""))) return;
        const r = decide(state, { type: "session_limit", turnId, text, at });
        state = r.state;
        if (r.alert) fire(r.alert); else saveState(stateFile, state, log);
      } catch (e) { log("[model-alert] onReplyObserved failed (turn not affected): " + ((e && e.message) || e)); }
    },
    /** A genuine answer: compare the actual model with the currently requested one. */
    onModelObserved({ actual, turnId, at } = {}) {
      try {
        const requested = currentRequested();
        const r = decide(state, { type: "model", actual, requested, turnId, at });
        state = r.state;
        if (r.alert) fire(r.alert); else saveState(stateFile, state, log);
      } catch (e) { log("[model-alert] onModelObserved failed (turn not affected): " + ((e && e.message) || e)); }
    },
    /**
     * `/model` was used. Only one case matters: during a fallback episode, the
     * owner switched to exactly the fallback model in use. That is an explicit
     * choice, so the episode is reset silently. Everything else is handled by the
     * next onModelObserved (sessions.json has already been updated by /model).
     */
    onModelCommand({ toModel } = {}) {
      try {
        const toN = bareModel(toModel);
        if (!toN) return;
        if (state.modelStatus === "fallback" && bareModel(state.lastActual) === toN) {
          state = { modelStatus: "normal", lastActual: "", sessionLimitAlerted: state.sessionLimitAlerted };
          saveState(stateFile, state, log);
        }
      } catch (e) { log("[model-alert] onModelCommand failed (switch not affected): " + ((e && e.message) || e)); }
    },
    /** For tests / diagnostics. */
    _state: () => ({ ...state }),
  };
}

module.exports = {
  bareModel, decide, composeAlertText, formatStamp, resolveRequestedModel,
  makeModelFallbackAlert, SESSION_LIMIT_RE,
};
