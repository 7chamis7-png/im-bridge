"use strict";
/**
 * Start a voice call (outgoing only). Answering incoming calls is not supported.
 * Which leg can place the call is decided by the outbound gate (currently WeChat).
 */
module.exports = {
  name: "call",
  description: "Call the user out loud — start a voice call on whichever channel this turn came from. "
    + "Use it when something is worth saying with your voice instead of typing, or when the user asks "
    + "you to call. The user has to pick up on their phone. Do not call repeatedly if nobody answers.",
  intent: "start_call",
  schema: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Optional. Only when the user asked for a specific channel." },
    },
  },
};
