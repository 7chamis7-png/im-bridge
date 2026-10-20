"use strict";

/**
 * Phone streaming: speak while the agent is still writing.
 *
 * The CLI already runs with partial messages enabled and emits text token by
 * token, but the bridge only delivers a segment once the turn has finished it.
 * On a voice call that means seconds of silence before the first word.
 *
 * This module handles ONLY turns whose inbound came from the phone leg. As
 * soon as a full sentence has accumulated, it is sent straight to the call
 * process socket (GATE_PHONE_SOCKET), bypassing the gate:
 *
 *   {"type":"say","text":"…","stream":true,"turnId":"…"}\n
 *
 * The normal path is unchanged: when the segment completes, the gate still
 * delivers the full text through the phone plugin, writes the cold log and
 * records delivery. The call process is expected to recognise text it already
 * spoke from stream frames and skip it. So if this layer is missing, broken,
 * or the call process is not there, the worst case is the old behaviour
 * (waiting for the full segment); nothing is lost.
 *
 * Rules:
 *   · only reply text (text_delta) is streamed; thinking is never spoken
 *   · cut points: 。！？!?… and newline; a space next to a CJK character
 *     (common as a sentence break in casual Chinese); a comma only once
 *     COMMA_MIN characters have accumulated. Pieces shorter than MIN
 *     characters are not cut on their own
 *   · never cut inside a bracketed tag such as `[soft laugh]`
 *   · if a line starts with `<tag` (a forged inbound / text tool call, see
 *     src/core/hallucination-cut.js), stop streaming the rest of this turn
 *     and leave it to the normal path
 */

const net = require("net");

const MIN = 4;
const COMMA_MIN = 12;
const len = (s) => Array.from(s).length;
const LINE_TAG_RE = /(^|\n)\s*(user)?<[A-Za-z]/;

/**
 * Index (in UTF-16 units, ready for slice) just after the first cut point in
 * `buf`, or -1 if there is none yet.
 * @param {string} buf
 * @returns {number}
 */
function nextCut(buf) {
  let depth = 0;
  const chars = Array.from(buf);
  let pos = 0;                                       // UTF-16 offset, so the caller can slice
  let n = 0;                                         // non-space characters outside [tags]
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    pos += c.length;
    if (c === "[") { depth++; continue; }
    if (c === "]") { depth = Math.max(0, depth - 1); continue; }
    if (depth) continue;
    if (!/\s/.test(c)) n++;
    if (/[。！？!?…\n]/.test(c) && n >= MIN) {
      // Take a run of punctuation along (「！！」「？！」「……」).
      let j = i + 1, p = pos;
      while (j < chars.length && /[。！？!?…]/.test(chars[j])) { p += chars[j].length; j++; }
      return p;
    }
    if ((c === "，" || c === ",") && n >= COMMA_MIN) return pos;
    if (c === " " && n >= MIN && i > 0 && i + 1 < chars.length
        && (/[一-龥]/.test(chars[i - 1]) || /[一-龥]/.test(chars[i + 1]))) return pos;
  }
  return -1;
}

function sendSay(socketPath, text, turnId, timeoutMs, log) {
  return new Promise((resolve) => {
    const s = net.createConnection(socketPath);
    let done = false;
    const end = (ok) => { if (done) return; done = true; clearTimeout(t); try { s.destroy(); } catch { /* already closed */ } resolve(ok); };
    const t = setTimeout(() => end(false), timeoutMs);
    s.on("connect", () => s.write(JSON.stringify({ type: "say", text, stream: true, turnId }) + "\n"));
    s.on("data", () => end(true));
    s.on("error", (e) => { log("[phone-stream] send failed: " + e.message); end(false); });
  });
}

/**
 * @param {object} [o]
 * @param {string} [o.socketPath] call process socket (default GATE_PHONE_SOCKET; empty = disabled)
 * @param {number} [o.timeoutMs]  per-sentence ack timeout
 * @param {function} [o.log]
 */
function makePhoneStreamer({ socketPath = process.env.GATE_PHONE_SOCKET || "", timeoutMs = 8000, log = () => {} } = {}) {
  const enabled = Boolean(String(socketPath || "").trim());
  /** turnId -> { buf, chain, dead (no more deltas), failed (a send failed) } */
  const turns = new Map();

  const st = (turnId) => {
    let t = turns.get(turnId);
    if (!t) { t = { buf: "", chain: Promise.resolve(), dead: false, failed: false }; turns.set(turnId, t); }
    return t;
  };

  // Sentences are sent strictly in order; after one failure the rest of the
  // turn is left to the normal path.
  const emitPiece = (turnId, t, piece) => {
    const clean = piece.trim();
    if (!clean) return;
    t.chain = t.chain
      .then(() => (t.failed ? false : sendSay(socketPath, clean, turnId, timeoutMs, log)))
      .then((ok) => { if (!ok) { t.failed = true; t.dead = true; } });
  };

  return {
    enabled,
    /** A chunk of reply text. */
    delta(turnId, text) {
      if (!enabled || !turnId) return;
      const t = st(turnId);
      if (t.dead) return;
      t.buf += text;
      // A line starting with `<tag`: hand the rest of this turn to the normal path.
      const k = t.buf.search(LINE_TAG_RE);
      if (k >= 0) {
        const before = t.buf.slice(0, k);
        t.buf = ""; t.dead = true;
        if (len(before.trim()) >= 1) emitPiece(turnId, t, before);
        log("[phone-stream] line-start tag; not streaming the rest of this turn");
        return;
      }
      for (;;) {
        const cut = nextCut(t.buf);
        if (cut < 0) break;
        const piece = t.buf.slice(0, cut);
        t.buf = t.buf.slice(cut);
        emitPiece(turnId, t, piece);
      }
    },
    /** A text block ended (before a tool call / at turn end): speak the rest, however short. */
    flush(turnId) {
      const t = turns.get(turnId);
      if (!t || t.dead) return;
      const rest = t.buf; t.buf = "";
      if (rest.trim()) emitPiece(turnId, t, rest);
    },
    /** Turn finished: flush, then forget it once pending sends are done. Returns that promise. */
    done(turnId) {
      this.flush(turnId);
      const t = turns.get(turnId);
      if (!t) return Promise.resolve();
      return t.chain.finally(() => { if (turns.get(turnId) === t) turns.delete(turnId); });
    },
    /** Turn failed: drop buffered text without speaking it. */
    discard(turnId) {
      const t = turns.get(turnId);
      if (!t) return;
      t.buf = ""; t.dead = true; t.failed = true;
      t.chain.finally(() => { if (turns.get(turnId) === t) turns.delete(turnId); });
    },
  };
}

module.exports = { makePhoneStreamer, nextCut };
