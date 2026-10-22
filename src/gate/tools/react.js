"use strict";
/** 点个表情。不算说话 —— 她随口一句可爱的、不需要回整条的，点一下就是"我看见了"。 */
module.exports = {
  name: "react",
  description: "React to her message with one emoji. Not a reply — use it when something she said "
    + "is cute or funny and doesn't need a whole sentence back. It lands on the message she just "
    + "sent you in this turn; you don't pick the target and there's nothing to look up.",
  intent: "react",
  schema: {
    type: "object",
    properties: {
      emoji: { type: "string", description: "One emoji, e.g. ❤️ 👍 😂" },
      channel: { type: "string", description: "Optional. Only when she asked for a specific channel." },
    },
    required: ["emoji"],
  },
};
