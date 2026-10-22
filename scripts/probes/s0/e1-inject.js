'use strict';
// E1/E2/E4：inject_items 能不能用、模型认不认、重启 resume 后还在不在、不开 experimentalApi 时 history/path 怎样。
// 用法：node e1-inject.js [--no-turn]
const fs = require('node:fs');
const { startServer } = require('./codex-rpc');
const MODEL = process.env.S0_MODEL || 'gpt-5.6-luna';
const CANARY = 'QX-4719-LANTERN';
const noTurn = process.argv.includes('--no-turn');
const out = {};
const log = (m) => console.log(m);

(async () => {
  let s = startServer({ log });
  out.init = await s.init();
  const started = await s.call('thread/start', { model: MODEL, cwd: '/tmp/s0/codex-ws', approvalPolicy: 'never', sandbox: 'read-only' });
  const threadId = started.thread.id;
  out.threadStartKeys = Object.keys(started); out.threadKeys = Object.keys(started.thread);
  log('thread ' + threadId + ' path=' + started.thread.path);
  const items = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '我们约定一个只有我们俩知道的校验码，由你来定。' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `好，我定的校验码是 ${CANARY}。我记住了。` }] },
  ];
  try { out.inject = await s.call('thread/inject_items', { threadId, items }); log('inject ok ' + JSON.stringify(out.inject)); }
  catch (e) { out.injectError = e.message; log('inject ERR ' + e.message); }
  if (!noTurn) {
    const r = await s.runTurn(threadId, '回答两行，不要别的：第一行写我们刚才约定的校验码；第二行写这个校验码是谁定的（只写「你」或「我」，从你的角度说）。');
    out.turn1 = r; log('turn1 ' + JSON.stringify({ status: r.status, final: r.final, commentary: r.commentary, usage: r.usage && r.usage.total }));
  }
  // rollout 落盘看一眼
  const p = started.thread.path;
  if (p && fs.existsSync(p)) {
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    out.rolloutShape = lines.map((o) => [o.type, o.payload && o.payload.type, o.payload && o.payload.role].filter(Boolean).join(':'));
    out.rolloutHasCanary = lines.filter((o) => JSON.stringify(o).includes(CANARY)).map((o) => [o.type, o.payload && o.payload.type, o.payload && o.payload.role].join(':'));
  }
  s.close();
  await new Promise((r) => setTimeout(r, 1500));

  // E2：新进程 resume
  s = startServer({ log });
  await s.init();
  const resumed = await s.call('thread/resume', { threadId, cwd: '/tmp/s0/codex-ws' });
  out.resumeTurns = (resumed.thread.turns || []).map((t) => ({ status: t.status, items: (t.items || []).map((i) => i.type) }));
  log('resume ok turns=' + JSON.stringify(out.resumeTurns));
  if (!noTurn) {
    const r2 = await s.runTurn(threadId, '再说一次那个校验码，只回校验码。');
    out.turn2 = r2; log('turn2 ' + JSON.stringify({ status: r2.status, final: r2.final }));
  }
  s.close();
  await new Promise((r) => setTimeout(r, 1500));

  // E4：不开 experimentalApi 时带 history / path
  s = startServer({ log });
  await s.init({ experimental: false });
  for (const [name, extra] of [['history', { history: [items[0]] }], ['path', { path: '/tmp/s0/does-not-exist.jsonl' }]]) {
    try { const r = await s.call('thread/resume', { threadId, ...extra }); out['e4_' + name] = { ok: true, thread: r.thread && r.thread.id }; }
    catch (e) { out['e4_' + name] = { ok: false, error: e.message }; }
    log('E4 ' + name + ' ' + JSON.stringify(out['e4_' + name]));
  }
  s.close();
  out.threadId = threadId;
  fs.writeFileSync('/tmp/s0/data-e1.json', JSON.stringify(out, null, 2));
  log('wrote /tmp/s0/data-e1.json');
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
