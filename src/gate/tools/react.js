"use strict";
/** React with an emoji. Not a reply: a lightweight "seen it". */
module.exports = {
  name: "react",
  description: "React to the user's message with one emoji. Not a reply — use it when something the user said "
    + "is cute or funny and doesn't need a whole sentence back. It lands on the message the user just "
    + "sent you in this turn; you don't pick the target and there's nothing to look up.",
  intent: "react",
  schema: {
    type: "object",
    properties: {
      emoji: { type: "string", description: "One emoji, e.g. ❤️ 👍 😂" },
      channel: { type: "string", description: "Optional. Only when the user asked for a specific channel." },
    },
    required: ["emoji"],
  },
};
