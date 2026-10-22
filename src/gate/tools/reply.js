"use strict";
/** 说话 —— 最常用的那个。渠道归出闸，工具只说「我要说这句」。 */
module.exports = {
  name: "reply",
  description: "Say something to her. Channel is decided by the gate: by default it goes back "
    + "the way this turn came in. Pass `channel` only when she told you to send it somewhere "
    + "specific (\"发我微信\"); if that leg can't carry it you will be told, not silently rerouted.",
  intent: "send_text",
  schema: {
    type: "object",
    properties: {
      text: { type: "string", description: "What you want to say, verbatim." },
      channel: { type: "string", description: "Optional. Only when she asked for a specific channel." },
    },
    required: ["text"],
  },
};
