"use strict";

/**
 * 守护件 —— 看「它还在干活吗」，不是「它还活着吗」（2026-09-18）
 *
 * **这个文件不属于桥**（住 `src/host/`）。桥只管把状态摆出来（心跳），
 * 谁来读、读出问题怎么办，是宿主的事 —— 桥不认识 pm2，也不该认识。
 *
 * ## 为什么不看「连接在不在」
 *
 * 东京那台 QQ 的教训（记忆 `project-tokyo-napcat-qq`）：**登录态失效的时候
 * WS 还通着，只是 sendMsg 超时** —— 看连接一切正常，消息全丢。
 * 老桥那几个守护件（fable-guard / stall-probe / context-monitor）盯的也都不是
 * 「进程在不在」，是「活着但不干活」的某一种形态。
 *
 * 所以这里摆的判据全是**数**，而且大多是**两次心跳之间的差**：
 * 进程好好活着、心跳照写、但「收了三条一条没出来」——那才是要命的。
 *
 * ## 只推不动
 *
 * **一律不自动重启**（Alice 2026-07-15 对 fable-guard 定的：连续自动回滚/重启
 * 怕把 session 越切越烂，决定权归她）。新桥这儿还多一条理由：
 * **重启 = 盒子重开 = 可能把他正在说的那一轮腰斩**。
 * 所以这个文件里没有任何 kill/restart/exec —— 它只会说话。
 *
 * ## 两种跑法，**都要有**
 *
 * · **跑在主进程里**（`GATE_WATCH_MS`）—— 抓「活着但不干活」：暂存涨了、
 *   收了一条没出来、「不知道发没发」涨了、水位到顶。
 * · **单独起一个进程**（`node src/host/watch.js <心跳文件>`）—— 抓「进程没了」。
 *
 * ⚠️ **进程内那个报不了自己的死**：进程一挂，守护跟着挂，心跳停在那儿也没人说话。
 * 这不是小毛病 —— 「它死了」恰恰是最该被发现的那种。所以外面必须还有一个。
 * （2026-09-18 接线时当场发现的：主进程带上守护之后我正要去验，
 *   才想起来验不了 —— 掐掉进程，守护也一起没了。）
 */

const fs = require("fs");

/**
 * 读心跳。**读两次** —— 见 tick 里的说明（撞上原子改名会扑空一次）。
 * 两次之间空转一小会儿，不用异步：这个函数一分钟才跑一次，阻塞几毫秒无所谓，
 * 而改成 async 会让 tick 的调用方全跟着变，不值。
 */
function readTwice(file, gapMs = 50) {
  for (let i = 0; i < 2; i += 1) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* 再试一次 */ }
    if (i === 0) { const until = Date.now() + gapMs; while (Date.now() < until) { /* 等一下 */ } }
  }
  return null;
}

/** 心跳多久没动就算停了（主进程默认 15 秒写一次，给 3 倍余量） */
const DEFAULT_STALE_MS = 45_000;
/** 收了之后多久还没出来算卡住 */
const DEFAULT_NO_REPLY_MS = 180_000;

/**
 * 两份心跳之间发生了什么。**纯函数**，好测。
 *
 * @param {object} o
 * @param {number} o.now
 * @param {object|null} o.hb    这次读到的心跳（读不到给 null）
 * @param {object|null} [o.prev] 上次那份
 * @param {number} [o.prevAt]   上次读到的时刻
 * @returns {{level:"ok"|"warn"|"bad", issues:Array<{code:string,text:string}>}}
 */
function inspect({ now, hb, prev = null, prevAt = 0,
  staleMs = DEFAULT_STALE_MS, noReplyMs = DEFAULT_NO_REPLY_MS,
  legacyPending = null, legacyPendingSince = 0 } = {}) {
  const issues = [];
  const add = (code, text, bad = false) => issues.push({ code, text, bad });

  // ——— 心跳本身 ———
  if (!hb) {
    add("no_heartbeat", "读不到心跳文件 —— 进程可能没起来，或者家指错了", true);
    return { level: "bad", issues };
  }
  const beatAge = now - (Date.parse(hb.at) || 0);
  if (beatAge > staleMs) {
    // 进程可能还在，但**它已经不写心跳了** = 卡死。这正是「活着但不干活」
    add("heartbeat_stale",
      "心跳 " + Math.round(beatAge / 1000) + " 秒没动了（该 " + Math.round(staleMs / 1000) + " 秒内）"
      + " —— 进程可能还在，但它不干活了", true);
  }

  // 进程重启过（upSec 倒退）：差值没意义，这一轮只看心跳新鲜度
  if (prev && Number(hb.upSec || 0) < Number(prev.upSec || 0)) {
    add("restarted", "进程重启过（运行时间倒退了）—— 这一轮不比差值");
    return { level: issues.some((i) => i.bad) ? "bad" : "warn", issues };
  }

  // 新桥的权威判据：pending 是还没有完成的任务数，oldestPendingAt 是其中最老
  // 的那一个进入 pending 的时刻。它不依赖两次心跳之间的间隔，所以每 30 秒
  // 写一次心跳也能看出同一个任务已经等了多久。out 可能是流式输出的片段，
  // 不能拿它来遮住仍然 pending 的任务。
  const progress = hb.progress;
  const progressPresent = hasProgress(hb);
  const unknownTurns = progress && Number.isFinite(Number(progress.unknown))
    ? Math.max(0, Number(progress.unknown)) : 0;
  // 一条轮次的画像：在哪份账本、哪个平台、她说了啥、为什么卡（2026-09-20 加：之前只报个数，
  // 排查时找错账本找了 40 分钟）
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
        + " 分钟没有完成" + phase + oldestRow + " —— 盒子可能挂死了（她那头是石沉大海）", true);
    }
  }

  if (!prev) return { level: issues.some((i) => i.bad) ? "bad" : "ok", issues };

  const d = (path) => {
    const g = (o) => path.split(".").reduce((x, k) => (x == null ? x : x[k]), o);
    return (Number(g(hb)) || 0) - (Number(g(prev)) || 0);
  };

  // ——— 最要命的一条：收了，但一条都没出来 ———
  // 判据是**真的走完一轮没有**，不是连接在不在。发出去 / 他选择沉默 / 明确失败
  // 都算「走完了」；三样全没动，就是话进去了没出来。
  // 有 progress 时上面的权威判据已经取代旧的相邻心跳差值。没有 progress
  // 时保留 inspect 的纯函数兼容行为；makeWatch 会传入它自己累计的 pending。
  if (!progressPresent) {
    const gotIn = legacyPending == null ? d("stats.in") : 0;
    const cameOut = d("stats.out") + d("stats.silent") + d("stats.failed") + d("stats.blocked");
    const span = legacyPending == null ? now - (prevAt || now) : now - (legacyPendingSince || now);
    const waiting = legacyPending == null ? gotIn > 0 && cameOut === 0 : legacyPending > 0;
    if (waiting && span >= noReplyMs) {
      add("in_no_out",
        (legacyPending == null ? "收了 " + gotIn + " 条" : "仍有 " + legacyPending + " 条任务")
        + "，" + Math.round(span / 60000) + " 分钟没有完成"
        + " —— 盒子可能挂死了（她那头是石沉大海）", true);
    }
  }

  // ——— 她收不到话的几种 ———
  if (d("held") > 0) {
    add("held_growing", "又有 " + d("held") + " 句话没有落点、暂存着 —— 她收不到");
  }
  const unknown = d("undelivered.等人核对");
  if (unknown > 0) {
    add("unknown_growing",
      "又有 " + unknown + " 条「不知道发没发」——**别自动重发**，等人核对", true);
  }
  if (d("stats.failed") > 0) {
    add("failed_growing", "又有 " + d("stats.failed") + " 条发失败了");
  }

  // ——— 水位 ———
  // ⚠️ **不知道就说不知道**：上限没有权威来源时 limit 是 null，那就只报绝对值、
  // 不编百分比（编一个分母出来，她看到的就是假的）。
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
 * 守着一份心跳。**只推不动** —— 它不会重启任何东西。
 *
 * @param {object} o
 * @param {string} o.heartbeatFile
 * @param {function} o.notify  (报告) => any。说什么、说给谁，宿主决定
 * @param {function} [o.log]
 * @param {number} [o.repeatMs] 同一个毛病多久提醒一次（默认 30 分钟，别刷屏）
 */
function makeWatch({ onHighWater = null, highWaterRatio = 0.85,
  onWaterline = null, waterlineRatio = 0.3, waterlineCooldownMs = 30 * 60_000, waterlineRetryMs = 5 * 60_000, heartbeatFile, notify, log = () => {}, repeatMs = 30 * 60_000,
  staleMs = DEFAULT_STALE_MS, noReplyMs = DEFAULT_NO_REPLY_MS, now = () => Date.now() } = {}) {
  if (!String(heartbeatFile || "").trim()) throw new Error("守护件要一份心跳文件 —— 不许用默认值猜");
  if (typeof notify !== "function") throw new Error("守护件要一个 notify（说给谁是宿主的事）");
  let prev = null, prevAt = 0;
  const legacy = { stats: null, pending: 0, pendingSince: 0 };
  const toldAt = new Map();

  const highWaterFired = new Set();
  const waterlineAt = new Map();
  return {
    /** 看一眼。返回这次的判断（测试拿它断言）。 */
    tick() {
      const t = now();
      // ⚠️ **一次读失败不算「没有心跳」**（2026-09-18 真跑时撞到的）：
      // 主进程写心跳是「写临时文件 → rename」，守护正好在那一瞬间读就会扑空。
      // 实测差 178 毫秒 —— 守护报「读不到心跳文件」，而那一刻进程好好活着。
      // 一次失败就宣布进程没了 = 假警报，而假警报会让真警报没人信。
      // 所以隔一下再试一次，两次都读不到才算数。
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

      // 同一个毛病别刷屏（老桥 killswitch 那条经验：只在状态变化时出声）
      const currentCodes = new Set(r.issues.map((i) => i.code));
      for (const code of toldAt.keys()) {
        if (!currentCodes.has(code)) toldAt.delete(code);
      }
      const fresh = r.issues.filter((i) => t - (toldAt.get(i.code) || 0) >= repeatMs);
      if (fresh.length) {
        for (const i of fresh) toldAt.set(i.code, t);
        const head = r.level === "bad" ? "【桥出事了】" : "【桥有点不对】";
        notify(head + "\n" + fresh.map((i) => "· " + i.text).join("\n"));
        log("[守护] " + r.level + " " + fresh.map((i) => i.code).join(","));
      }
      // ——— 水位线收尾（2026-09-21 Alice定）———
      // 收尾轮以前只挂在 /new 上，而 /new 最常见的原因是安全层拒答 —— 那时旧舱什么都跑不了。
      // 舱还健康的时候（默认 85%）先让他收一次尾；每个会话只推一次。
      const fw = (hb && hb.fullness) || {};
      if (typeof onHighWater === "function" && fw.limit && fw.ratio >= highWaterRatio && fw.threadId
        && !highWaterFired.has(fw.threadId)) {
        highWaterFired.add(fw.threadId);
        try { onHighWater({ ratio: fw.ratio, threadId: fw.threadId }); }
        catch (e) { log("[守护] 水位线收尾没推出去：" + ((e && e.message) || e)); }
      }
      // ——— 30% 撞线：先裁工具链，裁不动才换舱（2026-09-21 从老桥搬回；Alice 8-23/9-03 的判据）———
      // 每条会话换完/裁完 30 分钟内不再动（水位读数会抖）；「他正在说话」这种回 retrySoon 就 5 分钟后再看。
      if (typeof onWaterline === "function" && waterlineRatio > 0 && fw.limit && fw.ratio >= waterlineRatio && fw.threadId
        && t - (waterlineAt.get(fw.threadId) || 0) >= waterlineCooldownMs) {
        waterlineAt.set(fw.threadId, t);
        Promise.resolve().then(() => onWaterline({ ratio: fw.ratio, used: Number(fw.used) || 0, threadId: fw.threadId }))
          .then((res) => { if (res && res.retrySoon) waterlineAt.set(fw.threadId, t - waterlineCooldownMs + waterlineRetryMs); })
          .catch((e) => log("[守护] 水位撞线那一手出错：" + ((e && e.message) || e)));
      }
      // 心跳没读到就别拿它当上一份比（否则恢复之后第一轮会误报）
      if (hb) { prev = hb; prevAt = t; }
      return r;
    },
  };
}

module.exports = { makeWatch, inspect, DEFAULT_STALE_MS, DEFAULT_NO_REPLY_MS };

// ——— 单独起一个进程守（抓「进程没了」，进程内那个抓不到）———
if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error("用法: node src/host/watch.js <心跳文件> [看一次的间隔毫秒]");
    process.exit(2);
  }
  const everyMs = Number(process.argv[3] || 30_000);
  const w = makeWatch({
    heartbeatFile: file,
    // 说给谁是宿主的事。单独跑的时候先落 stdout，pm2 会收进日志。
    notify: (m) => console.log(new Date().toISOString() + " " + m.replace(/\n/g, " | ")),
    log: () => {},
  });
  console.log("守着 " + file + "，每 " + Math.round(everyMs / 1000) + " 秒看一次。**只推不动。**");
  setInterval(() => {
    try { w.tick(); } catch (e) { console.error("[守护] 自己出错了：" + ((e && e.message) || e)); }
  }, everyMs);
}
