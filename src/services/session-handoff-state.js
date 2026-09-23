"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const STATE_VERSION = 1;
const BUILD_STALE_MS = 30 * 60 * 1000;

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readState(stateFile) {
  const filePath = normalizeText(stateFile);
  if (!filePath) return { version: STATE_VERSION };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object"
      ? { version: STATE_VERSION, ...parsed }
      : { version: STATE_VERSION };
  } catch {
    return { version: STATE_VERSION };
  }
}

function writeState(stateFile, nextState) {
  const filePath = normalizeText(stateFile);
  if (!filePath) throw new Error("session handoff state file is empty");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify({ version: STATE_VERSION, ...nextState }, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tmp, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch {}
  return nextState;
}

function readSourceRecords(conversationSourceFile, { workspaceRoot = "" } = {}) {
  const sourceFile = normalizeText(conversationSourceFile);
  const workspace = normalizeText(workspaceRoot);
  if (!sourceFile) return [];
  try {
    return fs.readFileSync(sourceFile, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((record) => {
        if (!record || !["user", "assistant"].includes(record.role)) return false;
        if (!normalizeText(record.id)) return false;
        if (workspace && normalizeText(record.workspaceRoot) && normalizeText(record.workspaceRoot) !== workspace) return false;
        return true;
      });
  } catch {
    return [];
  }
}

function latestSourceId({ conversationSourceFile, workspaceRoot = "" }) {
  const records = readSourceRecords(conversationSourceFile, { workspaceRoot });
  return records.length ? normalizeText(records[records.length - 1].id) : "";
}

function listSourceRange({ conversationSourceFile, workspaceRoot = "", afterId = "", untilId = "" }) {
  const records = readSourceRecords(conversationSourceFile, { workspaceRoot });
  const after = normalizeText(afterId);
  const until = normalizeText(untilId);
  let startIndex = 0;
  if (after) {
    const index = records.findIndex((record) => normalizeText(record.id) === after);
    if (index < 0) return { ok: false, reason: `after source id not found: ${after}`, records: [] };
    startIndex = index + 1;
  }
  let endIndex = records.length - 1;
  if (until) {
    const index = records.findIndex((record) => normalizeText(record.id) === until);
    if (index < 0) return { ok: false, reason: `until source id not found: ${until}`, records: [] };
    endIndex = index;
  }
  if (endIndex < startIndex) {
    return { ok: true, records: [], firstSourceId: "", lastSourceId: "" };
  }
  const selected = records.slice(startIndex, endIndex + 1);
  return {
    ok: true,
    records: selected,
    firstSourceId: selected.length ? normalizeText(selected[0].id) : "",
    lastSourceId: selected.length ? normalizeText(selected[selected.length - 1].id) : "",
  };
}

function ensureCurrentSession({ stateFile, threadId, workspaceRoot }) {
  const tid = normalizeText(threadId);
  const workspace = normalizeText(workspaceRoot);
  if (!tid) return { state: readState(stateFile), current: null };
  const state = readState(stateFile);
  if (state.current?.threadId === tid && normalizeText(state.current?.workspaceRoot) === workspace) {
    return { state, current: state.current };
  }

  let startAfterSourceId = "";
  const lastSwap = state.lastSwap;
  if (lastSwap
      && normalizeText(lastSwap.workspaceRoot) === workspace
      && normalizeText(lastSwap.oldThreadId)
      && normalizeText(lastSwap.oldThreadId) !== tid
      && normalizeText(lastSwap.swapEndSourceId)) {
    startAfterSourceId = normalizeText(lastSwap.swapEndSourceId);
    if (!lastSwap.consumedAt) {
      lastSwap.consumedAt = new Date().toISOString();
      lastSwap.consumedByThreadId = tid;
      lastSwap.consumeMode = "boundary-adopted";
      lastSwap.handoffApplied = false;
    }
  }

  state.current = {
    threadId: tid,
    workspaceRoot: workspace,
    startAfterSourceId,
    adoptedAt: new Date().toISOString(),
  };
  writeState(stateFile, state);
  return { state, current: state.current };
}

function reserveBuild({ stateFile, threadId, workspaceRoot, untilSourceId }) {
  const tid = normalizeText(threadId);
  const until = normalizeText(untilSourceId);
  const { state, current } = ensureCurrentSession({ stateFile, threadId: tid, workspaceRoot });
  if (!current?.startAfterSourceId) {
    return { ok: false, reason: "unknown-session-boundary" };
  }
  if (!until || until === current.startAfterSourceId) {
    return { ok: false, reason: "no-new-sources" };
  }

  const existing = state.build;
  if (existing?.threadId === tid) {
    if (existing.status === "ready") return { ok: false, reason: "already-ready", build: existing };
    if (existing.status === "building") {
      const started = Date.parse(existing.startedAt || "");
      if (Number.isFinite(started) && Date.now() - started < BUILD_STALE_MS) {
        return { ok: false, reason: "already-building", build: existing };
      }
    }
    if (existing.status === "failed") {
      const failed = Date.parse(existing.failedAt || "");
      if (Number.isFinite(failed) && Date.now() - failed < 5 * 60 * 1000) {
        return { ok: false, reason: "recently-failed", build: existing };
      }
    }
  }

  const build = {
    id: `handoff-${Date.now()}-${crypto.randomBytes(5).toString("hex")}`,
    status: "building",
    threadId: tid,
    workspaceRoot: normalizeText(workspaceRoot),
    startAfterSourceId: current.startAfterSourceId,
    untilSourceId: until,
    startedAt: new Date().toISOString(),
  };
  state.build = build;
  writeState(stateFile, state);
  return { ok: true, build };
}

function completeBuild({ stateFile, buildId, summaryText, firstSourceId, lastSourceId, recordCount, chunkCount }) {
  const state = readState(stateFile);
  const build = state.build;
  if (!build || build.id !== normalizeText(buildId) || build.status !== "building") {
    return { ok: false, reason: "build-no-longer-active" };
  }
  if (!state.current || state.current.threadId !== build.threadId) {
    return { ok: false, reason: "session-already-moved" };
  }
  const summary = normalizeText(summaryText);
  if (!summary) return { ok: false, reason: "empty-summary" };
  state.build = {
    ...build,
    status: "ready",
    completedAt: new Date().toISOString(),
    firstSourceId: normalizeText(firstSourceId),
    lastSourceId: normalizeText(lastSourceId) || build.untilSourceId,
    recordCount: Math.max(0, Number(recordCount) || 0),
    chunkCount: Math.max(0, Number(chunkCount) || 0),
    summaryText: summary,
    summarySha256: crypto.createHash("sha256").update(summary).digest("hex"),
  };
  writeState(stateFile, state);
  return { ok: true, build: state.build };
}

function failBuild({ stateFile, buildId, error }) {
  const state = readState(stateFile);
  if (!state.build || state.build.id !== normalizeText(buildId) || state.build.status !== "building") {
    return { ok: false, reason: "build-no-longer-active" };
  }
  state.build = {
    ...state.build,
    status: "failed",
    failedAt: new Date().toISOString(),
    error: normalizeText(error).slice(0, 2000),
  };
  writeState(stateFile, state);
  return { ok: true };
}

function markSwap({ stateFile, threadId, workspaceRoot, swapEndSourceId }) {
  const state = readState(stateFile);
  const tid = normalizeText(threadId);
  const workspace = normalizeText(workspaceRoot);
  const endId = normalizeText(swapEndSourceId);
  const build = state.build;
  let checkpoint = null;
  if (build
      && build.status === "ready"
      && build.threadId === tid
      && normalizeText(build.workspaceRoot) === workspace
      && normalizeText(build.untilSourceId)
      && endId) {
    checkpoint = { ...build };
  } else if (build && build.status === "building" && build.threadId === tid) {
    state.build = { ...build, status: "abandoned", abandonedAt: new Date().toISOString(), reason: "swap-before-build-finished" };
  }
  state.lastSwap = {
    oldThreadId: tid,
    workspaceRoot: workspace,
    swapEndSourceId: endId,
    swappedAt: new Date().toISOString(),
    checkpoint,
    consumedAt: null,
    consumedByThreadId: "",
    consumeMode: "",
    handoffApplied: false,
  };
  state.current = null;
  writeState(stateFile, state);
  return state.lastSwap;
}

function getPendingHandoff({ stateFile, workspaceRoot = "" }) {
  const state = readState(stateFile);
  const lastSwap = state.lastSwap;
  const workspace = normalizeText(workspaceRoot);
  if (!lastSwap || lastSwap.consumedAt) return null;
  if (workspace && normalizeText(lastSwap.workspaceRoot) !== workspace) return null;
  const checkpoint = lastSwap.checkpoint;
  if (!checkpoint || checkpoint.status !== "ready" || !normalizeText(checkpoint.summaryText)) return null;
  if (!normalizeText(checkpoint.untilSourceId) || !normalizeText(lastSwap.swapEndSourceId)) return null;
  return { lastSwap, checkpoint };
}

function getPendingTailRecords({ stateFile, conversationSourceFile, workspaceRoot = "" }) {
  const pending = getPendingHandoff({ stateFile, workspaceRoot });
  if (!pending) return null;
  const range = listSourceRange({
    conversationSourceFile,
    workspaceRoot,
    afterId: pending.checkpoint.untilSourceId,
    untilId: pending.lastSwap.swapEndSourceId,
  });
  return { ...range, pending };
}

function markNewSession({ stateFile, newThreadId, workspaceRoot = "", handoffApplied = false }) {
  const tid = normalizeText(newThreadId);
  const workspace = normalizeText(workspaceRoot);
  if (!tid) return null;
  const state = readState(stateFile);
  const lastSwap = state.lastSwap;
  let startAfterSourceId = "";
  if (lastSwap
      && normalizeText(lastSwap.workspaceRoot) === workspace
      && normalizeText(lastSwap.oldThreadId) !== tid
      && normalizeText(lastSwap.swapEndSourceId)) {
    startAfterSourceId = normalizeText(lastSwap.swapEndSourceId);
    if (!lastSwap.consumedAt) {
      lastSwap.consumedAt = new Date().toISOString();
      lastSwap.consumedByThreadId = tid;
      lastSwap.consumeMode = handoffApplied ? "handoff-bootstrap" : "legacy-bootstrap";
      lastSwap.handoffApplied = Boolean(handoffApplied);
    }
  }
  state.current = {
    threadId: tid,
    workspaceRoot: workspace,
    startAfterSourceId,
    adoptedAt: new Date().toISOString(),
  };
  writeState(stateFile, state);
  return state.current;
}

module.exports = {
  STATE_VERSION,
  readState,
  writeState,
  readSourceRecords,
  latestSourceId,
  listSourceRange,
  ensureCurrentSession,
  reserveBuild,
  completeBuild,
  failBuild,
  markSwap,
  getPendingHandoff,
  getPendingTailRecords,
  markNewSession,
};
