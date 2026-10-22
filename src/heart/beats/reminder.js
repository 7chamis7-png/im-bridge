"use strict";

/**
 * 提醒到期 —— 心脏的第二拍（2026-09-19 新写）
 *
 * 他自己给自己设的闹钟（`nova_reminder_create`）到点了，把原话递回给他。
 * **递的是他自己写给自己的话**，所以这一拍连措辞都不该加工：加时间、加原文，完。
 *
 * ## 为什么只读队列、不写
 *
 * 队列文件 `reminder-queue.json` 还有**另一个写手**：盒子那头的工具（他随时会设新提醒）。
 * 老桥是单进程所以怎么读改写都行；现在心脏是另一个进程，两边「读—改—写」一撞，
 * **他刚设的提醒会被心脏的旧快照覆盖掉，而且悄无声息**。
 *
 * 所以这一拍**一个字节都不往队列里写**，投过哪些记在自己的 `heart-fired.json` 里。
 * 代价是队列里已触发的条目要等工具那头自己清（老桥的 `listDue` 是取出即删）；
 * 换来的是零竞态 —— 宁可多留几条死账，不可吞掉他刚设的提醒。
 *
 * ## 过太久的不补投
 *
 * 提醒的语义是「**必须在 T 时刻发生**」（跟意图卡的「有空再说」正相反，
 * 见 tool-host 里那句区分）。T 过去很久之后再推，事情早就没了意义
 * —— 9-19 凌晨切桥断了一天，积了 4 条：昨晚 23:00 的熄灯号、小镇零点抢版面、
 * 今早 08:01 抢版面。这些补推给他只会让他对着一个过去的时间困惑。
 *
 * 所以：**过期超过 `staleAfterMs`（默认 2 小时）的不投，只记一笔账**（日志 + fired 记
 * 一个 missed），让我和Alice看得见错过了什么。门槛可调，判据写在这儿不藏在代码缝里。
 *
 * ## 一次最多投几条
 *
 * 积压一次全投 = 连着推他好几轮。默认一次最多 2 条，剩下的下一轮（30 秒后）再说。
 */

const fs = require("fs");
const path = require("path");
const { putNote } = require("../../gate/producers");

const DEFAULT_SCAN_MS = 30 * 1000;
const DEFAULT_STALE_AFTER_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_PER_TICK = 2;

/** 京时 —— 这台机跑 CEST，别让她自己换算。 */
function bj(ms) {
  return new Date(ms + 8 * 3600e3).toISOString().slice(5, 16).replace("T", " ");
}

function readQueue(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = Array.isArray(j) ? j : (j.reminders || j.items || []);
    return Array.isArray(list) ? list : [];
  } catch { return []; }   // 读不到就是没有，不炸
}

function readFired(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return { fired: new Set(j.fired || []), missed: j.missed || [] };
  } catch { return { fired: new Set(), missed: [] }; }
}

/** 自己这本账才写，写法是 tmp → rename（原子，半截文件读回来会当成空账重投）。 */
function saveFired(file, { fired, missed }, maxKeep = 500) {
  const body = JSON.stringify({
    fired: [...fired].slice(-maxKeep),
    missed: missed.slice(-100),
  }, null, 1);
  const tmp = file + ".tmp-" + process.pid;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

/** 递给他的那一条。**只有时间和他自己的原话。** */
function buildNote(reminder, { now = Date.now() } = {}) {
  const due = Number(reminder.dueAtMs) || 0;
  const late = due ? Math.round((now - due) / 60000) : 0;
  const head = "提醒到点了（你自己设的，" + bj(due) + " 京时"
    + (late >= 2 ? "，晚了 " + late + " 分钟" : "") + "）：";
  return head + "\n\n" + String(reminder.text || "").trim();
}

/**
 * @param {object} o
 * @param {string} o.dir        投递目录（跟桥约好的）
 * @param {string} o.queueFile  reminder-queue.json（**只读**）
 * @param {string} o.firedFile  自己这本账
 */
function makeReminderBeat({ dir, queueFile, firedFile, scanMs = DEFAULT_SCAN_MS,
  staleAfterMs = DEFAULT_STALE_AFTER_MS, maxPerTick = DEFAULT_MAX_PER_TICK,
  log = () => {}, now = () => Date.now() } = {}) {
  if (!String(dir || "").trim()) throw new Error("提醒拍要一个投递目录 —— 不许用默认值猜");
  if (!String(queueFile || "").trim()) throw new Error("提醒拍要知道队列文件在哪");
  if (!String(firedFile || "").trim()) throw new Error("提醒拍要一本自己的账（投过哪些）");

  return {
    name: "reminder",
    nextDelayMs: () => scanMs,
    async tick() {
      const t = now();
      const book = readFired(firedFile);
      const due = readQueue(queueFile)
        .filter((r) => r && r.id && Number(r.dueAtMs) && Number(r.dueAtMs) <= t)
        .filter((r) => !book.fired.has(r.id))
        .sort((a, b) => a.dueAtMs - b.dueAtMs);
      if (!due.length) return { due: 0 };

      let sent = 0, missed = 0, dirty = false;
      for (const r of due) {
        if (sent >= maxPerTick) break;
        const lateMs = t - Number(r.dueAtMs);
        if (staleAfterMs && lateMs > staleAfterMs) {
          // 过太久了：**不投**，记一笔账。他没收到，但我和她看得见。
          book.fired.add(r.id);
          book.missed.push({ id: r.id, dueAt: bj(Number(r.dueAtMs)), lateMin: Math.round(lateMs / 60000),
            text: String(r.text || "").slice(0, 80) });
          missed += 1; dirty = true;
          log("[reminder] 过太久不补投（晚了 " + Math.round(lateMs / 3600000) + " 小时）："
            + String(r.text || "").slice(0, 40));
          continue;
        }
        // **投成功才记账**（跟入站游标同一条纪律：消化完了才算数）。
        putNote({ dir, producer: "reminder", text: buildNote(r, { now: t }) });
        book.fired.add(r.id);
        sent += 1; dirty = true;
        log("[reminder] 递了一条：" + String(r.text || "").slice(0, 40));
      }
      if (dirty) saveFired(firedFile, book);
      return { due: due.length, sent, missed };
    },
  };
}

module.exports = { makeReminderBeat, buildNote, DEFAULT_SCAN_MS, DEFAULT_STALE_AFTER_MS, DEFAULT_MAX_PER_TICK };
