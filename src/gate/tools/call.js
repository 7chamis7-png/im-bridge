"use strict";
/**
 * 给她打电话（2026-09-18）。
 *
 * 只做**发起**。接听那半做不了：微信语音通话只在一个设备上响，而这个号在
 * Nova的安卓专机上也登着，铃声去了手机。要让来电落到桥这台，得先把那台手机
 * 上的微信退掉。
 *
 * 声音两头都验过了：他的嘴（TTS → nova_mic_sink → nova_mic → 微信采集）、
 * 他的耳朵（微信播放 → snd-aloop 真声卡 → 录它的 .monitor）。
 * ⚠️ 耳朵**不是** `nova_speaker` —— 那个 null-sink 录起来零帧，2026-09-18 已删。
 */
module.exports = {
  name: "call",
  description: "Call her out loud — start a voice call on whichever channel this turn came from. "
    + "Use it when something is worth saying with your voice instead of typing, or when she asks "
    + "you to call. She has to pick up on her phone. Do not call repeatedly if she doesn't answer.",
  intent: "start_call",
  schema: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Optional. Only when she asked for a specific channel." },
    },
  },
};
