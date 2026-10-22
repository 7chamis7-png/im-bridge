"use strict";

/**
 * 盒子的出话记账本（2026-09-18 Alice：「插头坏了拔下来重新插就可以 没必要动盒子」）
 *
 * 盒子搬进自己的进程之后，桥可以随时重启。**重启那几秒他可能正在说话** ——
 * 那几句必须等得起桥回来，不能因为没人接就没了。
 *
 * 所以盒子说的每一句都先编号记在这儿，桥处理完回一句「我收到第几号了」，
 * 记账本才把它划掉。桥重连时报上次划到哪，从那儿往后补。
 *
 * **跟入站游标是同一个路子**（`cursor-telegram.json` 那套）：
 * 不靠"应该收到了"，靠"确认收到了"。
 *
 * 为什么不直接用「发出去就算」：桥在把他的话写进冷层 / 建出站账本之前就断了，
 * 那句话在桥这头等于没发生过。**划账必须在桥那头真办完之后**，不是在网线上。
 *
 * 落盘的理由：盒子自己也会重启（换舱 / 换模型 / 改盒子代码）。没落盘的话，
 * 盒子一重启，桥还没接走的那几句就真没了。
 */

const fs = require("fs");
const path = require("path");

/** 记账本里最多留多少条。桥正常在线时这个数永远是个位数。 */
const DEFAULT_CAP = 500;

class BoxJournal {
  /**
   * @param {object} o
   * @param {string} o.file   落盘位置
   * @param {number} [o.cap]  上限，超了丢最老的（并大声说，因为那就是真丢话了）
   * @param {function} [o.log]
   */
  constructor({ file, cap = DEFAULT_CAP, log = () => {} } = {}) {
    if (!file) throw new Error("记账本要给 file（不落盘的话盒子一重启就丢话）");
    this.file = file;
    this.cap = cap;
    this.log = log;
    this.seq = 0;
    this.rows = [];
    // 号码的高水位**单独落盘**（2026-09-20 修）。原来号只从账本里的行推出来 ——
    // 桥划完账账本就空了，盒子一重启号就从 1 重新数；而桥重连时报「我收到第 291 号」，
    // 盒子只补 >291 的，欠着的小号一条都不补 → 桥断着的时候他说的话会丢。
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
   * 桥说它已经收到第 n 号了，而我的号比它小（老版本重启归过零）——
   * 直接跳到 n，往后的新话才不会跟它记过的号撞。只往上跳，不往回拨。
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
    } catch { /* 第一次，没有 */ }
    let raw = "";
    try { raw = fs.readFileSync(this.file, "utf8"); } catch { return; }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (!o || typeof o.seq !== "number") continue;
        this.rows.push(o);
        if (o.seq > this.seq) this.seq = o.seq;
      } catch { /* 坏行跳过，不让一行挡住整本账 */ }
    }
  }

  #flush() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, this.rows.map((r) => JSON.stringify(r)).join("\n") + (this.rows.length ? "\n" : ""),
      { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, this.file);   // 换 inode，别原地改
  }

  /**
   * 记一句。返回带号的那条 —— **号是这儿发的**，盒子别自己编。
   * @param {string} kind  "reply" | "done"
   * @param {object} payload
   */
  append(kind, payload) {
    this.seq += 1;
    const row = { seq: this.seq, kind, at: new Date().toISOString(), payload };
    this.rows.push(row);
    if (this.rows.length > this.cap) {
      const dropped = this.rows.splice(0, this.rows.length - this.cap);
      // 这不是"清理"，这是**真丢了他说的话**。必须刺眼。
      this.log(`⚠️ 记账本满了（${this.cap}），丢掉 ${dropped.length} 条没人接的话`
        + `：${dropped.map((d) => "#" + d.seq).join(" ")} —— 桥是不是很久没上来了？`);
    }
    this.#flush();
    this.#writeSeq();
    return row;
  }

  /** 桥报「我处理到第 seq 号了」。**划账在这儿，不在发出去的那一刻。** */
  ack(seq) {
    const n = Number(seq) || 0;
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.seq > n);
    if (this.rows.length !== before) this.#flush();
    return before - this.rows.length;
  }

  /** 桥重连时：第 since 号之后的都还欠着，补给它。 */
  since(seq) {
    const n = Number(seq) || 0;
    return this.rows.filter((r) => r.seq > n);
  }

  /** 还欠着几条（面板用）。 */
  pending() { return this.rows.length; }

  lastSeq() { return this.seq; }
}

module.exports = { BoxJournal, DEFAULT_CAP };
