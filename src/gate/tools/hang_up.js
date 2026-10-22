"use strict";
/**
 * 挂电话（2026-09-18）。
 *
 * 跟 `call` 是一对。分成两个工具而不是给 `call` 加个参数，是因为出闸的账本
 * 按 intent 记账、去重也按 intent 比 —— 拿 `start_call` 记一次挂断，账是假的。
 *
 * 真正用得上的时候：她没接，电话一直响着没人收；或者话说完了他想自己收线。
 */
module.exports = {
  name: "hang_up",
  description: "Hang up the voice call that's currently ringing or connected. "
    + "Use it when she didn't pick up and it's been ringing a while, or when you're done talking. "
    + "If there's no call going on it just tells you so — nothing breaks.",
  intent: "end_call",
  schema: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Optional. Only when she asked for a specific channel." },
    },
  },
};
