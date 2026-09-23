"use strict";

const fs = require("fs");

const { OUTWARD_TZ, OUTWARD_LOCALE } = require("../core/outward-tz");

// Recent cold-layer excerpts injected when a new session opens, so the agent
// resumes "mid-conversation" instead of starting cold. Facts belong to other
// sections (snapshot / memory); this tail is only for continuity and tone.
// Overridable via AGENT_COLD_WINDOW_HOURS / AGENT_COLD_MAX_RECORDS /
// AGENT_COLD_BACKFILL_MAX_HOURS.
const DEFAULT_RECOVERY_WINDOW_HOURS = 4;
const MAX_RECOVERY_RECORDS = 60;
// Hard upper bound for backfill so very old conversation is never treated as "recent".
const DEFAULT_BACKFILL_MAX_HOURS = 72;

function resolveWindowHours() {
  const raw = process.env.AGENT_COLD_WINDOW_HOURS;
  const parsed = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RECOVERY_WINDOW_HOURS;
}

function resolveBackfillMaxHours() {
  const raw = process.env.AGENT_COLD_BACKFILL_MAX_HOURS;
  const parsed = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BACKFILL_MAX_HOURS;
}

function resolveMaxRecords() {
  const raw = process.env.AGENT_COLD_MAX_RECORDS;
  const parsed = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : MAX_RECOVERY_RECORDS;
}

class ConversationRecoveryService {
  constructor({ conversationSourceFile }) {
    this.conversationSourceFile = conversationSourceFile;
  }

  buildRecoveryText({ threadId, workspaceRoot } = {}) {
    const limited = this.listRecentColdRecords({ threadId, workspaceRoot });
    if (!limited.length) return "";

    const windowHours = resolveWindowHours();
    const maxRecords = resolveMaxRecords();
    const lines = [
      "Recent conversation recovery excerpts follow.",
      `Most recent ${limited.length} dialogue records (target ${maxRecords}; window ${windowHours}h, backfilled further when the window is thin). Selected nearby records after filtering noise.`,
      "Use the primary dialogue records first. They are the source of truth for recent details, exact wording, promises, tone, user state.",
      "The compact/runtime summary is only rough background. If the summary conflicts with these excerpts, trust these excerpts.",
      "Do not mention this recovery pass to the user.",
      "",
    ];

    lines.push(...formatColdRecordLines(limited));

    return lines.join("\n");
  }

  /**
   * Iron rule: this opening/recovery anchor may read only the raw cold layer
   * conversation-sources.jsonl. It must not use last-scene.md, compact summaries,
   * memory.md, rebuilt snapshots, or any other generated artifact as input.
   */
  buildRecentColdExcerpts({ threadId, workspaceRoot, emptyText = "none" } = {}) {
    const records = this.listRecentColdRecords({ threadId, workspaceRoot });
    if (!records.length) {
      return emptyText;
    }
    const lines = [
      `Most recent ${records.length} dialogue records (target ${resolveMaxRecords()}; window ${resolveWindowHours()}h, backfilled further when the window is thin).`,
      "Primary source: raw conversation-sources.jsonl records only.",
      "Use these excerpts as the source of truth for recent details, exact wording, promises, tone, and user state.",
      "",
      ...formatColdRecordLines(records),
    ];
    return lines.join("\n");
  }

  // Record count wins; the time window is only the starting point.
  // Take records inside windowHours; if that yields fewer than maxRecords, keep
  // backfilling regardless of time (bounded by backfillMaxHours) until full.
  // A pure time window returns nothing after a quiet period, which is exactly
  // when automatic session rotation tends to happen.
  listRecentColdRecords({ threadId, workspaceRoot } = {}) {
    const nowMs = Date.now();
    const maxRecords = resolveMaxRecords();
    const inWindow = this._readWindow({ nowMs, hours: resolveWindowHours(), threadId, workspaceRoot });
    if (inWindow.length >= maxRecords) {
      return inWindow.slice(-maxRecords);
    }
    const backfilled = this._readWindow({
      nowMs, hours: resolveBackfillMaxHours(), threadId, workspaceRoot,
    });
    return backfilled.slice(-maxRecords);
  }

  _readWindow({ nowMs, hours, threadId, workspaceRoot }) {
    const cutoffMs = nowMs - hours * 60 * 60 * 1000;
    try {
      const raw = fs.readFileSync(this.conversationSourceFile, "utf8");
      const results = [];
      for (const line of raw.trim().split("\n")) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (record.role !== "user" && record.role !== "assistant") continue;
          // Accept both cold-layer schemas: `at` (current cold-writer) and `receivedAt` (legacy).
          const stamp = record.receivedAt || record.at;
          const ts = stamp ? new Date(stamp).getTime() : 0;
          if (ts < cutoffMs) continue;
          if (workspaceRoot && record.workspaceRoot && record.workspaceRoot !== workspaceRoot) continue;
          results.push(record);
        } catch { /* skip malformed */ }
      }
      return results;
    } catch {
      return [];
    }
  }
}

function formatColdRecordLines(records) {
  const lines = [];
  for (const r of records) {
    const text = (r.text || "").trim();
    if (!text) continue;
    const role = r.role === "user" ? "[owner]" : "[agent]";
    const stamp = r.receivedAt || r.at;
    const timeStr = stamp
      ? new Date(stamp).toLocaleTimeString(OUTWARD_LOCALE, {
        timeZone: OUTWARD_TZ,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
      : "";
    lines.push(`${role}${timeStr ? ` (${timeStr})` : ""}: ${text.slice(0, 400)}`);
  }
  return lines;
}

module.exports = { ConversationRecoveryService };
