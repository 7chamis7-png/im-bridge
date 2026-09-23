"use strict";

/**
 * Remote box — the bridge-side stand-in for a box running in im-box.
 *
 * To the bridge it is just a box with the same five methods (`assertBox`
 * passes); the real CLI lives in another process (see box-host.js).
 *
 * Three things it must get right:
 * 1. Reconnect with backoff when the box restarts.
 * 2. No lost replies: on connect it reports the last seq it processed and the
 *    box replays from there. The cursor is persisted because the bridge
 *    restarts too.
 * 3. Ack only after processing: a reply is acked once its handlers resolved
 *    (cold log + outbound ledger written). Duplicates are absorbed by the
 *    outbound ledger's operationId idempotency — better twice than never.
 */

const fs = require("fs");
const net = require("net");
const path = require("path");
const { encode, createDecoder, unpackError } = require("../../cli-host/protocol");

const RETRY_MS = [200, 500, 1000, 2000, 5000];

function makeRemoteBox({ socketFile, cursorFile, log = () => {}, timeoutMs = 300_000 } = {}) {
  if (!socketFile) throw new Error("makeRemoteBox requires socketFile");
  if (!cursorFile) throw new Error("makeRemoteBox requires cursorFile (without it a bridge restart replays everything)");

  const replyHandlers = [];
  const doneHandlers = [];
  const pending = new Map();          // id → {resolve, reject, timer}
  let sock = null;
  let attempt = 0;
  let closed = false;
  let seq = readCursor();
  // Snapshot pushed by the box. fullness()/describe() are synchronous on the
  // bridge side, so they read this cache instead of asking over the socket.
  let state = { fullness: null, describe: null, turnCapabilities: null };

  function readCursor() {
    try { return Number(JSON.parse(fs.readFileSync(cursorFile, "utf8")).seq) || 0; }
    catch { return 0; }
  }
  function writeCursor(n) {
    const tmp = cursorFile + ".tmp";
    fs.mkdirSync(path.dirname(cursorFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify({ seq: n }), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, cursorFile);
  }

  function send(obj) {
    if (!sock || sock.destroyed) return false;
    try { sock.write(encode(obj)); return true; }
    catch { return false; }
  }

  /** One request/response. If the box is not connected, fail — never pretend it was delivered. */
  function ask(op, args = {}) {
    return new Promise((resolve, reject) => {
      if (!sock || sock.destroyed) return reject(new Error("box not connected (is im-box running?)"));
      const id = op + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`box did not answer ${op} within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      if (!send({ op, id, ...args })) {
        clearTimeout(timer); pending.delete(id);
        reject(new Error("write to box connection failed"));
      }
    });
  }

  /**
   * An event pushed by the box. Ack only after handlers finish (they are async:
   * the turn queue waits for the cold log and outbound ledger).
   */
  async function consume(kind, n, payload) {
    const hs = kind === "reply" ? replyHandlers : doneHandlers;
    for (const h of hs) {
      try { await h(payload); }
      catch (e) {
        // Handler failed: do not ack; the box replays it on reconnect.
        log(`handling #${n} (${kind}) failed; not acked, will be replayed: ${(e && e.message) || e}`);
        return;
      }
    }
    if (n > seq) { seq = n; writeCursor(seq); }
    send({ op: "ack", seq });
  }

  function connect() {
    if (closed) return;
    sock = net.createConnection(socketFile);
    sock.setNoDelay(true);

    sock.on("connect", () => {
      attempt = 0;
      log(`connected to box (acked up to #${seq})`);
      send({ op: "attach", since: seq });
    });

    let queue = Promise.resolve();      // process pushed events strictly in order
    const push = createDecoder((msg) => {
      if (msg.ev === "reply" || msg.ev === "done") {
        const { ev, seq: n, payload } = msg;
        queue = queue.then(() => consume(ev, n, payload)).catch(() => {});
        return;
      }
      if (msg.ev === "state") { state = msg.payload || state; return; }
      if (msg.op === "attach") {
        if (msg.owed) log(`box replayed ${msg.owed} missed events`);
        return;
      }
      if (msg.op === "ack") return;
      const p = msg.id && pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer); pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      // Unpack the full error: message / name / remote stack / whitelisted flags
      // (notAccepted → turn queue treats it as rejected and retries instead of
      // marking it unknown). Flag list: ERROR_FLAGS in protocol.js.
      else p.reject(unpackError(msg.error || "box request failed"));
    }, () => log("box sent a non-JSON line; dropped"));
    sock.on("data", (chunk) => push(chunk.toString("utf8")));

    const down = (why) => {
      if (closed) return;
      for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error("box disconnected: " + why)); }
      pending.clear();
      const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
      attempt += 1;
      log(`box disconnected (${why}); reconnecting in ${wait}ms`);
      setTimeout(connect, wait);
    };
    sock.on("error", (e) => { /* "close" follows; backoff happens there */ log("box connection error: " + ((e && e.message) || e)); });
    sock.once("close", () => down("close"));
  }

  connect();

  // ——— the five box methods (same shape as gate-box-claudecode) ———
  const box = {
    deliver: (env) => ask("deliver", { env }),
    rotate: (reason) => ask("rotate", { reason }),
    trim: (opts) => ask("trim", opts || {}),
    reloadCli: (opts) => ask("reloadCli", opts || {}),
    // Synchronous, same signature as a local box; reads the pushed snapshot.
    fullness: () => state.fullness,
    onReply(fn) { replyHandlers.push(fn); return () => replyHandlers.splice(replyHandlers.indexOf(fn), 1); },
    onTurnDone(fn) { doneHandlers.push(fn); return () => doneHandlers.splice(doneHandlers.indexOf(fn), 1); },
    /** Close (tests / graceful shutdown); not part of the box contract. */
    close() { closed = true; try { sock && sock.end(); } catch { /* already closed */ } },
    /** Diagnostics: connected? last acked seq. */
    _state: () => ({ connected: !!(sock && !sock.destroyed), seq, cached: state }),
  };

  /**
   * Runtime stand-in, only for commands (/model, /stop).
   *
   * The real runtime lives in the box process. Commands need `describe()`
   * (synchronous, served from the snapshot), `setModelForWorkspace` and
   * `cancelTurn` (forwarded). Deliberately no `initialize` / `close`: the box
   * process owns its own lifecycle.
   */
  const runtime = {
    describe: () => state.describe || {},
    // Called synchronously by image handling; see snapshot() in box-host.js.
    getTurnCapabilities: () => state.turnCapabilities || {},
    setModelForWorkspace: ({ model }) => ask("setModel", { model }),
    cancelTurn: ({ threadId, turnId } = {}) => ask("cancelTurn", { threadId, turnId }),
  };

  return { box, runtime };
}

module.exports = { makeRemoteBox };
