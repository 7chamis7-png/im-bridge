"use strict";

/**
 * Receiver: shared logic for "what counts once a message has been fetched".
 *
 * Boundary: plugins only fetch from the platform; the cursor belongs to this
 * shared layer. If a plugin advanced its own cursor, a crash would lose those
 * messages forever (the platform thinks they were received, we kept nothing).
 *
 * Three rules:
 *
 * 1. Advance the cursor only after a message is fully handled. A crash
 *    mid-way leaves the cursor where it was, so the message is retried.
 *    Replaying one is acceptable; silently skipping one is not.
 *
 * 2. One unprocessable message must not block the whole channel (otherwise
 *    nothing the owner says gets through, with no visible reason). It goes to
 *    the dead-letter file with the raw record, the cursor advances, and it is
 *    logged loudly. Dead letters can be re-delivered, so this is not loss.
 *
 * 3. Never consume the same message twice. Platform redeliveries and our own
 *    replays are deduplicated by `native_id` in intake; this layer passes the
 *    raw record through unchanged.
 */

const fs = require("fs");
const path = require("path");

/** Cursor: one per channel, persisted. Path supplied by the caller. */
function makeCursorStore({ file }) {
  if (!String(file || "").trim()) throw new Error("游标要一个文件路径 —— 不许用默认值猜");
  return {
    /**
     * A cursor may be a number or an opaque string (Telegram: update_id;
     * other gateways: an opaque buffer). Stored and returned verbatim.
     */
    read() {
      try {
        const v = JSON.parse(fs.readFileSync(file, "utf8")).cursor;
        return v === undefined || v === null ? 0 : v;
      } catch { return 0; }
    },
    // write temp then rename: a power cut never leaves half a JSON cursor
    write(cursor) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ cursor, at: new Date().toISOString() }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
}

/** Dead letters: unprocessable raw records kept for a human. Append-only. */
function makeDeadLetter({ file }) {
  if (!String(file || "").trim()) throw new Error("死信要一个文件路径 —— 不许用默认值猜");
  return {
    put(entry) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", { encoding: "utf8", mode: 0o600 });
    },
    list() {
      try {
        return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      } catch { return []; }
    },
  };
}

/**
 * @param {object} o
 * @param {object} o.plugin      the channel plugin; must implement poll()
 * @param {object} o.cursor      cursor store (makeCursorStore)
 * @param {object} o.deadLetter  dead-letter store (makeDeadLetter)
 * @param {function} o.handle    (raw, meta) => Promise - handles one raw record.
 *   Throwing means it failed (-> dead letter); returning means success.
 * @param {function} [o.log]
 */
function makeReceiver({ plugin, cursor, deadLetter, handle, enabled = () => true, log = () => {} }) {
  if (!plugin || typeof plugin.poll !== "function") {
    throw new Error("这条腿的插头不会自己捞消息（缺 poll）—— 收信人没法工作");
  }
  if (typeof handle !== "function") throw new Error("收信人要一个 handle（一条记录怎么消化）");

  let stopped = false;
  const stats = { got: 0, ok: 0, dead: 0, ticks: 0 };

  /**
   * Fetch a batch, handle each item, advance the cursor per item.
   *
   * Per item rather than per batch: if item 3 fails, items 1-2 must not be
   * replayed (that would produce duplicate replies).
   */
  async function tick({ timeoutSec = 25 } = {}) {
    stats.ticks += 1;
    const since = cursor.read();
    if (!enabled()) return { got: 0, ok: 0, dead: 0, cursor: since, paused: true };
    const { items } = await plugin.poll({ since, timeoutSec });
    let ok = 0, dead = 0;
    for (const item of items || []) {
      if (stopped || !enabled()) break;
      stats.got += 1;
      // The next cursor value comes from the plugin (`item.cursor`); only it
      // knows its cursor format. Falls back to Telegram style (update_id + 1).
      const next = item.cursor !== undefined && item.cursor !== null
        ? item.cursor
        : Number(item.update_id) + 1;
      try {
        await handle(item.message ?? item, { channel: plugin.channel, nativeCursor: item.update_id });
        ok += 1; stats.ok += 1;
        cursor.write(next);                       // only after the item is fully handled
      } catch (e) {
        // Unprocessable: keep the raw record, move on, log loudly.
        // Blocking the whole channel is worse than parking one message.
        dead += 1; stats.dead += 1;
        deadLetter.put({
          channel: plugin.channel,
          cursor: item.update_id,
          error: String((e && e.message) || e),
          raw: item.message ?? item,
        });
        cursor.write(next);
        log(`[收信] ${plugin.channel} 有一条消化不了，已进死信、不卡后面的：${(e && e.message) || e}`);
      }
    }
    return { got: (items || []).length, ok, dead, cursor: cursor.read() };
  }

  return {
    tick,
    stats: () => ({ ...stats }),
    stop() { stopped = true; },
    /** Receive until stop(). Back off on errors instead of hammering the platform. */
    async run({ timeoutSec = 25, idleMs = 0, onError = null } = {}) {
      stopped = false;
      while (!stopped) {
        try {
          const result = await tick({ timeoutSec });
          if (result.paused) await new Promise((r) => setTimeout(r, 1000));
        } catch (e) {
          // Fetch failed (network / platform issue): not a per-message problem.
          // The cursor stays put; back off and retry. Never treat it as "no messages".
          if (onError) onError(e); else log(`[收信] ${plugin.channel} 捞不上来：${(e && e.message) || e}`);
          await new Promise((r) => setTimeout(r, 2000));
        }
        if (idleMs) await new Promise((r) => setTimeout(r, idleMs));
      }
    },
  };
}

module.exports = { makeReceiver, makeCursorStore, makeDeadLetter };
