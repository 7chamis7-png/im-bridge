'use strict';

/**
 * Send one line to a standalone DeepSeek process and print the reply.
 * Bypasses the box and every channel.
 *
 *   node cli-host/deepseek-ask.js "are you there?"
 */

const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createRemoteRuntime } = require('./client');

function envStr(name, fallback = '') {
  const v = process.env[name];
  return (typeof v === 'string' && v.trim()) ? v.trim() : fallback;
}

const bridgeHome = envStr('IM_BRIDGE_HOME', path.join(os.homedir(), '.im-bridge'));
const gateRoot = envStr('GATE_ROOT', path.join(bridgeHome, 'gate'));
const root = envStr('DEEPSEEK_ROOT', path.join(gateRoot, 'deepseek'));
const socketPath = envStr('DEEPSEEK_SOCKET', path.join(root, 'deepseek.sock'));
const text = process.argv.slice(2).join(' ').trim();
if (!text) {
  console.error('usage: node cli-host/deepseek-ask.js <message>');
  process.exit(2);
}
// The box is the only client of its CLI socket. Connecting a second client
// would kick the box off, and the owner's next message would go unanswered.
if (path.resolve(socketPath) === path.resolve(gateRoot, 'cli.sock') && process.env.DEEPSEEK_ASK_FORCE !== '1') {
  console.error('This socket is the one the box uses; connecting here would disconnect the box. Set DEEPSEEK_ASK_FORCE=1 to override.');
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
  console.error('Timed out waiting for a result.');
  client.dispose();
  process.exit(1);
}, Number(process.env.DEEPSEEK_ASK_TIMEOUT_MS || 100000));
timer.unref?.();

(async () => {
  await client.ensure({
    workspaceRoot: envStr('DEEPSEEK_CWD', envStr('GATE_WORKSPACE_ROOT', process.cwd())),
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
