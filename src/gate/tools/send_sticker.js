"use strict";
/** 发贴纸。贴纸库归共用层，工具只说「发这个」。 */
module.exports = {
  name: "send_sticker",
  description: "Send one of your own stickers. Give either `sticker` (id or name) or `emoji`.",
  intent: "send_sticker",
  schema: {
    type: "object",
    properties: {
      sticker: { type: "string", description: "Sticker id or name." },
      emoji: { type: "string", description: "Or pick by emoji." },
      channel: { type: "string", description: "Optional. Only when she asked for a specific channel." },
    },
  },
};
