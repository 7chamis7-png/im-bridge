"use strict";

/**
 * File store for inbound media.
 *
 * Transcription and vision both consume file paths, so something has to
 * guarantee the file exists, has a stable name and a known type. Plugins only
 * fetch bytes from the platform; this layer:
 *   1. stores everything in one place, named by content hash (dedup for free)
 *   2. sniffs the type from content (magic bytes), not from the extension
 *   3. makes existence a checkable fact - verify() backs ghost-inbound detection
 *     (an inbound claiming an attachment whose file does not exist).
 *
 * Existing legacy files are not migrated; only new files go through here.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/** Sniff type from content; extensions lie. */
const MAGIC = [
  [[0xff, 0xd8, 0xff], "image/jpeg", "jpg"],
  [[0x89, 0x50, 0x4e, 0x47], "image/png", "png"],
  [[0x47, 0x49, 0x46, 0x38], "image/gif", "gif"],
  [[0x42, 0x4d], "image/bmp", "bmp"],
  [[0x25, 0x50, 0x44, 0x46], "application/pdf", "pdf"],
  [[0x50, 0x4b, 0x03, 0x04], "application/zip", "zip"],
  [[0x1f, 0x8b], "application/gzip", "gz"],
  [[0x28, 0xb5, 0x2f, 0xfd], "application/zstd", "zst"],   // WeChat long-text payloads
  [[0x49, 0x44, 0x33], "audio/mpeg", "mp3"],
  [[0xff, 0xfb], "audio/mpeg", "mp3"],
  [[0x4f, 0x67, 0x67, 0x53], "audio/ogg", "ogg"],
  [[0x02, 0x23, 0x21, 0x41], "audio/amr", "amr"],           // #!AMR (WeChat voice)
];

function sniff(buf) {
  for (const [sig, mime, ext] of MAGIC) {
    if (buf.length >= sig.length && sig.every((b, i) => buf[i] === b)) return { mime, ext };
  }
  // RIFF container: WAV / WEBP is identified from byte 8
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF") {
    const kind = buf.subarray(8, 12).toString("latin1");
    if (kind === "WAVE") return { mime: "audio/wav", ext: "wav" };
    if (kind === "WEBP") return { mime: "image/webp", ext: "webp" };
  }
  // ftyp: mp4 / m4a (iMessage voice notes are m4a)
  if (buf.length >= 12 && buf.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = buf.subarray(8, 12).toString("latin1");
    if (brand.startsWith("M4A")) return { mime: "audio/mp4", ext: "m4a" };
    return { mime: "video/mp4", ext: "mp4" };
  }
  return { mime: "application/octet-stream", ext: "bin" };
}

class FileStore {
  /** @param {{root:string, maxBytes?:number}} o */
  constructor({ root, maxBytes = 64 * 1024 * 1024 } = {}) {
    this.root = root;
    this.maxBytes = maxBytes;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  /**
   * A plugin hands in bytes (or a temp file) and gets back a path that is guaranteed to exist.
   * @returns {{fileId:string, filePath:string, mime:string, bytes:number, deduped:boolean}}
   */
  put({ bytes, srcPath, channel = "unknown", hintName = "" } = {}) {
    let buf = bytes;
    if (!buf && srcPath) {
      if (!fs.existsSync(srcPath)) throw new Error("文件仓：源文件不存在 " + srcPath);
      buf = fs.readFileSync(srcPath);
    }
    if (!Buffer.isBuffer(buf)) throw new Error("文件仓：要么给 bytes 要么给 srcPath");
    if (!buf.length) throw new Error("文件仓：空文件不收（多半是上游出错）");
    if (buf.length > this.maxBytes) throw new Error(`文件仓：${buf.length} 字节超过上限 ${this.maxBytes}`);

    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    const { mime, ext } = sniff(buf);
    // The sniffed extension wins; the original name is only recorded, never used in the
    // path (prevents path traversal and name collisions).
    const fileId = sha.slice(0, 32) + "." + ext;
    const dir = path.join(this.root, channel.replace(/[^a-z0-9_-]/gi, "_"), sha.slice(0, 2));
    const filePath = path.join(dir, fileId);

    if (fs.existsSync(filePath)) {
      return { fileId, filePath, mime, bytes: buf.length, deduped: true, hintName };
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = filePath + ".part";
    fs.writeFileSync(tmp, buf, { mode: 0o600 });
    fs.renameSync(tmp, filePath);       // write .part then rename: readers never see a partial file
    return { fileId, filePath, mime, bytes: buf.length, deduped: false, hintName };
  }

  /**
   * Existence is a checkable fact. Used by ghost detection: an inbound that
   * claims an attachment whose file is missing is a hard signal.
   */
  verify(filePath) {
    try {
      const st = fs.statSync(filePath);
      if (!st.isFile()) return { ok: false, reason: "不是文件" };
      if (!st.size) return { ok: false, reason: "空文件" };
      const fd = fs.openSync(filePath, "r");
      const head = Buffer.alloc(16);
      fs.readSync(fd, head, 0, 16, 0);
      fs.closeSync(fd);
      return { ok: true, bytes: st.size, ...sniff(head) };
    } catch (e) {
      return { ok: false, reason: "文件不存在" };
    }
  }
}

module.exports = { FileStore, sniff };
