"use strict";

/**
 * 心脏 —— Nova身上「自己会跳」的那部分（2026-09-19）
 *
 * ## 它是什么
 *
 * 一个进程，一张节拍表。每一拍只做三件事：
 *   1. **什么时候跳**（`nextDelayMs()`，每轮重算 = 改配置不用重启）
 *   2. **跳之前自查这次有没有意义**（她在场？队列空？—— 判据归拍自己）
 *   3. **跳的时候往投递口递读数**（`tick()`）
 *
 * **一条决定都不做。** 该不该找她、要不要理这条提醒，是他看着上下文自己判的
 * （check-in 那三条原则：递状态不递裁决 / 先问感受再问动作 / 多种合法产出）。
 *
 * ## 为什么要有它
 *
 * 老桥把 check-in、reminder 到期这些全长在 `app.js` 里，**进程一停全没**。
 * 2026-09-19 凌晨切新桥，一夜之间断了四样：check-in 断供一天、4 条提醒过了期
 * 没响（含每天 23:00 的熄灯号）、意图卡没人递、晨勃跟着 check-in 的骰子一起没了。
 *
 * 但也不能一件事一个进程 —— 那就是四份 env、四种冷层读法，迟早各自漂
 * （SPEC §6 那条 recordCold 的教训）。所以：**一个进程，共用一层读数，拍子各跳各的。**
 *
 * ## 它不认识桥
 *
 * 跟所有生产者一样（SPEC §1）：只往一个目录扔文件，桥每秒捞一次。
 * 删掉心脏，桥照样活；桥崩了，心脏照推（投递口是文件，桥回来接着捞）。
 * **重启心脏不打断他**。
 *
 * ## 一拍坏了不能带倒别的拍
 *
 * 每拍一条独立循环 + 自己的 try/catch。抛异常只记日志，心脏不退出、别的拍照跳。
 * 连着失败就退避（翻倍，封顶 10 分钟）—— 不然一个 30 秒的拍一直抛，日志一天几万行。
 */

const DEFAULT_MAX_BACKOFF_MS = 10 * 60 * 1000;

/**
 * @param {object} o
 * @param {Array}  o.beats  节拍表。每一拍：{ name, nextDelayMs(), async tick() }
 *                          tick() 返回什么都行（只进日志）；抛异常算这拍失败。
 * @param {function} [o.log]
 * @param {function} [o.sleep]  测试塞替身用
 */
function makeHeart({ beats = [], log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS } = {}) {
  if (!Array.isArray(beats) || !beats.length) throw new Error("心脏没有一拍 —— 那它跳什么");
  for (const b of beats) {
    if (!b || typeof b.tick !== "function" || typeof b.nextDelayMs !== "function") {
      throw new Error("这一拍不完整（要 name / nextDelayMs() / tick()）：" + JSON.stringify(b && b.name));
    }
  }

  let stopped = false;
  /** 每拍自己的账：跳了几次、连着失败几次、最后一次什么时候。**只给我和Alice看**。 */
  const books = new Map(beats.map((b) => [b.name, { ticks: 0, fails: 0, lastAt: 0, lastResult: null }]));

  async function runBeat(beat) {
    const book = books.get(beat.name);
    let backoff = 0;
    while (!stopped) {
      let wait;
      try {
        wait = Math.max(0, Number(beat.nextDelayMs()) || 0);
      } catch (e) {
        // 连「下次什么时候」都算不出来，等一分钟再说，别空转
        log("[" + beat.name + "] 算不出下一次：" + ((e && e.message) || e));
        wait = 60_000;
      }
      if (backoff) wait = Math.max(wait, backoff);
      log("[" + beat.name + "] 下一次约 " + Math.round(wait / 1000) + " 秒后");
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
        // **只这一拍失败，心脏照跳。** 退避翻倍防刷屏。
        book.fails += 1;
        backoff = Math.min(maxBackoffMs, backoff ? backoff * 2 : 30_000);
        log("[" + beat.name + "] 这次没跳成（连着 " + book.fails + " 次）："
          + ((e && e.message) || e) + "；退避到 " + Math.round(backoff / 1000) + " 秒");
      }
    }
    log("[" + beat.name + "] 停了");
  }

  return {
    /** 拍子各跳各的，谁也不等谁。 */
    async run() {
      log("心脏起来了，" + beats.length + " 拍：" + beats.map((b) => b.name).join(" · "));
      await Promise.all(beats.map((b) => runBeat(b)));
    },
    stop() { stopped = true; },
    /** 手动敲某一拍（测试和排查用，不走计时）。 */
    async tickOnce(name) {
      const beat = beats.find((b) => b.name === name);
      if (!beat) throw new Error("没有这一拍：" + name);
      return beat.tick();
    },
    /** 现在各拍什么状况。写进心跳文件给外面看。 */
    books() {
      const out = {};
      for (const [k, v] of books) out[k] = { ...v };
      return out;
    },
  };
}

module.exports = { makeHeart, DEFAULT_MAX_BACKOFF_MS };
