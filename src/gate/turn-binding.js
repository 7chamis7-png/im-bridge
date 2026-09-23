"use strict";

/**
 * Persistent binding: which inbound event started a given turn.
 *
 * The outbound gate needs the turn's inbound event to know where to reply.
 * The tool process (an MCP child process) does not share memory with the main
 * process, so the binding must live on disk; otherwise every tool-initiated
 * reply would be judged `proactive_target_not_configured`. An in-memory reply
 * target also evaporates across restarts, trims and session rotations, which is
 * exactly when misrouted replies happen.
 *
 * Key: `threadId:turnId`; the tool process can obtain the same pair.
 */

const fs = require("fs");
const path = require("path");

const KEEP = 500;          // keep only the most recent turns so the file stays bounded

class TurnBinding {
  constructor({ file }) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }

  #read() {
    try { return JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { return {}; }
  }

  #write(obj) {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    fs.renameSync(tmp, this.file);      // atomic replace: readers never see a partial file
  }

  static key(threadId, turnId) { return String(threadId || "") + ":" + String(turnId || ""); }

  /** Recorded right after intake admits the event: which inbound started this turn. */
  bind(threadId, turnId, event) {
    const k = TurnBinding.key(threadId, turnId);
    if (!k || k === ":") return;
    const all = this.#read();
    all[k] = {
      eventId: event.eventId, channel: event.channel,
      chatId: event.chatId, accountId: event.accountId,
      // Platform-native message id of the inbound (needed for reactions / reply-to).
      // Older records lack it; callers handle the fallback, don't guess here.
      nativeId: event.nativeId || "",
      at: new Date().toISOString(),
    };
    const keys = Object.keys(all);
    if (keys.length > KEEP) {
      keys.sort((a, b) => String(all[a].at).localeCompare(String(all[b].at)));
      for (const old of keys.slice(0, keys.length - KEEP)) delete all[old];
    }
    this.#write(all);
  }

  /** Lookup for the outbound gate / tool process. Returns null when unknown; the caller decides. */
  lookup(threadId, turnId) {
    return this.#read()[TurnBinding.key(threadId, turnId)] || null;
  }
}

module.exports = { TurnBinding };
