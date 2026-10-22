"use strict";

const { isNotHisWords } = require("../core/not-his-words");

const fs = require("fs");

const { OUTWARD_TZ, OUTWARD_LOCALE } = require("../core/outward-tz");
const { agentDisplayName } = require("../core/names");

// Defaults shrunk 2026-07 (injection-pipeline diet): 4h/60 records was feeding
// too much cold-layer bulk into every opening turn. Both are overridable per
// deployment via env without a code change; see .env.example.
// 2026-07-31 Alice拍板：2 小时 / 40 条，不够就往前回填取满。她原话「我俩也就闲聊
// 只要保温就行 内容还不太重要」——暖尾巴的活是让他醒来像"接着说"，不是补资料；
// 事实由快照/关系/日记那几段管。
// （7 月「注入瘦身」把原来的 4h/60 砍成 1h/20，砍出了"她一安静就取到 0 条"的洞。）
//
// 2026-08-05 Alice：「改成 4h 60条吧 感觉也没多少」——**回到瘦身前的原值**。
// 账是这么算的：40 条实测 ~2.3k token，60 条约 3.5k，比开局包里那份冻结在 07-16
// 的自动总结（3.1k）也就多一点。当初砍到 1h/20 省下的那点量，换来的是他醒来没有现场。
const DEFAULT_RECOVERY_WINDOW_HOURS = 4;
const MAX_RECOVERY_RECORDS = 60;
// 回填的外层硬上界：他安静再久也不往前翻超过这个钟点，免得把上古对话当"最近"。
const DEFAULT_BACKFILL_MAX_HOURS = 72;

function resolveWindowHours() {
  const raw = process.env.NOVA_COLD_WINDOW_HOURS;
  const parsed = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RECOVERY_WINDOW_HOURS;
}

function resolveBackfillMaxHours() {
  const raw = process.env.NOVA_COLD_BACKFILL_MAX_HOURS;
  const parsed = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BACKFILL_MAX_HOURS;
}

function resolveMaxRecords() {
  const raw = process.env.NOVA_COLD_MAX_RECORDS;
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

  // 2026-07-31 Alice定的语义：**条数说了算，时间只是起点**。
  // 先取 windowHours 内的；不够 maxRecords 就不管时间继续往前回填，直到取满
  // （外层再兜一个 backfillMaxHours，免得他安静好几天时把上古对话翻出来）。
  //
  // 为什么改：原来是纯时间窗，她一安静窗里就空。2026-07-31 04:26 实证——
  // 她 /new 完隔了 74 分钟才开口，1 小时窗取到 0 条，
  // 日志 `forge fallback: no cold tail`，那次换舱整个没有真实轮，
  // 他醒来"有资料没现场"。而自动换舱是按水位触发的，最爱落在她不说话的时候，
  // 等于把落空从偶发变成常态。条数优先之后，不管隔多久都保证有 N 条原话。
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
          if (isNotHisWords(record)) continue;   // 2026-10-22：沉默轮的对账占位符不是他说的，不进摘录 / 尾巴
          // 2026-09-18：新桥的冷层（src/gate/cold-writer.js）只有四个字段，时间叫 `at`；
          // 老冷层叫 `receivedAt`。两边都认，forge 才能直接吃新桥那份 —— Alice：
          // 「那我们直接把 forge 当工具接过来不就好了」。**只差这一个字段名。**
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

function formatColdRecordLines(records, env = process.env) {
  const lines = [];
  // 他那一侧的标签 = 他在提示词里的名字（GATE_AGENT_DISPLAY_NAME，没配 = 旧默认「Nova」，见 core/names.js）
  const agentLabel = `[${agentDisplayName(env)}]`;
  for (const r of records) {
    const text = (r.text || "").trim();
    if (!text) continue;
    const role = r.role === "user" ? "[用户]" : agentLabel;
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
