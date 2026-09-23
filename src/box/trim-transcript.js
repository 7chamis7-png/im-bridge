"use strict";
/**
 * Transcript trimming: when the context reaches the waterline, first try to
 * replace old tool output with placeholders instead of starting a new session.
 * The actual rewrite is `scripts/trim-tools.js` (placeholders instead of
 * deleting lines / drop thinking blocks / keep the last N real turns intact /
 * mandatory backup). After trimming the same session is resumed; no
 * conversation text is lost. Trim only if the dry-run estimate is worth it.
 *
 * Pure helpers only (estimate / apply). Stopping the CLI and finding the
 * session id live in the runtime adapter.
 * Token estimate: byte counts are misleading; use the script's token ratio ×
 * the real usage × a calibration factor.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const DEFAULT_SCRIPT = path.join(__dirname, "..", "..", "scripts", "trim-tools.js");
const CALIBRATION = 0.85;   // dry-run estimates ran ~10% high against measured results

/** Transcript location: ~/.claude/projects/<workspace slug>/<threadId>.jsonl (same rule as gate-box-claudecode). */
function transcriptPath(workspaceRoot, threadId, home = os.homedir()) {
  const slug = String(workspaceRoot || "").replace(/[/.]/g, "-");
  return path.join(home, ".claude", "projects", slug, String(threadId) + ".jsonl");
}

/**
 * Dry-run gain estimate.
 * @returns {{ok:true, ratio:number, gain:number}|{ok:false, reason:string}}
 */
function estimateTrimGain({ file, currentTokens = 0, keepRecent = 10, script = DEFAULT_SCRIPT, timeoutMs = 120_000 }) {
  if (!file || !fs.existsSync(file)) return { ok: false, reason: "transcript not found: " + file };
  if (!fs.existsSync(script)) return { ok: false, reason: "trim script not found: " + script };
  let out;
  try {
    out = execFileSync(process.execPath, [script, file, "--dry-run", "--keep-recent", String(keepRecent)], { encoding: "utf8", timeout: timeoutMs });
  } catch (e) { return { ok: false, reason: "dry run failed: " + ((e && e.message) || e) }; }
  const m = /ratio=([0-9.]+)/.exec(out);
  if (!m) return { ok: false, reason: "dry run reported no ratio" };
  const ratio = Number(m[1]);
  if (!Number.isFinite(ratio) || ratio < 0) return { ok: false, reason: "ratio is not a number: " + m[1] };
  return { ok: true, ratio, gain: Math.round(ratio * (Number(currentTokens) || 0) * CALIBRATION), out: out.trim() };
}

/** After trimming the file must still be one intact chain: every parentUuid must resolve. */
function chainIntact(lines) {
  const ids = new Set();
  for (const l of lines) { try { const o = JSON.parse(l); if (o.uuid) ids.add(o.uuid); } catch { return false; } }
  for (const l of lines) {
    const o = JSON.parse(l);
    if (o.parentUuid && !ids.has(o.parentUuid)) return false;
  }
  return true;
}

/**
 * Apply: backup → script writes tmp → validate (non-empty / JSON lines / intact chain) → rename.
 * On any failure the original is untouched and tmp is removed.
 * The caller must stop the CLI first (never rewrite a file that is being appended to).
 */
function applyTrim({ file, keepRecent = 10, script = DEFAULT_SCRIPT, timeoutMs = 120_000, now = new Date() }) {
  if (!file || !fs.existsSync(file)) return { ok: false, reason: "transcript not found: " + file };
  if (!fs.existsSync(script)) return { ok: false, reason: "trim script not found: " + script };
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
  const backup = `${file}.bak-autotrim-${stamp}`;
  const tmp = `${file}.trimtmp`;
  try {
    const before = fs.statSync(file).size;
    fs.copyFileSync(file, backup);
    const out = execFileSync(process.execPath, [script, file, tmp, "--keep-recent", String(keepRecent)], { encoding: "utf8", timeout: timeoutMs });
    const lines = fs.readFileSync(tmp, "utf8").split("\n").filter((l) => l.trim());
    if (!lines.length) throw new Error("trim output is empty");
    if (!chainIntact(lines)) throw new Error("chain broken after trim (a parentUuid points to a missing line)");
    fs.renameSync(tmp, file);
    const after = fs.statSync(file).size;
    return { ok: true, before, after, backup, lines: lines.length, out: out.trim() };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing written */ }
    return { ok: false, reason: (e && e.message) || String(e), backup };
  }
}

module.exports = { transcriptPath, estimateTrimGain, applyTrim, chainIntact, DEFAULT_SCRIPT, CALIBRATION };
