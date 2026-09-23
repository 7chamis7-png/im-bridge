"use strict";

/**
 * WeChat im.bot gateway plugin.
 *
 * Most platform-specific work here is chunking and layout; per SPEC §0.1
 * that belongs to the plugin, and the gate knows nothing about it.
 *
 * This is a different source from the `wechat` leg (which reads a local WeChat
 * client): it is a bot account with its own identity scheme (fromUserId) and
 * reply addressing (contextToken), so it uses its own channel name `wechat-bot`.
 */

const DEFAULT_CHUNK = 3500;

/** Chunking: prefer paragraph boundaries, then sentences, then a hard cut. */
function chunkText(text, limit = DEFAULT_CHUNK) {
  const s = String(text || "");
  if (s.length <= limit) return s ? [s] : [];
  const out = [];
  let rest = s;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"));
    if (cut < limit * 0.5) {
      for (const p of ["。", "！", "？", "…", ". ", "! ", "? "]) {
        cut = Math.max(cut, window.lastIndexOf(p) + p.length);
      }
    }
    if (cut < limit * 0.3) cut = limit;     // no usable boundary: hard cut
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

class WeixinBotPlugin {
  /**
   * @param {object} opts
   * @param {function} opts.sender  (toUserId, text, contextToken) => nativeId
   * @param {function} [opts.contextToken] returns the current context_token (platform detail, hidden from the gate)
   */
  constructor({ sender, contextToken, chunkLimit = DEFAULT_CHUNK } = {}) {
    // Separate channel from `wechat`: identity (fromUserId vs wxid), reply addressing
    // and message handling all differ.
    this.channel = "wechat-bot";
    this.transport = "im.bot";        // diagnostic only, not part of the source identity
    this.sender = sender;
    // the im.bot gateway supports media upload
    this.capabilities = {
      send_text: "supported",
      send_file: "supported",
      send_voice: "supported",
      send_sticker: "unsupported",
      send_generated_image: "supported",
      react: "unsupported",
      start_call: "unsupported",          // gateway only sends/receives messages
      end_call: "unsupported",
    };
    this.contextToken = contextToken;
    this.chunkLimit = chunkLimit;
  }

  /** One getUpdates item -> standard delivery. Plain JSON, no decoding needed. */
  toDelivery(update) {
    const media = [];
    const kind = update && update.msgType;
    if (kind === "image") media.push({ kind: "image", ref: String(update.mediaId || "") });
    if (kind === "voice") media.push({ kind: "voice", ref: String(update.mediaId || "") });

    return {
      channel: this.channel,
      transport: this.transport,
      accountId: (update && update.botAccountId) || "im.bot",
      senderId: String((update && update.fromUserId) || ""),   // real platform identity
      chatId: String((update && update.fromUserId) || ""),
      chatType: "private",
      nativeId: String((update && update.msgId) || ""),        // native gateway message id
      receivedAt: update && update.createTime
        ? new Date(Number(update.createTime) * 1000).toISOString()
        : new Date().toISOString(),
      text: String((update && update.content) || ""),
      media,
      processing: ["none"],
    };
  }

  /** Outbound: chunking happens inside the plugin; the gate hands over one full text and a target. */
  async send({ operationId, chatId, text }) {
    if (!chatId) throw new Error("插件收到的目标为空——出闸应当先解析目标");
    const chunks = chunkText(text, this.chunkLimit);
    const token = this.contextToken ? await this.contextToken() : undefined;
    const ids = [];
    for (let i = 0; i < chunks.length; i += 1) {
      // each chunk has its own operation id so a partial success is not resent in full
      const id = await this.sender({ chatId, text: chunks[i], contextToken: token,
        operationId: operationId + "#" + (i + 1) + "/" + chunks.length });
      ids.push(id);
    }
    return { nativeId: ids[0] || null, segments: ids.length, segmentIds: ids };
  }

  health() {
    return { platform: "supported", plugin: "wired", availability: this.sender ? "ready" : "offline" };
  }
}

module.exports = { WeixinBotPlugin, chunkText };
