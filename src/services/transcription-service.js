"use strict";

const { execFile } = require("child_process");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const SILK_MAGIC = Buffer.from([0x02, 0x23, 0x21, 0x53, 0x49, 0x4c, 0x4b]); // \x02#!SILK

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "whisper-1";


// Local whisper fallback, used when the remote API is unavailable or fails.
// Requires the `openai-whisper` Python package.
//   AGENT_TRANSCRIPTION_LOCAL=false            disable the fallback
//   AGENT_TRANSCRIPTION_LOCAL_MODEL            whisper model name (default: small;
//                                              noticeably more accurate than base
//                                              for short, noisy clips)
//   AGENT_TRANSCRIPTION_PYTHON                 interpreter (default: python3)
//   AGENT_TRANSCRIPTION_LOCAL_PROMPT           initial_prompt hint
//   AGENT_TRANSCRIPTION_LOCAL_TIMEOUT_MS       default 180000
//   AGENT_TRANSCRIPTION_LANGUAGE               forced language, API and local (default: zh)
async function transcribeLocally(audioPath) {
  if (String(process.env.AGENT_TRANSCRIPTION_LOCAL || "true").toLowerCase() === "false") {
    return "";
  }
  const model = normalizeText(process.env.AGENT_TRANSCRIPTION_LOCAL_MODEL) || "small";
  const language = normalizeText(process.env.AGENT_TRANSCRIPTION_LANGUAGE) || "zh";
  const py = normalizeText(process.env.AGENT_TRANSCRIPTION_PYTHON) || "python3";
  const localPrompt = normalizeText(process.env.AGENT_TRANSCRIPTION_LOCAL_PROMPT)
    || "以下是普通话的简体中文语音内容。";
  const script = [
    "import sys, json, whisper",
    `m = whisper.load_model(${JSON.stringify(model)})`,
    // initial_prompt steers script/vocabulary (e.g. without it whisper may emit
    // Traditional instead of Simplified Chinese).
    `r = m.transcribe(sys.argv[1], language=${JSON.stringify(language)}, fp16=False, initial_prompt=${JSON.stringify(localPrompt)})`,
    "print(json.dumps({'text': r.get('text','')}, ensure_ascii=False))",
  ].join("\n");
  const { stdout } = await execFileAsync(py, ["-c", script, audioPath], {
    timeout: Number(process.env.AGENT_TRANSCRIPTION_LOCAL_TIMEOUT_MS) || 180000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const line = String(stdout || "").trim().split("\n").pop();
  return normalizeText(JSON.parse(line).text);
}

async function transcribeAudioFile(filePath, options = {}) {
  const normalizedPath = normalizeText(filePath);
  if (!normalizedPath) {
    throw new Error("audio file path is required");
  }

  const apiKey = normalizeText(
    options.apiKey
    || process.env.AGENT_TRANSCRIPTION_API_KEY
    || process.env.OPENAI_API_KEY
  );
  if (!apiKey) {
    // No API key: try the local fallback before giving up.
    const local = await transcribeLocally(normalizedPath).catch(() => "");
    if (local) return local;
    throw new Error("Missing AGENT_TRANSCRIPTION_API_KEY or OPENAI_API_KEY");
  }

  const baseUrl = normalizeText(options.baseUrl || process.env.AGENT_TRANSCRIPTION_BASE_URL) || DEFAULT_BASE_URL;
  const model = normalizeText(options.model || process.env.AGENT_TRANSCRIPTION_MODEL) || DEFAULT_MODEL;
  // Force the language so short/breathy clips are not misdetected.
  const language = normalizeText(options.language || process.env.AGENT_TRANSCRIPTION_LANGUAGE) || "zh";
  let audioPath = normalizedPath;
  let tmpFile = null;
  try {
    const header = Buffer.alloc(7);
    const fh = await fs.open(normalizedPath, "r");
    await fh.read(header, 0, 7, 0);
    await fh.close();
    if (header.slice(0, 7).equals(SILK_MAGIC)) {
      tmpFile = path.join(os.tmpdir(), `im-bridge-silk-${Date.now()}.mp3`);
      const pcmFile = tmpFile.replace(".mp3", ".pcm");
      await execFileAsync("python3", ["-c",
        `import pilk; pilk.decode(${JSON.stringify(normalizedPath)}, ${JSON.stringify(pcmFile)})`
      ]);
      await execFileAsync("ffmpeg", ["-f", "s16le", "-ar", "24000", "-ac", "1", "-i", pcmFile, "-y", tmpFile]);
      await fs.unlink(pcmFile).catch(() => {});
      audioPath = tmpFile;
    }
  } catch {
    // If SILK detection/conversion fails, fall through with original file.
  }

  const audioBuffer = await fs.readFile(audioPath);
  if (tmpFile) fs.unlink(tmpFile).catch(() => {});
  const form = new FormData();
  form.append("model", model);
  if (language) form.append("language", language);
  form.append(
    "file",
    new Blob([audioBuffer], { type: inferAudioMimeType(audioPath) }),
    path.basename(audioPath)
  );

  const apiTimeoutMs = Number(process.env.AGENT_TRANSCRIPTION_API_TIMEOUT_MS) || 45000;
  let apiError = null;
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/g, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(apiTimeoutMs),
    });
    const bodyText = await response.text();
    let body = {};
    try { body = JSON.parse(bodyText); } catch { /* Keep raw bodyText for error reporting. */ }
    if (!response.ok) {
      throw new Error(`Transcription API error ${response.status}: ${body?.error?.message || bodyText}`);
    }
    const text = normalizeText(body.text);
    if (text) return text;
    apiError = new Error("Transcription API returned empty text");
  } catch (error) {
    apiError = error;
  }

  // Remote gave no text: fall back to local so the voice message is not lost.
  const local = await transcribeLocally(audioPath).catch((error) => {
    console.error(`[transcription] local fallback failed too: ${error.message}`);
    return "";
  });
  if (local) {
    console.warn(`[transcription] remote failed (${apiError?.message?.slice(0, 80)}), used local whisper`);
    return local;
  }
  throw apiError;
}

function isAudioAttachment(item) {
  const kind = normalizeText(item?.kind).toLowerCase();
  if (kind === "audio" || kind === "voice") {
    return true;
  }
  const contentType = normalizeText(item?.contentType).toLowerCase();
  if (contentType.startsWith("audio/")) {
    return true;
  }
  const fileName = normalizeText(item?.absolutePath || item?.fileName || item?.sourceFileName).toLowerCase();
  return [".ogg", ".oga", ".opus", ".mp3", ".m4a", ".wav", ".webm", ".flac", ".aac", ".amr"]
    .some((extension) => fileName.endsWith(extension));
}

function inferAudioMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const map = {
    ".aac": "audio/aac",
    ".amr": "audio/amr",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".oga": "audio/ogg",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".wav": "audio/wav",
    ".webm": "audio/webm",
  };
  return map[extension] || "application/octet-stream";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  isAudioAttachment,
  transcribeAudioFile,
};
