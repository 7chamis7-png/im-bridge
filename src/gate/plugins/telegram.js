"use strict";

/**
 * Telegram plugin.
 *
 * Everything Telegram-specific lives in this file; adding it must not require
 * changes to the core in src/gate/.
 *
 *  - Messages are plain Bot API JSON (no decryption, unlike the WeChat leg)
 *  - Supports group chats
 *  - Voice must be downloaded before transcription; that processing belongs to
 *    the plugin side, not the core
 */

const fs = require("fs");
const path = require("path");
const { notSent } = require("../errors");
const { stickerBookFromEnv } = require("../sticker-book");

const DEFAULT_MEDIA_TIMEOUT_MS = 30_000;
const DEFAULT_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
const TELEGRAM_MEDIA_KINDS = new Set(["image", "sticker", "voice", "audio", "video", "file"]);

/** File to send: caller extras > tool args > capability output (TTS / image generation). */
function pickFile({ asset, extras, toolArgs }) {
  if (extras && extras.filePath) return String(extras.filePath);
  if (toolArgs && toolArgs.filePath) return String(toolArgs.filePath);
  if (asset && Array.isArray(asset.files) && asset.files[0] && asset.files[0].filePath) {
    return String(asset.files[0].filePath);
  }
  if (asset && asset.filePath) return String(asset.filePath);
  return "";
}

class TelegramPlugin {
  /**
   * @param {object} opts
   * @param {function} opts.sender     function that actually sends text via the Bot API
   * @param {function} [opts.transcribe] optional voice transcriber (legacy hook)
   * @param {function} [opts.call]     low-level Bot API call (method, params) => Promise<json.result>;
   *   test seam. Without it a token is required and the plugin calls HTTPS itself.
   * @param {string} [opts.token]      bot token; must be passed in, never read from a file path.
   * @param {string|number} [opts.botId]      the bot's own user id (detects replies to the bot)
   * @param {string} [opts.botUsername]       the bot's own @username (detects mentions)
   *   Both only feed `addressing`; wake decisions belong to the shared layer (group.js).
   */
  constructor({ sender, transcribe, call = null, token = "", stickerBook = null, stickerOwner = "",
    botId = "", botUsername = "", fetchBytes = null,
    mediaTimeoutMs = DEFAULT_MEDIA_TIMEOUT_MS, mediaMaxBytes = DEFAULT_MEDIA_MAX_BYTES } = {}) {
    this.channel = "telegram";
    this.botId = String(botId || "");
    this.botUsername = String(botUsername || "").replace(/^@/, "").toLowerCase();
    this.sender = sender;
    // Sticker book (optional). Without it only raw file_ids can be sent; failures are explicit.
    this.stickerBook = stickerBook;
    // Which sticker pack owner to pick packs for
    this.stickerOwner = String(stickerOwner || "");
    this.token = String(token || "");
    this.call = call || ((method, params) => callBotApi(this.token, method, params));
    // Tests and hosts may supply a byte fetcher. The production fallback below
    // is deliberately small, bounded, and only uses Telegram's official file
    // endpoint after getFile has resolved the opaque file_id.
    this.fetchBytes = typeof fetchBytes === "function" ? fetchBytes : null;
    this.mediaTimeoutMs = Number(mediaTimeoutMs) > 0 ? Number(mediaTimeoutMs) : DEFAULT_MEDIA_TIMEOUT_MS;
    this.mediaMaxBytes = Number(mediaMaxBytes) > 0 ? Number(mediaMaxBytes) : DEFAULT_MEDIA_MAX_BYTES;
    // Bot API supports nearly everything
    this.capabilities = {
      send_text: "supported",
      send_file: "supported",
      send_voice: "supported",
      send_sticker: "supported",
      send_generated_image: "supported",
      react: "supported",
      // The Bot API has no way to start a voice call
      start_call: "unsupported",
      end_call: "unsupported",
    };
    this.transcribe = transcribe;
  }

  /**
   * Bot API message -> standard delivery.
   * @param {object} msg Telegram Bot API message object
   */
  async toDelivery(msg) {
    const processing = [];
    const media = [];
    let text = String((msg && (msg.text || msg.caption)) || "");

    if (msg && msg.photo) {
      const photo = msg.photo[msg.photo.length - 1] || {};
      media.push({ kind: "image", ref: String(photo.file_id || "") });
    }
    if (msg && msg.sticker) {
      media.push({ kind: "sticker", ref: String(msg.sticker.file_id || ""),
        hintName: String(msg.sticker.file_name || "") });
    }

    if (msg && msg.document) {
      media.push({ kind: "file", ref: String(msg.document.file_id || ""),
        hintName: String(msg.document.file_name || "") });
    }
    if (msg && msg.video) {
      media.push({ kind: "video", ref: String(msg.video.file_id || ""),
        hintName: String(msg.video.file_name || "") });
    }
    if (msg && msg.audio) {
      media.push({ kind: "audio", ref: String(msg.audio.file_id || ""),
        hintName: String(msg.audio.file_name || "") });
    }
    // Round videos and GIFs are separate Bot API fields, not video/document.
    // Missing them silently drops the media and leaves an empty text.
    if (msg && msg.video_note) {
      media.push({ kind: "video", ref: String(msg.video_note.file_id || ""),
        hintName: "video-note.mp4" });
    }
    if (msg && msg.animation) {
      media.push({ kind: "video", ref: String(msg.animation.file_id || ""),
        hintName: String(msg.animation.file_name || "animation.mp4") });
    }

    if (msg && msg.voice) {
      const voice = { kind: "voice", ref: String(msg.voice.file_id || "") };
      media.push(voice);
      if (this.transcribe) {
        // Compatibility for older hosts that inject a transcriber. New hosts
        // should let MediaPipeline.fetchMedia own this step; marking the item
        // text makes a successful legacy result visible without processing it
        // a second time during hydrate.
        try {
          const t = await this.transcribe(msg.voice.file_id);
          const rendered = String(t || "").trim();
          if (rendered) {
            text = rendered;
            voice.text = rendered;
            processing.push("transcribed");
          }
        } catch { /* MediaPipeline gets a chance to fetch and transcribe. */ }
      }
    }

    if (!processing.length) processing.push("none");

    const chat = (msg && msg.chat) || {};
    const from = (msg && msg.from) || {};
    return {
      channel: this.channel,
      // Platform facts for group handling (the decision itself lives in group.js):
      // mentions the bot / replies to the bot / sender is a bot.
      // Wake words are NOT evaluated here.
      addressing: this.#addressing(msg),
      // Display name only; identity always uses the numeric id below.
      senderName: String(from.first_name || from.username || "").trim(),
      accountId: (msg && msg.botAccountId) || "telegram",
      // Real platform identity: numeric user id, never the nickname (mutable, not unique)
      senderId: String(from.id || ""),
      chatId: String(chat.id || ""),
      chatType: chat.type === "private" ? "private" : "group",
      nativeId: String((msg && msg.message_id) || ""),
      receivedAt: new Date(Number((msg && msg.date) || 0) * 1000).toISOString(),
      text,
      media,
      processing,
    };
  }

  /**
   * Resolve a Telegram file_id and download its bytes for MediaPipeline.
   *
   * The Bot API deliberately separates getFile (metadata) from the file
   * download. Keep both operations here because only this plugin knows how
   * to turn Telegram's opaque ref into bytes.
   */
  async fetchMedia(item = {}) {
    const kind = String(item.kind || "").toLowerCase();
    if (!TELEGRAM_MEDIA_KINDS.has(kind)) return { bytes: null, failed: "unsupported_kind" };
    const fileId = String(item.ref || item.file_id || "").trim();
    if (!fileId) return { bytes: null, failed: "file_id_missing" };

    let info;
    try {
      info = await withTimeout(this.call("getFile", { file_id: fileId }), this.mediaTimeoutMs);
    } catch {
      // Do not return the API error: it may include request details or a URL.
      return { bytes: null, failed: "file_lookup_failed" };
    }
    const filePath = String((info && (info.file_path || info.result && info.result.file_path)) || "").trim();
    if (!filePath) return { bytes: null, failed: "file_path_missing" };
    const declaredBytes = Number(info && (info.file_size || info.result && info.result.file_size));
    if (Number.isFinite(declaredBytes) && declaredBytes > this.mediaMaxBytes) {
      return { bytes: null, failed: "media_too_large" };
    }
    if (!this.token) return { bytes: null, failed: "token_missing" };

    const url = "https://api.telegram.org/file/bot" + this.token + "/" + filePath;
    try {
      const bytes = await this.#downloadBytes(url, filePath);
      if (!bytes || !bytes.length) return { bytes: null, failed: "empty_download" };
      return {
        bytes,
        hintName: item.hintName || path.basename(filePath),
      };
    } catch (e) {
      // Only stable reason codes go back through hydrate and into model text;
      // never expose the token-bearing URL or a fetch implementation's error.
      return { bytes: null, failed: (e && e.code) || "download_failed" };
    }
  }

  async #downloadBytes(url, filePath) {
    if (this.fetchBytes) {
      const value = await withTimeout(this.fetchBytes(url, {
        filePath,
        timeoutMs: this.mediaTimeoutMs,
        maxBytes: this.mediaMaxBytes,
      }), this.mediaTimeoutMs);
      const bytes = value && value.bytes != null ? value.bytes : value;
      const out = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
      if (out.length > this.mediaMaxBytes) {
        const e = new Error("media too large");
        e.code = "media_too_large";
        throw e;
      }
      return out;
    }
    return downloadTelegramBytes(url, {
      timeoutMs: this.mediaTimeoutMs,
      maxBytes: this.mediaMaxBytes,
    });
  }

  /** Whether the message addresses the bot: @username (text or entities) or a reply to the bot. */
  #addressing(msg) {
    const text = String((msg && (msg.text || msg.caption)) || "");
    const u = this.botUsername;
    let mentionsMe = Boolean(u) && text.toLowerCase().includes("@" + u);
    if (!mentionsMe && u) {
      const entities = (msg && (msg.entities || msg.caption_entities)) || [];
      mentionsMe = entities.some((e) => e.type === "mention"
        && text.slice(e.offset, e.offset + e.length).toLowerCase() === "@" + u);
    }
    const replied = msg && msg.reply_to_message && msg.reply_to_message.from;
    const repliedToMe = Boolean(replied && (
      (this.botId && String(replied.id) === this.botId)
      || (u && String(replied.username || "").toLowerCase() === u)
    ));
    return { mentionsMe, repliedToMe, senderIsBot: Boolean(msg && msg.from && msg.from.is_bot) };
  }

  /**
   * Fetch messages from the platform.
   *
   * The plugin only fetches. Persisting/advancing the cursor belongs to the shared
   * layer (reliable redelivery, see SPEC §5): if the plugin advanced it itself, a
   * crash would lose the in-flight messages.
   *
   * @param {object} o
   * @param {number} [o.since]      update_id to start from (cursor from the shared layer)
   * @param {number} [o.timeoutSec] long-poll timeout; 0 = return immediately
   * @param {number} [o.limit]
   * @returns {{items: Array<{update_id:number, message:object}>, cursor:number}}
   *   cursor = where to start next time; the shared layer stores it once the batch is processed.
   */
  async poll({ since = 0, timeoutSec = 25, limit = 100 } = {}) {
    const updates = await this.call("getUpdates", {
      offset: since || undefined,
      timeout: timeoutSec,
      limit,
      // Only message types this leg handles. callback_query = inline button presses;
      // without it buttons spin forever and the agent never learns about the press.
      allowed_updates: ["message", "callback_query"],
    });
    const items = [];
    let maxId = since ? since - 1 : 0;
    for (const u of Array.isArray(updates) ? updates : []) {
      const id = Number(u && u.update_id);
      if (Number.isFinite(id)) maxId = Math.max(maxId, id);
      if (u && u.message) items.push({ update_id: id, message: u.message });
      else if (u && u.callback_query) {
        const msg = this.#buttonPress(u.callback_query);
        if (msg) items.push({ update_id: id, message: msg });
      }
    }
    return { items, cursor: maxId + 1 };
  }

  /**
   * Button press -> treated as an ordinary inbound message (identity, group gate,
   * cold log all apply as usual).
   *
   * · Acknowledge first (answerCallbackQuery) or the button keeps spinning; ack failure is ignored.
   * · Text is marked as a button press rather than pretending the user typed it.
   * · The id is `<message id>-btn-<callback id>`: the button message belongs to the bot,
   *   and pressing the same row twice would otherwise be deduplicated.
   * · reply_to_message points at the bot's message so group logic sees it as a reply.
   */
  #buttonPress(cq) {
    if (!cq || !cq.message || !cq.message.chat) return null;
    this.call("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => { /* only affects the spinner */ });
    const label = String(cq.data || "").trim();
    if (!label) return null;
    // Command buttons (e.g. the `/model` menu) carry the full command in their callback data.
    // Pass it through unchanged so the shared command layer can match it; a prefix would break it.
    // Unregistered slash text is forwarded as normal text.
    const isCommand = label.startsWith("/");
    return {
      message_id: `${cq.message.message_id}-btn-${cq.id}`,
      from: cq.from || {},
      chat: cq.message.chat,
      date: Math.floor(Date.now() / 1000),
      text: isCommand ? label : `（点了按钮）${label}`,
      reply_to_message: cq.message,
    };
  }

  /**
   * Outbound: turn the gate's request into a Telegram action.
   *
   * Default deny: only the intents handled below are supported; anything else fails
   * explicitly. Never silently degrade a sticker/voice/image into plain text while
   * reporting success.
   */
  async send({ operationId, chatId, text, intent = "send_text", asset = null, extras = {}, toolArgs = {} }) {
    if (!chatId) throw notSent("插件收到的目标为空——出闸应当先解析目标");
    const chat_id = chatId;

    switch (intent) {
      case "send_text": {
        // Text keeps the injectable sender (tests/scripts); otherwise call the Bot API.
        if (this.sender) {
          const nativeId = await this.sender({ chatId, text, operationId });
          return { nativeId: nativeId || null };
        }
        const r = await this.call("sendMessage", {
          chat_id, text,
          ...(extras.reply_to_message_id ? { reply_to_message_id: Number(extras.reply_to_message_id) } : {}),
          ...(extras.parse_mode ? { parse_mode: extras.parse_mode } : {}),
          ...(Array.isArray(extras.inline_keyboard) && extras.inline_keyboard.length
            ? { reply_markup: { inline_keyboard: extras.inline_keyboard.map((b) => [b]) } } : {}),
        });
        return { nativeId: String((r && r.message_id) || "") };
      }

      case "send_generated_image": {
        const file = pickFile({ asset, extras, toolArgs });
        if (!file) throw notSent("没拿到图片路径 —— 确认文件在不在，或者换一张");
        const r = await this.callFile("sendPhoto", "photo", file, { chat_id, ...(text ? { caption: text } : {}) });
        return { nativeId: String((r && r.message_id) || ""), sentAs: "photo", filePath: file };
      }

      case "send_sticker": {
        // Telegram accepts a file_id (received stickers can be echoed) or a local file.
        let fileId = (toolArgs && toolArgs.file_id) || (extras && extras.file_id) || "";
        if (!fileId && this.stickerBook) {
          const want = (toolArgs && toolArgs.sticker) || (toolArgs && toolArgs.emoji) || text;
          const found = this.stickerBook.resolve(want, this.stickerOwner);
          if (!found) {
            throw notSent("贴纸本里没有「" + String(want || "").slice(0, 30) + "」这张"
              + " —— 换个说法，或者用 #序号");
          }
          // Fetch a live file_id: stored Telegram file_ids go stale, and a stale one
          // produces a misleading "sticker not found" error. The stored id is only a fallback.
          fileId = (await this.#liveFileId(found)) || found.fileId;
          if (!fileId) throw notSent("拿不到「" + found.name + "」当下有效的 file_id");
        }
        if (fileId) {
          const r = await this.call("sendSticker", { chat_id, sticker: fileId });
          return { nativeId: String((r && r.message_id) || ""), sentAs: "sticker", fileId };
        }
        const file = pickFile({ asset, extras, toolArgs });
        if (!file) throw notSent("这张贴纸既没有 file_id 也没有本地文件 —— 换一张，或者先确认贴纸本接上了");
        const r = await this.callFile("sendSticker", "sticker", file, { chat_id });
        return { nativeId: String((r && r.message_id) || ""), sentAs: "sticker", filePath: file };
      }

      case "send_voice": {
        const file = pickFile({ asset, extras, toolArgs });
        if (!file) throw notSent("没拿到音频文件 —— 语音合成那步没出东西");
        const r = await this.callFile("sendVoice", "voice", file, { chat_id });
        return { nativeId: String((r && r.message_id) || ""), sentAs: "voice", filePath: file };
      }

      case "send_file": {
        const file = pickFile({ asset, extras, toolArgs });
        if (!file) throw notSent("没拿到要发的文件路径");
        const r = await this.callFile("sendDocument", "document", file, { chat_id, ...(text ? { caption: text } : {}) });
        return { nativeId: String((r && r.message_id) || ""), sentAs: "document", filePath: file };
      }

      case "react": {
        const messageId = Number((extras && extras.message_id) || (toolArgs && toolArgs.message_id) || 0);
        if (!messageId) throw notSent("点表情要知道点哪一条（message_id）");
        const emoji = String((toolArgs && toolArgs.emoji) || (extras && extras.emoji) || text || "❤️").trim();
        await this.call("setMessageReaction", {
          chat_id, message_id: messageId, reaction: [{ type: "emoji", emoji }],
        });
        return { nativeId: String(messageId), sentAs: "reaction", emoji };
      }

      default:
        // Never silently degrade to plain text.
        throw notSent("Telegram 这条腿还没接这个意图：" + intent);
    }
  }

  /**
   * Current file_id for sticker `index` of a pack.
   *
   * Cached for one hour: avoids an API call per sticker, but packs can change,
   * so it is never cached forever.
   */
  async #liveFileId(found) {
    if (!found || !found.setName || !this.token) return "";
    const now = Date.now();
    const cached = this._setCache && this._setCache[found.setName];
    let list = (cached && now - cached.at < 3600_000) ? cached.list : null;
    if (!list) {
      try {
        const r = await this.call("getStickerSet", { name: found.setName });
        list = (r && r.stickers) || [];
        this._setCache = { ...(this._setCache || {}), [found.setName]: { at: now, list } };
      } catch (e) {
        this.log("[贴纸] 拉不到贴纸包 " + found.setName + "，退回存的 id：" + ((e && e.message) || e));
        return "";
      }
    }
    const s = list[found.index];
    return (s && s.file_id) || "";
  }

  /** File uploads use multipart; the Bot API file endpoints don't accept JSON. */
  async callFile(method, field, filePath, params) {
    if (!this.token) throw notSent("要传文件得给 token（这条路不走 sender 替身）");
    if (!fs.existsSync(filePath)) throw notSent("文件不在：" + filePath);
    const form = new FormData();
    for (const [k, v] of Object.entries(params || {})) form.append(k, String(v));
    form.append(field, new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, { method: "POST", body: form });
    const j = await res.json();
    if (!j || j.ok !== true) throw new Error("Bot API " + method + " 失败：" + JSON.stringify(j).slice(0, 200));
    return j.result;
  }

  health() {
    // Ready if we can actually send: either an injected sender or a token
    // (send() falls back to this.call("sendMessage")). Checking only `sender`
    // would mark every token-only production setup offline.
    return { platform: "supported", plugin: "wired",
      availability: (this.sender || this.token) ? "ready" : "offline" };
  }
}

/** Download a response with both a deadline and a hard byte ceiling. */
async function downloadTelegramBytes(url, { timeoutMs, maxBytes }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res || !res.ok) {
      const e = new Error("telegram download failed");
      e.code = "download_http";
      throw e;
    }
    const declared = Number(res.headers && res.headers.get && res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      const e = new Error("media too large");
      e.code = "media_too_large";
      throw e;
    }

    if (res.body && typeof res.body.getReader === "function") {
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        const chunk = Buffer.from(part.value || []);
        total += chunk.length;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch { /* best effort */ }
          const e = new Error("media too large");
          e.code = "media_too_large";
          throw e;
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, total);
    }

    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > maxBytes) {
      const e = new Error("media too large");
      e.code = "media_too_large";
      throw e;
    }
    return bytes;
  } catch (e) {
    if (e && e.name === "AbortError") {
      const timeout = new Error("telegram download timed out");
      timeout.code = "download_timeout";
      throw timeout;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error("telegram download timed out");
      e.code = "download_timeout";
      reject(e);
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

/** Call the Bot API. Only used when no `call` seam is injected. */
async function callBotApi(token, method, params) {
  if (!token) throw new Error("Telegram 插头没有 token —— 装配时传进来，别让它自己去文件里找");
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params || {}),
  });
  const j = await res.json();
  if (!j || j.ok !== true) throw new Error("Bot API " + method + " 失败：" + JSON.stringify(j).slice(0, 200));
  return j.result;
}

module.exports = { TelegramPlugin, callBotApi };

/** Plugin descriptor: name, required config, and how to construct it. */
module.exports.leg = {
  name: "telegram",
  slot: "telegram",
  configKeys: [["GATE_TELEGRAM_TOKEN", "TG bot token"]],
  // long polling blocks by itself, no idle sleep needed
  poll: { timeoutSecKey: "GATE_POLL_TIMEOUT_SEC", timeoutSecDefault: 25 },
  make({ env, log }) {
    return new TelegramPlugin({
      token: env.GATE_TELEGRAM_TOKEN,
      botId: env.GATE_BOT_ID || "",
      botUsername: env.GATE_BOT_USERNAME || "",
      // without GATE_STICKER_PACKS there is no sticker book; sending by name fails explicitly
      stickerBook: stickerBookFromEnv(env, log),
      stickerOwner: env.GATE_STICKER_OWNER || "",
      log,
    });
  },
};
