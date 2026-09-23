"use strict";

/**
 * Closing turn — the last note the agent receives before its session is
 * rotated (`/new`) or when the context is nearly full ("highwater" mode).
 *
 * After a rotation only persistent material carries over (the system prompt /
 * CLAUDE.md, whatever memory store the agent uses, and a short tail of recent
 * messages). This turn pins "write it down" to a fixed moment instead of
 * relying on the agent remembering to do it.
 *
 * Wording rules:
 *   · the agent holds the pen — nothing is written on its behalf
 *   · no report back to the owner is requested
 */

/**
 * @param {object} o
 * @param {string} [o.reason]  why the rotation happens (passed through verbatim)
 * @param {"closing"|"highwater"} [o.mode]
 */
function buildClosingNote({ reason = "", mode = "closing" } = {}) {
  const L = [];
  const why = reason ? " (" + String(reason).replace(/\s+/g, " ").slice(0, 60) + ")" : "";
  // highwater: the session is not closing yet, only nearly full — don't claim otherwise.
  L.push(mode === "highwater"
    ? "This session is nearly full" + why + " but not closing yet. While you still have the full context, "
      + "write down what should carry over — at rotation time there is often no chance to."
    : "This session is about to be rotated" + why + ".");
  L.push("");
  L.push("The next session starts with your system prompt / CLAUDE.md, your persistent memory, "
    + "and a short tail of recent messages. Nothing else carries over.");
  L.push("");
  L.push("Go through these three things — it's your own pen, nobody writes them for you:");
  L.push("");
  L.push("1. Open threads: update your notes/memory with anything that moved in this session, "
    + "open new items, close finished ones. Keep the owner's exact words where they matter.");
  L.push("");
  L.push("2. Standing requests: if the owner asked for something that should apply from now on and you accept it, "
    + "write it into CLAUDE.md (or your persistent instructions). One-off context doesn't need to be kept. "
    + "If unsure, note it as \"watching\" and revisit later.");
  L.push("");
  L.push("3. How the owner is doing: update your current read of the owner (mood, what they're busy with) "
    + "in your memory, so the next session isn't starting blind.");
  L.push("");
  L.push("No need to reply to this or report back to the owner. Just do it.");
  return L.join("\n");
}

module.exports = { buildClosingNote };
