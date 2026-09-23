"use strict";

/**
 * Capability surface: three layers.
 *
 * Without the third layer things get dropped silently: e.g. `inline_keyboard`
 * passed on a WeChat turn has no place in send() and would vanish unreported.
 *
 * +- Layer 1: shared capabilities (outside the gate, one instance for all channels)
 * |    transcription / speech synthesis / image generation / file store
 * +- Layer 2: common intents (every plugin must declare support or not)
 * |    text / image / file / voice / sticker / reaction / call
 * +- Layer 3: plugin-specific extras (features only one platform has)
 *      Telegram buttons, reply-to, Markdown ...
 *
 * Rule: a layer-3 extra used on a channel that lacks it must be reported as
 * "not available on this channel", never silently ignored.
 */

/** Layer 1: shared capabilities -> intents that cannot work without them. */
const SHARED_CAPABILITIES = {
  synthesize_voice: ["send_voice"],
  generate_image: ["send_generated_image"],
  transcribe: [],        // inbound side (speech-to-text)
  acoustic: [],          // inbound side (optional prosody/tone analysis appended to transcripts)
  // No separate `vision` capability: images are passed to the model directly
  // (media-pipeline PLAN: image/sticker = "look"). Listing an unused capability
  // would make missingShared() report a permanent false alarm.
  // file_store: guarantees media files exist with a known name and type;
  // plugins only fetch bytes.
  file_store: [],
};

/** Layer 2: common intents. Every plugin must declare each of these in capabilities. */
const COMMON_INTENTS = [
  "send_text", "send_file", "send_voice", "send_sticker", "send_generated_image", "react",
  // Calls: only start and end. Answering depends on platform multi-device
  // behavior, which the bridge does not control.
  "start_call", "end_call",
];

/**
 * Layer 3: plugin-specific args. Key = arg name, value = channels that honor it.
 * Other channels receiving it report `extra_unsupported` instead of dropping it.
 */
const PLUGIN_EXTRAS = {
  inline_keyboard: ["telegram"],            // option buttons (Bot API only)
  reply_to_message_id: ["telegram"],        // reply to a specific message
  parse_mode: ["telegram"],                 // Markdown rendering
  emoji: ["telegram"],                      // emoji reaction on a message
  message_id: ["telegram"],                 // target message; defaults to the owner's message of this turn
};

/**
 * Classify tool args into the three layers.
 * @returns {{content:object, extras:object, unsupported:Array<{name:string,channel:string,honoredBy:string[]}>}}
 */
function classifyArgs({ args = {}, channel }) {
  const content = {};
  const extras = {};
  const unsupported = [];
  for (const [k, v] of Object.entries(args)) {
    const honoredBy = PLUGIN_EXTRAS[k];
    if (!honoredBy) { content[k] = v; continue; }
    if (v === undefined || v === null || (Array.isArray(v) && !v.length)) continue;
    if (honoredBy.includes(channel)) extras[k] = v;
    else unsupported.push({ name: k, channel, honoredBy });
  }
  return { content, extras, unsupported };
}

/**
 * Plugin self-check: are all common intents declared, which extras are honored.
 * Distinguishes "not wired" from "platform genuinely unsupported".
 */
function describePlugin(plugin) {
  const caps = (plugin && plugin.capabilities) || {};
  const channel = plugin && plugin.channel;
  const missing = COMMON_INTENTS.filter((i) => !caps[i]);
  return {
    channel,
    supported: COMMON_INTENTS.filter((i) => caps[i] === "supported"),
    unsupported: COMMON_INTENTS.filter((i) => caps[i] === "unsupported"),
    undeclared: missing,                      // undeclared = unknown; the gate blocks it
    extras: Object.entries(PLUGIN_EXTRAS).filter(([, ch]) => ch.includes(channel)).map(([k]) => k),
  };
}

/** Shared capabilities not yet registered - checked at wiring time, not at runtime. */
function missingShared(caps) {
  return Object.keys(SHARED_CAPABILITIES).filter((n) => !(caps && caps.has(n)));
}

module.exports = { SHARED_CAPABILITIES, COMMON_INTENTS, PLUGIN_EXTRAS, classifyArgs, describePlugin, missingShared };
