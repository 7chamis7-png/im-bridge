"use strict";
/** 发图：本地路径或刚生成的图。 */
module.exports = {
  name: "send_image",
  description: "Send an image to her — a local file path, or one you just generated.",
  intent: "send_generated_image",
  schema: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Local path of the image." },
      caption: { type: "string", description: "Optional words to go with it." },
      channel: { type: "string", description: "Optional. Only when she asked for a specific channel." },
    },
    required: ["filePath"],
  },
};
