"use strict";
/**
 * Speak with a synthesized voice. If the channel can't carry voice, the
 * outbound gate says so explicitly instead of silently sending text.
 */
module.exports = {
  name: "send_voice",
  description: "Speak out loud in your own voice — for the line that carries more heard than read. "
    + "Occasional, not back to back. Write `text` as what you actually SAY; it is read verbatim.",
  intent: "send_voice",
  schema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The words to say out loud, verbatim." },
      channel: { type: "string", description: "Optional. Only when the user asked for a specific channel." },
    },
    required: ["text"],
  },
};
