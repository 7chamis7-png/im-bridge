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


// 2026-08-29 Keeper：本地 whisper 兜底。
// 搬到德国后发现转写全线 503 → 查出来是两件事叠一起：
//   ① 硅基流动的 FunAudioLLM/SenseVoiceSmall 服务端挂了（洛杉矶也 503，跟搬家无关）
//   ② 换成 Qwen/Qwen3-ASR-1.7B 洛杉矶 1.5 秒就好，但【德国连不通】——
//      TCP 能连上、GET 模型列表也通，一上传文件就卡死到超时。MTU 排除过（1472 字节能过）。
//      结论是它对境外 IP 的上传端点不通，不是我们能修的。
// 所以：API 失败就转本地。模型早就在 /root/.cache/whisper（base.pt / small.pt），
// 纯 CPU，四秒的语音大概几秒出字，比"没有字"强得多。
// 关掉本地兜底：NOVA_TRANSCRIPTION_LOCAL=false
async function transcribeLocally(audioPath) {
  if (String(process.env.NOVA_TRANSCRIPTION_LOCAL || "true").toLowerCase() === "false") {
    return "";
  }
  // small 比 base 慢一倍(12.6s vs 5.6s)但准得多：
  // base 把"字幕"听成"自我"、"彩蛋"听成"采代"，small 全对。
  // 她的语音本来就带哼带气，听岔了还不如不听 —— 所以默认吃这个时间。
  const model = normalizeText(process.env.NOVA_TRANSCRIPTION_LOCAL_MODEL) || "small";
  const language = normalizeText(process.env.NOVA_TRANSCRIPTION_LANGUAGE) || "zh";
  const py = normalizeText(process.env.NOVA_TRANSCRIPTION_PYTHON) || "python3";
  const localPrompt = normalizeText(process.env.NOVA_TRANSCRIPTION_LOCAL_PROMPT)
    || "以下是普通话的简体中文语音内容。";
  const script = [
    "import sys, json, whisper",
    `m = whisper.load_model(${JSON.stringify(model)})`,
    // initial_prompt 是给 whisper 的口音/字形提示：不写它会吐繁体，
    // 而且把"字幕"这类词听岔（实测 base 模型 5.7 秒，质量够用不够好）。
    `r = m.transcribe(sys.argv[1], language=${JSON.stringify(language)}, fp16=False, initial_prompt=${JSON.stringify(localPrompt)})`,
    "print(json.dumps({'text': r.get('text','')}, ensure_ascii=False))",
  ].join("\n");
  const { stdout } = await execFileAsync(py, ["-c", script, audioPath], {
    timeout: Number(process.env.NOVA_TRANSCRIPTION_LOCAL_TIMEOUT_MS) || 180000,
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
    || process.env.NOVA_TRANSCRIPTION_API_KEY
    || process.env.OPENAI_API_KEY
  );
  if (!apiKey) {
    // 没配 key 不再直接抛：先看本地能不能顶上
    const local = await transcribeLocally(normalizedPath).catch(() => "");
    if (local) return local;
    throw new Error("Missing NOVA_TRANSCRIPTION_API_KEY or OPENAI_API_KEY");
  }

  const baseUrl = normalizeText(options.baseUrl || process.env.NOVA_TRANSCRIPTION_BASE_URL) || DEFAULT_BASE_URL;
  const model = normalizeText(options.model || process.env.NOVA_TRANSCRIPTION_MODEL) || DEFAULT_MODEL;
  // Force language so Whisper does not misdetect short/breathy Chinese clips as ja/en.
  const language = normalizeText(options.language || process.env.NOVA_TRANSCRIPTION_LANGUAGE) || "zh";
  let audioPath = normalizedPath;
  let tmpFile = null;
  try {
    const header = Buffer.alloc(7);
    const fh = await fs.open(normalizedPath, "r");
    await fh.read(header, 0, 7, 0);
    await fh.close();
    if (header.slice(0, 7).equals(SILK_MAGIC)) {
      tmpFile = path.join(os.tmpdir(), `cyberboss-silk-${Date.now()}.mp3`);
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

  const apiTimeoutMs = Number(process.env.NOVA_TRANSCRIPTION_API_TIMEOUT_MS) || 45000;
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

  // 走到这儿说明远端没给出字：转本地，别让她的语音变成一片空白
  const local = await transcribeLocally(audioPath).catch((error) => {
    console.error(`[transcription] 本地兜底也失败: ${error.message}`);
    return "";
  });
  if (local) {
    console.warn(`[transcription] 远端失败(${apiError?.message?.slice(0, 80)})，已用本地 whisper 顶上`);
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
