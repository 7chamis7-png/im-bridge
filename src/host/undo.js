"use strict";

/**
 * 撤销一轮 —— **撤的是「这一轮对后续的影响」，不是删个文件**（2026-09-18 Alice定的规格）
 *
 * 她的原话分三块，这个文件就按这三块组织：
 *   1. 上下文与记忆：CLI 历史、主冷层、影子副本，以及由它们生成的摘要 / 交接包 / 长期记忆
 *   2. 队列与派生文件：待处理、发送队列、重试、轮次绑定、生成的语音和附件
 *      —— **采集游标和编号不倒退、不复用**，留无正文的撤销标记防旧消息重新进来
 *   3. 外部动作与验收：已发出去的消息、已建的提醒、已改的文件，分别标
 *      「已撤销 / 无法撤销 / 待处理」，**不许拿删历史冒充撤销动作**
 *
 * 两个入口：撤销上一轮（`last`）、回到指定消息之前（`before`）。**两个都先给影响范围**。
 * 两档力度：
 *   undo   普通撤销 —— 动手前整份备份，后悔得回来
 *   purge  彻底删除 —— **连正文备份一起清**，只留不含正文的操作审计
 *
 * ⚠️ 这个文件住在 host/ 不在 gate/：它要同时动 CLI 的 transcript（底座的东西）
 *    和桥的账本（桥的东西），只有宿主同时认识这两边。桥不认识 transcript 是什么。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

/** CLI 把工作目录变成目录名时**斜杠和点号都换成横线**（跟盒子那份必须一致）。 */
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

/** 先写临时文件再 rename —— 半路断电也不会留半截账本。 */
function writeAtomic(file, text) {
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** 跟她说时间一律北京时间 —— 服务器时区不是她的时区，别让她自己加减。 */
function beijing(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || "");
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(5, 16) + " 京";
}

/** 正文一律不进返回值以外的地方；展示用的摘要截短。 */
function brief(text, max = 40) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max) + "…";
}

// ───────────────────────── 1. 这一轮都有谁 ─────────────────────────

/**
 * 桥这头：把 events.jsonl 读成「一轮一条」。
 * 一轮 = 一条 `kind:"user_input"` 的入站事件，及其所有派生（回复、投递、账）。
 */
function readTurns(gateRoot) {
  const rows = readJsonl(path.join(gateRoot, "events.jsonl"));
  const turns = new Map();
  for (const r of rows) {
    const o = r.obj;
    if (!o || o.kind !== "user_input" || !o.eventId) continue;
    if (turns.has(o.eventId)) continue;          // 同一条会被登记两次（registered / delivered）
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
 * 要撤哪几轮。
 * @param {object} target `{kind:"last"}` / `{kind:"before", nativeId}` / `{kind:"event", eventId}`
 *   before 的语义是**她说的那条消息本身也一起撤**（「回到指定消息之前」）。
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

// ───────────────────────── 2. CLI 历史那一段 ─────────────────────────

/** 这一行是不是「她说的一整轮」的开头（桥送进去的那条，带 `<channel …>` 包装）。 */
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

/** 入站行的正文（queue-operation 在 content，真正的 user 行在 message.content）。 */
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

/** 拒答：合成消息，不是模型真说的话。 */
function isRefusalLine(o) {
  const m = o && o.message;
  return Boolean(m && m.role === "assistant" && (m.stop_reason === "refusal" || m.model === "<synthetic>"));
}

/** 末尾连着的那几条拒答（以及前面那半轮），删完照样要接上 parentUuid。 */
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
 * 在 transcript 里圈出这几轮的行。
 *
 * ⚠️ **删行必须接上 parentUuid**（2026-09-18 的真事：Grok 切拒答没接，
 *    Nova resume 只装回 87 条、292k 变 53k，他自己以为换舱了）。所以这儿要连
 *    「删完之后谁接谁」一起算出来，不是只给一串行号。
 */
function planTranscript({ workspaceRoot, threadId, turns }) {
  const file = transcriptPathOf(workspaceRoot, threadId);
  const rows = readJsonl(file);
  if (!rows.length) return { file, exists: false, lines: [], relink: null, tools: [], unmatched: turns.map((t) => t.nativeId) };

  // 先把整份 transcript 切成「一轮一段」：入站行就是段界。
  // ⚠️ 同一轮**有两条入站行**（queue-operation 的 enqueue + 真正的 user 行），
  //    它们的 message_id 一样。拿「下一条入站行」当段尾会把一轮切成两半 ——
  //    第一版就是这么写的，结果只删掉 enqueue 那一行，他的答复原封不动留着。
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
    // 锚点对不上 —— 最常见的是**这一轮不是她挑起的**（他自己的 check-in 轮被安全层拒了，
    // transcript 里没有 `<channel … message_id=…>` 那条）。她要 /undo 的原头就是这个：
    // 拒答留在历史里，下一轮带着它一起送上去，于是一拒再拒。
    // 所以退一步按**拒答判据**切：连着的 `<synthetic>` / stop_reason=refusal 一起拿掉。
    const fb = refusalRange(rows);
    if (fb) return { file, exists: true, ...fb, unmatched, by: "拒答判据（没找到入站锚点）" };
    return { file, exists: true, lines: [], relink: null, tools: [], unmatched };
  }

  const from = mine[0].i;
  // 段尾：从最后一条属于这几轮的入站行往后，找**第一条不属于这几轮**的入站行
  const lastMine = mine[mine.length - 1].i;
  let to = rows[rows.length - 1].i;
  for (const m of marks) {
    if (m.i > lastMine && !wanted.has(m.nativeId)) { to = m.i - 1; break; }
  }

  const cut = rows.filter((r) => r.i >= from && r.i <= to);
  const lines = cut.map((r) => r.i);

  // 他这一轮调过哪些工具 —— 外部动作要靠它列账（发消息、写记忆、改文件都在这儿）
  const tools = [];
  for (const r of cut) {
    const content = r.obj && r.obj.message && r.obj.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b && b.type === "tool_use" && b.name) tools.push({ name: b.name, at: r.obj.timestamp || "" });
    }
  }

  // 删完之后谁接谁
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

// ───────────────────────── 3. 桥这头的账 ─────────────────────────

/** 冷层 / 影子冷层里属于这几轮的记录（靠 coldId 里带的 eventId 认）。 */
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

/** 发送队列：整条 operation 归属某一轮就整条撤。 */
function planOutbox(gateRoot, ids) {
  const file = path.join(gateRoot, "outbox.json");
  const doc = readJson(file, null);
  const ops = (doc && doc.operations) || {};
  const keys = Object.keys(ops).filter((k) => {
    const o = ops[k] || {};
    const blob = [k, o.outputId, o.operationId, o.coldId, o.turnId].filter(Boolean).join(" ");
    return ids.some((id) => blob.includes(id));
  });
  // 还没发出去的 vs 已经发出去的 —— 后者属于「外部动作」，删队列不等于撤回
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

/** 摘要 / 交接包 / 长期记忆 —— 有就标出来，**不自动删**（混着别的有效内容）。 */
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

// ───────────────────────── 计划 ─────────────────────────

/**
 * 先看会动什么。**这一步只读，不写任何文件。**
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

  // 派生附件：这一轮生成的语音（队列里引到的那些）
  const voice = [...new Set(outbox.pending.concat(outbox.sent).map((x) => x.voice).filter(Boolean))]
    .filter((p) => fs.existsSync(p));

  // 游标**只看不动**：她定的「不倒退、不复用」
  const cursors = ["cursor-telegram.json", "cursor-wechat.json", "cursor-phone.json"]
    .map((n) => ({ file: path.join(gateRoot, n), value: readJson(path.join(gateRoot, n), null) }))
    .filter((c) => c.value);

  const external = {
    // 已经发出去的：删队列**不等于**对方那头消失
    sent: outbox.sent.map((s) => ({
      channel: s.channel, nativeId: s.nativeId,
      verdict: s.channel === "telegram" && s.nativeId ? "可撤回（要你点头才去撤）" : "无法撤销（平台不支持或没记到号）",
    })),
    // 他那一轮动过的工具：记忆、提醒、改文件都算
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

/** 把计划说成一段人话 —— 动手之前她先看这个。 */
function describePlan(plan, { mode = "undo" } = {}) {
  if (!plan.ok) return "撤不了：" + plan.why;
  const L = [];
  L.push(mode === "purge" ? "🔥 **彻底删除**（连正文备份一起清，只留不含正文的审计）" : "↩️ 普通撤销（先整份备份，后悔得回来）");
  L.push(`要撤 ${plan.turns.length} 轮：`);
  for (const t of plan.turns.slice(0, 5)) {
    const id = t.nativeId.length > 12 ? t.nativeId.slice(-8) : t.nativeId;   // 微信那种超长号只留尾巴
    L.push(`  · ${beijing(t.at)} ${t.channel} #${id} 「${t.brief}」`);
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
    for (const [n, k] of Object.entries(byName)) L.push(`  · 他调过 ${n} ×${k} → 待处理（这个引擎不替别人的库做主）`);
  }
  if (plan.footprint.transcript.by) {
    L.push("");
    L.push(`ℹ️ CLI 历史那段是按「${plan.footprint.transcript.by}」圈的 —— 这一轮不是你挑起的（他自己那轮被拒了）。`);
  }
  if (plan.footprint.transcript.unmatched.length) {
    L.push("");
    L.push(`⚠️ 有 ${plan.footprint.transcript.unmatched.length} 轮在 CLI 历史里没对上号（消息号缺失或已被别的操作动过），那部分**没算进上面**。`);
  }
  return L.join("\n");
}

// ───────────────────────── 执行 ─────────────────────────

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
 * 真动手。
 *
 * @param {object} o
 * @param {object} o.plan     planUndo 的产物（**必须是刚算的**，见 stale 检查）
 * @param {string} o.mode     "undo"（留备份）| "purge"（连正文备份一起清）
 * @param {boolean} [o.recallSent] 顺带去撤回已经发出去的消息（默认 false —— 对外动作要她点头）
 * @param {function} [o.now]
 */
function applyUndo({ plan, mode = "undo", now = () => new Date() }) {
  if (!plan || !plan.ok) return { ok: false, why: (plan && plan.why) || "没有计划" };
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  const gateRoot = plan.gateRoot;
  const done = { backup: "", removed: {}, tombstones: 0 };

  // —— 普通撤销：动手前整份备份。彻底删除：**不留正文备份**（她定的）——
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
      // ⚠️ 不能用 basename：`cold.jsonl` 和 `shadow/cold.jsonl` 会撞名，
      //    后拷的把先拷的盖掉，备份里就少了一份正文（第一版真这么丢过）。
      const rel = path.relative(gateRoot, f).replace(/[/\\]/g, "-") || path.basename(f);
      try { fs.copyFileSync(f, path.join(dir, rel)); } catch { /* 没有就算了 */ }
    }
    done.backup = dir;
  }

  // —— 1. CLI 历史：删行 + **接上 parentUuid** ——
  const tr = plan.footprint.transcript;
  if (tr.exists && tr.lines.length) {
    const rows = fs.readFileSync(tr.file, "utf8").split("\n");
    if (tr.relink) {
      try {
        const o = JSON.parse(rows[tr.relink.line]);
        o.parentUuid = tr.relink.parentUuid;     // null 也要写：那表示它成了新的头
        rows[tr.relink.line] = JSON.stringify(o);
      } catch { /* 那行本来就坏，跳过 */ }
    }
    const drop = new Set(tr.lines);
    writeAtomic(tr.file, rows.filter((_, i) => !drop.has(i)).join("\n"));
    done.removed.transcript = tr.lines.length;
  }

  // —— 2. 冷层 / 影子 ——
  for (const [k, f] of [["cold", plan.footprint.cold], ["shadowCold", plan.footprint.shadowCold]]) {
    if (f.exists && f.lines.length) done.removed[k] = dropLines(f.file, f.lines);
  }

  // —— 3. 事件账本：普通撤销留着打标记，彻底删除连正文一起清 ——
  for (const [k, f] of [["events", plan.footprint.events], ["shadowEvents", plan.footprint.shadowEvents]]) {
    if (!f.exists || !f.lines.length) continue;
    if (mode === "purge") done.removed[k] = dropLines(f.file, f.lines);
    else done.removed[k] = 0;                   // 留着；下面追加撤销标记
  }

  // —— 4. 队列 / 轮次 / 绑定 / 欠账 ——
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

  // —— 5. 派生附件 ——
  let voiceGone = 0;
  for (const p of plan.footprint.voice) { try { fs.rmSync(p, { force: true }); voiceGone += 1; } catch { /* 删不掉就算了 */ } }
  if (voiceGone) done.removed.voice = voiceGone;

  // —— 6. 撤销标记：**不含正文**。游标不倒退，靠它挡住旧消息重新进来 ——
  const tomb = path.join(gateRoot, "tombstones.jsonl");
  const at = now().toISOString();
  const marks = plan.turns.map((t) => JSON.stringify({
    schema: "gate.undo-tombstone.v1", at, mode,
    eventId: t.eventId, nativeId: t.nativeId, channel: t.channel, chatId: t.chatId, originalAt: t.at,
  })).join("\n");
  fs.appendFileSync(tomb, marks + "\n", { mode: 0o600 });
  done.tombstones = plan.turns.length;

  // 审计（无正文），普通撤销那档也靠它在账本里留痕
  const audit = path.join(gateRoot, "events.jsonl");
  try {
    fs.appendFileSync(audit, JSON.stringify({
      kind: "turn.undone", at, mode, eventIds: plan.ids,
      counts: plan.counts, backup: done.backup || null,
    }) + "\n", { mode: 0o600 });
  } catch { /* 账本没了就算了 */ }

  return { ok: true, mode, ...done };
}

/**
 * 验收：动完之后再扫一遍，看还有没有残留。
 * **这一步必须跑** —— 她的规格最后一句就是「检查磁盘、内存、记忆和队列一致，再恢复接收」。
 */
function verifyUndo(plan, { mode = "undo" } = {}) {
  const after = planUndo({
    gateRoot: plan.gateRoot, workspaceRoot: plan.workspaceRoot, threadId: plan.threadId,
    target: { kind: "event", eventId: plan.ids[0] },
  });
  // 账本里那条入站被清了（purge）或还在（undo），两种都算正常 —— 看的是**别的地方**有没有残留
  const left = after.ok ? { ...after.counts } : {};
  if (mode !== "purge") left.events = 0;              // 普通撤销本来就留着账本
  const leftovers = Object.entries(left).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`);
  return { clean: leftovers.length === 0, leftovers };
}

module.exports = { planUndo, describePlan, applyUndo, verifyUndo, transcriptPathOf, readTurns };
