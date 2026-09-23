"use strict";

/**
 * Two kinds of outbound failure, which must never be conflated:
 *
 *   NotSent   Definitely nothing left the process (bad arguments, missing
 *             sticker/file...). Failed before touching the platform.
 *             -> the agent may fix the call and try again.
 *   unknown   We don't know whether it was delivered (network timeout, no
 *             platform receipt). -> do NOT resend; wait for reconciliation.
 *
 * Mixing them up fails both ways: treating NotSent as unknown silently drops
 * a message; treating unknown as NotSent sends the same message twice.
 */

class NotSentError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotSentError";
    this.notSent = true;      // the outbound gate checks this flag
  }
}

/** For plugins: this step failed before the platform was touched. */
function notSent(message) {
  return new NotSentError(message);
}

module.exports = { NotSentError, notSent };
