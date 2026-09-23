"use strict";

/**
 * Undo a turn: remove the turn's effect on everything that follows, not just a file.
 *
 * Organized in three parts:
 *   1. Context and memory: CLI history, main cold layer, shadow copy, and the
 *      summaries / handoff packages derived from them.
 *   2. Queues and derived files: pending, outbox, retries, turn bindings,
 *      generated voice and attachments. Ingestion cursors and ids never move
 *      backwards or get reused; body-less tombstones keep old messages out.
 *   3. External actions: sent messages, created reminders, modified files are
 *      each marked "undone / cannot undo / needs attention". Deleting history
 *      is never presented as undoing an external action.
 *
 * Two targets: the last turn (`last`) or back to before a given message
 * (`before`). Both show the scope first.
 * Two modes:
 *   undo   regular undo — full backup before touching anything
 *   purge  hard delete — no body backup; only a body-less audit record remains
 *
 * Lives in host/, not gate/: it touches both the CLI transcript (backend) and
 * the bridge ledgers (bridge); only the host knows both sides.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

/** The CLI turns the workspace path into a dir name by replacing `/` and `.` with `-` (must match the box). */
function transcriptPathOf(workspaceRoot, threadId) {
  const slug = String(workspaceRoot || "").replace(/[/.]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", slug, String(threadId) + ".jsonl");
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").map((line, i) => {
      if (!line.trim()) return null;
      try { return { i, line, obj: JSON.parse(line) }; } catch { return { i, line, obj: null }; }
    }).filter(Boolean);
  } catch { return []; }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

/** Write a temp file then rename, so a crash never leaves a half-written ledger. */
function writeAtomic(file, text) {
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Short local timestamp (MM-DD HH:mm) in the host time zone (set TZ to change it). */
function localStamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || "");
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Message bodies never leave the return value; display summaries are truncated. */
function brief(text, max = 40) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max) + "…";
}

// ───────────────────────── 1. Which turns ─────────────────────────

/**
 * Bridge side: read events.jsonl as one entry per turn.
 * A turn = one inbound `kind:"user_input"` event plus everything derived from it.
 */
function readTurns(gateRoot) {
  const rows = readJsonl(path.join(gateRoot, "events.jsonl"));
  const turns = new Map();
  for (const r of rows) {
    const o = r.obj;
    if (!o || o.kind !== "user_input" || !o.eventId) continue;
    if (turns.has(o.eventId)) continue;          // logged twice (registered / delivered)
    turns.set(o.eventId, {
      eventId: o.eventId,
      nativeId: o.nativeId == null ? "" : String(o.nativeId),
      channel: o.channel || "",
      chatId: o.chatId == null ? "" : String(o.chatId),
      at: o.receivedAt || o.registeredAt || "",
      brief: brief(o.text),
    });
  }
  return [...turns.values()];
}

/**
 * Select the turns to undo.
 * @param {object} target `{kind:"last"}` / `{kind:"before", nativeId}` / `{kind:"event", eventId}`
 *   `before` includes the given message itself ("back to before that message").
 */
function selectTurns(all, target) {
  if (!all.length) return { ok: false, why: "账本里一轮都没有" };
  const t = target || { kind: "last" };
  if (t.kind === "last") return { ok: true, turns: all.slice(-1) };
  if (t.kind === "event" || t.kind === "before") {
    const key = t.kind === "event" ? "eventId" : "nativeId";
    const want = String(t.eventId || t.nativeId || "");
    const idx = all.findIndex((x) => String(x[key]) === want);
    if (idx < 0) return { ok: false, why: `账本里找不到这条消息（${key}=${want}）` };
    return { ok: true, turns: t.kind === "event" ? [all[idx]] : all.slice(idx) };
  }
  return { ok: false, why: "不认识的撤销目标：" + t.kind };
}

// ───────────────────────── 2. CLI history ─────────────────────────

/** Whether this line starts an inbound turn (the bridge-sent message wrapped in `<channel …>`). */
function isInboundLine(o) {
  if (!o) return false;
  if (o.type === "queue-operation" && typeof o.content === "string") return o.content.includes("<channel source=");
  const m = o.message;
  if (!m || m.role !== "user") return false;
  const c = m.content;
  if (typeof c === "string") return c.includes("<channel source=");
  if (Array.isArray(c)) return c.some((b) => b && b.type === "text" && String(b.text || "").includes("<channel source="));
  return false;
}

/** Text of an inbound line (queue-operation: content; user line: message.content). */
function inboundText(o) {
  const m = o && o.message;
  const c = m ? m.content : (o ? o.content : "");
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (b && b.type === "text" ? String(b.text || "") : "")).join("\n");
  return "";
}

function inboundLineMatches(o, nativeId) {
  const needle = `message_id="${nativeId}"`;
  const m = o && o.message;
  const c = m ? m.content : (o ? o.content : "");
  if (typeof c === "string") return c.includes(needle);
  if (Array.isArray(c)) return c.some((b) => b && b.type === "text" && String(b.text || "").includes(needle));
  return false;
}

/** Refusal: a synthetic message, not something the model actually said. */
function isRefusalLine(o) {
  const m = o && o.message;
  return Boolean(m && m.role === "assistant" && (m.stop_reason === "refusal" || m.model === "<synthetic>"));
}

/** Trailing consecutive refusals; parentUuid must still be relinked after removal. */
function refusalRange(rows) {
  let end = rows.length - 1;
  while (end >= 0 && !isRefusalLine(rows[end].obj)) end -= 1;
  if (end < 0) return null;
  let start = end;
  while (start - 1 >= 0 && isRefusalLine(rows[start - 1].obj)) start -= 1;
  const from = rows[start].i, to = rows[end].i;
  let prevUuid = null;
  for (const r of rows) { if (r.i >= from) break; if (r.obj && r.obj.uuid) prevUuid = r.obj.uuid; }
  let nextIdx = -1;
  for (const r of rows) {
    if (r.i <= to) continue;
    if (r.obj && Object.prototype.hasOwnProperty.call(r.obj, "parentUuid")) { nextIdx = r.i; break; }
  }
  return {
    lines: rows.filter((r) => r.i >= from && r.i <= to).map((r) => r.i),
    relink: nextIdx >= 0 ? { line: nextIdx, parentUuid: prevUuid } : null,
    tools: [],
  };
}

/**
 * Locate the transcript lines belonging to these turns.
 *
 * Removing lines requires relinking parentUuid: otherwise `resume` follows a
 * broken chain and silently loads only the tail of the conversation. So the
 * plan includes "who links to whom afterwards", not just line numbers.
 */
function planTranscript({ workspaceRoot, threadId, turns }) {
  const file = transcriptPathOf(workspaceRoot, threadId);
  const rows = readJsonl(file);
  if (!rows.length) return { file, exists: false, lines: [], relink: null, tools: [], unmatched: turns.map((t) => t.nativeId) };

  // Split the transcript into turns; inbound lines are the boundaries.
  // A turn has two inbound lines (queue-operation enqueue + the user line) with
  // the same message_id. Using "next inbound line" as the end would split a turn
  // in half and leave the reply in place.
  const marks = [];
  for (const r of rows) {
    if (!isInboundLine(r.obj)) continue;
    const m = /message_id="([^"]+)"/.exec(inboundText(r.obj));
    marks.push({ i: r.i, nativeId: m ? m[1] : "" });
  }
  const wanted = new Set(turns.map((t) => String(t.nativeId)).filter(Boolean));
  const unmatched = turns.filter((t) => !t.nativeId || !marks.some((m) => m.nativeId === String(t.nativeId)))
    .map((t) => t.nativeId || t.eventId);
  const mine = marks.filter((m) => wanted.has(m.nativeId));
  if (!mine.length) {
    // No anchor: typically the turn was not started by an inbound message (e.g. a
    // producer-initiated turn that got refused), so there is no
    // `<channel … message_id=…>` line. A refusal left in the history is sent again
    // with every following turn, causing repeated refusals. Fall back to cutting
    // the trailing `<synthetic>` / stop_reason=refusal lines.
    const fb = refusalRange(rows);
    if (fb) return { file, exists: true, ...fb, unmatched, by: "拒答判据（没找到入站锚点）" };
    return { file, exists: true, lines: [], relink: null, tools: [], unmatched };
  }

  const from = mine[0].i;
  // End: the first inbound line after the last selected one that is not selected
  const lastMine = mine[mine.length - 1].i;
  let to = rows[rows.length - 1].i;
  for (const m of marks) {
    if (m.i > lastMine && !wanted.has(m.nativeId)) { to = m.i - 1; break; }
  }

  const cut = rows.filter((r) => r.i >= from && r.i <= to);
  const lines = cut.map((r) => r.i);

  // Tools called during these turns — used to list external actions
  const tools = [];
  for (const r of cut) {
    const content = r.obj && r.obj.message && r.obj.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b && b.type === "tool_use" && b.name) tools.push({ name: b.name, at: r.obj.timestamp || "" });
    }
  }

  // Relink after removal
  let prevUuid = null;
  for (const r of rows) {
    if (r.i >= from) break;
    if (r.obj && r.obj.uuid) prevUuid = r.obj.uuid;
  }
  let nextIdx = -1;
  for (const r of rows) {
    if (r.i <= to) continue;
    if (r.obj && Object.prototype.hasOwnProperty.call(r.obj, "parentUuid")) { nextIdx = r.i; break; }
  }
  const relink = nextIdx >= 0 ? { line: nextIdx, parentUuid: prevUuid } : null;

  return { file, exists: true, lines, relink, tools, unmatched };
}

// ───────────────────────── 3. Bridge ledgers ─────────────────────────

/** Cold / shadow-cold records of these turns (matched via the eventId inside coldId). */
function planColdFile(file, ids) {
  const rows = readJsonl(file);
  const hit = rows.filter((r) => r.obj && ids.some((id) => String(r.obj.id || "").includes(id)));
  return { file, exists: fs.existsSync(file), lines: hit.map((r) => r.i), ids: hit.map((r) => r.obj.id) };
}

function planEventsFile(file, ids) {
  const rows = readJsonl(file);
  const hit = rows.filter((r) => {
    const o = r.obj;
    if (!o) return false;
    const blob = [o.eventId, o.coldId, o.outputId, o.trace_id].filter(Boolean).join(" ");
    return ids.some((id) => blob.includes(id));
  });
  return { file, exists: fs.existsSync(file), lines: hit.map((r) => r.i) };
}

/** Outbox: an operation belonging to a turn is removed entirely. */
function planOutbox(gateRoot, ids) {
  const file = path.join(gateRoot, "outbox.json");
  const doc = readJson(file, null);
  const ops = (doc && doc.operations) || {};
  const keys = Object.keys(ops).filter((k) => {
    const o = ops[k] || {};
    const blob = [k, o.outputId, o.operationId, o.coldId, o.turnId].filter(Boolean).join(" ");
    return ids.some((id) => blob.includes(id));
  });
  // Pending vs already sent — sent ones are external actions; removing them from the queue doesn't recall them
  const pending = [], sent = [];
  for (const k of keys) {
    const o = ops[k] || {};
    const done = o.state === "confirmed" || o.confirmedAt || o.nativeId || (o.result && o.result.nativeId);
    (done ? sent : pending).push({
      key: k,
      channel: (o.payload && o.payload.target && o.payload.target.platform) || o.channel || "",
      nativeId: String(o.nativeId || (o.result && o.result.nativeId) || ""),
      voice: (o.payload && (o.payload.filePath || o.payload.path)) || "",
    });
  }
  return { file, exists: Boolean(doc), keys, pending, sent };
}

function planMapFile(file, ids, keyMatch) {
  const doc = readJson(file, null);
  if (!doc) return { file, exists: false, keys: [] };
  const keys = Object.keys(doc).filter((k) => keyMatch(k, doc[k], ids));
  return { file, exists: true, keys };
}

/** Summaries / handoff packages: flagged, never deleted automatically (they mix in other turns). */
function planDerived(gateRoot, ids) {
  const out = [];
  const handoff = path.join(gateRoot, "state", "handoff.json");
  if (fs.existsSync(handoff)) {
    const raw = fs.readFileSync(handoff, "utf8");
    if (ids.some((id) => raw.includes(id))) {
      out.push({ what: "换舱交接包", file: handoff, verdict: "待重建", why: "里面混着别轮的内容，整份删会误伤" });
    }
  }
  return out;
}

// ───────────────────────── Plan ─────────────────────────

/**
 * Compute what would change. Read-only; writes nothing.
 * @returns {object} plan
 */
function planUndo({ gateRoot, workspaceRoot, threadId, target = { kind: "last" } }) {
  const all = readTurns(gateRoot);
  const picked = selectTurns(all, target);
  if (!picked.ok) return { ok: false, why: picked.why };
  const turns = picked.turns;
  const ids = turns.map((t) => t.eventId);

  const transcript = planTranscript({ workspaceRoot, threadId, turns });
  const cold = planColdFile(path.join(gateRoot, "cold.jsonl"), ids);
  const shadowCold = planColdFile(path.join(gateRoot, "shadow", "cold.jsonl"), ids);
  const events = planEventsFile(path.join(gateRoot, "events.jsonl"), ids);
  const shadowEvents = planEventsFile(path.join(gateRoot, "shadow", "events.jsonl"), ids);
  const outbox = planOutbox(gateRoot, ids);
  const turnsFile = planMapFile(path.join(gateRoot, "turns.json"), ids,
    (k, v, list) => list.some((id) => k.includes(id) || JSON.stringify(v || "").includes(id)));
  const bindings = planMapFile(path.join(gateRoot, "turn-bindings.json"), ids,
    (k, v, list) => list.some((id) => (v && v.eventId) === id));
  const undelivered = planEventsFile(path.join(gateRoot, "undelivered.jsonl"), ids);
  const derived = planDerived(gateRoot, ids);

  // Derived attachments: generated voice files referenced by the queue
  const voice = [...new Set(outbox.pending.concat(outbox.sent).map((x) => x.voice).filter(Boolean))]
    .filter((p) => fs.existsSync(p));

  // Cursors are read, never modified (no rewinding, no reuse)
  const cursors = ["cursor-telegram.json", "cursor-wechat.json", "cursor-phone.json"]
    .map((n) => ({ file: path.join(gateRoot, n), value: readJson(path.join(gateRoot, n), null) }))
    .filter((c) => c.value);

  const external = {
    // Already sent: removing from the queue does not remove it on the recipient's side
    sent: outbox.sent.map((s) => ({
      channel: s.channel, nativeId: s.nativeId,
      verdict: s.channel === "telegram" && s.nativeId ? "可撤回（需确认后才去撤）" : "无法撤销（平台不支持或没记到号）",
    })),
    // Tools used during the turn: memory writes, reminders, file edits, ...
    tools: transcript.tools.map((t) => ({ name: t.name, at: t.at, verdict: "待处理（这个引擎不替别人的库做主）" })),
  };

  const counts = {
    transcript: transcript.lines.length,
    cold: cold.lines.length,
    shadowCold: shadowCold.lines.length,
    events: events.lines.length,
    shadowEvents: shadowEvents.lines.length,
    outbox: outbox.keys.length,
    turns: turnsFile.keys.length,
    bindings: bindings.keys.length,
    undelivered: undelivered.lines.length,
    voice: voice.length,
  };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return {
    ok: true,
    gateRoot, workspaceRoot, threadId,
    turns, ids,
    footprint: { transcript, cold, shadowCold, events, shadowEvents, outbox, turnsFile, bindings, undelivered, voice },
    derived, external, cursors, counts, total,
  };
}

/** Human-readable plan, shown before anything is applied. */
function describePlan(plan, { mode = "undo" } = {}) {
  if (!plan.ok) return "撤不了：" + plan.why;
  const L = [];
  L.push(mode === "purge" ? "🔥 **彻底删除**（连正文备份一起清，只留不含正文的审计）" : "↩️ 普通撤销（先整份备份，后悔得回来）");
  L.push(`要撤 ${plan.turns.length} 轮：`);
  for (const t of plan.turns.slice(0, 5)) {
    const id = t.nativeId.length > 12 ? t.nativeId.slice(-8) : t.nativeId;   // shorten very long ids
    L.push(`  · ${localStamp(t.at)} ${t.channel} #${id} 「${t.brief}」`);
  }
  if (plan.turns.length > 5) L.push(`  · …还有 ${plan.turns.length - 5} 轮`);
  L.push("");
  L.push("会动这些：");
  const c = plan.counts;
  const row = (n, v, extra = "") => { if (v) L.push(`  ${n} ${v} 处${extra}`); };
  row("CLI 历史", c.transcript, plan.footprint.transcript.relink ? "（删完把 parentUuid 接上）" : "");
  row("主冷层", c.cold);
  row("影子冷层", c.shadowCold);
  row("事件账本", c.events, mode === "purge" ? "（连正文一起清）" : "（留着，打撤销标记）");
  row("影子账本", c.shadowEvents);
  row("发送队列", c.outbox);
  row("轮次记录", c.turns);
  row("轮次绑定", c.bindings);
  row("没送到的账", c.undelivered);
  row("生成的语音", c.voice);
  if (!plan.total) L.push("  （一处都没有 —— 这轮没留下什么）");
  L.push("");
  L.push(`采集游标：${plan.cursors.length} 个**一律不动**（不倒退、不复用），另留无正文的撤销标记防旧消息再进来。`);
  if (plan.derived.length) {
    L.push("");
    L.push("摘要 / 交接包（**不自动删**，混着别轮的内容）：");
    for (const d of plan.derived) L.push(`  · ${d.what} → ${d.verdict}：${d.why}`);
  }
  if (plan.external.sent.length || plan.external.tools.length) {
    L.push("");
    L.push("外部动作（**删历史 ≠ 撤销动作**）：");
    for (const s of plan.external.sent) L.push(`  · 已发出 ${s.channel} #${s.nativeId} → ${s.verdict}`);
    const byName = {};
    for (const t of plan.external.tools) byName[t.name] = (byName[t.name] || 0) + 1;
    for (const [n, k] of Object.entries(byName)) L.push(`  · 调过 ${n} ×${k} → 待处理（这个引擎不替别人的库做主）`);
  }
  if (plan.footprint.transcript.by) {
    L.push("");
    L.push(`ℹ️ CLI 历史那段是按「${plan.footprint.transcript.by}」圈的 —— 这一轮不是由入站消息发起的（例如主动发起的轮被拒答了）。`);
  }
  if (plan.footprint.transcript.unmatched.length) {
    L.push("");
    L.push(`⚠️ 有 ${plan.footprint.transcript.unmatched.length} 轮在 CLI 历史里没对上号（消息号缺失或已被别的操作动过），那部分**没算进上面**。`);
  }
  return L.join("\n");
}

// ───────────────────────── Apply ─────────────────────────

function dropLines(file, lineNumbers) {
  if (!lineNumbers.length) return 0;
  const drop = new Set(lineNumbers);
  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split("\n");
  const kept = lines.filter((_, i) => !drop.has(i));
  writeAtomic(file, kept.join("\n"));
  return lineNumbers.length;
}

/**
 * Apply the plan.
 *
 * @param {object} o
 * @param {object} o.plan     result of planUndo (must be freshly computed)
 * @param {string} o.mode     "undo" (keeps a backup) | "purge" (no body backup)
 * @param {boolean} [o.recallSent] also recall sent messages (default false — external actions need confirmation)
 * @param {function} [o.now]
 */
function applyUndo({ plan, mode = "undo", now = () => new Date() }) {
  if (!plan || !plan.ok) return { ok: false, why: (plan && plan.why) || "没有计划" };
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  const gateRoot = plan.gateRoot;
  const done = { backup: "", removed: {}, tombstones: 0 };

  // undo: full backup first. purge: no body backup.
  const touched = [
    plan.footprint.transcript.exists ? plan.footprint.transcript.file : "",
    plan.footprint.cold.exists ? plan.footprint.cold.file : "",
    plan.footprint.shadowCold.exists ? plan.footprint.shadowCold.file : "",
    plan.footprint.events.exists ? plan.footprint.events.file : "",
    plan.footprint.shadowEvents.exists ? plan.footprint.shadowEvents.file : "",
    plan.footprint.outbox.exists ? plan.footprint.outbox.file : "",
    plan.footprint.turnsFile.exists ? plan.footprint.turnsFile.file : "",
    plan.footprint.bindings.exists ? plan.footprint.bindings.file : "",
    plan.footprint.undelivered.exists ? plan.footprint.undelivered.file : "",
  ].filter(Boolean);

  if (mode !== "purge") {
    const dir = path.join(gateRoot, "undo-backups", stamp);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const f of touched) {
      // Not basename: `cold.jsonl` and `shadow/cold.jsonl` would collide and one
      // backup would overwrite the other.
      const rel = path.relative(gateRoot, f).replace(/[/\\]/g, "-") || path.basename(f);
      try { fs.copyFileSync(f, path.join(dir, rel)); } catch { /* missing: skip */ }
    }
    done.backup = dir;
  }

  // 1. CLI history: remove lines + relink parentUuid
  const tr = plan.footprint.transcript;
  if (tr.exists && tr.lines.length) {
    const rows = fs.readFileSync(tr.file, "utf8").split("\n");
    if (tr.relink) {
      try {
        const o = JSON.parse(rows[tr.relink.line]);
        o.parentUuid = tr.relink.parentUuid;     // write null too: it becomes the new head
        rows[tr.relink.line] = JSON.stringify(o);
      } catch { /* malformed line: skip */ }
    }
    const drop = new Set(tr.lines);
    writeAtomic(tr.file, rows.filter((_, i) => !drop.has(i)).join("\n"));
    done.removed.transcript = tr.lines.length;
  }

  // 2. cold layer / shadow
  for (const [k, f] of [["cold", plan.footprint.cold], ["shadowCold", plan.footprint.shadowCold]]) {
    if (f.exists && f.lines.length) done.removed[k] = dropLines(f.file, f.lines);
  }

  // 3. event ledger: undo keeps it and appends tombstones; purge removes the lines
  for (const [k, f] of [["events", plan.footprint.events], ["shadowEvents", plan.footprint.shadowEvents]]) {
    if (!f.exists || !f.lines.length) continue;
    if (mode === "purge") done.removed[k] = dropLines(f.file, f.lines);
    else done.removed[k] = 0;                   // kept; tombstones appended below
  }

  // 4. queue / turns / bindings / undelivered
  const ob = plan.footprint.outbox;
  if (ob.exists && ob.keys.length) {
    const doc = readJson(ob.file, null);
    if (doc && doc.operations) {
      for (const k of ob.keys) delete doc.operations[k];
      writeAtomic(ob.file, JSON.stringify(doc, null, 2));
      done.removed.outbox = ob.keys.length;
    }
  }
  for (const [k, f] of [["turns", plan.footprint.turnsFile], ["bindings", plan.footprint.bindings]]) {
    if (!f.exists || !f.keys.length) continue;
    const doc = readJson(f.file, null);
    if (!doc) continue;
    for (const key of f.keys) delete doc[key];
    writeAtomic(f.file, JSON.stringify(doc, null, 2));
    done.removed[k] = f.keys.length;
  }
  const un = plan.footprint.undelivered;
  if (un.exists && un.lines.length) done.removed.undelivered = dropLines(un.file, un.lines);

  // 5. derived attachments
  let voiceGone = 0;
  for (const p of plan.footprint.voice) { try { fs.rmSync(p, { force: true }); voiceGone += 1; } catch { /* ignore */ } }
  if (voiceGone) done.removed.voice = voiceGone;

  // 6. Body-less tombstones: cursors don't rewind; tombstones keep old messages out
  const tomb = path.join(gateRoot, "tombstones.jsonl");
  const at = now().toISOString();
  const marks = plan.turns.map((t) => JSON.stringify({
    schema: "gate.undo-tombstone.v1", at, mode,
    eventId: t.eventId, nativeId: t.nativeId, channel: t.channel, chatId: t.chatId, originalAt: t.at,
  })).join("\n");
  fs.appendFileSync(tomb, marks + "\n", { mode: 0o600 });
  done.tombstones = plan.turns.length;

  // Body-less audit record
  const audit = path.join(gateRoot, "events.jsonl");
  try {
    fs.appendFileSync(audit, JSON.stringify({
      kind: "turn.undone", at, mode, eventIds: plan.ids,
      counts: plan.counts, backup: done.backup || null,
    }) + "\n", { mode: 0o600 });
  } catch { /* ledger missing: ignore */ }

  return { ok: true, mode, ...done };
}

/**
 * Verify: rescan after applying and report leftovers. Must run before intake
 * resumes (disk, memory and queues must be consistent).
 */
function verifyUndo(plan, { mode = "undo" } = {}) {
  const after = planUndo({
    gateRoot: plan.gateRoot, workspaceRoot: plan.workspaceRoot, threadId: plan.threadId,
    target: { kind: "event", eventId: plan.ids[0] },
  });
  // The inbound event is gone (purge) or kept (undo); both are fine — check everything else
  const left = after.ok ? { ...after.counts } : {};
  if (mode !== "purge") left.events = 0;              // undo keeps the ledger by design
  const leftovers = Object.entries(left).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`);
  return { clean: leftovers.length === 0, leftovers };
}

module.exports = { planUndo, describePlan, applyUndo, verifyUndo, transcriptPathOf, readTurns };
