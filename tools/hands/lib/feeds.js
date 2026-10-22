'use strict';

/**
 * 兴趣源 —— 他在 [SELF_TIME] 里翻的只读 RSS/Atom 白名单。
 *
 * 规则照老 src/services/feed-service.js（2026-09-20 重写进这一包）：
 *   · 只读白名单里的源，他在这儿**不能**随便开网址。Alice可以随时改名单（label + url）。
 *   · 小红书/微博/X 不在这儿 —— 要 RSSHub/Stagehand，那是另一期。
 *   · 单个源 8 秒拿不回来就算这个源失败，不拖别的源。
 *   · 摘要最多 280 字。
 *   · 找不到 `source` 指定的那个源 → **读全部**（老的就是这样，不报错）。
 *   · 每个源最多取 ceil(limit / 源数) 条，至少 1 条；拿到 0 条的源记进 failed。
 *   · 条目顺序 = 哪个源先回来谁在前（并发抓，回来就往里塞），最后整体截到 limit。
 *
 * 名单可以用 HANDS_FEEDS_FILE 换（JSON 数组 [{label,url}]），不给就是下面四个。
 */

const fs = require('node:fs');

const SELF_FEEDS = [
  { label: '少数派', url: 'https://sspai.com/feed' },
  { label: '36氪', url: 'https://www.36kr.com/feed' },
  { label: 'HackerNews', url: 'https://hnrss.org/frontpage' },
  { label: 'TheVerge', url: 'https://www.theverge.com/rss/index.xml' },
];

const FETCH_TIMEOUT_MS = 8_000;
const MAX_SUMMARY_CHARS = 280;
const DEFAULT_LIMIT = 8;

// 装成浏览器：有些源对裸 fetch 回 403
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

/** 名单：给了 HANDS_FEEDS_FILE 就读它，读坏了明说（不悄悄退回默认名单）。 */
function loadFeeds(feedsFile = '') {
  if (!feedsFile) return SELF_FEEDS;
  let list;
  try {
    list = JSON.parse(fs.readFileSync(feedsFile, 'utf8'));
  } catch (e) {
    throw new Error(`兴趣源名单读不了（HANDS_FEEDS_FILE=${feedsFile}）：${e.message}`);
  }
  if (!Array.isArray(list) || !list.length
    || !list.every((f) => f && typeof f.label === 'string' && f.label.trim() && typeof f.url === 'string' && f.url.trim())) {
    throw new Error(`兴趣源名单格式不对（HANDS_FEEDS_FILE=${feedsFile}）：要一个非空数组，每项 {label, url}`);
  }
  return list.map((f) => ({ label: f.label.trim(), url: f.url.trim() }));
}

function resolveFeeds(feeds, source) {
  const wanted = String(source || '').trim().toLowerCase();
  if (!wanted) return feeds;
  const hit = feeds.filter((f) => f.label.toLowerCase() === wanted);
  return hit.length ? hit : feeds; // 认不出就读全部 —— 老规矩
}

/** 拿不到（超时 / 非 2xx / 网络错）一律回空串，由上层记成 failed。 */
async function fetchText(url, { fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: BROWSER_HEADERS, redirect: 'follow' });
    clearTimeout(timer);
    if (!res.ok) return '';
    return await res.text();
  } catch {
    clearTimeout(timer);
    return '';
  }
}

// 去标签 + 解几个常见实体。实体的解码顺序照老的（&amp; 在 &lt; 前面），
// 所以 "&amp;lt;" 会被解两层变成 "<" —— 老的就这样，不改，保证输出一模一样。
function stripTags(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function pickTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? stripTags(m[1]) : '';
}

// Atom 的 <link href="..."/> 优先，其次 RSS 的 <link>...</link>
function pickLink(block) {
  const href = block.match(/<link[^>]*href=["']([^"']+)["']/i);
  if (href) return href[1].trim();
  return pickTag(block, 'link');
}

function parseItems(xml) {
  if (!xml) return [];
  // 有 <entry> 且没有 <item> 才当 Atom
  const isAtom = /<entry[\s>]/i.test(xml) && !/<item[\s>]/i.test(xml);
  const tag = isAtom ? 'entry' : 'item';
  const blocks = xml.match(new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>`, 'gi')) || [];
  const items = [];
  for (const block of blocks) {
    const title = pickTag(block, 'title');
    const summaryRaw = pickTag(block, 'description') || pickTag(block, 'summary') || pickTag(block, 'content');
    if (!title && !summaryRaw) continue; // 标题摘要都没有的条目不要
    items.push({ title, summary: summaryRaw.slice(0, MAX_SUMMARY_CHARS), link: pickLink(block) });
  }
  return items;
}

/** @returns {Promise<{items: {feed,title,summary,link}[], failed: string[]}>} */
async function readFeeds({ source = '', limit = DEFAULT_LIMIT, feeds = SELF_FEEDS, fetchImpl, timeoutMs } = {}) {
  const chosen = resolveFeeds(feeds, source);
  const perFeed = Math.max(1, Math.ceil(limit / chosen.length));
  const items = [];
  const failed = [];
  await Promise.all(chosen.map(async (feed) => {
    const xml = await fetchText(feed.url, { fetchImpl, timeoutMs });
    const parsed = parseItems(xml).slice(0, perFeed);
    if (!parsed.length) {
      failed.push(feed.label);
      return;
    }
    for (const it of parsed) items.push({ feed: feed.label, ...it });
  }));
  return { items: items.slice(0, limit), failed };
}

/** 工具入口那层：limit 的规矩 + 回给他的文字格式（照老 tool-host 的 nova_feed_read）。 */
async function feedRead(args = {}, { feeds = SELF_FEEDS, fetchImpl, timeoutMs } = {}) {
  // 正整数才认，最多 20；别的一律 8
  const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 20) : DEFAULT_LIMIT;
  const { items, failed } = await readFeeds({ source: args.source, limit, feeds, fetchImpl, timeoutMs });
  if (!items.length) {
    return {
      text: `No feed items available right now${failed.length ? ` (failed: ${failed.join(', ')})` : ''}.`,
      data: { items: [], failed },
    };
  }
  const text = items
    .map((it) => `【${it.feed}】${it.title}${it.summary ? `\n${it.summary}` : ''}${it.link ? `\n${it.link}` : ''}`)
    .join('\n\n');
  return { text, data: { items, failed } };
}

module.exports = {
  SELF_FEEDS, FETCH_TIMEOUT_MS, MAX_SUMMARY_CHARS, DEFAULT_LIMIT, BROWSER_HEADERS,
  loadFeeds, resolveFeeds, fetchText, stripTags, pickTag, pickLink, parseItems, readFeeds, feedRead,
};
