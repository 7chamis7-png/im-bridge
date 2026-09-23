"use strict";
/** Send an image: a local path or a freshly generated one. */
module.exports = {
  name: "send_image",
  description: "Send an image to the user — a local file path, or one you just generated.",
  intent: "send_generated_image",
  schema: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Local path of the image." },
      caption: { type: "string", description: "Optional words to go with it." },
      channel: { type: "string", description: "Optional. Only when the user asked for a specific channel." },
    },
    required: ["filePath"],
  },
};
