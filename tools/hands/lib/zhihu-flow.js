'use strict';

/**
 * 知乎专栏发文 —— 一次调用跑完整套浏览器动作（照老 scripts/zhihu-post.js 重写，2026-09-20）。
 *
 * 来历（别删）：2026-09-12 晚他手动在网页上点着发了一篇《拍品》，一轮 60 次模型调用、
 * 33 次浏览器动作，账单 $16.22（≈¥115），其中 $13.62 是「缓存读」—— 每调一次工具就要把
 * 188k 上下文重读一遍。**贵的不是浏览器，是模型往返的次数。**所以固定动作写死在这里。
 *
 * 为什么不直接调知乎 API：写接口要 z_c0 + _xsrf + __zse_ck 签名，__zse_ck 是知乎自己的
 * 混淆算法，逆出来也会在改版时**静默失效** —— 发不出去还不报错是最坏的形态。
 *
 * 这个文件只放流程本身，浏览器由调用方递进来（生产 = Playwright，测试 = 假页面），
 * 所以每一道闸都能在不开浏览器的情况下测到。
 *
 * 规矩清单：
 *   · title 去空白后为空 → 拒绝；content 全是空白 → 拒绝（正文**不修剪**，原样灌）
 *   · topics 只取前 5 个；不是数组就当没有
 *   · publish 必须**严格等于 true** 才发布，其余一律只存草稿（发布没有撤回键）
 *   · profile 的 SingletonLock 在 = 他自己的 browser 工具开着 → 明说「先 browser_close」。
 *     ⚠️ 用 lstat 不用 exists：SingletonLock 是指向「主机名-pid」的**符号链接**，
 *     目标不存在时 exists 返回 false，这道闸就等于没装（2026-09-12 第一次实测就漏过去了）
 *   · 先验登录态（z_c0 cookie 要有值），别写完一整篇才发现没登录
 *   · 正文用 insertText 一次塞进去，**不许逐字敲**（8000 字敲两分多钟）
 *   · 灌完读回来：进去的字数 < min(原文 × 0.5, 200) → 不往下走
 *   · 话题一个一个加，某个加不上只记一笔，不拦整篇
 *   · 发布判据：地址栏从 /edit 跳到 /p/<数字>，每 2 秒看一次、看 20 次（40 秒）；
 *     没跳 → state=unknown，叫他去后台看，**别重复发**
 *   · Playwright 报「profile 被占用」也翻译成同一句人话，并带 busy:true
 *   · 不管怎么结束都关掉浏览器
 */

const fs = require('node:fs');
const path = require('node:path');

const BUSY_MSG = '浏览器 profile 正被占用——你自己的 browser 工具开着 chromium。把它关掉（browser_close）再调我。';
const BUSY_RE = /existing browser session|already in use/i;

function checkArgs(args = {}) {
  const title = String(args.title || '').trim();
  const content = String(args.content || '');
  const topics = Array.isArray(args.topics) ? args.topics.slice(0, 5) : [];
  const publish = args.publish === true; // ⚠️ 默认只存草稿
  if (!title) return { error: 'title 不能为空' };
  if (!content.trim()) return { error: 'content 不能为空' };
  return { title, content, topics, publish };
}

function profileLocked(profile) {
  try { return !!fs.lstatSync(path.join(profile, 'SingletonLock')); } catch { return false; }
}

/**
 * @param {object} args  { title, content, topics, publish }
 * @param {object} o     { chromium, profile }
 * @returns {Promise<object>} 跟老脚本 stdout 最后一行同一个形状：{ ok, state?, id?, url?, editUrl?, chars?, error?, busy?, log? }
 */
async function runZhihuPost(args, { chromium, profile }) {
  const a = checkArgs(args);
  if (a.error) return { ok: false, error: a.error };
  const { title, content, topics, publish } = a;

  if (profileLocked(profile)) return { ok: false, busy: true, error: BUSY_MSG };

  let ctx;
  const log = [];
  try {
    ctx = await chromium.launchPersistentContext(profile, {
      headless: false, args: ['--no-sandbox'], viewport: { width: 1280, height: 900 },
    });
    const page = ctx.pages()[0] || await ctx.newPage();

    await page.goto('https://www.zhihu.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    const zc = (await ctx.cookies('https://www.zhihu.com')).find((c) => c.name === 'z_c0' && c.value);
    if (!zc) return { ok: false, error: '知乎未登录（没有 z_c0）。让 Keeper 重新扫码。' };
    log.push('登录态 ok');

    await page.goto('https://zhuanlan.zhihu.com/write', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);

    const titleBox = page.locator("textarea[placeholder*='标题'], input[placeholder*='标题']").first();
    await titleBox.click({ timeout: 20000 });
    await titleBox.fill(title);
    log.push('标题已填');

    const editor = page.locator('.public-DraftEditor-content').first();
    await editor.click({ timeout: 20000 });
    await page.waitForTimeout(500);
    await page.keyboard.insertText(content);
    await page.waitForTimeout(2500);
    const written = await editor.innerText().catch(() => '');
    log.push(`正文已灌入 ${written.length} 字`);
    if (written.length < Math.min(content.length * 0.5, 200)) {
      return { ok: false, error: `正文只进去 ${written.length} 字（应为 ${content.length}），没敢往下走`, log };
    }

    for (const t of topics) {
      try {
        await page.locator('text=添加话题').first().click({ timeout: 10000 });
        const box = page.locator("input[placeholder*='搜索话题']").first();
        await box.click({ timeout: 10000 });
        await box.fill(t);
        await page.waitForTimeout(2500);
        await page.locator(`text="${t}"`).last().click({ timeout: 8000 });
        await page.waitForTimeout(1200);
        log.push(`话题 ${t} 已加`);
      } catch (e) {
        log.push(`话题 ${t} 没加上: ${String(e && e.message).slice(0, 60)}`);
      }
    }

    // 草稿此时已自动保存，地址里带文章 id
    await page.waitForTimeout(2000);
    let url = page.url();
    let id = (url.match(/\/p\/(\d+)/) || [])[1] || '';

    if (!publish) {
      log.push('只存草稿，没点发布');
      return { ok: true, state: 'draft', id, url,
        editUrl: id ? `https://zhuanlan.zhihu.com/p/${id}/edit` : url, chars: written.length, log };
    }

    await page.locator('button', { hasText: /^发布$/ }).first().click({ timeout: 20000 });
    for (let i = 0; i < 20; i += 1) {
      await page.waitForTimeout(2000);
      url = page.url();
      if (/\/p\/\d+$/.test(url)) {
        id = (url.match(/\/p\/(\d+)/) || [])[1] || id;
        log.push('已发布（地址栏跳到正文页）');
        return { ok: true, state: 'published', id, url, chars: written.length, log };
      }
    }
    return { ok: false, state: 'unknown', id, url,
      error: '点了发布但 40 秒内地址栏没跳走——可能在审核或被拦。去后台看一眼，别重复发。', log };
  } catch (e) {
    const msg = String((e && e.message) || e);
    const busy = BUSY_RE.test(msg);
    return { ok: false, busy, error: busy ? BUSY_MSG : msg, log };
  } finally {
    try { await ctx?.close(); } catch { /* 已关 */ }
  }
}

module.exports = { runZhihuPost, checkArgs, profileLocked, BUSY_MSG };
