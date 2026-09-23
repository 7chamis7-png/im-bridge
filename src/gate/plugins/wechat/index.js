"use strict";

/**
 * ============================================================================
 * WARNING / 警告
 *
 * This plugin reads the local WeChat desktop client's encrypted database and
 * drives the WeChat UI through accessibility automation (clicks, clipboard,
 * virtual microphone). This is not an official API. WeChat may detect it and
 * restrict the account (e.g. block logins on new devices, or worse).
 * USE ENTIRELY AT YOUR OWN RISK.
 *
 * 本插件读取本机微信客户端的加密数据库，并通过无障碍接口自动操作微信界面
 * （点击、剪贴板、虚拟麦克风）。这不是官方接口，可能被平台识别并限制账号
 * （例如限制新设备扫码登录，甚至更严重）。使用风险完全自担。
 * ============================================================================
 *
 * WeChat plugin (local client: database reader for inbound, UI automation for outbound).
 *
 * This leg demonstrates SPEC §0.1: all processing happens outside the gate,
 * the gate only validates. WeChat is the heaviest channel: SQLCipher
 * decryption, zstd decompression, local_type semantics. All of that belongs
 * to the plugin. Two layers guard against garbage reaching the agent: the
 * plugin decompresses, and the gate rejects text that doesn't look like text.
 */

const { execFileSync, execFile } = require("child_process");
const path = require("path");
const { notSent } = require("../../errors");
const { parseAppmsg, renderAppmsg } = require("./appmsg");
const {
  sniffImage, imgMd5FromXml, locateImageDat, isWxgf, decodeWxgf, decodeWechatSilk,
} = require("./media");

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const NUL = String.fromCharCode(0);

const TYPE_LABEL = {
  1: null,          // plain text
  3: "image",
  34: "voice",
  43: "video",
  47: "sticker",
  48: "location",
  49: null,         // appmsg, subtype in APPMSG_LABEL
  50: "call",
  10002: "system",
};

/**
 * WeChat's local_type packs two values: the low 32 bits are the main type
 * (e.g. 49 = appmsg), the high 32 bits the appmsg subtype. Looking up the
 * whole number in TYPE_LABEL would miss every link card / file / quote.
 */
function splitLocalType(v) {
  const n = Number(v) || 0;
  return { type: n % 4294967296, appmsg: Math.floor(n / 4294967296) };
}

/** appmsg subtypes (link cards, files, quoted replies, ...). */
const APPMSG_LABEL = {
  5: "link",            // shared article / link card
  6: "file",
  19: "forward",        // merged forwarded chat history
  24: "favorite",
  33: "miniapp",
  36: "miniapp",
  51: "channels",       // Channels video
  57: "quote",          // quoted reply (which message is being quoted)
  63: "channels",       // Channels live
  2000: "transfer",
  2001: "redpacket",
};

/**
 * Length cap for UNRECOGNIZED message types only.
 *
 * Plain text (type=1) is never truncated. The cap applies to unknown types,
 * which are usually unparsed structured payloads that would otherwise flood
 * the agent's context.
 */
const PLAIN_MAX = 2000;

/** WeChat stores long texts zstd-compressed in message_content */
function zstdUnpack(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || !buf.subarray(0, 4).equals(ZSTD_MAGIC)) return null;
  try {
    return execFileSync("zstd", ["-d", "-c"], { input: buf, maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return null;   // leave as-is; the gate will flag it as non-text
  }
}

/**
 * Animated sticker: extract the plain download URL and checksum.
 * `cdnurl` (ef=1) is plaintext; `encrypturl` (ef=2) needs an aeskey and is not used.
 */
function parseEmoji(xml) {
  const s = String(xml || "");
  const attr = (n) => {
    const m = new RegExp("\\b" + n + '="([^"]*)"').exec(s);
    return m ? m[1].replace(/&amp;/g, "&") : "";
  };
  return { url: attr("cdnurl"), md5: attr("md5"), len: Number(attr("len")) || 0 };
}

/**
 * Local path of a received file: `<db_dir>/../msg/file/YYYY-MM/<original name>`,
 * stored unencrypted (unlike images, which are encrypted .dat files). The month
 * follows the message time; returns "" when not found rather than guessing.
 */
function localFilePath(fileName, createTime, filesRoot) {
  if (!fileName || !filesRoot) return "";
  const d = new Date((Number(createTime) || 0) * 1000);
  const ym = d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
  const fsMod = require("fs");
  const pathMod = require("path");
  const months = [ym, shiftMonth(ym, -1), shiftMonth(ym, 1)];
  // also check adjacent months: messages near a month boundary may land in either
  for (const m of months) {
    const p = pathMod.join(filesRoot, m, fileName);
    try { if (fsMod.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  // Duplicate names get "(1)", "(2)" suffixes on disk. Accept only a unique
  // candidate; better no path than the wrong one.
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  const re = new RegExp("^" + stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    + "(\\(\\d+\\))?" + ext.replace(/\./g, "\\.") + "$");
  const hits = [];
  for (const m of months) {
    let names = [];
    try { names = fsMod.readdirSync(pathMod.join(filesRoot, m)); } catch { continue; }
    for (const n of names) if (re.test(n)) hits.push(pathMod.join(filesRoot, m, n));
  }
  return hits.length === 1 ? hits[0] : "";
}

function shiftMonth(ym, delta) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}

/**
 * Pick the image path from the shapes the outbound gate may pass. Returns ""
 * if none; the caller reports the error. Module-level function (no `this`).
 */
function pickImagePath({ intent, asset, extras, toolArgs, text, stickerBook = null, stickerOwner = "" }) {
  if (extras && extras.filePath) return String(extras.filePath);
  if (toolArgs && toolArgs.filePath) return String(toolArgs.filePath);
  if (asset && Array.isArray(asset.files) && asset.files[0] && asset.files[0].filePath) {
    return String(asset.files[0].filePath);
  }
  if (asset && asset.filePath) return String(asset.filePath);
  // Stickers may be passed by name and resolved to a local image via the sticker book
  if (intent === "send_sticker") {
    // Sticker book is injected at assembly time. Without it, fail explicitly
    // instead of degrading into a text message.
    if (!stickerBook) throw notSent("这条腿还没接贴纸本（stickerBook）");
    const want = (toolArgs && toolArgs.sticker) || (toolArgs && toolArgs.emoji) || text;
    const hit = stickerBook.resolve(want, stickerOwner);
    if (hit && hit.filePath) return hit.filePath;
    // WeChat needs a local image; a Telegram-only sticker (file_id without a
    // local file) cannot be sent here. Say so explicitly instead of sending text.
    if (hit) {
      throw notSent("「" + hit.name + "」是 Telegram 那包里的贴纸，微信这条腿要本地图片，"
        + "现在没有 —— 在微信这儿换个说法表达，或者去 TG 发");
    }
  }
  return "";
}

class WeChatPlugin {
  /** @param {{sender?: function, skipDecompress?: boolean}} opts skipDecompress is for regression tests only */
  constructor({ sender, imageSender, voiceSender, caller, hangUp, filesRoot = "", skipDecompress = false,
    imageKey = "", attachRoot = "", imageFileLookup = null, imageFilesByTime = null, wxgfDecode = decodeWxgf,
    voiceLookup = null, silkDecode = decodeWechatSilk, stickerBook = null, stickerOwner = "",
    keysFile = "", whitelistFile = "", python = "python3",
    pollTimeoutMs = 180_000, accountId = "wechat", log = () => {} } = {}) {
    // Sticker book (optional). Missing = sending a sticker fails explicitly.
    this.stickerBook = stickerBook;
    this.stickerOwner = String(stickerOwner || "");
    // Received files live here (<db_dir>/../msg/file). Unset = no local path lookup.
    this.filesRoot = filesRoot;
    this.channel = "wechat";      // channel name only; the transport is not part of the source identity
    this.sender = sender;
    // outbound uses accessibility (AT-SPI) automation of the desktop client
    this.capabilities = {
      send_text: "supported",
      send_file: "unsupported",              // would need the file dialog; not implemented
      // WeChat cannot send an audio file as a voice message, but voice messages are
      // recorded: synthesized audio is played into a virtual microphone while recording.
      send_voice: "supported",
      // Images/stickers go through the clipboard (xclip -t image/png -> Ctrl+V -> Enter),
      // landing as real image messages (local_type=3).
      send_sticker: "supported",
      send_generated_image: "supported",
      react: "unsupported",                  // WeChat has no message reactions
      // Outgoing calls only (clicks "Voice Call" in the title bar). Answering is not
      // supported: a WeChat call rings on only one device, which may not be this one.
      start_call: "supported",
      end_call: "supported",
    };
    this.imageSender = imageSender;
    this.voiceSender = voiceSender;
    this.caller = caller;
    this.hangUp = hangUp;
    this.skipDecompress = skipDecompress;
    // Inbound media decoding (all optional; missing pieces degrade to placeholders)
    this.imageKey = imageKey;        // image AES key (16 ASCII chars)
    this.attachRoot = attachRoot;    // <db_dir>/../msg/attach, where .dat files live
    this.imageFileLookup = imageFileLookup;  // (md5) => file name via hardlink.db (optional)
    this.imageFilesByTime = imageFilesByTime; // (createTime) => file names[], time-window fallback (optional)
    this.wxgfDecode = wxgfDecode;    // (wxgfBuf) => Promise<Buffer jpeg>
    this.voiceLookup = voiceLookup;  // (serverId) => Buffer(silk)|null from media_0.db
    this.silkDecode = silkDecode;    // (silkBuf) => Promise<Buffer wav>
    // Database reader inputs (see db-watch.py). Both paths are required;
    // poll() reports explicitly which one is missing.
    this.keysFile = keysFile;
    this.whitelistFile = whitelistFile;
    this.python = python;
    this.pollTimeoutMs = pollTimeoutMs;
    this.accountId = accountId;
    this.log = log;
    // the reader script lives next to this file
    this.watcher = path.join(__dirname, "db-watch.py");
  }

  /**
   * Read new messages from the local WeChat database.
   *
   * WeChat has no message API, so messages are read from its SQLCipher
   * database by `db-watch.py` (decryption, table matching, filtering).
   *
   * This method only runs the script, converts the hex payload back to bytes
   * and passes the cursor through. Content decoding happens in `toDelivery`.
   *
   * @param {object} o
   * @param {object} [o.since] previous cursor (opaque, passed back to the script)
   * @returns {{items: Array, cursor: object}}
   */
  async poll({ since = {} } = {}) {
    if (!String(this.keysFile || "").trim() || !String(this.whitelistFile || "").trim()) {
      throw new Error("微信插头要 keysFile 和 whitelistFile 才收得到消息 —— 不许用默认值猜");
    }
    const args = [this.watcher, "--once",
      "--keys", this.keysFile,
      "--whitelist", this.whitelistFile,
      "--cursor", JSON.stringify(since && typeof since === "object" ? since : {})];
    const out = await new Promise((resolve, reject) => {
      execFile(this.python, args, { timeout: this.pollTimeoutMs, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => {
          // never pretend there are no messages when the database can't be read
          if (err) return reject(new Error("微信采集器跑不起来：" + ((err && err.message) || err)
            + (stderr ? " / " + String(stderr).slice(0, 200) : "")));
          resolve(String(stdout || ""));
        });
    });
    let parsed;
    try { parsed = JSON.parse(out.trim().split("\n").pop() || "{}"); }
    catch { throw new Error("微信采集器的输出不是 JSON：" + out.slice(0, 200)); }

    // e.g. empty whitelist: the script reports it and does not advance the cursor
    if (parsed.error) this.log("[wechat] " + parsed.error);

    const list = Array.isArray(parsed.items) ? parsed.items : [];
    const items = list.map((r) => ({
      update_id: r.table + ":" + r.local_id,
      // cursor after consuming this item; stored opaquely by the shared layer (receiver.js)
      cursor: parsed.cursor,
      message: {
        table: r.table,
        local_id: r.local_id,
        local_type: r.local_type,
        sender: r.sender,
        create_time: r.create_time,
        // needed to find voice bytes in media_0.db
        server_id: r.server_id,
        accountId: this.accountId,
        // JSON can't carry bytes; the script emits hex
        raw: Buffer.from(String(r.raw_hex || ""), "hex"),
      },
    }));
    return { items, cursor: parsed.cursor || since };
  }

  /**
   * One database row -> standard delivery.
   * @param {{local_id:number, local_type:number, sender:string, create_time:number, raw:Buffer, accountId?:string}} row
   */
  toDelivery(row) {
    const processing = ["decrypted"];          // read from SQLCipher = decrypted
    let buf = row.raw;

    const unpacked = this.skipDecompress ? null : zstdUnpack(buf);
    if (unpacked) {
      buf = unpacked;
      processing.push("decompressed");
    }

    const text = buf.toString("utf8").split(NUL).join("");
    const { type, appmsg } = splitLocalType(row.local_type);
    const kind = TYPE_LABEL[type];
    const media = [];
    let body = "";

    if (type === 1) {
      body = text;
    } else if (type === 49) {
      // appmsg: XML body, subtype decides what it is. Parsing belongs to the plugin (§0.1).
      // The agent gets one parsed line (title + URL), not the raw XML; the original
      // stays in the event ledger.
      processing.push("parsed");
      const sub = APPMSG_LABEL[appmsg] || "card";
      const a = parseAppmsg(text);
      // Files are stored unencrypted (msg/file/YYYY-MM/<name>); resolve the path
      // before rendering so the line includes it.
      if (sub === "file" && a.fileName) {
        a.localPath = localFilePath(a.fileName, row.create_time, this.filesRoot);
      }
      body = renderAppmsg(sub, a);
      const item = { kind: sub, ref: a.url || "", appmsgType: appmsg, card: a };
      if (a.localPath) item.localPath = a.localPath;
      media.push(item);
    } else if (type === 47) {
      // Animated sticker: the XML carries a plain HTTP URL whose content matches the
      // declared md5/size (unlike image/voice URLs, which are binary descriptors).
      // The plugin extracts the URL; downloading belongs to the shared layer.
      const e = parseEmoji(text);
      media.push({ kind: "sticker", ref: e.url || "", url: e.url,
        expectMd5: e.md5, expectBytes: e.len });
    } else if (type === 3) {
      // Image: the real file is a local encrypted `_h.dat` (V2 container). Only
      // locator info (md5 + table) is carried here; decryption happens in fetchMedia
      // so toDelivery stays light and synchronous.
      media.push({ kind: "image", ref: "", md5: imgMd5FromXml(text), table: row.table || "" });
    } else if (type === 34) {
      // Voice: the blob lives in media_0.db/VoiceInfo, keyed by server_id.
      // Fetching + SILK decoding happens in fetchMedia.
      media.push({ kind: "voice", ref: "", serverId: row.server_id != null ? String(row.server_id) : "" });
    } else if (kind) {
      media.push({ kind, ref: "" });           // media as asset, empty body
    } else {
      // Unknown type: pass the text, capped and marked as truncated (see PLAIN_MAX).
      body = text.length > PLAIN_MAX
        ? text.slice(0, PLAIN_MAX) + "…（[消息类型" + type + "] 原文共 " + text.length + " 字，已截断）"
        : text;
      processing.push("parsed");
    }

    return {
      channel: this.channel,
      accountId: row.accountId || "wechat",
      senderId: row.sender || "",              // real platform identity
      chatId: row.sender || "",
      chatType: "private",
      // Native local_id, qualified by table: each conversation has its own Msg_xxx
      // table and local_id is only unique within a table.
      nativeId: (row.table ? row.table + ":" : "") + String(row.local_id),
      receivedAt: new Date(row.create_time * 1000).toISOString(),
      text: body,
      media,
      processing,
    };
  }

  /**
   * Turn an inbound media item into plaintext bytes for the shared layer
   * (storage / transcription / vision).
   *
   * Boundary (§0.1): platform-specific decryption/decoding is the plugin's job;
   * everything after bytes is shared. Failures are reported explicitly.
   *
   * @param {{kind:string, md5?:string, table?:string, serverId?:string}} item
   * @param {{createTime?:number}} [ctx]
   * @returns {Promise<{bytes:Buffer, mime:string, hintName:string}|
   *                    {bytes:null, failed:string, detail?:string}>}
   */
  async fetchMedia(item = {}, ctx = {}) {
    if (item.kind === "image") {
      if (!this.imageKey || !this.attachRoot) return { bytes: null, failed: "image_key_missing" };
      if (!item.md5) return { bytes: null, failed: "image_unlocatable" };
      // With a hardlink lookup, resolve the real file name from the XML md5;
      // otherwise fall back to scanning _h.dat files by md5 (HD images only).
      const fileNameHint = typeof this.imageFileLookup === "function" ? this.imageFileLookup(item.md5) : "";
      // md5 miss (e.g. the client re-encoded the image) -> look up candidates by message time
      const fileNameHints = (!fileNameHint && typeof this.imageFilesByTime === "function" && ctx.createTime)
        ? this.imageFilesByTime(ctx.createTime) : [];
      const hit = locateImageDat({
        table: item.table, md5: item.md5, createTime: ctx.createTime,
        attachRoot: this.attachRoot, imageKey: this.imageKey, fileNameHint, fileNameHints,
      });
      // no file = not downloaded yet; report it
      if (!hit) return { bytes: null, failed: "image_not_downloaded" };

      // decrypted: standard images pass through; wxgf is converted to JPEG
      const mime = sniffImage(hit.bytes);
      if (mime) return { bytes: hit.bytes, mime, hintName: item.md5 + "." + mime.split("/")[1], variant: hit.variant, matchedBy: hit.matchedBy };
      if (isWxgf(hit.bytes)) {
        try {
          const jpg = await this.wxgfDecode(hit.bytes);
          return { bytes: jpg, mime: "image/jpeg", hintName: item.md5 + ".jpg", variant: hit.variant, matchedBy: hit.matchedBy };
        } catch (e) {
          return { bytes: null, failed: "wxgf_decode_failed", detail: e.message };
        }
      }
      return { bytes: null, failed: "image_unknown_format" };
    }

    if (item.kind === "voice") {
      if (typeof this.voiceLookup !== "function") return { bytes: null, failed: "voice_lookup_missing" };
      if (!item.serverId) return { bytes: null, failed: "voice_no_serverid" };
      const silk = this.voiceLookup(item.serverId);
      if (!silk || !silk.length) return { bytes: null, failed: "voice_blob_missing" };
      try {
        const wav = await this.silkDecode(silk);
        return { bytes: wav, mime: "audio/wav", hintName: item.serverId + ".wav" };
      } catch (e) {
        return { bytes: null, failed: "voice_decode_failed", detail: e.message };
      }
    }

    return { bytes: null, failed: "unsupported_kind" };
  }

  async send({ operationId, chatId, text, intent = "send_text", asset = null, extras = {}, toolArgs = {} }) {
    if (!chatId) throw notSent("插件收到的目标为空——出闸应当先解析目标");

    // Stickers / images go through clipboard paste. Fail explicitly rather than
    // degrading to a text message.
    if (intent === "send_sticker" || intent === "send_generated_image") {
      if (!this.imageSender) throw notSent("微信这条还没接图片发送器（imageSender）");
      const file = pickImagePath({ intent, asset, extras, toolArgs, text,
        stickerBook: this.stickerBook, stickerOwner: this.stickerOwner });
      if (!file) {
        // nothing was sent: tell the agent to pick another, not to avoid resending
        throw notSent("没这张贴纸/没拿到图片路径。换一张，或者先确认文件在不在。");
      }
      const nativeId = await this.imageSender({ chatId, filePath: file, operationId });
      return { nativeId: nativeId || null, sentAs: "image", filePath: file };
    }

    if (intent === "start_call") {
      if (!this.caller) throw notSent("微信这条还没接拨号器（caller）");
      await this.caller({ chatId, operationId });
      return { nativeId: null, sentAs: "call" };
    }

    if (intent === "end_call") {
      if (!this.hangUp) throw notSent("微信这条还没接挂断器（hangUp）");
      await this.hangUp({ chatId, operationId });
      return { nativeId: null, sentAs: "call_ended" };
    }

    if (intent === "send_voice") {
      if (!this.voiceSender) throw notSent("微信这条还没接语音发送器（voiceSender）");
      // A caller-supplied audio file is used as-is (the outbound gate skips TTS
      // and asset is empty in that case); otherwise use the synthesized asset.
      const file = (asset && (asset.filePath || asset.path))
        || (toolArgs && (toolArgs.filePath || toolArgs.file_path)) || "";
      if (!file) throw notSent("没拿到合成好的音频 —— 出闸应该先把词变成声音");
      await this.voiceSender({ chatId, filePath: file, operationId });
      return { nativeId: null, sentAs: "voice", filePath: file };
    }

    const nativeId = await this.sender({ chatId, text, operationId });
    return { nativeId: nativeId || null };
  }

  health() {
    return { platform: "supported", plugin: "wired", availability: this.sender ? "ready" : "offline" };
  }
}

module.exports = { WeChatPlugin, zstdUnpack, splitLocalType, APPMSG_LABEL, parseEmoji, localFilePath };

/**
 * Plugin descriptor: the owner's own WeChat desktop client (database read in,
 * accessibility automation out). Not the same leg as `wechat-bot` (weixin-bot.js).
 */
module.exports.leg = {
  name: "wechat",
  slot: "wechatA11y",
  configKeys: [
    ["GATE_WECHAT_KEYS_FILE", "WeChat DB keys JSON (all_keys.json, includes _db_dir)"],
    ["GATE_WECHAT_IMAGE_KEY_FILE", "decryption key file for image .dat files"],
    ["GATE_WECHAT_WHITELIST_FILE", "whitelist file: only messages from these contacts are received"],
    ["GATE_WECHAT_SENDER", "path to the outbound script linux-wx-send-a11y.py"],
    ["GATE_WECHAT_TARGET", "target chat window title (accessibility matches by title)"],
    ["GATE_WECHAT_SEND_LOCK", "lock file serializing UI automation (one WeChat window)"],
  ],
  // DB polling doesn't block; idle between polls to avoid spinning
  poll: { idleMsKey: "GATE_WECHAT_IDLE_MS", idleMsDefault: 2000 },
  make({ env, log }) {
    const { buildWechatMediaConfig } = require("./media-config");
    const media = buildWechatMediaConfig({
      keysFile: env.GATE_WECHAT_KEYS_FILE,
      imageKeyFile: env.GATE_WECHAT_IMAGE_KEY_FILE,
      log,
    });
    if (!media.imageKey) log("⚠️ WeChat media key not loaded: images and voice will be placeholders");
    const { makeA11ySenders } = require("./a11y-send");
    // Text sender backend: UI automation via AT-SPI (a11y).
    const senders = makeA11ySenders(env, log);
    return new WeChatPlugin({
      ...media,
      ...senders,
      keysFile: env.GATE_WECHAT_KEYS_FILE,
      whitelistFile: env.GATE_WECHAT_WHITELIST_FILE,
      ownerWxid: env.GATE_OWNER_WECHAT_ID || "",
      filesRoot: env.GATE_WECHAT_FILES_ROOT || media.filesRoot || "",   // env override; default derived from the DB dir in the keys file
      python: env.GATE_WECHAT_PYTHON || "python3",
      // WeChat needs local sticker images; Telegram-only packs fail explicitly (see pickImagePath).
      stickerBook: require("../../sticker-book").stickerBookFromEnv(env, log),
      stickerOwner: env.GATE_STICKER_OWNER || "",
      log,
    });
  },
};
