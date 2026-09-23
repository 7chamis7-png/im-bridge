"use strict";

/**
 * Producer drop-box — how things outside the bridge push a turn in.
 *
 * SPEC §1: scheduled check-ins and similar are *event producers*, not part of the bridge.
 * Remove them and the bridge still works. They don't live in the bridge process and don't
 * know about the runtime; they decide "time to push a turn" and drop a note here.
 *
 * ## One file per note, not a JSON array
 *
 * A single queue file (`load → push → save`) loses messages as soon as two independent
 * producer processes enqueue at the same time (last writer wins, silently).
 * One file per note + `tmp → rename` is atomic on the same filesystem: any number of
 * producers can write concurrently without locks.
 *
 * ## Only counted once consumed
 *
 * Same rule as the inbound cursor (SPEC §5): the file is deleted only after the note was
 * handed to the box. A crash in between re-delivers it — better twice than never.
 * Idempotency comes from `id`: the bridge remembers which ids it has delivered.
 *
 * ## The bridge doesn't know producers
 *
 * `producer` is free text; the bridge neither validates nor enumerates it. Adding a new
 * producer requires no bridge change.
 */

const fs = require("fs");
const path = require("path");

/**
 * In-process sequence number. File names only have millisecond resolution; this breaks
 * ties between notes written in the same millisecond by the same process.
 *
 * Ordering across processes within the same millisecond is not guaranteed (and needn't be:
 * two independent producers have no real order). Anything needing a strict total order
 * should not use this drop-box.
 */
let seq = 0;

/** Validate a note. Say exactly what's missing; never drop silently. */
function assertNote(note) {
  if (!note || typeof note !== "object") throw new Error("投递不是个对象");
  const text = String(note.text || "").trim();
  if (!text) throw new Error("投递没有正文 —— 空轮不许进盒子");
  if (!String(note.producer || "").trim()) {
    throw new Error("投递要说清楚是谁推的（producer）—— 出了事得知道找谁");
  }
  return note;
}

/**
 * Producer side: drop one note into the bridge's inbox.
 *
 * Meant for processes outside the bridge; it requires nothing from the bridge (copy-pasteable).
 * @param {object} o
 * @param {string} o.dir      drop directory (agreed between bridge and producer)
 * @param {string} o.producer who pushed it (free text; the bridge doesn't interpret it)
 * @param {string} o.text     body
 * @param {object} [o.target] destination { platform, chat_id } — system producers only
 * @returns {{id:string, file:string}}
 */
function putNote({ dir, producer, text, target = null }) {
  if (!String(dir || "").trim()) throw new Error("投递要一个目录 —— 不许用默认值猜");
  const note = assertNote({
    id: "n-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
    at: new Date().toISOString(),
    producer: String(producer || "").trim(),
    text: String(text || "").trim(),
    ...(target ? { target } : {}),
  });
  fs.mkdirSync(dir, { recursive: true });
  // timestamp + in-process sequence in the name => directory listing is chronological
  seq = (seq + 1) % 1e6;
  const name = note.at.replace(/[:.]/g, "-")
    + "-" + String(seq).padStart(6, "0")
    + "-" + note.id + ".json";
  const finalPath = path.join(dir, name);
  const tmp = path.join(dir, "." + name + ".tmp-" + process.pid);
  fs.writeFileSync(tmp, JSON.stringify(note, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, finalPath);          // atomic: concurrent producers never overwrite each other
  return { id: note.id, file: finalPath };
}

/**
 * Bridge side: consume notes dropped by producers.
 *
 * @param {object} o
 * @param {string} o.dir
 * @param {string} [o.seenFile] delivered ids (idempotency). Defaults to a file under dir
 * @param {number} [o.maxSeen]  how many ids to remember
 */
function makeProducerInbox({ dir, seenFile = "", maxSeen = 2000 } = {}) {
  if (!String(dir || "").trim()) throw new Error("投递口要一个目录 —— 不许用默认值猜");
  const seenPath = seenFile || path.join(dir, ".seen.json");
  fs.mkdirSync(dir, { recursive: true });

  const loadSeen = () => {
    try {
      const a = JSON.parse(fs.readFileSync(seenPath, "utf8"));
      return Array.isArray(a) ? a : [];
    } catch { return []; }
  };
  const saveSeen = (list) => {
    const tail = list.slice(-maxSeen);
    const tmp = seenPath + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(tail), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, seenPath);
  };

  return {
    /** How many notes are waiting (count only). Used by the watchdog to spot a jam. */
    pending() {
      try {
        return fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith(".")).length;
      } catch { return 0; }
    },

    /**
     * Consume waiting notes in order.
     *
     * @param {function} handle `(note) => Promise`. Throwing means "not consumed":
     *   the file stays and is retried next time.
     * @returns {{ok:number, failed:number, skipped:number}}
     */
    async drain(handle) {
      if (typeof handle !== "function") throw new Error("投递口要一个 handle（一条怎么消化）");
      let files;
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("."));
      } catch { return { ok: 0, failed: 0, skipped: 0 }; }
      files.sort();                                  // timestamped names = chronological order
      const seen = new Set(loadSeen());
      const added = [];
      let ok = 0, failed = 0, skipped = 0;

      for (const f of files) {
        const full = path.join(dir, f);
        let note;
        try {
          note = JSON.parse(fs.readFileSync(full, "utf8"));
          assertNote(note);
        } catch {
          // Bad file: must not block the rest, and must not vanish silently.
          fs.renameSync(full, full + ".bad");
          failed += 1;
          continue;
        }
        if (note.id && seen.has(note.id)) {          // already delivered (crashed before unlink)
          fs.unlinkSync(full);
          skipped += 1;
          continue;
        }
        try {
          await handle(note);
        } catch {
          failed += 1;
          continue;                                  // keep the file, retry next time
        }
        // ==== delete only after it was consumed ====
        if (note.id) { seen.add(note.id); added.push(note.id); }
        try { fs.unlinkSync(full); } catch { /* next time `seen` skips it */ }
        ok += 1;
      }
      if (added.length) saveSeen([...loadSeen(), ...added]);
      return { ok, failed, skipped };
    },
  };
}

module.exports = { putNote, makeProducerInbox, assertNote };
