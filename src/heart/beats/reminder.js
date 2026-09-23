"use strict";

/**
 * reminder beat — delivers due reminders from a queue file back to the agent.
 *
 * Optional: enabled only when GATE_REMINDER_QUEUE_FILE is set. The queue is
 * written by some external tool (e.g. an MCP "create reminder" tool) as JSON:
 *   [ { "id": "...", "dueAtMs": 1760000000000, "text": "..." }, ... ]
 * (or `{ "reminders": [...] }`).
 *
 * The note contains only the due time and the original text — no rewording.
 *
 * Read-only on the queue: another process (the tool) writes it concurrently,
 * and a read-modify-write here could silently drop a freshly created reminder.
 * Fired ids are tracked in a separate ledger (`firedFile`) instead.
 *
 * Reminders overdue by more than `staleAfterMs` (default 2h) are not delivered,
 * only recorded as `missed`. At most `maxPerTick` are delivered per scan.
 */

const fs = require("fs");
const path = require("path");
const { putNote } = require("../../gate/producers");

const DEFAULT_SCAN_MS = 30 * 1000;
const DEFAULT_STALE_AFTER_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_PER_TICK = 2;

/** MM-DD HH:MM at GATE_TZ_OFFSET_HOURS (default UTC). */
function bj(ms) {
  const off = Number(process.env.GATE_TZ_OFFSET_HOURS);
  return new Date(ms + (Number.isFinite(off) ? off : 0) * 3600e3).toISOString().slice(5, 16).replace("T", " ");
}

function readQueue(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = Array.isArray(j) ? j : (j.reminders || j.items || []);
    return Array.isArray(list) ? list : [];
  } catch { return []; }   // unreadable = empty
}

function readFired(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return { fired: new Set(j.fired || []), missed: j.missed || [] };
  } catch { return { fired: new Set(), missed: [] }; }
}

/** Atomic write (tmp → rename) of our own ledger. */
function saveFired(file, { fired, missed }, maxKeep = 500) {
  const body = JSON.stringify({
    fired: [...fired].slice(-maxKeep),
    missed: missed.slice(-100),
  }, null, 1);
  const tmp = file + ".tmp-" + process.pid;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

/** The note: due time + the original text. */
function buildNote(reminder, { now = Date.now() } = {}) {
  const due = Number(reminder.dueAtMs) || 0;
  const late = due ? Math.round((now - due) / 60000) : 0;
  const head = "Reminder due (set by you, " + bj(due)
    + (late >= 2 ? ", " + late + " min late" : "") + "):";
  return head + "\n\n" + String(reminder.text || "").trim();
}

/**
 * @param {object} o
 * @param {string} o.dir        producers drop directory
 * @param {string} o.queueFile  reminder queue (read-only)
 * @param {string} o.firedFile  our own ledger of fired ids
 */
function makeReminderBeat({ dir, queueFile, firedFile, scanMs = DEFAULT_SCAN_MS,
  staleAfterMs = DEFAULT_STALE_AFTER_MS, maxPerTick = DEFAULT_MAX_PER_TICK,
  log = () => {}, now = () => Date.now() } = {}) {
  if (!String(dir || "").trim()) throw new Error("reminder beat needs a producers directory");
  if (!String(queueFile || "").trim()) throw new Error("reminder beat needs queueFile");
  if (!String(firedFile || "").trim()) throw new Error("reminder beat needs firedFile");

  return {
    name: "reminder",
    nextDelayMs: () => scanMs,
    async tick() {
      const t = now();
      const book = readFired(firedFile);
      const due = readQueue(queueFile)
        .filter((r) => r && r.id && Number(r.dueAtMs) && Number(r.dueAtMs) <= t)
        .filter((r) => !book.fired.has(r.id))
        .sort((a, b) => a.dueAtMs - b.dueAtMs);
      if (!due.length) return { due: 0 };

      let sent = 0, missed = 0, dirty = false;
      for (const r of due) {
        if (sent >= maxPerTick) break;
        const lateMs = t - Number(r.dueAtMs);
        if (staleAfterMs && lateMs > staleAfterMs) {
          // Too late: record as missed instead of delivering.
          book.fired.add(r.id);
          book.missed.push({ id: r.id, dueAt: bj(Number(r.dueAtMs)), lateMin: Math.round(lateMs / 60000),
            text: String(r.text || "").slice(0, 80) });
          missed += 1; dirty = true;
          log("[reminder] missed (" + Math.round(lateMs / 3600000) + "h late): "
            + String(r.text || "").slice(0, 40));
          continue;
        }
        // Record only after a successful put.
        putNote({ dir, producer: "reminder", text: buildNote(r, { now: t }) });
        book.fired.add(r.id);
        sent += 1; dirty = true;
        log("[reminder] delivered: " + String(r.text || "").slice(0, 40));
      }
      if (dirty) saveFired(firedFile, book);
      return { due: due.length, sent, missed };
    },
  };
}

module.exports = { makeReminderBeat, buildNote, DEFAULT_SCAN_MS, DEFAULT_STALE_AFTER_MS, DEFAULT_MAX_PER_TICK };
