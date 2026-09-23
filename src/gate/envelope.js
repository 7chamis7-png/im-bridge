"use strict";

/**
 * Envelope — the unified message format (SPEC §3).
 *
 * Everything entering or leaving the box has this shape: owner messages, producer pushes,
 * scheduled check-ins, agent replies. The origin is a structured field, never a line of text
 * inside the body.
 *
 * Why: guessing the origin by parsing the body breaks as soon as anything is prepended
 * (status lines pushing a `<channel ...>` tag down), system injections get mixed with user
 * text, and ID formats differ between legs (some prefixed with `telegram:`, some not).
 * Nothing prepended to a body can displace a field.
 */

/** Persisted records carry a schema version: what is written today must remain readable later. */
const SCHEMA_VERSION = 1;

/**
 * Where a turn comes from — exactly three kinds:
 *   user   the owner said it on some channel
 *   system pushed by something outside the bridge (scheduled notes, reminders, ...) — NOT the owner's words
 *   box    said by the agent inside the box (outbound)
 *
 * The concrete producer name goes into `source.producer`. The bridge never validates or
 * enumerates it (no tool names inside the bridge), so adding a producer needs no bridge change.
 */
const KINDS = Object.freeze(["user", "system", "box"]);

/** Conversation role: entering the box = user, leaving the box = assistant. */
const ROLES = Object.freeze(["user", "assistant"]);

/**
 * Verification verdicts. A body that did not pass must never pose as the owner's words.
 * The vocabulary must be identical to the inbound gate's (verify.js).
 */
const VERDICTS = Object.freeze(["accepted", "undecoded", "no_content"]);

function nowIso() { return new Date().toISOString(); }

/**
 * Build an envelope. Missing fields are reported explicitly — never papered over with defaults.
 *
 * @param {object} o
 * @param {string} o.trace_id      identity of one message, from inbound through box to outbound
 * @param {string} [o.role]        user (into the box) / assistant (out of the box), default user
 * @param {object} o.source        { kind, producer, platform, chat_id, sender_id, native_id }
 *   kind is one of user/system/box; producer is free text the bridge doesn't interpret
 * @param {object} [o.target]      { person, platform, chat_id, policy } — resolved destination
 * @param {object} o.payload       { text, media[] }
 * @param {string} [o.identity]    resolved identity; "unknown" is never delivered
 * @param {string} [o.verdict]
 * @param {string[]} [o.processing] processing applied: none/decrypted/transcribed/vision/acoustic
 * @param {number|null} [o.seq]    sequence number, assigned by the gate at delivery time
 * @param {object} [o.cold]        { write:boolean, text?:string } whether/how it goes into the cold layer
 */
function makeEnvelope({
  trace_id, role = "user", source, target = null, payload,
  identity = "unknown", verdict = "accepted", processing = ["none"],
  seq = null, cold = null, created_at = nowIso(),
} = {}) {
  const e = {
    trace_id: String(trace_id || "").trim(),
    role,
    created_at,
    seq,
    source: {
      kind: (source && source.kind) || "user",
      // who pushed it (free text, carried through unchanged)
      producer: (source && source.producer) || "",
      platform: (source && source.platform) || "",
      chat_id: (source && source.chat_id) || "",
      sender_id: (source && source.sender_id) || "",
      native_id: (source && source.native_id) || "",
    },
    target: target ? {
      person: target.person || "",
      platform: target.platform || "",
      chat_id: target.chat_id || "",
      policy: target.policy || "",
    } : null,
    identity,
    verdict,
    processing: Array.isArray(processing) && processing.length ? processing.slice() : ["none"],
    payload: {
      text: String((payload && payload.text) || ""),
      media: Array.isArray(payload && payload.media) ? payload.media.slice() : [],
    },
    cold: cold ? { write: cold.write !== false, text: cold.text } : { write: true },
  };
  assertEnvelope(e);
  return e;
}

/**
 * Validation. Only rejects things that are definitely wrong, not matters of taste.
 */
function assertEnvelope(e) {
  if (!e || typeof e !== "object") throw new Error("信封不是个对象");
  if (!String(e.trace_id || "").trim()) throw new Error("信封没有 trace_id —— 出了事就查不到它卡在哪");
  if (!ROLES.includes(e.role)) throw new Error("信封的 role 只能是 " + ROLES.join(" / ") + "，拿到的是 " + e.role);
  if (!e.source || !KINDS.includes(e.source.kind)) {
    throw new Error("信封要说清楚这一轮打哪来（source.kind 只有 " + KINDS.join(" / ") + "）");
  }
  if (!VERDICTS.includes(e.verdict)) throw new Error("verdict 只能是 " + VERDICTS.join(" / "));
  // Real-channel input must carry a platform identity. Never identify by nickname:
  // nicknames change and collide.
  if (e.source.kind === "user" && !String(e.source.sender_id || "").trim()) {
    throw new Error("这一轮用户消息没有 sender_id —— 认不出人就不许投递，绝不硬填成 owner");
  }
  const hasText = String(e.payload && e.payload.text || "").trim().length > 0;
  const hasMedia = Array.isArray(e.payload && e.payload.media) && e.payload.media.length > 0;
  // Empty turns must not enter the box: the model would invent what was said.
  // Failed-verification turns may be empty — they are rendered as "unreadable message".
  if (!hasText && !hasMedia && e.verdict === "accepted") {
    throw new Error("空轮（既没正文也没媒体）—— 要么是上游取值出错，要么该标 no_content");
  }
  return e;
}

/**
 * Persisted log shape: versioned, without the body.
 *
 * The body lives only in the cold layer (`forCold`); the log points to it by id. Storing the
 * body twice invites inconsistency and bloats the log.
 */
function forLog(e, extra = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    trace_id: e.trace_id,
    seq: e.seq,
    role: e.role,
    at: e.created_at,
    kind: e.source.kind,
    producer: e.source.producer,
    platform: e.source.platform,
    chat_id: e.source.chat_id,
    sender_id: e.source.sender_id,
    native_id: e.source.native_id,
    identity: e.identity,
    verdict: e.verdict,
    processing: e.processing,
    target: e.target,
    /** points to the cold record, which holds the body */
    cold_id: e.cold && e.cold.write === false ? null : coldId(e),
    ...extra,
  };
}

/** Cold record id; the log points to it. */
function coldId(e) {
  return "cold-" + e.trace_id + "-" + e.role;
}

/**
 * Pure cold-layer shape — exactly four fields, never more.
 *
 * Cold records are used for memory lookup and may be replayed into a new session; any
 * technical field would leak into the agent's context. Markers such as "not delivered" go
 * into the log (`forLog`), never into the body.
 */
function forCold(e) {
  return {
    id: coldId(e),
    role: e.role,
    at: e.created_at,
    text: e.cold && e.cold.text != null ? String(e.cold.text) : e.payload.text,
  };
}

/** The only fields allowed in a cold record. Tests use this as a guard. */
const COLD_FIELDS = Object.freeze(["id", "role", "at", "text"]);

module.exports = {
  SCHEMA_VERSION, KINDS, ROLES, VERDICTS, COLD_FIELDS,
  makeEnvelope, assertEnvelope, forLog, forCold, coldId,
};
