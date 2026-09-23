"use strict";

const fs = require("fs");
const path = require("path");
const { normalizeModelInput } = require("./model-input");

/**
 * Group gate — one set of group-chat rules shared by every leg.
 *
 * Groups are not a separate plugin: group and private chats share the same connection,
 * token and update cursor (e.g. Telegram `getUpdates` is exclusive), so two plugins would
 * steal each other's messages.
 *
 * Split per SPEC: decisions live in the shared layer (here), actions in the plugin.
 *   · the plugin extracts facts from raw platform records: sender, is-bot, mentions the agent,
 *     replies to the agent
 *   · this module decides: is the group allowed, should this message wake the agent, buffer
 *     the rest, and hand the whole batch over on wake-up
 *
 * Living in the shared layer means Telegram / WeChat / QQ groups all use the same code. A new
 * platform only has to provide `chatType` / `senderId` / `senderName` / `addressing`.
 *
 * Rules:
 *   · the group allowlist comes from config only — never learned from chat (a bot added to a
 *     stranger's group must not grant itself access)
 *   · wake levels: always-wake group / owner spoke / agent addressed directly / otherwise buffer
 *   · "addressed directly" = a wake word appears, the bot is @mentioned, or a reply to the bot
 *   · external bots can only wake the agent via always-wake or direct address, and are rate limited
 *   · non-waking messages are not dropped: they are buffered and delivered as one batch on wake-up
 */

/**
 * Wake words: if any of these appears in a group message, the agent wakes up.
 * Configured via GATE_GROUP_WAKE_NAMES (comma-separated), default empty.
 *
 * Every added word makes the agent wake more often — consider how busy the group is.
 */
const WAKE_NAMES = Object.freeze(String(process.env.GATE_GROUP_WAKE_NAMES || "")
  .split(",").map((s) => s.trim()).filter(Boolean));

/** External bot rate limit: minimum gap between two wakes */
const BOT_COOLDOWN_MS = 30_000;
/** External bot rate-limit window */
const BOT_WINDOW_MS = 5 * 60_000;
/** Max wakes by the same external bot per window */
const BOT_MAX_WAKES = 3;

/**
 * @param {object} o
 * @param {string[]} o.allowed        allowed groups, keyed **`channel:groupId`** (e.g. `telegram:-10002`).
 *   From config only, never learned.
 *   The channel prefix is required: raw ids from different platforms can collide, and allowing
 *   a group on platform A must not allow a same-numbered group on platform B.
 * @param {string[]} [o.alwaysWake]   groups where every message wakes the agent (same key format)
 * @param {string[]} [o.wakeNames]    wake words, default WAKE_NAMES
 * @param {number} [o.maxUnread]      max buffered messages per group (drops the oldest)
 * @param {function} [o.now]
 */
function makeGroupGate({ allowed = [], alwaysWake = [], wakeNames = WAKE_NAMES,
  maxUnread = 200, now = () => Date.now(), stateFile = "", file = "" } = {}) {
  const allowSet = new Set(allowed.map(String));
  const wakeSet = new Set(alwaysWake.map(String));
  const persistenceFile = String(stateFile || file || "").trim();
  /** `channel:groupId` -> { unread: [], botWakeHistory: {}, seenNativeIds: [] } */
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

  /** Group key: channel + group id, unique across platforms. */
  const keyOf = (d) => String(d.channel || "") + ":" + String(d.chatId || "");

  const groupOf = (key) => {
    const k = String(key);
    if (!state.has(k)) state.set(k, {
      unread: [], botWakeHistory: {}, seenNativeIds: [], nextBufferId: 1, snapshotIds: [],
    });
    return state.get(k);
  };

  /** External bot rate limit: no wake during cooldown or once the window quota is used */
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

    /** Group key `channel:groupId`, exposed so callers can query unread counts. */
    keyOf,

    /** Is this group allowed? Not configured = not allowed; never learned from chat. */
    isAllowed(d) { return allowSet.has(typeof d === "string" ? d : keyOf(d)); },

    /**
     * What to do with one group message.
     *
     * @param {object} d standard delivery plus the plugin's `addressing`:
     *   { mentionsMe, repliedToMe, senderIsBot } — platform details stay in the plugin
     * @param {object} o
     * @param {string} o.ownerIdentity the owner's identity name (owner messages always wake)
     * @returns {{allowed:boolean, wake:boolean, reason:string}}
     */
    decide(d, { identity = "unknown", ownerIdentity = "owner" } = {}) {
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
        // External bots may only wake the agent via always-wake or direct address, and are
        // rate limited — otherwise two bots can keep waking each other forever.
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
     * Buffer a non-waking message (not dropped): on wake-up the agent sees what happened.
     *
     * `isOwner` must be derived from the real platform id (caller passes the resolveIdentity
     * result), never from the nickname — anyone can rename themselves. Nicknames are display
     * only, and brackets are stripped so a nickname can't forge a marker like "[owner]".
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
        // default to the plugin-provided nickname rather than a numeric id
        speaker: String(speaker || d.senderName || d.senderId || "").replace(/[[\]]/g, ""),
        isOwner: Boolean(isOwner),
        // Store the model-readable rendering, while media remains separately
        // available for the wake-up pipeline to attach after durable enqueue.
        text: modelInput.text,
        media: cloneMedia(d.media),
        nativeId,
        bufferId: String(group.nextBufferId++),
      });
      // on overflow drop the oldest: the most recent context matters most on wake-up
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

    /** Take the whole buffered batch on wake-up (clears it, never delivered twice). Arg: delivery or group key. */
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
