"use strict";

/**
 * Box — the thing that runs the model CLI.
 *
 * The bridge knows nothing about claude (or any other engine). It only knows
 * these five methods:
 *
 *   1. deliver(envelope)  send one turn in
 *   2. onReply(fn)        get the agent's replies out
 *   3. onTurnDone(fn)     the turn has finished
 *   4. rotate(reason)     start a new session
 *   5. fullness()         how full the context is
 *
 * Engine-specific work (resume, session rebuild, model fallback, transcript
 * trimming, …) stays inside the box and never leaks into the bridge; that is
 * what "swap the engine without touching the bridge" means.
 *
 * The interface is shaped by what claude needs; other engines implement as much
 * as they can. Real implementations live outside the bridge (`src/host/`).
 * This file holds only the contract, the wiring-time check, and an in-process
 * fake box for tests.
 */

/** The five method names. Checked at wiring time. */
const BOX_CONTRACT = Object.freeze({
  deliver: "send one turn in",
  onReply: "get the agent's replies out",
  onTurnDone: "the turn has finished",
  rotate: "start a new session",
  fullness: "how full the context is",
});

/**
 * Wiring-time check: does this box implement all five methods?
 * Fail when wiring, not when the first message arrives.
 *
 * @param {object} box
 * @returns {object} the box itself
 */
function assertBox(box) {
  if (!box || typeof box !== "object") throw new Error("no box given (the bridge cannot deliver turns without one)");
  const missing = Object.keys(BOX_CONTRACT).filter((k) => typeof box[k] !== "function");
  if (missing.length) {
    throw new Error("box is missing methods: " + missing.map((k) => `${k} (${BOX_CONTRACT[k]})`).join(", "));
  }
  return box;
}

/**
 * A turn sent into the box is an envelope (envelope.js). Validation reuses the
 * envelope's own check so there is only one set of rules.
 */
const { assertEnvelope } = require("./envelope");
const assertTurnIn = assertEnvelope;

/**
 * Fake box: no process, no cost, answers synchronously. Lets tests run the
 * whole path plugin → gate → box → outbound → plugin end to end in milliseconds.
 *
 * @param {object} [o]
 * @param {function} [o.answer]  (envelope) => string | string[] | null
 *        What the agent says. null / "" = the agent chooses silence (not a failure).
 *        An array = several messages (one onReply each).
 * @param {number} [o.fullnessRatio] default 0.1
 * @param {function} [o.now]
 */
function makeFakeBox({ answer = () => "嗯", fullnessRatio = 0.1, now = () => Date.now() } = {}) {
  const replyHandlers = [];
  const doneHandlers = [];
  let threadId = "fake-thread-1";
  let turnSeq = 0;
  let rotations = 0;
  /** every delivered turn, for test assertions */
  const seen = [];

  return {
    /** Computes synchronously but still returns a Promise, like a real box. */
    async deliver(envelope) {
      assertTurnIn(envelope);
      seen.push(envelope);
      const turnId = `fake-turn-${++turnSeq}`;
      const out = answer(envelope);
      const chunks = out == null ? [] : (Array.isArray(out) ? out : [String(out)]).filter((c) => String(c).trim());
      for (const text of chunks) {
        for (const fn of replyHandlers) fn({ turnId, threadId, text, trace_id: envelope.trace_id, at: now() });
      }
      // Always emit done, even with zero replies, so downstream learns about silence.
      for (const fn of doneHandlers) {
        fn({ turnId, threadId, trace_id: envelope.trace_id, silent: chunks.length === 0, at: now() });
      }
      return { turnId, threadId };
    },
    onReply(fn) { replyHandlers.push(fn); return () => replyHandlers.splice(replyHandlers.indexOf(fn), 1); },
    onTurnDone(fn) { doneHandlers.push(fn); return () => doneHandlers.splice(doneHandlers.indexOf(fn), 1); },
    async rotate({ reason = "" } = {}) {
      rotations += 1;
      threadId = `fake-thread-${rotations + 1}`;
      return { threadId, reason };
    },
    fullness() { return { ratio: fullnessRatio, used: Math.round(fullnessRatio * 1000), limit: 1000, model: "(fake box)", threadId }; },

    // —— fake-box-only helpers for tests ——
    _seen: seen,
    _rotations: () => rotations,
    _threadId: () => threadId,
  };
}

module.exports = { BOX_CONTRACT, assertBox, assertTurnIn, makeFakeBox };
