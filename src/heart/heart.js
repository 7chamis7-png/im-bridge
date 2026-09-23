"use strict";

/**
 * heart — the part of the agent that "ticks on its own".
 *
 * One process, one table of beats. Each beat:
 *   1. decides when to fire next (`nextDelayMs()`, recomputed every round)
 *   2. checks whether firing is meaningful right now (its own criteria)
 *   3. fires by dropping a note into the producers directory (`tick()`)
 * The heart makes no decisions for the agent.
 *
 * Like every producer, it doesn't know the bridge: it only writes files, and
 * the bridge polls the directory. Restarting the heart never interrupts the
 * agent's session.
 *
 * Each beat runs its own loop with its own try/catch; a failing beat is logged
 * and backed off (doubling, capped at 10 minutes) without affecting others.
 */

const DEFAULT_MAX_BACKOFF_MS = 10 * 60 * 1000;

/**
 * @param {object} o
 * @param {Array}  o.beats  beats: { name, nextDelayMs(), async tick() }.
 *                          tick()'s return value is only logged; throwing = failure.
 * @param {function} [o.log]
 * @param {function} [o.sleep]  test hook
 */
function makeHeart({ beats = [], log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS } = {}) {
  if (!Array.isArray(beats) || !beats.length) throw new Error("heart needs at least one beat");
  for (const b of beats) {
    if (!b || typeof b.tick !== "function" || typeof b.nextDelayMs !== "function") {
      throw new Error("incomplete beat (needs name / nextDelayMs() / tick()): " + JSON.stringify(b && b.name));
    }
  }

  let stopped = false;
  /** Per-beat stats (for operators; exported via books()). */
  const books = new Map(beats.map((b) => [b.name, { ticks: 0, fails: 0, lastAt: 0, lastResult: null }]));

  async function runBeat(beat) {
    const book = books.get(beat.name);
    let backoff = 0;
    while (!stopped) {
      let wait;
      try {
        wait = Math.max(0, Number(beat.nextDelayMs()) || 0);
      } catch (e) {
        // Can't even compute the next delay: wait a minute rather than spin.
        log("[" + beat.name + "] nextDelayMs failed: " + ((e && e.message) || e));
        wait = 60_000;
      }
      if (backoff) wait = Math.max(wait, backoff);
      log("[" + beat.name + "] next in ~" + Math.round(wait / 1000) + "s");
      await sleep(wait);
      if (stopped) break;
      try {
        const r = await beat.tick();
        book.ticks += 1;
        book.lastAt = Date.now();
        book.lastResult = r || null;
        book.fails = 0;
        backoff = 0;
      } catch (e) {
        // Only this beat failed; back off (doubling) to avoid log spam.
        book.fails += 1;
        backoff = Math.min(maxBackoffMs, backoff ? backoff * 2 : 30_000);
        log("[" + beat.name + "] tick failed (" + book.fails + " in a row): "
          + ((e && e.message) || e) + "; backing off " + Math.round(backoff / 1000) + "s");
      }
    }
    log("[" + beat.name + "] stopped");
  }

  return {
    /** Beats run independently. */
    async run() {
      log("heart started, " + beats.length + " beat(s): " + beats.map((b) => b.name).join(" · "));
      await Promise.all(beats.map((b) => runBeat(b)));
    },
    stop() { stopped = true; },
    /** Fire one beat manually (tests / debugging). */
    async tickOnce(name) {
      const beat = beats.find((b) => b.name === name);
      if (!beat) throw new Error("no such beat: " + name);
      return beat.tick();
    },
    /** Current per-beat stats. */
    books() {
      const out = {};
      for (const [k, v] of books) out[k] = { ...v };
      return out;
    },
  };
}

module.exports = { makeHeart, DEFAULT_MAX_BACKOFF_MS };
