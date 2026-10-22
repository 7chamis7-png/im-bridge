'use strict';
// E3：一次 inject 多少条 / 多大有没有限制。不跑模型轮，不花额度。
const fs = require('node:fs');
const { startServer } = require('./codex-rpc');
(async () => {
  const s = startServer({ log: (m) => console.log(m) });
  await s.init();
  const res = {};
  const mk = (role, text) => ({ type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] });
  for (const [name, items] of [
    ['500x100B', Array.from({ length: 500 }, (_, i) => mk(i % 2 ? 'assistant' : 'user', `第${i}条 ` + 'x'.repeat(90)))],
    ['2000x100B', Array.from({ length: 2000 }, (_, i) => mk(i % 2 ? 'assistant' : 'user', `第${i}条 ` + 'x'.repeat(90)))],
    ['1x1MB', [mk('user', 'y'.repeat(1 << 20))]],
    ['1x8MB', [mk('user', 'z'.repeat(8 << 20))]],
    ['bad-shape', [{ type: 'message', role: 'assistant', content: [{ type: 'input_text_typo', text: 'x' }] }]],
    ['function-pair', [{ type: 'function_call', name: 'lookup', arguments: '{"q":"x"}', call_id: 'call_s0_1' },
      { type: 'function_call_output', call_id: 'call_s0_1', output: 'ok' }]],
    ['orphan-output', [{ type: 'function_call_output', call_id: 'call_s0_missing', output: 'ok' }]],
  ]) {
    const t = await s.call('thread/start', { model: 'gpt-5.6-luna', cwd: '/tmp/s0/codex-ws', approvalPolicy: 'never', sandbox: 'read-only', ephemeral: false });
    const t0 = Date.now();
    try { await s.call('thread/inject_items', { threadId: t.thread.id, items }); res[name] = { ok: true, ms: Date.now() - t0 }; }
    catch (e) { res[name] = { ok: false, error: e.message.slice(0, 300), ms: Date.now() - t0 }; }
    let lines = 0; try { lines = fs.readFileSync(t.thread.path, 'utf8').split('\n').filter(Boolean).length; } catch {}
    res[name].rolloutLines = lines;
    res[name].historyMode = t.thread.historyMode;
    console.log(name, JSON.stringify(res[name]));
  }
  fs.writeFileSync('/tmp/s0/data-e3.json', JSON.stringify(res, null, 2));
  s.close(); process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
