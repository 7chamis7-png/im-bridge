'use strict';

/**
 * 他的只读浏览器（2026-09-20 从老 src/services/browser-service.js 重写）。
 *
 * 能开任意网址读正文 + 链接、能搜；**不能点、不能填表、不能登录、不能发帖** —— 只导航、只读。
 *
 * 所有数字都照老的，他用了三个月（30 天 358 次，最常用的一个工具），手感别变：
 *   · 每次调用**现起一个无头 chromium、用完就关** —— 不留 profile、不共用任何人的浏览器
 *     （playwright 不给 userDataDir 就是临时目录，跟 browser MCP 那份
 *     /root/.nova/browser-profile 井水不犯河水，也就不需要 DISPLAY）
 *   · 导航/等元素超时 25 秒（page.setDefaultTimeout）；开页面后再等 0.8 秒让脚本把字画出来
 *   · 正文：body.innerText → 三个以上连续换行压成两个 → trim → 截前 4000 字
 *   · 链接：只要 http(s) 且有字的 <a>，按 href 去重，最多 limit 条
 *   · 图片/音视频/字体/样式表一律不下载（省流量省时间，正文用不着）
 *   · 搜索走 DuckDuckGo 的 html 版（不要 JS、不要登录），链接从 uddg 参数里解出真地址
 *   · UA 装成 Mac Chrome 120，语言 zh-CN，窗口 1280×900
 *
 * ⚠️ chromium 要**显式给 executablePath**：playwright-core 自带的版本号跟缓存里装的对不上
 *（6-22 踩过：它默认找的目录不存在），所以自己去 ~/.cache/ms-playwright 挑最新的 chromium-*。
 *
 * 防注入（节点 R-N-1301~1304）的包装在 tools.js 里，这里只管抓。
 */

const fs = require('node:fs');
const path = require('node:path');

const NAV_TIMEOUT_MS = 25_000;
const SETTLE_MS = 800;
const MAX_TEXT_CHARS = 4_000;
const DEFAULT_LIMIT = 10;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BLOCKED_RESOURCES = new Set(['image', 'media', 'font', 'stylesheet']);
const SEARCH_URL = 'https://duckduckgo.com/html/?q=';

/**
 * 挑 chromium：显式给的（且文件在）优先；否则 ~/.cache/ms-playwright 下 chromium-*（跳过 headless 那种）
 * **按目录名字典序倒着**挑第一个有 chrome-linux64/chrome 的。都没有就交给 playwright 自己找。
 * （字典序不是数字序 —— 老的就是这样，目前 1223/1226 同位数，不影响。）
 */
function resolveChromePath({ explicit = '', homeDir = require('node:os').homedir() } = {}) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  const base = path.join(homeDir, '.cache', 'ms-playwright');
  try {
    const dirs = fs.readdirSync(base).filter((d) => d.startsWith('chromium-') && !d.includes('headless')).sort();
    for (const d of dirs.reverse()) {
      const p = path.join(base, d, 'chrome-linux64', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  } catch { /* 目录都没有：往下走 */ }
  return undefined;
}

/** 起一个用完即扔的无头浏览器，挡掉图片/字体/样式，交一页给 fn。无论成败都关掉。 */
async function withPage(fn, { executablePath } = {}) {
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const ctx = await browser.newContext({ userAgent: UA, locale: 'zh-CN', viewport: { width: 1280, height: 900 } });
    await ctx.route('**/*', (route) => (BLOCKED_RESOURCES.has(route.request().resourceType())
      ? route.abort() : route.continue()));
    const page = await ctx.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT_MS);
    return await fn(page);
  } finally {
    await browser.close().catch(() => {});
  }
}

/** DDG 的结果链接是 /l/?uddg=<真地址>，解出来；解不出就原样。 */
function decodeDdgLink(href) {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : href;
  } catch {
    return href;
  }
}

/** 搜：只要有标题的结果，截 limit 条，每条 { title, link }。 */
async function search(query, limit = DEFAULT_LIMIT, opts = {}) {
  return withPage(async (page) => {
    await page.goto(`${SEARCH_URL}${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded' });
    const raw = await page.$$eval('a.result__a', (as) => as.map((a) => ({
      title: a.innerText.trim(), link: a.getAttribute('href') || '' })));
    return raw.filter((r) => r.title).slice(0, limit).map((r) => ({ title: r.title, link: decodeDdgLink(r.link) }));
  }, opts);
}

/** 打开一页：{ title, text（≤4000 字）, links（≤limit 条，按 href 去重） }。 */
async function open(url, limit = DEFAULT_LIMIT, opts = {}) {
  return withPage(async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(SETTLE_MS);
    const title = await page.title();
    const text = (await page.evaluate(() => (document.body ? document.body.innerText : '')))
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, MAX_TEXT_CHARS);
    const links = await page.$$eval('a[href]', (as) => as
      .map((a) => ({ t: a.innerText.trim(), h: a.href }))
      .filter((x) => x.t && /^https?:\/\//.test(x.h)));
    const seen = new Set();
    const outLinks = [];
    for (const l of links) {
      if (seen.has(l.h)) continue;
      seen.add(l.h);
      outLinks.push({ title: l.t, link: l.h });
      if (outLinks.length >= limit) break;
    }
    return { title, text, links: outLinks };
  }, opts);
}

module.exports = {
  search, open, resolveChromePath, decodeDdgLink,
  NAV_TIMEOUT_MS, SETTLE_MS, MAX_TEXT_CHARS, DEFAULT_LIMIT, UA, BLOCKED_RESOURCES,
};
