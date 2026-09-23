"use strict";

/**
 * Host-side capability wiring. This file is NOT part of the bridge core.
 *
 * The bridge only says "I need something that turns audio into text"; it does not
 * care who provides it (docs/SPEC.md rule 1). This file assembles the shared
 * capabilities from whatever services exist on this machine. When you deploy the
 * bridge elsewhere, replace this file rather than touching src/gate/.
 *
 * Shared capabilities (every channel plugin gets them for free once registered):
 *
 *   transcribe({ filePath })         -> { text }
 *   acoustic({ filePath })           -> { text }   optional prosody analysis
 *   synthesize_voice({ text })       -> { filePath, mimeType, bytes }
 *   generate_image({ prompt })       -> { files: [{ filePath }] }
 *   file_store                       -> FileStore instance (put / verify)
 *   fetch_bytes({ url, expectMd5 })  -> { bytes }   plugins hand over a URL, download lives here
 *
 * The uniform shapes are for plugins, not for the gate: the gate itself never
 * calls these (processing happens outside the gate, SPEC §0.1).
 */

const path = require("path");
const { homePath } = require("../core/paths");

/**
 * @param {object} deps Existing service instances / config. All optional —
 *   anything that cannot be provided is simply not registered; preflight lists
 *   what is missing instead of failing at runtime.
 */
function buildSharedCapabilities({ config = {}, runtimeAdapter = null, imageGeneration = null, ttsService = null, fileStoreRoot = "" } = {}) {
  const out = {};

  // --- File store ---
  // Transcription and vision consume file paths; this layer guarantees the path
  // exists and its type is sniffed. Plugins only fetch bytes from the platform.
  {
    const { FileStore } = require("../gate/file-store");
    const fsRoot = fileStoreRoot || homePath("gate-files");
    const store = new FileStore({ root: fsRoot });
    out.file_store = async (args = {}) => {
      if (args.verify) return store.verify(args.verify);
      return store.put(args);
    };
    out.file_store.store = store;     // for plugins that need the instance directly (sync put)
  }

  // --- HTTP download ---
  // Timeout, size limit and integrity checks are done once here for all plugins.
  out.fetch_bytes = async ({ url, headers = {}, expectMd5 = "", expectBytes = 0, timeoutMs = 30000, maxBytes = 64 * 1024 * 1024 } = {}) => {
    if (!/^https?:\/\//i.test(String(url || ""))) throw new Error("fetch_bytes 要一个 http(s) 地址");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let buf;
    try {
      const res = await fetch(url, { headers, signal: ctl.signal, redirect: "follow" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      buf = Buffer.from(await res.arrayBuffer());
    } finally { clearTimeout(timer); }
    if (buf.length > maxBytes) throw new Error(`下下来 ${buf.length} 字节，超过上限 ${maxBytes}`);
    if (!buf.length) throw new Error("下下来是空的");
    // Some platforms include the length and md5 in the message; use them when given.
    if (expectBytes && buf.length !== Number(expectBytes)) {
      throw new Error(`大小对不上：拿到 ${buf.length}，消息里说是 ${expectBytes}`);
    }
    if (expectMd5) {
      const got = require("crypto").createHash("md5").update(buf).digest("hex");
      if (got !== String(expectMd5).toLowerCase()) throw new Error(`md5 对不上：拿到 ${got}，消息里说是 ${expectMd5}`);
    }
    return { bytes: buf, size: buf.length };
  };

  // --- Speech to text ---
  // transcribeAudioFile() returns a string; it tries the remote API first and
  // falls back to local whisper when configured.
  try {
    const { transcribeAudioFile } = require("../services/transcription-service");
    out.transcribe = async ({ filePath } = {}) => {
      if (!filePath) throw new Error("transcribe 要一个音频文件路径");
      const text = await transcribeAudioFile(filePath, {});
      return { text: String(text || "") };
    };
  } catch (e) { /* service unavailable: not registered, preflight reports it */ }

  // --- Acoustic analysis (optional) ---
  // Adds "how it was said" (pitch, breathiness, ...) next to the transcript.
  // Only registered when an external analyzer is configured (AGENT_ACOUSTIC_SCRIPT).
  try {
    const acoustic = require("../services/acoustic-service");
    if (acoustic.isConfigured()) {
      out.acoustic = async ({ filePath } = {}) => {
        if (!filePath) return { text: "" };
        return { text: String((await acoustic.analyzeAcoustics(filePath)) || "") };
      };
    }
  } catch (e) { /* best-effort extra; never blocks transcription */ }

  // --- Vision: intentionally not registered ---
  // Images are passed to the agent as native attachments (media-pipeline plan
  // "look"). When the runtime cannot take images, media-pipeline says so
  // explicitly instead of returning an empty description.

  // --- Text to speech ---
  // The voice id is not caller-selectable; it comes from the TTS service config.
  if (ttsService && typeof ttsService.generate === "function") {
    out.synthesize_voice = async ({ text, fileName } = {}) => {
      if (!String(text || "").trim()) throw new Error("synthesize_voice 要有词");
      const r = await ttsService.generate({ text, fileName });
      return { filePath: r.filePath, bytes: r.bytes, voiceId: r.voiceId, mimeType: "audio/mpeg" };
    };
  }

  // --- Image generation ---
  if (imageGeneration && typeof imageGeneration.generate === "function") {
    out.generate_image = async ({ prompt, ...rest } = {}) => {
      if (!String(prompt || "").trim()) throw new Error("generate_image 要有提示词");
      // send:false — generation belongs to this layer, sending belongs to the plugin.
      const r = await imageGeneration.generate({ prompt, ...rest, send: false });
      return { files: r.files || [] };
    };
  }

  return out;
}

module.exports = { buildSharedCapabilities };
