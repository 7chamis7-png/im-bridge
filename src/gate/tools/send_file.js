"use strict";
/** Send a local file. */
module.exports = {
  name: "send_file",
  description: "Send a local file to the user.",
  intent: "send_file",
  schema: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Local path of the file." },
      caption: { type: "string", description: "Optional words to go with it." },
      channel: { type: "string", description: "Optional. Only when the user asked for a specific channel." },
    },
    required: ["filePath"],
  },
};
