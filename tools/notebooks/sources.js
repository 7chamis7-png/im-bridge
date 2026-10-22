'use strict';

/**
 * 原话搜索（一行一条 JSON）。只读。
 *
 * ## 读哪份（2026-09-20 改）
 *
 * 读**新桥冷层**，路径由 MEMORY_SOURCES_FILE 给（2026-10-21 起没有默认；Nova = /root/.nova-gate/cold.jsonl）。
 * 老的 <家>/conversation-sources.jsonl 9-18 切桥后就冻住了；冷层里是 5-16 起的全量
 * （老那 48474 条同 id 全在，外加切桥后的 `cold-ev-…` 新 id）。
 *
 * 冷层一条只有四个字段 `{id, role, at, text}`（新桥 cold-writer.js 结构上锁死，多一个字段就炸；
 * role 只会是 user / assistant，信封那层也锁着）。老文件是 `receivedAt` + 一堆技术字段。
 * **两种形状都认**：时间取 receivedAt，没有就取 at —— 回给他的还叫 `receivedAt`，
 * 冷层没有的那几栏（accountId / senderId / workspaceRoot / bindingKey / messageId / threadId / turnId）
 * 照老规整器的做法填空串，attachments / attachmentFailures 填 []。
 * 所以他看到的形状跟以前一样，只是那几栏在新数据上永远是空的（文字输出里空栏本来就不打印）。
 *
 * ## 搜索规矩（老 conversation-memory-service.js 逐条搬，**过滤全在这儿，别只抄主循环**）
 *   · 关键词 trim 后判空 → 空就直接返回 []（不抛错）
 *   · 大小写不敏感：关键词和正文都 toLowerCase
 *   · 每行先「规整」再比：坏 JSON 丢；role 不是 user/assistant 的丢；没 id 的现场补一个
 *   · 时间规整成毫秒级 ISO（冷层有微秒的 `…05:16:47.980442Z`，规整后 `.980Z`，老的也这么规整）；
 *     解析不了就用此刻
 *   · 正文先截到 12000 字再比（超长的尾巴带 `...`）——所以搜的是截过的那段
 *   · 取**最后** N 条命中（文件顺序 = 时间顺序，也就是最近的 N 条），不倒序
 *   · N：parseInt 后 ≤0 或不是数 → 20；上限 200
 *   · 读不到文件 = []
 *   · 返回的是规整后的形状（只留固定那几个键，额外键不带出来）
 */

const crypto = require('node:crypto');
const fs = require('node:fs');

const DEFAULT_LIMIT = 20;
const MAX_TEXT_CHARS = 12_000;

function text(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function isoOrEmpty(v) {
  const s = text(v);
  if (!s) return '';
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

function truncate(v, max) {
  const s = text(v);
  const limit = Math.max(1, Number(max) || 1);
  return s.length > limit ? `${s.slice(0, limit)}...` : s;
}

function clampLimit(v, fallback) {
  const n = Number.parseInt(String(v), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 200);
}

function buildSourceId(role, receivedAt, unique) {
  const stamp = receivedAt.replace(/[-:.TZ]/g, '').slice(0, 14);
  const hash = crypto.createHash('sha1').update(`${role}:${receivedAt}:${unique}`).digest('hex').slice(0, 10);
  return `cbmsg-${stamp}-${hash}`;
}

/** 老 normalizeSourceRecord：返回 null = 这行不算数。 */
function normalizeRecord(r) {
  if (!r || typeof r !== 'object') return null;
  const role = text(r.role);
  // 老文件叫 receivedAt，新桥冷层叫 at —— 回出去一律叫 receivedAt
  const receivedAt = isoOrEmpty(r.receivedAt !== undefined ? r.receivedAt : r.at) || new Date().toISOString();
  const id = text(r.id) || buildSourceId(role, receivedAt, r.messageId || r.turnId || crypto.randomUUID());
  if (!id || !['user', 'assistant'].includes(role)) return null;
  return {
    id,
    role,
    accountId: text(r.accountId),
    senderId: text(r.senderId),
    workspaceRoot: text(r.workspaceRoot),
    bindingKey: text(r.bindingKey),
    messageId: text(r.messageId),
    threadId: text(r.threadId),
    turnId: text(r.turnId),
    receivedAt,
    text: truncate(r.text, MAX_TEXT_CHARS),
    attachments: Array.isArray(r.attachments) ? r.attachments.filter(Boolean) : [],
    attachmentFailures: Array.isArray(r.attachmentFailures) ? r.attachmentFailures.filter(Boolean) : [],
  };
}

function readAll(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let rec = null;
    try { rec = normalizeRecord(JSON.parse(s)); } catch { rec = null; }
    if (rec) out.push(rec);
  }
  return out;
}

function search(file, { query = '', limit = DEFAULT_LIMIT } = {}) {
  const needle = text(query).toLowerCase();
  if (!needle) return [];
  return readAll(file)
    .filter((item) => text(item.text).toLowerCase().includes(needle))
    .slice(-clampLimit(limit, DEFAULT_LIMIT));
}

/** 回给他的那段字（老 formatConversationSourceResults）。 */
function formatResults(results) {
  return results.map((item) => {
    const lines = [`### ${item.id}`, '', `role: ${item.role}`, `time: ${item.receivedAt}`];
    if (item.messageId) lines.push(`messageId: ${item.messageId}`);
    if (item.threadId) lines.push(`threadId: ${item.threadId}`);
    if (item.turnId) lines.push(`turnId: ${item.turnId}`);
    if (item.text) lines.push('', item.text);
    if (Array.isArray(item.attachments) && item.attachments.length) {
      lines.push('', 'attachments:');
      for (const a of item.attachments) lines.push(`- ${a.path || a.sourceFileName || a.kind || 'attachment'}`);
    }
    return lines.join('\n');
  }).join('\n\n---\n\n');
}

module.exports = { search, formatResults, normalizeRecord, clampLimit };
