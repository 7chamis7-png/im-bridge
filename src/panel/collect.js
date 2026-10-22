"use strict";

/**
 * 面板：每个角色的现状。全部只读 —— 唯一的写是错误日志基线，落在面板自己的状态目录。
 *
 * 数据源（全部从这个角色的 env 推，GATE_ROOT 没有就整张卡报错）：
 *   pm2 jlist                         进程状态 / 运行时长 / error log 路径（名字前缀 <id>-）
 *   $GATE_ROOT/state/sessions.json    当前模型（GATE_BINDING_KEY 那条绑定，GATE_WORKSPACE_ROOT 那个工作目录）
 *   $GATE_ROOT/heartbeat.json         上下文水位（桥每 GATE_HEARTBEAT_MS 写一次的 fullness，来自盒子快照）
 *   $GATE_ROOT/state/im-bridge-ingress.json  悬着的入站（state 不是 completed）
 *   $GATE_ROOT/events.jsonl           最后收 / 最后发 / 失败类事件
 *   $GATE_ROOT/model-fallback-alert.json     模型兜底告警
 *   $GATE_ROOT/turns.json · undelivered.jsonl · dead-*.jsonl   卡住的消息（pending-view.js → gate/pending.js 同一套口径）
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { stateDir, readJson, writeJson } = require("./state");
const { readPending } = require("./pending-view");

const DAY_MS = 24 * 60 * 60 * 1000;
/** 账本里算「失败」的事件。 */
const FAIL_KINDS = new Set(["turn.failed", "outbound.unknown", "outbound.blocked", "outbound.not_sent",
  "outbound.partial", "inbound.blocked"]);
const isFailKind = (k) => FAIL_KINDS.has(k) || /\.(failed|error)$/.test(String(k || ""));
/** 失败详情里展示的字段（不带聊天正文 text / preview）。 */
const DETAIL_FIELDS = ["channel", "chatType", "turnId", "outputId", "state", "error", "reason", "why", "detail", "verdict", "verifyReasons", "capability"];

const { L } = require("./i18n");
/** 失败种类的名字（中文原句；页面上过 L）。 */
const KIND_LABEL = {
  "turn.failed": "这一轮失败", "outbound.unknown": "发出去没确认", "outbound.blocked": "发送被拦",
  "outbound.not_sent": "没发出去", "outbound.partial": "只发出一部分", "inbound.blocked": "入站被拦",
  "model.alert": "模型兜底告警", "errlog": "进程错误日志", "ingress.hanging": "入站悬着",
};

// ——— pm2（只读：只跑 jlist）———
function pm2Home(env) {
  return String(env.PM2_HOME || "").trim() || path.join(String(env.HOME || "").trim() || os.homedir(), ".pm2");
}

/** pm2 jlist。守护进程没在跑就不调（jlist 会顺手把守护进程拉起来 = 改状态）。 */
function pm2List(env = process.env) {
  if (env.PANEL_PM2_JSON) { // 测试用：直接给一份 jlist 的 JSON 文件
    return { ok: true, procs: normalizePm2(readJson(env.PANEL_PM2_JSON, [])) };
  }
  const pidFile = path.join(pm2Home(env), "pm2.pid");
  let pid = 0;
  try { pid = Number(fs.readFileSync(pidFile, "utf8").trim()); } catch { /* 没有 */ }
  try { if (!pid) throw 0; process.kill(pid, 0); } catch { return { ok: false, error: L("pm2 守护进程没在跑"), procs: [] }; }
  try {
    const out = execFileSync(env.PANEL_PM2_BIN || "pm2", ["jlist"], { encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"], env: { PATH: env.PATH || "/usr/bin:/bin", HOME: env.HOME || os.homedir(), PM2_HOME: pm2Home(env) } });
    const start = out.indexOf("[");
    return { ok: true, procs: normalizePm2(JSON.parse(out.slice(start))) };
  } catch (e) {
    return { ok: false, error: L("pm2 jlist 失败：{0}", String(e.message || e).split("\n")[0]), procs: [] };
  }
}

/** 只留要用的几个字段 —— jlist 里带着每个进程的整份环境变量（含密钥），一个字都不往下传。 */
function normalizePm2(list) {
  return (Array.isArray(list) ? list : []).map((p) => {
    const e = p.pm2_env || {};
    return { name: String(p.name || ""), status: String(e.status || "unknown"), startedAt: Number(e.pm_uptime) || 0,
      restarts: Number(e.restart_time) || 0, errLog: String(e.pm_err_log_path || "") };
  });
}

// ——— 文件小工具 ———
function readTail(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return { text: buf.toString("utf8"), size, partial: len < size };
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* */ } }
}

const tsOf = (e) => Date.parse(e && (e.at || e.receivedAt || e.registeredAt || e.deliveredAt) || "") || 0;

/**
 * 从账本尾巴往前读：拿到 sinceMs 之后的失败事件，以及最后一条收 / 最后一条发。
 * 最多读 64MB（够几个月）；读到文件头为止。
 */
function scanEvents(file, { sinceMs, now = Date.now() } = {}) {
  const res = { ok: true, fails: [], lastIn: 0, lastOut: 0, coveredSince: 0, exists: true };
  let size;
  try { size = fs.statSync(file).size; } catch { return { ...res, ok: false, exists: false }; }
  let want = 4 * 1024 * 1024;
  for (;;) {
    const t = readTail(file, want);
    if (!t) return { ...res, ok: false };
    let lines = t.text.split("\n");
    if (t.partial) lines = lines.slice(1);
    const fails = [];
    let lastIn = 0, lastOut = 0, earliest = Infinity;
    for (const line of lines) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const at = tsOf(e);
      if (at && at < earliest) earliest = at;
      if (e.kind === "user_input" && at > lastIn) lastIn = at;
      if (e.kind === "outbound.confirmed" && at > lastOut) lastOut = at;
      if (isFailKind(e.kind) && at >= sinceMs) {
        const d = {};
        for (const k of DETAIL_FIELDS) if (e[k] !== undefined && e[k] !== null && e[k] !== "") d[k] = e[k];
        fails.push({ at, type: e.kind, label: KIND_LABEL[e.kind] ? L(KIND_LABEL[e.kind]) : e.kind, source: "events.jsonl", detail: d });
      }
    }
    const enough = !t.partial || (earliest <= sinceMs && lastIn && lastOut) || want >= 64 * 1024 * 1024;
    if (enough) {
      return { ...res, fails, lastIn, lastOut, coveredSince: t.partial ? earliest : 0, size };
    }
    want *= 4;
  }
}

/** 入站 id 里藏着的时间：turn-<毫秒>-n / ev-<base36 毫秒>-n。 */
function idTime(id) {
  const s = String(id || "");
  let m = /^turn-(\d{12,14})-/.exec(s);
  if (m) return Number(m[1]);
  m = /^ev-([0-9a-z]{6,10})-/.exec(s);
  if (m) { const v = parseInt(m[1], 36); return v > 1e12 && v < 1e13 ? v : 0; }
  return 0;
}

function scanIngress(file, now = Date.now()) {
  const j = readJson(file, null);
  if (!j) return { ok: false, exists: fs.existsSync(file) };
  const rows = Array.isArray(j.records) ? j.records : [];
  const hanging = rows.filter((r) => r && r.state !== "completed").map((r) => {
    const o = (r.payload && r.payload.origin) || {};
    const at = idTime(o.turnId) || idTime(r.payload && r.payload.message && r.payload.message.uuid) || 0;
    return { state: String(r.state), at, channel: String(o.channel || ""), turnId: String(o.turnId || ""), error: r.error ? String(r.error).slice(0, 300) : "" };
  });
  const byState = {};
  for (const h of hanging) byState[h.state] = (byState[h.state] || 0) + 1;
  const dated = hanging.filter((h) => h.at).sort((a, b) => a.at - b.at);
  return { ok: true, total: rows.length, hanging, count: hanging.length, byState,
    oldestAt: dated.length ? dated[0].at : 0, undated: hanging.length - dated.length };
}

/** 当前模型：sessions.json 里 GATE_BINDING_KEY 那条绑定（没给就所有绑定）在本工作目录下各 runtime 的 model。 */
function readModels(file, env) {
  const j = readJson(file, null);
  if (!j) return { ok: false, exists: fs.existsSync(file), models: [] };
  const bindings = j.bindings || {};
  const key = String(env.GATE_BINDING_KEY || "").trim();
  const ws = String(env.GATE_WORKSPACE_ROOT || "").trim();
  const picked = key && bindings[key] ? [bindings[key]] : Object.values(bindings);
  const models = [];
  for (const b of picked) {
    const byRt = (b && b.runtimeParamsByWorkspaceRootByRuntime) || {};
    for (const [rt, byWs] of Object.entries(byRt)) {
      const p = (byWs && (byWs[ws] || byWs[b.activeWorkspaceRoot])) || null;
      if (p && p.model && !models.some((m) => m.runtime === rt && m.model === p.model)) models.push({ runtime: rt, model: String(p.model) });
    }
  }
  return { ok: true, models };
}

function readFullness(file, now = Date.now()) {
  const j = readJson(file, null);
  if (!j) return { ok: false, exists: fs.existsSync(file) };
  const f = j.fullness || null;
  const at = Date.parse(j.at || "") || 0;
  if (!f || !(Number(f.limit) > 0)) return { ok: false, exists: true, at, why: "心跳里没有 fullness", model: String((f && f.model) || ""),
    stale: at ? now - at > 5 * 60 * 1000 : true };
  return { ok: true, at, stale: at ? now - at > 5 * 60 * 1000 : true, used: Number(f.used) || 0, limit: Number(f.limit),
    ratio: Number(f.ratio) || 0, model: String(f.model || ""), hasThread: !!f.threadId };
}

function readAlert(file) {
  const j = readJson(file, null);
  if (!j) return { ok: false, exists: fs.existsSync(file) };
  const bad = (j.modelStatus && j.modelStatus !== "normal") || j.sessionLimitAlerted === true;
  return { ok: true, bad: !!bad, status: String(j.modelStatus || ""), lastActual: String(j.lastActual || ""),
    sessionLimitAlerted: !!j.sessionLimitAlerted, at: Date.parse(j.updatedAt || "") || 0 };
}

/**
 * 「此刻真正在用的模型」：只认盒子实测的那个（heartbeat 里的 fullness.model —— 掉档提醒拿来
 * 跟请求的比的也是它）；掉档告警里记着的实际型号次之。sessions.json 里的只是**请求的**，
 * 不冒充实测：两样都没有就是「未确认」（actual 空着，页面自己写）。
 */
function engineOf(models, fullness, alert) {
  const req = (models && models.ok && models.models[0]) || null;
  let actual = "", source = "";
  if (fullness && fullness.model) { actual = fullness.model; source = "heartbeat"; }
  else if (alert && alert.ok && alert.bad && alert.lastActual) { actual = alert.lastActual; source = "alert"; }
  const fallback = !!(alert && alert.ok && alert.status === "fallback");
  return { actual, source, requested: req ? req.model : "", runtime: req ? req.runtime : "",
    others: models && models.ok ? models.models.slice(1) : [], fallback, fallbackActual: fallback ? alert.lastActual : "",
    stale: !!(fullness && fullness.at && fullness.stale), at: (fullness && fullness.at) || 0 };
}

/**
 * pm2 的 error log 没有时间戳 —— 「24 小时内的新错误」靠面板自己记的基线算：
 * 每小时最多记一笔 {at, size}；新错误 = 现在的大小 − 24 小时前（或最早那笔）基线的大小。
 * 没有基线（面板第一次看）就只报「自 现在 起」，不编数字。
 */
function errLogDelta(name, file, { env, now = Date.now(), record = true } = {}) {
  let size;
  try { size = fs.statSync(file).size; } catch { return { ok: false, name, file }; }
  const marksFile = path.join(stateDir(env), "errlog-marks.json");
  const all = readJson(marksFile, {});
  const marks = (all[file] || []).filter((m) => m && now - m.at < 3 * DAY_MS);
  const base = marks.filter((m) => m.at <= now - DAY_MS).pop() || marks[0] || null;
  if (record && (!marks.length || now - marks[marks.length - 1].at >= 60 * 60 * 1000)) {
    marks.push({ at: now, size });
    all[file] = marks;
    try { writeJson(marksFile, all); } catch { /* 状态目录写不了就不记，照样显示 */ }
  }
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { /* */ }
  // 基线不满 24 小时（面板刚开始记）而日志在基线之前、24 小时之内动过：把尾巴 20 行摆出来看
  // （标明「没有基线」，不算成新错误条数）
  const tailOnly = () => {
    const t = mtime > now - DAY_MS ? readTail(file, 16 * 1024) : null;
    return t ? t.text.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-20) : [];
  };
  if (!base) return { ok: true, name, file, since: now, newBytes: 0, newLines: [], baseline: false, mtime, tail: tailOnly() };
  const from = base.size <= size ? base.size : 0; // 变小了 = 被轮转/清空过，从头算
  const len = Math.min(size - from, 256 * 1024);
  let text = "";
  if (len > 0) {
    const t = readTail(file, len);
    text = t ? t.text : "";
  }
  const newLines = text.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
  if (!newLines.length && base.at > now - DAY_MS && mtime < base.at) {
    return { ok: true, name, file, since: base.at, newBytes: 0, newLines: [], baseline: false, mtime, tail: tailOnly() };
  }
  return { ok: true, name, file, since: base.at, newBytes: size - from, newLines, baseline: true };
}

/**
 * 一个角色的卡片数据。任何一项出错只影响那一项。
 * @param {{id, env, error?}} ch
 */
function collectCharacter(ch, { pm2, env = process.env, now = Date.now(), sinceMs = now - DAY_MS, recordMarks = true } = {}) {
  if (ch.error) return { id: ch.id, displayName: ch.displayName, error: ch.error };
  const root = String(ch.env.GATE_ROOT || "").trim();
  if (!root) return { id: ch.id, displayName: ch.displayName, error: L("env 里没有 GATE_ROOT —— 不猜它在哪") };
  const procs = (pm2.procs || []).filter((p) => p.name.startsWith(ch.id + "-"))
    .map((p) => ({ ...p, uptimeMs: p.status === "online" && p.startedAt ? now - p.startedAt : 0 }));
  const events = scanEvents(path.join(root, "events.jsonl"), { sinceMs, now });
  const ingress = scanIngress(path.join(root, "state", "im-bridge-ingress.json"), now);
  const alert = readAlert(path.join(root, "model-fallback-alert.json"));
  const errlogs = procs.filter((p) => p.errLog).map((p) => errLogDelta(p.name, p.errLog, { env, now, record: recordMarks }));

  const failures = [...(events.fails || [])];
  if (alert.ok && alert.bad) {
    failures.push({ at: alert.at, type: "model.alert", label: L(KIND_LABEL["model.alert"]), source: "model-fallback-alert.json",
      detail: { modelStatus: alert.status, lastActual: alert.lastActual, sessionLimitAlerted: alert.sessionLimitAlerted } });
  }
  for (const l of errlogs) {
    if (l.ok && l.newLines && l.newLines.length) {
      failures.push({ at: now, type: "errlog", label: L(KIND_LABEL.errlog) + " · " + l.name, source: l.file,
        detail: { since: l.since, newBytes: l.newBytes }, lines: l.newLines.slice(-40), lineCount: l.newLines.length });
    }
  }
  for (const l of errlogs) {
    if (l.ok && !l.baseline && l.tail && l.tail.length) {
      failures.push({ at: l.mtime, type: "errlog.nobaseline", label: L(KIND_LABEL.errlog) + " · " + l.name + L("（还没有基线，只看尾部）"),
        source: l.file, detail: { 最后修改: l.mtime }, lines: l.tail, lineCount: 0, noBaseline: true });
    }
  }
  failures.sort((a, b) => b.at - a.at);
  const byType = {};
  for (const f of failures) {
    if (f.noBaseline) continue; // 没基线的尾巴只给看，不计数
    byType[f.label] = (byType[f.label] || 0) + (f.type === "errlog" ? f.lineCount : 1);
  }

  const models = readModels(path.join(root, "state", "sessions.json"), ch.env);
  const fullness = readFullness(String(ch.env.GATE_HEARTBEAT_FILE || "").trim() || path.join(root, "heartbeat.json"), now);
  return {
    id: ch.id, displayName: ch.displayName, root,
    pm2: { ok: pm2.ok, error: pm2.error || "", procs },
    models, fullness, engine: engineOf(models, fullness, alert),
    pending: readPending(root),
    ingress, events: { ok: events.ok, exists: events.exists, lastIn: events.lastIn, lastOut: events.lastOut, coveredSince: events.coveredSince },
    alert, errlogs, failures, failureByType: byType, sinceMs,
  };
}

module.exports = { collectCharacter, engineOf, pm2List, normalizePm2, scanEvents, scanIngress, readModels, readFullness, readAlert,
  errLogDelta, idTime, FAIL_KINDS, KIND_LABEL, DAY_MS };
