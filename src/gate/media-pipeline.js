"use strict";

/**
 * Media pipeline: everything that can be shared across channels lives here.
 *
 * Boundary: plugins only obtain bytes from their platform; everything after
 * that belongs to this layer. Plugins don't need to know that voice gets
 * transcribed, video gets a frame extracted, what counts as too large, how to
 * handle unknown types, or how to report a processing failure. A new channel
 * gets all of this for free.
 *
 * In:  a file (bytes or path) + what the platform says it is
 * Out: a line of text the agent can read + structured result + `attach`
 *      (files to hand to the model as-is)
 *
 * Failures are never hidden. If processing fails, say "this is an image, but it
 * could not be viewed" - returning nothing makes the model assume the owner
 * sent nothing, or invent content.
 */

const path = require("path");
const { execFileSync } = require("child_process");

/**
 * Platform kind -> processing plan. Unknown kinds are treated as attachments.
 *
 * Images are NOT captioned by default: the model can look at images itself.
 * When the runtime accepts images (`nativeImageInput`), the original is passed
 * as an attachment. A captioning service is only a fallback for runtimes that
 * cannot take images (it costs money and degrades the image to a description).
 */
const PLAN = {
  image: "look",        // pass the original; caption only as a fallback
  sticker: "look",
  voice: "transcribe",  // the model cannot take audio; transcription is the only path
  audio: "transcribe",
  video: "frames",      // extract one frame, then handle like "look"
  file: "none",
  link: "none",
  quote: "none",
};

/** Labels shown to the model; shared by describe() and hydrate(). */
const LABEL = { file: "文件", link: "链接", quote: "引用", image: "图片",
  sticker: "表情", voice: "语音", audio: "语音", video: "视频" };

/** Extract one video frame (requires ffmpeg on PATH). */
function grabFrame(videoPath, outPath) {
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", videoPath, "-frames:v", "1", outPath],
    { timeout: 30000, stdio: ["ignore", "ignore", "pipe"] });
  return outPath;
}

class MediaPipeline {
  /**
   * @param {object} o
   * @param {import("./capabilities").Capabilities} o.caps shared capability registry
   * @param {object} o.fileStore FileStore instance
   * @param {boolean} o.nativeImageInput whether the runtime accepts images. This is a
   *   runtime property, not a channel property, so it is decided here.
   *   Typically `runtimeAdapter.getTurnCapabilities({model}).nativeImageInput`.
   */
  constructor({ caps, fileStore, nativeImageInput = true }) {
    this.caps = caps;
    this.fileStore = fileStore;
    this.nativeImageInput = Boolean(nativeImageInput);
  }

  /**
   * A plugin hands in one media item.
   *
   * @param {object} o
   * @param {string} o.kind     what the platform says it is (image/voice/video/file/sticker/link...)
   * @param {Buffer} [o.bytes]  bytes fetched by the plugin
   * @param {string} [o.srcPath] or a path already on disk
   * @param {string} [o.channel] only used for the directory layout
   * @param {string} [o.hintName] original file name, recorded only
   * @returns {Promise<{text:string, kind:string, filePath:string, mime:string,
   *                    bytes:number, processed:string, failed:string}>}
   */
  async ingest({ kind = "file", bytes, srcPath, url = "", expectMd5 = "", expectBytes = 0,
                 channel = "unknown", hintName = "" }) {
    // 0. If the plugin only gave a URL, download here (with md5/size checks).
    if (!bytes && !srcPath && url) {
      if (!this.caps.has("fetch_bytes")) {
        return { text: `[${kind}：只有个链接，下载能力没注册]`, kind, filePath: "", mime: "",
          bytes: 0, processed: "none", failed: "capability_missing" };
      }
      try {
        const r = await this.caps.call("fetch_bytes", { url, expectMd5, expectBytes });
        bytes = r.bytes;
      } catch (e) {
        return { text: `[${kind}：下载失败 —— ${e.message}]`, kind, filePath: "", mime: "",
          bytes: 0, processed: "none", failed: "fetch" };
      }
    }

    // 1. Store first: type sniffed from content, path guaranteed, dedup by content.
    let stored;
    try {
      stored = this.fileStore.put({ bytes, srcPath, channel, hintName });
    } catch (e) {
      // No bytes at all: an upstream failure, not a processing one - report it.
      return {
        text: `[${kind}：文件没拿到 —— ${e.message}]`,
        kind, filePath: "", mime: "", bytes: 0, processed: "none", failed: "store",
      };
    }

    const base = {
      kind, filePath: stored.filePath, mime: stored.mime, bytes: stored.bytes,
      deduped: stored.deduped, hintName,
    };

    // 2. Process per plan. A missing capability is reported, never silently degraded.
    const plan = PLAN[kind] || "none";
    if (plan === "none") return { ...base, text: this.describe(base), processed: "none", failed: "" };

    try {
      if (plan === "transcribe") {
        if (!this.caps.has("transcribe")) {
          return { ...base, text: `[语音：转写没接上，音频已存在 ${path.basename(stored.filePath)}]`,
            processed: "none", failed: "capability_missing" };
        }
        const r = await this.caps.call("transcribe", { filePath: stored.filePath });
        const t = String((r && r.text) || "").trim();
        // Optional acoustic/tone analysis. Purely additive: never blocks transcription;
        // missing / failing / empty results are ignored.
        let acoustic = "";
        if (this.caps.has("acoustic")) {
          try {
            const a = await this.caps.call("acoustic", { filePath: stored.filePath });
            acoustic = String((a && a.text) || "").trim();
          } catch { /* acoustic failure never affects the transcript */ }
        }
        const head = t ? `[语音] ${t}` : "[语音：一段听不清的，没转出字]";
        // no transcript does not mean no voice message - say so, never return empty
        return { ...base, text: acoustic ? `${head}\n${acoustic}` : head,
          transcript: t, acoustic, processed: "transcribe", failed: t ? "" : "empty" };
      }

      if (plan === "look" || plan === "frames") {
        let look = stored.filePath;
        if (plan === "frames") {
          const frame = stored.filePath + ".frame.png";
          try {
            grabFrame(stored.filePath, frame);
            look = frame;
          } catch (e) {
            return { ...base, text: "[视频：抽帧失败，没看成]", processed: "none", failed: "frames" };
          }
        }
        const head = kind === "sticker" ? "[表情]" : kind === "video" ? "[视频]" : "[图片]";

        // Main path: the model looks at the original image itself (no captioning cost).
        if (this.nativeImageInput) {
          return { ...base, text: head, attach: [look],
            processed: "native", failed: "" };
        }

        // Fallback: the runtime cannot take images, so caption via a vision capability.
        if (!this.caps.has("vision")) {
          return { ...base, text: head + "（这个运行时看不了图，识图也没接上）",
            processed: "none", failed: "capability_missing" };
        }
        const r = await this.caps.call("vision", { filePaths: [look] });
        const t = String((r && r.text) || "").trim();
        return { ...base, text: t ? `${head} ${t}` : `${head}：没看出内容`,
          description: t, processed: "caption", failed: t ? "" : "empty" };
      }
    } catch (e) {
      // Processing failed but the file exists. Say so explicitly.
      return { ...base, text: `${this.describe(base)}（加工失败：${e.message}）`,
        processed: "none", failed: "error" };
    }

    return { ...base, text: this.describe(base), processed: "none", failed: "" };
  }

  /**
   * Turn the media of a delivery from "locators" into something the model can read.
   *
   * A plugin's `toDelivery` only carries locators (e.g. md5 + table, server_id);
   * the actual bytes come from `fetchMedia`. This connects the two:
   *
   *   toDelivery (locators) -> hydrate (fetchMedia bytes -> ingest) -> intake
   *
   * Fetching bytes stays in the plugin (platform-specific decryption/decoding);
   * everything after that happens here. `delivery.media` items are updated in
   * place, so intake receives readable text and never needs to know about
   * platform formats.
   *
   * @param {object} delivery the plugin's delivery (fields are filled in place)
   * @param {object} plugin   the delivering plugin (may lack fetchMedia; then url/path only)
   */
  async hydrate(delivery, plugin) {
    const items = Array.isArray(delivery && delivery.media) ? delivery.media : [];
    if (!items.length) return delivery;
    const channel = (delivery && delivery.channel) || "unknown";
    // Plugins often need the message time to locate media (e.g. per-month folders);
    // it is a property of the delivery, so the shared layer can provide it.
    const createTime = Math.floor(Date.parse((delivery && delivery.receivedAt) || "") / 1000) || 0;

    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      if (item.text) continue;                     // plugin already provided text; don't override
      const kind = item.kind || "file";
      const label = LABEL[kind] || kind;

      // Already plaintext on disk and nothing to process (file/link/quote): the path
      // or URL is already in the text. Copying it into the store adds nothing. Skip,
      // but keep the path visible to the model.
      if ((PLAN[kind] || "none") === "none" && (item.localPath || item.ref)) continue;

      let src = null;
      let hintName = item.hintName || "";

      // 1. Let the plugin fetch bytes if it can (platform decryption/decoding lives there).
      if (plugin && typeof plugin.fetchMedia === "function") {
        let r;
        try { r = await plugin.fetchMedia(item, { createTime }); }
        catch (e) { r = { bytes: null, failed: "fetch_threw", detail: e.message }; }
        if (r && r.bytes && r.bytes.length) {
          src = { bytes: r.bytes };
          hintName = r.hintName || hintName;
          if (r.variant) item.variant = r.variant;
        } else if (r && r.failed && r.failed !== "unsupported_kind") {
          // Report fetch failures explicitly; silence is worse. Exception:
          // unsupported_kind just means "not this plugin's job" - try other paths.
          item.failed = r.failed;
          item.text = "[" + label + "：取不到 —— " + r.failed
            + (r.detail ? "（" + r.detail + "）" : "") + "]";
          continue;
        }
      }

      // 2. Plugin only gave a plain direct URL -> download here.
      if (!src && item.url) {
        src = { url: item.url, expectMd5: item.expectMd5 || "", expectBytes: item.expectBytes || 0 };
      }
      // 3. A plaintext file already on disk.
      if (!src && item.localPath) src = { srcPath: item.localPath };
      // No way to obtain it: leave as is, never invent content.
      if (!src) continue;

      const out = await this.ingest({ kind, channel, hintName, ...src });
      item.text = out.text;
      item.filePath = out.filePath || "";
      item.mime = out.mime || "";
      item.byteLength = out.bytes || 0;
      item.processed = out.processed;
      if (out.failed) item.failed = out.failed;
      if (out.transcript) item.transcript = out.transcript;
      if (out.acoustic) item.acoustic = out.acoustic;
      if (out.description) item.description = out.description;
      if (out.attach) item.attach = out.attach;
    }
    return delivery;
  }

  /** One-line description when unprocessed. Never an empty string. */
  describe({ kind, mime, bytes, hintName, filePath }) {
    const name = hintName || path.basename(filePath || "");
    const kb = bytes ? ` ${Math.round(bytes / 1024)}KB` : "";
    const label = LABEL[kind] || kind;
    return `[${label}${name ? " " + name : ""}${kb}${mime ? " " + mime : ""}]`;
  }
}

module.exports = { MediaPipeline, PLAN, LABEL };
