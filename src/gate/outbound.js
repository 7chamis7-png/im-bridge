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
 * Detecting a hallucinated inbound continuation appended by the model:
 *
 * ```
 *   ...reply text
 *   user<channel source="wechat" chat_id="…" message_id="…:2594" ts="…">
 *   (text the owner never sent)
 *   </channel>
 * ```
 *
 * The model sometimes continues past its own reply and invents the next user message
 * (the referenced message id doesn't exist in the event ledger). Left in the cold layer,
 * such text would later be replayed as if the owner had said it.
 *
 * Only this exact shape is recognized (`user` immediately followed by `<channel`). The narrow
 * rule is intentional: `user:` appears legitimately in technical conversation.
 * The other rules (`ARTIFACT_RULES`) only record a note and never touch the body.
 *
 * The detector lives in src/core/hallucination-cut.js (shared by box and outbound gate) and also
 * recognizes a second shape: a tool call written as plain text (`action\n<invoke name="…">…`).
 * What is sent to the owner is always the original text; only the cold layer stores the cut version.
 */
const { cutHallucinatedTail, FORGED_INBOUND_RE } = require("../core/hallucination-cut");

/**
 * Legacy helper recognizing shape 1 (forged inbound) only; new code uses `cutHallucinatedTail`.
 * @returns {{text:string, cut:string}} non-empty cut = matched
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
  constructor({ store, cold, plugins, undelivered = null, caps = null, sequenceScope = "owner",
    segmenter = null, sendGapMs = 700, sendGapByChannel = {}, outbox = null }) {
    this.store = store;
    this.cold = cold;
    this.plugins = plugins;
    this.undelivered = undelivered;
    this.caps = caps;
    this.sequenceScope = sequenceScope;
    this.segmenter = segmenter;
    this.sendGapMs = sendGapMs;
    // Inter-bubble delay can be overridden per channel: a fixed number or a random range {min,max}
    // (a fixed short gap looks robotic on some platforms). Defaults are unchanged for other channels.
    this.sendGapByChannel = sendGapByChannel || {};
    this.outbox = outbox || new Outbox({ root: store.root, store, undelivered });
    this.outbox.attachUndelivered?.(undelivered);
    this._tail = Promise.resolve();
  }

  /** Delay between two bubbles on this channel: fixed value, or a random pick in [min,max]. */
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
   * Should this message go into the cold layer?
   *
   * The cold layer holds real conversation only — what the owner said and what the agent said.
   * Written by default; skipped only if upstream says so. Two kinds must not go in:
   *
   *   1. The bridge's own receipts (/status /help /model ...): not conversation.
   *   2. Runtime-generated text (safety refusals, API errors). Cold records may later be
   *      replayed into a new session as real turns; such text would become a false memory
   *      of the agent having said "API Error".
   *
   * The decision is not made here: recognizing `<synthetic>` is backend-specific knowledge.
   * Upstream writes its verdict into `turn.cold.write`; the gate executes and records it.
   *
   * Skips are always traced: the body goes to the event ledger instead. Silently dropping is worst.
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
    // Hallucinated tails (forged inbound / text tool calls) are kept out of the cold layer:
    // if replayed into a new session, the model would learn to imitate them. The copy sent to
    // the owner is untouched; the cold layer stores the cut text, the original stays in the
    // outbox payload, and the event gets a preview of the tail.
    const clean = cutHallucinatedTail(text || "");
    if (clean.cut && !clean.text.trim()) {
      // Entirely hallucinated — not a real reply: same handling as above (skip, but trace).
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
    // The outgoing text is never rewritten (policy: keep symptoms visible). The detector is
    // used only to observe: a note + a log line, while the original is sent as written
    // (test/gate/e2e.js asserts "the outgoing text is the original").
    // Second shape (text tool call) is recorded as `outbound.text_tool_call_seen`; the cut
    // version only goes into the cold layer (see #writeCold).
    const forged = cutHallucinatedTail(text);
    if (forged.kind === "forged_inbound") {
      this.store.appendEvent({ kind: "outbound.forged_inbound_seen", turnId: turn.turnId || "",
        cut: forged.cut.length, preview: forged.cut.slice(0, 200) });
      console.log("[出闸] ⚠️ 这一轮正文里带了 agent 自己续写的假入站（照发，只留痕）："
        + JSON.stringify(forged.cut.slice(0, 120)));
    } else if (forged.kind === "text_tool_call") {
      this.store.appendEvent({ kind: "outbound.text_tool_call_seen", turnId: turn.turnId || "",
        cut: forged.cut.length, preview: forged.cut.slice(0, 200) });
      console.log("[出闸] ⚠️ 这一轮正文里带了 agent 写成文字的工具调用（照发，只留痕）："
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
    // If the caller already supplied a file, don't generate one. `send_image` uses the
    // `send_generated_image` intent, so an existing local image would otherwise be routed to
    // the image generator and fail with "a prompt is required".
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
