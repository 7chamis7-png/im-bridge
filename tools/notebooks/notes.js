'use strict';

/**
 * 纸条：<纸条目录>/YYYY-MM-DD.json，一天一个 JSON 数组，每条 {ts, text}。
 *
 * 纸条是「想起她但不打扰她」的第三条路 —— 写给她的信，不是待办（9-19 核过内容才留下的）。
 *
 * 老 self-life/notes-store.js 的规矩逐条搬过来：
 *   · text：必须是字符串，trim 后不能空（`Note text cannot be empty.`）
 *   · date：没给或空串 = 北京时间的今天；给了**必须是 YYYY-MM-DD**
 *     （9-20 起，故意比老的严：老的原样拼进路径，`../x` 能写到目录外面）
 *   · 读那天的文件：读不到、坏 JSON、不是数组 —— 都当空数组
 *     ⚠️ 所以坏掉的那天文件会在下一次留纸条时**被整份覆盖**，老的也这样
 *   · 追加一条 {ts: ISO, text} → 整份写回：先写临时文件 `<file>.tmp-<pid>-<8位hex>` 再 rename，
 *     JSON 两格缩进、末尾不带换行；写之前 mkdir
 *   · 读：原样返回数组里的东西，不校验每条长什么样
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { todayInShanghai, assertDate } = require('./config');

function fileFor(notesDir, date) {
  return path.join(notesDir, `${date}.json`);
}

function readList(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function leave(notesDir, { text, date = '' } = {}, now = new Date()) {
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body) throw new Error('Note text cannot be empty.');
  if (date) assertDate(date);
  const day = date || todayInShanghai(now);
  const filePath = fileFor(notesDir, day);
  const list = readList(filePath);
  const entry = { ts: now.toISOString(), text: body };
  list.push(entry);
  writeAtomic(filePath, list);
  return { filePath, date: day, entry, count: list.length };
}

function read(notesDir, { date = '' } = {}, now = new Date()) {
  if (date) assertDate(date);
  const day = date || todayInShanghai(now);
  const filePath = fileFor(notesDir, day);
  return { date: day, filePath, notes: readList(filePath) };
}

module.exports = { leave, read };
