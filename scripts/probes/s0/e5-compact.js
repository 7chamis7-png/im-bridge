'use strict';
// E5：-c model_auto_compact_token_limit 生不生效；设得比窗口大时撞线是报错还是硬压。
// 用法：node e5-compact.js <名字> <填充词数> [-c k=v ...]
const fs = require('node:fs');
const { startServer } = require('./codex-rpc');
const [name, wordsArg, ...extra] = process.argv.slice(2);
const WORDS = 'river stone lantern copper meadow harbor violet thunder pepper orbit canyon maple velvet signal garden ember quartz willow falcon basket'.split(' ');
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const filler = (n) => Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ');
(async () => {
  const s = startServer({ extraArgs: extra, log: (m) => { if (!/PATH aliases/.test(m)) console.log(m); } });
  await s.init();
  const t = await s.call('thread/start', { model: 'gpt-5.6-luna', cwd: '/tmp/s0/codex-ws', approvalPolicy: 'never', sandbox: 'read-only' });
  const n = Number(wordsArg);
  const per = 2000;
  const items = [];
  for (let i = 0; i < n; i += per) {
    items.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '（背景资料，不用回应）' + filler(Math.min(per, n - i)) }] });
    items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '收到。' }] });
  }
  await s.call('thread/inject_items', { threadId: t.thread.id, items });
  const r1 = await s.runTurn(t.thread.id, '只回两个字母：OK', { timeoutMs: 240000 });
  console.log('turn1', r1.status, JSON.stringify(r1.final), r1.usage && r1.usage.total && r1.usage.total.inputTokens);
  const r = await s.runTurn(t.thread.id, '再回一次：OK', { timeoutMs: 240000 });
  const compactNotes = s.notes.filter((m) => /compact/i.test(m.method) || (m.params && m.params.item && /compact/i.test(m.params.item.type || '')));
  const rollout = fs.readFileSync(t.thread.path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const res = { name, extra, words: n, status: r.status, final: r.final, turn: r.turn, error: r.error,
    usage: r.usage && { total: r.usage.total, last: r.usage.last, window: r.usage.modelContextWindow },
    compactNotifications: compactNotes.map((m) => m.method + (m.params && m.params.item ? ':' + m.params.item.type : '')),
    rolloutCompacted: rollout.filter((o) => o.type === 'compacted' || (o.payload && o.payload.type === 'context_compacted')).length,
    taskStartedWindow: rollout.filter((o) => o.payload && o.payload.type === 'task_started').map((o) => o.payload.model_context_window),
    methods: [...new Set(r.methods)], rateLimits: (s.notes.filter((m) => m.method === 'account/rateLimits/updated').pop() || {}).params };
  console.log(JSON.stringify(res, null, 1));
  fs.writeFileSync(`/tmp/s0/data-e5-${name}.json`, JSON.stringify(res, null, 2));
  s.close(); process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
