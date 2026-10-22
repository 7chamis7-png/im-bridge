"use strict";

/**
 * 第 1 层第五样：文件仓（2026-09-17 Alice一句「那文件呢」问出来的）
 *
 * 转写吃文件路径、识图吃文件路径 —— 可**谁保证那个文件真在、叫什么、是什么类型**？
 * 在此之前是每条渠道各管各的，现状三套办法：
 *   inbox/telegram/        1618 个平铺，按消息号命名
 *   inbox/2026-05-25/…     62 个日期文件夹（老微信那套）
 *   微信直读库              根本不下载，只贴 [图片] 标签
 * MIME 判断只有 weixin 角落里一个 22 行小文件。
 * 而且**没人验文件在不在** —— 9-17 影子抓到的 TG 幽灵入站，
 * `attachment_path` 指的就是不存在的文件。
 *
 * 所以这一层做三件事，插头只管「从平台拿到字节」：
 *   1. 统一落盘 + 统一命名（按内容哈希，同一张图存第二遍自动去重）
 *   2. 类型从**内容**嗅（magic bytes），不只看扩展名
 *   3. **存在性是可查的事实**，不是假设 —— verify() 专门给幽灵检测用
 *
 * ⚠️ 不迁移历史文件。老目录原样留着，这一层只管新进来的。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/** 从内容嗅类型。扩展名会骗人 —— 微信 zstd 那次就是只看表面栽的。 */
const MAGIC = [
  [[0xff, 0xd8, 0xff], "image/jpeg", "jpg"],
  [[0x89, 0x50, 0x4e, 0x47], "image/png", "png"],
  [[0x47, 0x49, 0x46, 0x38], "image/gif", "gif"],
  [[0x42, 0x4d], "image/bmp", "bmp"],
  [[0x25, 0x50, 0x44, 0x46], "application/pdf", "pdf"],
  [[0x50, 0x4b, 0x03, 0x04], "application/zip", "zip"],
  [[0x1f, 0x8b], "application/gzip", "gz"],
  [[0x28, 0xb5, 0x2f, 0xfd], "application/zstd", "zst"],   // 微信长文本那个
  [[0x49, 0x44, 0x33], "audio/mpeg", "mp3"],
  [[0xff, 0xfb], "audio/mpeg", "mp3"],
  [[0x4f, 0x67, 0x67, 0x53], "audio/ogg", "ogg"],
  [[0x02, 0x23, 0x21, 0x41], "audio/amr", "amr"],           // #!AMR（微信语音）
];

function sniff(buf) {
  for (const [sig, mime, ext] of MAGIC) {
    if (buf.length >= sig.length && sig.every((b, i) => buf[i] === b)) return { mime, ext };
  }
  // RIFF 容器：WAV / WEBP 得看第 8 字节起
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF") {
    const kind = buf.subarray(8, 12).toString("latin1");
    if (kind === "WAVE") return { mime: "audio/wav", ext: "wav" };
    if (kind === "WEBP") return { mime: "image/webp", ext: "webp" };
  }
  // ftyp：mp4 / m4a（iMessage 语音气泡走 m4a）
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
   * 插头把字节（或一个临时文件）交进来，拿回一个**保证存在**的路径。
   * @returns {{fileId:string, filePath:string, mime:string, bytes:number, deduped:boolean}}
   */
  put({ bytes, srcPath, channel = "unknown", hintName = "" } = {}) {
    let buf = bytes;
    if (!buf && srcPath) {
      if (!fs.existsSync(srcPath)) throw new Error("文件仓：源文件不存在 " + srcPath);
      buf = fs.readFileSync(srcPath);
    }
    if (!Buffer.isBuffer(buf)) throw new Error("文件仓：要么给 bytes 要么给 srcPath");
    if (!buf.length) throw new Error("文件仓：空文件不收（空文件多半是上游出错，不是内容）");
    if (buf.length > this.maxBytes) throw new Error(`文件仓：${buf.length} 字节超过上限 ${this.maxBytes}`);

    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    const { mime, ext } = sniff(buf);
    // 扩展名以嗅出来的为准；原文件名只作记录，不参与路径（防路径穿越，也防重名覆盖）
    const fileId = sha.slice(0, 32) + "." + ext;
    const dir = path.join(this.root, channel.replace(/[^a-z0-9_-]/gi, "_"), sha.slice(0, 2));
    const filePath = path.join(dir, fileId);

    if (fs.existsSync(filePath)) {
      return { fileId, filePath, mime, bytes: buf.length, deduped: true, hintName };
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = filePath + ".part";
    fs.writeFileSync(tmp, buf, { mode: 0o600 });
    fs.renameSync(tmp, filePath);       // 先写 .part 再改名：读的那头永远看不到半截文件
    return { fileId, filePath, mime, bytes: buf.length, deduped: false, hintName };
  }

  /**
   * 存在性是**可查的事实**，不是假设。给幽灵检测用：
   * 入站声称带附件但文件不在 → 这是个硬信号，不是小毛病。
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
