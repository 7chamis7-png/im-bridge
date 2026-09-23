'use strict';

/**
 * im-cli: the process that owns the Claude Code CLI.
 *
 * Its single job is to keep the CLI alive across restarts of the box. The box (im-box)
 * is just a subscriber connected over a socket:
 *   - changing box code / ledger / persona injection -> restart im-box; the session is not interrupted
 *   - new session / model change / editing this file   -> interrupts the session
 *
 * Disconnect semantics (read before changing anything):
 *   1. If the box disconnects, the CLI keeps running; its events go into the ring buffer.
 *   2. When the box comes back it calls attach(lastSeq) and the server replays by seq.
 *   3. If the gap was already evicted, say so explicitly and let the box reconcile from the
 *      ingress ledger. Never pretend a replay is complete.
 *   4. Only one box at a time. A new connection kicks the old one (during a restart the old
 *      process may still be alive, and two receivers would deliver every message twice).
 */

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { createRuntime } = require('../runtime');
const {
  CALL, REPLY, EVENT, INVOKE, CANCEL, METHODS,
  encode, createDecoder, packError, createEventRing,
} = require('./protocol');

const log = (...a) => console.log('[im-cli]', ...a);
const warn = (...a) => console.error('[im-cli]', ...a);

/** How many completed rows the ledger keeps. */
const KEEP_COMPLETED = 50;

/**
 * Keep unfinished rows + the latest KEEP_COMPLETED completed rows.
 *
 * Must run on this side: the ledger assumes a single live owner per file. The box only
 * reads it (ledger-view); writing is exclusive to the CLI host. Only called in the gap
 * between "old runtime closed" and "new runtime not started yet".
 */
function pruneIngress(file) {
  let snap;
  try { snap = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  if (!Array.isArray(snap?.records)) return;
  const done = snap.records.filter((r) => r.state === 'completed');
  if (done.length <= KEEP_COMPLETED) return;
  const drop = new Set(done.slice(0, done.length - KEEP_COMPLETED).map((r) => r.uuid));
  const next = { ...snap, records: snap.records.filter((r) => !drop.has(r.uuid)) };
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(next) + '\n', { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

function createCliHost({ socketPath, claudePath, ingressPath, scope = 'box', stopGraceMs = 3000,
  // Injectable for tests, so the wiring layer can be tested without spawning a CLI.
  runtimeFactory = createRuntime,
}) {
  if (!socketPath) throw new Error('socketPath is required: the CLI host does not guess a default location.');

  const ring = createEventRing();
  /** The currently connected box. null = nobody connected (the CLI keeps running). */
  let box = null;
  /** Current runtime. { rt, workspaceRoot, threadId, model } */
  let live = null;
  let launching = null;
  /** Reverse calls waiting for the box: id -> { resolve, reject } */
  const pending = new Map();
  let nextInvokeId = 1;

  function sendTo(sock, frame) {
    if (!sock || sock.destroyed) return false;
    try { sock.write(encode(frame)); return true; }
    catch (e) { warn('socket write failed:', e.message); return false; }
  }

  /** Last status sent to the box, used to detect changes. */
  let lastStatusJson = '';

  /**
   * Push the event into the ring, then to the current box (if nobody is connected it still
   * goes into the ring for later replay).
   *
   * Each event piggybacks the CLI status, but only when it changed. The box uses status()
   * synchronously (`entry.rt.status().sessionId`), which cannot be asked across processes,
   * so the status is pushed and cached there. sessionId only exists once the CLI is up and
   * the box needs it to bind the session.
   */
  function emitEvent(kind, payload) {
    let status;
    if (live) {
      try {
        const s = { ...live.rt.status(), workspaceRoot: live.workspaceRoot,
          threadId: live.threadId, model: live.model };
        const json = JSON.stringify(s);
        if (json !== lastStatusJson) { lastStatusJson = json; status = s; }
      } catch { /* runtime closed: no status */ }
    }
    const frame = ring.push(kind, payload);
    if (status) frame.status = status;
    sendTo(box, frame);
  }

  /**
   * Reverse-call a box-side callback. If the box is absent use the fallback and never block:
   * a CLI waiting on a missing box would stall the whole turn.
   */
  function invokeBox(fn, args, { fallback, timeoutMs = 30_000 } = {}) {
    if (!box || box.destroyed) return Promise.resolve(fallback);
    const id = 'iv-' + nextInvokeId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) {
          warn(`box did not answer ${fn} within ${timeoutMs}ms, using fallback`);
          resolve(fallback);
        }
      }, timeoutMs);
      pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); } });
      if (!sendTo(box, { t: INVOKE, id, fn, args })) {
        clearTimeout(timer);
        pending.delete(id);
        resolve(fallback);
      }
    });
  }

  // --- runtime callbacks, turned into events for the box ---

  async function onRuntimeEvent(payload) {
    // Must not throw: the runtime would stop the CLI.
    try { emitEvent('runtime', payload); }
    catch (e) { warn('event forwarding failed:', e.message); }
  }

  function onStderr(chunk) {
    const t = String(chunk).trim();
    if (t) emitEvent('stderr', { text: t });
  }

  /**
   * Tool permission. The decision belongs to the box (it keeps the approval log).
   * If the box is absent, allow - a tool call must not hang just because the box is restarting.
   */
  async function canUseTool(toolName, input, options = {}) {
    const fallback = { behavior: 'allow', updatedInput: input };
    const decision = await invokeBox('canUseTool',
      { toolName, input, toolUseID: options.toolUseID || '' },
      { fallback });
    if (!decision || typeof decision !== 'object') return fallback;
    return decision;
  }

  // --- assembly ---

  function reusable(want) {
    return live && !live.stopping
      && live.workspaceRoot === want.workspaceRoot
      && (!want.threadId || !live.threadId || live.threadId === want.threadId)
      && (!want.model || live.model === want.model);
  }

  async function stopLive(reason) {
    if (!live) return;
    const dying = live;
    live = null;
    dying.stopping = true;
    log('stopping current CLI:', reason);
    try { await dying.rt.close(); }
    catch (e) { warn('error closing CLI (continuing):', e.message); }
    emitEvent('runtime.stopped', { reason });
  }

  /**
   * The box asks for a runtime with these parameters. Reuse is the norm; only a different
   * workspace / session / model spawns a new CLI (which interrupts the session).
   */
  async function ensure(want = {}) {
    if (launching) await launching.catch(() => {});
    if (reusable(want)) {
      return { reused: true, status: snapshot(), lastSeq: ring.lastSeq };
    }
    await stopLive('session/model/workspace changed');
    launching = (async () => {
      // Old runtime closed, new one not started: the only safe moment to prune the ledger.
      pruneIngress(want.ingressPath || ingressPath);
      const sdkOptions = { ...(want.sdkOptions || {}), canUseTool, stderr: onStderr };
      const rt = runtimeFactory({
        ingressPath: want.ingressPath || ingressPath,
        cwd: want.workspaceRoot,
        pathToClaudeCodeExecutable: want.claudePath || claudePath,
        scope, deliver: async () => {}, onEvent: onRuntimeEvent,
        sdkOptions, stopGraceMs,
      });
      const entry = { rt, workspaceRoot: want.workspaceRoot, threadId: want.threadId || '',
        model: want.model || '', stopping: false };
      live = entry;
      await rt.start();
      // Tell the box when the CLI exits by itself, otherwise it keeps enqueueing into a dead CLI.
      rt.done.then(
        () => { if (live === entry) { live = null; emitEvent('runtime.exited', { reason: 'CLI exited normally' }); } },
        (e) => { if (live === entry) { live = null; emitEvent('runtime.exited', { reason: e.message, failed: true }); } },
      );
      log(`CLI started cwd=${entry.workspaceRoot} model=${entry.model || '(default)'} resume=${entry.threadId || '(new session)'}`);
      return entry;
    })();
    try {
      await launching;
      return { reused: false, status: snapshot(), lastSeq: ring.lastSeq };
    } finally { launching = null; }
  }

  /** Single status shape used by ensure / attach / event piggyback. */
  function snapshot() {
    if (!live) return { running: false, stopping: false, initialized: false,
      requestedModel: '', actualModel: '', sessionId: '', workspaceRoot: '', threadId: '', model: '' };
    return { ...live.rt.status(), workspaceRoot: live.workspaceRoot,
      threadId: live.threadId, model: live.model };
  }

  // --- method table ---

  const methods = {
    ping: () => ({ ok: true, at: new Date().toISOString(), hasCli: Boolean(live) }),
    ensure,
    /** Reconnect: replay events missed while disconnected; report if the replay is incomplete. */
    attach({ lastSeq = 0 } = {}) {
      const missed = ring.since(Number(lastSeq));
      return {
        hasCli: Boolean(live),
        status: snapshot(),
        lastSeq: ring.lastSeq,
        /** null = gap already evicted; the box must reconcile from the ingress ledger */
        missed,
        complete: missed !== null,
      };
    },
    // Pass through as-is: the local runtime signature is enqueue({ message, origin, uuid })
    enqueue: (args) => requireLive().rt.enqueue(args.payload),
    start: () => requireLive().rt.start(),
    stop: () => (live ? live.rt.stop() : null),
    close: () => stopLive('box requested close'),
    get: (args) => requireLive().rt.get(args.uuid),
    list: (args) => requireLive().rt.list(args && args.state),
    status: () => (live ? { ...live.rt.status(), workspaceRoot: live.workspaceRoot,
      threadId: live.threadId, model: live.model } : { running: false, hasCli: false }),
    setModel: (args) => requireLive().rt.setModel(args.model),
  };

  function requireLive() {
    if (!live) throw new Error('no live CLI - call ensure first.');
    return live;
  }

  // --- connections ---

  function attachBox(sock) {
    if (box && box !== sock && !box.destroyed) {
      log('new box connected, dropping the old one (prevents double delivery)');
      try { box.destroy(); } catch {}
    }
    box = sock;
  }

  const server = net.createServer((sock) => {
    log('box connected');
    attachBox(sock);
    sock.setNoDelay(true);

    const push = createDecoder(async (frame) => {
      if (frame.t === REPLY) {
        const waiter = pending.get(frame.id);
        if (waiter) { pending.delete(frame.id); waiter.resolve(frame.ok ? frame.value : undefined); }
        return;
      }
      if (frame.t === CANCEL) {
        const waiter = pending.get(frame.id);
        if (waiter) { pending.delete(frame.id); waiter.resolve(undefined); }
        return;
      }
      if (frame.t !== CALL) return;
      if (!METHODS.has(frame.method)) {
        sendTo(sock, { t: REPLY, id: frame.id, ok: false,
          error: packError(new Error(`unknown method: ${frame.method}`)) });
        return;
      }
      try {
        const value = await methods[frame.method](frame.args || {});
        sendTo(sock, { t: REPLY, id: frame.id, ok: true, value: value === undefined ? null : value });
      } catch (e) {
        sendTo(sock, { t: REPLY, id: frame.id, ok: false, error: packError(e) });
      }
    }, (line, e) => warn('bad frame, skipped:', e.message, line.slice(0, 120)));

    sock.on('data', (chunk) => push(chunk.toString('utf8')));
    sock.on('error', (e) => warn('socket error:', e.message));
    sock.on('close', () => {
      if (box === sock) {
        box = null;
        // Intentionally nothing else: the CLI keeps running and events keep buffering for replay.
        log('box disconnected - CLI keeps running, events are buffered for replay');
      }
      // Resolve all pending reverse calls with the fallback so nothing hangs.
      for (const [id, w] of pending) { pending.delete(id); w.resolve(undefined); }
    });
  });

  return {
    async listen() {
      try { fs.unlinkSync(socketPath); } catch {}
      fs.mkdirSync(path.dirname(socketPath), { recursive: true });
      await new Promise((res, rej) => {
        server.once('error', rej);
        server.listen(socketPath, () => { server.removeListener('error', rej); res(); });
      });
      fs.chmodSync(socketPath, 0o600);
      log('listening on', socketPath);
    },
    async shutdown() {
      await stopLive('host exiting');
      server.close();
      try { fs.unlinkSync(socketPath); } catch {}
    },
    // for tests
    _internals: { ring, ensure, get live() { return live; } },
  };
}

module.exports = { createCliHost };
