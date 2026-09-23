"use strict";

/**
 * Sticker book: translates "which sticker the agent wants" into "which one".
 *
 * ## Why the book does not rely on stored file_ids
 *
 * Telegram `file_id`s are not stable over time (the stable one is
 * `file_unique_id`). Sending with a stale stored id fails with a misleading
 * "sticker not found" style error.
 *
 * So the split is:
 *   - this book maps name / emoji -> "pack X, sticker #N" (does not expire)
 *   - the plugin fetches the pack live from the platform and takes the current
 *     id at that index.
 *
 * Packs grow by appending, so index alignment stays valid; unnamed new
 * stickers are still reachable as `#N`.
 *
 * The book knows no platform (no telegram/wechat require, no API calls). It
 * reads one JSON file whose path is supplied at wiring time.
 */

const fs = require("fs");

/** A resolved sticker. `fileId` is only a fallback; prefer a live fetch by setName+index. */
function hit(pack, sticker, index) {
  return {
    pack: pack.title || "",
    setName: pack.set_name || "",
    index,                                   // 0-based index into the live-fetched pack
    name: sticker.name || "",
    emoji: sticker.emoji || "",
    desc: sticker.desc || "",
    fileId: sticker.file_id || "",           // may be stale; fallback only
  };
}

class StickerBook {
  /**
   * @param {object} o
   * @param {string} o.file          sticker packs JSON ({packName: {set_name,title,stickers:[{emoji,name,desc,file_id}]}})
   * @param {Object<string,string>} [o.owners]  who uses which pack, e.g. `{ agent: "my-pack" }`
   * @param {function} [o.log]
   */
  constructor({ file, owners = {}, log = () => {} } = {}) {
    if (!file) throw new Error("StickerBook requires file (no hard-coded default path)");
    this.file = file;
    this.owners = owners;
    this.log = log;
    this.packs = {};
    this.load();
  }

  load() {
    try {
      this.packs = JSON.parse(fs.readFileSync(this.file, "utf8")) || {};
    } catch (e) {
      // Unreadable means "no stickers", not a crash - but say so loudly.
      this.packs = {};
      this.log("[sticker] cannot read sticker packs (sending stickers will fail): " + ((e && e.message) || e));
    }
    return this;
  }

  /** Which pack this identity uses; defaults to the first pack. */
  packFor(owner) {
    const want = this.owners[String(owner || "")] || "";
    if (want && this.packs[want]) return this.packs[want];
    const names = Object.keys(this.packs);
    return names.length ? this.packs[names[0]] : null;
  }

  /**
   * Resolve a query to a sticker. Four forms, strictest first:
   *   1. `#3` / `3`       - by position (reaches unnamed stickers too)
   *   2. exact name
   *   3. exact emoji      - e.g. "😄"
   *   4. substring of name or description
   *
   * Returns null when nothing matches; never picks a random one. Sending the
   * wrong sticker is worse than sending none.
   */
  resolve(query, owner = "") {
    const pack = this.packFor(owner);
    if (!pack || !Array.isArray(pack.stickers) || !pack.stickers.length) return null;
    const list = pack.stickers;
    const q = String(query == null ? "" : query).trim();
    if (!q) return null;

    const num = /^#?(\d{1,3})$/.exec(q);
    if (num) {
      const i = Number(num[1]) - 1;
      return (i >= 0 && i < list.length) ? hit(pack, list[i], i) : null;
    }
    let i = list.findIndex((s) => String(s.name || "") === q);
    if (i < 0) i = list.findIndex((s) => String(s.emoji || "") === q);
    if (i < 0) {
      i = list.findIndex((s) => String(s.name || "").includes(q) || String(s.desc || "").includes(q));
    }
    return i >= 0 ? hit(pack, list[i], i) : null;
  }

  /** Stickers available to send (for tool descriptions / `/help`). */
  list(owner = "") {
    const pack = this.packFor(owner);
    if (!pack || !Array.isArray(pack.stickers)) return [];
    return pack.stickers.map((s, i) => ({ index: i, name: s.name || "", emoji: s.emoji || "", desc: s.desc || "" }));
  }
}

/**
 * Wiring helper: a book exists only when `GATE_STICKER_PACKS` is set; otherwise
 * the channel has no stickers (the plugin says so explicitly).
 *   GATE_STICKER_PACKS   path to the sticker packs JSON
 *   GATE_STICKER_OWNERS  optional identity->pack map, e.g. `agent=my-pack`
 */
function stickerBookFromEnv(env = {}, log = () => {}) {
  const file = String(env.GATE_STICKER_PACKS || "").trim();
  if (!file) return null;
  const owners = {};
  // format: `agent=my-pack,other=other-pack`
  for (const part of String(env.GATE_STICKER_OWNERS || "").split(",")) {
    const [k, v] = part.split("=").map((s) => (s || "").trim());
    if (k && v) owners[k] = v;
  }
  return new StickerBook({ file, owners, log });
}

module.exports = { StickerBook, stickerBookFromEnv };
