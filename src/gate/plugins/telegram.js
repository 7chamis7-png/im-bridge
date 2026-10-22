"use strict";

/**
 * Telegram 插件（阶段 3）
 *
 * **这一个文件就是阶段 3 的全部。** 如果接它需要动 src/gate/ 里任何一个核心文件，
 * 说明接口没定对，应当退回阶段 1 重定，而不是在核心里开特例。
 * 这条就是 A01「新接一个渠道不修改 core」的判决方式。
 *
 * Telegram 与前两个渠道的差别，全部由插件自己消化：
 *  - 正文是 Bot API 的明文 JSON，无需解密解压（对比微信要解 SQLCipher + zstd）
 *  - 有群聊，而 iMessage / 微信这条线只有私聊
 *  - 语音要先下载再转写 —— **转写属于加工，归插件（闸外）**
 */

const fs = require("fs");
const path = require("path");
const { notSent } = require("../errors");
const { stickerBookFromEnv } = require("../sticker-book");

const DEFAULT_MEDIA_TIMEOUT_MS = 30_000;
const DEFAULT_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
const TELEGRAM_MEDIA_KINDS = new Set(["image", "sticker", "voice", "audio", "video", "file"]);

/** 要发的文件从哪来：调用方给的 > 工具参数 > 共用能力生成的（语音合成/生图）。 */
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
   * @param {function} opts.sender     真正打到 Bot API 的函数
   * @param {function} [opts.transcribe] 语音转写，插件在交付前自己调（闸外加工）
   * @param {function} [opts.call]     打 Bot API 的底层调用 (method, params) => Promise<json.result>
   *   —— **测试塞替身用**。不给就得给 token，插头自己用 https 打。
   * @param {string} [opts.token]      bot token。**只能传进来，不许从文件路径里读**（铁律 1）。
   * @param {string|number} [opts.botId]      他自己的 user id —— 用来认「这条是不是在回他」
   * @param {string} [opts.botUsername]       他自己的 @用户名 —— 用来认「这条有没有 @ 他」
   *   这两样只喂给 `addressing`，**插头不拿它们做决定**：要不要叫醒是共用层（group.js）的事。
   */
  constructor({ sender, transcribe, call = null, token = "", stickerBook = null, stickerOwner = "",
    botId = "", botUsername = "", fetchBytes = null,
    mediaTimeoutMs = DEFAULT_MEDIA_TIMEOUT_MS, mediaMaxBytes = DEFAULT_MEDIA_MAX_BYTES } = {}) {
    this.channel = "telegram";
    this.botId = String(botId || "");
    this.botUsername = String(botUsername || "").replace(/^@/, "").toLowerCase();
    this.sender = sender;
    // 贴纸本（路径装配时给）。没给就只能靠 file_id 发，发不了会明说。
    this.stickerBook = stickerBook;
    // 这条桥服务谁 —— 贴纸本按它挑包（Nova=小熊、Iris=小兔）
    this.stickerOwner = String(stickerOwner || "");
    this.token = String(token || "");
    this.call = call || ((method, params) => callBotApi(this.token, method, params));
    // Tests and hosts may supply a byte fetcher. The production fallback below
    // is deliberately small, bounded, and only uses Telegram's official file
    // endpoint after getFile has resolved the opaque file_id.
    this.fetchBytes = typeof fetchBytes === "function" ? fetchBytes : null;
    this.mediaTimeoutMs = Number(mediaTimeoutMs) > 0 ? Number(mediaTimeoutMs) : DEFAULT_MEDIA_TIMEOUT_MS;
    this.mediaMaxBytes = Number(mediaMaxBytes) > 0 ? Number(mediaMaxBytes) : DEFAULT_MEDIA_MAX_BYTES;
    // Bot API 能力最全
    this.capabilities = {
      send_text: "supported",
      send_file: "supported",
      send_voice: "supported",
      send_sticker: "supported",
      send_generated_image: "supported",
      react: "supported",
      // Bot API 没有"发起语音通话"这回事（2026-09-18）
      start_call: "unsupported",
      end_call: "unsupported",
    };
    this.transcribe = transcribe;
  }

  /**
   * Bot API 的一条 message -> 标准交付。
   * @param {object} msg Telegram Bot API message 对象
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
    // 圆视频和 GIF 在 Bot API 里是独立字段，不会落进 video/document。
    // 漏掉它们不会报错，只会把媒体静默丢掉、只剩一条空文本（2026-09-18 Keeper补）。
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
      // 群那一套要的**平台事实**（动作归插头，决定归共用层 group.js）：
      // 有没有 @ 他 / 这条是不是在回他 / 发言人是不是个 bot。
      // 叫醒词（「Nova」「Alice」）**不在这儿判** —— 那是决定，不是平台脏活。
      addressing: this.#addressing(msg),
      // 群里他要看见是谁说的。昵称只用来显示，认人一律用上面那个数字 id。
      senderName: String(from.first_name || from.username || "").trim(),
      accountId: (msg && msg.botAccountId) || "telegram",
      // 真实平台身份 —— 用数字 user id，不用昵称（昵称可改、可重名）
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

    const url = telegramApiBase() + "/file/bot" + this.token + "/" + filePath;
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

  /** 这条消息有没有直接点他：@用户名（正文里或 entities 里）、或者回复他的消息。 */
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
   * **自己去平台捞消息**（2026-09-18）。
   *
   * 插头只管「捞」，捞上来什么样交出去什么样 —— **游标存不存、什么时候推进，
   * 不归它管**（那是共用层的可靠重投：进了盒子、落了冷层才算数，见 SPEC §5）。
   * 插头自己推进游标的话，进程一崩，那几条就永远丢了。
   *
   * @param {object} o
   * @param {number} [o.since]      从哪个 update_id 开始（共用层给的游标）
   * @param {number} [o.timeoutSec] 长轮询等多久；0 = 不等，立刻回
   * @param {number} [o.limit]
   * @returns {{items: Array<{update_id:number, message:object}>, cursor:number}}
   *   cursor = **下一次该从哪开始**；共用层确认这批都消化完了才存它。
   */
  async poll({ since = 0, timeoutSec = 25, limit = 100 } = {}) {
    const updates = await this.call("getUpdates", {
      offset: since || undefined,
      timeout: timeoutSec,
      limit,
      // 只要真人消息那几类；别的类型（编辑、频道帖、投票）这条腿不认，
      // 收进来也没人处理，白占游标。
      // 2026-09-20：加 callback_query —— 她按了他发的选项按钮。不收的话按钮能发、
      // 一按就一直转圈，他那头什么也不知道。
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
   * 她按了按钮 → 当成她说了一句话交给共用层，**认人、群闸、冷层全照一条普通消息走**。
   *
   * · 先应一声（answerCallbackQuery），不然她那边按钮一直转圈。应答失败不挡这条消息。
   * · 正文写明是按钮，不冒充她打的字：「（点了按钮）选项文字」。
   * · 编号不用按钮所在那条消息的号 —— 那是**他**发的消息，而且同一排按钮按两次
   *   会撞号被当重复吞掉；用 `<那条消息号>-btn-<回调 id>`，唯一。
   * · reply_to_message 指向他那条带按钮的消息：群里据此认「在回他」。
   */
  #buttonPress(cq) {
    if (!cq || !cq.message || !cq.message.chat) return null;
    this.call("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => { /* 转圈而已，不挡消息 */ });
    const label = String(cq.data || "").trim();
    if (!label) return null;
    // 2026-09-23：命令按钮（`/model` 弹的那排）回调里放的是整条命令 —— 原样交出去，
    // 共用层按「她本人 + 注册过的命令」照常拦；加了「（点了按钮）」前缀斜杠就不在开头，命令失效。
    // 没注册的斜杠照旧当正文送给他，跟她亲手打一样。
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
   * 出站：把闸给定的内容变成 Telegram 的动作。
   *
   * ⚠️ **默认拒绝**：只处理下面显式写过的意图，别的一律明说发不了。
   * 这条是拿教训换的 —— 2026-09-18 之前这个函数不看 intent，
   * 他发贴纸、发语音、发图，出去的**全是一段文字**，而出闸还记成「发成功」。
   * 他以为说出去了，她那头收到一句莫名其妙的话。
   * 宁可让他收到「这个发不了」，也不许把贴纸变成字。
   */
  async send({ operationId, chatId, text, intent = "send_text", asset = null, extras = {}, toolArgs = {} }) {
    if (!chatId) throw notSent("插件收到的目标为空——出闸应当先解析目标");
    const chat_id = chatId;

    switch (intent) {
      case "send_text": {
        // 文字这条保留 sender 注入（测试和脚本在用）；没注入就自己打 Bot API。
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
        // TG 认 file_id（她发过来的那张能原样回），也能传本地文件。
        let fileId = (toolArgs && toolArgs.file_id) || (extras && extras.file_id) || "";
        if (!fileId && this.stickerBook) {
          const want = (toolArgs && toolArgs.sticker) || (toolArgs && toolArgs.emoji) || text;
          const found = this.stickerBook.resolve(want, this.stickerOwner);
          if (!found) {
            throw notSent("贴纸本里没有「" + String(want || "").slice(0, 30) + "」这张"
              + " —— 换个说法，或者用 #序号");
          }
          // ⚠️ **现拉，不用存货**：TG 的 file_id 会过期。2026-09-19 实测本地存的
          // 24 个跟线上现拉的 **0 个一致**，直接用存货一张也发不出去，
          // 而且报的错会把人带去查"贴纸不存在"。存的那个只当最后兜底。
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
        // **不许悄悄降级成发文字。**
        throw notSent("Telegram 这条腿还没接这个意图：" + intent);
    }
  }

  /** 传文件走 multipart。Bot API 的文件接口不吃 JSON。 */
  /**
   * 拿「这一包第 index 张」**当下有效**的 file_id。
   *
   * 缓存一小时：他连发几张不该打几次 API，但也不能永久缓存 —— 她随时会往包里
   * 加新贴纸（2026-09-19 就发现线上 30 张、本地只记了 24 张）。
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

  async callFile(method, field, filePath, params) {
    if (!this.token) throw notSent("要传文件得给 token（这条路不走 sender 替身）");
    if (!fs.existsSync(filePath)) throw notSent("文件不在：" + filePath);
    const form = new FormData();
    for (const [k, v] of Object.entries(params || {})) form.append(k, String(v));
    form.append(field, new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
    const res = await fetch(`${telegramApiBase()}/bot${this.token}/${method}`, { method: "POST", body: form });
    const j = await res.json();
    if (!j || j.ok !== true) throw new Error("Bot API " + method + " 失败：" + JSON.stringify(j).slice(0, 200));
    return j.result;
  }

  health() {
    // ⚠️ 判据是**能不能发出去**，不是「有没有塞替身」。插头有 token 就能自己打 Bot API
    // （见 send()：没有 sender 就走 this.call("sendMessage")）。
    // 原来只认 sender，于是生产装配（按设计只给 token）一律判成 offline，
    // 出闸 precheck 当场 blocked —— 盒子跑完了、冷层也写了，她那头什么都没收到。
    // 2026-09-18 玩具实例实测抓到：`blocked reason=channel_offline`，
    // 而测试里人人都传 sender，所以这个洞一路全绿。
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

/**
 * 打 Bot API。**只在没给 call 替身时用到。**
 * 放在插头里而不是从老桥 import —— 桥要拷得走（铁律 1），
 * 「怎么跟 Telegram 说话」本来就该是这条腿自己的事。
 */
/**
 * Bot API 的地址。默认官方；GATE_TELEGRAM_API_BASE 可指到自建的 Bot API server / 反代 / 测试用的假服务。
 * 每次现读（测试在同一个进程里换）。
 */
function telegramApiBase(env = process.env) {
  return String(env.GATE_TELEGRAM_API_BASE || "").trim().replace(/\/+$/, "") || "https://api.telegram.org";
}

async function callBotApi(token, method, params) {
  if (!token) throw new Error("Telegram 插头没有 token —— 装配时传进来，别让它自己去文件里找");
  const res = await fetch(`${telegramApiBase()}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params || {}),
  });
  const j = await res.json();
  if (!j || j.ok !== true) throw new Error("Bot API " + method + " 失败：" + JSON.stringify(j).slice(0, 200));
  return j.result;
}

module.exports = { TelegramPlugin, callBotApi, telegramApiBase };

/**
 * 自我介绍（2026-09-18 插头插件化）——**桥靠这段认识它，不用在 main.js 里写死**。
 * 插头本身一个字没改；这里只是把「叫什么、要哪些配置、怎么造」说出来。
 */
module.exports.leg = {
  name: "telegram",
  slot: "telegram",
  configKeys: [["GATE_TELEGRAM_TOKEN", "TG bot token"]],
  // 长轮询自己会阻塞，不用额外歇
  poll: { timeoutSecKey: "GATE_POLL_TIMEOUT_SEC", timeoutSecDefault: 25 },
  make({ env, log }) {
    return new TelegramPlugin({
      token: env.GATE_TELEGRAM_TOKEN,
      botId: env.GATE_BOT_ID || "",
      botUsername: env.GATE_BOT_USERNAME || "",
      // 没配 GATE_STICKER_PACKS = 这条腿没贴纸，插头会明说，不会退成发一行字
      stickerBook: stickerBookFromEnv(env, log),
      stickerOwner: env.GATE_STICKER_OWNER || "",
      log,
    });
  },
};
