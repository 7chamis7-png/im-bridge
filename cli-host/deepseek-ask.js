'use strict';

/**
 * 给单独那只 DeepSeek 送一句话，把回的字打出来。不经过盒子，不经过微信。
 *   node cli-host/deepseek-ask.js 在吗
 */

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createRemoteRuntime } = require('./client');

const { gateRoot } = require('../src/core/paths');

// 2026-10-22 数据隔离：这几样必须显式给，不再回落 ~/.nova-deepseek / ~/nova（= Nova的目录）
const need = (k, ...alts) => { for (const n of [k, ...alts]) { const v = String(process.env[n] || '').trim(); if (v) return v; }
  console.error(`[deepseek] 没设 ${[k, ...alts].join(' / ')} —— 不回落到别人的目录`); process.exit(2); };
const root = need('DEEPSEEK_ROOT');
const socketPath = process.env.DEEPSEEK_SOCKET || path.join(root, 'deepseek.sock');
const text = process.argv.slice(2).join(' ').trim();
if (!text) {
  console.error('用法: node cli-host/deepseek-ask.js 要说的话');
  process.exit(2);
}
// 生产插座上盒子是唯一的连接。再连一次会把盒子踢掉，她的下一条就没人收。
if (socketPath === path.join(gateRoot(), 'cli.sock') && process.env.DEEPSEEK_ASK_FORCE !== '1') {
  console.error('这只已经接在盒子上。不要从旁边再连，会把盒子踢掉。');
  process.exit(2);
}

const client = createRemoteRuntime({
  socketPath,
  ingressPath: path.join(root, 'state', 'ingress.json'),
  reconnectMs: 200,
  onEvent(payload) {
    if (!payload || !payload.event) return;
    if (payload.event.kind === 'text' && payload.event.text) {
      process.stdout.write(String(payload.event.text).trim() + '\n');
    }
    if (payload.event.kind === 'result') {
      const raw = payload.event.raw || {};
      client.dispose();
      process.exit(raw.subtype === 'success' ? 0 : 1);
    }
  },
});

const timer = setTimeout(() => {
  console.error('等了太久，没有结果。');
  client.dispose();
  process.exit(1);
}, Number(process.env.DEEPSEEK_ASK_TIMEOUT_MS || 100000));
timer.unref?.();

(async () => {
  await client.ensure({
    workspaceRoot: need('DEEPSEEK_CWD', 'GATE_WORKSPACE_ROOT'),
    model: 'deepseek',
    ingressPath: path.join(root, 'state', 'ingress.json'),
  });
  await client.start();
  await client.enqueue({
    uuid: randomUUID(),
    origin: { channel: 'box', threadId: 'box', recipient: 'gate', turnId: `ask-${Date.now()}` },
    message: { type: 'user', message: { role: 'user', content: text }, origin: { kind: 'human' } },
  });
})().catch((error) => {
  console.error(error && error.message ? error.message : error);
  client.dispose();
  process.exit(1);
});
