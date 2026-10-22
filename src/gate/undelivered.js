"use strict";

/**
 * 发不出去的那些，去哪儿（2026-09-18，SPEC §5 出站那半）
 *
 * 入站那半已经有了（`receiver.js` 的死信）：一条消化不了，进死信、留原件、
 * 游标照走、大声报。出站这半一直缺 —— 出闸只在事件账本里记一笔，
 * 没有一个地方能让人一眼看见「哪些话她其实没收到」。
 *
 * 三种结果，处理方式**必须分开**：
 *
 * | | 什么时候 | 怎么办 |
 * |---|---|---|
 * | `blocked`  | 有内容但发不出去（平台不支持、腿掉线、没落点） | 留着，**可以换个方式再说** |
 * | `not_sent` | 还没碰到平台就挂了（文件不在、参数不对、平台明确回绝） | 留着，**可以重试/换条腿** |
 * | `unknown`  | 超时、断线、进程崩在半路 | 留着，**绝不自动重发**，等人核对 |
 *
 * 最后一种是拿血换的：9-17 实发撞见过「发送器报超时，其实一秒前已经发出去了」。
 * 三个平台（TG / 微信 / iMessage）**都不认幂等键**，发两次就是两条，
 * 平台不会帮我们挡。所以 unknown 只能留着等人看，不能自作主张重来。
 */

const fs = require("fs");
const path = require("path");

/** 能不能自动重来 —— **只有「确定没出去」那种可以**。 */
const RETRIABLE = Object.freeze(new Set(["blocked", "not_sent"]));

/**
 * @param {object} o
 * @param {string} o.file  落盘位置。**路径由调用方给**（铁律 1）。
 */
function makeUndelivered({ file }) {
  if (!String(file || "").trim()) throw new Error("发不出去的账要一个文件路径 —— 不许用默认值猜");

  function put(entry) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", { encoding: "utf8", mode: 0o600 });
  }

  function list() {
    try {
      const rows = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      // An operation may be recorded once when it becomes unknown and again
      // when a human retries it.  The visible ledger is the latest state for
      // that operation, so recovery remains exactly once across restarts.
      const latest = new Map();
      for (const row of rows) {
        const key = row.operationId || row.recoveryId;
        if (key) latest.set(String(key), row);
        else latest.set(Symbol(), row);
      }
      return [...latest.values()].filter((row) => row.state !== "resolved");
    } catch { return []; }
  }

  return {
    /**
     * 记一条没送到的。
     * @param {object} o
     * @param {"blocked"|"not_sent"|"unknown"} o.state
     */
    note({ state, turnId = "", traceId = "", intent = "send_text", channel = "", chatId = "", text = "", reason = "",
      operationId = "", outputId = "", coldId = "", segments = null }) {
      const entry = {
        state, turnId, traceId, intent, channel, chatId, reason,
        ...(operationId ? { operationId } : {}),
        ...(outputId ? { outputId } : {}),
        ...(coldId ? { coldId } : {}),
        ...(segments ? { segments } : {}),
        // 正文留着 —— 要补发就靠它。**但这份不是冷层**：冷层那条已经由出闸写了，
        // 这里是给人看的账，两边不混。
        text,
        // A partial operation contains confirmed sends and must be checked
        // before any retry, even when its remaining segments are not_sent.
        retriable: RETRIABLE.has(state) && state !== "partial",
      };
      const prior = operationId && list().find((row) => row.operationId === operationId && row.state === state);
      if (prior) return prior;
      put(entry);
      return entry;
    },

    /** Mark a previously failed operation as delivered after an explicit retry. */
    resolve({ operationId, outputId = "", turnId = "", coldId = "" } = {}) {
      if (!operationId) return null;
      const prior = list().find((row) => row.operationId === operationId);
      if (!prior) return null;
      const entry = { state: "resolved", operationId, outputId: outputId || prior.outputId || "",
        turnId: turnId || prior.turnId || "", coldId: coldId || prior.coldId || "", retriable: false,
        at: new Date().toISOString() };
      put(entry);
      return entry;
    },

    /** 全部 */
    list,

    /** 可以重来的那些（确定没出去的）。 */
    retriable: () => list().filter((e) => e.retriable),

    /** **绝不能自动重来**的那些 —— 等人核对。 */
    needsCheck: () => list().filter((e) => !e.retriable),

    /** 一句话说清现在欠着多少 */
    summary() {
      const all = list();
      const by = {};
      for (const e of all) by[e.state] = (by[e.state] || 0) + 1;
      return {
        total: all.length,
        ...by,
        可以重来: all.filter((e) => e.retriable).length,
        等人核对: all.filter((e) => !e.retriable).length,
      };
    },
  };
}

module.exports = { makeUndelivered, RETRIABLE };
