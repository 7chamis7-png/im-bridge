"use strict";

/**
 * 事件账本（设计稿 v1.5 §0.1 入闸的「编号 / 身份归一」两件事）
 *
 * 两个关键决定，都是Alice 2026-09-17 定的：
 *
 * 1. **编号在「投递给他」那一刻分配，不是收到那一刻。**
 *    否则群消息不投、被过滤、合并投递都会造成合法跳号，
 *    「跳号=有假货」这个判据就废了。保证「他看见的号就是连续的 1、2、3」。
 *
 * 2. **同一编号域跨渠道共用一条序列，跨重启不清零**（A29）。
 *    微信 #42 和 TG #42 若各编各的，他引用 #42 会命中另一条 —— 而她发现不了，
 *    因为两条的语气都能对上他的回复。
 *
 * 阶段 1 用「append-only 事件日志 + 原子写的游标文件」，不引新依赖。
 * 写入一律 tmp + rename 换 inode，不原地改。
 */

const fs = require("fs");
const path = require("path");

/**
 * ⚠️ 铁律 1（docs/SPEC.md）：**代码里不许有写死的路径。**
 * 这里原来默认 "/root/.nova-gate" —— 换台机器就得改代码，拷走跑不起来。
 * 现在必须由调用方给；没给就当场说清楚缺哪一样，不许猜一个。
 */


function nowIso() {
  return new Date().toISOString();
}

function atomicWrite(file, text) {
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

class GateStore {
  constructor({ root } = {}) {
    if (!String(root || "").trim()) throw new Error("GateStore 要一个存储目录（root）—— 不许用默认值猜");
    this.root = root;
    this.eventsFile = path.join(root, "events.jsonl");
    this.stateFile = path.join(root, "state.json");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.state = this.#loadState();
    // 每条腿最后一次真收到 / 真发出的时刻（2026-09-21 Alice要的：/status 一眼看出哪条腿哑了）。
    // 不另开探针 —— 发测试消息会撞微信风控；只记账本里本来就有的两种事件。
    this.lastSeenByChannel = {};
    this.nativeIndex = this.#loadNativeIndex();
  }

  #noteLastSeen(ev) {
    const ch = ev && ev.channel;
    if (!ch) return;
    if (ev.kind === "user_input.delivered") {
      const at = ev.registeredAt || ev.at;
      if (at) (this.lastSeenByChannel[ch] ||= {}).in = at;
    } else if (ev.kind === "outbound.confirmed") {
      if (ev.at) (this.lastSeenByChannel[ch] ||= {}).out = ev.at;
    }
  }

  /** { [channel]: { in?: ISO, out?: ISO } } —— 最后一次真收到 / 真发出 */
  lastSeen() {
    const out = {};
    for (const [ch, v] of Object.entries(this.lastSeenByChannel)) out[ch] = { ...v };
    return out;
  }

  #loadState() {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      // seqByScope: 编号域 -> 已分配的最大 user_seq
      return { seqByScope: {}, eventCount: 0 };
    }
  }

  #saveState() {
    atomicWrite(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  /** Native message ids are scoped to account AND conversation. */
  static nativeKey(ev) {
    return JSON.stringify([ev.channel, ev.accountId || "", ev.chatId || "", ev.nativeId || ""]);
  }

  #loadNativeIndex() {
    const idx = new Map();
    let raw;
    try {
      raw = fs.readFileSync(this.eventsFile, "utf8");
    } catch {
      return idx;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.nativeId) idx.set(GateStore.nativeKey(ev), ev);
      this.#noteLastSeen(ev);
      // The append can succeed before state.json is replaced. Rebuild sequence
      // high-water marks from the journal so a crash cannot reuse a number.
      if (ev.sequenceScope && Number.isFinite(ev.userSeq)) {
        this.state.seqByScope[ev.sequenceScope] = Math.max(this.state.seqByScope[ev.sequenceScope] || 0, ev.userSeq);
      }
    }
    return idx;
  }

  #append(ev) {
    fs.appendFileSync(this.eventsFile, JSON.stringify(ev) + "\n", { encoding: "utf8", mode: 0o600 });
    // 所有落账都走这儿（user_input.delivered 不经 appendEvent），所以「最后一次」在这一层记
    this.#noteLastSeen(ev);
  }

  /**
   * 登记一条接收事件。**此时不分配 user_seq。**
   * 同一 nativeId 重复登记返回原事件（重传沿用原号，不吃两个号）。
   */
  /**
   * 这条平台消息以前登记过没有（2026-10-22，/pending 重投死信前去重用）。
   * 只查不写；没有 nativeId 的认不出来，返回 null。
   */
  findNative(delivery) {
    if (!delivery || !delivery.nativeId) return null;
    return this.nativeIndex.get(GateStore.nativeKey(delivery)) || null;
  }

  registerInbound(delivery, verdict) {
    const key = GateStore.nativeKey(delivery);
    if (delivery.nativeId && this.nativeIndex.has(key)) {
      return { event: this.nativeIndex.get(key), duplicate: true };
    }
    this.state.eventCount += 1;
    const ev = {
      eventId: "ev-" + Date.now().toString(36) + "-" + this.state.eventCount,
      kind: "user_input",
      channel: delivery.channel,
      accountId: delivery.accountId || "",
      senderId: delivery.senderId || "",
      chatId: delivery.chatId || "",
      chatType: delivery.chatType || "private",
      nativeId: delivery.nativeId || "",
      receivedAt: delivery.receivedAt || nowIso(),
      registeredAt: nowIso(),
      processing: delivery.processing || [],
      text: delivery.text || "",
      media: delivery.media || [],
      verdict: verdict.verdict,
      verifyReasons: verdict.reasons || [],
      identity: delivery.identity || "unknown",
      userSeq: null,        // 投递时才填
      deliveredAt: null,
      state: "registered",
    };
    this.#append(ev);
    if (ev.nativeId) this.nativeIndex.set(key, ev);
    this.#saveState();
    return { event: ev, duplicate: false };
  }

  /**
   * 投递那一刻分配 user_seq。只有真实用户输入占号；
   * 模型输出、工具结果、系统唤醒都不占（A30）。
   */
  assignSeqOnDeliver(ev, scope) {
    if (ev.userSeq != null) return ev.userSeq;
    const cur = this.state.seqByScope[scope] || 0;
    const next = cur + 1;
    const assigned = { ...ev, userSeq: next, sequenceScope: scope, deliveredAt: nowIso(), state: "delivered" };
    this.#append({ ...assigned, kind: "user_input.delivered" });
    Object.assign(ev, assigned);
    this.state.seqByScope[scope] = next;
    this.#saveState();
    return next;
  }

  maxSeq(scope) {
    return this.state.seqByScope[scope] || 0;
  }

  /** 按编号取回原文，供出闸核对他引用的 #N */
  findBySeq(scope, seq) {
    let raw;
    try {
      raw = fs.readFileSync(this.eventsFile, "utf8");
    } catch {
      return null;
    }
    let found = null;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.sequenceScope === scope && ev.userSeq === seq) found = ev;
    }
    return found;
  }

  appendEvent(ev) {
    this.state.eventCount += 1;
    const full = { eventId: "ev-" + Date.now().toString(36) + "-" + this.state.eventCount, at: nowIso(), ...ev };
    this.#append(full);
    this.#saveState();
    return full;
  }
}

module.exports = { GateStore };
