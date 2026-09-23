const fs = require("fs");
const path = require("path");
const https = require("https");

const API_KEY = process.env.ELEVENLABS_API_KEY || "";
const DEFAULT_VOICE_ID = process.env.ELEVENLABS_DEFAULT_VOICE_ID || "";
const { homePath } = require("../core/paths");

/**
 * Synthesis model. Default is eleven_v3 because it interprets inline audio tags
 * such as `[whispers]` / `[soft laugh]`; older models (e.g. eleven_multilingual_v2)
 * read those tags out loud as literal text.
 *
 * The model can be switched at runtime via a one-line file (no restart needed).
 * Resolution order: ELEVENLABS_MODEL_FILE (default $GATE_ROOT/tts-model) →
 * ELEVENLABS_MODEL → "eleven_v3".
 *
 * Low-latency realtime paths (e.g. phone calls) should use a flash model instead,
 * and must strip [..] tags first since flash models do not support them.
 */
const MODEL_FILE = process.env.ELEVENLABS_MODEL_FILE
  || path.join(process.env.GATE_ROOT || homePath("gate"), "tts-model");
function readModel() {
  try {
    const raw = fs.readFileSync(MODEL_FILE, "utf8").trim();
    if (/^[a-z0-9_]+$/i.test(raw)) return raw;
  } catch { /* no file: fall through */ }
  const fromEnv = String(process.env.ELEVENLABS_MODEL || "").trim();
  return /^[a-z0-9_]+$/i.test(fromEnv) ? fromEnv : "eleven_v3";
}
const OUTPUT_DIR_DEFAULT = homePath("voice");

class TtsService {
  constructor({ config } = {}) {
    this.config = config || {};
    this.outputDir = config?.ttsOutputDir || OUTPUT_DIR_DEFAULT;
  }

  async generate({ text, voiceId, fileName } = {}) {
    if (!API_KEY) throw new Error("ELEVENLABS_API_KEY not set");
    if (!text || !text.trim()) throw new Error("text is required");

    const vid = voiceId || DEFAULT_VOICE_ID;
    if (!vid) throw new Error("ELEVENLABS_DEFAULT_VOICE_ID not set");
    const ts = Date.now();
    const name = fileName
      ? fileName.replace(/\.mp3$/i, "") + ".mp3"
      : `tts_${ts}.mp3`;
    const outPath = path.join(this.outputDir, name);

    fs.mkdirSync(this.outputDir, { recursive: true });

    const body = JSON.stringify({
      text: text.trim(),
      model_id: readModel(),
    });

    const mp3 = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: "api.elevenlabs.io",
          path: `/v1/text-to-speech/${vid}`,
          method: "POST",
          headers: {
            "xi-api-key": API_KEY,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            let err = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (err += c));
            res.on("end", () =>
              reject(new Error(`ElevenLabs API ${res.statusCode}: ${err}`))
            );
            return;
          }
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
        }
      );
      req.on("error", reject);
      req.end(body);
    });

    const tmp = outPath + `.${process.pid}.tmp`;
    fs.writeFileSync(tmp, mp3);
    fs.renameSync(tmp, outPath);

    return { filePath: outPath, bytes: mp3.length, voiceId: vid };
  }
}

module.exports = { TtsService, readModel };
