"use strict";

/**
 * Ledger of outbound messages that did not (certainly) reach the owner.
 *
 * The inbound side has dead letters (receiver.js). This is the outbound side:
 * one place to see "what the owner never actually received".
 *
 * Three outcomes, handled differently:
 *
 * | state      | when                                                     | action                          |
 * |------------|----------------------------------------------------------|---------------------------------|
 * | `blocked`  | content exists but cannot be sent (unsupported, leg down, no target) | keep; may be re-said another way |
 * | `not_sent` | failed before touching the platform (missing file, bad args, explicit reject) | keep; may retry / use another leg |
 * | `unknown`  | timeout, disconnect, crash mid-send                      | keep; NEVER auto-resend, wait for a human |
 *
 * `unknown` exists because a sender can report a timeout after the platform
 * already delivered. Telegram / WeChat / iMessage have no idempotency keys:
 * sending twice produces two messages.
 */

const fs = require("fs");
const path = require("path");

/** Automatically retriable only when we know nothing went out. */
const RETRIABLE = Object.freeze(new Set(["blocked", "not_sent"]));

/**
 * @param {object} o
 * @param {string} o.file  ledger file; supplied by the caller (no default).
 */
function makeUndelivered({ file }) {
  if (!String(file || "").trim()) throw new Error("发不出去的账要一个文件路径 —— 不许用默认值猜");

  function put(entry) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", { encoding: "utf8", mode: 0o600 });
  }

  function list() {
    try {
      const rows = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      // An operation may be recorded once when it becomes unknown and again
      // when a human retries it.  The visible ledger is the latest state for
      // that operation, so recovery remains exactly once across restarts.
      const latest = new Map();
      for (const row of rows) {
        const key = row.operationId || row.recoveryId;
        if (key) latest.set(String(key), row);
        else latest.set(Symbol(), row);
      }
      return [...latest.values()].filter((row) => row.state !== "resolved");
    } catch { return []; }
  }

  return {
    /**
     * Record an undelivered message.
     * @param {object} o
     * @param {"blocked"|"not_sent"|"unknown"} o.state
     */
    note({ state, turnId = "", traceId = "", intent = "send_text", channel = "", chatId = "", text = "", reason = "",
      operationId = "", outputId = "", coldId = "", segments = null }) {
      const entry = {
        state, turnId, traceId, intent, channel, chatId, reason,
        ...(operationId ? { operationId } : {}),
        ...(outputId ? { outputId } : {}),
        ...(coldId ? { coldId } : {}),
        ...(segments ? { segments } : {}),
        // Keep the text for a possible resend. This is NOT the conversation
        // archive (the outbound gate writes that); it is a human-facing ledger.
        text,
        // A partial operation contains confirmed sends and must be checked
        // before any retry, even when its remaining segments are not_sent.
        retriable: RETRIABLE.has(state) && state !== "partial",
      };
      const prior = operationId && list().find((row) => row.operationId === operationId && row.state === state);
      if (prior) return prior;
      put(entry);
      return entry;
    },

    /** Mark a previously failed operation as delivered after an explicit retry. */
    resolve({ operationId, outputId = "", turnId = "", coldId = "" } = {}) {
      if (!operationId) return null;
      const prior = list().find((row) => row.operationId === operationId);
      if (!prior) return null;
      const entry = { state: "resolved", operationId, outputId: outputId || prior.outputId || "",
        turnId: turnId || prior.turnId || "", coldId: coldId || prior.coldId || "", retriable: false,
        at: new Date().toISOString() };
      put(entry);
      return entry;
    },

    /** all */
    list,

    /** Safe to retry (certainly not sent). */
    retriable: () => list().filter((e) => e.retriable),

    /** Must never be auto-retried; wait for a human check. */
    needsCheck: () => list().filter((e) => !e.retriable),

    /** Summary counts */
    summary() {
      const all = list();
      const by = {};
      for (const e of all) by[e.state] = (by[e.state] || 0) + 1;
      return {
        total: all.length,
        ...by,
        可以重来: all.filter((e) => e.retriable).length,
        等人核对: all.filter((e) => !e.retriable).length,
      };
    },
  };
}

module.exports = { makeUndelivered, RETRIABLE };
