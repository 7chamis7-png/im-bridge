"use strict";

/**
 * Box process (im-box) — owns the agent session.
 *
 * ```
 *   im-cli   →  the claude CLI lives here (cli-host/); the box connects via cli.sock
 *   im-box   →  this process: session / persona injection / reply journal
 *                 unix socket: <root>/box.sock
 *                        ▲
 *   im-gate  →  channel plugins + shared capabilities + cold log + routing
 * ```
 *
 * Why a separate process: if the CLI were a child of the bridge (talking over
 * pipes), every bridge restart would cut the agent off mid-turn and there is no
 * way to reattach to the old CLI's stdin/stdout. Split this way:
 *   · plugins / capabilities / routing / cold log → restart im-gate, agent unaffected
 *   · box / journal / persona injection           → restart im-box, agent unaffected (CLI is in im-cli)
 *   · new session / model change / im-cli changes → only these interrupt the agent
 *
 * ## Agent speaks while the bridge is down
 *
 * Replies are numbered and persisted in `box-journal.js`. The bridge acks a
 * sequence number only after it has fully processed it (cold log written,
 * outbound ledger created); only then is it cleared from the journal.
 *
 * ## Tools need no change
 *
 * The MCP tool shim connects per call (no long-lived connection), so after a
 * bridge restart the next tool call simply reaches the new bridge.
 *
 * ## One box serves one bridge
 *
 * A new connection replaces the previous one (normally the bridge restarted and
 * the old connection is dead). Two bridges driving one box is a config error.
 *
 * ## Wire format
 *
 * One JSON object per line; encoding and error packing come from
 * `cli-host/protocol.js` (same as cli.sock). Errors go through `packError` so
 * flags such as `notAccepted` survive the trip (see ERROR_FLAGS there).
 */

const fs = require("fs");
const net = require("net");
const path = require("path");

const { readConfig, BOXES } = require("./main");
const { loadPersona } = require("./persona");
const { buildBox } = require("./box-build");
const { BoxJournal } = require("./box-journal");
const { encode, createDecoder, packError } = require("../../cli-host/protocol");

const defaultLog = (m) => console.log(new Date().toISOString().slice(11, 19) + " | [box] " + m);

function writeLine(sock, obj) {
  try { sock.write(encode(obj)); return true; }
  catch { return false; }
}

/**
 * Expose a box on a unix socket for the bridge. Does not read config or build
 * the box (that is main()'s job), so tests can drive the wire behavior with a
 * fake box.
 *
 * @param {object} o.box       box with deliver / rotate / fullness / onReply / onTurnDone
 * @param {object} o.runtime   runtime (setModelForWorkspace / cancelTurn / describe / getTurnCapabilities)
 * @param {object} o.journal   BoxJournal
 * @param {string} o.sockFile  unix socket to listen on
 * @param {string} o.workspaceRoot  workspace for model changes / cancel
 * @param {string} [o.model]   configured model (needed for turnCapabilities)
 */
function serveBox({ box, runtime, journal, sockFile, workspaceRoot, model = "", log = defaultLog }) {
  /** Currently attached bridge connection, or null. The journal keeps recording either way. */
  let bridge = null;

  function emit(kind, payload) {
    const row = journal.append(kind, payload);
    if (bridge) {
      if (!writeLine(bridge, { ev: kind, seq: row.seq, payload })) {
        log(`write to bridge failed; #${row.seq} stays owed`);
      }
    } else {
      log(`bridge not attached; #${row.seq} (${kind}) recorded, ${journal.pending()} owed`);
    }
  }

  /**
   * Snapshot: fullness + runtime self-description.
   *
   * The bridge calls fullness()/describe() synchronously (/model, /status,
   * panel), so the box pushes snapshots and the bridge caches them. Losing one
   * is harmless (the next turn overwrites it), so snapshots are not journaled.
   */
  function snapshot() {
    const pick = (fn) => { try { return fn() || null; } catch { return null; } };
    return {
      fullness: pick(() => box.fullness()),
      describe: pick(() => (typeof runtime.describe === "function" ? runtime.describe() : null)),
      // Must be pushed too: without it the bridge falls back to
      // describe().capabilities (absent) and image handling silently diverges
      // from the in-process path when the fallback model differs.
      turnCapabilities: pick(() => (typeof runtime.getTurnCapabilities === "function"
        ? runtime.getTurnCapabilities({ model }) : null)),
    };
  }
  function pushState() {
    if (bridge) writeLine(bridge, { ev: "state", payload: snapshot() });
  }

  box.onReply((e) => emit("reply", e));
  box.onTurnDone((e) => { emit("done", e); pushState(); });

  // deliver / rotate are box methods; onReply / onTurnDone are pushed;
  // fullness goes through snapshots. The rest are for commands.
  const OPS = {
    async deliver({ env }) { return { ok: true, result: await box.deliver(env) }; },
    async rotate({ reason }) {
      const result = await box.rotate(reason);
      pushState();
      return { ok: true, result };
    },
    async fullness() { return { ok: true, result: snapshot().fullness }; },
    async trim(opts) {
      if (typeof box.trim !== "function") throw new Error("this box cannot trim the transcript");
      const result = await box.trim(opts || {});
      pushState();
      return { ok: true, result };
    },
    async reloadCli(opts) {
      if (typeof box.reloadCli !== "function") throw new Error("this box cannot reload the CLI");
      return { ok: true, result: await box.reloadCli(opts || {}) };
    },
    async setModel({ model: m }) {
      if (typeof runtime.setModelForWorkspace !== "function") throw new Error("this runtime cannot change models");
      await runtime.setModelForWorkspace({ workspaceRoot, model: m });
      pushState();
      return { ok: true, result: { model: m } };
    },
    async cancelTurn({ threadId, turnId }) {
      if (typeof runtime.cancelTurn !== "function") throw new Error("this runtime cannot cancel a running turn");
      await runtime.cancelTurn({ threadId: threadId || "", turnId: turnId || "", workspaceRoot });
      return { ok: true, result: {} };
    },
  };

  async function handle(sock, msg) {
    // Attach: this connection becomes the bridge; replay what it is owed.
    if (msg.op === "attach") {
      if (bridge && bridge !== sock) {
        log("new bridge connection; dropping the previous one");
        try { bridge.end(); } catch { /* already closed */ }
      }
      bridge = sock;
      // Bridge has seen a higher seq than ours (our counter was reset): jump up.
      if (journal.raiseTo(msg.since)) log(`bridge is at #${msg.since}, ahead of us; continuing from there`);
      const owed = journal.since(msg.since);
      writeLine(sock, { ok: true, op: "attach", lastSeq: journal.lastSeq(), owed: owed.length });
      pushState();
      for (const r of owed) writeLine(sock, { ev: r.kind, seq: r.seq, payload: r.payload, replay: true });
      log(`bridge attached (acked up to #${Number(msg.since) || 0})`
        + (owed.length ? `, replayed ${owed.length}` : ", nothing owed"));
      return;
    }

    // Ack: cleared only after the bridge has fully processed it.
    if (msg.op === "ack") {
      const n = journal.ack(msg.seq);
      if (n) writeLine(sock, { ok: true, op: "ack", cleared: n, pending: journal.pending() });
      return;
    }

    const fn = OPS[msg.op];
    if (!fn) { writeLine(sock, { id: msg.id, ok: false, error: packError(new Error("unknown op: " + msg.op)) }); return; }
    try {
      const r = await fn(msg);
      writeLine(sock, { id: msg.id, ...r });
    } catch (e) {
      // Report failures faithfully; never let the bridge assume delivery.
      writeLine(sock, { id: msg.id, ok: false, error: packError(e) });
      log(`${msg.op} failed: ${(e && e.message) || e}`);
    }
  }

  const server = net.createServer((sock) => {
    sock.setNoDelay(true);
    // Frames are handled in order (attach must take effect first); bad lines are reported, not fatal.
    let queue = Promise.resolve();
    const push = createDecoder(
      (msg) => { queue = queue.then(() => handle(sock, msg)).catch((e) => log("frame handling failed: " + ((e && e.message) || e))); },
      (line, e) => writeLine(sock, { ok: false, error: packError(new Error("not JSON: " + e.message + " " + line.slice(0, 80))) }),
    );
    sock.on("data", (chunk) => push(chunk.toString("utf8")));
    sock.on("error", (e) => log("connection error: " + ((e && e.message) || e)));
    sock.on("close", () => {
      if (bridge === sock) {
        bridge = null;
        log(`bridge detached; replies keep being journaled (${journal.pending()} owed)`);
      }
    });
  });

  async function listen() {
    try { fs.unlinkSync(sockFile); } catch { /* not there */ }
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockFile, () => { server.removeListener("error", reject); resolve(); });
    });
    fs.chmodSync(sockFile, 0o600);
  }

  function close() {
    try { server.close(); } catch { /* ignore */ }
    try { fs.unlinkSync(sockFile); } catch { /* ignore */ }
  }

  return { listen, close, pushState, _state: () => ({ attached: !!bridge, pending: journal.pending() }) };
}

async function main() {
  const log = defaultLog;
  const cfg = readConfig(process.env);
  const backend = BOXES[cfg.boxKind];
  if (!backend) throw new Error("unknown box kind: " + cfg.boxKind);

  const persona = loadPersona(cfg.persona, { name: cfg.personaName });
  const { runtime, box } = await buildBox({ cfg, backend, persona, log });

  const sockFile = process.env.GATE_BOX_SOCKET || path.join(cfg.root, "box.sock");
  const journal = new BoxJournal({ file: path.join(cfg.root, "box-journal.jsonl"), log });

  const served = serveBox({ box, runtime, journal, sockFile, workspaceRoot: cfg.workspaceRoot, model: cfg.model, log });
  await served.listen();

  log(`up; bridge connects to ${sockFile}`);
  log(`box ${cfg.boxKind}  workspace ${cfg.workspaceRoot}  binding ${cfg.bindingKey}`);
  if (journal.pending()) log(`⚠️ ${journal.pending()} replies still owed from last run; waiting for the bridge`);

  const bye = (sig) => {
    log(`${sig} received; shutting down. ${journal.pending()} owed replies are on disk.`);
    served.close();
    process.exit(0);
  };
  process.on("SIGINT", () => bye("SIGINT"));
  process.on("SIGTERM", () => bye("SIGTERM"));
}

if (require.main === module) {
  main().catch((e) => { console.error("[box] failed to start:", e); process.exit(1); });
}

module.exports = { main, serveBox };
