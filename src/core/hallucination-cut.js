"use strict";
/**
 * Detect and cut three "continuation hallucination" shapes from the tail of the
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
 * Shape 3 · any angle-bracket tag at the START of a line:
 * ```
 *   …reply text
 *
 *   user<system-reminder>check-in: …</system-reminder>
 *   <system_warning>Long conversation reminder: …</system_warning>
 *   <channel source="wechat" …>…</channel>     ← also without a `user` prefix
 * ```
 * Shape 1 only knew the `<channel` name, so forged system reminders and leaked
 * harness tags slipped through. In a review of all past agent replies, every
 * line-leading `<englishTag` was invented or leaked and none was ordinary
 * speech; a tag mentioned mid-sentence is not at line start and does not
 * match. So tag names are no longer listed: a line-leading tag is cut. Tags
 * inside ``` code fences do not count.
 *
 * Rule: cut from the EARLIEST match to the end, then rstrip. Everything the
 * agent said before the match is kept verbatim. For shape 2 a bare `action`
 * line right before it is cut too.
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

/**
 * Shape 3: a `<tag` at the START of a line, optionally preceded by `user` and
 * a few `[Image #N]` placeholders, or by a short `word:` prefix (seen in the
 * wild as `question<localized word>:<channel …>`). Group 1 = the preceding newline (or start);
 * the cut starts after it. `<invoke` belongs to shape 2 and is skipped here.
 */
const LINE_START_TAG_RE = /(^|\n)[ \t]*(?:[A-Za-z\u4e00-\u9fff]{1,12}[:：][ \t]*)?(?:user[ \t]*(?:\[Image\s*#\d+\][ \t]*)*)?<\s*\/?\s*(?!invoke\b)[A-Za-z][\w:-]*/g;

/** Whether position `at` is inside a ``` code fence (odd number of fences before it). */
function insideCodeFence(s, at) {
  return ((s.slice(0, at).match(/```/g) || []).length % 2) === 1;
}

function firstLineStartTag(s) {
  LINE_START_TAG_RE.lastIndex = 0;
  let m;
  while ((m = LINE_START_TAG_RE.exec(s))) {
    const start = m.index + m[1].length;
    if (!insideCodeFence(s, start)) return start;
  }
  return -1;
}

const KIND_LABEL = { forged_inbound: "forged inbound", text_tool_call: "text tool call", line_start_tag: "line-start tag" };

/**
 * @param {string} text
 * @returns {{text:string, cut:string, kind:''|'forged_inbound'|'text_tool_call'|'line_start_tag'}}
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
  const c = firstLineStartTag(s);
  if (c >= 0 && (at < 0 || c < at)) { at = c; kind = "line_start_tag"; }
  if (at < 0) return { text: s, cut: "", kind: "" };
  return { text: s.slice(0, at).trimEnd(), cut: s.slice(at), kind };
}

/** Detection only (no cut). */
function hasHallucinatedTail(text) {
  return cutHallucinatedTail(text).cut !== "";
}

module.exports = { cutHallucinatedTail, hasHallucinatedTail, FORGED_INBOUND_RE, TEXT_TOOL_CALL_RE, LINE_START_TAG_RE, KIND_LABEL };
