#!/usr/bin/env node
"use strict";

/**
 * S1b：从引擎自己的文件补录全本（一次性，**只读**引擎文件）。设计稿 §6 S1b。
 *
 *   Nova  ~/.claude/projects/-root-nova/*.jsonl（CC transcript，默认只要 2026-10-07 起的）
 *   Iris  ~/.codex/sessions/…/rollout-….jsonl（codex rollout，只取 message 和工具对；跳过 compacted 副本，
 *         加密 reasoning 默认不要）
 *
 * 导出的记录都是 `epoch: 0`、`imported: true`，带 `source: {file, line}`，回滚 = 删掉这些。
 *
 * **默认干跑**：只读、只打统计和形状，不写任何东西。加 `--out <目录>` 才写出（用 HistoryWriter，同一套去重和脱敏）。
 * `--out` **不许**指到生产的 GATE_ROOT（/root/.nova-gate、/root/.iris-gate、$GATE_ROOT），指了直接拒。
 *
 * 用法：
 *   node scripts/history-import.js --claude ~/.claude/projects/-root-nova [--since 2026-10-07] [--include-forged] [--opaque] [--out /tmp/x]
 *   node scripts/history-import.js --rollout <rollout.jsonl> [--opaque] [--out /tmp/x]
 *
 * 判据（都从生产文件实测出来的，夹具在 test/fixtures/real/）：
 *   · forge 回填的行不导（它们是更早冷层的复述，导了就重复）：assistant 的 message.id 以 msg_synth_ 开头；
 *     user 行没有 `entrypoint`（真入站行都有）。`--include-forged` 才要
 *   · `<channel …>` 壳拆开：属性进 origin，正文进 parts；壳前面还有一截的 = 人格包，只记指纹
 *   · CC 造的消息（model=<synthetic> / isApiErrorMessage）标 generatedBy=engine；isMeta 的 user 行标 producer=engine
 *   · codex 的 <environment_context> 之类是引擎塞的，标 producer=engine；developer 消息（指令）不导
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { HistoryWriter, ITEM_VERSION } = require("../src/box/history-writer");
const { splitToolName } = require("../src/box/history-claude");

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

const PROD_ROOTS = ["/root/.nova-gate", "/root/.iris-gate"];
function refuseProdOut(out, env = process.env) {
  const abs = path.resolve(out);
  const roots = PROD_ROOTS.concat(env.GATE_ROOT ? [env.GATE_ROOT] : []).map((r) => path.resolve(r));
  for (const r of roots) {
    if (abs === r || abs.startsWith(r + path.sep)) throw new Error(`--out 指到了生产的 GATE_ROOT（${r}），不写。导到 /tmp 或测试夹具目录。`);
  }
  return abs;
}

/** 一行一行读（大文件按块，不整个读进内存）。 */
function* readLines(file) {
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(1 << 20);
  let rest = "";
  let n;
  try {
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      rest += buf.toString("utf8", 0, n);
      let nl;
      while ((nl = rest.indexOf("\n")) >= 0) { yield rest.slice(0, nl); rest = rest.slice(nl + 1); }
    }
    if (rest.trim()) yield rest;
  } finally { fs.closeSync(fd); }
}

const CHANNEL_RE = /<channel((?:\s+[a-z_]+="[^"]*")*)\s*>\n?([\s\S]*?)\n?<\/channel>\s*$/;
/** `[人格包]<channel a="b">正文</channel>` → { pack, attrs, body }；没有壳返回 null。 */
function parseChannel(text) {
  const s = String(text || "");
  const at = s.lastIndexOf("<channel ");
  if (at < 0) return null;
  const m = CHANNEL_RE.exec(s.slice(at));
  if (!m) return null;
  const attrs = {};
  for (const a of m[1].matchAll(/([a-z_]+)="([^"]*)"/g)) {
    attrs[a[1]] = a[2].replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  }
  return { pack: s.slice(0, at).replace(/\s+$/, ""), attrs, body: m[2] };
}

const ENGINE_USER_TAGS = /^\s*<(environment_context|recommended_plugins|turn_aborted|memory_context|subagent_notification|user_instructions|skills_instructions|model_switch|collaboration_mode)\b/;

function makeStats() {
  return { rows: 0, items: 0, opaque: 0, blobs: 0, bytes: 0, skipped: {}, kinds: {}, first: "", last: "", shapes: {} };
}
const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };

function createSink({ out, opaque, stats }) {
  const writer = out ? new HistoryWriter({ dir: out }) : null;
  const seen = new Set();
  return {
    item(it) {
      const full = { v: ITEM_VERSION, epoch: 0, imported: true, ...it };
      if (seen.has(full.id)) { bump(stats.skipped, "重复 id"); return; }
      seen.add(full.id);
      stats.items += 1;
      stats.bytes += Buffer.byteLength(JSON.stringify(full)) + 1;
      const k = full.type + (full.kind ? ":" + full.kind : "") + (full.role ? "/" + full.role : "");
      bump(stats.kinds, k);
      if (!stats.shapes[k]) stats.shapes[k] = Object.keys(full).sort().join(",");
      if (full.at && (!stats.first || full.at < stats.first)) stats.first = full.at;
      if (full.at && full.at > stats.last) stats.last = full.at;
      if (writer) writer.append(full);
    },
    opaque(rec) {
      if (!opaque) { bump(stats.skipped, "opaque（没加 --opaque）"); return; }
      stats.opaque += 1;
      if (writer) writer.appendOpaque({ epoch: 0, imported: true, ...rec });
    },
    blob(buf) {
      stats.blobs += 1;
      return writer ? writer.putBlob(buf) : sha(buf);
    },
    text(s) { return writer ? writer.inlineOrBlob(s) : { text: String(s || "").slice(0, 16384), blob: Buffer.byteLength(String(s || "")) > 16384 ? "(干跑不存)" : null }; },
    epoch(rec) { if (writer) writer.appendEpoch({ epoch: 0, reason: "imported", ...rec }); },
  };
}

// ——— CC transcript ———

function importClaudeFile(file, sink, stats, { includeForged = false } = {}) {
  let lineNo = -1;
  let sessionId = "";
  for (const line of readLines(file)) {
    lineNo += 1;
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { bump(stats.skipped, "坏行"); continue; }
    stats.rows += 1;
    if (row.type !== "user" && row.type !== "assistant") { bump(stats.skipped, `cc:${row.type}`); continue; }
    const m = row.message || {};
    sessionId = sessionId || row.sessionId || "";
    const src = { file, line: lineNo };
    const at = row.timestamp || "";
    const common = { at, engine: "claude-cli", engineThread: row.sessionId || "", source: src, ...(row.isSidechain ? { sidechain: true } : {}) };
    const content = m.content;

    if (row.type === "assistant") {
      const forged = String(m.id || "").startsWith("msg_synth_");
      if (forged && !includeForged) { bump(stats.skipped, "cc:forge 回填的 assistant"); continue; }
      const engineMade = m.model === "<synthetic>" || row.isApiErrorMessage === true;
      const blocks = Array.isArray(content) ? content : [{ type: "text", text: String(content || "") }];
      blocks.forEach((b, i) => {
        if (!b) return;
        if (b.type === "text") {
          sink.item({ ...common, id: `a:${row.sessionId}:${row.uuid}:${i}`, role: "assistant", type: "message", model: m.model || "",
            parts: [{ t: "text", text: String(b.text || "") }], generatedBy: engineMade ? "engine" : "model", deliverHint: "text",
            ...(forged ? { forged: true } : {}) });
        } else if (b.type === "thinking" || b.type === "redacted_thinking") {
          sink.opaque({ id: `o:${row.sessionId}:${row.uuid}:${i}`, at, engine: "claude-cli", model: m.model || "", kind: "claude.reasoning",
            payload: { engine: "claude", type: b.type, thinking: b.thinking, signature: b.signature, data: b.data }, source: src });
        } else if (b.type === "tool_use") {
          sink.item({ ...common, id: `t:${b.id}:call`, role: "assistant", type: "tool_call", model: m.model || "",
            call: { id: b.id, name: b.name, server: splitToolName(b.name).server, args: b.input == null ? {} : b.input } });
        } else bump(stats.skipped, `cc:assistant 块 ${b.type}`);
      });
      continue;
    }

    // user
    const isToolResult = Array.isArray(content) && content.some((b) => b && b.type === "tool_result");
    if (isToolResult) {
      for (const b of content) {
        if (!b || b.type !== "tool_result") continue;
        const c = b.content;
        const textOf = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x && x.type === "text").map((x) => x.text || "").join("\n") : "";
        const images = Array.isArray(c) ? c.filter((x) => x && x.type === "image" && x.source && x.source.data)
          .map((x) => sink.blob(Buffer.from(x.source.data, "base64"))) : [];
        const body = sink.text(textOf);
        sink.item({ ...common, id: `t:${b.tool_use_id}:result`, role: "tool", type: "tool_result",
          result: { callId: b.tool_use_id, isError: b.is_error === true, text: body.text, blob: body.blob || null, images },
          ...(body.scrubbed ? { secretsScrubbed: body.scrubbed } : {}) });
      }
      continue;
    }
    const forged = !("entrypoint" in row);
    if (forged && !includeForged) { bump(stats.skipped, "cc:forge 回填的 user"); continue; }
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    const textJoined = blocks.filter((b) => b && b.type === "text").map((b) => b.text || "").join("\n");
    const parts = [];
    const ch = parseChannel(textJoined);
    let producer = row.isMeta ? "engine" : "system";
    let origin = null;
    if (ch && !row.isMeta) {
      producer = "her";
      origin = { platform: ch.attrs.source || "", chat_id: ch.attrs.chat_id || "", native_id: ch.attrs.message_id || "",
        seq: ch.attrs.seq != null && ch.attrs.seq !== "" ? Number(ch.attrs.seq) : null, created_at: ch.attrs.ts || "" };
      if (ch.pack) {
        const h = sha(ch.pack);
        sink.item({ ...common, id: `p:0:${h.slice(0, 16)}:${row.uuid}`, role: "system", type: "marker", kind: "persona_pack",
          meta: { sha256: h, bytes: Buffer.byteLength(ch.pack), reason: "imported" } });
      }
      parts.push({ t: "text", text: ch.body });
    } else {
      parts.push({ t: "text", text: textJoined });
    }
    for (const b of blocks) {
      if (b && b.type === "image" && b.source && b.source.data) {
        parts.push({ t: "image", mime: b.source.media_type || "", blob: sink.blob(Buffer.from(b.source.data, "base64")) });
      }
    }
    sink.item({ ...common, id: `u:imp:${row.sessionId}:${row.uuid}`, role: "user", type: "message", producer,
      ...(producer === "engine" ? { generatedBy: "engine" } : {}), parts, ...(origin ? { origin } : {}), ...(forged ? { forged: true } : {}) });
  }
  return sessionId;
}

// ——— codex rollout ———

function importRollout(file, sink, stats) {
  let lineNo = -1;
  let thread = "";
  let lastUsage = null;
  const textOfContent = (content) => (Array.isArray(content) ? content : [])
    .filter((b) => b && (b.type === "input_text" || b.type === "output_text")).map((b) => b.text || "").join("\n");
  for (const line of readLines(file)) {
    lineNo += 1;
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { bump(stats.skipped, "坏行"); continue; }
    stats.rows += 1;
    const p = o.payload || {};
    const at = o.timestamp || "";
    const src = { file, line: lineNo };
    if (o.type === "session_meta") {
      thread = p.id || p.session_id || "";
      sink.epoch({ at, engine: "codex-appserver", engineThread: thread, cliVersion: p.cli_version || "", historyMode: p.history_mode || "", file });
      continue;
    }
    const common = { at, engine: "codex-appserver", engineThread: thread, source: src };
    if (o.type === "compacted") { bump(stats.skipped, "codex:compacted（历史副本）"); continue; }
    if (o.type === "event_msg") {
      if (p.type === "token_count" && p.info) { lastUsage = p.info.last_token_usage || lastUsage; continue; }
      if (p.type === "context_compacted") {
        sink.item({ ...common, id: `n:${thread}:L${lineNo}:compacted`, role: "system", type: "marker", kind: "engine_compacted", meta: {} });
        continue;
      }
      if (p.type === "task_complete" && p.turn_id) {
        const u = lastUsage || null;
        sink.item({ ...common, id: `e:${thread}:${p.turn_id}`, role: "system", type: "turn_end", status: "ok", synthetic: false, errors: [],
          turnId: p.turn_id, usage: u ? { input: u.input_tokens ?? null, output: u.output_tokens ?? null, cacheRead: u.cached_input_tokens ?? null,
            cacheWrite: null, context: u.total_tokens ?? null } : null });
        continue;
      }
      if (p.type === "turn_aborted" && p.turn_id) {
        sink.item({ ...common, id: `e:${thread}:${p.turn_id}`, role: "system", type: "turn_end", status: "interrupted", synthetic: false,
          errors: [String(p.reason || "")], turnId: p.turn_id, usage: null });
        continue;
      }
      bump(stats.skipped, `codex:event_msg:${p.type}`);
      continue;
    }
    if (o.type !== "response_item") { bump(stats.skipped, `codex:${o.type}`); continue; }
    const key = p.id || `L${lineNo}`;
    switch (p.type) {
      case "message": {
        const text = textOfContent(p.content);
        if (p.role === "developer") { bump(stats.skipped, "codex:developer 指令"); break; }
        if (p.role === "assistant") {
          sink.item({ ...common, id: `a:${thread}:${key}:0`, role: "assistant", type: "message", model: "",
            parts: [{ t: "text", text }], generatedBy: "model", deliverHint: p.phase === "commentary" ? "commentary" : "text" });
          break;
        }
        const parts = [];
        let producer = "system";
        let origin = null;
        const ch = parseChannel(text);
        if (ENGINE_USER_TAGS.test(text)) producer = "engine";
        else if (ch) {
          producer = "her";
          origin = { platform: ch.attrs.source || "", chat_id: ch.attrs.chat_id || "", native_id: ch.attrs.message_id || "",
            seq: ch.attrs.seq ? Number(ch.attrs.seq) : null, created_at: ch.attrs.ts || "" };
        }
        parts.push({ t: "text", text: producer === "her" ? ch.body : text });
        for (const b of Array.isArray(p.content) ? p.content : []) {
          if (b && b.type === "input_image" && typeof b.image_url === "string") {
            const m = /^data:([^;]+);base64,(.*)$/.exec(b.image_url);
            parts.push(m ? { t: "image", mime: m[1], blob: sink.blob(Buffer.from(m[2], "base64")) } : { t: "image", url: b.image_url.slice(0, 200) });
          }
        }
        sink.item({ ...common, id: `u:imp:${thread}:${key}`, role: "user", type: "message", producer,
          ...(producer === "engine" ? { generatedBy: "engine" } : {}), parts, ...(origin ? { origin } : {}) });
        break;
      }
      case "reasoning":
        sink.opaque({ id: `o:${thread}:${key}`, at, engine: "codex-appserver", kind: "codex.reasoning",
          payload: { engine: "codex", encrypted_content: p.encrypted_content, summary: p.summary }, source: src });
        break;
      case "custom_tool_call":
      case "function_call": {
        let args = p.type === "custom_tool_call" ? { input: p.input } : p.arguments;
        if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = { arguments: args }; } }
        sink.item({ ...common, id: `t:${p.call_id}:call`, role: "assistant", type: "tool_call",
          call: { id: p.call_id, name: p.name || "", server: "", args: args || {} } });
        break;
      }
      case "custom_tool_call_output":
      case "function_call_output": {
        const out = p.output;
        const text = typeof out === "string" ? out : Array.isArray(out) ? out.filter((x) => x && x.type === "input_text").map((x) => x.text || "").join("\n")
          : JSON.stringify(out || "");
        const images = Array.isArray(out) ? out.filter((x) => x && x.type === "input_image" && typeof x.image_url === "string")
          .map((x) => { const m = /^data:[^;]+;base64,(.*)$/.exec(x.image_url); return m ? sink.blob(Buffer.from(m[1], "base64")) : null; }).filter(Boolean) : [];
        const body = sink.text(text);
        sink.item({ ...common, id: `t:${p.call_id}:result`, role: "tool", type: "tool_result",
          result: { callId: p.call_id, isError: false, text: body.text, blob: body.blob || null, images },
          ...(body.scrubbed ? { secretsScrubbed: body.scrubbed } : {}) });
        break;
      }
      default:
        bump(stats.skipped, `codex:response_item:${p.type}`);
    }
  }
  return thread;
}

function parseArgs(argv) {
  const a = { claude: [], rollout: [], since: "2026-10-07", out: "", includeForged: false, opaque: false };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === "--claude") a.claude.push(argv[++i]);
    else if (k === "--rollout") a.rollout.push(argv[++i]);
    else if (k === "--since") a.since = argv[++i];
    else if (k === "--out") a.out = argv[++i];
    else if (k === "--include-forged") a.includeForged = true;
    else if (k === "--opaque") a.opaque = true;
    else throw new Error("不认识的参数：" + k);
  }
  return a;
}

/** 列出要导的 CC 文件：给目录就挑 mtime ≥ since 的 *.jsonl，按首行时间排序。 */
function claudeFiles(target, since) {
  const st = fs.statSync(target);
  if (st.isFile()) return [target];
  const sinceMs = since ? new Date(since).getTime() : 0;
  return fs.readdirSync(target).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(target, f))
    .filter((f) => fs.statSync(f).mtimeMs >= sinceMs).sort((x, y) => fs.statSync(x).mtimeMs - fs.statSync(y).mtimeMs);
}

function run(argv, { log = console.log } = {}) {
  const a = parseArgs(argv);
  if (!a.claude.length && !a.rollout.length) throw new Error("要 --claude 或 --rollout（见文件头用法）");
  const out = a.out ? refuseProdOut(a.out) : "";
  const stats = makeStats();
  const sink = createSink({ out, opaque: a.opaque, stats });
  const files = [];
  for (const t of a.claude) {
    for (const f of claudeFiles(t.replace(/^~/, os.homedir()), a.since)) {
      const sid = importClaudeFile(f, sink, stats, { includeForged: a.includeForged });
      sink.epoch({ at: new Date().toISOString(), engine: "claude-cli", engineThread: sid, file: f });
      files.push(f);
    }
  }
  for (const f of a.rollout) { importRollout(f, sink, stats); files.push(f); }
  log(`${out ? "写出到 " + out : "干跑（没写任何东西；加 --out <目录> 才写）"}`);
  log(`读了 ${files.length} 个文件、${stats.rows} 行 → ${stats.items} 条全本记录（约 ${(stats.bytes / 1048576).toFixed(1)} MB）、`
    + `opaque ${stats.opaque}、blob ${stats.blobs}；时间 ${stats.first || "?"} → ${stats.last || "?"}`);
  log("记录种类：" + JSON.stringify(stats.kinds));
  log("跳过的：" + JSON.stringify(stats.skipped));
  log("形状：");
  for (const [k, v] of Object.entries(stats.shapes)) log(`  ${k}: ${v}`);
  return stats;
}

if (require.main === module) {
  try { run(process.argv.slice(2)); }
  catch (e) { console.error("没导：" + e.message); process.exit(1); }
}

module.exports = { run, parseChannel, refuseProdOut, importClaudeFile, importRollout };
