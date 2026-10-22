"use strict";

/**
 * 微信媒体解码原语（2026-09-17 Alice「写进去」）
 *
 * §0.1：**平台特有的解密/解码全归插件，闸和共用层一个都不该懂。**
 * 微信 4.0 的图片和语音是这里最脏的两块，都各有一套私有格式：
 *
 *   图片 .dat  = V2 容器：15 字节头 + AES-128-ECB(前 1024 明文) + XOR(0x5f) 其余
 *   语音       = media_0.db/VoiceInfo.voice_data，SILK v3（头 `\x02#!SILK_V3`）
 *
 * 两把钥匙都实测过（2026-09-17）：
 *   - 图片 AES key = 16 个 ASCII 字符，直接当 AES-128 key；`_h.dat` 解出来
 *     明文 md5 **正好等于消息 XML 里的 md5** —— 靠这条唯一对上是哪张图。
 *   - 语音走 pilk 解 SILK -> PCM -> ffmpeg 封 WAV（同目录的 wx-voice-decode.py）。
 *
 * ⚠️ 中间版 `.dat`（微信默认下的那份）里面是微信自有的 `wxgf` 格式（头 77786766），
 *    不是标准图片，本层不硬解 —— 嗅出来不是常见图片就明说，不冒充成能看的图。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { execFile, execFileSync } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const DAT_SIG = Buffer.from([0x07, 0x08, 0x56, 0x32]);   // ...V2，头 6 字节的前 4 字节
const HEADER = 15;                                        // 6 签名 + 4 aeslen + 4 xorlen + 1 pad
const XOR_KEY = 0x5f;
// 解码脚本跟插头放在一起（铁律 1：拷走能跑）。**这不是"写死路径"**——
// 它是包内资源，用 __dirname 找同目录，换机器换目录都跟着走。
// 2026-09-18 踩过：脚本原来在仓库的 scripts/ 下，插头一搬家路径就算错，
// 而测试把"脚本找不到"吞成了「真数据不全，跳过」，一片绿。
const DEFAULT_VOICE_DECODER = path.join(__dirname, "wx-voice-decode.py");

/** 常见图片的 magic —— 用来判「解出来的到底是不是能看的图」，不是 wxgf 这种私有壳。 */
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return "";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF"
      && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return "";      // wxgf（77786766）等私有格式落这儿，返回空 = 不是能看的图
}

/** 这是不是一个 V2 图片 .dat 容器。 */
function isDatV2(buf) {
  return Buffer.isBuffer(buf) && buf.length > HEADER && buf.subarray(0, 4).equals(DAT_SIG);
}

/**
 * 解一个 V2 图片 .dat。
 *
 * @param {Buffer} buf  整个 .dat 文件字节
 * @param {string|Buffer} key  图片 AES key（16 个 ASCII 字符）
 * @returns {Buffer} 明文图片字节（可能是 jpeg/png/gif，也可能是 wxgf —— 由调用方嗅）
 *
 * 头：6 字节签名 | 4 字节 aeslen(LE) | 4 字节 xorlen(LE) | 1 字节 pad。
 * 密文长度 = 文件长 - 15 - xorlen（确定式，不猜 padding 补几个块）。
 * 前 aeslen 字节走 AES-128-ECB，其余每字节 XOR 0x5f。
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
  decipher.setAutoPadding(false);       // padding 是微信补的整块，自己按 aeslen 截，不让 node 校验
  const head = Buffer.concat([decipher.update(buf.subarray(HEADER, HEADER + ctLen)), decipher.final()])
    .subarray(0, aeslen);

  const tail = Buffer.from(buf.subarray(HEADER + ctLen));
  for (let i = 0; i < tail.length; i++) tail[i] ^= XOR_KEY;

  return Buffer.concat([head, tail]);
}

/** 从（已解压的）图片消息 XML 里挑 md5。挑不到返回空，不猜。 */
function imgMd5FromXml(xml) {
  const m = /\bmd5="([0-9a-fA-F]{32})"/.exec(String(xml || ""));
  return m ? m[1].toLowerCase() : "";
}

/**
 * 定位并解出一条图片消息对应的 `_h.dat`（高清原图）。
 *
 * 目录规律（2026-09-17 实测）：`<attachRoot>/<talkerMd5>/<YYYY-MM>/Img/<hash>_h.dat`，
 * 其中 talkerMd5 = 消息所在的 Msg_ 表名去掉 `Msg_` 前缀。
 * **对上是哪张图靠明文 md5 == XML.md5**（文件名那个 hash 跟 XML md5 不是一回事）。
 *
 * 定位分两条路，优先第一条：
 *   ① `fileNameHint`（从 hardlink.db 按 XML.md5 查到的文件名）—— 这是微信自己用的
 *      正经索引，最可靠。同一条消息盘上有三份：`<base>.dat`（中间版 wxgf）、
 *      `<base>_h.dat`（高清原图，点开大图才有）、`<base>_t.dat`（缩略图）。
 *      **优先高清 `_h`，退中间版 `.dat`，再退缩略图 `_t`**（清晰度递减，但都比 [图片] 强）。
 *   ② 没 hint 时兜底：扫 `_h.dat`，靠明文 md5==XML.md5 认（只对高清有效）。
 *
 * 解出来的字节可能是标准图（jpeg/png…），也可能是 wxgf（中间版）——**本函数不管翻译**，
 * 原样把解密后的容器字节交出去，由调用方 sniff 再决定要不要 wxgf→jpg（那步是异步）。
 *
 * @returns {{bytes:Buffer, datPath:string, variant:string}|null}
 */
function locateImageDat({ table, md5, createTime, attachRoot, imageKey, fileNameHint = "", fileNameHints = [] }) {
  if (!attachRoot || !imageKey) return null;
  const talker = String(table || "").replace(/^Msg_/, "");
  const d = new Date((Number(createTime) || 0) * 1000);
  const ym = d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
  const months = [ym, shiftMonth(ym, -1), shiftMonth(ym, 1)];

  // 按 base 找三个变体，清晰度优先；三个月目录都看（跨月那几分钟）
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

  // —— ① hardlink 按 XML.md5 给了文件名 ——
  if (fileNameHint) {
    // hint 给了却找不到文件（还没下下来）——不再瞎扫别的 md5，如实报空
    return tryBase(fileNameHint);
  }

  // —— ①′ md5 对不上时的时间窗候选（2026-09-21）——
  // 她按「原图」发的图，XML.md5 是原图 / HEVC 中间版的（XML 里带 hevc_mid_size），
  // 客户端落盘的是转成 JPEG 的中间版，hardlink.db 记的是**转码后文件**的 md5，跟 XML 永远对不上。
  // 9-20 19:37 那张就是：XML md5 15f8…，盘上 6e45….dat（md5 9230…），桥报「没下载」。
  // 候选来自 hardlink.db 里 modify_time 落在消息 create_time 附近的行（调用方按时间差排好序），
  // 这里只认**这个会话目录下真存在**的那个；一个都不在就继续往下走。
  const seen = new Set();
  for (const h of Array.isArray(fileNameHints) ? fileNameHints : []) {
    const base = String(h || "").replace(/(_[ht])?\.dat$/i, "");
    if (!base || seen.has(base)) continue;
    seen.add(base);
    const hit = tryBase(h);
    if (hit) return { ...hit, matchedBy: "time" };
  }

  // —— ② 没 hint 的兜底：只有高清 _h.dat 的明文 md5 才等于 XML.md5 ——
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

/** 这段（已解密的）字节是不是微信自有的 wxgf 静图（里面包着 HEVC）。 */
function isWxgf(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.subarray(0, 4).equals(WXGF_MAGIC);
}

/**
 * wxgf -> JPEG 字节。
 *
 * 2026-09-17 逆出来的结构：`wxgf` magic + 一段配置头，**从第一个 HEVC Annex-B 起始码
 * `00 00 00 01` 起就是标准 H.265 码流**（VPS/SPS/PPS/IDR 一整套），ffmpeg 直接解。
 * 前面那段配置头（含一份 hvcC 风格的 VPS 副本）扔掉不用。
 *
 * @param {Buffer} wxgf  解密后的 wxgf 容器字节
 * @returns {Promise<Buffer>} JPEG 字节
 */
async function decodeWxgf(wxgf, { ffmpeg = "ffmpeg", timeoutMs = 30000 } = {}) {
  if (!isWxgf(wxgf)) throw new Error("不是 wxgf（magic 对不上）");
  const sc = wxgf.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x01]));
  if (sc < 0) throw new Error("wxgf 里找不到 HEVC 起始码");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wx-wxgf-"));
  const h265 = path.join(tmp, "in.h265");
  const jpg = path.join(tmp, "out.jpg");
  try {
    fs.writeFileSync(h265, wxgf.subarray(sc));
    // -update 1 明说只写一张图，避免 ffmpeg 当成序列
    execFileSync(ffmpeg, ["-y", "-hide_banner", "-v", "error", "-i", h265, "-frames:v", "1", "-update", "1", jpg],
      { timeout: timeoutMs, stdio: ["ignore", "ignore", "pipe"] });
    const out = fs.readFileSync(jpg);
    if (!out.length || sniffImage(out) !== "image/jpeg") throw new Error("ffmpeg 没解出 JPEG");
    return out;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清不掉不拖垮主链 */ }
  }
}

/**
 * 造一个「XML.md5 -> 盘上文件名」的查询函数（注入给插件），查的是 hardlink.db，
 * 那是微信自己用来定位媒体文件的正经索引。
 * @returns {(md5:string)=>string} 文件名（如 `e363...dat`），查不到返回 ""
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

/** 这段字节是不是微信 SILK v3 语音（可能带一个 0x02 前导字节）。 */
function isWechatSilk(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 10) return false;
  return buf.subarray(0, 9).equals(SILK_MAGIC) || buf.subarray(1, 10).equals(SILK_MAGIC);
}

/**
 * 微信语音 SILK v3 -> WAV 字节。走同目录的 wx-voice-decode.py（pilk + ffmpeg）。
 * pilk 直接吃微信那个 0x02 前导头，不用自己剥。
 *
 * @param {Buffer} silk  voice_data 原始字节
 * @returns {Promise<Buffer>} WAV 字节
 */
async function decodeWechatSilk(silk, { decoder = DEFAULT_VOICE_DECODER, python = "python3", timeoutMs = 30000 } = {}) {
  if (!isWechatSilk(silk)) throw new Error("不是微信 SILK v3 语音（头对不上）");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wx-voice-"));
  const silkPath = path.join(tmp, "in.silk");
  const wavPath = path.join(tmp, "out.wav");
  try {
    fs.writeFileSync(silkPath, silk);
    await execFileAsync(python, [decoder, silkPath, wavPath], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    return fs.readFileSync(wavPath);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清不掉不拖垮主链 */ }
  }
}

/**
 * 造一个从 media_0.db 按 server_id 取语音字节的查询函数（注入给插件）。
 * 语音 blob 不在主消息库，在 media_0.db/VoiceInfo，靠 server_id 对上（唯一）。
 * 用 sqlcipher CLI 的 writefile 把 BLOB 落到临时文件再读回来 —— 不经 shell 管道、
 * 不打印二进制（跟采集器同一套避坑：二进制走管道会被 xclip/编码搞坏）。
 *
 * @returns {(serverId:string|number)=>Buffer|null}
 */
/**
 * 按时间在 hardlink.db 里找候选文件名（配合 locateImageDat 的 fileNameHints）。
 * 只查「modify_time 落在消息 create_time ± windowSec」的行，按时间差近→远排；
 * 存不存在、是不是这个会话的，由 locateImageDat 在会话目录下验，这里不判。
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
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 同上 */ }
    }
  };
}

module.exports = {
  decryptDatV2, isDatV2, sniffImage, imgMd5FromXml, locateImageDat,
  isWxgf, decodeWxgf, makeImageFileLookup, makeImageFilesByTime,
  decodeWechatSilk, isWechatSilk, makeVoiceLookup,
};
