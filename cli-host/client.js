'use strict';

/**
 * Box-side proxy with exactly the same shape as what `createRuntime()` returns, so
 * adapters/box-runtime.js only swaps `createRuntime(...)` for `createRemoteRuntime(...)`.
 * Shape mismatches are the most common wiring bug, so this deliberately mirrors the local API.
 *
 * Relationship with im-cli:
 *   - cannot connect -> back off and retry, never throw (box may start before the CLI host)
 *   - reconnect      -> attach(lastSeq) first to replay events missed while disconnected
 *   - replay gap     -> emit an `incomplete` marker so the box reconciles from the ingress
 *                       ledger; never pretend the replay is complete
 */

const net = require('node:net');
const fs = require('node:fs');
const {
  CALL, REPLY, EVENT, INVOKE,
  encode, createDecoder, packError, unpackError,
} = require('./protocol');
const { createLedgerView } = require('./ledger-view');

const log = (...a) => console.log('[im-cli/client]', ...a);
const warn = (...a) => console.error('[im-cli/client]', ...a);

function createRemoteRuntime({
  socketPath,
  ingressPath,
  /**
   * Where the last received event seq is stored. Do not skip this file: if the box restarted
   * from seq 0, im-cli would replay the whole buffer and the owner would get duplicates.
   * With it persisted, only the last few hundred ms can replay; a normal SIGTERM restart
   * flushes it and replays nothing.
   */
  cursorPath,
  onEvent = async () => {},
  callbacks = {},
  reconnectMs = 500,
  maxReconnectMs = 10_000,
  callTimeoutMs = 60_000,
  cursorFlushMs = 200,
} = {}) {
  if (!socketPath) throw new Error('socketPath is required.');
  if (!ingressPath) throw new Error('ingressPath is required: get/list read the ledger synchronously, not over the socket.');
  const ledger = createLedgerView({ filePath: ingressPath });
  /** CLI status, piggybacked on events. status() is used synchronously by the box. */
  let statusCache = { running: false, stopping: false, initialized: false,
    requestedModel: '', actualModel: '', sessionId: '', workspaceRoot: '', threadId: '', model: '' };

  let sock = null;
  let connected = false;
  let disposed = false;
  let backoff = reconnectMs;
  let lastSeq = readCursor();
  let nextCallId = 1;
  let cursorTimer = null;
  let cursorDirty = false;
  /** id -> { resolve, reject, timer } */
  const waiting = new Map();
  /** calls queued until connected */
  let readyWaiters = [];
  /** Settles when the current CLI exits. */
  let doneResolve, doneReject;
  let done = new Promise((res, rej) => { doneResolve = res; doneReject = rej; });
  done.catch(() => {});   // avoid unhandledRejection when nobody listens
  /** last ensure() params (the CLI may be new after a reconnect) */
  let lastEnsure = null;

  function resetDone() {
    done = new Promise((res, rej) => { doneResolve = res; doneReject = rej; });
    done.catch(() => {});
  }

  function readCursor() {
    if (!cursorPath) return 0;
    try {
      const n = Number(JSON.parse(fs.readFileSync(cursorPath, 'utf8')).lastSeq);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch { return 0; }   // missing = start from 0, not an error
  }

  /** Synchronous write via tmp+rename so a restart never sees a half-written file. */
  function writeCursor() {
    if (!cursorPath) return;
    cursorDirty = false;
    try {
      fs.writeFileSync(`${cursorPath}.tmp`, JSON.stringify({ lastSeq, at: new Date().toISOString() }) + '\n');
      fs.renameSync(`${cursorPath}.tmp`, cursorPath);
    } catch (e) { warn('cursor write failed (a restart will replay):', e.message); }
  }

  /** Debounced; flushCursor() writes the final value on exit. */
  function markCursor() {
    if (!cursorPath) return;
    cursorDirty = true;
    if (cursorTimer) return;
    cursorTimer = setTimeout(() => { cursorTimer = null; if (cursorDirty) writeCursor(); }, cursorFlushMs);
    cursorTimer.unref?.();
  }

  function flushCursor() {
    if (cursorTimer) { clearTimeout(cursorTimer); cursorTimer = null; }
    if (cursorDirty) writeCursor();
  }

  function whenReady() {
    if (connected) return Promise.resolve();
    if (disposed) return Promise.reject(new Error('remote runtime already disposed.'));
    return new Promise((res) => readyWaiters.push(res));
  }

  function flushReady() {
    const list = readyWaiters;
    readyWaiters = [];
    for (const r of list) r();
  }

  function send(frame) {
    if (!sock || sock.destroyed) return false;
    try { sock.write(encode(frame)); return true; }
    catch (e) { warn('write failed:', e.message); return false; }
  }

  async function call(method, args = {}, { timeoutMs = callTimeoutMs } = {}) {
    await whenReady();
    const id = 'c-' + nextCallId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (waiting.delete(id)) reject(new Error(`im-cli did not answer ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      waiting.set(id, { resolve, reject, timer });
      if (!send({ t: CALL, id, method, args })) {
        clearTimeout(timer);
        waiting.delete(id);
        reject(new Error('connection to im-cli lost'));
      }
    });
  }

  /** Handle one event: update seq, absorb piggybacked status, dispatch. */
  async function handleEvent(frame) {
    if (Number.isFinite(frame.seq)) { lastSeq = frame.seq; markCursor(); }
    if (frame.status) statusCache = { ...statusCache, ...frame.status };
    if (frame.kind === 'runtime') {
      try { await onEvent(frame.payload); }
      catch (e) { warn('box event callback failed:', e.message); }
      return;
    }
    if (frame.kind === 'stderr') {
      try { callbacks.stderr?.(frame.payload.text); } catch {}
      return;
    }
    if (frame.kind === 'runtime.exited' || frame.kind === 'runtime.stopped') {
      const p = frame.payload || {};
      if (p.failed) doneReject(new Error(p.reason || 'CLI interrupted'));
      else doneResolve();
      return;
    }
  }

  /** Reverse call from im-cli (canUseTool). */
  async function handleInvoke(frame) {
    const fn = callbacks[frame.fn];
    if (typeof fn !== 'function') {
      send({ t: REPLY, id: frame.id, ok: false, error: packError(new Error(`box has no callback ${frame.fn}`)) });
      return;
    }
    try {
      const a = frame.args || {};
      const value = await fn(a.toolName, a.input, { toolUseID: a.toolUseID });
      send({ t: REPLY, id: frame.id, ok: true, value: value === undefined ? null : value });
    } catch (e) {
      send({ t: REPLY, id: frame.id, ok: false, error: packError(e) });
    }
  }

  function connect() {
    if (disposed) return;
    const s = net.createConnection(socketPath);
    sock = s;
    s.setNoDelay(true);

    const push = createDecoder((frame) => {
      if (frame.t === REPLY) {
        const w = waiting.get(frame.id);
        if (!w) return;
        waiting.delete(frame.id);
        clearTimeout(w.timer);
        if (frame.ok) w.resolve(frame.value);
        else w.reject(unpackError(frame.error));
        return;
      }
      if (frame.t === EVENT) { handleEvent(frame); return; }
      if (frame.t === INVOKE) { handleInvoke(frame); return; }
    }, (line, e) => warn('bad frame, skipped:', e.message, line.slice(0, 120)));

    // Do not remove: without it the server works fine but this side never reads a byte and every call times out.
    s.on('data', (chunk) => push(chunk.toString('utf8')));

    s.on('connect', async () => {
      connected = true;
      backoff = reconnectMs;
      log('connected to im-cli');
      flushReady();
      // Reconnect: replay whatever was emitted while disconnected.
      try {
        const info = await call('attach', { lastSeq }, { timeoutMs: 15_000 });
        if (info.status) statusCache = { ...statusCache, ...info.status };
        if (info.hasCli) resetDone();
        if (Array.isArray(info.missed) && info.missed.length) {
          log(`replaying ${info.missed.length} events missed while disconnected`);
          for (const f of info.missed) await handleEvent(f);
        } else if (info.complete === false) {
          warn('event gap already evicted, replay incomplete - reconcile from the ingress ledger');
          try { await onEvent({ __incomplete: true, lastSeq, serverLastSeq: info.lastSeq }); }
          catch {}
          lastSeq = info.lastSeq;
        }
        // A restarted CLI host has no live runtime yet. Recreate it from the
        // most recent ensure request instead of dropping the next turn.
        if (lastEnsure && !info.hasCli) {
          const again = await call('ensure', lastEnsure, { timeoutMs: 120_000 });
          if (again && again.status) statusCache = { ...statusCache, ...again.status };
          if (again && !again.reused) resetDone();
          log('recreated runtime after CLI host reconnect');
        }
      } catch (e) { warn('attach failed (continuing):', e.message); }
    });

    s.on('error', (e) => { if (connected) warn('connection error:', e.message); });
    s.on('close', () => {
      connected = false;
      sock = null;
      for (const [id, w] of waiting) {
        waiting.delete(id);
        clearTimeout(w.timer);
        w.reject(new Error('connection to im-cli lost'));
      }
      if (disposed) return;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, maxReconnectMs);
    });
  }

  connect();

  return {
    /** Create or reuse. The adapter calls it again after reconnect; the server detects reuse. */
    async ensure(want) {
      lastEnsure = want;
      const info = await call('ensure', want, { timeoutMs: 120_000 });
      if (info && info.status) statusCache = { ...statusCache, ...info.status };
      if (info && !info.reused) resetDone();   // new CLI: fresh `done` promise
      return info;
    },
    async attach() { return call('attach', { lastSeq }); },

    // --- the following mirror createRuntime ---

    /**
     * Same signature as the local version: one object `{ message, origin, uuid }`.
     *
     * Unlike the local version this is async and callers must await it. It must not be
     * fire-and-forget: the box relies on the thrown error to know "not persisted = definitely
     * not delivered, safe to retry". Swallowing it would silently drop the owner's message.
     */
    enqueue: (payload) => call('enqueue', { payload }),

    start: () => call('start', {}, { timeoutMs: 120_000 }),
    stop: () => call('stop'),
    close: async () => { try { await call('close'); } catch {} },

    // get / list / status stay synchronous with identical shapes: the first two read the
    // ledger file directly (atomic rename), status reads the piggybacked cache.
    get: (uuid) => ledger.get(uuid),
    list: (state) => ledger.list(state),
    status: () => ({ ...statusCache }),

    setModel: (model) => call('setModel', { model }),
    get done() { return done; },
    get connected() { return connected; },

    /** Flush the cursor before exit so a normal restart replays nothing. */
    flushCursor,

    dispose() {
      disposed = true;
      readyWaiters = [];
      flushCursor();
      try { sock?.destroy(); } catch {}
    },
  };
}

module.exports = { createRemoteRuntime };
