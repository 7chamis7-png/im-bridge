"use strict";
/** Send a sticker. The sticker book lives in the shared layer; the tool only says "send this". */
module.exports = {
  name: "send_sticker",
  description: "Send one of your own stickers. Give either `sticker` (id or name) or `emoji`.",
  intent: "send_sticker",
  schema: {
    type: "object",
    properties: {
      sticker: { type: "string", description: "Sticker id or name." },
      emoji: { type: "string", description: "Or pick by emoji." },
      channel: { type: "string", description: "Optional. Only when the user asked for a specific channel." },
    },
  },
};
