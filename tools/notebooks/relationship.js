'use strict';

/**
 * relationship.yaml：只改他自己那几栏，Alice那几栏（relationship_phase / her_actual_state …）碰都不碰。
 *
 * ⚠️ `open_threads` 2026-09-19 退役（Alice：「直接全删掉」），线头走笔记本 notebook_open。
 * **别加回来** —— 可写栏里没有它，撞上了就当场说清楚去哪（见 write 开头）。
 *
 * 老 relationship-service.js 的规矩逐条搬过来：
 *   · 可写栏只有五个：my_read_of_her_state · i_owe_her · what_works · watch_out · last_updated
 *   · 不在名单里的键**静默跳过**（入参 schema 那层已经先挡了多余键）；值为 undefined 的也跳过
 *   · 三个列表栏：必须是数组（否则抛 `<key> must be an array of strings.`），逐项 trim、扔空项
 *   · 两个字符串栏：trim（trim 完是空串也照写 —— 等于清空那一栏）
 *   · 一栏都没有 → 抛 `relationship write requires at least one writable field: …`
 *   · last_updated 没给或给了空串 → 现场补当前 ISO 时间；updatedFields 里总会有它（排在最后）
 *   · 写法 = 读出整份 → 盖上这几栏 → 整份重写（注释行、空行排版都会被规整掉，老的也这样）
 *   · 栏的顺序：先按固定顺序（phase/trust/closeness/stability/her_actual_state/他那五栏），
 *     再接文件里原有的其他栏，再接新栏
 *   · 读不到文件 = 从空的开始写；写之前 mkdir 上级目录
 *
 * ## 这份 YAML 解析器是手搓的，不是真 YAML
 *
 * 只认三种行：`key: 值`（顶层）、`  - 值`（列表项）、`  key: 值`（一层嵌套），
 * `#` 开头和空行跳过。值：`[]` = 空数组，引号包着的去引号，纯数字转 number，其余原样。
 * 写：列表写成 `key:` + `  - 项`；空列表 `key: []`；含 `:#[]{},"'` 的用 JSON 双引号包。
 *
 * ## ⚠️ 跟老代码**故意不一样**的三处（都是老代码会悄悄毁数据的洞，生产文件目前一处都没踩到）
 *
 *   1. 读双引号值时老代码只剥引号、不反转义：`"她说\"好\""` 读回来是 `她说\"好\"`，
 *      下次整份重写再转义一遍 → 每写一次反斜杠翻倍。这里先按 JSON 解一次，解不开再剥引号。
 *   2. 写数字时老代码走 normalizeText（只认字符串），数字变成 `""` —— Alice手写的
 *      `trust: 8` 会在他下一次写任何一栏时被清成空。这里数字原样写回。
 *   3. 值里有换行时老代码不加引号，续行在读回来时整行丢掉。这里有换行就用 JSON 双引号包。
 *
 *   这三处写出来的文件老代码照样读得懂（回滚安全），只是老代码读到 `\"`、`\n` 会当字面字符。
 */

const fs = require('node:fs');
const path = require('node:path');

const WRITABLE_FIELDS = ['my_read_of_her_state', 'i_owe_her', 'what_works', 'watch_out', 'last_updated'];
const ARRAY_FIELDS = new Set(['i_owe_her', 'what_works', 'watch_out']);
const STRING_FIELDS = new Set(['my_read_of_her_state', 'last_updated']);
const DEFAULT_FIELD_ORDER = [
  'relationship_phase', 'trust', 'closeness', 'stability', 'her_actual_state',
  'my_read_of_her_state', 'i_owe_her', 'what_works', 'watch_out', 'last_updated',
];

function text(v) {
  return typeof v === 'string' ? v.trim() : '';
}

// ——— 手搓 YAML ———

function parseValue(raw) {
  const s = String(raw || '').trim();
  if (s === '[]') return [];
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    // 改动 1：先按 JSON 反转义，解不开（手写的非法转义之类）再退回老办法只剥引号
    try {
      const v = JSON.parse(s);
      if (typeof v === 'string') return v;
    } catch { /* 退回老办法 */ }
    return s.slice(1, -1);
  }
  // 老代码对单引号也是只剥不解 —— 单引号不会是我们写出去的（我们只写 JSON 双引号），照旧
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function parseYaml(content) {
  const data = {};
  let current = '';
  for (const rawLine of String(content || '').replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const top = line.match(/^([A-Za-z0-9_]+):(?:\s*(.*))?$/);
    if (top) {
      current = top[1];
      data[current] = top[2] ? parseValue(top[2]) : {};
      continue;
    }
    const item = line.match(/^\s+-\s*(.*)$/);
    if (item && current) {
      if (!Array.isArray(data[current])) data[current] = [];
      data[current].push(parseValue(item[1] || ''));
      continue;
    }
    const nested = line.match(/^\s+([A-Za-z0-9_]+):\s*(.*)$/);
    if (nested && current) {
      if (!data[current] || typeof data[current] !== 'object' || Array.isArray(data[current])) data[current] = {};
      data[current][nested[1]] = parseValue(nested[2] || '');
    }
  }
  return data;
}

function formatScalar(value) {
  // 改动 2：数字原样写回（老代码这里会写成 ""）
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  const s = text(value);
  if (!s) return '""';
  // 改动 3：带换行的也包引号（老代码只看下面这串符号）
  if (/[:#\[\]{},"']/.test(s) || /^\s|\s$/.test(s) || /[\r\n]/.test(s)) return JSON.stringify(s);
  return s;
}

/** 老 mergeFieldOrder：先 preferred，再 existing 里没出现过的，保持各自顺序。 */
function mergeOrder(existing, preferred = DEFAULT_FIELD_ORDER) {
  const keys = [];
  for (const k of preferred) if (!keys.includes(k)) keys.push(k);
  for (const k of existing || []) if (!keys.includes(k)) keys.push(k);
  return keys;
}

function stringifyYaml(data, fieldOrder = DEFAULT_FIELD_ORDER) {
  const lines = [];
  for (const key of mergeOrder(Object.keys(data || {}), fieldOrder)) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
    const value = data[key];
    if (Array.isArray(value)) {
      if (!value.length) lines.push(`${key}: []`);
      else {
        lines.push(`${key}:`);
        for (const item of value) lines.push(`  - ${formatScalar(item)}`);
      }
      lines.push('');
      continue;
    }
    if (value && typeof value === 'object') {
      lines.push(`${key}:`);
      for (const [k, v] of Object.entries(value)) lines.push(`  ${k}: ${formatScalar(v)}`);
      lines.push('');
      continue;
    }
    lines.push(`${key}: ${formatScalar(value)}`);
    lines.push('');
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

// ——— 读写 ———

function read(file) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    return { content, data: parseYaml(content), found: true, filePath: file };
  } catch {
    return { content: '', data: {}, found: false, filePath: file };
  }
}

function normalizeUpdates(fields) {
  if (!fields || typeof fields !== 'object') return {};
  const updates = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!WRITABLE_FIELDS.includes(key) || value === undefined) continue;
    if (ARRAY_FIELDS.has(key)) {
      if (!Array.isArray(value)) throw new Error(`${key} must be an array of strings.`);
      updates[key] = value.map(text).filter(Boolean);
      continue;
    }
    if (STRING_FIELDS.has(key)) updates[key] = text(value);
  }
  return updates;
}

function write(file, fields = {}, now = new Date()) {
  // 退役的栏当场说清楚去哪，别让他撞上一句含糊的「没有可写字段」。
  // （经工具进来时 schema 那层会先以 `input.open_threads is not allowed.` 挡掉 —— 老的也是这样。）
  if (fields && Object.prototype.hasOwnProperty.call(fields, 'open_threads')) {
    throw new Error(
      'open_threads 已经退役（2026-09-19）——线头和欠她的事现在走笔记本：notebook_open。'
      + ' 这儿只剩「关系怎么样」那几栏：' + WRITABLE_FIELDS.join(', '),
    );
  }
  const updates = normalizeUpdates(fields);
  if (!Object.keys(updates).length) {
    throw new Error(`relationship write requires at least one writable field: ${WRITABLE_FIELDS.join(', ')}`);
  }
  if (!updates.last_updated) updates.last_updated = now.toISOString();

  const current = read(file);
  const data = { ...(current.data || {}), ...updates };
  const content = stringifyYaml(data, mergeOrder(Object.keys(current.data || {})));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return { filePath: file, updatedFields: Object.keys(updates), data };
}

module.exports = { read, write, parseYaml, stringifyYaml, WRITABLE_FIELDS };
