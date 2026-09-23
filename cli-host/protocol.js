'use strict';

/**
 * Wire format shared by both process sockets:
 *   im-cli <-> im-box   (cli.sock)
 *   im-box <-> im-gate  (box.sock)
 *
 * Both sockets use the same encode / createDecoder / packError / unpackError, so
 * error flags (see ERROR_FLAGS) survive the hop instead of being hand-copied field by field.
 *
 * Why a separate CLI process: the Claude Code CLI lives in its own long-running host, and
 * the box is just a subscriber. Restarting the box (the code that changes often) does not
 * interrupt the agent's session.
 *
 * Frame = one JSON line + "\n". No length prefix: every message is JSON anyway, and a jsonl
 * stream can be inspected with `tail -f`.
 *
 * Invariant: CLI-side events must be replayable. While the box is disconnected (restart,
 * crash, upgrade) the CLI keeps producing events; if they were fire-and-forget they would be
 * lost and the owner would miss messages. So the server numbers every event and keeps a ring
 * buffer; on reconnect the box reports the last seq it saw and the server replays from there.
 */

/** Ring buffer size. A long turn is ~200-400 events (incl. stream_event); 2000 covers several turns. */
const EVENT_BUFFER = 2000;

/** box -> cli: method call. { t:'call', id, method, args } */
const CALL = 'call';
/** either direction: reply to a call / invoke. { t:'reply', id, ok, value?, error? } */
const REPLY = 'reply';
/** cli -> box: event push. { t:'event', seq, kind, payload } */
const EVENT = 'event';
/** cli -> box: reverse call into a box-side callback (e.g. canUseTool). { t:'invoke', id, fn, args } */
const INVOKE = 'invoke';
/** cli -> box: a reverse call was cancelled (AbortSignal cannot cross the wire). { t:'cancel', id } */
const CANCEL = 'cancel';

/** Methods the box may call. Deliberately an allowlist so wire messages cannot reach beyond the runtime. */
const METHODS = new Set([
  'ensure',    // create or reuse a runtime (a new CLI only when cwd/session/model changes)
  'attach',    // reconnect: report lastSeq, get status + replay
  'enqueue',
  'start',
  'stop',
  'close',
  'get',
  'list',
  'status',
  'setModel',
  'ping',
]);

/** Callbacks the cli may invoke back. Also an allowlist. */
const CALLBACKS = new Set(['canUseTool', 'stderr']);

function encode(frame) {
  return JSON.stringify(frame) + '\n';
}

/**
 * Split a socket byte stream into one frame per line.
 * Returns push(chunk); onFrame is called once per complete frame.
 * Bad lines do not throw - one broken frame must not take the bridge down; the caller logs it.
 */
function createDecoder(onFrame, onBadLine = () => {}) {
  let buf = '';
  return function push(chunk) {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let frame;
      try { frame = JSON.parse(line); }
      catch (e) { onBadLine(line, e); continue; }
      onFrame(frame);
    }
  };
}

/**
 * Error flags that must survive the wire. Adding one here is enough for both ends.
 *   notAccepted  definitely never reached the CLI (thrown before persisting) -> the bridge
 *                may safely retry instead of recording `unknown` and stalling the queue
 */
const ERROR_FLAGS = ['notAccepted'];

/** Error -> serializable object. Keeps name, the top of the stack and allowlisted flags. */
function packError(err) {
  if (!err) return { message: 'unknown error' };
  const out = {
    message: String(err.message || err),
    name: err.name || 'Error',
    stack: typeof err.stack === 'string' ? err.stack.split('\n').slice(0, 6).join('\n') : undefined,
  };
  for (const k of ERROR_FLAGS) if (err[k] === true) out[k] = true;
  return out;
}

/** Wire error -> local Error, keeping name, stack head and allowlisted flags.
 *  Plain strings are accepted too, so a non-packed error is never lost. */
function unpackError(payload) {
  if (typeof payload === 'string') return new Error(payload || 'peer sent no error message');
  const e = new Error((payload && payload.message) || 'peer sent no error message');
  if (payload && payload.name) e.name = payload.name;
  if (payload && payload.stack) e.remoteStack = payload.stack;
  for (const k of ERROR_FLAGS) if (payload && payload[k] === true) e[k] = true;
  return e;
}

/**
 * Event ring (server side): every event gets a monotonic seq; the box replays by seq on reconnect.
 * When full, the oldest is dropped - and attach must learn that the requested range is gone
 * rather than pretending the replay is complete (a silent gap is far harder to debug).
 */
function createEventRing(capacity = EVENT_BUFFER) {
  const items = [];
  let nextSeq = 1;
  return {
    push(kind, payload) {
      const frame = { t: EVENT, seq: nextSeq++, kind, payload };
      items.push(frame);
      if (items.length > capacity) items.shift();
      return frame;
    },
    /** All events after afterSeq. null = that range was already evicted and cannot be replayed. */
    since(afterSeq) {
      if (!Number.isFinite(afterSeq) || afterSeq < 0) return null;
      if (afterSeq === nextSeq - 1) return [];          // nothing missed
      if (!items.length) return afterSeq === 0 ? [] : null;
      if (items[0].seq > afterSeq + 1) return null;     // gap already evicted
      return items.filter((f) => f.seq > afterSeq);
    },
    get lastSeq() { return nextSeq - 1; },
    get size() { return items.length; },
  };
}

module.exports = {
  CALL, REPLY, EVENT, INVOKE, CANCEL,
  METHODS, CALLBACKS, EVENT_BUFFER, ERROR_FLAGS,
  encode, createDecoder, packError, unpackError, createEventRing,
};
