#!/usr/bin/env node
'use strict';

/**
 * 远程 MCP（streamable-http）→ 本地 stdio 的薄代理（2026-10-21）。
 *
 * 为什么要它：
 *   · codex 原生 HTTP MCP 连不住（8-02 实测 initialize 完就断 → user cancelled），
 *     而且它不透传环境、headers 也带不过去 —— 包成 stdio 子进程，两边都当本地包用
 *   · 渲染出来的配置里不再出现 headers：钥匙走 env，由桥渲染时从人格自己的 secrets 文件读
 *
 * env（renderer 给）：
 *   MCP_PROXY_URL      远程地址（不含钥匙）
 *   MCP_PROXY_TOKEN    钥匙（可空 = 无认证）
 *   MCP_PROXY_AUTH     bearer（默认）| query:<参数名>（钥匙拼进 URL，如 ?token=）
 *   MCP_PROXY_NAME     日志里叫什么
 *   MCP_PROXY_TIMEOUT_MS  单个请求最长等多久，默认 10 分钟（工具本身可能慢）
 *
 * 做的事就一件：stdin 一行一条 JSON-RPC → POST 过去 → 回包（JSON 或 SSE 的 message 事件）原样写 stdout。
 *   · 记 mcp-session-id，之后每条都带上
 *   · 会话过期（带着会话号吃 404）→ 用记下来的 initialize 重新握手一次再重发
 *   · 出错：有 id 的请求回 JSON-RPC error，别让对面干等
 * ⚠️ 日志只走 stderr，而且**不打印 URL**（query 模式的 URL 里有钥匙）。
 */

const NAME = process.env.MCP_PROXY_NAME || 'remote';
const BASE_URL = process.env.MCP_PROXY_URL || '';
const TOKEN = process.env.MCP_PROXY_TOKEN || '';
const AUTH = process.env.MCP_PROXY_AUTH || 'bearer';
const TIMEOUT_MS = Number(process.env.MCP_PROXY_TIMEOUT_MS) || 600_000;

const log = (m) => { try { process.stderr.write(`[mcp-proxy ${NAME}] ${m}\n`); } catch { /* 无所谓 */ } };

function targetUrl() {
  if (!TOKEN || !AUTH.startsWith('query:')) return BASE_URL;
  const u = new URL(BASE_URL);
  u.searchParams.set(AUTH.slice('query:'.length) || 'token', TOKEN);
  return u.toString();
}

const state = { session: '', protocolVersion: '', initMsg: null };

function writeOut(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

/** 错误信息里别带出钥匙（fetch 的报错有时会带 URL）。 */
function scrub(s) {
  let t = String(s || '');
  if (TOKEN) t = t.split(TOKEN).join('***');
  return t;
}

/** SSE：按空行切事件，取 event 为 message（或没写 event）的 data，拼起来是一条 JSON。 */
function makeSseParser(onMessage) {
  let buf = '';
  const flush = (block) => {
    let event = 'message';
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      let value = i < 0 ? '' : line.slice(i + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (!data.length || event !== 'message') return;
    try { onMessage(JSON.parse(data.join('\n'))); }
    catch (e) { log(`SSE 里有一段不是 JSON：${e.message}`); }
  };
  return {
    push(chunk) {
      buf += chunk;
      let m;
      while ((m = /\r?\n\r?\n/.exec(buf))) {
        const block = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        if (block.trim()) flush(block);
      }
    },
    end() { if (buf.trim()) flush(buf); buf = ''; },
  };
}

/**
 * 发一条，回包逐条交给 onMessage。返回 HTTP 状态码。
 */
async function post(msg, onMessage) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (TOKEN && AUTH === 'bearer') headers.authorization = `Bearer ${TOKEN}`;
  if (state.session) headers['mcp-session-id'] = state.session;
  if (state.protocolVersion) headers['mcp-protocol-version'] = state.protocolVersion;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(targetUrl(), { method: 'POST', headers, body: JSON.stringify(msg), signal: ctl.signal });
    const sid = res.headers.get('mcp-session-id');
    if (sid) state.session = sid;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { status: res.status, errorText: scrub(body).slice(0, 300) };
    }
    const ct = String(res.headers.get('content-type') || '');
    if (ct.includes('text/event-stream') && res.body) {
      const parser = makeSseParser(onMessage);
      const dec = new TextDecoder();
      for await (const chunk of res.body) parser.push(dec.decode(chunk, { stream: true }));
      parser.end();
    } else {
      const raw = await res.text();
      if (raw.trim()) {
        let parsed;
        try { parsed = JSON.parse(raw); }
        catch { return { status: res.status, errorText: `回包不是 JSON：${scrub(raw).slice(0, 200)}` }; }
        for (const m of Array.isArray(parsed) ? parsed : [parsed]) onMessage(m);
      }
    }
    return { status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

async function reinitialize() {
  if (!state.initMsg) return false;
  state.session = '';
  let ok = false;
  const r = await post({ ...state.initMsg, id: `proxy-reinit-${Date.now()}` }, (m) => { if (m && m.result) ok = true; });
  if (!ok || r.status >= 400) return false;
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, () => {}).catch(() => {});
  log('会话过期，重新握手了');
  return true;
}

async function handle(msg) {
  const isRequest = msg && msg.id !== undefined && msg.id !== null && typeof msg.method === 'string';
  if (msg && msg.method === 'initialize') state.initMsg = msg;
  const deliver = (m) => {
    if (m && msg.method === 'initialize' && m.id === msg.id && m.result && m.result.protocolVersion) {
      state.protocolVersion = m.result.protocolVersion;
    }
    writeOut(m);
  };
  const fail = (text) => {
    log(`${msg.method || '回包'} 失败：${text}`);
    if (isRequest) writeOut({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `[${NAME}] ${text}` } });
  };
  try {
    let r = await post(msg, deliver);
    if (r.status === 404 && msg.method !== 'initialize' && state.initMsg && await reinitialize()) {
      r = await post(msg, deliver);
    }
    if (r.status >= 400) fail(`HTTP ${r.status}${r.errorText ? ' ' + r.errorText : ''}`);
  } catch (e) {
    fail(e && e.name === 'AbortError' ? `超时（${Math.round(TIMEOUT_MS / 1000)} 秒）` : scrub(e && e.message || e));
  }
}

function main() {
  if (!BASE_URL) { log('没有 MCP_PROXY_URL，起不来'); process.exit(2); }
  let buf = '';
  let pending = 0;
  let ended = false;
  let barrier = Promise.resolve();
  const maybeExit = () => { if (ended && pending === 0) process.exit(0); };
  process.stdin.on('data', (c) => {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch { log('stdin 来了一行不是 JSON，丢掉'); continue; }
      pending++;
      // 通知（尤其 notifications/initialized）必须先到，后面的请求排在它后面；请求之间并发
      const run = barrier.then(() => handle(msg));
      if (msg && (msg.id === undefined || msg.id === null)) barrier = run.catch(() => {});
      run.finally(() => { pending--; maybeExit(); });
    }
  });
  process.stdin.on('end', () => { ended = true; maybeExit(); });
}

if (require.main === module) main();

module.exports = { makeSseParser };
