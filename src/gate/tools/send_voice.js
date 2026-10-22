"use strict";
/** 出声 —— 合成你自己的嗓子。平台不支持（比如微信）时出闸会明说，不会偷偷改发文字。 */
module.exports = {
  name: "send_voice",
  description: "Speak out loud in your own voice — for the line that carries more heard than read. "
    + "Occasional, not back to back. Write `text` as what you actually SAY; it is read verbatim.",
  intent: "send_voice",
  schema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The words to say out loud, verbatim." },
      channel: { type: "string", description: "Optional. Only when she asked for a specific channel." },
    },
    required: ["text"],
  },
};
