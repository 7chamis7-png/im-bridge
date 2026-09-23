"use strict";

/**
 * The only cold-layer writer (SPEC v1.5 §0.1 / §6).
 *
 * This is the single place in the system that writes the cold layer (the plain-text
 * conversation log). Plugins structurally cannot reach it — there is no entry point for
 * them, so a new channel can't "forget" to record conversation history.
 *
 * Rules:
 * - A record has exactly four fields (SPEC §6): `id` / `role` / `at` / `text`, taken from
 *   `COLD_FIELDS` in `envelope.js` (single definition for the whole bridge).
 *   Technical fields go to the event log (`store.appendEvent`), linked back via `coldId`.
 *   Reason: cold records may later be replayed into a fresh session as real turns; any
 *   technical field would have to be stripped first or it leaks into the agent's context.
 * - Recording follows what was *processed*; no per-channel exemptions, and delivery success
 *   is not a precondition for recording.
 * - Images are stored as `[图片]` only (§0.4). Storing paths would let old inbox paths be
 *   rescanned and pulled back into the active context.
 * - A body that failed verification must never pose as the user's words; it is downgraded
 *   to a placeholder here, and the original stays in the event ledger.
 * - The cold layer is read in file order: append-only, never insert.
 */

const fs = require("fs");
const path = require("path");

const { COLD_FIELDS } = require("./envelope");

class ColdWriter {
  constructor({ file } = {}) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.seen = this.#loadIds();
  }

  #loadIds() {
    const s = new Set();
    let raw;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      return s;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.id) s.add(o.id);
      } catch { /* skip bad lines; one bad line must not break the index */ }
    }
    return s;
  }

  /** Downgrade before storing: undecodable content must not pose as the owner's words. */
  static bodyForCold(ev) {
    if (ev.verdict === "undecoded") return "[未解码内容]";
    const media = Array.isArray(ev.media) ? ev.media : [];
    if (!ev.text && media.length) {
      return media.map(ColdWriter.coldMediaLine).join(" ");
    }
    return ev.text || "";
  }

  /**
   * How one media item looks in the cold layer. Deliberately different from the line
   * shown to the agent:
   *
   * - Visual media (image/sticker/video) is stored as a label only (§0.4); storing the path
   *   would let it be rescanned into the active context.
   * - Audio is stored as its transcript: it has no path and *is* what was said. Storing only
   *   `[voice]` would lose the content on every session rotation.
   */
  static coldMediaLine(m) {
    const kind = (m && m.kind) || "media";
    if (kind === "voice" || kind === "audio") {
      const t = String((m && m.transcript) || "").trim();
      if (t) return "[语音] " + t;
    }
    return kind === "image" ? "[图片]" : "[" + kind + "]";
  }

  /**
   * Single entry point. The same recordId is written at most once (safe to retry when the
   * write succeeded but the acknowledgement was lost).
   * @returns {{written: boolean, id: string}}
   */
  write({ recordId, role, ev, text }) {
    if (this.seen.has(recordId)) return { written: false, id: recordId };
    const rec = {
      id: recordId,
      role,
      at: (ev && ev.receivedAt) || new Date().toISOString(),
      text: text != null ? text : ColdWriter.bodyForCold(ev || {}),
    };
    // The four-field rule is enforced structurally: an extra field throws immediately.
    ColdWriter.assertShape(rec);
    fs.appendFileSync(this.file, JSON.stringify(rec) + "\n", { encoding: "utf8", mode: 0o600 });
    this.seen.add(recordId);
    return { written: true, id: recordId };
  }

  /** Shape check: exactly the `COLD_FIELDS`, no more, no less. */
  static assertShape(rec) {
    const got = Object.keys(rec).sort();
    const want = COLD_FIELDS.slice().sort();
    if (got.length !== want.length || got.some((k, i) => k !== want[i])) {
      throw new Error(
        "冷层记录只许有 " + want.join(" / ") + "，拿到的是 " + got.join(" / ")
        + " —— 技术字段去日志（见 SPEC §6）",
      );
    }
    return rec;
  }

  count() {
    return this.seen.size;
  }
}

module.exports = { ColdWriter };
