"use strict";

/**
 * 暖尾巴的排除名单（2026-10-22 Alice）：换舱时她可以挑掉某几轮不带进新舱。
 *
 * 文件：$GATE_ROOT/tail-exclude.json（面板写，原子写 0600）。
 *   { schema, updatedAt, by, entries: [{ id, role, at, sha }] }
 *   id  = 冷层记录的 id（稳定的那个，不按序号）
 *   sha = 这条正文（trim 后）的 sha256；role + sha + 时间（±10 秒）是给「料源 = 全本」那条路认的 ——
 *         全本投影出来的记录 id 跟冷层不同，正文和时间是同一份（history-project.js「跟冷层同口径」）。
 *
 * 读的地方只有一处：scripts/forge.js buildTailFromCold（冷层、全本两条料源都过它）。
 * **冷层原文一个字节都不碰**，只是这一次不带进新舱。
 * 换舱真用掉之后（新舱垫好了），调用方 consume：名单清空、在 tail-exclude-used.jsonl 记一笔（只对下一次生效）。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SCHEMA = "im-bridge.tail-exclude.v1";
const AT_SLACK_MS = 10_000;

const shaOf = (text) => crypto.createHash("sha256").update(String(text || "").trim()).digest("hex");

function tailExcludeFile(gateRoot = process.env.GATE_ROOT) {
  const root = String(gateRoot || "").trim();
  return root ? path.join(root, "tail-exclude.json") : "";
}
function usedLogFile(file) { return file ? path.join(path.dirname(file), "tail-exclude-used.jsonl") : ""; }

function readTailExclude(file = tailExcludeFile()) {
  if (!file) return { entries: [], updatedAt: "" };
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    const entries = Array.isArray(j && j.entries) ? j.entries.filter((e) => e && (e.id || e.sha)) : [];
    return { entries, updatedAt: String((j && j.updatedAt) || ""), by: String((j && j.by) || "") };
  } catch { return { entries: [], updatedAt: "" }; }
}

/** 一条冷层记录 → 排除名单里的那一项。 */
function entryOf(r) {
  return { id: String((r && r.id) || ""), role: String((r && r.role) || ""), at: String((r && (r.receivedAt || r.at)) || ""), sha: shaOf(r && r.text) };
}

/** (record) => 要不要排掉。名单空 = 永远 false。 */
function makeExcluder(fileOrEntries = tailExcludeFile()) {
  const entries = Array.isArray(fileOrEntries) ? fileOrEntries : readTailExclude(fileOrEntries).entries;
  if (!entries.length) return null;
  const ids = new Set(entries.map((e) => String(e.id || "")).filter(Boolean));
  const keyed = entries.filter((e) => e.sha).map((e) => ({ role: e.role, sha: e.sha, ms: Date.parse(e.at || "") || 0 }));
  return (r) => {
    if (!r) return false;
    if (r.id && ids.has(String(r.id))) return true;
    const s = shaOf(r.text);
    const ms = Date.parse(r.receivedAt || r.at || "") || 0;
    return keyed.some((k) => k.sha === s && k.role === r.role && (!k.ms || !ms || Math.abs(k.ms - ms) <= AT_SLACK_MS));
  };
}

function writeTailExclude(file, entries, { by = "panel" } = {}) {
  if (!file) throw new Error("不知道这个角色的桥根目录（GATE_ROOT），排除名单没地方放");
  const body = JSON.stringify({ schema: SCHEMA, updatedAt: new Date().toISOString(), by, entries }, null, 1) + "\n";
  const tmp = file + ".tmp-" + process.pid + "-" + crypto.randomBytes(3).toString("hex");
  fs.writeFileSync(tmp, body, { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, file);
}

/**
 * 换舱用掉了：清空名单，在 tail-exclude-used.jsonl 记一笔（时间、谁用的、新舱号、排了哪些）。名单本来就空 = 什么都不做。
 * 失败不抛（不能因为这个挡住换舱）——返回 { used, error? }。
 */
function consumeTailExclude(file = tailExcludeFile(), { usedBy = "", threadId = "" } = {}) {
  try {
    const cur = readTailExclude(file);
    if (!cur.entries.length) return { used: 0 };
    const log = usedLogFile(file);
    fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), usedBy, threadId: String(threadId || ""),
      count: cur.entries.length, ids: cur.entries.map((e) => e.id).filter(Boolean), listUpdatedAt: cur.updatedAt }) + "\n", { mode: 0o600 });
    writeTailExclude(file, [], { by: "consumed:" + usedBy });
    return { used: cur.entries.length };
  } catch (e) { return { used: 0, error: e.message }; }
}

function readUsedLog(file = tailExcludeFile(), limit = 20) {
  try {
    return fs.readFileSync(usedLogFile(file), "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(-limit).reverse();
  } catch { return []; }
}

module.exports = { tailExcludeFile, usedLogFile, readTailExclude, makeExcluder, writeTailExclude, consumeTailExclude, readUsedLog, entryOf, shaOf, SCHEMA };
