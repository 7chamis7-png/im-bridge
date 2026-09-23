"use strict";

/**
 * WeChat media decoding primitives.
 *
 * SPEC §0.1: platform-specific decryption/decoding belongs to the plugin only.
 * WeChat 4.0 uses private formats for images and voice:
 *
 *   image .dat = V2 container: 15-byte header + AES-128-ECB(first 1024 bytes) + XOR(0x5f) rest
 *   voice      = media_0.db/VoiceInfo.voice_data, SILK v3 (header `\x02#!SILK_V3`)
 *
 *   - Image AES key = 16 ASCII chars used directly as AES-128 key. The plaintext
 *     md5 of `_h.dat` equals the md5 in the message XML, which identifies the image.
 *   - Voice: pilk decodes SILK -> PCM -> ffmpeg wraps WAV (wx-voice-decode.py).
 *
 * The "middle" `.dat` variant contains WeChat's own `wxgf` format (magic 77786766),
 * not a standard image; it is detected and converted separately, never passed
 * off as a viewable image.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { execFile, execFileSync } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const DAT_SIG = Buffer.from([0x07, 0x08, 0x56, 0x32]);   // ...V2, first 4 of the 6 signature bytes
const HEADER = 15;                                        // 6 signature + 4 aeslen + 4 xorlen + 1 pad
const XOR_KEY = 0x5f;
// The decoder script ships next to this plugin and is resolved via __dirname.
const DEFAULT_VOICE_DECODER = path.join(__dirname, "wx-voice-decode.py");

/** Magic bytes of common image formats; distinguishes viewable images from private wrappers like wxgf. */
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return "";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF"
      && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return "";      // wxgf (77786766) and other private formats: not a viewable image
}

/** Is this a V2 image .dat container? */
function isDatV2(buf) {
  return Buffer.isBuffer(buf) && buf.length > HEADER && buf.subarray(0, 4).equals(DAT_SIG);
}

/**
 * Decrypt a V2 image .dat.
 *
 * @param {Buffer} buf  whole .dat file bytes
 * @param {string|Buffer} key  image AES key (16 ASCII chars)
 * @returns {Buffer} plaintext bytes (jpeg/png/gif, or wxgf; the caller sniffs)
 *
 * Header: 6-byte signature | 4-byte aeslen (LE) | 4-byte xorlen (LE) | 1-byte pad.
 * Ciphertext length = file length - 15 - xorlen (deterministic, no padding guess).
 * First aeslen bytes are AES-128-ECB, the rest XOR 0x5f.
 */
function decryptDatV2(buf, key) {
  if (!isDatV2(buf)) throw new Error("不是 V2 图片 .dat（签名对不上）");
  const k = Buffer.isBuffer(key) ? key : Buffer.from(String(key || ""), "utf8");
  if (k.length !== 16) throw new Error("图片 AES key 必须是 16 字节，拿到 " + k.length);

  const aeslen = buf.readUInt32LE(6);
  const xorlen = buf.readUInt32LE(10);
  const ctLen = buf.length - HEADER - xorlen;
  if (ctLen <= 0 || ctLen % 16 !== 0) {
    throw new Error(`.dat 长度对不上：文件 ${buf.length} 头说 aeslen=${aeslen} xorlen=${xorlen}`);
  }

  const decipher = crypto.createDecipheriv("aes-128-ecb", k, null);
  decipher.setAutoPadding(false);       // WeChat pads whole blocks; truncate by aeslen ourselves
  const head = Buffer.concat([decipher.update(buf.subarray(HEADER, HEADER + ctLen)), decipher.final()])
    .subarray(0, aeslen);

  const tail = Buffer.from(buf.subarray(HEADER + ctLen));
  for (let i = 0; i < tail.length; i++) tail[i] ^= XOR_KEY;

  return Buffer.concat([head, tail]);
}

/** Extract md5 from (decompressed) image message XML. Returns "" if absent. */
function imgMd5FromXml(xml) {
  const m = /\bmd5="([0-9a-fA-F]{32})"/.exec(String(xml || ""));
  return m ? m[1].toLowerCase() : "";
}

/**
 * Locate and decrypt the `.dat` file for an image message.
 *
 * Layout: `<attachRoot>/<talkerMd5>/<YYYY-MM>/Img/<hash>_h.dat`, where talkerMd5 is
 * the Msg_ table name without the `Msg_` prefix. The file-name hash is not the XML md5.
 *
 * Lookup order:
 *   1. `fileNameHint` (file name from hardlink.db by XML md5), WeChat's own index.
 *      A message may have `<base>.dat` (middle, wxgf), `<base>_h.dat` (HD, only
 *      after opening the full image) and `<base>_t.dat` (thumbnail).
 *      Prefer HD, then middle, then thumbnail.
 *   1b. `fileNameHints` time-window candidates (see below).
 *   2. Fallback without hints: scan `_h.dat` and match plaintext md5 == XML md5.
 *
 * Returns decrypted container bytes as-is (standard image or wxgf); the caller
 * sniffs and converts wxgf -> jpg asynchronously.
 *
 * @returns {{bytes:Buffer, datPath:string, variant:string}|null}
 */
function locateImageDat({ table, md5, createTime, attachRoot, imageKey, fileNameHint = "", fileNameHints = [] }) {
  if (!attachRoot || !imageKey) return null;
  const talker = String(table || "").replace(/^Msg_/, "");
  const d = new Date((Number(createTime) || 0) * 1000);
  const ym = d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
  const months = [ym, shiftMonth(ym, -1), shiftMonth(ym, 1)];

  // try the three variants by quality; check adjacent months too
  const tryBase = (hint) => {
    const base = String(hint).replace(/(_[ht])?\.dat$/i, "");
    for (const suffix of ["_h.dat", ".dat", "_t.dat"]) {
      for (const m of months) {
        const p = path.join(attachRoot, talker, m, "Img", base + suffix);
        let bytes;
        try { bytes = decryptDatV2(fs.readFileSync(p), imageKey); }
        catch { continue; }
        return { bytes, datPath: p, variant: suffix === "_h.dat" ? "hd" : suffix === "_t.dat" ? "thumb" : "middle" };
      }
    }
    return null;
  };

  // 1. hardlink gave a file name for the XML md5
  if (fileNameHint) {
    // hint present but file missing (not downloaded yet): report null, don't scan
    return tryBase(fileNameHint);
  }

  // 1b. Time-window candidates for md5 mismatches. Images sent as "original"
  // carry the original/HEVC md5 in the XML, while the client stores a re-encoded
  // JPEG whose md5 (recorded in hardlink.db) never matches. Candidates are
  // hardlink.db rows whose modify_time is near the message create_time (sorted
  // by distance by the caller); accept the first that exists in this talker's dir.
  const seen = new Set();
  for (const h of Array.isArray(fileNameHints) ? fileNameHints : []) {
    const base = String(h || "").replace(/(_[ht])?\.dat$/i, "");
    if (!base || seen.has(base)) continue;
    seen.add(base);
    const hit = tryBase(h);
    if (hit) return { ...hit, matchedBy: "time" };
  }

  // 2. no hint: only HD _h.dat plaintext md5 equals the XML md5
  if (!md5 || !table) return null;
  for (const m of months) {
    const dir = path.join(attachRoot, talker, m, "Img");
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith("_h.dat")) continue;
      let bytes;
      try { bytes = decryptDatV2(fs.readFileSync(path.join(dir, name)), imageKey); }
      catch { continue; }
      if (crypto.createHash("md5").update(bytes).digest("hex") === md5) {
        return { bytes, datPath: path.join(dir, name), variant: "hd" };
      }
    }
  }
  return null;
}

const WXGF_MAGIC = Buffer.from("wxgf", "latin1");

/** Is this (decrypted) buffer a WeChat wxgf still image (HEVC inside)? */
function isWxgf(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.subarray(0, 4).equals(WXGF_MAGIC);
}

/**
 * wxgf -> JPEG bytes.
 *
 * Structure: `wxgf` magic + a config header; from the first HEVC Annex-B start code
 * `00 00 00 01` on it is a standard H.265 stream (VPS/SPS/PPS/IDR) that ffmpeg decodes.
 * The config header (with an hvcC-style VPS copy) is discarded.
 *
 * @param {Buffer} wxgf  decrypted wxgf container bytes
 * @returns {Promise<Buffer>} JPEG bytes
 */
async function decodeWxgf(wxgf, { ffmpeg = "ffmpeg", timeoutMs = 30000 } = {}) {
  if (!isWxgf(wxgf)) throw new Error("not wxgf (magic mismatch)");
  const sc = wxgf.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x01]));
  if (sc < 0) throw new Error("no HEVC start code in wxgf");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wx-wxgf-"));
  const h265 = path.join(tmp, "in.h265");
  const jpg = path.join(tmp, "out.jpg");
  try {
    fs.writeFileSync(h265, wxgf.subarray(sc));
    // -update 1: write a single image, not a sequence
    execFileSync(ffmpeg, ["-y", "-hide_banner", "-v", "error", "-i", h265, "-frames:v", "1", "-update", "1", jpg],
      { timeout: timeoutMs, stdio: ["ignore", "ignore", "pipe"] });
    const out = fs.readFileSync(jpg);
    if (!out.length || sniffImage(out) !== "image/jpeg") throw new Error("ffmpeg produced no JPEG");
    return out;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup failure is not fatal */ }
  }
}

/**
 * Build an "XML md5 -> file name on disk" lookup (injected into the plugin) backed
 * by hardlink.db, WeChat's own media index.
 * @returns {(md5:string)=>string} file name (e.g. `e363...dat`), or "" if not found
 */
function makeImageFileLookup({ hardlinkDb, key, sqlcipherBin = "sqlcipher" }) {
  return function imageFileLookup(md5) {
    if (!hardlinkDb || !key || !md5) return "";
    const m = String(md5).toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(m)) return "";
    const script = `PRAGMA key = "x'${key}'";\nPRAGMA cipher_compatibility = 4;\n.headers off\n.mode list\n`
      + `SELECT file_name FROM image_hardlink_info_v4 WHERE md5 = '${m}' LIMIT 1;\n`;
    try {
      const out = execFileSync(sqlcipherBin, ["-batch", hardlinkDb], { input: script, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
      const line = out.split("\n").map((l) => l.trim()).filter((l) => l && l !== "ok")[0] || "";
      return line;
    } catch {
      return "";
    }
  };
}

function shiftMonth(ym, delta) {
  const [y, m] = ym.split("-").map(Number);
  const dd = new Date(Date.UTC(y, m - 1 + delta, 1));
  return dd.getUTCFullYear() + "-" + String(dd.getUTCMonth() + 1).padStart(2, "0");
}

const SILK_MAGIC = Buffer.from("#!SILK_V3", "latin1");

/** Is this WeChat SILK v3 voice data (optionally with a leading 0x02 byte)? */
function isWechatSilk(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 10) return false;
  return buf.subarray(0, 9).equals(SILK_MAGIC) || buf.subarray(1, 10).equals(SILK_MAGIC);
}

/**
 * WeChat SILK v3 voice -> WAV bytes via wx-voice-decode.py (pilk + ffmpeg).
 * pilk accepts WeChat's leading 0x02 byte as-is.
 *
 * @param {Buffer} silk  raw voice_data bytes
 * @returns {Promise<Buffer>} WAV bytes
 */
async function decodeWechatSilk(silk, { decoder = DEFAULT_VOICE_DECODER, python = "python3", timeoutMs = 30000 } = {}) {
  if (!isWechatSilk(silk)) throw new Error("not WeChat SILK v3 voice (header mismatch)");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wx-voice-"));
  const silkPath = path.join(tmp, "in.silk");
  const wavPath = path.join(tmp, "out.wav");
  try {
    fs.writeFileSync(silkPath, silk);
    await execFileAsync(python, [decoder, silkPath, wavPath], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    return fs.readFileSync(wavPath);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup failure is not fatal */ }
  }
}

/**
 * Build a lookup that fetches voice bytes from media_0.db by server_id (injected
 * into the plugin). The blob lives in media_0.db/VoiceInfo, keyed by server_id.
 * Uses sqlcipher's writefile to dump the BLOB to a temp file and read it back,
 * avoiding binary data on shell pipes.
 *
 * @returns {(serverId:string|number)=>Buffer|null}
 */
/**
 * Find candidate file names in hardlink.db by time (for locateImageDat's fileNameHints).
 * Only rows with modify_time within create_time ± windowSec, sorted nearest first.
 * Existence / talker membership is verified by locateImageDat.
 * @returns {(createTime:number)=>string[]}
 */
function makeImageFilesByTime({ hardlinkDb, key, sqlcipherBin = "sqlcipher", windowSec = 120 }) {
  return function imageFilesByTime(createTime) {
    const t = Math.floor(Number(createTime) || 0);
    if (!hardlinkDb || !key || !t) return [];
    const w = Math.max(1, Math.floor(Number(windowSec) || 120));
    const script = `PRAGMA key = "x'${key}'";\nPRAGMA cipher_compatibility = 4;\n.headers off\n.mode list\n`
      + `SELECT file_name FROM image_hardlink_info_v4 WHERE modify_time BETWEEN ${t - w} AND ${t + w} `
      + `ORDER BY abs(modify_time - ${t}) ASC LIMIT 8;\n`;
    try {
      const out = execFileSync(sqlcipherBin, ["-batch", hardlinkDb], { input: script, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
      return out.split("\n").map((l) => l.trim()).filter((l) => l && l !== "ok" && /\.dat$/i.test(l));
    } catch {
      return [];
    }
  };
}

function makeVoiceLookup({ mediaDb, key, sqlcipherBin = "sqlcipher" }) {
  return function voiceLookup(serverId) {
    if (!mediaDb || !key || serverId == null) return null;
    const sid = String(serverId).replace(/[^0-9-]/g, "");
    if (!sid) return null;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wx-vblob-"));
    const out = path.join(tmp, "v.silk");
    const script = `PRAGMA key = "x'${key}'";\nPRAGMA cipher_compatibility = 4;\n.mode list\n`
      + `SELECT writefile('${out}', voice_data) FROM VoiceInfo WHERE svr_id = ${sid} LIMIT 1;\n`;
    try {
      execFileSync(sqlcipherBin, ["-batch", mediaDb], { input: script, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      if (!fs.existsSync(out) || !fs.statSync(out).size) return null;
      return fs.readFileSync(out);
    } catch {
      return null;
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* same as above */ }
    }
  };
}

module.exports = {
  decryptDatV2, isDatV2, sniffImage, imgMd5FromXml, locateImageDat,
  isWxgf, decodeWxgf, makeImageFileLookup, makeImageFilesByTime,
  decodeWechatSilk, isWechatSilk, makeVoiceLookup,
};
