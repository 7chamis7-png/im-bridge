#!/usr/bin/env node
"use strict";

/**
 * Transcript tool-output trimming for Claude Code session files (.jsonl).
 *
 * In long agent sessions tool inputs/results dominate the context (often
 * >90% of the text). Trimming them keeps the session alive longer instead of
 * rotating to a fresh session and losing continuity.
 *
 * Rules:
 * 1. Replace tool results with placeholders; never delete whole lines.
 *    A visible "archived" marker keeps the model from inventing what used to
 *    be there; a silent hole invites confabulation.
 * 2. Drop thinking blocks entirely (half-kept fragments are worse).
 * 3. Keep the last N real turns untouched (default 10) so recent tool output
 *    can still be re-read (numbers, receipts, …).
 * 4. Always back up (the caller, src/box/trim-transcript.js, does this).
 *
 * Replacing content instead of deleting lines keeps the parentUuid chain
 * intact. A line is only removed when its content becomes empty (pure
 * thinking), and then its children are relinked to the nearest live ancestor.
 *
 * Usage:
 *   node trim-tools.js <in> <out> [--keep-recent N] [--new-sid]
 *   node trim-tools.js <in> --dry-run [--keep-recent N]
 *
 * --dry-run: read-only; prints the estimated savings (tokens + ratio) so the
 * caller can decide whether trimming is worth breaking the prompt cache.
 */

const fs = require("fs");
const crypto = require("crypto");

const [, , inPath, ...rest] = process.argv;
let outPath = rest[0];
const flags = rest.slice(1);
// --dry-run may appear in the output-path position or after it.
const dryRun = flags.includes("--dry-run") || outPath === "--dry-run";
if (dryRun) outPath = null;
if (!inPath || (!outPath && !dryRun)) {
  console.error("usage: node trim-tools.js <in.jsonl> <out.jsonl> [--keep-recent N] [--new-sid]");
  console.error("       node trim-tools.js <in.jsonl> --dry-run [--keep-recent N]");
  process.exit(1);
}
const krIdx = flags.indexOf("--keep-recent");
const keepRecent = krIdx >= 0 ? Math.max(0, parseInt(flags[krIdx + 1], 10) || 0) : 10;
const newSid = flags.includes("--new-sid") ? crypto.randomUUID() : null;

// File tools (Read/Write/Edit/Glob/Grep) keep the head of their result; other
// tools (browsing, search, MCP) are machine-to-machine output and become a bare placeholder.
const KEEP_HEAD = /^(Read|Write|Edit|MultiEdit|Glob|Grep|NotebookEdit)$/;
const HEAD_CHARS = 500;
const RESULT_THRESHOLD = 400;
const INPUT_THRESHOLD = 400;

// Inputs of memory-writing tools are always archived regardless of length:
// they are long-lived text the model would otherwise keep seeing.
const ALWAYS_ARCHIVE_INPUT = /(memorize|memory_write|reminder_create|diary_write)/i;

// Memory-retrieval results are archived too, but the placeholder says "query
// again if needed" — the source still exists, so the model should re-fetch
// rather than treat it as a gap.
const MEMORY_TOOL_RESULT = /(breath|remember|recall|diary_search|diary_read|memory_search|black_room_read)/i;

const lines = fs.readFileSync(inPath, "utf8").split("\n").filter((l) => l.trim());

// ── Guard line: count keepRecent real turns back from the end; lines after it stay untouched ──
let guardFrom = lines.length;
if (keepRecent > 0) {
  let seen = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let e = null;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    const c = e.message && e.message.content;
    const hasText = Array.isArray(c)
      ? c.some((b) => b && b.type === "text" && String(b.text || "").trim())
      : typeof c === "string" && c.trim();
    if (hasText && (e.type === "user" || e.type === "assistant")) {
      seen += 1;
      if (seen >= keepRecent) { guardFrom = i; break; }
    }
  }
}

// ── Token estimate (dry run) ──
// Do not estimate tokens from byte counts: images are stored as base64 but the
// API bills them by pixel size (~290 tokens for a typical chat image).
const IMG_TOKENS = 290;
function estTokens(str) {
  if (!str) return 0;
  const s = String(str);
  const cjk = (s.match(/[一-鿿　-〿＀-￯]/g) || []).length;
  const bytes = Buffer.byteLength(s, "utf8");
  return cjk + Math.max(0, Math.floor((bytes - cjk * 3) / 4));
}
function estBlock(b) {
  if (!b || typeof b !== "object") return estTokens(b);
  switch (b.type) {
    case "image": return IMG_TOKENS;
    case "thinking": return estTokens(b.thinking || "");
    case "text": return estTokens(b.text || "");
    case "tool_use": return estTokens(JSON.stringify(b.input ?? {}));
    case "tool_result": {
      const c = b.content;
      if (Array.isArray(c)) return c.reduce((n, x) => n + estBlock(x), 0);
      return estTokens(JSON.stringify(c ?? ""));
    }
    default: return estTokens(JSON.stringify(b));
  }
}
function estEntry(e) {
  const c = e && e.message && e.message.content;
  if (typeof c === "string") return estTokens(c);
  if (Array.isArray(c)) return c.reduce((n, b) => n + estBlock(b), 0);
  return 0;
}

const textOf = (v) => (typeof v === "string" ? v : JSON.stringify(v ?? ""));

function shortName(name) {
  return String(name || "tool")
    .replace(/^mcp__[a-z0-9_]+__/, "")
    .replace(/^Bash$/, "bash");
}

/** Tool result → placeholder (file tools keep the first HEAD_CHARS chars).
 *  Array content may contain image blocks (large base64) and other block
 *  types, so size is judged on the whole JSON and images are replaced separately. */
function compressResult(block, toolName) {
  const raw = block.content;
  const bulk = JSON.stringify(raw ?? "").length;
  if (bulk <= RESULT_THRESHOLD) return false;

  const label = shortName(toolName);

  // Memory retrieval: say explicitly that it can be fetched again.
  if (MEMORY_TOOL_RESULT.test(String(toolName || ""))) {
    block.content = [{ type: "text", text: `[${label}: retrieved memory archived (${bulk} chars). The source still exists; query again if needed]` }];
    return true;
  }

  if (Array.isArray(raw)) {
    let changed = false;
    const next = [];
    let textDone = false;
    for (const b of raw) {
      if (!b || typeof b !== "object") { next.push(b); continue; }
      if (b.type === "image") {
        const bytes = (((b.source || {}).data) || "").length;
        next.push({ type: "text", text: `[image: archived, base64 ${bytes} bytes]` });
        changed = true; nImage += 1; continue;
      }
      if (b.type === "text") {
        const t = b.text || "";
        if (t.length > RESULT_THRESHOLD) {
          const rep = KEEP_HEAD.test(toolName)
            ? `${t.slice(0, HEAD_CHARS)}\n…[${label}: content archived, original ${t.length} chars]`
            : `[${label}: done, ${t.length} chars of output archived]`;
          next.push({ ...b, text: rep }); changed = true; textDone = true; continue;
        }
      }
      next.push(b);
    }
    if (changed) block.content = next;
    return changed;
  }

  const t = String(raw);
  if (t.length <= RESULT_THRESHOLD) return false;
  block.content = KEEP_HEAD.test(toolName)
    ? `${t.slice(0, HEAD_CHARS)}\n…[${label}: content archived, original ${t.length} chars]`
    : `[${label}: done, ${t.length} chars of output archived]`;
  return true;
}

/** Images are archived everywhere, including inside the guarded tail.
 *  The gain is small (~290 tokens per image) but free; the originals stay on
 *  disk in the inbox if the model needs to look again. */
function stripImagesOnly(content) {
  let n = 0;
  const walk = (arr) => {
    if (!Array.isArray(arr)) return arr;
    return arr.map((b) => {
      if (!b || typeof b !== "object") return b;
      if (b.type === "image") {
        const bytes = (((b.source || {}).data) || "").length;
        n += 1;
        return { type: "text", text: `[image: archived, base64 ${bytes} bytes]` };
      }
      if (b.type === "tool_result" && Array.isArray(b.content)) {
        b.content = walk(b.content);
      }
      return b;
    });
  };
  const next = walk(content);
  if (n) content.splice(0, content.length, ...next);
  return n;
}

/** Tool input → truncated hint (enough to know what the call was about). */
function compressInput(block, toolName) {
  const raw = block.input ?? {};
  const s = JSON.stringify(raw);
  const always = ALWAYS_ARCHIVE_INPUT.test(String(toolName || ""));
  if (always) {
    // Memory writes: keep only a title hint.
    const title = String(raw.title || raw.text || raw.name || "").slice(0, 40);
    block.input = { _archived: title ? `${title}… [memory text ${s.length} chars archived]` : `[memory text ${s.length} chars archived]` };
    return true;
  }
  if (s.length <= INPUT_THRESHOLD) return false;
  // Keep one hint (path / query / url, first 80 chars); drop the rest.
  const hint = raw.file_path || raw.path || raw.url || raw.query || raw.command || raw.pattern || "";
  const brief = String(hint).slice(0, 80);
  block.input = brief
    ? { _archived: `${brief}${String(hint).length > 80 ? "…" : ""} [input ${s.length} chars archived]` }
    : { _archived: `[input ${s.length} chars archived]` };
  return true;
}

// ── Pass 1: compress in place, record lines that became empty ──
const parentOf = new Map();
const doomed = new Set();
const parsed = [];
let nResult = 0, nInput = 0, nThinking = 0, nImage = 0;
let estBefore = 0, estAfter = 0;   // dry run: estimated tokens before/after

for (let idx = 0; idx < lines.length; idx += 1) {
  const raw = lines[idx];
  let e = null;
  try { e = JSON.parse(raw); } catch { parsed.push({ raw, e: null }); continue; }
  if (e.uuid) parentOf.set(e.uuid, e.parentUuid ?? null);
  estBefore += estEntry(e);

  const content = e.message && e.message.content;
  if (idx < guardFrom && Array.isArray(content)) {
    // map tool_use id → name so results can be labeled
    const nameById = new Map();
    for (const b of content) if (b && b.type === "tool_use") nameById.set(b.id, b.name);

    const next = [];
    for (const b of content) {
      if (!b) continue;
      if (b.type === "thinking") { nThinking += 1; continue; }          // drop entirely
      if (b.type === "tool_use") { if (compressInput(b, b.name)) nInput += 1; next.push(b); continue; }
      if (b.type === "tool_result") {
        const nm = b.__name || nameById.get(b.tool_use_id) || e.__toolName || "";
        if (compressResult(b, nm)) nResult += 1;
        next.push(b); continue;
      }
      next.push(b);
    }
    e.message.content = next;
    if (next.length === 0 && e.uuid) doomed.add(e.uuid);                // delete only if emptied
  } else if (Array.isArray(content)) {
    // Guarded tail: leave everything except images.
    nImage += stripImagesOnly(content);
  }
  estAfter += estEntry(e);
  parsed.push({ raw, e });
}

function livingAncestor(uuid) {
  let p = uuid; const seen = new Set();
  while (p && doomed.has(p)) {
    if (seen.has(p)) return null;
    seen.add(p); p = parentOf.get(p) ?? null;
  }
  return p ?? null;
}

// ── Pass 2: write out, relinking parentUuid of deleted lines to the nearest live ancestor ──
let kept = 0, killed = 0, relinked = 0;
const out = [];
for (const item of parsed) {
  const e = item.e;
  if (!e) { out.push(item.raw); kept += 1; continue; }
  if (e.uuid && doomed.has(e.uuid)) { killed += 1; continue; }
  if (e.parentUuid && doomed.has(e.parentUuid)) { e.parentUuid = livingAncestor(e.parentUuid); relinked += 1; }
  if (newSid && e.sessionId) e.sessionId = newSid;
  out.push(JSON.stringify(e));
  kept += 1;
}

if (dryRun) {
  // Absolute numbers are rough (CJK text tokenizes differently); callers
  // should multiply the ratio by real usage instead of using delta directly.
  const delta = estBefore - estAfter;
  const ratio = estBefore > 0 ? delta / estBefore : 0;
  console.log(`DRY_RUN est_before=${estBefore} est_after=${estAfter} est_delta=${delta} ratio=${ratio.toFixed(4)}`);
  console.log(`  dry run: est. savings ${(delta / 1000).toFixed(1)}k / ${(estBefore / 1000).toFixed(1)}k = ${(ratio * 100).toFixed(1)}%`);
  console.log(`  tool results→placeholder ${nResult} | inputs truncated ${nInput} | thinking removed ${nThinking} | images archived ${nImage}`);
  process.exit(0);
}

fs.writeFileSync(outPath, out.join("\n") + "\n");

const a = fs.statSync(inPath).size, b = fs.statSync(outPath).size;
console.log(`  input  ${lines.length} lines / ${a.toLocaleString()} bytes`);
console.log(`  output ${kept} lines / ${b.toLocaleString()} bytes   (-${(100 - b / a * 100).toFixed(1)}%)`);
console.log(`  tool results→placeholder ${nResult} | inputs truncated ${nInput} | thinking removed ${nThinking} | images archived ${nImage}`);
console.log(`  emptied lines removed ${killed} | relinked ${relinked}`);
if (keepRecent > 0) console.log(`  guarded: last ${keepRecent} real turns (from line ${guardFrom + 1}) kept as-is, except images`);
if (newSid) console.log(`  new sessionId: ${newSid}`);
