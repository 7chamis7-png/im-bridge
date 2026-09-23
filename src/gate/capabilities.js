"use strict";

/**
 * Shared capability registry (SPEC §7.1).
 *
 * Each capability (transcription, vision, voice synthesis, image generation, ...)
 * has exactly one implementation shared by every connected channel. A new channel
 * only has to implement "how to send/receive on this platform".
 *
 * Two boundaries:
 *  - Capabilities are processing *outside* the gate (§0.1). Plugins use them; the gate itself doesn't.
 *  - Generation and delivery are separate steps (§7.1): ask the plugin whether it can deliver
 *    *before* starting an expensive generation, so we never synthesize voice that can't be sent.
 */

/** Three separate dimensions of platform support (§7.3) — mixing them hides "unsupported" vs "not wired". */
const SUPPORT = { SUPPORTED: "supported", UNSUPPORTED: "unsupported", UNKNOWN: "unknown" };
const WIRED = { WIRED: "wired", NOT_WIRED: "not_wired" };
const AVAIL = { READY: "ready", OFFLINE: "offline", DEGRADED: "degraded" };

class Capabilities {
  constructor() {
    this.impls = new Map();
  }

  /** Register an implementation. Registering the same name twice is an error: exactly one is a hard rule. */
  register(name, impl) {
    if (this.impls.has(name)) throw new Error("公共能力 " + name + " 已注册，不允许第二份实现");
    if (typeof impl !== "function") throw new Error("公共能力 " + name + " 的实现必须是函数");
    this.impls.set(name, impl);
    return this;
  }

  has(name) { return this.impls.has(name); }

  async call(name, args) {
    const impl = this.impls.get(name);
    if (!impl) throw new Error("公共能力未注册: " + name);
    return impl(args);
  }

  list() { return [...this.impls.keys()].sort(); }
}

/**
 * Can this outbound intent be delivered? Call this *before* any expensive generation.
 * @returns {{ok:boolean, reason?:string, detail?:object}}
 */
function precheck({ intent, plugin, caps, hasSuppliedFile = false }) {
  if (!plugin) return { ok: false, reason: "plugin_not_wired" };

  const decl = (plugin.capabilities && plugin.capabilities[intent]) || SUPPORT.UNKNOWN;
  if (decl === SUPPORT.UNSUPPORTED) {
    return { ok: false, reason: "platform_unsupported", detail: { intent, channel: plugin.channel } };
  }
  if (decl === SUPPORT.UNKNOWN) {
    return { ok: false, reason: "platform_support_unknown", detail: { intent, channel: plugin.channel } };
  }

  const h = typeof plugin.health === "function" ? plugin.health() : {};
  if (h.plugin === WIRED.NOT_WIRED) return { ok: false, reason: "plugin_not_wired" };
  if (h.availability === AVAIL.OFFLINE) return { ok: false, reason: "channel_offline" };

  // Which shared capability does this intent need? If it isn't registered, say so explicitly
  // instead of silently degrading to text. A missing registry counts as "not registered" too,
  // otherwise the failure only surfaces mid-send as capability_failed.
  // If the agent already supplied a file (e.g. an existing image), no generator is needed:
  // the intent is "send an image", and its source may be a path or a fresh generation.
  const need = hasSuppliedFile ? null : INTENT_NEEDS[intent];
  if (need && (!caps || !caps.has(need))) {
    return { ok: false, reason: "capability_not_registered", detail: { intent, need } };
  }
  return { ok: true };
}

/**
 * Did this turn already come with a file? If so, don't generate one — that wastes money
 * and produces misleading errors such as "a prompt is required".
 */
function hasSuppliedFile(turn) {
  const t = turn || {};
  const pick = (o) => o && (o.filePath || o.file_path || o.path);
  return Boolean(pick(t.toolArgs) || pick(t.extras));
}

/** intent -> required shared capability. Intents not listed need none (e.g. plain text). */
const INTENT_NEEDS = {
  send_voice: "synthesize_voice",
  send_generated_image: "generate_image",
};

module.exports = { Capabilities, precheck, SUPPORT, WIRED, AVAIL, INTENT_NEEDS, hasSuppliedFile };
