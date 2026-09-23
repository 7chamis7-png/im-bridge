"use strict";

/**
 * Inbound gate (SPEC v1.5 §0.1) — always the last step.
 *
 *   plugin: fetch from platform → decrypt → decompress → transcribe → [deliver]
 *                                                                      ↓
 *                                                                [inbound gate]  ← here
 *                          verify / resolve identity / assign sequence / write cold layer → hand to CLI
 *
 * The gate knows nothing about SQLCipher, zstd or speech models. It does exactly four things.
 */

const { verifyInbound } = require("./verify");
const { GateStore } = require("./store");
const { ColdWriter } = require("./cold-writer");

class InboundGate {
  /**
   * @param {object} opts
   * @param {GateStore} opts.store
   * @param {ColdWriter} opts.cold
   * @param {object} opts.identities  real platform ID → unified identity. Never identify people by nickname.
   * @param {string} opts.sequenceScope sequence domain: one owner↔agent stream shared across channels
   */
  constructor({ store, cold, identities = {}, sequenceScope = "owner" }) {
    this.store = store;
    this.cold = cold;
    this.identities = identities;
    this.sequenceScope = sequenceScope;
  }

  /**
   * Identity resolution: only configured real platform IDs; anything else is "unknown",
   * never defaulted to the owner.
   *
   * This answers "who is this person", not "whose turn is this". Most people in a group are
   * unknown by design; group turns are attributed by `identityForTurn`.
   */
  resolveIdentity(delivery) {
    const key = delivery.channel + ":" + (delivery.senderId || "");
    return this.identities[key] || this.identities[delivery.senderId] || "unknown";
  }

  /**
   * Whose turn is this. Private chat = the sender; group turn = the group
   * (config key `channel:group:<chatId>`).
   *
   * Group turns are attributed to the group because other members are not in the allowlist;
   * per-person resolution would block every group message. Who said what is carried by the
   * speaker prefix the group gate renders into the body.
   *
   * Never authorize commands with this identity: otherwise anyone in a group could run
   * `/new`. Commands always use the person from `resolveIdentity`.
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
   * A plugin delivers one message. The channel name is decided by the gate, not the plugin (§0.1).
   * @returns {{accepted:boolean, event:object, duplicate:boolean, injected:string|null}}
   */
  accept(delivery) {
    if (!delivery || !delivery.channel) {
      throw new Error("交付缺少 channel");
    }
    const verdict = verifyInbound(delivery);
    // group turns are attributed to the group, private ones to the person — see identityForTurn
    const identity = this.identityForTurn(delivery);

    const { event, duplicate } = this.store.registerInbound({ ...delivery, identity }, verdict);

    // Unknown identities are not delivered to the agent. Better to stop here and surface a
    // config problem than to attribute someone else's words to the owner.
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

    // ==== Sequence numbers are assigned at delivery time ====
    // The cold id is computed first and attached to the event; `assignSeqOnDeliver` logs it.
    // The log never copies the body — it points back to the cold record by id (SPEC §6).
    const coldId = "cold-" + event.eventId + "-user";
    event.coldId = coldId;
    const seq = this.store.assignSeqOnDeliver(event, this.sequenceScope);

    // ==== The single cold-layer writer. Four fields only; technical fields are in the log above. ====
    this.cold.write({ recordId: coldId, role: "user", ev: event });

    // Retrying after a partial write fills the missing cold record with the same
    // id. The pipeline's durable task state decides whether to call the box.
    return { accepted: true, event, duplicate, injected: this.renderForModel(event, seq) };
  }

  /**
   * What the CLI sees. The sequence number is metadata next to the original text, which is
   * never rewritten. Unverified bodies never pose as the owner's words.
   */
  renderForModel(event, seq) {
    // no_content must be stated explicitly: an empty body after "原文：" is more dangerous
    // than a clear marker, because the model would fill in the blank itself.
    let body;
    if (event.verdict === "undecoded") {
      body = "[未解码内容：插件交付的正文无法读取，原件已留在事件账本 " + event.eventId + "]";
    } else if (event.verdict === "no_content") {
      body = "[空事件：既无正文也无媒体，多半是上游取值出错。**不要当成 owner 说了什么**，"
           + "更不要猜 owner 想说什么。账本 " + event.eventId + "]";
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
 * The line shown to the agent for one media item.
 *
 * The processing layer (outside the gate) puts a readable description in `text`
 * (decrypted image path, voice transcript, ...); the gate uses it and never invents one.
 * Only when the processing layer produced nothing does it fall back to a label — a label,
 * never an empty string.
 */
function mediaLine(m) {
  if (m && typeof m.text === "string" && m.text) return m.text;
  return (m && m.kind) === "image" ? "[图片]" : "[" + ((m && m.kind) || "media") + "]";
}

module.exports = { InboundGate, mediaLine };
