"use strict";
/**
 * Hang up. Paired with `call`. It is a separate tool rather than a `call`
 * parameter because the outbound ledger records and deduplicates by intent;
 * recording a hang-up as `start_call` would corrupt the ledger.
 */
module.exports = {
  name: "hang_up",
  description: "Hang up the voice call that's currently ringing or connected. "
    + "Use it when nobody picked up and it's been ringing a while, or when you're done talking. "
    + "If there's no call going on it just tells you so — nothing breaks.",
  intent: "end_call",
  schema: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Optional. Only when the user asked for a specific channel." },
    },
  },
};
