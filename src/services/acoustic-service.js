"use strict";

// Optional acoustic analysis for voice attachments ("how it was said", not
// "what was said"). Runs an external script that prints JSON to stdout.
// Best effort: any failure returns an empty string and never affects transcription.
//
// Configuration:
//   AGENT_ACOUSTIC_SCRIPT      path to the analyzer script (empty = feature off)
//   AGENT_ACOUSTIC_PYTHON      interpreter used to run it (default: python3)
//   AGENT_ACOUSTIC_TIMEOUT_MS  default 30000
//
// Expected script output: `<script> <audio> --json` prints either
//   { "text": "..." }                                    used verbatim, or
//   { "total_duration": n, "segments": [ {...}, ... ] }  summarized generically.

const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

function isConfigured(env = process.env) {
  return Boolean(normalizeText(env.AGENT_ACOUSTIC_SCRIPT));
}

async function analyzeAcoustics(filePath, options = {}) {
  const audioPath = normalizeText(filePath);
  if (!audioPath) return "";
  const script = normalizeText(options.script || process.env.AGENT_ACOUSTIC_SCRIPT);
  if (!script) return "";
  const python = normalizeText(options.python || process.env.AGENT_ACOUSTIC_PYTHON) || "python3";
  try {
    const { stdout } = await execFileAsync(python, [script, audioPath, "--json"], {
      timeout: options.timeoutMs || Number(process.env.AGENT_ACOUSTIC_TIMEOUT_MS) || 30000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return summarizeAcoustics(JSON.parse(stdout));
  } catch {
    // Decoding errors, timeouts and missing scripts all degrade silently.
    return "";
  }
}

// Compress the analyzer output into one line of raw numbers for the agent to read.
function summarizeAcoustics(data) {
  if (data && typeof data.text === "string") return data.text.trim();
  const segments = Array.isArray(data?.segments) ? data.segments : [];
  if (!segments.length) return "";
  const parts = segments.map((seg, index) => {
    const fields = Object.entries(seg || {})
      .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
      .map(([k, v]) => `${k}=${v}`);
    return `#${index + 1} ${fields.join(" ")}`;
  });
  const dur = data.total_duration != null ? `${data.total_duration}s/` : "";
  return `[acoustic ${dur}${segments.length}seg] ${parts.join(" ; ")}`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  analyzeAcoustics,
  isConfigured,
};
