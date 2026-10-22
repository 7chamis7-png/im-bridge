"use strict";

/**
 * 生产者投递口（2026-09-18）—— 桥外面的东西怎么推一轮进来
 *
 * SPEC §1：**晨笺那些是事件生产者，不是桥的一部分。删掉 check-in，桥照样活。**
 * 所以它们不该住在桥的进程里，也不该认识 runtime —— 它们只做两件事：
 * 按自己的判据决定「该推一轮了」，然后往这个口投一条。
 *
 * ## 为什么是「一条一个文件」而不是一个 JSON 数组
 *
 * 老桥的 `system-message-queue.json` 是单文件：`load → push → save`。
 * 现在只有一个进程写（poller 长在 app.js 里），所以没事。但**生产者一变成
 * 独立进程，两个同时 enqueue 就会丢消息** —— 后写的那个把先写的覆盖掉，
 * 而且悄无声息。这是把生产者搬出去之后必然踩到的坑，所以这里不抄它。
 *
 * 一条一个文件 + `tmp → rename`：rename 在同一文件系统上是原子的，
 * 多少个生产者同时投都不会互相覆盖，也不需要锁。
 *
 * ## 消化完了才算数
 *
 * 跟入站游标同一条纪律（SPEC §5）：**投进盒子了才删文件**。
 * 进程崩在中间，重启后那条还在，会被再投一次 —— 宁可重来不可丢。
 * 幂等靠 `id`：桥记得投过哪些，重复的直接跳过。
 *
 * ## 桥不认识生产者是谁
 *
 * `producer` 是自由文本（"checkin" / "晨勃" / 随便什么），桥**不校验、不枚举**
 * （铁律 2/3）。以后加一个新的生产者，桥一行不用改。
 */

const fs = require("fs");
const path = require("path");

/**
 * 同一进程内的投递序号。
 *
 * 文件名只到毫秒，**同一毫秒投的两条就只能按随机 id 排** —— 2026-09-18 测试当场抓到：
 * 一口气投 20 条，出来的顺序是乱的。加这个计数器把同毫秒的并列打破。
 *
 * ⚠️ **跨进程同一毫秒的顺序仍然不保证**，而且不该保证 —— 两个独立生产者在同一毫秒
 * 各投一条，它们之间本来就没有真实先后。需要严格全序的东西不该走这个口。
 */
let seq = 0;

/** 一条投递长什么样。缺哪样当场说清楚，不许默默丢。 */
function assertNote(note) {
  if (!note || typeof note !== "object") throw new Error("投递不是个对象");
  const text = String(note.text || "").trim();
  if (!text) throw new Error("投递没有正文 —— 空轮不许进盒子（他会自己脑补）");
  if (!String(note.producer || "").trim()) {
    throw new Error("投递要说清楚是谁推的（producer）—— 出了事得知道找谁");
  }
  return note;
}

/**
 * 生产者那一头：往桥的投递口放一条。
 *
 * **这个函数是给桥外面的进程用的**，它不 require 桥的任何东西（拷走能跑）。
 * @param {object} o
 * @param {string} o.dir      投递目录（桥和生产者约好的一个路径）
 * @param {string} o.producer 谁推的。自由文本，桥不认识它的值
 * @param {string} o.text     正文
 * @param {object} [o.target] 落点 { platform, chat_id }。**只有系统生产者可以给**
 * @returns {{id:string, file:string}}
 */
function putNote({ dir, producer, text, target = null }) {
  if (!String(dir || "").trim()) throw new Error("投递要一个目录 —— 不许用默认值猜");
  const note = assertNote({
    id: "n-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
    at: new Date().toISOString(),
    producer: String(producer || "").trim(),
    text: String(text || "").trim(),
    ...(target ? { target } : {}),
  });
  fs.mkdirSync(dir, { recursive: true });
  // 文件名带时间戳 + 同进程序号 = 目录列出来就是时间顺序，桥不用读内容就能排
  seq = (seq + 1) % 1e6;
  const name = note.at.replace(/[:.]/g, "-")
    + "-" + String(seq).padStart(6, "0")
    + "-" + note.id + ".json";
  const finalPath = path.join(dir, name);
  const tmp = path.join(dir, "." + name + ".tmp-" + process.pid);
  fs.writeFileSync(tmp, JSON.stringify(note, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, finalPath);          // ← 原子，多个生产者同时投也不会互相覆盖
  return { id: note.id, file: finalPath };
}

/**
 * 桥那一头：收生产者投进来的东西。
 *
 * @param {object} o
 * @param {string} o.dir
 * @param {string} [o.seenFile] 投过哪些（幂等）。默认在 dir 底下
 * @param {number} [o.maxSeen]  记住多少条 id，防它无限长
 */
function makeProducerInbox({ dir, seenFile = "", maxSeen = 2000 } = {}) {
  if (!String(dir || "").trim()) throw new Error("投递口要一个目录 —— 不许用默认值猜");
  const seenPath = seenFile || path.join(dir, ".seen.json");
  fs.mkdirSync(dir, { recursive: true });

  const loadSeen = () => {
    try {
      const a = JSON.parse(fs.readFileSync(seenPath, "utf8"));
      return Array.isArray(a) ? a : [];
    } catch { return []; }
  };
  const saveSeen = (list) => {
    const tail = list.slice(-maxSeen);
    const tmp = seenPath + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(tail), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, seenPath);
  };

  return {
    /** 现在攒了几条（不消化，只数）。守护件看这个判断有没有堵住。 */
    pending() {
      try {
        return fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith(".")).length;
      } catch { return 0; }
    },

    /**
     * 把攒的逐条消化掉。
     *
     * @param {function} handle 一条怎么消化：`(note) => Promise`。
     *   **抛错 = 这条没消化成**，文件留着下次再来（宁可重来不可丢）。
     * @returns {{ok:number, failed:number, skipped:number}}
     */
    async drain(handle) {
      if (typeof handle !== "function") throw new Error("投递口要一个 handle（一条怎么消化）");
      let files;
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("."));
      } catch { return { ok: 0, failed: 0, skipped: 0 }; }
      files.sort();                                  // 文件名带时间戳 = 时间顺序
      const seen = new Set(loadSeen());
      const added = [];
      let ok = 0, failed = 0, skipped = 0;

      for (const f of files) {
        const full = path.join(dir, f);
        let note;
        try {
          note = JSON.parse(fs.readFileSync(full, "utf8"));
          assertNote(note);
        } catch {
          // 坏文件：**不许它卡住后面的**，也不许无声消失
          fs.renameSync(full, full + ".bad");
          failed += 1;
          continue;
        }
        if (note.id && seen.has(note.id)) {          // 投过了（上次崩在删文件之前）
          fs.unlinkSync(full);
          skipped += 1;
          continue;
        }
        try {
          await handle(note);
        } catch {
          failed += 1;
          continue;                                  // 文件留着，下次再来
        }
        // ==== 消化完了才删 ====
        if (note.id) { seen.add(note.id); added.push(note.id); }
        try { fs.unlinkSync(full); } catch { /* 删不掉下次靠 seen 跳过 */ }
        ok += 1;
      }
      if (added.length) saveSeen([...loadSeen(), ...added]);
      return { ok, failed, skipped };
    },
  };
}

module.exports = { putNote, makeProducerInbox, assertNote };
