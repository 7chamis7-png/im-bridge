"use strict";

/**
 * Watchdog: checks "is it still doing work", not "is it still alive".
 *
 * Lives in src/host/: the bridge only publishes its state (heartbeat); who reads
 * it and what to do about problems is a host concern. The bridge knows nothing
 * about process managers.
 *
 * ## Why not check "is the connection up"
 *
 * A typical failure mode of chat bridges: the login session expires while the
 * websocket stays connected, and only the send calls time out. Everything looks
 * healthy while every message is lost. So every signal here is a number, mostly
 * a delta between two heartbeats: "received three, delivered none" is what matters.
 *
 * ## Report only, never act
 *
 * It never restarts anything: automatic restart loops can make a session worse,
 * and restarting the box can cut off a turn the agent is in the middle of.
 * There is no kill/restart/exec in this file.
 *
 * ## Two ways to run it — you want both
 *
 * - In-process (`GATE_WATCH_MS`): catches "alive but not working" (held messages
 *   growing, received but not answered, unknown delivery growing, context full).
 * - As a separate process (`node src/host/watch.js <heartbeat file>`): catches
 *   "process is gone". The in-process watcher cannot report its own death.
 */

const fs = require("fs");

/**
 * Read the heartbeat, retrying once (a read can race the writer's atomic rename).
 * The short busy-wait is intentional: this runs rarely, and making it async
 * would ripple through every caller of tick().
 */
function readTwice(file, gapMs = 50) {
  for (let i = 0; i < 2; i += 1) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* retry once */ }
    if (i === 0) { const until = Date.now() + gapMs; while (Date.now() < until) { /* wait */ } }
  }
  return null;
}

/** Heartbeat considered stale after this (writer defaults to every 15s; 3x margin). */
const DEFAULT_STALE_MS = 45_000;
/** A received message not completed within this time counts as stuck. */
const DEFAULT_NO_REPLY_MS = 180_000;

/**
 * What happened between two heartbeats. Pure function.
 *
 * @param {object} o
 * @param {number} o.now
 * @param {object|null} o.hb    current heartbeat (null if unreadable)
 * @param {object|null} [o.prev] previous heartbeat
 * @param {number} [o.prevAt]   when the previous one was read
 * @returns {{level:"ok"|"warn"|"bad", issues:Array<{code:string,text:string}>}}
 */
function inspect({ now, hb, prev = null, prevAt = 0,
  staleMs = DEFAULT_STALE_MS, noReplyMs = DEFAULT_NO_REPLY_MS,
  legacyPending = null, legacyPendingSince = 0 } = {}) {
  const issues = [];
  const add = (code, text, bad = false) => issues.push({ code, text, bad });

  // --- the heartbeat itself ---
  if (!hb) {
    add("no_heartbeat", "读不到心跳文件 —— 进程可能没起来，或者家指错了", true);
    return { level: "bad", issues };
  }
  const beatAge = now - (Date.parse(hb.at) || 0);
  if (beatAge > staleMs) {
    // The process may exist but no longer writes heartbeats: stuck.
    add("heartbeat_stale",
      "心跳 " + Math.round(beatAge / 1000) + " 秒没动了（该 " + Math.round(staleMs / 1000) + " 秒内）"
      + " —— 进程可能还在，但它不干活了", true);
  }

  // Restarted (upSec went backwards): deltas are meaningless this round
  if (prev && Number(hb.upSec || 0) < Number(prev.upSec || 0)) {
    add("restarted", "进程重启过（运行时间倒退了）—— 这一轮不比差值");
    return { level: issues.some((i) => i.bad) ? "bad" : "warn", issues };
  }

  // Authoritative signal: `pending` is the number of unfinished tasks and
  // `oldestPendingAt` is when the oldest one entered pending. It does not depend
  // on the heartbeat interval. `out` may count streamed fragments, so it must not
  // mask tasks that are still pending.
  const progress = hb.progress;
  const progressPresent = hasProgress(hb);
  const unknownTurns = progress && Number.isFinite(Number(progress.unknown))
    ? Math.max(0, Number(progress.unknown)) : 0;
  // Describe a turn: which ledger, platform, text, and why it is stuck
  // (counts alone are not enough to debug).
  const who = (row) => {
    if (!row || typeof row !== "object") return "";
    const bits = [];
    if (row.platform) bits.push("[" + row.platform + "]");
    if (row.text) bits.push("「" + row.text + "」");
    if (row.reason) bits.push("原因：" + row.reason);
    if (row.id) bits.push(row.id);
    return bits.length ? "：" + bits.join(" · ") : "";
  };
  const ledger = progress && progress.ledger ? "（桥账本 " + progress.ledger + "）" : "";
  if (unknownTurns > 0) {
    const rows = Array.isArray(progress.unknownRows) ? progress.unknownRows : [];
    const detail = rows.length ? rows.map(who).join("；") : "";
    add("turn_acceptance_unknown",
      "有 " + unknownTurns + " 条轮次的接收结果不明" + ledger + detail
      + " —— 先核对证据，再继续让盒子收新话", true);
  }
  if (progressPresent) {
    const pending = Math.max(0, Number(progress.pending));
    const oldest = pending > 0 ? Date.parse(progress.oldestPendingAt || "") : NaN;
    if (pending > 0 && Number.isFinite(oldest) && now - oldest >= noReplyMs) {
      const phase = progress.phase ? "（阶段：" + String(progress.phase) + "）" : "";
      const oldestRow = progress.oldestPending ? "，最老那条" + who(progress.oldestPending) : "";
      add("in_no_out",
        "仍有 " + pending + " 条任务等了 " + Math.round((now - oldest) / 60000)
        + " 分钟没有完成" + phase + oldestRow + " —— 盒子可能挂死了（owner 那头收不到回复）", true);
    }
  }

  if (!prev) return { level: issues.some((i) => i.bad) ? "bad" : "ok", issues };

  const d = (path) => {
    const g = (o) => path.split(".").reduce((x, k) => (x == null ? x : x[k]), o);
    return (Number(g(hb)) || 0) - (Number(g(prev)) || 0);
  };

  // --- The critical one: received, but nothing came out ---
  // "Completed" means sent, deliberately silent, or explicitly failed. If none
  // moved, the message went in and never came out.
  // With `progress` present the signal above supersedes this. Without it, keep
  // the legacy delta behavior; makeWatch passes its own cumulative pending.
  if (!progressPresent) {
    const gotIn = legacyPending == null ? d("stats.in") : 0;
    const cameOut = d("stats.out") + d("stats.silent") + d("stats.failed") + d("stats.blocked");
    const span = legacyPending == null ? now - (prevAt || now) : now - (legacyPendingSince || now);
    const waiting = legacyPending == null ? gotIn > 0 && cameOut === 0 : legacyPending > 0;
    if (waiting && span >= noReplyMs) {
      add("in_no_out",
        (legacyPending == null ? "收了 " + gotIn + " 条" : "仍有 " + legacyPending + " 条任务")
        + "，" + Math.round(span / 60000) + " 分钟没有完成"
        + " —— 盒子可能挂死了（owner 那头收不到回复）", true);
    }
  }

  // --- ways the owner stops receiving messages ---
  if (d("held") > 0) {
    add("held_growing", "又有 " + d("held") + " 句话没有落点、暂存着 —— owner 收不到");
  }
  const unknown = d("undelivered.等人核对");
  if (unknown > 0) {
    add("unknown_growing",
      "又有 " + unknown + " 条「不知道发没发」——**别自动重发**，等人核对", true);
  }
  if (d("stats.failed") > 0) {
    add("failed_growing", "又有 " + d("stats.failed") + " 条发失败了");
  }

  // --- context fill ---
  // Without an authoritative limit, `limit` is null: never invent a percentage.
  const f = hb.fullness || {};
  if (f.limit && f.ratio >= 0.9) {
    add("context_high", "上下文 " + Math.round(f.ratio * 100) + "% 了，该换舱");
  }

  return { level: issues.some((i) => i.bad) ? "bad" : (issues.length ? "warn" : "ok"), issues };
}

function hasProgress(hb) {
  const p = hb && hb.progress;
  return !!(p && Object.prototype.hasOwnProperty.call(p, "pending")
    && p.pending !== null && Number.isFinite(Number(p.pending)));
}

function statValue(stats, key) {
  return Number.isFinite(Number(stats && stats[key])) ? Number(stats[key]) : 0;
}

function legacySnapshot(hb) {
  const s = hb.stats || {};
  return {
    in: statValue(s, "in"),
    out: statValue(s, "out"),
    silent: statValue(s, "silent"),
    failed: statValue(s, "failed"),
    blocked: statValue(s, "blocked"),
    completed: statValue(s, "completed"),
  };
}

function legacyCompleted(stats) {
  return stats.completed > 0
    ? stats.completed
    : stats.out + stats.silent + stats.failed + stats.blocked;
}

/**
 * Keep a cumulative fallback for old heartbeats that have no progress object.
 * The clock starts when a new pending item is observed, rather than being
 * restarted on every heartbeat read.
 */
function updateLegacy(legacy, hb, at) {
  const current = legacySnapshot(hb);
  if (!legacy.stats) {
    legacy.stats = current;
    legacy.pending = Math.max(0, current.in - legacyCompleted(current));
    if (legacy.pending > 0) legacy.pendingSince = Date.parse(hb.at) || at;
    return;
  }

  const delta = (key) => current[key] - legacy.stats[key];
  // A counter going backwards without an upSec reset is still not comparable.
  // Re-baseline it and wait for a fresh incoming task.
  if (Object.keys(current).some((key) => delta(key) < 0)) {
    legacy.stats = current;
    legacy.pending = 0;
    legacy.pendingSince = 0;
    return;
  }

  const incoming = delta("in");
  const completed = current.completed > legacy.stats.completed
    ? delta("completed")
    : delta("out") + delta("silent") + delta("failed") + delta("blocked");
  legacy.pending += incoming;
  legacy.pending = Math.max(0, legacy.pending - completed);
  if (legacy.pending > 0 && !legacy.pendingSince) legacy.pendingSince = at;
  if (legacy.pending === 0) legacy.pendingSince = 0;
  legacy.stats = current;
}

/**
 * Watch a heartbeat file. Reports only; never restarts anything.
 *
 * @param {object} o
 * @param {string} o.heartbeatFile
 * @param {function} o.notify  (report) => any; the host decides where it goes
 * @param {function} [o.log]
 * @param {number} [o.repeatMs] repeat interval for the same issue (default 30 min)
 */
function makeWatch({ onHighWater = null, highWaterRatio = 0.85,
  onWaterline = null, waterlineRatio = 0.3, waterlineCooldownMs = 30 * 60_000, waterlineRetryMs = 5 * 60_000, heartbeatFile, notify, log = () => {}, repeatMs = 30 * 60_000,
  staleMs = DEFAULT_STALE_MS, noReplyMs = DEFAULT_NO_REPLY_MS, now = () => Date.now() } = {}) {
  if (!String(heartbeatFile || "").trim()) throw new Error("watch needs a heartbeat file");
  if (typeof notify !== "function") throw new Error("watch needs a notify function");
  let prev = null, prevAt = 0;
  const legacy = { stats: null, pending: 0, pendingSince: 0 };
  const toldAt = new Map();

  const highWaterFired = new Set();
  const waterlineAt = new Map();
  return {
    /** Check once. Returns the verdict (used by tests). */
    tick() {
      const t = now();
      // A single failed read is not "no heartbeat": the writer does
      // write-tmp + rename, and a read can land in between. False alarms erode
      // trust in real ones, so only two consecutive failures count.
      const hb = readTwice(heartbeatFile);
      const restarted = !!(hb && prev && Number(hb.upSec || 0) < Number(prev.upSec || 0));
      if (hb && (restarted || hasProgress(hb))) {
        // A restart discards the old cumulative counters. An explicit progress
        // heartbeat is authoritative, so it also clears any legacy estimate.
        legacy.stats = null;
        legacy.pending = 0;
        legacy.pendingSince = 0;
        if (restarted) toldAt.delete("in_no_out");
      } else if (hb) {
        updateLegacy(legacy, hb, t);
      }
      const r = inspect({ now: t, hb, prev, prevAt, staleMs, noReplyMs,
        legacyPending: hb && !hasProgress(hb) ? legacy.pending : null,
        legacyPendingSince: legacy.pendingSince });

      // Don't repeat the same issue; speak on state changes
      const currentCodes = new Set(r.issues.map((i) => i.code));
      for (const code of toldAt.keys()) {
        if (!currentCodes.has(code)) toldAt.delete(code);
      }
      const fresh = r.issues.filter((i) => t - (toldAt.get(i.code) || 0) >= repeatMs);
      if (fresh.length) {
        for (const i of fresh) toldAt.set(i.code, t);
        const head = r.level === "bad" ? "【桥出事了】" : "【桥有点不对】";
        notify(head + "\n" + fresh.map((i) => "· " + i.text).join("\n"));
        log("[watch] " + r.level + " " + fresh.map((i) => i.code).join(","));
      }
      // --- High-water closing turn ---
      // While the session is still healthy (default 85%), ask the agent to wrap up
      // once per session, instead of only on /new (by which point the old session
      // may no longer be usable).
      const fw = (hb && hb.fullness) || {};
      if (typeof onHighWater === "function" && fw.limit && fw.ratio >= highWaterRatio && fw.threadId
        && !highWaterFired.has(fw.threadId)) {
        highWaterFired.add(fw.threadId);
        try { onHighWater({ ratio: fw.ratio, threadId: fw.threadId }); }
        catch (e) { log("[watch] high-water closing turn not pushed: " + ((e && e.message) || e)); }
      }
      // --- Waterline: trim the tool chain first, rotate the session if trimming can't free enough ---
      // Cooldown per session (readings fluctuate); a handler returning retrySoon
      // (e.g. agent is mid-turn) is retried after waterlineRetryMs.
      if (typeof onWaterline === "function" && waterlineRatio > 0 && fw.limit && fw.ratio >= waterlineRatio && fw.threadId
        && t - (waterlineAt.get(fw.threadId) || 0) >= waterlineCooldownMs) {
        waterlineAt.set(fw.threadId, t);
        Promise.resolve().then(() => onWaterline({ ratio: fw.ratio, used: Number(fw.used) || 0, threadId: fw.threadId }))
          .then((res) => { if (res && res.retrySoon) waterlineAt.set(fw.threadId, t - waterlineCooldownMs + waterlineRetryMs); })
          .catch((e) => log("[watch] waterline handler failed: " + ((e && e.message) || e)));
      }
      // Don't use a missing heartbeat as the baseline (would false-alarm after recovery)
      if (hb) { prev = hb; prevAt = t; }
      return r;
    },
  };
}

module.exports = { makeWatch, inspect, DEFAULT_STALE_MS, DEFAULT_NO_REPLY_MS };

// --- Standalone mode: catches "process is gone" ---
if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node src/host/watch.js <heartbeat file> [interval ms]");
    process.exit(2);
  }
  const everyMs = Number(process.argv[3] || 30_000);
  const w = makeWatch({
    heartbeatFile: file,
    // Standalone: report to stdout (collected by your process manager).
    notify: (m) => console.log(new Date().toISOString() + " " + m.replace(/\n/g, " | ")),
    log: () => {},
  });
  console.log("watching " + file + " every " + Math.round(everyMs / 1000) + "s (report only)");
  setInterval(() => {
    try { w.tick(); } catch (e) { console.error("[watch] internal error: " + ((e && e.message) || e)); }
  }, everyMs);
}
