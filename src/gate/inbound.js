"use strict";

/**
 * 入闸（设计稿 v1.5 §0.1）—— 永远是最后一步。
 *
 *   插件：平台收取 → 解密 → 解压 → 转写 → 【交付】
 *                                            ↓
 *                                       【入闸】  ← 就是这里
 *                            验收 / 身份归一 / 编号 / 写冷层 → 交给 CLI
 *
 * 闸不懂 SQLCipher、不懂 zstd、不懂语音模型。它只做四件事，多一件都不做。
 */

const { verifyInbound } = require("./verify");
const { GateStore } = require("./store");
const { ColdWriter } = require("./cold-writer");

class InboundGate {
  /**
   * @param {object} opts
   * @param {GateStore} opts.store
   * @param {ColdWriter} opts.cold
   * @param {object} opts.identities  真实平台 ID → 统一身份。**不能靠昵称认人。**
   * @param {string} opts.sequenceScope 编号域：Alice↔Nova这条流跨渠道共用一个
   */
  constructor({ store, cold, identities = {}, sequenceScope = "alice" }) {
    this.store = store;
    this.cold = cold;
    this.identities = identities;
    this.sequenceScope = sequenceScope;
  }

  /**
   * 身份归一：只认配置过的真实平台 ID；认不出就是 unknown，绝不硬填成她。
   *
   * **这个函数回答的是「这个人是谁」，不是「这一轮算谁的」。** 群里大部分人本来就
   * 认不出来 —— 那不是故障。群轮该挂在谁名下由 `identityForTurn` 说了算。
   */
  resolveIdentity(delivery) {
    const key = delivery.channel + ":" + (delivery.senderId || "");
    return this.identities[key] || this.identities[delivery.senderId] || "unknown";
  }

  /**
   * 这一轮算谁的。私聊 = 发言人本人；群轮 = **这个群**（配置键 `channel:group:<chatId>`）。
   *
   * 为什么群轮按群不按人（2026-09-18）：群里除了她，别人的 id 不会配进白名单，
   * 按人认就是人人 unknown、整条被挡 —— 她在全家群说句话他都收不到。
   * 谁说的不靠身份传，靠正文里的发言人前缀（群闸批量渲染时写进去）。
   *
   * ⚠️ **命令绝不能用这个身份来放行**：群轮的身份是群，拿它当门票等于
   * 群里随便谁一句 `/new` 就能换他的舱。命令一律认 `resolveIdentity` 那个人。
   */
  identityForTurn(delivery) {
    const person = this.resolveIdentity(delivery);
    if (person !== "unknown") return person;
    if (delivery.chatType && delivery.chatType !== "private") {
      const gkey = delivery.channel + ":group:" + (delivery.chatId || "");
      if (this.identities[gkey]) return this.identities[gkey];
    }
    return "unknown";
  }

  /**
   * 插件交付一条消息。渠道标识由闸认定，插件不能自己起名（§0.1）。
   * @returns {{accepted:boolean, event:object, duplicate:boolean, injected:string|null}}
   */
  accept(delivery) {
    if (!delivery || !delivery.channel) {
      throw new Error("交付缺少 channel");
    }
    const verdict = verifyInbound(delivery);
    // 群轮挂在群名下，私聊挂在人名下 —— 见 identityForTurn 的注释
    const identity = this.identityForTurn(delivery);

    const { event, duplicate } = this.store.registerInbound({ ...delivery, identity }, verdict);

    // 未知身份不投给他 —— 宁可停在这儿报配置故障，也不能把别人的话标成她的。
    // 现网反面教材：bridge.js 硬写 from_is_alice="true"，白名单一丢就冒认。
    if (event.identity === "unknown") {
      this.store.appendEvent({
        kind: "inbound.blocked",
        reason: "unknown_identity",
        eventId: event.eventId,
        channel: delivery.channel,
        senderId: delivery.senderId || "",
      });
      return { accepted: false, event, duplicate, injected: null };
    }

    // ==== 编号在「投递给他」这一刻分配（Alice 2026-09-17 定）====
    // 冷层 id 先算出来挂到事件上，`assignSeqOnDeliver` 落日志时一起写进去 ——
    // 日志不复制正文，靠这个 id 指回冷层那一条（SPEC §6「两份，用 id 串」）。
    const coldId = "cold-" + event.eventId + "-user";
    event.coldId = coldId;
    const seq = this.store.assignSeqOnDeliver(event, this.sequenceScope);

    // ==== 唯一冷层写手。只有四个字段，技术字段全在上面那条日志里。 ====
    this.cold.write({ recordId: coldId, role: "user", ev: event });

    // Retrying after a partial write fills the missing cold record with the same
    // id. The pipeline's durable task state decides whether to call the box.
    return { accepted: true, event, duplicate, injected: this.renderForModel(event, seq) };
  }

  /**
   * 交给 CLI 的样子。号作为元数据附在原文旁，不改写原文。
   * 验收未过的正文不冒充她的话。
   */
  renderForModel(event, seq) {
    // ⚠️ 2026-09-17：原来只给 undecoded 兜底，no_content 走到 ColdBody 返回空串，
    // 投到他眼前就是「原文：」后面一片空白 —— 空白比明说更危险，他会自己脑补。
    // 影子第一夜 1633 条 TG 全是这个形态（驱动取错字段），一条都没被拦住。
    let body;
    if (event.verdict === "undecoded") {
      body = "[未解码内容：插件交付的正文无法读取，原件已留在事件账本 " + event.eventId + "]";
    } else if (event.verdict === "no_content") {
      body = "[空事件：既无正文也无媒体，多半是上游取值出错。**不要当成她说了什么**，"
           + "更不要猜她想说什么。账本 " + event.eventId + "]";
    } else {
      body = ColdBody(event);
    }
    return [
      "#" + seq,
      "来源：" + event.channel,
      "原文：" + body,
    ].join("\n");
  }
}

function ColdBody(event) {
  const media = Array.isArray(event.media) ? event.media : [];
  if (!event.text && media.length) {
    return media.map(mediaLine).join(" ");
  }
  return event.text || "";
}

/**
 * 一件媒体投给他的那一行。
 *
 * ⚠️ 2026-09-17：原来这儿写死 `[图片]` / `[voice]`，**加工层做完的活全丢在半路**——
 * 微信图片解密解出来了、语音 SILK 转写出来了，到他眼前还是一个光秃秃的标签。
 * 现在的规矩：**加工层（闸外）把"他能读的一段话"放在 `text` 里，闸就用它，闸自己不造。**
 * 加工层没给（没接线、取不到字节），才退回标签 —— 退回去也是标签，不是空白。
 */
function mediaLine(m) {
  if (m && typeof m.text === "string" && m.text) return m.text;
  return (m && m.kind) === "image" ? "[图片]" : "[" + ((m && m.kind) || "media") + "]";
}

module.exports = { InboundGate, mediaLine };
