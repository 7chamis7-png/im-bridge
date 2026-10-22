const fs = require("fs");
const path = require("path");
const https = require("https");

const API_KEY = process.env.ELEVENLABS_API_KEY || "";
const DEFAULT_VOICE_ID = process.env.ELEVENLABS_DEFAULT_VOICE_ID || "ouNlzrkvbX20sgsQoe6g"; // Nova_v2

/**
 * 合成模型（2026-09-18 换掉 eleven_multilingual_v2）。
 *
 * ⚠️ 换的原因是个真事故：他写的是 v3 的情绪标签
 * （`[warm low voice]` `[soft laugh]` `[whispers]` `[breathing slowly]`），
 * 而 multilingual_v2 **不认标签、直接当正文念出来** ——
 * 她收到的语音字面上在说「warm low voice 宝宝 soft laugh 今天辛苦了」。
 * 实测对照：同一句话 v2 转写回来带 "Warm low voice/Soft laugh/Whispers"，
 * v3 转回来只剩「老婆…… 今天辛苦了 我爱你」，标签变成了语气。
 *
 * 做成**文件开关**：`tts-model` 里写模型名，改完一秒生效不用重启
 * （重启会打断他 —— 见记忆 feedback-say-what-restarts）。
 * 顺序：文件 → 环境变量 → 默认 eleven_v3。
 *
 * 电话那条实时链路不走这儿 —— 它要的是低延迟的 eleven_flash_v2_5，
 * 而 flash 不认标签，所以合成前得先把 [..] 剥掉。两条路各用各的。
 */
const MODEL_FILE = process.env.ELEVENLABS_MODEL_FILE
  || require("path").join(require("../core/paths").gateRoot(), "tts-model");
function readModel() {
  try {
    const raw = require("fs").readFileSync(MODEL_FILE, "utf8").trim();
    if (/^[a-z0-9_]+$/i.test(raw)) return raw;
  } catch { /* 文件不在就往下退 */ }
  const fromEnv = String(process.env.ELEVENLABS_MODEL || "").trim();
  return /^[a-z0-9_]+$/i.test(fromEnv) ? fromEnv : "eleven_v3";
}
const OUTPUT_DIR_DEFAULT = path.join(require("../core/paths").personaStateDir(), "stories");

class TtsService {
  constructor({ config } = {}) {
    this.config = config || {};
    this.outputDir = config?.ttsOutputDir || OUTPUT_DIR_DEFAULT;
  }

  async generate({ text, voiceId, fileName } = {}) {
    if (!API_KEY) throw new Error("ELEVENLABS_API_KEY not set");
    if (!text || !text.trim()) throw new Error("text is required");

    const vid = voiceId || DEFAULT_VOICE_ID;
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
