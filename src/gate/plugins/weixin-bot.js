"use strict";

/**
 * 微信 im.bot 网关插件（阶段 4）
 *
 * 对应现网 src/adapters/channel/weixin/（2435 行）。盘点发现那 2435 行里**大头是分段与排版**
 * —— chunkReplyTextForWeixin / packChunksForWeixinDelivery / collectStreamingBoundaries 等。
 * 按 §0.1，排版分段是**插件的活**，闸一个字都不该懂。
 *
 * 这个插件和 wechat.js（VPS 直读库那条）是**同一个来源的两条技术路径**。
 * Alice 2026-09-17 口径：「**来源是一个**」—— 她眼里微信就是微信。
 * ⚠️ 2026-09-18 作废：原来两个插件交付时 channel 都填 "wechat"（见下面构造器里的说明），
 * 不进来源。现网的毛病正在这儿：冷层里裂成 a1b2c3d4e5f6-im.bot 和 android-wechat 两个身份。
 */

const DEFAULT_CHUNK = 3500;

/** 分段：插件的活。按段落边界优先，其次句子，最后硬切。 */
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
    if (cut < limit * 0.3) cut = limit;     // 实在找不到边界就硬切
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
   * @param {function} [opts.contextToken] 取当前 context_token —— **平台细节，闸不该知道**
   */
  constructor({ sender, contextToken, chunkLimit = DEFAULT_CHUNK } = {}) {
    // 2026-09-18 Alice拆开：**它跟真实微信不是一个插口。**
    // a11y 那条读的是她自己的微信客户端（身份 = wxid，会话 = 真人聊天窗）；
    // 这条是 im.bot 上的一个 **bot 账号**（身份 = fromUserId，回话还得配 contextToken）。
    // 「都叫微信」不等于同一个来源 —— 身份体系、回复地址、消息处理从头到尾都不一样。
    this.channel = "wechat-bot";
    this.transport = "im.bot";        // 技术路径只进排障字段，不进来源
    this.sender = sender;
    // im.bot 网关支持媒体上传（现网 media-send.js）
    this.capabilities = {
      send_text: "supported",
      send_file: "supported",
      send_voice: "supported",
      send_sticker: "unsupported",
      // 现网 media-send.js 有 WEIXIN_MEDIA_TYPE.IMAGE 这条路（image/* 走 image_item），核过再填的
      send_generated_image: "supported",
      react: "unsupported",
      start_call: "unsupported",          // 网关只能收发消息
      end_call: "unsupported",
    };
    this.contextToken = contextToken;
    this.chunkLimit = chunkLimit;
  }

  /** getUpdates 的一条 -> 标准交付。网关返回明文 JSON，无需解密解压。 */
  toDelivery(update) {
    const media = [];
    const kind = update && update.msgType;
    if (kind === "image") media.push({ kind: "image", ref: String(update.mediaId || "") });
    if (kind === "voice") media.push({ kind: "voice", ref: String(update.mediaId || "") });

    return {
      channel: this.channel,
      transport: this.transport,
      accountId: (update && update.botAccountId) || "im.bot",
      senderId: String((update && update.fromUserId) || ""),   // 真实平台身份
      chatId: String((update && update.fromUserId) || ""),
      chatType: "private",
      nativeId: String((update && update.msgId) || ""),        // 网关原生消息 ID
      receivedAt: update && update.createTime
        ? new Date(Number(update.createTime) * 1000).toISOString()
        : new Date().toISOString(),
      text: String((update && update.content) || ""),
      media,
      processing: ["none"],
    };
  }

  /** 出站：分段在插件内部完成，闸只交一段完整正文和一个目标 */
  async send({ operationId, chatId, text }) {
    if (!chatId) throw new Error("插件收到的目标为空——出闸应当先解析目标");
    const chunks = chunkText(text, this.chunkLimit);
    const token = this.contextToken ? await this.contextToken() : undefined;
    const ids = [];
    for (let i = 0; i < chunks.length; i += 1) {
      // 每段带自己的操作 ID —— 部分成功后不整篇重发（微信评审优先级 2）
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
