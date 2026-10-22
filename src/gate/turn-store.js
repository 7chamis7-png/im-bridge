"use strict";

// Operational inbox, separate from the four-field conversation archive.
// A queued task is safe to submit. A task interrupted across the box boundary
// is unknown until reconciled; recording an input is not an execution receipt.
const fs = require("fs");
const path = require("path");

class TurnStore {
  constructor({ file, keepSettled = 300 }) {
    this.file = file;
    this.keepSettled = Math.max(1, Number(keepSettled) || 300);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try { this.rows = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (e) { if (e.code !== "ENOENT") throw e; this.rows = {}; }
    if (!this.rows || Array.isArray(this.rows) || typeof this.rows !== "object"
      || Object.values(this.rows).some((r) => !r || typeof r.id !== "string" || !r.envelope || !r.state)) {
      throw new Error("轮次账本结构损坏，不能当成空队列继续");
    }
  }

  save() {
    const tmp = this.file + ".tmp-" + process.pid;
    const fd = fs.openSync(tmp, "w", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(this.rows)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file);
  }

  get(id) { return this.rows[id] || null; }
  list() { return Object.values(this.rows); }
  byTurn(turnId, threadId) {
    if (!turnId) return null;
    return this.list().find((r) => r.turnId === turnId && (!threadId || !r.threadId || r.threadId === threadId)) || null;
  }
  ensure(envelope, route) {
    const id = envelope.trace_id;
    if (!id || typeof id !== "string") throw new Error("轮次缺少 trace_id");
    if (this.get(id)) return { row: this.get(id), duplicate: true };
    const at = new Date().toISOString();
    const row = { id, schema_version: 1, envelope, route, state: "queued", queuedAt: at, updatedAt: at };
    this.rows[id] = row;
    const pruned = this.#pruneSettled();
    try { this.save(); } catch (e) {
      delete this.rows[id];
      for (const r of pruned) this.rows[r.id] = r;
      throw e;
    }
    return { row, duplicate: false };
  }

  /**
   * 同 outbox：只丢**已有结论**的（completed/failed），从最老的丢起。
   * 2026-10-22：rejected 不再算「有结论」—— 它现在是「等自动重投 / 等她在 /pending 里决定」，
   * 丢了就是悄悄吞掉她一句话。
   * 任何 queued/submitting/accepted/unknown 一条都不丢 —— unknown 正是等人核对的。
   * 代价同样是「很久以前的 trace_id 不再去重」，保留 300 条远大于真实重投窗口。
   */
  #pruneSettled() {
    const settled = this.list()
      .filter((r) => ["completed", "failed"].includes(r.state))
      .sort((a, b) => String(a.updatedAt || a.queuedAt || "").localeCompare(String(b.updatedAt || b.queuedAt || "")));
    const excess = settled.length - this.keepSettled;
    if (excess <= 0) return [];
    const dropped = settled.slice(0, excess);
    for (const r of dropped) delete this.rows[r.id];
    return dropped;
  }
  update(id, changes) {
    const prior = this.get(id);
    if (!prior) throw new Error("未知轮次 " + id);
    const row = { ...prior, ...changes, updatedAt: new Date().toISOString() };
    this.rows[id] = row;
    try { this.save(); } catch (e) { this.rows[id] = prior; throw e; }
    return row;
  }
  recover() {
    for (const row of this.list()) {
      if (["submitting", "accepted"].includes(row.state)) {
        this.update(row.id, { state: "unknown", reason: "进程中断；盒子是否完成需要核对，不自动重投" });
      }
    }
  }
}

module.exports = { TurnStore };
