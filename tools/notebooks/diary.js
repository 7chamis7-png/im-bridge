'use strict';

/**
 * 日记：按日期读、按关键词搜、往今天（或指定那天）追加一条。
 *
 * 文件 = <diaryDir>/YYYY-MM-DD.md，一天一个。老 diary-service.js 的规矩逐条搬过来：
 *   · 列日期 = 目录里所有 `.md`，去掉扩展名，**字符串倒序**（新的在前）
 *   · 搜之前先 mkdir 日记目录（老代码就这么干，目录不存在时不报错、返回空）
 *   · 关键词**先 trim 判空**（空 = 抛 `query is required.`），但**匹配用的是原样没 trim 的**
 *   · 命中一天就算一个结果；每行命中截「前一行 + 本行 + 后两行」，trim；每天最多 3 段
 *   · 攒够 limit 天就停；limit 不夹紧（0 或负数 = 一天都不要）
 *   · 读某天：读不到 = found:false；空文件也算 found。
 *     调用方给的日期由工具层先验成 YYYY-MM-DD（9-20 起；老的不验）——这里的 readDay 还要给
 *     search 读目录里的任意 .md 用（老的就搜得到非日期文件名），所以不在这层卡
 */

const fs = require('node:fs');
const path = require('node:path');
const { todayInShanghai, assertDate, assertTime } = require('./config');

function listDates(diaryDir) {
  try {
    fs.mkdirSync(diaryDir, { recursive: true });
    return fs.readdirSync(diaryDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function readDay(diaryDir, date = '', now = new Date()) {
  const day = date || todayInShanghai(now);
  const filePath = path.join(diaryDir, `${day}.md`);
  try {
    return { date: day, content: fs.readFileSync(filePath, 'utf8'), found: true, filePath };
  } catch {
    return { date: day, content: null, found: false };
  }
}

function search(diaryDir, { query = '', limit = 5 } = {}) {
  if (!query.trim()) throw new Error('query is required.');
  const results = [];
  for (const date of listDates(diaryDir)) {
    if (results.length >= limit) break;
    const { content, found } = readDay(diaryDir, date);
    if (!found || !content || !content.includes(query)) continue;
    const lines = content.split('\n');
    const excerpts = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes(query)) continue;
      excerpts.push(lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 3)).join('\n').trim());
    }
    results.push({ date, excerpts: excerpts.slice(0, 3) });
  }
  return results;
}

// ——— 写日记（nova_diary_append，2026-09-20 补进这一包：跟搜/读是同一摞文件） ———
//
// 老 diary-service.js append + text-input.js 的规矩：
//   · 正文：String(text||'')，\r\n → \n，trim；空 → 抛 `Diary content cannot be empty. Pass text or textFile.`
//     （报错原文照抄。老服务还认一个 textFile 参数，但工具的 schema 不收它 —— 经工具永远到不了，没搬）
//   · date / time：没给或空串 = 北京时间的今天 / 此刻 HH:MM；给了**必须是 YYYY-MM-DD / HH:MM**
//     （9-20 起，故意比老的严：老的不校验，date 能把路径带出日记目录）
//     ⚠️ 文件名和条目时间都**固定北京时间**，历史日记全是这么记的，别改成走 OUTWARD_TZ
//   · 标题行：有 title（真假值判断）→ `## HH:MM <title.trim()>`，否则 `## HH:MM`
//     （所以全空格的 title 会留下 `## HH:MM ` 带个尾空格，老的也这样）
//   · 一条 = 标题行 + 空行 + 正文；文件已存在且非空 → 前面先垫一个空行（`\n\n`）；追加写，不改旧内容
//   · 写之前 mkdir 日记目录
//   · 返回 { filePath, date, time, body }

function nowHHMM(now = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now);
}

function append(diaryDir, { text = '', title = '', date = '', time = '' } = {}, now = new Date()) {
  const body = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!body) throw new Error('Diary content cannot be empty. Pass text or textFile.');
  if (date) assertDate(date);
  if (time) assertTime(time);
  const day = date || todayInShanghai(now);
  const hhmm = time || nowHHMM(now);
  const filePath = path.join(diaryDir, `${day}.md`);
  const heading = title ? `## ${hhmm} ${String(title).trim()}` : `## ${hhmm}`;
  fs.mkdirSync(diaryDir, { recursive: true });
  const prefix = fs.existsSync(filePath) && fs.statSync(filePath).size > 0 ? '\n\n' : '';
  fs.appendFileSync(filePath, `${prefix}${heading}\n\n${body}`, 'utf8');
  return { filePath, date: day, time: hhmm, body };
}

module.exports = { listDates, readDay, search, append };
