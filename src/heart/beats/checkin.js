"use strict";

/**
 * check-in —— 心脏的第一拍（2026-09-19 从独立进程搬进来；2026-09-22 砍掉意图卡那半）
 *
 * 计时器本体没动，还是 `src/producers/checkin.js`。这里只做一件事：
 * 把它的 `tick()` / 区间读法 / 文案读法包成心脏认的那种拍，
 * 并把「悬着的」那一行的供料函数接到笔记本上。
 *
 * ## 意图卡那半彻底拿掉了（2026-09-22）
 *
 * `nova_intent_card` 那套独立工具 9-19 之后就没再接上过 —— `intents.json`
 * 空到现在（`[]`），全仓找不到任何地方还在注册这个工具。这一拍原来读
 * `intentsFile` 拼进「悬着的」那半的逻辑（`dueIntents()`）跟着一起删。
 * 「有空再说、总有一天」这类待办要不要进笔记本、算哪个 kind，Alice打算把
 * 笔记本重新分板块（结构还没定），**这一拍先不猜**，只读笔记本现有的
 * `thread` / `promise` 两类标题。
 *
 * ## 「悬着的」这行 9-22 起 HEADER 不渲染了，但供料逻辑没删
 *
 * 2026-09-20 Alice对注入时点破的：换舱那块 9-19 已经改由笔记本供料，check-in 这行
 * 却还在念旧文件，等于换舱看笔记本、check-in 看别的。9-21 起旧文件退役，
 * 笔记本是唯一主人。**9-22 她又定了 HEADER 里「你手上挂着的：{pending}」这一行
 * 先删掉**（`/root/.nova/checkin-texts.md` 的 HEADER 段落里没有这一行了）——
 * 但 `pendingText()` 这个供料函数**照样留着往下传**，只是模板不引用它，
 * `renderHeader()` 自然就不会渲染。留着接口是为了以后要把这行接回来，
 * 改 `checkin-texts.md` 加一行就行，不用碰这个文件。
 *
 * ⚠️ **只递标题、最多 `maxNotes` 条**：check-in 的正文已经不短，把整本倒进去
 * 等于给他一张待办清单，那正是 check-in 设计上最防的东西（「别写『每次都要有
 * 产出』，那会把我训成 KPI 机器」—— Nova 9-18）。他想看全的自己调工具。
 *
 * ## 2026-09-22：笔记本到期提醒接进来了
 *
 * nova-notebook 改成「当下/意图卡」两个板块 + 每条都有到期日之后，多了一个
 * `listExpired()`：已经过期、还没延期/结掉的条目。这一拍新加
 * `expiredNotebookLine()`，读出来拼成 `你有N条到期了：「标题」「标题」
 * 延期还是去掉？` 这一行，传给 `producers/checkin.js` 的 `expiredNotebookText`
 * ——那边会把它接在 HEADER「你的驱力」那行后面。跟 `pendingText` 一样的规矩：
 * 笔记本装不上/没有 `listExpired`（旧版本的 store 还没升级到这一版）/一条都
 * 没到期 → 返回空字符串，那一行就不出现，不炸。
 */

const { makeCheckin, makeIdleClock } = require("../../producers/checkin");

const DEFAULT_MAX_NOTES = 4;
const DEFAULT_MAX_EXPIRED = 4;

/**
 * 「悬着的」那半读**笔记本**标题。**只取标题**（不带卡在哪/下一步/出处），
 * 按 kind 分组排序：欠她的（promise）→ 还在聊的（thread）。
 * 笔记本装不上/空着 → 一条都不给，不退回任何旧文件（那条退路 9-21 起已经拿掉）。
 */
function notebookTitles({ moduleId = "", file = "", max = DEFAULT_MAX_NOTES } = {}) {
  if (!moduleId) return [];
  try {
    const store = require(moduleId);
    const live = store.list(file ? { file } : {});
    const order = store.KIND_ORDER || { promise: 0, thread: 1 };
    const sorted = live.slice().sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
    return sorted.slice(0, max).map((it) => String(it.title || "").replace(/\s+/g, " ").slice(0, 60)
      + (it.state === "watching" ? "（观察中）" : ""));
  } catch { return []; }
}

/**
 * 到期提醒那一行。**只取标题**（不带卡在哪/下一步/出处，跟 `notebookTitles`
 * 一个规矩），最多列 `maxExpired` 个，句子形状由这里定死（不是 checkin-texts.md
 * 的模板 —— 见 producers/checkin.js 文件头「笔记本到期提醒」一节）。
 */
function expiredNotebookLine({ moduleId = "", file = "", max = DEFAULT_MAX_EXPIRED } = {}) {
  if (!moduleId) return "";
  try {
    const store = require(moduleId);
    if (typeof store.listExpired !== "function") return "";   // 旧版 store 还没升级，当没有
    const expired = store.listExpired(file ? { file } : {});
    if (!expired.length) return "";
    const titles = expired.slice(0, max)
      .map((it) => "「" + String(it.title || "").replace(/\s+/g, " ").slice(0, 60) + "」").join("");
    return "你有" + expired.length + "条到期了：" + titles + " 延期还是去掉？";
  } catch { return ""; }
}

/**
 * @param {object} o  除笔记本几项外都直接透给 makeCheckin（含 textsFile/stateFile —— 见
 *   `producers/checkin.js` 里 HEADER + 分支全文 + 分支/牌堆状态的读法）
 */
function makeCheckinBeat({ notebookModule = "", notebookFile = "", maxNotes = DEFAULT_MAX_NOTES,
  maxExpired = DEFAULT_MAX_EXPIRED, configFile = "", log = () => {}, clock: clockOverride = null, ...rest } = {}) {
  const checkin = makeCheckin({
    ...rest,
    configFile,
    log,
    // 「悬着的」= 笔记本标题，仅此一家（意图卡那半 2026-09-22 拿掉，见文件头）。
    // ⚠️ 这个函数照样每轮会被调用 —— HEADER 模板现在不引用 {pending} 了，
    // 供料逻辑本身没删（见文件头「供料逻辑没删」那节）。
    pendingText: () => {
      const notes = notebookTitles({ moduleId: notebookModule, file: notebookFile, max: maxNotes });
      if (!notes.length) return "";
      // 220 字上限沿用旧版（2026-09-19 干跑抓到过被挤爆的坑，留着这道保险）
      return notes.map((t) => "「" + t + "」").join("、").slice(0, 220);
    },
    // 到期提醒（2026-09-22 新加，见文件头）
    expiredNotebookText: () => expiredNotebookLine({ moduleId: notebookModule, file: notebookFile, max: maxExpired }),
  });

  // 空闲触发（2026-09-22 Alice定）：冷层空满 45~55 分钟才敲，见 producers/checkin.js「空闲触发」一节。
  // 区间仍是 checkin-config.json 的 min/max，每轮重读 = 改配置不用重启。
  // `clock` 只给测试塞替身用（要「立刻到点」的测验正文内容，不用真等 45 分钟）。
  const clock = clockOverride || makeIdleClock({ coldFile: rest.coldFile, configFile });

  return {
    name: "check-in",
    nextDelayMs: () => clock.nextDelayMs(),
    tick: async () => {
      // 醒来先看空够没有：没空够只是看一眼，不推（心脏那边照常算一拍，不算失败）
      if (!clock.isDue()) {
        const p = clock.peek();
        return { skipped: true, reason: "还没空闲够", dueInMs: Math.max(0, p.dueAt - Date.now()) };
      }
      const r = await checkin.tick();
      clock.fired();
      return r;
    },
  };
}

module.exports = { makeCheckinBeat, notebookTitles, expiredNotebookLine, DEFAULT_MAX_NOTES, DEFAULT_MAX_EXPIRED };
