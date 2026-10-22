"use strict";

/**
 * 待处理总台 —— /pending 背后那张表（2026-10-22）
 *
 * 为什么要有它：代码审查（N1/N2/N3/N10）查出三处「她的话悬在半空、没人能处理」：
 *   · 轮次账本（turns.json）里的 unknown / rejected 轮：unknown 堵住整条队列，
 *     全仓没有一条命令能解；rejected 以前从来没人再捡。
 *   · 死信（dead-<渠道>.jsonl）：生产上 10-07 / 10-09 躺着她 4 句话，从来没被处理过。
 *   · 没送到的账（undelivered.jsonl）：「没发出去 / 不知道发没发」只有账，没人能重发或确认。
 *
 * 这里把三本账摆在一张表上，每条给一个**短编号**（类别字母 + 4 位，按内容算出来，
 * 两次 /pending 之间不会串号），她用 `/pending retry <编号>` / `/pending drop <编号>` 处理。
 *
 * 规矩（跟整座桥一样）：宁可明确地卡住告诉她，也不悄悄吞掉、不悄悄重发两遍。
 *   · unknown 的轮 / 不知道发没发的那条：**只有她按了才重来**，桥从不自己判。
 *   · 死信重投前先去重：这条平台消息已经登记过、而且轮次账本里有它的结论 → 不再投。
 *   · drop 只是「她确认不要了」，账上标终态，**不撒谎说「他回过了 / 她收到了」**。
 *
 * 死信文件本身只追加不删改（receiver.js 的规矩），处理过的另记在 `handled-dead-letters.jsonl`。
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { formatWhen } = require("./commands");

const short = (s, n = 20) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};
const hash = (key) => crypto.createHash("sha1").update(String(key)).digest("hex");

/** 死信原件里认得出的正文（TG 是 text/caption，别的插头多半是 text/content）。只用来给她看一眼。 */
function rawText(raw) {
  if (!raw || typeof raw !== "object") return String(raw || "");
  return String(raw.text || raw.caption || raw.content || raw.body || (raw.message && raw.message.text) || "");
}

function turnState(row, now) {
  if (row.state === "unknown") {
    return row.exhausted ? `拒收 ${row.attempts || "?"} 次，停了等你` : "卡住了（不知道他收没收）";
  }
  if (row.autoRetry && row.retryAt) {
    const at = Date.parse(row.retryAt);
    return `拒收，${Number.isFinite(at) && at > now ? formatWhen(row.retryAt) + " " : ""}自动重投（第 ${row.attempts || 1} 次）`;
  }
  return "拒收（旧账，不会自动重投）";
}

const UNDELIVERED_LABEL = { blocked: "没发出去", not_sent: "没发出去", unknown: "不知道发没发", partial: "发了一半" };

/**
 * @param {object} o
 * @param {object} o.queue          轮次队列（turn-queue.js）
 * @param {function} o.undelivered  () => 没送到的账（undelivered.js），可能是 null
 * @param {object} o.outbound       出闸（undelivered 重发走它，**发送逻辑一行不改**）
 * @param {object} o.router         路由（没落点的那条重发时找落点）
 * @param {object} o.plugins        渠道名 → 插头（死信原件 → 交付，拿 nativeId 去重）
 * @param {object} o.inboundStore   入闸的事件账本（GateStore）：查这条平台消息登记过没有；root 放 handled-dead-letters.jsonl
 * @param {function} o.deadLetters  () => Map<渠道, 死信>
 * @param {function} o.reingest     ({channel, raw}) => Promise —— 按原件重走一遍入站
 */
function makePendingDesk({ queue, undelivered = () => null, outbound = null, router = null, plugins = null,
  inboundStore = null, deadLetters = () => new Map(), reingest = null, log = () => {},
  now = () => Date.now(), reingestWaitMs = 5_000 } = {}) {
  if (!queue) throw new Error("待处理总台要轮次队列");
  const handledFile = inboundStore && inboundStore.root ? path.join(inboundStore.root, "handled-dead-letters.jsonl") : "";

  function handledDead() {
    const out = new Map();
    if (!handledFile) return out;
    try {
      for (const line of fs.readFileSync(handledFile, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { const r = JSON.parse(line); if (r.key) out.set(r.key, r); } catch { /* 坏行跳过 */ }
      }
    } catch { /* 没有就是一条都没处理过 */ }
    return out;
  }
  function markDead(key, entry) {
    if (!handledFile) throw new Error("没有账本目录，记不了死信处理结果");
    fs.mkdirSync(path.dirname(handledFile), { recursive: true, mode: 0o700 });
    fs.appendFileSync(handledFile, JSON.stringify({ at: new Date(now()).toISOString(), key, ...entry }) + "\n",
      { encoding: "utf8", mode: 0o600 });
  }

  function turnItems() {
    return queue.store.list().filter((r) => r.state === "unknown" || r.state === "rejected").map((r) => {
      const pl = (r.envelope && r.envelope.payload) || {};
      const media = Array.isArray(pl.media) && pl.media.length ? `[${pl.media.length} 个附件]` : "";
      return { kind: "turn", key: "turn:" + r.id, ref: r.id, state: r.state, at: r.queuedAt,
        label: turnState(r, now()), reason: r.reason || "", text: String(pl.text || "").trim() || media,
        system: Boolean(r.envelope && r.envelope.source && r.envelope.source.kind === "system") };
    });
  }

  function undeliveredItems() {
    const u = undelivered();
    if (!u || typeof u.list !== "function") return [];
    return u.list().map((e, i) => ({
      kind: "undelivered", key: "out:" + (e.operationId || `noop-${i}-${e.at}`), ref: e.operationId || "",
      state: e.state, at: e.at, label: UNDELIVERED_LABEL[e.state] || e.state, reason: e.reason || "",
      text: e.text || "", entry: e,
    }));
  }

  function deadItems() {
    const done = handledDead();
    const out = [];
    const seen = new Set();
    for (const [channel, dl] of deadLetters()) {
      for (const e of (dl && typeof dl.list === "function" ? dl.list() : [])) {
        const key = "dead:" + channel + ":" + (e.cursor ?? "") + ":" + hash(JSON.stringify(e.raw ?? null)).slice(0, 12);
        if (seen.has(key) || done.has(key)) continue;   // 同一条进了两次死信也只列一次
        seen.add(key);
        out.push({ kind: "dead", key, ref: key, channel, state: "dead", at: e.at, label: "进了死信",
          reason: e.error || "", text: rawText(e.raw), raw: e.raw });
      }
    }
    return out;
  }

  /** 全部待处理的，带短编号。编号 = 类别字母 + 内容哈希前 4 位（撞了就加长）。 */
  function list() {
    const items = [...turnItems(), ...undeliveredItems(), ...deadItems()];
    const prefix = { turn: "t", undelivered: "u", dead: "d" };
    const used = new Set();
    for (const it of items) {
      const h = hash(it.key);
      let n = 4;
      let code = prefix[it.kind] + h.slice(0, n);
      while (used.has(code) && n < h.length) { n += 1; code = prefix[it.kind] + h.slice(0, n); }
      used.add(code);
      it.code = code;
    }
    return items.sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
  }

  function find(code) {
    const c = String(code || "").trim().toLowerCase().replace(/^#/, "");
    if (!c) throw new Error("要给编号（/pending 里每条前面那个）");
    const hit = list().find((it) => it.code === c);
    if (!hit) throw new Error(`没有编号 ${c} —— 可能已经处理掉了，再发一次 /pending 看看`);
    return hit;
  }

  function counts() {
    const turns = turnItems();
    return {
      stuck: turns.filter((t) => t.state === "unknown").length,
      rejected: turns.filter((t) => t.state === "rejected").length,
      dead: deadItems().length,
      check: undeliveredItems().length,
    };
  }

  // ——— 重来 ———

  async function retryUndelivered(it) {
    const e = it.entry;
    if (!e.operationId) throw new Error("这条是老账，没有操作号，重发不了（只能 drop）");
    if (!outbound) throw new Error("没有出闸，重发不了");
    const op = outbound.outbox && typeof outbound.outbox.get === "function" ? outbound.outbox.get(e.operationId) : null;
    const pl = (op && op.payload) || {};
    let channel = pl.channel || e.channel || "";
    let chatId = pl.chatId || e.chatId || "";
    if (!channel || !chatId) {
      const route = router ? router.resolve({ by: "pending" }) : { ok: false };
      if (!route.ok) throw new Error("这条当时就没有落点，现在也找不到 —— 先跟他说句话让桥知道往哪发");
      channel = route.target.platform; chatId = route.target.chat_id;
    }
    const base = { turnId: e.turnId || (op && op.turnId) || "", intent: pl.intent || e.intent || "send_text",
      replyToEventId: "pending-" + e.operationId, inboundEvent: { eventId: "pending-" + e.operationId, channel, chatId, accountId: "" },
      extras: pl.extras || {}, toolArgs: pl.toolArgs || {} };
    let r;
    if (RETRIABLE_SAME_OP.has(e.state)) {
      // 确定没出去（blocked / not_sent）：同一个操作号重来，出闸自己续上没发的那几段。
      r = await outbound.deliver({ ...base, operationId: e.operationId, outputId: e.outputId || (op && op.outputId) || "",
        coldId: e.coldId || (op && op.coldId) || "", text: pl.text || e.text || "" });
    } else {
      // 不知道发没发 / 发了一半：出闸对这种**永远不会自己重发**（平台不认幂等）。她按了 retry =
      // 她确认那边没收到，所以用一个新操作号补发**还没确认发出去**的那几段，旧账标掉。
      const segs = op && Array.isArray(op.segments) ? op.segments.filter((s) => s.state !== "sent").map((s) => s.text) : [];
      const text = segs.length ? segs.join("\n") : (pl.text || e.text || "");
      const opId = e.operationId + "-resend-" + now().toString(36);
      // 补发的那段已经在冷层里了（第一次就写了），这次不再写一遍
      r = await outbound.deliver({ ...base, operationId: opId, outputId: opId, text, cold: { write: false, reason: "pending_resend" } });
      if (r && r.outcome === "sent") undelivered().resolve({ operationId: e.operationId });
    }
    const ok = r && r.outcome === "sent";
    return { ok, text: ok ? `✅ ${it.code} 重发出去了。` : `⚠️ ${it.code} 还是没发出去：${(r && (r.reason || r.state)) || "?"}` };
  }

  async function retryDead(it) {
    if (!reingest) throw new Error("没有入站入口，死信重投不了");
    const plugin = plugins && typeof plugins.get === "function" ? plugins.get(it.channel) : null;
    if (!plugin) throw new Error(`渠道 ${it.channel} 的插头现在没装，重投不了`);
    // 去重：这条平台消息以前登记过，而且轮次账本里有它的结论 → 已经处理过，不再投。
    let delivery = null;
    try { delivery = await plugin.toDelivery(it.raw); } catch (e) { throw new Error("原件翻译不出来：" + ((e && e.message) || e)); }
    if (delivery && !delivery.channel) delivery.channel = it.channel;
    const ev = inboundStore && typeof inboundStore.findNative === "function" ? inboundStore.findNative(delivery) : null;
    const row = ev ? queue.store.get(ev.eventId) : null;
    if (row && (row.state === "unknown" || row.state === "rejected")) {
      // 轮次账本里还挂着 —— 那一行就是它，走轮次放行，不再登记一遍。
      queue.retry(row.id);
      markDead(it.key, { action: "retried", via: "turn", taskId: row.id });
      return { ok: true, text: `✅ ${it.code} 已重新交给他（轮次 ${row.id}）。` };
    }
    if (row) {
      markDead(it.key, { action: "skipped", reason: "already_" + row.state, taskId: row.id });
      return { ok: true, text: `${it.code} 以前已经处理过了（轮次状态 ${row.state}），没再投，从列表里拿掉了。` };
    }
    // ⚠️ 不在这儿等他回完：/pending 跑在入站串行道里，等盒子会把她后面的话一起堵住。
    // 等几秒拿到「进没进轮次账本」就回执；进了就记处理过，剩下的交给队列（拒收会自动重投）。
    const p = Promise.resolve().then(() => reingest({ channel: it.channel, raw: it.raw }));
    let settled = null;
    let failure = null;
    await Promise.race([
      p.then((r) => { settled = r || {}; }, (e) => { failure = e; }),
      new Promise((r) => { const t = setTimeout(r, reingestWaitMs); if (t.unref) t.unref(); }),
    ]);
    if (failure) throw new Error("重投没成：" + ((failure && failure.message) || failure));
    if (settled && settled.accepted === false) {
      markDead(it.key, { action: "skipped", reason: settled.reason || "not_accepted" });
      return { ok: false, text: `⚠️ ${it.code} 入闸没收（${settled.reason || "?"}），从列表里拿掉了。` };
    }
    const ev2 = inboundStore && typeof inboundStore.findNative === "function" ? inboundStore.findNative(delivery) : null;
    const taskId = (settled && settled.taskId) || (ev2 && queue.store.get(ev2.eventId) ? ev2.eventId : "");
    if (!settled && !taskId) {
      // 还没进账本（媒体还在下？）：先不记处理过，等它自己落地；落地以后再记。
      p.then((r) => { if (r && r.taskId) markDead(it.key, { action: "retried", via: "ingest", taskId: r.taskId }); })
        .catch((e) => log("[待处理] 死信重投后台失败：" + ((e && e.message) || e)));
      return { ok: true, text: `⏳ ${it.code} 正在重投（还在路上），过一会儿再 /pending 看。` };
    }
    markDead(it.key, { action: "retried", via: "ingest", taskId });
    if (!settled) p.catch((e) => log("[待处理] 死信重投后台失败：" + ((e && e.message) || e)));
    return { ok: true, text: `✅ ${it.code} 已重新交给他${taskId ? `（轮次 ${taskId}）` : ""}。` };
  }

  async function retry(code) {
    const it = find(code);
    if (it.kind === "turn") {
      queue.retry(it.ref);
      const warn = it.state === "unknown" && !(queue.store.get(it.ref) || {}).exhausted
        ? "\n（这条之前不知道他收没收，万一收过，他可能把这句回两遍。）" : "";
      return { ok: true, text: `✅ ${it.code} 已重新交给他。${warn}` };
    }
    if (it.kind === "undelivered") return retryUndelivered(it);
    return retryDead(it);
  }

  // ——— 放弃 ———

  async function drop(code) {
    const it = find(code);
    if (it.kind === "turn") {
      queue.drop(it.ref);
      return { ok: true, text: `🗑️ ${it.code} 放弃了，后面排着的接着走。（账上记的是「你放弃」，不是「他回过」）` };
    }
    if (it.kind === "undelivered") {
      if (!it.entry.operationId) throw new Error("这条是老账，没有操作号，标不了");
      undelivered().resolve({ operationId: it.entry.operationId });
      return { ok: true, text: `🗑️ ${it.code} 标掉了，不再列。` };
    }
    markDead(it.key, { action: "dropped" });
    return { ok: true, text: `🗑️ ${it.code} 这条死信放弃了，不再列。` };
  }

  /** /pending 那一屏（含按钮）。 */
  function render({ limit = 15 } = {}) {
    const items = list();
    if (!items.length) return { text: "✅ 没有卡住 / 拒收 / 死信 / 待核对的，都清了。", buttons: [] };
    const L = [`🧯 待处理 ${items.length} 条：`];
    const shown = items.slice(0, limit);
    for (const it of shown) {
      const who = it.kind === "turn" ? (it.system ? "系统" : "她→他") : it.kind === "undelivered" ? "他→她" : `死信·${it.channel}`;
      L.push(`#${it.code} ${it.at ? formatWhen(it.at) : "?"} ${who} ${it.label}`
        + `\n   「${short(it.text) || "(空)"}」${it.reason ? "\n   原因：" + short(it.reason, 60) : ""}`);
    }
    if (items.length > shown.length) L.push(`…还有 ${items.length - shown.length} 条（先处理上面的）`);
    L.push("重来：/pending retry 编号 · 放弃：/pending drop 编号");
    // 按钮是一维的：TG 插头一颗按钮占一行（telegram.js 的 inline_keyboard.map((b) => [b])），
    // 跟 /model 一个形状。只给前 8 条出按钮，再多一屏放不下 —— 其余照着手打。
    const buttons = shown.slice(0, 8).flatMap((it) => [
      { text: `↻ 重来 ${it.code}「${short(it.text, 8)}」`, callback_data: `/pending retry ${it.code}` },
      { text: `✕ 放弃 ${it.code}`, callback_data: `/pending drop ${it.code}` },
    ]);
    return { text: L.join("\n"), buttons };
  }

  return { list, counts, retry, drop, render, find };
}

/** 出闸只认「确定没出去」的两种可以原样续发（跟 undelivered.js 的 RETRIABLE 一致）。 */
const RETRIABLE_SAME_OP = new Set(["blocked", "not_sent"]);

module.exports = { makePendingDesk };
