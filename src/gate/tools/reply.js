"use strict";
/** Say something. The channel belongs to the outbound gate; the tool only states "say this". */
module.exports = {
  name: "reply",
  description: "Say something to the user. Channel is decided by the gate: by default it goes back "
    + "the way this turn came in. Pass `channel` only when the user told you to send it somewhere "
    + "specific (\"send it to my WeChat\"); if that leg can't carry it you will be told, not silently rerouted.",
  intent: "send_text",
  schema: {
    type: "object",
    properties: {
      text: { type: "string", description: "What you want to say, verbatim." },
      channel: { type: "string", description: "Optional. Only when the user asked for a specific channel." },
    },
    required: ["text"],
  },
};
