"use strict";

const crypto = require("crypto");
const { precheck, INTENT_NEEDS, hasSuppliedFile } = require("./capabilities");
const { Outbox } = require("./outbox");

const ARTIFACT_RULES = [
  { name: "user_tag", re: /\buser\s*<\s*[a-z_-]+/i, why: "user 紧跟标签" },
  { name: "user_role", re: /\buser\s*[:：]/i, why: "user 紧跟冒号" },
  { name: "user_bracket", re: /\buser\s*【/i, why: "user 紧跟方括号" },
  { name: "user_trailing", re: /\buser\s*$/i, why: "user 孤零零挂在正文末尾" },
];

/**
 * 他续写的**假入站**长什么样（2026-09-19 从生产抓的真样本）：
 *
 * ```
 *   …正文正文正文
 *   user<channel source="wechat" chat_id="…" message_id="…:2594" ts="…">
 *   70？我觉得951 你在教我做事？
 *   </channel>
 * ```
 *
 * 9-18 15:17 那条：编号 2594 **在事件账本里根本不存在**，她没发过。
 * 而他下一步就照着自己编的那句回了一条语音 —— 这就是 7-25 那批幻觉入站的成因
 * （他分不清上下文里哪段是自己写的、哪段是她说的，见 CLAUDE.md「她的话只能来自她」）。
 *
 * **只认这一种形状**（`user` 紧跟 `<channel`）——判据窄是故意的：
 * 他跟她聊技术时正文里出现 `user:` 是常事，宽了就会把正经话拦腰砍断。
 * 其余几条规则照旧只记一笔（`ARTIFACT_RULES`），不动正文。
 */
//
// 2026-09-21 夜：判据搬进 src/core/hallucination-cut.js（盒子 / 出闸 / forge 共用一份），
// 顺手认第二种形状 —— 把工具调用写成正文（`action\n<invoke name="…">…`）。
// **发给她的照旧是原文**（下面 #deliver 那段），切过的只进冷层。
const { cutHallucinatedTail, FORGED_INBOUND_RE } = require("../core/hallucination-cut");

/**
 * 只认形状 1（假入站）的老口子，留着给外面的调用方；新代码用 `cutHallucinatedTail`。
 * @returns {{text:string, cut:string}} cut 非空 = 命中
 */
function cutForgedInbound(text) {
  const s = String(text || "");
  const m = FORGED_INBOUND_RE.exec(s);
  if (!m) return { text: s, cut: "" };
  return { text: s.slice(0, m.index).trimEnd(), cut: s.slice(m.index) };
}

function scanArtifacts(text) {
  const hits = [];
  for (const r of ARTIFACT_RULES) {
    const m = r.re.exec(String(text || ""));
    if (m) hits.push({ rule: r.name, why: r.why, at: m.index, fragment: m[0] });
  }
  return hits;
}

function findSeqReferences(text) {
  const out = [];
  const re = /(?:^|[\s，,。、（(])#(\d{1,6})(?![\d%])/g;
  let m;
  while ((m = re.exec(String(text || "")))) out.push(Number(m[1]));
  return out;
}

function uniqueId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${process.pid}-${crypto.randomUUID()}`;
}

function receiptOf(value) {
  if (value && typeof value === "object") return { receipt: value, nativeId: value.nativeId };
  return { receipt: value, nativeId: value == null ? undefined : String(value) };
}

class OutboundGate {
  constructor({ store, cold, plugins, undelivered = null, caps = null, sequenceScope = "alice",
    segmenter = null, sendGapMs = 700, sendGapByChannel = {}, outbox = null }) {
    this.store = store;
    this.cold = cold;
    this.plugins = plugins;
    this.undelivered = undelivered;
    this.caps = caps;
    this.sequenceScope = sequenceScope;
    this.segmenter = segmenter;
    this.sendGapMs = sendGapMs;
    // 段间间隔可以按渠道覆盖，值可以是定值（数字）或随机区间 {min,max}。
    // 2026-09-20 微信因 Frida 被处罚后，她要微信段间随机 1~3 秒（0.7 秒定值太机器）——
    // 但别动 Telegram/iMessage，它们没这问题。所以做成每渠道覆盖，默认全不变。
    this.sendGapByChannel = sendGapByChannel || {};
    this.outbox = outbox || new Outbox({ root: store.root, store, undelivered });
    this.outbox.attachUndelivered?.(undelivered);
    this._tail = Promise.resolve();
  }

  /** 这个渠道两段之间等多久。定值直接返回；随机区间就在 [min,max] 里掷一个。 */
  #gapFor(channel) {
    const g = this.sendGapByChannel[channel];
    const spec = g === undefined ? this.sendGapMs : g;
    if (spec && typeof spec === "object") {
      const min = Number(spec.min) || 0;
      const max = Number(spec.max) || min;
      if (max <= min) return min;
      return Math.round(min + Math.random() * (max - min));
    }
    return Number(spec) || 0;
  }

  resolveTarget(turn) {
    if (turn && turn.replyToEventId) {
      const ev = turn.inboundEvent;
      if (ev && ev.channel) return { ok: true, channel: ev.channel, chatId: ev.chatId, accountId: ev.accountId, basis: "reply_to_inbound" };
      return { ok: false, reason: "reply_target_missing", basis: "reply_to_inbound" };
    }
    const d = this.defaultTarget;
    if (!d) return { ok: false, reason: "proactive_target_not_configured", basis: "proactive" };
    return { ok: true, ...d, basis: "proactive_default" };
  }

  deliver(turn = {}) {
    const run = () => this.#deliver(turn);
    const result = this._tail.then(run, run);
    this._tail = result.catch(() => undefined);
    return result;
  }

  #identity(turn) {
    const hasOperation = turn.operationId != null && String(turn.operationId) !== "";
    const hasOutput = turn.outputId != null && String(turn.outputId) !== "";
    const outputId = hasOutput ? String(turn.outputId) : (hasOperation ? String(turn.operationId) : uniqueId("output"));
    const operationId = hasOperation ? String(turn.operationId) : outputId;
    return { outputId, operationId, explicit: hasOperation || hasOutput };
  }

  #coldId(turn, outputId, suffix = "assistant") { return String(turn.coldId || `cold-${outputId}-${suffix}`); }

  #payload({ turn, target, intent, text, notes, outputId, operationId, coldId }) {
    return {
      outputId, operationId, coldId, turnId: turn.turnId || "", intent, text,
      channel: target && target.channel || "", chatId: target && target.chatId || "", accountId: target && target.accountId || "",
      notes: notes || [], extras: turn.extras || {}, toolArgs: turn.toolArgs || {},
    };
  }

  #eventPayload(payload) {
    const { text, extras, toolArgs, ...meta } = payload;
    return { ...meta, payloadRef: { outputId: payload.outputId, operationId: payload.operationId, coldId: payload.coldId } };
  }

  #segmentMeta(segments) {
    return (segments || []).map(({ text, receipt, ...meta }) => meta);
  }

  /**
   * 这一条要不要进冷层。
   *
   * **冷层只装真实对话** —— 她说的话、他说的话。默认写；上游说不写才不写。
   *
   * 不该进的两类（2026-09-18 Alice：「不是模型真实回复不落冷层」）：
   *
   *   1. **桥自己的回执**（/status /help /model …）。`pipeline.js` 那行注释
   *      「命令不进盒子、不进对话冷层 —— 那不是跟他说的话」7 月就写了，
   *      但实现一直没跟上：命令回执照样走出闸、照样以 `role:"assistant"` 落库。
   *
   *   2. **运行时造的文本**（安全层拒答、API 报错）。9-18 京时 23:18 当场吃过：
   *      那句「API Error: … safeguards flagged …」以**他的身份**躺进了冷层。
   *      后果不是多一行脏数据 —— 换舱 / forge 会把冷层原话当**真实轮**塞回他的会话，
   *      等于给他造一段「我说过 API Error」的假记忆；而换舱本来是安全层黏连的解药
   *      （见记忆 `project-fable-guard`），药里就掺了病。
   *
   * **判断不在这儿做。** 认 `<synthetic>` 是 claude 特有的知识，桥不认识 claude
   * （铁律 3）—— 上游把结论写进 `turn.cold.write`，闸只负责执行 + 留痕。
   *
   * 跳过的**一定要留痕**：正文进事件账本，不进冷层。悄悄丢是最坏的
   * （跟投递层「不许让他以为发了」同一条规矩）。
   */
  #writeCold(coldId, text, turn = null) {
    const cold = turn && turn.cold;
    if (cold && cold.write === false) {
      this.store.appendEvent({
        kind: "cold.skipped",
        coldId,
        turnId: (turn && turn.turnId) || "",
        reason: cold.reason || "not_a_real_reply",
        text: text || "",
      });
      return { written: false, id: coldId, skipped: true };
    }
    // 2026-09-21 夜：他正文尾巴上的续写幻觉（假入站 / 文字工具调用）**不进冷层**。
    // 那晚这些尾巴进了冷层 → 换舱 forge 把它们当他说过的话塞回新舱 → 新舱照着学，
    // 每轮都炸「tool call could not be parsed」。发给她的那份不动（照发，只留痕），
    // 这里只是冷层存切过的；原文在出闸账本（outbox 的 payload）里，事件里再留个尾巴预览。
    const clean = cutHallucinatedTail(text || "");
    if (clean.cut && !clean.text.trim()) {
      // 整条都是幻觉 —— 那不是他的话，跟上面「不是真实回复」同一个处理：不落冷层，留痕
      this.store.appendEvent({ kind: "cold.skipped", coldId, turnId: (turn && turn.turnId) || "",
        reason: "hallucination_only", hallucination: clean.kind, text: text || "" });
      return { written: false, id: coldId, skipped: true };
    }
    const r = this.cold.write({ recordId: coldId, role: "assistant", text: clean.cut ? clean.text : (text || "") });
    if (clean.cut && r && r.written) {
      this.store.appendEvent({ kind: "cold.hallucination_cut", coldId, turnId: (turn && turn.turnId) || "",
        hallucination: clean.kind, cut: clean.cut.length, preview: clean.cut.slice(0, 200) });
    }
    return r;
  }

  #note(state, op, reason = "") {
    this.undelivered?.note({ state, operationId: op.operationId, outputId: op.outputId, coldId: op.coldId, turnId: op.turnId,
      intent: op.payload && op.payload.intent, channel: op.payload && op.payload.channel, chatId: op.payload && op.payload.chatId,
      text: op.payload && op.payload.text, reason: reason || op.reason || "", segments: op.segments });
  }

  #resultFor(op) {
    return op.result || { outcome: op.state === "sent" ? "sent" : "failed", operationId: op.operationId, outputId: op.outputId,
      state: op.state, reason: op.reason, channel: op.payload && op.payload.channel, notes: op.payload && op.payload.notes || [] };
  }

  #existing(opId, identity, requestedText, requestedIntent, turn) {
    const op = this.outbox.get(opId);
    if (!op) return null;
    if (identity.explicit && op.payload) {
      const requestedChannel = turn && turn.inboundEvent && turn.inboundEvent.channel;
      const requestedChatId = turn && turn.inboundEvent && turn.inboundEvent.chatId;
      if ((requestedText != null && op.payload.text !== requestedText)
        || (requestedIntent && op.payload.intent !== requestedIntent)
        || (op.payload.channel && requestedChannel && op.payload.channel !== requestedChannel)
        || (op.payload.chatId && requestedChatId && String(op.payload.chatId) !== String(requestedChatId))) {
        return { outcome: "blocked", reason: "operation_conflict", operationId: op.operationId, outputId: op.outputId };
      }
    }
    if (op.state === "sent" || op.state === "unknown"
      || (Array.isArray(op.segments) && op.segments.some((s) => s.state === "unknown"))) return this.#resultFor(op);
    if (!identity.explicit) return this.#resultFor(op);
    return null;
  }

  async #deliver(turn) {
    const text = String(turn.text || "").trim();
    // ⚠️ **正文一个字都不改写**（Alice的方针：不加闸，症状留可见）。
    // 2026-09-19 我写过一版"砍掉假入站再发"，被 `test/gate/e2e.js` 的
    // 「外发的是原文，没被改写」当场挡下 —— 那条断言就是这个决定本身。
    // 判据（`cutForgedInbound`）留着**只用来看见**：下面 notes 里记一笔、日志喊一声，
    // 但发出去的还是他写的原样。要不要改成截断，是她拍板的事，不是我顺手改的。
    //
    // 2026-09-21 夜加：认第二种形状（文字工具调用），另记 `outbound.text_tool_call_seen`。
    // 发出去的**仍是原文**；切过的那份只进冷层（见 #writeCold）。
    const forged = cutHallucinatedTail(text);
    // 2026-10-16 keeper：试过把过滤网也接到「发给她」这条路，Alice当场否了——
    //「不要剪掉 我要看到他的幻觉我才方便判断」。所以发给她的照旧是原文（她的诊断信号），
    // 过滤网仍只用来清冷层（#writeCold 内部那份）。保留 forged 只为下面记一笔、看得见。
    if (forged.kind === "forged_inbound") {
      this.store.appendEvent({ kind: "outbound.forged_inbound_seen", turnId: turn.turnId || "",
        cut: forged.cut.length, preview: forged.cut.slice(0, 200) });
      console.log("[出闸] ⚠️ 这一轮正文里带了他自己续写的假入站（照发，只留痕）："
        + JSON.stringify(forged.cut.slice(0, 120)));
    } else if (forged.kind === "text_tool_call") {
      this.store.appendEvent({ kind: "outbound.text_tool_call_seen", turnId: turn.turnId || "",
        cut: forged.cut.length, preview: forged.cut.slice(0, 200) });
      console.log("[出闸] ⚠️ 这一轮正文里带了他写成文字的工具调用（照发，只留痕）："
        + JSON.stringify(forged.cut.slice(0, 120)));
    }
    const intent = turn.intent || "send_text";
    const identity = this.#identity(turn);
    const existing = this.#existing(identity.operationId, identity, text, intent, turn);
    if (existing) return existing;

    if (!text && intent === "send_text") {
      const coldId = this.#coldId(turn, identity.outputId, "silent");
      this.store.appendEvent({ kind: "turn.silent", turnId: turn.turnId, outputId: identity.outputId, operationId: identity.operationId, coldId });
      this.#writeCold(coldId, "[本轮未回复]", turn);
      return { outcome: "silent", outputId: identity.outputId, operationId: identity.operationId };
    }

    const artifacts = scanArtifacts(text);
    const refs = findSeqReferences(text);
    const refChecks = refs.map((seq) => {
      const ev = this.store.findBySeq(this.sequenceScope, seq);
      return ev ? { seq, status: "found", eventId: ev.eventId, originalText: ev.text } : { seq, status: "no_source" };
    });
    const notes = [...(turn.extraNotes || []), ...artifacts.map((a) => ({ type: "artifact", ...a }))];
    if (forged.cut) notes.push({ type: forged.kind, chars: forged.cut.length });
    for (const c of refChecks) if (c.status === "no_source") notes.push({ type: "reference_unverified", seq: c.seq });

    const target = this.resolveTarget(turn);
    const coldId = this.#coldId(turn, identity.outputId);
    if (!target.ok) {
      const payload = this.#payload({ turn, target: null, intent, text, notes, ...identity, coldId });
      const op = this.outbox.create({ ...identity, turnId: turn.turnId || "", coldId, payload, state: "blocked", segments: [], createdAt: new Date().toISOString(), reason: target.reason });
      this.#writeCold(coldId, text, turn);
      this.store.appendEvent({ kind: "outbound.blocked", ...this.#eventPayload(payload), reason: target.reason,
        notes: notes.concat([{ type: "undelivered", reason: target.reason }]) });
      this.#note("blocked", op, target.reason);
      return { outcome: "blocked", reason: target.reason, notes, operationId: identity.operationId, outputId: identity.outputId };
    }

    const plugin = this.plugins.get(target.channel);
    const pre = precheck({ intent, plugin, caps: this.caps, hasSuppliedFile: hasSuppliedFile(turn) });
    if (!pre.ok) {
      const payload = this.#payload({ turn, target, intent, text, notes, ...identity, coldId });
      const op = this.outbox.create({ ...identity, turnId: turn.turnId || "", coldId, payload, state: "blocked", segments: [], createdAt: new Date().toISOString(), reason: pre.reason });
      this.#writeCold(coldId, text, turn);
      this.store.appendEvent({ kind: "outbound.blocked", ...this.#eventPayload(payload), reason: pre.reason, detail: pre.detail || null,
        notes: notes.concat([{ type: "undelivered", reason: pre.reason, intent }]) });
      this.#note("blocked", op, pre.reason);
      return { outcome: "blocked", reason: pre.reason, intent, detail: pre.detail || null, notes, operationId: identity.operationId, outputId: identity.outputId };
    }

    const bubbles = intent === "send_text" && this.segmenter ? this.segmenter.segment(text) : [];
    const segmentTexts = bubbles.length ? bubbles : [text];
    const payload = this.#payload({ turn, target, intent, text, notes, ...identity, coldId });
    let op = this.outbox.get(identity.operationId);
    if (!op) {
      op = this.outbox.create({ ...identity, turnId: turn.turnId || "", coldId, payload, state: "running", createdAt: new Date().toISOString(),
        segments: segmentTexts.map((value, index) => ({ index, text: value, operationId: segmentTexts.length > 1 ? `${identity.operationId}-${index + 1}` : identity.operationId, state: "pending" })) });
    } else if (op.state === "blocked" && (!Array.isArray(op.segments) || op.segments.length === 0)) {
      // A blocked operation has never touched the platform.  If an explicit
      // retry now has a usable target/capability, install its durable plan
      // before sending it.
      op = this.outbox.update(op.operationId, {
        payload, coldId,
        segments: segmentTexts.map((value, index) => ({ index, text: value, operationId: segmentTexts.length > 1 ? `${identity.operationId}-${index + 1}` : identity.operationId, state: "pending" })),
      });
    }
    const segments = op.segments || [];
    this.#writeCold(op.coldId || coldId, text, turn);
    this.store.appendEvent({ kind: "outbound.submitted", ...this.#eventPayload(payload), state: "submitted", segments: this.#segmentMeta(segments) });
    op = this.outbox.update(op.operationId, { state: "submitted", payload, segments });

    let asset = null;
    // **他已经给了文件就别再造一个**（2026-09-19，Alice：「把发图片接上」）。
    // `send_image` 的 intent 是 `send_generated_image`，所以发一张本机已有的图
    // 原来也会被拖去生图，炸在「generate_image 要有提示词」——
    // 生产账本里两条 outbound.unknown 就是这么来的。他明明把图递进来了。
    const supplied = hasSuppliedFile(turn);
    const need = supplied ? null : INTENT_NEEDS[intent];
    if (supplied && INTENT_NEEDS[intent]) {
      this.store.appendEvent({ kind: "capability.skipped", capability: INTENT_NEEDS[intent], intent,
        why: "调用方已经给了文件", operationId: op.operationId, outputId: op.outputId });
    }
    if (need) {
      try {
        if (Object.prototype.hasOwnProperty.call(op, "asset")) asset = op.asset;
        else asset = await this.caps.call(need, { text, turnId: turn.turnId });
        if (!Object.prototype.hasOwnProperty.call(op, "asset")) op = this.outbox.update(op.operationId, { asset });
        this.store.appendEvent({ kind: "capability.used", capability: need, intent, operationId: op.operationId, outputId: op.outputId });
      } catch (e) {
        const reason = String((e && e.message) || e);
        // Generation may have reached an external service before failing. It
        // is therefore unknown and must never be blindly rebilled on retry.
        op = this.outbox.update(op.operationId, { state: "unknown", reason: "capability_failed: " + reason });
        this.store.appendEvent({ kind: "outbound.unknown", ...this.#eventPayload(payload), capability: need, operationId: op.operationId, outputId: op.outputId, error: reason });
        this.#note("unknown", op, reason);
        return { outcome: "failed", reason: "capability_failed", operationId: op.operationId, outputId: op.outputId, state: "unknown", intent, notes };
      }
    }

    const sentIds = [];
    let failure = null;
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      if (seg.state === "sent" || seg.state === "unknown") { if (seg.nativeId != null) sentIds.push(seg.nativeId); continue; }
      op = this.outbox.updateSegment(op.operationId, i, { state: "running", startedAt: new Date().toISOString() });
      try {
        const raw = await plugin.send({ operationId: seg.operationId, chatId: target.chatId, text: seg.text, notes: i === 0 ? notes : [], intent, asset,
          extras: turn.extras || {}, toolArgs: turn.toolArgs || {} });
        const got = receiptOf(raw);
        op = this.outbox.updateSegment(op.operationId, i, { state: "sent", nativeId: got.nativeId, receipt: got.receipt, completedAt: new Date().toISOString() });
        if (got.nativeId != null) sentIds.push(got.nativeId);
      } catch (e) {
        const reason = String((e && e.message) || e);
        const state = e && e.notSent ? "not_sent" : "unknown";
        op = this.outbox.updateSegment(op.operationId, i, { state, error: reason, completedAt: new Date().toISOString() });
        failure = { state, reason, index: i };
        break;
      }
      if (i < segments.length - 1) {
        const gap = this.#gapFor(target.channel);
        if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap));
      }
    }

    const states = op.segments.map((s) => s.state);
    if (failure) {
      const anySent = states.includes("sent");
      const anyUnknown = states.includes("unknown");
      const finalState = anyUnknown ? "unknown" : (anySent ? "partial" : (states.every((s) => s === "not_sent") ? "not_sent" : "partial"));
      const result = { outcome: "failed", operationId: op.operationId, outputId: op.outputId, state: finalState, reason: failure.reason, intent, notes,
        ...(sentIds.length ? { nativeIds: sentIds } : {}) };
      op = this.outbox.update(op.operationId, { state: finalState, reason: failure.reason, result });
      this.store.appendEvent({ kind: `outbound.${finalState}`, ...this.#eventPayload(payload), operationId: op.operationId, outputId: op.outputId, coldId: op.coldId,
        error: failure.reason, segments: this.#segmentMeta(op.segments), notes: notes.concat([{ type: finalState, reason: failure.reason, intent }]) });
      this.#note(finalState, op, failure.reason);
      return result;
    }

    const result = { outcome: "sent", operationId: op.operationId, outputId: op.outputId, channel: target.channel, notes, refChecks,
      nativeId: sentIds[0], nativeIds: sentIds, bubbles: segments.length };
    op = this.outbox.update(op.operationId, { state: "sent", result, completedAt: new Date().toISOString() });
    this.undelivered?.resolve({ operationId: op.operationId, outputId: op.outputId, turnId: op.turnId, coldId: op.coldId });
    this.store.appendEvent({ kind: "outbound.confirmed", ...this.#eventPayload(payload), operationId: op.operationId, outputId: op.outputId, coldId: op.coldId,
      nativeId: sentIds[0], nativeIds: sentIds, bubbles: segments.length, segments: this.#segmentMeta(op.segments), notes: notes.length ? notes : undefined });
    return result;
  }
}

module.exports = { OutboundGate, scanArtifacts, findSeqReferences, cutForgedInbound };
