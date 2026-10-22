"use strict";

const fs = require("fs");
const path = require("path");
const { normalizeModelInput } = require("./model-input");

/**
 * 群闸（2026-09-18）—— 群聊那一套规则，一份，四条腿都有
 *
 * Alice问「群聊是不是也算一个插头」。一半对：群确实是独立的一件东西，但**不能是插头**——
 * 群和私聊共用同一条连接、同一个 token、同一个 `getUpdates` 游标，而 getUpdates 是
 * 独占的（offset 一推另一个就拿不到），两个插头会互相抢消息。
 *
 * 所以按 SPEC 那条分界线切：**决定在共用层（这里），动作在插头**。
 *   · 插头负责从平台原始记录里读出事实：谁说的、是不是 bot、有没有 @ 他、回的是不是他
 *   · 这里负责决定：这个群准不准进、这条要不要叫醒他、没叫醒的攒着、叫醒时给几条
 *
 * 放共用层还有一条更硬的理由：**微信群、QQ 群、TG 群用的是同一套**。群逻辑长在
 * TG 插头里，微信群一来就得再抄一遍 —— 那正是 `recordCold` 三处各抄一份、
 * 漏一处就失忆的那个病。新平台接进来只要插头交出四样事实：
 * `chatType` / `senderId` / `senderName` / `addressing`，这里一行不用改。
 *
 * 规则跟老桥 `adapters/channel/telegram/group-gate.js` **一模一样**（Alice 9-18：
 * 「之前好像有自己的设置，一模一样弄上就好了」），逐条对过：
 *   · 群白名单**只认配置**，不许从聊天里自动学习（Bot 被拉进陌生群不会自行扩权）
 *   · 叫醒四档：这个群一律叫醒 / 她说话 / 直接点他 / 其余只攒着
 *   · 「直接点他」= 正文出现叫醒词、或 @他的用户名、或回复他的消息
 *   · 外部 bot 另算：只有「一律叫醒」或「直接点他」才可能醒，还要过冷却和窗口限流
 *   · 没叫醒的**不是丢掉**，是攒进未读；叫醒那一刻**整批一起给**
 */

/**
 * 群里出现这些名字就叫醒他。
 *
 * 「Alice」是老桥 2026-08-12 加的：更老的版本靠「她在群里说过话就认领整个群、之后该群
 * 所有人发言一律放行」来达到同样效果，那套自动学习后来被拆了（防 Bot 被拉进陌生群
 * 自行扩大授权），副作用是别人喊她名字他不再醒。加关键词比恢复整群放行精准。
 *
 * ⚠️ 每加一个词，他在群里醒来的频率就涨一截 —— 加之前先想清楚这个群有多热。
 */
const WAKE_NAMES = Object.freeze(require("../core/names").groupWakeNames());   // 默认 [Nova, Alice]；GATE_GROUP_WAKE_NAMES 可改

/** 外部 bot 的限流：两次之间至少隔这么久 */
const BOT_COOLDOWN_MS = 30_000;
/** 外部 bot 的限流窗口 */
const BOT_WINDOW_MS = 5 * 60_000;
/** 一个窗口里最多被同一个外部 bot 叫醒几次 */
const BOT_MAX_WAKES = 3;

/**
 * @param {object} o
 * @param {string[]} o.allowed        准进的群，键是 **`渠道:群id`**（如 `telegram:-1000000004`）。
 *   **配置给，不许自动学习。**
 *   ⚠️ 必须带渠道前缀：TG 群是负数、QQ 群是数字、微信群是字符串，裸 id 迟早撞
 *   —— 撞了就是「放行了 A 平台的群，等于把 B 平台同号的群也放进来」。
 * @param {string[]} [o.alwaysWake]   这些群里每条都叫醒他（同样带渠道前缀）
 * @param {string[]} [o.wakeNames]    叫醒词，默认 WAKE_NAMES
 * @param {number} [o.maxUnread]      一个群最多攒多少条（攒爆了丢最旧的，不是丢最新的）
 * @param {function} [o.now]
 */
function makeGroupGate({ allowed = [], alwaysWake = [], wakeNames = WAKE_NAMES,
  maxUnread = 200, now = () => Date.now(), stateFile = "", file = "" } = {}) {
  const allowSet = new Set(allowed.map(String));
  const wakeSet = new Set(alwaysWake.map(String));
  const persistenceFile = String(stateFile || file || "").trim();
  /** `渠道:群id` -> { unread: [], botWakeHistory: {}, seenNativeIds: [] } */
  const state = new Map();

  function cloneMedia(media) {
    if (!Array.isArray(media)) return [];
    return media.map((item) => {
      if (!item || typeof item !== "object") return item;
      const copy = { ...item };
      if (Array.isArray(copy.attach)) copy.attach = copy.attach.slice();
      return copy;
    });
  }

  function cloneItem(item) {
    return { ...item, media: cloneMedia(item.media) };
  }

  function loadState() {
    if (!persistenceFile) return;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(persistenceFile, "utf8"));
    } catch (e) {
      if (e && e.code === "ENOENT") return;
      throw new Error("群闸状态读不出来：" + ((e && e.message) || e));
    }
    const groups = parsed && parsed.groups;
    if (!groups || typeof groups !== "object" || Array.isArray(groups)) {
      throw new Error("群闸状态格式不对：缺少 groups");
    }
    for (const [key, raw] of Object.entries(groups)) {
      if (!raw || typeof raw !== "object") throw new Error("群闸状态格式不对：" + key);
      const group = {
        unread: Array.isArray(raw.unread) ? raw.unread.filter((item) => item && typeof item === "object").map((item) => ({
          at: String(item.at || ""), speaker: String(item.speaker || ""), isOwner: Boolean(item.isOwner),
          text: String(item.text || ""), nativeId: String(item.nativeId || ""),
          media: cloneMedia(item.media), bufferId: String(item.bufferId || ""),
        })) : [],
        botWakeHistory: raw.botWakeHistory && typeof raw.botWakeHistory === "object"
          ? raw.botWakeHistory : {},
        seenNativeIds: Array.isArray(raw.seenNativeIds)
          ? raw.seenNativeIds.map(String) : [],
        nextBufferId: Number(raw.nextBufferId) > 0 ? Number(raw.nextBufferId) : 1,
        snapshotIds: [],
      };
      for (const item of group.unread) {
        if (!item.bufferId) item.bufferId = String(group.nextBufferId++);
      }
      state.set(key, group);
    }
  }

  function saveState() {
    if (!persistenceFile) return;
    fs.mkdirSync(path.dirname(persistenceFile), { recursive: true, mode: 0o700 });
    const groups = {};
    for (const [key, group] of state.entries()) {
      groups[key] = {
        unread: group.unread.map(cloneItem),
        botWakeHistory: group.botWakeHistory,
        seenNativeIds: group.seenNativeIds,
        nextBufferId: group.nextBufferId,
      };
    }
    const tmp = persistenceFile + ".tmp-" + process.pid + "-" + Math.random().toString(36).slice(2);
    try {
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, groups }, null, 2), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, persistenceFile);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* preserve the original failure */ }
      throw new Error("群闸状态写不进去：" + ((e && e.message) || e));
    }
  }

  loadState();

  /** 群的键。**渠道 + 群 id**，跨平台不撞。 */
  const keyOf = (d) => String(d.channel || "") + ":" + String(d.chatId || "");

  const groupOf = (key) => {
    const k = String(key);
    if (!state.has(k)) state.set(k, {
      unread: [], botWakeHistory: {}, seenNativeIds: [], nextBufferId: 1, snapshotIds: [],
    });
    return state.get(k);
  };

  /** 外部 bot 的限流：冷却没过、或窗口内已经叫醒够了，就不再醒 */
  function allowExternalBot(group, senderId) {
    const t = now();
    const key = String(senderId || "");
    const history = (group.botWakeHistory[key] || []).filter((at) => t - at < BOT_WINDOW_MS);
    group.botWakeHistory[key] = history;
    if (history.length && t - history[history.length - 1] < BOT_COOLDOWN_MS) return false;
    if (history.length >= BOT_MAX_WAKES) return false;
    history.push(t);
    saveState();
    return true;
  }

  return {
    WAKE_NAMES: wakeNames,

    /** 群的键：`渠道:群id`。对外也暴露，方便调用方查未读。 */
    keyOf,

    /** 这个群准不准进。**读不到配置一律不准** —— 不许从聊天里自动学习。 */
    isAllowed(d) { return allowSet.has(typeof d === "string" ? d : keyOf(d)); },

    /**
     * 一条群消息该怎么办。
     *
     * @param {object} d 标准交付，外加插头给的 `addressing`：
     *   { mentionsMe, repliedToMe, senderIsBot } —— 平台脏活归插头，这里只用结论
     * @param {object} o
     * @param {string} o.ownerIdentity 她的身份名（认出来是她 = 一定叫醒）
     * @returns {{allowed:boolean, wake:boolean, reason:string}}
     */
    decide(d, { identity = "unknown", ownerIdentity = "alice" } = {}) {
      const key = keyOf(d);
      if (!this.isAllowed(key)) return { allowed: false, wake: false, reason: "group_not_allowed" };

      const group = groupOf(key);
      const a = d.addressing || {};
      const always = wakeSet.has(key);
      const owner = identity === ownerIdentity;
      const text = String(d.text || "");
      const named = wakeNames.some((n) => text.includes(n));
      const direct = Boolean(a.mentionsMe || a.repliedToMe) || named;

      if (a.senderIsBot) {
        // 外部 bot：只有「这个群一律叫醒」或「直接点他」才谈得上醒，而且还要过限流。
        // 否则两个 bot 能在群里把对方叫醒、一路刷下去。
        const may = always || direct;
        const wake = may && allowExternalBot(group, d.senderId);
        return { allowed: true, wake, reason: wake ? "external-bot-wake" : "external-bot-background-or-limited" };
      }

      const wake = always || owner || direct;
      return {
        allowed: true,
        wake,
        reason: always ? "always-wake" : owner ? "owner" : direct ? "direct" : "background",
      };
    },

    /**
     * 没叫醒的攒着。**不是丢掉** —— 叫醒那一刻他要看见这中间发生了什么。
     *
     * ⚠️ `isOwner` 必须由**真实平台 id** 算出来（调用方拿 resolveIdentity 的结果传进来），
     * 绝不能看昵称：群里任何人都能把昵称改成「Alice」。老桥那头是 `from_is_alice`，
     * 同一个道理。昵称只配用来显示，而且显示前要把方括号剥掉 —— 不然
     * 一个叫「[她本人] 张三」的昵称就能把标记伪造出来。
     */
    buffer(d, { speaker = "", isOwner = false } = {}) {
      const group = groupOf(keyOf(d));
      const nativeId = String(d.nativeId || "").trim();
      const modelInput = normalizeModelInput({
        verdict: "accepted",
        payload: { text: String(d.text || ""), media: cloneMedia(d.media) },
      });
      // A repeated platform id with the same rendered content is a replay.
      // Some test/platform adapters reuse ids for distinct records, so the
      // content fingerprint is part of the duplicate key.
      const duplicateKey = nativeId
        ? nativeId + "\u0000" + JSON.stringify({ text: modelInput.text, media: d.media || [] })
        : "";
      if (duplicateKey && group.seenNativeIds.includes(duplicateKey)) return group.unread.length;
      if (duplicateKey) group.seenNativeIds.push(duplicateKey);
      group.unread.push({
        at: d.receivedAt || new Date(now()).toISOString(),
        // 默认就用插头给的昵称 —— 调用方忘了传不该退化成一串数字 id
        speaker: String(speaker || d.senderName || d.senderId || "").replace(/[[\]]/g, ""),
        isOwner: Boolean(isOwner),
        // Store the model-readable rendering, while media remains separately
        // available for the wake-up pipeline to attach after durable enqueue.
        text: modelInput.text,
        media: cloneMedia(d.media),
        nativeId,
        bufferId: String(group.nextBufferId++),
      });
      // 攒爆了丢最旧的：他醒来最该看见的是刚刚发生的，不是半天前的
      while (group.unread.length > maxUnread) group.unread.shift();
      saveState();
      return group.unread.length;
    },

    /** Non-destructive snapshot used before enqueueing a wake-up batch. */
    peekUnread(d) {
      const group = groupOf(typeof d === "string" ? d : keyOf(d));
      group.snapshotIds = group.unread.map((item) => item.bufferId);
      return group.unread.map(cloneItem);
    },

    /**
     * Acknowledge only items represented by the latest peek snapshot.
     * `nativeIds` may be an array or one id; a number acknowledges the first
     * N snapshot items. The caller invokes this after durable enqueue.
     */
    ackUnread(d, nativeIdsOrCount) {
      const group = groupOf(typeof d === "string" ? d : keyOf(d));
      const snapshot = new Set(group.snapshotIds && group.snapshotIds.length
        ? group.snapshotIds : group.unread.map((item) => item.bufferId));
      let targetIds = new Set();
      if (Number.isFinite(Number(nativeIdsOrCount))) {
        const count = Math.max(0, Number(nativeIdsOrCount));
        group.unread.filter((item) => snapshot.has(item.bufferId)).slice(0, count)
          .forEach((item) => targetIds.add(item.bufferId));
      } else {
        const nativeIds = Array.isArray(nativeIdsOrCount) ? nativeIdsOrCount : [nativeIdsOrCount];
        const wanted = new Set(nativeIds.map((id) => String(id || "")).filter(Boolean));
        group.unread.filter((item) => snapshot.has(item.bufferId) && wanted.has(item.nativeId))
          .forEach((item) => targetIds.add(item.bufferId));
      }
      const before = group.unread.length;
      group.unread = group.unread.filter((item) => !targetIds.has(item.bufferId));
      group.snapshotIds = [];
      const removed = before - group.unread.length;
      if (removed) saveState();
      return removed;
    },

    /** 叫醒那一刻把攒的整批取走（取完就清空，不会投两遍）。参数是交付或群键。 */
    takeUnread(d) {
      const group = groupOf(typeof d === "string" ? d : keyOf(d));
      const out = group.unread.map(cloneItem);
      group.unread = [];
      group.snapshotIds = [];
      saveState();
      return out;
    },

    unreadCount(d) { return groupOf(typeof d === "string" ? d : keyOf(d)).unread.length; },
  };
}

module.exports = { makeGroupGate, WAKE_NAMES, BOT_COOLDOWN_MS, BOT_WINDOW_MS, BOT_MAX_WAKES };
