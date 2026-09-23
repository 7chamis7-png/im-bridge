"use strict";

/**
 * Inbound acceptance check.
 *
 * The gate does not decode, but it does verify. If a plugin skipped a
 * processing step (e.g. forgot zstd decompression) and hands in garbage, the
 * gate recognizes "this is not human text", flags and records it, and never
 * lets it pose as something the owner said.
 *
 * Note: newline, carriage return and tab are normal text, not bad characters.
 * Forgetting that exclusion misclassifies almost every multi-line message.
 */

/** Must stay identical to looks_binary() in the WeChat db-watch.py. */
function looksBinary(text) {
  const s = String(text || "");
  if (!s) return false;
  let bad = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 0xfffd || (c < 32 && ch !== "\n" && ch !== "\r" && ch !== "\t")) bad += 1;
  }
  return bad >= 3 || bad / s.length > 0.05;
}

/** Plugins must declare which processing steps they applied; the gate verifies accordingly. */
const KNOWN_STEPS = new Set([
  "decrypted",      // platform decryption
  "decompressed",   // decompression (WeChat long text uses zstd)
  "parsed",         // platform-specific format parsing (e.g. appmsg xml)
  "transcribed",    // speech transcription
  "none",           // explicitly "no processing needed"
]);

/**
 * @returns {{ok: boolean, verdict: string, reasons: string[]}}
 *   verdict: accepted | undecoded | no_content
 *   undecoded is not dropped: the event is still recorded, but its text may
 *   never be presented as the user's words.
 */
function verifyInbound(delivery) {
  const reasons = [];
  const steps = Array.isArray(delivery && delivery.processing) ? delivery.processing : [];
  for (const s of steps) {
    if (!KNOWN_STEPS.has(s)) reasons.push("未知的处理步骤声明: " + s);
  }
  if (!steps.length) reasons.push("缺少处理链声明（0.5 要求插件声明自己做了什么）");

  const text = String((delivery && delivery.text) || "");
  const media = (delivery && delivery.media) || [];
  const hasMedia = Array.isArray(media) && media.length > 0;

  if (!text && !hasMedia) {
    return { ok: false, verdict: "no_content", reasons: reasons.concat("既无正文也无媒体") };
  }
  if (text && looksBinary(text)) {
    reasons.push("正文未能解码成人类可读文本 —— 插件可能漏了某一步加工");
    return { ok: false, verdict: "undecoded", reasons };
  }
  return { ok: reasons.length === 0, verdict: "accepted", reasons };
}

module.exports = { looksBinary, verifyInbound, KNOWN_STEPS };
