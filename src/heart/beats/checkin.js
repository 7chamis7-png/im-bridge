"use strict";

/**
 * check-in beat — wraps `src/producers/checkin.js` as a heart beat driven by
 * the idle clock, and optionally wires in an external notebook module.
 *
 * ## Optional notebook module (AGENT_NOTEBOOK_MODULE)
 *
 * If configured, the module is `require()`d and may export:
 *   list({file?})        → [{ title, kind?, state? }]   open items
 *   listExpired({file?}) → [{ title }]                  items past their expiry
 *   KIND_ORDER           → { <kind>: <sort rank> }       optional
 * Titles feed `{pending}` (not rendered by the default header) and an extra
 * "expired" header line. Anything missing or throwing → the line is omitted.
 *
 * Only titles are passed, capped at a few items: the check-in must not turn
 * into a to-do list for the agent.
 */

const { makeCheckin, makeIdleClock } = require("../../producers/checkin");

const DEFAULT_MAX_NOTES = 4;
const DEFAULT_MAX_EXPIRED = 4;

/** Open notebook titles, sorted by kind rank. Module missing/empty → []. */
function notebookTitles({ moduleId = "", file = "", max = DEFAULT_MAX_NOTES } = {}) {
  if (!moduleId) return [];
  try {
    const store = require(moduleId);
    const live = store.list(file ? { file } : {});
    const order = store.KIND_ORDER || { promise: 0, thread: 1 };
    const sorted = live.slice().sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
    return sorted.slice(0, max).map((it) => String(it.title || "").replace(/\s+/g, " ").slice(0, 60)
      + (it.state === "watching" ? " (watching)" : ""));
  } catch { return []; }
}

/** "N notebook item(s) expired: “a” “b” — extend or close?"  Nothing expired / no module → "". */
function expiredNotebookLine({ moduleId = "", file = "", max = DEFAULT_MAX_EXPIRED } = {}) {
  if (!moduleId) return "";
  try {
    const store = require(moduleId);
    if (typeof store.listExpired !== "function") return "";
    const expired = store.listExpired(file ? { file } : {});
    if (!expired.length) return "";
    const titles = expired.slice(0, max)
      .map((it) => "“" + String(it.title || "").replace(/\s+/g, " ").slice(0, 60) + "”").join(" ");
    return expired.length + " notebook item(s) expired: " + titles + " — extend or close?";
  } catch { return ""; }
}

/**
 * @param {object} o  everything except the notebook options and `clock` is passed to makeCheckin
 * @param {object} [o.clock]  test hook replacing the idle clock
 */
function makeCheckinBeat({ notebookModule = "", notebookFile = "", maxNotes = DEFAULT_MAX_NOTES,
  maxExpired = DEFAULT_MAX_EXPIRED, configFile = "", log = () => {}, clock: clockOverride = null, ...rest } = {}) {
  const checkin = makeCheckin({
    ...rest,
    configFile,
    log,
    pendingText: () => {
      const notes = notebookTitles({ moduleId: notebookModule, file: notebookFile, max: maxNotes });
      if (!notes.length) return "";
      return notes.map((t) => "“" + t + "”").join(", ").slice(0, 220);
    },
    expiredNotebookText: () => expiredNotebookLine({ moduleId: notebookModule, file: notebookFile, max: maxExpired }),
  });

  const clock = clockOverride || makeIdleClock({ coldFile: rest.coldFile, configFile });

  return {
    name: "check-in",
    nextDelayMs: () => clock.nextDelayMs(),
    tick: async () => {
      // Not idle long enough yet: just look, don't send (not a failure).
      if (!clock.isDue()) {
        const p = clock.peek();
        return { skipped: true, reason: "not idle long enough", dueInMs: Math.max(0, p.dueAt - Date.now()) };
      }
      const r = await checkin.tick();
      clock.fired();
      return r;
    },
  };
}

module.exports = { makeCheckinBeat, notebookTitles, expiredNotebookLine, DEFAULT_MAX_NOTES, DEFAULT_MAX_EXPIRED };
