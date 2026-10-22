"use strict";

/**
 * 信封 —— 统一消息格式（2026-09-18，Alice定，见 docs/SPEC.md §3）
 *
 * **所有**进出盒子的东西都长这样：她说的、晨笺推的、check-in 触发的、他回的，
 * 一个结构。来路是**结构里的字段**，不是正文里的一行字。
 *
 * 为什么非这样不可（三件真事，根子都是「靠读正文猜来路」）：
 *   · 8-29 她在 TG 说话，他回到微信去了 —— 状态条把 `<channel …>` 那行标签顶下去，
 *     投递层就猜不着这轮从哪来
 *   · 7 月那批「她没发过的消息」 —— 系统注入和她的话在同一条文字流里，他分不清
 *   · 9-17 差点栽：有的腿的 id 带 `telegram:` 前缀、有的不带，拿去调平台接口必然失败
 *
 * 前面贴多少东西都顶不掉一个字段。
 */

/** 落盘的记录才带版本号（冷层里躺着四万八千条，今天写的三个月后还要读）。 */
const SCHEMA_VERSION = 1;

/**
 * 这一轮打哪来的，**只分三类**：
 *   user   她从某条渠道说的
 *   system 桥外面的东西推的（晨笺、提醒、身体状态…）—— **不是她说的话**
 *   box    盒子里那位说的（出站）
 *
 * ⚠️ 具体是「晨笺」还是「日记」还是「脉」，写在 `source.producer` 里，**桥不校验、
 * 不认识、也不许在代码里枚举**（铁律 2/3：桥里不出现任何工具名）。以后加一个新的
 * 产生者，桥一行不用改 —— 这正是「工具全部可拆卸」那条的落点。
 */
const KINDS = Object.freeze(["user", "system", "box"]);

/** 在对话里算谁说的：进盒子的是 user，出盒子的是 assistant。 */
const ROLES = Object.freeze(["user", "assistant"]);

/**
 * 验收结论。没过的正文**不许冒充她的话**。
 * ⚠️ 用词跟入闸（verify.js）**必须是同一套**：2026-09-18 第一版这儿写 "ok"、
 * 那边产出 "accepted"，主循环一串起来就炸 —— 两套词迟早各自往下漂。
 */
const VERDICTS = Object.freeze(["accepted", "undecoded", "no_content"]);

function nowIso() { return new Date().toISOString(); }

/**
 * 造一个信封。缺的当场说清楚缺哪样 —— 不许默默填一个默认值糊过去。
 *
 * @param {object} o
 * @param {string} o.trace_id      一条消息的身份证，贯穿入站→盒子→出站
 * @param {string} [o.role]        user（进盒子）/ assistant（出盒子），默认 user
 * @param {object} o.source        { kind, producer, platform, chat_id, sender_id, native_id }
 *   kind 只有三类（user/system/box）；producer 是自由文本，桥不认识它的值
 * @param {object} [o.target]      { person, platform, chat_id, policy } —— 路由解析出来的落点
 * @param {object} o.payload       { text, media[] }
 * @param {string} [o.identity]    认出来是谁；认不出就是 unknown（**不投递**）
 * @param {string} [o.verdict]
 * @param {string[]} [o.processing] 做过哪些加工：none/decrypted/transcribed/vision/acoustic
 * @param {number|null} [o.seq]    编号，闸在「投递给他」那一刻发
 * @param {object} [o.cold]        { write:boolean, text?:string } 这条进不进冷层、进的时候正文长什么样
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
      // 谁推的（晨笺/提醒/…）。自由文本，桥只原样带着走。
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
 * 体检。挡住的都是**一定错**的，不是口味问题。
 */
function assertEnvelope(e) {
  if (!e || typeof e !== "object") throw new Error("信封不是个对象");
  if (!String(e.trace_id || "").trim()) throw new Error("信封没有 trace_id —— 出了事就查不到它卡在哪");
  if (!ROLES.includes(e.role)) throw new Error("信封的 role 只能是 " + ROLES.join(" / ") + "，拿到的是 " + e.role);
  if (!e.source || !KINDS.includes(e.source.kind)) {
    throw new Error("信封要说清楚这一轮打哪来（source.kind 只有 " + KINDS.join(" / ") + "）");
  }
  if (!VERDICTS.includes(e.verdict)) throw new Error("verdict 只能是 " + VERDICTS.join(" / "));
  // 真实渠道来的必须带平台身份 —— **绝不用昵称认人**（昵称可改、可重名，
  // 而采集器会把每一行都硬标成同一个昵称，等于谁说的都算她说的）。
  if (e.source.kind === "user" && !String(e.source.sender_id || "").trim()) {
    throw new Error("她发来的这一轮没有 sender_id —— 认不出人就不许投递，绝不硬填成她");
  }
  const hasText = String(e.payload && e.payload.text || "").trim().length > 0;
  const hasMedia = Array.isArray(e.payload && e.payload.media) && e.payload.media.length > 0;
  // 空轮不许进盒子：他会自己脑补她说了什么（7 月那批幻觉入站就是这么来的）。
  // 但**验收没过**的那种可以空 —— 那种要照实告诉他「这是一条读不出来的消息」。
  if (!hasText && !hasMedia && e.verdict === "accepted") {
    throw new Error("空轮（既没正文也没媒体）—— 要么是上游取值出错，要么该标 no_content");
  }
  return e;
}

/**
 * 落盘形状（日志用）。**带版本号，不带正文。**
 *
 * 正文只在冷层有一份（`forCold`），这里只放指向它的 id ——
 * 两份都存正文的话，改一份另一份就不一致了，而且日志会白白大一圈。
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
    /** 指向冷层那一条；正文去那儿取 */
    cold_id: e.cold && e.cold.write === false ? null : coldId(e),
    ...extra,
  };
}

/** 冷层记录的 id，日志靠它指过去。 */
function coldId(e) {
  return "cold-" + e.trace_id + "-" + e.role;
}

/**
 * 纯冷层形状 —— **只有四样，一个字段都不许加**（铁律 4）。
 *
 * 这份是给他查记忆、给 forge 塞回会话文件用的。混进技术字段，forge 就得先剥一遍；
 * 剥不干净，他上下文里就会冒出 `schema_version: 1` 这种噪音。
 * 「这条没发出去」之类的标记一律进日志（`forLog`），**不写进正文**。
 */
function forCold(e) {
  return {
    id: coldId(e),
    role: e.role,
    at: e.created_at,
    text: e.cold && e.cold.text != null ? String(e.cold.text) : e.payload.text,
  };
}

/** 冷层记录允许出现的字段，就这四个。测试拿它当守卫。 */
const COLD_FIELDS = Object.freeze(["id", "role", "at", "text"]);

module.exports = {
  SCHEMA_VERSION, KINDS, ROLES, VERDICTS, COLD_FIELDS,
  makeEnvelope, assertEnvelope, forLog, forCold, coldId,
};
