"use strict";

/**
 * Event ledger (inbound numbering and identity normalization).
 *
 * Two key decisions:
 *
 * 1. Sequence numbers are assigned when an event is DELIVERED to the agent,
 *    not when it is received. Otherwise undelivered group messages, filtered
 *    or merged deliveries create legitimate gaps, and "a gap means something
 *    forged" stops being a usable signal. The agent always sees 1, 2, 3...
 *
 * 2. One sequence per numbering scope, shared across channels and persisted
 *    across restarts. If WeChat #42 and Telegram #42 were numbered separately,
 *    a reference to #42 could hit the wrong message without anyone noticing.
 *
 * Storage: append-only event log + atomically written state file; no extra
 * dependencies. All writes use tmp + rename.
 */

const fs = require("fs");
const path = require("path");

/** No hard-coded default root: the caller must supply it. */


function nowIso() {
  return new Date().toISOString();
}

function atomicWrite(file, text) {
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

class GateStore {
  constructor({ root } = {}) {
    if (!String(root || "").trim()) throw new Error("GateStore 要一个存储目录（root）—— 不许用默认值猜");
    this.root = root;
    this.eventsFile = path.join(root, "events.jsonl");
    this.stateFile = path.join(root, "state.json");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.state = this.#loadState();
    // Last real inbound / outbound per channel, so /status shows at a glance which
    // channel went quiet. No active probes (test messages can trip platform
    // anti-spam); derived only from events already in the ledger.
    this.lastSeenByChannel = {};
    this.nativeIndex = this.#loadNativeIndex();
  }

  #noteLastSeen(ev) {
    const ch = ev && ev.channel;
    if (!ch) return;
    if (ev.kind === "user_input.delivered") {
      const at = ev.registeredAt || ev.at;
      if (at) (this.lastSeenByChannel[ch] ||= {}).in = at;
    } else if (ev.kind === "outbound.confirmed") {
      if (ev.at) (this.lastSeenByChannel[ch] ||= {}).out = ev.at;
    }
  }

  /** { [channel]: { in?: ISO, out?: ISO } } - last real inbound / outbound */
  lastSeen() {
    const out = {};
    for (const [ch, v] of Object.entries(this.lastSeenByChannel)) out[ch] = { ...v };
    return out;
  }

  #loadState() {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      // seqByScope: scope -> highest assigned user_seq
      return { seqByScope: {}, eventCount: 0 };
    }
  }

  #saveState() {
    atomicWrite(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  /** Native message ids are scoped to account AND conversation. */
  static nativeKey(ev) {
    return JSON.stringify([ev.channel, ev.accountId || "", ev.chatId || "", ev.nativeId || ""]);
  }

  #loadNativeIndex() {
    const idx = new Map();
    let raw;
    try {
      raw = fs.readFileSync(this.eventsFile, "utf8");
    } catch {
      return idx;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.nativeId) idx.set(GateStore.nativeKey(ev), ev);
      this.#noteLastSeen(ev);
      // The append can succeed before state.json is replaced. Rebuild sequence
      // high-water marks from the journal so a crash cannot reuse a number.
      if (ev.sequenceScope && Number.isFinite(ev.userSeq)) {
        this.state.seqByScope[ev.sequenceScope] = Math.max(this.state.seqByScope[ev.sequenceScope] || 0, ev.userSeq);
      }
    }
    return idx;
  }

  #append(ev) {
    fs.appendFileSync(this.eventsFile, JSON.stringify(ev) + "\n", { encoding: "utf8", mode: 0o600 });
    // every write goes through here (user_input.delivered bypasses appendEvent), so track last-seen here
    this.#noteLastSeen(ev);
  }

  /**
   * Register an inbound event. user_seq is NOT assigned here.
   * Re-registering the same nativeId returns the original event (redelivery
   * never consumes a second number).
   */
  registerInbound(delivery, verdict) {
    const key = GateStore.nativeKey(delivery);
    if (delivery.nativeId && this.nativeIndex.has(key)) {
      return { event: this.nativeIndex.get(key), duplicate: true };
    }
    this.state.eventCount += 1;
    const ev = {
      eventId: "ev-" + Date.now().toString(36) + "-" + this.state.eventCount,
      kind: "user_input",
      channel: delivery.channel,
      accountId: delivery.accountId || "",
      senderId: delivery.senderId || "",
      chatId: delivery.chatId || "",
      chatType: delivery.chatType || "private",
      nativeId: delivery.nativeId || "",
      receivedAt: delivery.receivedAt || nowIso(),
      registeredAt: nowIso(),
      processing: delivery.processing || [],
      text: delivery.text || "",
      media: delivery.media || [],
      verdict: verdict.verdict,
      verifyReasons: verdict.reasons || [],
      identity: delivery.identity || "unknown",
      userSeq: null,        // assigned on delivery
      deliveredAt: null,
      state: "registered",
    };
    this.#append(ev);
    if (ev.nativeId) this.nativeIndex.set(key, ev);
    this.#saveState();
    return { event: ev, duplicate: false };
  }

  /**
   * Assign user_seq at delivery time. Only real user input consumes numbers;
   * model output, tool results and system wake-ups do not.
   */
  assignSeqOnDeliver(ev, scope) {
    if (ev.userSeq != null) return ev.userSeq;
    const cur = this.state.seqByScope[scope] || 0;
    const next = cur + 1;
    const assigned = { ...ev, userSeq: next, sequenceScope: scope, deliveredAt: nowIso(), state: "delivered" };
    this.#append({ ...assigned, kind: "user_input.delivered" });
    Object.assign(ev, assigned);
    this.state.seqByScope[scope] = next;
    this.#saveState();
    return next;
  }

  maxSeq(scope) {
    return this.state.seqByScope[scope] || 0;
  }

  /** Fetch the original by number so the outbound gate can verify a #N reference. */
  findBySeq(scope, seq) {
    let raw;
    try {
      raw = fs.readFileSync(this.eventsFile, "utf8");
    } catch {
      return null;
    }
    let found = null;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.sequenceScope === scope && ev.userSeq === seq) found = ev;
    }
    return found;
  }

  appendEvent(ev) {
    this.state.eventCount += 1;
    const full = { eventId: "ev-" + Date.now().toString(36) + "-" + this.state.eventCount, at: nowIso(), ...ev };
    this.#append(full);
    this.#saveState();
    return full;
  }
}

module.exports = { GateStore };
