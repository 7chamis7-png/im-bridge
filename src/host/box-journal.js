"use strict";

/**
 * Reply journal for the box.
 *
 * With the box in its own process the bridge can restart at any time, possibly
 * while the agent is speaking. Every reply is numbered and persisted here; the
 * bridge acks a number after it has fully processed it (cold log written,
 * outbound ledger created) and only then is it cleared. On reconnect the bridge
 * reports the last number it acked and everything after it is replayed.
 *
 * Same idea as the inbound cursors: rely on "confirmed received", not "should
 * have arrived". Persisted because the box itself also restarts.
 */

const fs = require("fs");
const path = require("path");

/** Max rows kept. With the bridge online this stays in single digits. */
const DEFAULT_CAP = 500;

class BoxJournal {
  /**
   * @param {object} o
   * @param {string} o.file   journal file
   * @param {number} [o.cap]  cap; oldest rows are dropped beyond it (loudly — that is real data loss)
   * @param {function} [o.log]
   */
  constructor({ file, cap = DEFAULT_CAP, log = () => {} } = {}) {
    if (!file) throw new Error("BoxJournal requires file (without persistence replies are lost on box restart)");
    this.file = file;
    this.cap = cap;
    this.log = log;
    this.seq = 0;
    this.rows = [];
    // The sequence high-water mark is persisted separately. Deriving it from
    // journal rows alone resets it to 1 once everything is acked, and the
    // bridge (which remembers a higher number) would then skip new replies.
    this.seqFile = file + ".seq";
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.#load();
  }

  #writeSeq() {
    const tmp = this.seqFile + ".tmp";
    fs.writeFileSync(tmp, String(this.seq) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, this.seqFile);
  }

  /**
   * The bridge has seen #n but our counter is lower: jump to n so new numbers
   * do not collide. Only moves up, never down.
   */
  raiseTo(n) {
    const v = Number(n) || 0;
    if (v <= this.seq) return false;
    this.seq = v;
    this.#writeSeq();
    return true;
  }

  #load() {
    try {
      const saved = Number(String(fs.readFileSync(this.seqFile, "utf8")).trim());
      if (Number.isFinite(saved) && saved > this.seq) this.seq = saved;
    } catch { /* first run */ }
    let raw = "";
    try { raw = fs.readFileSync(this.file, "utf8"); } catch { return; }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (!o || typeof o.seq !== "number") continue;
        this.rows.push(o);
        if (o.seq > this.seq) this.seq = o.seq;
      } catch { /* skip bad lines */ }
    }
  }

  #flush() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, this.rows.map((r) => JSON.stringify(r)).join("\n") + (this.rows.length ? "\n" : ""),
      { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, this.file);   // atomic replace
  }

  /**
   * Record one event; returns the row with its assigned seq (numbers are issued here only).
   * @param {string} kind  "reply" | "done"
   * @param {object} payload
   */
  append(kind, payload) {
    this.seq += 1;
    const row = { seq: this.seq, kind, at: new Date().toISOString(), payload };
    this.rows.push(row);
    if (this.rows.length > this.cap) {
      const dropped = this.rows.splice(0, this.rows.length - this.cap);
      // This is real loss of agent output, so log it prominently.
      this.log(`⚠️ journal full (${this.cap}); dropped ${dropped.length} unacked rows`
        + `: ${dropped.map((d) => "#" + d.seq).join(" ")} — has the bridge been down for long?`);
    }
    this.#flush();
    this.#writeSeq();
    return row;
  }

  /** Bridge reports it has processed up to seq. Clearing happens here, not on send. */
  ack(seq) {
    const n = Number(seq) || 0;
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.seq > n);
    if (this.rows.length !== before) this.#flush();
    return before - this.rows.length;
  }

  /** On reconnect: everything after `since` is still owed. */
  since(seq) {
    const n = Number(seq) || 0;
    return this.rows.filter((r) => r.seq > n);
  }

  /** Number of owed rows. */
  pending() { return this.rows.length; }

  lastSeq() { return this.seq; }
}

module.exports = { BoxJournal, DEFAULT_CAP };
