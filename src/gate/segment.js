"use strict";

/**
 * Segmentation: split a reply into chat bubbles at the author's own breaks.
 *
 * Two different things are both called "segmentation":
 *
 *   - Platform hard limits (e.g. WeChat ~3500 chars, Telegram ~3900) belong to
 *     the plugin; the gate knows nothing about them.
 *   - Splitting at the author's breathing points (blank lines, merging short
 *     pieces) is shared and platform-independent: this file. Keeping it shared
 *     avoids each plugin re-implementing (or forgetting) it.
 *
 * ## Rules (derived from measuring real replies)
 *
 * 1. Split only on blank lines. Single newlines are layout (lists, verse);
 *    splitting there breaks the shape. Blank lines are boundaries the author
 *    already chose, so no sentence analysis is needed.
 * 2. Don't split on sentence punctuation. Many chat styles barely use full
 *    stops and separate clauses with spaces instead.
 * 3. Merge pieces that are too short into the next one; a too-short tail is
 *    merged back into the previous one. Avoids strings of tiny bubbles.
 * 4. No bubble cap by default. Capping fights with length: merging a long
 *    message back into N bubbles yields one huge block. Callers may configure it.
 * 5. Fallback splitting of very long paragraphs is off by default: most
 *    paragraphs are already well sized, and a low threshold would cut many
 *    well-formed ones. If enabled, use a threshold around 150 chars.
 */

/** Minimum bubble length; shorter pieces get merged */
const DEFAULT_MIN_CHARS = 14;

const len = (s) => Array.from(String(s || "")).length;

/**
 * @param {object} [o]
 * @param {number} [o.minChars]   merge pieces shorter than this into the next
 * @param {number} [o.maxBubbles] max bubbles; 0 = no cap (default), see rule 4
 * @param {number} [o.softMax]    split paragraphs longer than this at spaces.
 *   0 = off (default), see rule 5
 */
function makeSegmenter({ minChars = DEFAULT_MIN_CHARS, maxBubbles = 0, softMax = 0 } = {}) {
  return {
    /** @returns {string[]} one entry per bubble; empty text -> [] */
    segment(text) {
      const s = String(text || "").replace(/\r\n?/g, "\n").trim();
      if (!s) return [];

      // 1. split on blank lines only - the author's own boundaries
      let parts = s.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
      if (!parts.length) return [];

      // 2. fallback for very long paragraphs: split at spaces (off by default)
      if (softMax > 0) {
        const out = [];
        for (const p of parts) {
          if (len(p) <= softMax) { out.push(p); continue; }
          // split at spaces - in CJK chat text pauses are usually spaces, not punctuation
          const segs = p.split(/(?<=[一-龥\w。！？!?…—])\s+/);
          let cur = "";
          for (const seg of segs) {
            if (cur && len(cur + " " + seg) > softMax) { out.push(cur); cur = seg; }
            else cur = cur ? cur + " " + seg : seg;
          }
          if (cur) out.push(cur);
        }
        parts = out;
      }

      // 3. merge too-short pieces into the next one
      const merged = [];
      for (const p of parts) {
        if (merged.length && len(merged[merged.length - 1]) < minChars) {
          merged[merged.length - 1] += "\n\n" + p;
        } else merged.push(p);
      }
      // a too-short tail is merged back into the previous bubble
      if (merged.length > 1 && len(merged[merged.length - 1]) < minChars) {
        const tail = merged.pop();
        merged[merged.length - 1] += "\n\n" + tail;
      }

      // 4. optional cap: merge the overflow into the last bubble
      if (maxBubbles > 0) {
        while (merged.length > maxBubbles) {
          const tail = merged.pop();
          merged[merged.length - 1] += "\n\n" + tail;
        }
      }
      return merged;
    },
  };
}

module.exports = { makeSegmenter, DEFAULT_MIN_CHARS };
