"use strict";

/**
 * 出站失败的两种，必须分开（2026-09-17 贴纸实发时自审出来的）
 *
 *   NotSent   **确定一个字都没出去**。参数不对、贴纸找不到、文件不存在这类，
 *             在碰平台之前就失败了。→ 他应该「换一张再来」。
 *   unknown   **不知道发没发**。网络超时、平台没回执这类。
 *             → 他应该「别重发，等核对」。9-17 实发撞见过：报超时其实 1 秒就发出去了。
 *
 * 混成一种的后果是双向的：
 *   把 NotSent 当 unknown → 告诉他「别重发」，可其实她什么也没收到，这条就哑了
 *   把 unknown 当 NotSent → 告诉他「再发一遍」，于是同一句话说两遍
 */

class NotSentError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotSentError";
    this.notSent = true;      // 出闸认这个标记
  }
}

/** 插件里用：这一步失败时，平台还没被碰过。 */
function notSent(message) {
  return new NotSentError(message);
}

module.exports = { NotSentError, notSent };
