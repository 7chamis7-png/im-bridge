"use strict";
/**
 * 冷层翻看（2026-10-26）—— 只读。
 *
 * 她要「有个面板能查冷层」：按关键词 / 日期 / 谁说的筛，点一条看前后文。
 * 冷层是桥根里的 cold.jsonl（一行一条 {id, role, at, text}），这里一个字都不改。
 * 文件 3 千万字节上下：按 mtime+size 缓存解析结果，没变就不重读。
 */
const fs = require("fs");
const path = require("path");
const i18n = require("./i18n");

const PAGE = 40;
const STREAM = 80;   // 定位页一屏几条
const LEAD = 10;     // 目标前面留几条
const cache = new Map();

function coldFile(ch) {
  const root = String((ch.env && ch.env.GATE_ROOT) || "").trim();
  return root ? path.join(root, "cold.jsonl") : "";
}

function load(file) {
  const st = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.rows;
  const rows = [];
  let bad = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      rows.push({ id: String(r.id || ""), role: r.role, at: Date.parse(r.at || "") || 0, text: String(r.text || "") });
    } catch { bad++; }
  }
  rows.bad = bad;
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, rows });
  return rows;
}

/** 日期按她那边的时区算（面板统一用 i18n.tz()，默认北京时间）。 */
const dayFmt = () => new Intl.DateTimeFormat("en-CA", { timeZone: i18n.tz(), year: "numeric", month: "2-digit", day: "2-digit" });

/**
 * @param {{q?:string, who?:string, d?:string, p?:number, around?:string, start?:string|number}} opts
 */
function query(ch, { q = "", who = "", d = "", p = 1, around = "", start = "" } = {}) {
  const file = coldFile(ch);
  if (!file) return { ok: false, error: "env 里没有 GATE_ROOT" };
  if (!fs.existsSync(file)) return { ok: false, error: `没有冷层文件：${file}` };
  let rows;
  try { rows = load(file); } catch (e) { return { ok: false, error: String(e.message || e) }; }
  const base = { ok: true, file, total: rows.length, bad: rows.bad || 0, first: rows.length ? rows[0].at : 0, last: rows.length ? rows[rows.length - 1].at : 0 };

  // 定位：跳进按时间顺序的整条聊天里，目标那条前面留几条，上下可以接着翻（2026-10-26 她：不要前后几条，直接定位聊天位置）
  if (around || start !== "") {
    let i = -1;
    if (around) {
      i = rows.findIndex((r) => r.id === around);
      if (i < 0) return { ...base, mode: "stream", missing: true, items: [] };
    }
    const from = around ? Math.max(0, i - LEAD) : Math.min(Math.max(0, rows.length - STREAM), Math.max(0, Number(start) || 0));
    const items = rows.slice(from, from + STREAM).map((r) => ({ ...r, focus: !!around && r.id === around }));
    return { ...base, mode: "stream", from, to: from + items.length, prev: from > 0 ? Math.max(0, from - STREAM) : null,
      next: from + STREAM < rows.length ? from + STREAM : null, focusId: around || "", items };
  }

  const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  const fmt = d ? dayFmt() : null;
  const hits = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (who && r.role !== who) continue;
    if (fmt && (!r.at || fmt.format(new Date(r.at)) !== d)) continue;
    if (words.length) {
      const t = r.text.toLowerCase();
      if (!words.every((w) => t.includes(w))) continue;
    }
    hits.push(r);
  }
  // 按日期看：一天之内按先后顺着读更自然
  if (d && !words.length) hits.reverse();
  const pages = Math.max(1, Math.ceil(hits.length / PAGE));
  const page = Math.min(pages, Math.max(1, Number(p) || 1));
  return { ...base, mode: "list", matched: hits.length, page, pages, words, items: hits.slice((page - 1) * PAGE, page * PAGE) };
}

module.exports = { query, coldFile, PAGE };
