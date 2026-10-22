'use strict';

/**
 * /usage：现在这家引擎的订阅额度 / 余额（Alice 10-21）。**查不到就明说查不到，不编数字。**
 *
 * 三家各查各的，统一成一个形状：
 *   { ok, engine, kind: 'subscription'|'api', windows?: [{key, name, usedPercent, resetsAt(ISO|null)}],
 *     balances?: [{currency, total, granted, toppedUp}], available?, plan?, source, why? }
 *
 * Claude（CLI）—— 跟 Claude Code 自带的 /usage 同一个接口（2.1.292 二进制里读出来的：BASE_API_URL + `/api/oauth/usage`，
 *   头 `Authorization: Bearer <OAuth access token>` + `anthropic-beta: oauth-2025-04-20`；
 *   回 `five_hour` / `seven_day` / `seven_day_opus` / `seven_day_sonnet`，每个 `{utilization(0-100), resets_at(ISO)}`）。
 *   凭据**只读** ~/.claude/.credentials.json 的 claudeAiOauth.accessToken。**不刷新**：过期了就说过期了
 *   （刷新会轮换 refresh token，跟正在跑的 CLI 抢同一份凭据）。
 * codex —— app-server 0.163.0 的 `account/rateLimits/read`（GetAccountRateLimitsResponse.rateLimits：
 *   primary / secondary 各 `{usedPercent, windowDurationMins, resetsAt(unix 秒)}`）；问的是**活着的** app-server。
 *   读不到时退回最近一条 `account/rateLimits/updated` 通知（注明是哪一刻的）。
 * DeepSeek —— 按量计费，没有订阅额度；查余额 GET https://api.deepseek.com/user/balance（官方接口，不扣费）：
 *   `{is_available, balance_infos:[{currency, total_balance, granted_balance, topped_up_balance}]}`。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';
const TIMEOUT_MS = 10_000;

const CLAUDE_WINDOWS = [
  ['five_hour', '5 小时'],
  ['seven_day', '每周'],
  ['seven_day_opus', '每周 · Opus'],
  ['seven_day_sonnet', '每周 · Sonnet'],
];

function pct(v) {
  const n = Number(v);
  return v === null || v === undefined || !Number.isFinite(n) ? null : Math.round(n * 10) / 10;
}

function isoOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function getJson(fetchImpl, url, headers) {
  const res = await fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const raw = await res.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { /* 下面按非 JSON 报 */ }
  return { status: res.status, ok: res.ok, body, raw };
}

/** Claude 订阅额度。credentialsFile 只读；过期不刷新。 */
async function claudeUsage({ credentialsFile = path.join(os.homedir(), '.claude', '.credentials.json'),
  fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const out = { ok: false, engine: 'claude-cli', kind: 'subscription', source: CLAUDE_USAGE_URL };
  let cred;
  try { cred = JSON.parse(fs.readFileSync(credentialsFile, 'utf8')); }
  catch (e) { return { ...out, why: `读不到 ${credentialsFile}（${e.code || e.message}）` }; }
  const oauth = cred && cred.claudeAiOauth;
  const token = oauth && typeof oauth.accessToken === 'string' ? oauth.accessToken.trim() : '';
  if (!token) return { ...out, why: `${credentialsFile} 里没有 claudeAiOauth.accessToken` };
  const exp = Number(oauth.expiresAt);
  if (Number.isFinite(exp) && exp > 0 && exp <= now) {
    return { ...out, why: `OAuth token ${new Date(exp).toISOString()} 已过期 —— 这里不刷新（CLI 下一次用的时候会自己刷）` };
  }
  if (typeof fetchImpl !== 'function') return { ...out, why: '没有 fetch' };
  let r;
  try {
    r = await getJson(fetchImpl, CLAUDE_USAGE_URL, {
      Authorization: `Bearer ${token}`, 'anthropic-beta': CLAUDE_OAUTH_BETA,
      'Content-Type': 'application/json', 'User-Agent': 'im-bridge-usage',
    });
  } catch (e) { return { ...out, why: `请求没成：${e.message}` }; }
  if (r.status === 401 || r.status === 403) return { ...out, why: `凭据被拒（HTTP ${r.status}）—— 可能刚过期，这里不刷新` };
  if (!r.ok || !r.body || typeof r.body !== 'object') return { ...out, why: `HTTP ${r.status}：${String(r.raw || '').slice(0, 120)}` };
  const windows = [];
  for (const [key, name] of CLAUDE_WINDOWS) {
    const w = r.body[key];
    if (!w || typeof w !== 'object') continue;
    const used = pct(w.utilization);
    if (used === null && !w.resets_at) continue;
    windows.push({ key, name, usedPercent: used, resetsAt: isoOrNull(w.resets_at) });
  }
  if (!windows.length) return { ...out, why: '接口回了，但里面没有 five_hour / seven_day（形状变了？）' };
  return { ...out, ok: true, windows };
}

function codexWindowName(mins) {
  const m = Number(mins);
  if (m === 300) return '5 小时';
  if (m === 10080) return '每周';
  if (!Number.isFinite(m) || m <= 0) return '窗口';
  if (m % 1440 === 0) return `${m / 1440} 天`;
  if (m % 60 === 0) return `${m / 60} 小时`;
  return `${m} 分钟`;
}

/** codex 的 RateLimitSnapshot → 统一形状。 */
function fromCodexSnapshot(snap) {
  const windows = [];
  for (const key of ['primary', 'secondary']) {
    const w = snap && snap[key];
    if (!w || typeof w !== 'object') continue;
    windows.push({ key, name: codexWindowName(w.windowDurationMins), usedPercent: pct(w.usedPercent), resetsAt: isoOrNull(w.resetsAt) });
  }
  return { windows, plan: (snap && snap.planType) || '' };
}

/** codex：问活着的 app-server（driver.readRateLimits）；读不到退回最近一条通知。 */
async function codexUsage({ driver } = {}) {
  const out = { ok: false, engine: 'codex-appserver', kind: 'subscription', source: 'account/rateLimits/read' };
  if (!driver || typeof driver.readRateLimits !== 'function') return { ...out, why: 'codex 没在跑（额度要问活着的 app-server）' };
  let why = '';
  try {
    const r = await driver.readRateLimits();
    const snap = r && (r.rateLimits || (r.rateLimitsByLimitId && r.rateLimitsByLimitId.codex));
    const { windows, plan } = fromCodexSnapshot(snap);
    if (windows.length) return { ...out, ok: true, windows, plan };
    why = 'account/rateLimits/read 回了，但没有 primary / secondary';
  } catch (e) { why = `account/rateLimits/read 没成：${e.message}`; }
  const cached = typeof driver.lastRateLimits === 'function' ? driver.lastRateLimits() : null;
  if (cached && cached.snapshot) {
    const { windows, plan } = fromCodexSnapshot(cached.snapshot);
    if (windows.length) return { ...out, ok: true, windows, plan, source: `account/rateLimits/updated（${cached.at} 的通知）`, note: why };
  }
  return { ...out, why };
}

/** DeepSeek 余额。按量计费，没有订阅额度。 */
async function deepseekBalance({ apiKey, baseUrl = 'https://api.deepseek.com', fetchImpl = globalThis.fetch } = {}) {
  const base = String(baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '').replace(/\/(v1|anthropic)$/, '');
  const url = `${base}/user/balance`;
  const out = { ok: false, engine: 'openai-chat', kind: 'api', source: url };
  if (!apiKey) return { ...out, why: `没有钥匙（${require('../src/core/paths').secretsDir()}/<secret>.secret）` };
  if (typeof fetchImpl !== 'function') return { ...out, why: '没有 fetch' };
  let r;
  try { r = await getJson(fetchImpl, url, { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }); }
  catch (e) { return { ...out, why: `请求没成：${e.message}` }; }
  if (!r.ok || !r.body || !Array.isArray(r.body.balance_infos)) return { ...out, why: `HTTP ${r.status}：${String(r.raw || '').slice(0, 120)}` };
  const balances = r.body.balance_infos.map((b) => ({
    currency: String(b.currency || ''), total: String(b.total_balance ?? ''),
    granted: b.granted_balance === undefined ? null : String(b.granted_balance),
    toppedUp: b.topped_up_balance === undefined ? null : String(b.topped_up_balance),
  }));
  return { ...out, ok: true, balances, available: r.body.is_available !== false };
}

module.exports = { claudeUsage, codexUsage, deepseekBalance, fromCodexSnapshot, codexWindowName, CLAUDE_USAGE_URL, CLAUDE_OAUTH_BETA };
