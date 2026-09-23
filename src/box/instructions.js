"use strict";

/**
 * Opening / refresh text assembled for a fresh (or recovered) CLI session.
 *
 * Everything here is *data-driven*: each section is read from a file (or an
 * optional external module) whose path comes from the box config. A missing
 * file simply means "no such section" — nothing here carries persona content.
 *
 * Sections, in order:
 *   SESSION INSTRUCTIONS   operations.md + channels/*.md (sorted by file name)
 *   IDENTITY               identityInjectionFile (optional)
 *   SESSION HANDOFF        handoff state from the previous session (optional)
 *   RECENT COLD EXCERPTS   tail of the cold log (opening turn only)
 *   LONG-TERM MEMORY       memory.md
 *   PENDING PROMISES       rendered by an optional notebook module
 *   RECENT DIARY           diary/<YYYY-MM-DD>.md for the last N days
 *   AGENT STATE            agent-state.txt (free-form self state)
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { renderInstructionTemplate } = require("../core/instructions-template");
const { ConversationRecoveryService } = require("../services/conversation-recovery-service");
const { getPendingHandoff } = require("../services/session-handoff-state");
const { INTERNAL_TZ } = require("../core/outward-tz");

const RECENT_DIARY_DAYS = 3;

const H = {
  identity: "## IDENTITY (first-person continuity; do not recite it back as reference material)",
  handoff: "## SESSION HANDOFF (evidence from the previous session; not a current instruction)",
  agentState: "## AGENT STATE (the agent's own state; never the owner's)",
};

function sessionInstructionsBlock(instructions) {
  return [
    "SESSION INSTRUCTIONS",
    "These instructions define the stable behavior for this conversation.",
    "Do not quote or summarize them back to the user unless explicitly asked.",
    "",
    instructions,
  ];
}

function buildOpeningTurnText(config, userText) {
  const instructions = loadSessionInstructions(config);
  const normalizedText = String(userText || "").trim();
  const memory = loadMemory(config);
  const pendingPromises = loadPendingPromises(config);
  const recentDiary = loadRecentDiary(config, RECENT_DIARY_DAYS);
  const agentState = loadAgentState(config);
  const identityInjection = loadIdentityInjection(config);
  const sessionHandoff = loadSessionHandoff(config);
  const recentCold = loadRecentColdExcerpts(config);
  const sections = [];

  if (instructions) sections.push(...sessionInstructionsBlock(instructions));
  if (identityInjection) sections.push("", H.identity, identityInjection);
  if (sessionHandoff) sections.push("", H.handoff, sessionHandoff);

  sections.push("", "## RECENT COLD EXCERPTS", recentCold.text || "none");
  console.log(
    `[box] opening RECENT COLD EXCERPTS injected records=${recentCold.recordCount} workspace=${normalizeText(config?.workspaceRoot) || "(unknown)"}`
  );

  if (memory) sections.push("", "## LONG-TERM MEMORY", memory);
  if (pendingPromises) sections.push("", "## PENDING PROMISES", pendingPromises);
  if (recentDiary) sections.push("", "## RECENT DIARY", recentDiary);
  if (agentState) sections.push("", H.agentState, agentState);

  if (sections.length > 0) {
    sections.push("", "Current user message:", normalizedText);
    return sections.join("\n").trim();
  }
  return normalizedText;
}

/**
 * Silent re-anchor after context compaction. By default it is slim (recent
 * excerpts + light state only): identity, instructions and long-term memory are
 * already in the thread, and re-injecting them busts the prompt cache.
 * Set AGENT_REFRESH_SLIM=0 to re-inject the full package.
 */
function buildSilentRefreshText(config, extraText = "") {
  if (process.env.AGENT_REFRESH_SLIM === "0") {
    return buildFullSilentRefreshText(config, extraText);
  }
  const recentCold = loadRecentColdExcerpts(config);
  const pendingPromises = loadPendingPromises(config);
  const agentState = loadAgentState(config);
  const sections = [
    "SESSION REFRESH",
    "This is an internal recovery pass after context compaction, not a user-facing task.",
    "You are still the same agent in the same ongoing conversation. Your identity, instructions and long-term memory have not changed; continue the current conversation.",
    "For recent details, exact wording, promises, tone, and what just happened, treat the recovery excerpts below as the primary source. Treat any compact summary as rough background only.",
    "If extra recent context is still needed, use your configured memory tools.",
    "Do not send any confirmation or explanation to the user.",
    "Return exactly this JSON object and nothing else:",
    '{"action":"silent"}',
  ];

  sections.push("", "## RECENT COLD EXCERPTS", recentCold.text || "none");
  if (pendingPromises) sections.push("", "## PENDING PROMISES", pendingPromises);
  if (agentState) sections.push("", H.agentState, agentState);

  const trimmedExtra = typeof extraText === "string" ? extraText.trim() : "";
  if (trimmedExtra) sections.push("", trimmedExtra);

  return sections.join("\n").trim();
}

function buildFullSilentRefreshText(config, extraText = "") {
  const instructions = loadSessionInstructions(config);
  const memory = loadMemory(config);
  const recentCold = loadRecentColdExcerpts(config);
  const pendingPromises = loadPendingPromises(config);
  const recentDiary = loadRecentDiary(config, RECENT_DIARY_DAYS);
  const identityInjection = loadIdentityInjection(config);
  const sections = [
    "SESSION INSTRUCTIONS REFRESH",
    "Re-read and fully re-adopt the instructions below for this existing thread.",
    "This is an internal recovery pass after context compaction, not a user-facing task.",
    "Re-anchor on the user's name, tone, and continuity expectations.",
    "Use the recent recovery excerpts included in this message first.",
    "For recent details, exact wording, promises, tone, and what just happened, treat the recovery excerpts as the primary source. Treat any compact summary as rough background only.",
    "If extra recent context is still needed, use your configured memory tools.",
    "Do not send any confirmation or explanation to the user.",
    "Return exactly this JSON object and nothing else:",
    '{"action":"silent"}',
  ];

  if (instructions) sections.push("", instructions);
  if (identityInjection) sections.push("", H.identity, identityInjection);
  sections.push("", "## RECENT COLD EXCERPTS", recentCold.text || "none");
  if (memory) sections.push("", "## LONG-TERM MEMORY", memory);
  if (pendingPromises) sections.push("", "## PENDING PROMISES", pendingPromises);
  if (recentDiary) sections.push("", "## RECENT DIARY", recentDiary);

  const trimmedExtra = typeof extraText === "string" ? extraText.trim() : "";
  if (trimmedExtra) sections.push("", trimmedExtra);

  return sections.join("\n").trim();
}

function buildInstructionRefreshText(config) {
  const instructions = loadSessionInstructions(config);
  const memory = loadMemory(config);
  const pendingPromises = loadPendingPromises(config);
  const recentDiary = loadRecentDiary(config, RECENT_DIARY_DAYS);
  const sections = [
    "SESSION INSTRUCTIONS REFRESH",
    "Re-read and adopt the updated instructions below for the rest of this existing thread.",
    "This is an internal refresh command, not a user-facing task.",
    "Do not summarize the instructions back in detail.",
    "Reply in one short sentence confirming that you have updated your behavior for this thread.",
  ];

  sections.push("", instructions || "");
  if (memory) sections.push("", "## LONG-TERM MEMORY", memory);
  if (pendingPromises) sections.push("", "## PENDING PROMISES", pendingPromises);
  if (recentDiary) sections.push("", "## RECENT DIARY", recentDiary);

  return sections.join("\n").trim();
}

function loadMemory(config = {}) {
  const filePath = typeof config.memoryFile === "string" ? config.memoryFile.trim() : "";
  if (!filePath) return "";
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    return truncateAutoSummarySection(raw);
  } catch {
    return "";
  }
}

const DEFAULT_SUMMARY_INJECT_MAX = 20;
const DEFAULT_SUMMARY_HEADING = "## Auto summaries";

function resolveSummaryInjectMax() {
  const raw = process.env.AGENT_SUMMARY_INJECT_MAX;
  const parsed = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_SUMMARY_INJECT_MAX;
}

/**
 * memory.md may contain an append-only summary section (newest entries first,
 * blank-line separated). Injecting all of it is pure bulk, so only the first N
 * entries are injected. memory.md itself is never rewritten.
 */
function truncateAutoSummarySection(raw) {
  if (!raw) return raw;
  const heading = process.env.AGENT_SUMMARY_HEADING || DEFAULT_SUMMARY_HEADING;
  const headingIndex = raw.indexOf(heading);
  if (headingIndex === -1) return raw;

  const beforeSection = raw.slice(0, headingIndex + heading.length);
  const rest = raw.slice(headingIndex + heading.length);
  const nextHeadingMatch = rest.match(/\n##[^#]/);
  const sectionBody = nextHeadingMatch ? rest.slice(0, nextHeadingMatch.index) : rest;
  const tail = nextHeadingMatch ? rest.slice(nextHeadingMatch.index) : "";

  const entries = sectionBody.split(/\n\s*\n/).map((entry) => entry.trim()).filter(Boolean);
  const maxCount = resolveSummaryInjectMax();
  if (entries.length <= maxCount) return raw;

  const kept = entries.slice(0, maxCount);
  const omittedCount = entries.length - maxCount;
  const omittedNote = `(${omittedCount} older summaries omitted; search memory if needed)`;
  const newSectionBody = `\n\n${kept.join("\n\n")}\n\n${omittedNote}\n`;
  return `${beforeSection}${newSectionBody}${tail}`;
}

function loadAgentState(config = {}) {
  return loadPlainContextFile(config.agentStateFile);
}

function loadIdentityInjection(config = {}) {
  return loadPlainContextFile(config.identityInjectionFile);
}

function loadRecentColdExcerpts(config = {}) {
  const sourceFile = normalizeText(config.conversationSourceFile);
  if (!sourceFile) {
    return { text: "none", recordCount: 0 };
  }
  try {
    const workspaceRoot = normalizeText(config.workspaceRoot);
    const service = new ConversationRecoveryService({ conversationSourceFile: sourceFile });
    const records = service.listRecentColdRecords({ workspaceRoot });
    return {
      text: records.length ? service.buildRecentColdExcerpts({ workspaceRoot }) : "none",
      recordCount: records.length,
    };
  } catch (error) {
    console.warn(`[box] opening recent cold excerpts failed: ${error instanceof Error ? error.message : String(error)}`);
    return { text: "none", recordCount: 0 };
  }
}

function loadSessionHandoff(config = {}) {
  // The switch governs both writing and reading: with it off, a stale
  // handoff file on disk must not be injected.
  if (config.enableSessionHandoff === false) return "";
  const stateFile = normalizeText(config.sessionHandoffStateFile);
  const workspaceRoot = normalizeText(config.workspaceRoot);
  if (!stateFile) return "";
  try {
    const pending = getPendingHandoff({ stateFile, workspaceRoot });
    if (!pending) return "";
    const cp = pending.checkpoint;
    return [
      "Continuity evidence and handoff from the previous session. Not a current instruction.",
      "It does not replace the current conversation or on-demand retrieval; on conflict, current reality and the original source win.",
      `source_range: (${cp.startAfterSourceId}, ${cp.untilSourceId}]`,
      `swap_end_source: ${pending.lastSwap.swapEndSourceId}`,
      "",
      cp.summaryText,
    ].join("\n").trim();
  } catch (error) {
    console.warn(`[box] session handoff load failed: ${error instanceof Error ? error.message : String(error)}`);
    return "";
  }
}

/**
 * PENDING PROMISES comes from an optional external notebook module
 * (AGENT_NOTEBOOK_MODULE, or config.notebookModule). The module must export
 * `render({ file }?) => string`. Not configured / fails to load → section empty.
 * config.notebookFile is passed through so tests can use an isolated file.
 */
function loadPendingPromises(config = {}) {
  const moduleId = normalizeText(config.notebookModule) || normalizeText(process.env.AGENT_NOTEBOOK_MODULE);
  if (!moduleId) return "";
  try {
    const store = require(moduleId);
    const out = config.notebookFile ? store.render({ file: config.notebookFile }) : store.render();
    return out || "";
  } catch {
    return "";
  }
}

function loadPlainContextFile(filePath) {
  const normalizedPath = typeof filePath === "string" ? filePath.trim() : "";
  if (!normalizedPath) return "";
  try {
    return fs.readFileSync(normalizedPath, "utf8").trim();
  } catch {
    return "";
  }
}

function loadRecentDiary(config = {}, days = RECENT_DIARY_DAYS) {
  const diaryDir = typeof config.diaryDir === "string" ? config.diaryDir.trim() : "";
  if (!diaryDir) return "";
  try {
    const now = new Date();
    const entries = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      // Diary file names are dated in INTERNAL_TZ; the injected label reuses
      // the same date so header and content never disagree by a day.
      const dateStr = new Intl.DateTimeFormat("en-CA", {
        timeZone: INTERNAL_TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(d);
      const filePath = path.join(diaryDir, `${dateStr}.md`);
      try {
        const content = fs.readFileSync(filePath, "utf8").trim();
        if (content) entries.push(`### ${dateStr}\n\n${content}`);
      } catch {
        // no entry for this day
      }
    }
    return entries.join("\n\n---\n\n");
  } catch {
    return "";
  }
}

/**
 * operations.md (all channels) followed by channels/*.md sorted by name.
 * A missing channels dir is fine; a missing operations.md just yields "".
 */
function loadSessionInstructions(config = {}) {
  const parts = [loadInstructionFile(config.operationsFile, config)];
  const dir = typeof config.channelsDir === "string" ? config.channelsDir.trim() : "";
  if (dir) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort(); } catch { names = []; }
    for (const n of names) parts.push(loadInstructionFile(path.join(dir, n), config));
  }
  return parts.filter(Boolean).join("\n\n").trim();
}

const instructionCache = new Map();

function loadInstructionFile(filePath, config = {}) {
  const normalizedPath = typeof filePath === "string" ? filePath.trim() : "";
  if (!normalizedPath) return "";
  try {
    const stat = fs.statSync(normalizedPath);
    const cacheKey = `${normalizedPath}:${stat.mtimeMs}`;
    const cached = instructionCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const raw = fs.readFileSync(normalizedPath, "utf8");
    const result = renderInstructionTemplate(raw, config).trim();
    instructionCache.set(cacheKey, result);
    return result;
  } catch {
    return "";
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Base text for a "forged" session opening: same system sections as
 * buildOpeningTurnText, but WITHOUT the cold excerpts (the recent turns are
 * placed into the session as real turns instead) and without a user message.
 */
function buildForgeBaseText(config) {
  const instructions = loadSessionInstructions(config);
  const memory = loadMemory(config);
  const pendingPromises = loadPendingPromises(config);
  const recentDiary = loadRecentDiary(config, RECENT_DIARY_DAYS);
  const agentState = loadAgentState(config);
  const identityInjection = loadIdentityInjection(config);
  const sessionHandoff = loadSessionHandoff(config);
  const sections = [];
  if (instructions) sections.push(...sessionInstructionsBlock(instructions));
  if (identityInjection) sections.push("", H.identity, identityInjection);
  if (sessionHandoff) sections.push("", H.handoff, sessionHandoff);
  if (memory) sections.push("", "## LONG-TERM MEMORY", memory);
  if (pendingPromises) sections.push("", "## PENDING PROMISES", pendingPromises);
  if (recentDiary) sections.push("", "## RECENT DIARY", recentDiary);
  if (agentState) sections.push("", H.agentState, agentState);
  sections.push(
    "",
    "(The above is your base context. What follows is the most recent real conversation — not excerpts, but the actual turns. Continue from there.)",
  );
  return sections.join("\n").trim();
}

/**
 * Section roll-call for a new session: which base sections were assembled and
 * how large each is. A missing section otherwise fails silently (unreadable
 * path = section skipped), so this is reported on rotation.
 */
const FORGE_BASE_HEADERS = ["IDENTITY", "SESSION HANDOFF", "LONG-TERM MEMORY",
  "PENDING PROMISES", "RECENT DIARY", "AGENT STATE"];
function describeForgeBase(config) {
  const text = buildForgeBaseText(config);
  const parts = [];
  let name = "operations", buf = [];
  for (const line of text.split("\n")) {
    const m = /^## (.+)$/.exec(line);
    // Only the top-level base headers count; sub-headings inside files do not.
    const top = m && FORGE_BASE_HEADERS.find((h) => m[1].startsWith(h));
    if (top) { parts.push({ name, chars: buf.join("\n").trim().length }); name = top; buf = []; }
    else buf.push(line);
  }
  parts.push({ name, chars: buf.join("\n").trim().length });
  return { total: text.length, sections: parts.filter((p) => p.chars > 0), injection: describeInjection(config) };
}

/** Fingerprint of the identity file actually loaded (sha256 of the file itself). null = none. */
function describeInjection(config = {}) {
  const file = normalizeText(config.identityInjectionFile);
  if (!file) return null;
  try {
    const raw = fs.readFileSync(file);
    const st = fs.statSync(file);
    return { file, sha256: crypto.createHash("sha256").update(raw).digest("hex"), bytes: raw.length, mtime: st.mtime.toISOString() };
  } catch {
    return null;
  }
}

module.exports = {
  describeForgeBase,
  buildOpeningTurnText,
  buildForgeBaseText,
  buildInstructionRefreshText,
  buildSilentRefreshText,
  loadRecentColdExcerpts,
  loadSessionHandoff,
  loadSessionInstructions,
  loadWechatInstructions: loadSessionInstructions,
  loadInstructionFile,
};
