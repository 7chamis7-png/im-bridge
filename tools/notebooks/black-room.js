'use strict';

/**
 * 小黑屋草稿桶：<家>/black-room/drafts.jsonl，一行一条，只追加。
 *
 * 它**不是**整理过的记忆 —— 不进 memory、不进 relationship、不进日记、不进 LMC-5。
 * 每条正文前面钉一个「〔机器笔迹/小黑屋草稿〕」，谁翻到都知道这是草稿。
 *
 * 老 black-room-service.js 的规矩逐条搬过来：
 *   · kind：trim + 小写后必须是 desire/persona/reflection/closure 之一，否则抛错
 *     （入参 schema 那层**不查 enum**，把关全在这儿）
 *   · title、content：trim 后都不能空（`title and content are required`）
 *   · evidence：不是数组当 []；逐项 trim、扔空项、最多 50 条
 *   · id = blackroom-<ISO 去掉 -: 和毫秒>-<sha1(kind\ntitle\ncontent) 前 16 位>
 *     （摘要用的是**截断之前**的 title/content）
 *   · 存盘时 title 截 160 字、content 截 8000 字再加前缀
 *   · 读：limit 是正整数就取 min(limit,100)，否则 20；kind 不认识 = **不过滤**（不报错）
 *   · 读：按空行切、坏行跳过、按 kind 过滤、取最后 N 条、**新的在前**
 *   · 读不到文件 = 空列表（不建文件）
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const KINDS = new Set(['desire', 'persona', 'reflection', 'closure']);
const PREFIX = '〔机器笔迹/小黑屋草稿〕';

function text(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function kindOf(v) {
  const k = text(v).toLowerCase();
  return KINDS.has(k) ? k : '';
}

function append(file, { kind, title, content, evidence = [] } = {}, now = new Date()) {
  const k = kindOf(kind);
  if (!k) throw new Error('kind must be one of: desire, persona, reflection, closure');
  const t = text(title);
  const c = text(content);
  if (!t || !c) throw new Error('title and content are required');
  const ev = Array.isArray(evidence) ? evidence.map(text).filter(Boolean).slice(0, 50) : [];
  const ts = now.toISOString();
  const digest = crypto.createHash('sha1').update(`${k}\n${t}\n${c}`).digest('hex').slice(0, 16);
  const record = {
    id: `blackroom-${ts.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${digest}`,
    ts,
    kind: k,
    title: t.slice(0, 160),
    content: `${PREFIX}${c.slice(0, 8000)}`,
    evidence: ev,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  return { filePath: file, record };
}

function read(file, { kind = '', limit = 20 } = {}) {
  const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
  const k = kindOf(kind);
  if (!fs.existsSync(file)) return { filePath: file, records: [] };
  const records = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\n+/)) {
    const s = text(line);
    if (!s) continue;
    let rec = null;
    try { rec = JSON.parse(s); } catch { continue; }
    if (!rec) continue; // 老 parseJsonLine 后面跟着 filter(Boolean)：`null` 这种行也扔
    if (k && rec.kind !== k) continue;
    records.push(rec);
  }
  return { filePath: file, records: records.slice(-max).reverse() };
}

module.exports = { append, read, KINDS };
