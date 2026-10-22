'use strict';
// S0 实测用的最小 codex app-server 客户端。只在 /tmp/s0 下跑，CODEX_HOME / HOME 都指临时目录。
const { spawn } = require('node:child_process');

function startServer({ extraArgs = [], log = () => {} } = {}) {
  const env = { PATH: process.env.PATH, HOME: '/tmp/s0/home', CODEX_HOME: '/tmp/s0/codex-home' };
  const child = spawn('/usr/local/bin/codex', ['app-server', ...extraArgs], { cwd: '/tmp/s0/codex-ws', env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let nextId = 1;
  const pending = new Map();
  const notes = [];
  const listeners = new Set();
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
        const w = pending.get(msg.id); if (w) { pending.delete(msg.id); msg.error ? w.reject(Object.assign(new Error(msg.error.message || JSON.stringify(msg.error)), { rpc: msg.error })) : w.resolve(msg.result); }
        continue;
      }
      if (msg.id != null && msg.method) {
        log('server request ' + msg.method);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: /[Aa]pproval/.test(msg.method) ? { decision: 'approved' } : {} }) + '\n');
        continue;
      }
      if (msg.method) { notes.push(msg); for (const l of listeners) l(msg); }
    }
  });
  child.stderr.on('data', (d) => { const s = d.toString().trim(); if (s && !/bubblewrap/.test(s)) log('[stderr] ' + s.slice(0, 400)); });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++; pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n');
  async function init({ experimental = false } = {}) {
    const r = await call('initialize', { clientInfo: { name: 's0-probe', version: '0.0.1' }, capabilities: { experimentalApi: experimental, requestAttestation: false } });
    notify('initialized', {});
    return r;
  }
  /** 跑一轮，收齐通知直到 turn/completed（或失败/超时）。 */
  function runTurn(threadId, text, { effort = 'low', timeoutMs = 180000 } = {}) {
    return new Promise((resolve) => {
      const seen = []; let final = ''; let commentary = ''; let usage = null; let done = false;
      const finish = (status, extra = {}) => { if (done) return; done = true; listeners.delete(on); clearTimeout(t); resolve({ status, final, commentary, usage, methods: seen, ...extra }); };
      const on = (msg) => {
        const p = msg.params || {};
        seen.push(msg.method + (p.item && p.item.type ? ':' + p.item.type : ''));
        if (msg.method === 'item/completed' && p.item && p.item.type === 'agentMessage') {
          if (p.item.phase === 'final_answer') final = p.item.text; else commentary += p.item.text;
        }
        if (msg.method === 'thread/tokenUsage/updated') usage = p.tokenUsage;
        if (msg.method === 'turn/completed') finish('completed', { turn: p.turn && { status: p.turn.status, error: p.turn.error } });
        if (msg.method === 'turn/failed' || msg.method === 'error') finish('failed', { error: p });
      };
      listeners.add(on);
      const t = setTimeout(() => finish('timeout'), timeoutMs);
      call('turn/start', { threadId, input: [{ type: 'text', text }], effort }).catch((e) => finish('rpc-error', { error: e.message }));
    });
  }
  function close() { try { child.kill('SIGTERM'); } catch {} }
  return { child, call, notify, init, runTurn, close, notes };
}

module.exports = { startServer };
