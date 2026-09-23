'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { makeTools, clipBytes } = require('./tools');
const { askGate } = require('../_lib/gate');

const tool = (tools, n) => tools.find((t) => t.name === n);
const fakeAsk = (reply) => { const seen = []; return { seen, fn: async (p) => { seen.push(p); return reply(p); } }; };

test('tg_buttons：交给桥 reply，带 inline_keyboard；callback_data 按字节截到 64', async () => {
  const g = fakeAsk(() => ({ ok: true, channel: 'telegram', unsupportedExtras: [] }));
  const long = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十';
  const r = await tool(makeTools({ askGate: g.fn }), 'tg_buttons').handler({ text: ' 吃啥 ', options: ['火锅', ' 烧烤 ', '火锅', '', long] });
  assert.equal(g.seen[0].tool, 'reply');
  assert.equal(g.seen[0].text, '吃啥');
  const kb = g.seen[0].args.inline_keyboard;
  assert.deepEqual(kb.map((b) => b.text), ['火锅', '烧烤', long]);
  assert.ok(Buffer.byteLength(kb[2].callback_data) <= 64);
  assert.equal(kb[2].callback_data, clipBytes(long));
  assert.equal(r.text, '发出去了。');
});

test('tg_buttons：选项数量 / 截短撞车 / 空话 都拦下，不发', async () => {
  const g = fakeAsk(() => ({ ok: true }));
  const t = tool(makeTools({ askGate: g.fn }), 'tg_buttons');
  await assert.rejects(t.handler({ text: 'x', options: ['一个'] }), /2～8/);
  await assert.rejects(t.handler({ text: 'x', options: Array.from({ length: 9 }, (_, i) => `选${i}`) }), /2～8/);
  const base = '一二三四五六七八九十一二三四五六七八九十一二';
  await assert.rejects(t.handler({ text: 'x', options: [base + '甲', base + '乙'] }), /撞成一样/);
  await assert.rejects(t.handler({ text: ' ', options: ['a', 'b'] }), /text/);
  assert.equal(g.seen.length, 0);
});

test('不在 TG 的轮：字照发、按钮没出去 —— 明说，不假装成功；桥挡下就报错', async () => {
  const g = fakeAsk(() => ({ ok: true, channel: 'wechat', unsupportedExtras: [{ name: 'inline_keyboard', channel: 'wechat', honoredBy: ['telegram'] }] }));
  const r = await tool(makeTools({ askGate: g.fn }), 'tg_buttons').handler({ text: '吃啥', options: ['a', 'b'] });
  assert.match(r.text, /按钮没出去/);
  assert.match(r.text, /wechat/);
  const b = fakeAsk(() => ({ ok: false, reason: 'channel_address_unknown' }));
  await assert.rejects(tool(makeTools({ askGate: b.fn }), 'tg_reply_to').handler({ text: 'x', message_id: '5' }), /没发出去：channel_address_unknown/);
});

test('tg_reply_to：只认数字编号（按钮点击那种编号回不了）', async () => {
  const g = fakeAsk(() => ({ ok: true, channel: 'telegram', unsupportedExtras: [] }));
  const t = tool(makeTools({ askGate: g.fn }), 'tg_reply_to');
  await t.handler({ text: '说的是这条', message_id: ' 40453 ' });
  assert.deepEqual(g.seen[0].args, { reply_to_message_id: 40453 });
  await assert.rejects(t.handler({ text: 'x', message_id: '99-btn-abc' }), /数字编号/);
  assert.equal(g.seen.length, 1);
});

test('整条链路：包 → 真的桥工具口（unix socket）→ TG 腿 → sendMessage 参数', async () => {
  const { makeToolSocket } = require('../../src/gate/tool-socket');
  const { TelegramPlugin } = require('../../src/gate/plugins/telegram');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgpkg-'));
  const calls = [];
  const tg = new TelegramPlugin({ call: async (m, p) => { calls.push([m, p]); return { message_id: 1 }; } });
  const sock = makeToolSocket({ file: path.join(dir, 'tools.sock'),
    outbound: { deliver: async (turn) => { await tg.send({ operationId: 'o', chatId: turn.inboundEvent.chatId,
      text: turn.text, intent: turn.intent, extras: turn.extras, toolArgs: turn.toolArgs }); return { outcome: 'sent', channel: 'telegram' }; } },
    binding: { lookup: () => ({ eventId: 'ev', channel: 'telegram', chatId: '10001' }) },
    activeTurn: () => ({ threadId: 'th', turnId: 'tu' }) });
  await sock.start();
  try {
    const ask = (p) => askGate(p, { socket: path.join(dir, 'tools.sock'), timeoutMs: 5000 });
    const tools = makeTools({ askGate: ask });
    const r1 = await tool(tools, 'tg_buttons').handler({ text: '吃啥', options: ['火锅', '烧烤'] });
    const r2 = await tool(tools, 'tg_reply_to').handler({ text: '这条', message_id: '77' });
    assert.equal(r1.text, '发出去了。');
    assert.equal(r2.text, '发出去了。');
    const sends = calls.filter(([m]) => m === 'sendMessage').map(([, p]) => p);
    assert.deepEqual(sends[0].reply_markup, { inline_keyboard: [[{ text: '火锅', callback_data: '火锅' }], [{ text: '烧烤', callback_data: '烧烤' }]] });
    assert.equal(sends[0].chat_id, '10001');
    assert.equal(sends[1].reply_to_message_id, 77);
  } finally { await sock.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('stdio：agent 看到的名字是 tg_buttons / tg_reply_to', async () => {
  const child = spawn(process.execPath, [path.join(__dirname, 'mcp-server.js')], { stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  const got = new Promise((resolve) => child.stdout.on('data', (c) => {
    buf += c; const line = buf.split('\n').find((l) => l.includes('"id":2')); if (line) resolve(JSON.parse(line));
  }));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  const r = await got;
  child.kill();
  assert.deepEqual(r.result.tools.map((t) => t.name), ['tg_buttons', 'tg_reply_to']);
});
