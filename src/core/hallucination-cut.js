"use strict";
/**
 * Detect and cut two "continuation hallucination" shapes from the tail of the
 * agent's own reply text (pure function, one shared copy for the whole bridge).
 *
 * If these tails reach the cold log, a later session rebuilt from that log
 * learns them as real turns and keeps reproducing them.
 *
 * Shape 1 · forged inbound — the agent writes a fake next user turn:
 * ```
 *   …reply text
 *
 *   user<channel source="wechat" seq="936" chat_id="…" message_id="…" ts="…">
 *   some invented user message
 *   </channel>
 *
 *   [Image #1]            ← sometimes followed by this
 * ```
 * Shape 2 · a tool call written as plain text:
 * ```
 *   …reply text
 *
 *   action
 *   <invoke name="mcp__memory__save">
 *   <parameter name="title">…</parameter>
 *   </invoke>
 * ```
 *
 * Rule: cut from the EARLIEST match to the end, then rstrip. For shape 2 a bare
 * `action` line right before it is cut too.
 *
 * Shared by:
 *   A. the box: rewriting the CLI transcript after a turn settles
 *   B. outbound: the cold-log copy uses the cut text (the owner still receives
 *      the original — send as-is, just record it)
 *   C. session rebuild from the cold log (cleans already-dirty history)
 */

/**
 * Shape 1: `user` immediately followed by `<channel`. Deliberately narrow:
 * `user:` in ordinary technical text must not be cut. `[Image #N]`
 * placeholders are allowed between the two; nothing else is.
 */
const FORGED_INBOUND_RE = /\buser\s*(?:\[Image\s*#\d+\]\s*)*<\s*channel\b/i;

/**
 * Shape 2: `<invoke name=` at the START of a line (optionally preceded by a
 * bare `action` line). Anchored to line start so XML mentioned mid-sentence
 * does not count. Group 1 = the preceding newline (or start); cut after it.
 */
const TEXT_TOOL_CALL_RE = /(^|\n)[ \t]*(?:action[ \t]*\r?\n[ \t]*)?<invoke\s+name\s*=/;

const KIND_LABEL = { forged_inbound: "forged inbound", text_tool_call: "text tool call" };

/**
 * @param {string} text
 * @returns {{text:string, cut:string, kind:''|'forged_inbound'|'text_tool_call'}}
 *   Non-empty `cut` = matched. `text` is the trimmed remainder (may be "" when
 *   the whole reply was hallucinated; the caller decides what to do).
 */
function cutHallucinatedTail(text) {
  const s = String(text == null ? "" : text);
  let at = -1;
  let kind = "";
  const a = FORGED_INBOUND_RE.exec(s);
  if (a) { at = a.index; kind = "forged_inbound"; }
  const b = TEXT_TOOL_CALL_RE.exec(s);
  if (b) {
    const start = b.index + b[1].length;
    if (at < 0 || start < at) { at = start; kind = "text_tool_call"; }
  }
  if (at < 0) return { text: s, cut: "", kind: "" };
  return { text: s.slice(0, at).trimEnd(), cut: s.slice(at), kind };
}

/** Detection only (no cut). */
function hasHallucinatedTail(text) {
  return cutHallucinatedTail(text).cut !== "";
}

module.exports = { cutHallucinatedTail, hasHallucinatedTail, FORGED_INBOUND_RE, TEXT_TOOL_CALL_RE, KIND_LABEL };
