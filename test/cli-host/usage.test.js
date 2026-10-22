'use strict';

// /usage 的三家查法（全用桩，不真去请求接口）：
//   Claude：~/.claude/.credentials.json 只读、不刷新；GET https://api.anthropic.com/api/oauth/usage + anthropic-beta: oauth-2025-04-20
//   codex：活着的 app-server 的 account/rateLimits/read（假 app-server）
//   DeepSeek：GET https://api.deepseek.com/user/balance（Bearer，钥匙从 secrets 目录）
// 查不到就明说，不编数字。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { claudeUsage, codexUsage, deepseekBalance } = require('../../cli-host/usage');
const { createCodexAppServer } = require('../../cli-host/codex-appserver');
const { createCliHost } = require('../../cli-host/server');
const { createEngineFactories } = require('../../cli-host/engines');

const FAKE = path.join(__dirname, '..', 'gate', 'lib', 'fake-codex-appserver.js');
fs.chmodSync(FAKE, 0o755);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));

function stubFetch(calls, { status = 200, body = {} } = {}) {
  return async (url, opts) => {
    calls.push({ url, headers: opts.headers, method: opts.method });
    return { ok: status >= 200 && status < 300, status, async text() { return typeof body === 'string' ? body : JSON.stringify(body); } };
  };
}

function creds(dir, { expiresAt = Date.now() + 3600_000, token = 'oat-test' } = {}) {
  const f = path.join(dir, '.credentials.json');
  fs.writeFileSync(f, JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: 'ort-never-used', expiresAt } }));
  return f;
}

test('Claude：跟 CC 自带 /usage 同一个接口、同一组头；5 小时 / 每周两个窗口照搬', async () => {
  const dir = tmp(); const f = creds(dir); const calls = [];
  const before = fs.readFileSync(f, 'utf8');
  const u = await claudeUsage({ credentialsFile: f, fetchImpl: stubFetch(calls, { body: {
    five_hour: { utilization: 37, resets_at: '2026-10-21T13:00:00Z' },
    seven_day: { utilization: 12.25, resets_at: '2026-10-25T00:00:00Z' },
    seven_day_opus: null } }) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].headers.Authorization, 'Bearer oat-test');
  assert.equal(calls[0].headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(u.ok, true);
  assert.deepEqual(u.windows.map((w) => [w.name, w.usedPercent, w.resetsAt]), [
    ['5 小时', 37, '2026-10-21T13:00:00.000Z'], ['每周', 12.3, '2026-10-25T00:00:00.000Z']]);
  assert.equal(fs.readFileSync(f, 'utf8'), before, '凭据文件一个字没动（只读）');
});

test('Claude：token 过期 → 不刷新、不请求，明说；凭据被拒 / 读不到 / 形状不对 → 明说查不到', async () => {
  const dir = tmp(); const calls = [];
  const expired = await claudeUsage({ credentialsFile: creds(dir, { expiresAt: Date.now() - 1000 }), fetchImpl: stubFetch(calls) });
  assert.equal(expired.ok, false); assert.match(expired.why, /过期[\s\S]*不刷新/); assert.equal(calls.length, 0);
  const denied = await claudeUsage({ credentialsFile: creds(dir), fetchImpl: stubFetch(calls, { status: 401, body: { error: 'x' } }) });
  assert.equal(denied.ok, false); assert.match(denied.why, /被拒/);
  const missing = await claudeUsage({ credentialsFile: path.join(dir, 'nope.json'), fetchImpl: stubFetch(calls) });
  assert.equal(missing.ok, false); assert.match(missing.why, /读不到/);
  const odd = await claudeUsage({ credentialsFile: creds(dir), fetchImpl: stubFetch([], { body: { something_else: 1 } }) });
  assert.equal(odd.ok, false); assert.match(odd.why, /没有 five_hour/);
});

test('codex：问活着的 app-server（account/rateLimits/read），primary/secondary 翻成 5 小时 / 每周', async () => {
  const dir = tmp(); const log = path.join(dir, 'rpc.jsonl');
  const driver = createCodexAppServer({ codexPath: FAKE, cwd: dir, home: dir, env: { ...process.env, FAKE_CODEX_LOG: log } });
  const notLive = await codexUsage({ driver });
  assert.equal(notLive.ok, false, '没起 app-server 就不起一个新的去问');
  await driver.ensure();
  const u = await codexUsage({ driver });
  assert.equal(u.ok, true);
  assert.deepEqual(u.windows.map((w) => [w.name, w.usedPercent, w.resetsAt]), [
    ['5 小时', 42, new Date(1792600000 * 1000).toISOString()], ['每周', 7.5, new Date(1793000000 * 1000).toISOString()]]);
  assert.equal(u.plan, 'pro');
  const rpc = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(rpc.some((c) => c.method === 'account/rateLimits/read'));
  await driver.close();
  assert.equal((await codexUsage({})).ok, false);
});

test('codex：实时读不到 → 退回最近一条通知并注明；也没有通知 → 明说', async () => {
  const fail = { readRateLimits: async () => { throw new Error('boom'); }, lastRateLimits: () => null };
  const a = await codexUsage({ driver: fail });
  assert.equal(a.ok, false); assert.match(a.why, /boom/);
  const cached = { readRateLimits: async () => { throw new Error('boom'); },
    lastRateLimits: () => ({ at: '2026-10-21T10:00:00.000Z', snapshot: { primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: null } } }) };
  const b = await codexUsage({ driver: cached });
  assert.equal(b.ok, true); assert.match(b.source, /2026-10-21T10:00/); assert.match(b.note, /boom/);
  assert.equal(b.windows[0].resetsAt, null, '没给的重置时间不编');
});

test('DeepSeek：余额接口（Bearer），总额 / 币种 / 赠送 / 充值照搬；没钥匙、HTTP 错 → 明说', async () => {
  const calls = [];
  const u = await deepseekBalance({ apiKey: 'sk-1', fetchImpl: stubFetch(calls, { body: { is_available: true, balance_infos: [
    { currency: 'CNY', total_balance: '12.34', granted_balance: '2.00', topped_up_balance: '10.34' }] } }) });
  assert.equal(calls[0].url, 'https://api.deepseek.com/user/balance');
  assert.equal(calls[0].headers.Authorization, 'Bearer sk-1');
  assert.equal(u.ok, true); assert.equal(u.kind, 'api');
  assert.deepEqual(u.balances, [{ currency: 'CNY', total: '12.34', granted: '2.00', toppedUp: '10.34' }]);
  assert.equal((await deepseekBalance({ apiKey: '', fetchImpl: stubFetch([]) })).ok, false);
  const bad = await deepseekBalance({ apiKey: 'sk-1', fetchImpl: stubFetch([], { status: 401, body: 'nope' }) });
  assert.equal(bad.ok, false); assert.match(bad.why, /HTTP 401/);
});

test('宿主：/usage 按引擎分派 —— 没起的 claude 读凭据、DeepSeek 用 secrets 里的钥匙、没起的 codex 明说', async () => {
  const dir = tmp(); const calls = [];
  fs.writeFileSync(path.join(dir, 'deepseek.secret'), 'sk-from-secrets\n');
  const fetchImpl = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization });
    const body = String(url).includes('deepseek') ? { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '1.00' }] }
      : { five_hour: { utilization: 5, resets_at: null }, seven_day: { utilization: 1, resets_at: null } };
    return { ok: true, status: 200, async text() { return JSON.stringify(body); } };
  };
  const host = createCliHost({ socketPath: path.join(dir, 'cli.sock'), ingressPath: path.join(dir, 'i.json'), claudePath: process.execPath,
    engine: 'claude', engines: createEngineFactories({ env: {}, stateDir: dir, secretsDir: dir, fetchImpl,
      claudeCredentialsFile: creds(dir) }) });
  const call = (args) => host._internals.usage(args);
  const c = await call({ engine: 'claude-cli' });
  assert.equal(c.ok, true); assert.equal(c.windows[0].usedPercent, 5);
  const d = await call({ engine: 'openai-chat', engineCreds: { secret: 'deepseek' } });
  assert.equal(d.ok, true); assert.equal(d.balances[0].total, '1.00');
  assert.ok(calls.some((x) => x.auth === 'Bearer sk-from-secrets'));
  const x = await call({ engine: 'codex-appserver' });
  assert.equal(x.ok, false); assert.match(x.why, /没在跑/);
  await host.shutdown();
});
