"use strict";

/**
 * The small, local delivery journal used by the outbound gate.
 *
 * There is deliberately no queue worker here.  The journal records the plan
 * and every boundary around a platform side effect; the gate remains the only
 * code that sends.  A single atomic JSON file is sufficient for this purpose
 * and also makes a crashed operation inspectable without another dependency.
 */

const fs = require("fs");
const path = require("path");

function atomicWrite(file, value) {
  const tmp = file + ".tmp-" + process.pid + "-" + Math.random().toString(16).slice(2);
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2), "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

class Outbox {
  constructor({ root = null, store = null, undelivered = null, file = null, keepSettled = 300 } = {}) {
    this.keepSettled = Math.max(1, Number(keepSettled) || 300);
    root = root || (store && store.root);
    if (!String(root || "").trim()) throw new Error("出站 outbox 要一个存储目录（root）");
    this.root = root;
    this.file = file || path.join(root, "outbox.json");
    this.store = store;
    this.undelivered = undelivered;
    this.data = this.#load();
    this.recoverStale();
    this.attachUndelivered(undelivered);
  }

  #load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!parsed || !parsed.operations || typeof parsed.operations !== "object") throw new Error("outbox 结构损坏");
      return parsed;
    } catch (error) {
      if (error && error.code === "ENOENT") return { version: 1, operations: {} };
      throw new Error("无法读取出站 outbox：" + ((error && error.message) || error));
    }
  }

  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    atomicWrite(this.file, this.data);
  }

  get(operationId) {
    return this.data.operations[String(operationId)] || null;
  }

  has(operationId) {
    return !!this.get(operationId);
  }

  create(record) {
    const key = String(record.operationId);
    const existing = this.get(key);
    if (existing) return clone(existing);
    const before = this.data.operations[key];
    this.data.operations[key] = clone(record);
    const pruned = this.#pruneSettled();
    try { this.#save(); } catch (error) {
      if (before) this.data.operations[key] = before; else delete this.data.operations[key];
      for (const op of pruned) this.data.operations[String(op.operationId)] = op;
      throw error;
    }
    return clone(this.data.operations[key]);
  }

  update(operationId, patch) {
    const key = String(operationId);
    const current = this.data.operations[key];
    if (!current) throw new Error("outbox 中没有 operationId: " + key);
    this.data.operations[key] = { ...current, ...clone(patch), updatedAt: new Date().toISOString() };
    try { this.#save(); } catch (error) { this.data.operations[key] = current; throw error; }
    return clone(this.data.operations[key]);
  }

  updateSegment(operationId, index, patch) {
    const op = this.get(operationId);
    if (!op || !Array.isArray(op.segments) || !op.segments[index]) {
      throw new Error(`outbox 中没有 segment: ${operationId}/${index}`);
    }
    const segments = op.segments.map((s, i) => i === index ? { ...s, ...clone(patch) } : s);
    return this.update(operationId, { segments });
  }

  /**
   * A process can die after persisting "running" or "submitted" and before
   * the platform answers.  Those operations are facts of unknown delivery;
   * changing them to unknown is the only safe restart action.
   */
  recoverStale() {
    const before = clone(this.data);
    const recovered = [];
    for (const op of Object.values(this.data.operations)) {
      const stale = op.state === "running" || op.state === "submitted"
        || (Array.isArray(op.segments) && op.segments.some((s) => s.state === "running" || s.state === "submitted"));
      if (!stale) continue;
      op.state = "unknown";
      delete op.result;
      op.reason = op.reason || "进程在投递完成前退出，结果不明";
      op.recoveredAt = new Date().toISOString();
      op.recoveryNoted = false;
      if (Array.isArray(op.segments)) {
        op.segments = op.segments.map((s) => (s.state === "running" || s.state === "submitted")
          ? { ...s, state: "unknown", error: s.error || op.reason } : s);
      }
      recovered.push(op);
    }
    if (recovered.length) {
      try { this.#save(); } catch (error) { this.data = before; throw error; }
    }
    for (const op of recovered) {
      this.store?.appendEvent({
        kind: "outbound.recovered_unknown",
        operationId: op.operationId,
        outputId: op.outputId,
        turnId: op.turnId,
        coldId: op.coldId,
        intent: op.payload && op.payload.intent,
        channel: op.payload && op.payload.channel,
        chatId: op.payload && op.payload.chatId,
        reason: op.reason,
        segments: (op.segments || []).map(({ text, receipt, ...meta }) => meta),
      });
    }
    this.attachUndelivered(this.undelivered);
    return recovered;
  }

  attachUndelivered(undelivered) {
    if (!undelivered) return [];
    const before = clone(this.data);
    const exposed = [];
    for (const op of Object.values(this.data.operations)) {
      if (op.state !== "unknown" || !op.recoveredAt || op.recoveryNoted) continue;
      undelivered.note({ state: "unknown", operationId: op.operationId, outputId: op.outputId, turnId: op.turnId,
        intent: op.payload && op.payload.intent, channel: op.payload && op.payload.channel,
        chatId: op.payload && op.payload.chatId, text: op.payload && op.payload.text, reason: op.reason,
        coldId: op.coldId, segments: op.segments });
      op.recoveryNoted = true;
      exposed.push(op);
    }
    if (exposed.length) {
      try { this.#save(); } catch (error) { this.data = before; throw error; }
    }
    return exposed;
  }

  /**
   * 账本只增不减的话，每发一段话都要把整个文件重写一遍，跑几个月就变成负担。
   *
   * 只丢**已经有结论**的那些（sent/failed/blocked/silent…），而且从最老的丢起。
   * `unknown` 和任何还在途中的一条都不丢 —— 那些正是需要人来核对的。
   *
   * 代价说在前面：这份账本同时充当「同一个 operationId 别投第二遍」的去重依据，
   * 丢掉旧记录等于放弃对那些**很久以前**的 operationId 的去重。保留 300 条
   * （默认）远大于任何真实的重试窗口，所以换来的文件大小是划算的。
   */
  #pruneSettled() {
    const inFlight = new Set(["running", "submitted", "unknown"]);
    const settled = Object.values(this.data.operations)
      .filter((op) => !inFlight.has(op.state))
      .filter((op) => !(op.state === "unknown" || op.recoveryNoted === false))
      .sort((a, b) => String(a.updatedAt || a.createdAt || "").localeCompare(String(b.updatedAt || b.createdAt || "")));
    const excess = settled.length - this.keepSettled;
    if (excess <= 0) return [];
    const dropped = settled.slice(0, excess);
    for (const op of dropped) delete this.data.operations[String(op.operationId)];
    return dropped;
  }

  all() {
    return Object.values(this.data.operations).map(clone);
  }
}

module.exports = { Outbox, DurableOutbox: Outbox, atomicWrite };
