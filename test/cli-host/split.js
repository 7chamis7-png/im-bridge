'use strict';

/**
 * Wiring tests for the im-cli <-> im-box split.
 *
 * The single criterion: a box restart must not lose (or duplicate) a single message.
 * So these test disconnect behaviour rather than return values:
 * replay of missed events, explicit incomplete-replay signalling, and shape parity with the local runtime.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCliHost } = require('../../cli-host/server');
const { createRemoteRuntime } = require('../../cli-host/client');
const { createEventRing } = require('../../cli-host/protocol');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until a condition holds, at most `timeout` ms. */
async function until(fn, timeout = 3000, step = 20) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'im-cli-test-'));
}

/** Fake runtime: no CLI, same interface shape, and tests can emit events manually. */
function fakeRuntimeFactory(hooks = {}) {
  return function factory(cfg) {
    const rows = [];
    const rt = {
      // Same signature as the real one: enqueue({ message, origin, uuid })
      enqueue(payload) {
        if (hooks.rejectEnqueue) throw new Error('ledger write failed');
        hooks.captureEnqueue?.(payload);
        rows.push({ uuid: payload.uuid, scope: cfg.scope, payload, state: 'pending', error: null });
        return rows[rows.length - 1];
      },
      start: async () => { hooks.onStart?.(cfg); },
      stop: async () => {},
      close: async () => { hooks.onClose?.(); },
      get: (uuid) => rows.find((r) => r.uuid === uuid),
      list: (state) => rows.filter((r) => state === undefined || r.state === state),
      status: () => ({ running: true, stopping: false, initialized: true,
        requestedModel: cfg.sdkOptions?.model || '', actualModel: cfg.sdkOptions?.model || '',
        sessionId: hooks.sessionId || 'sess-fake' }),
      setModel: async () => {},
      done: new Promise(() => {}),   // never settles = CLI stays alive
      /** test helper: emit an event from the CLI side */
      _emit: (payload) => cfg.onEvent(payload),
      /** test helper: exercise canUseTool */
      _ask: (name, input) => cfg.sdkOptions.canUseTool(name, input, { toolUseID: 'tu-1' }),
    };
    hooks.captured?.(rt);
    return rt;
  };
}

async function withPair(hooks, fn) {
  const dir = tmpdir();
  const socketPath = path.join(dir, 'cli.sock');
  const ingressPath = path.join(dir, 'ingress.json');
  let rt;
  const host = createCliHost({
    socketPath, ingressPath, claudePath: '/usr/bin/claude', scope: 'box',
    runtimeFactory: fakeRuntimeFactory({ ...hooks, captured: (r) => { rt = r; } }),
  });
  await host.listen();
  const seen = [];
  const client = createRemoteRuntime({
    socketPath, ingressPath, cursorPath: hooks.cursorPath,
    onEvent: async (p) => { seen.push(p); },
    callbacks: { canUseTool: hooks.canUseTool || (async (n, i) => ({ behavior: 'allow', updatedInput: i })) },
    reconnectMs: 50,
  });
  try {
    await fn({ client, host, seen, socketPath, ingressPath, dir, getRt: () => rt });
  } finally {
    client.dispose();
    await host.shutdown().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ——————————————————————————————————————————————

test('环：没落下就补空数组，落下了就补那几条', () => {
  const ring = createEventRing(5);
  assert.deepStrictEqual(ring.since(0), []);
  ring.push('runtime', { a: 1 });
  ring.push('runtime', { a: 2 });
  assert.strictEqual(ring.since(0).length, 2);
  assert.strictEqual(ring.since(1).length, 1);
  assert.deepStrictEqual(ring.since(2), []);
});

test('环：缺口被挤掉了要明着说补不全，不许假装补全', () => {
  const ring = createEventRing(3);
  for (let i = 0; i < 6; i += 1) ring.push('runtime', { i });
  // only #4 #5 #6 remain; asking after #1 -> incomplete
  assert.strictEqual(ring.since(1), null);
  // asking after #4 -> complete
  assert.deepStrictEqual(ring.since(4).map((f) => f.seq), [5, 6]);
});

test('装配、事件、状态：状态靠事件捎回来，status() 同步可用', async () => {
  await withPair({}, async ({ client, seen, getRt }) => {
    const info = await client.ensure({ workspaceRoot: '/tmp/agent-workspace', model: 'claude-model-x' });
    assert.strictEqual(info.reused, false);
    getRt()._emit({ event: { raw: { type: 'assistant' } }, bindings: [] });
    assert.ok(await until(() => seen.length >= 1), '事件没推过来');
    // The box calls it synchronously: entry.rt.status().sessionId
    assert.strictEqual(client.status().sessionId, 'sess-fake');
    assert.strictEqual(client.status().workspaceRoot, '/tmp/agent-workspace');
  });
});

test('复用：同样的 cwd/模型再 ensure 一次，不换 CLI（= 不打断会话）', async () => {
  let starts = 0;
  await withPair({ onStart: () => { starts += 1; } }, async ({ client }) => {
    await client.ensure({ workspaceRoot: '/tmp/agent-workspace', model: 'm1' });
    const second = await client.ensure({ workspaceRoot: '/tmp/agent-workspace', model: 'm1' });
    assert.strictEqual(second.reused, true, '同样的参数应该复用');
    assert.strictEqual(starts, 1, 'CLI was restarted - that interrupts the session');
  });
});

test('换模型才换 CLI', async () => {
  let starts = 0;
  await withPair({ onStart: () => { starts += 1; } }, async ({ client }) => {
    await client.ensure({ workspaceRoot: '/tmp/agent-workspace', model: 'm1' });
    const second = await client.ensure({ workspaceRoot: '/tmp/agent-workspace', model: 'm2' });
    assert.strictEqual(second.reused, false);
    assert.strictEqual(starts, 2);
  });
});

test('★ 盒子断线期间 agent 产生的事件，重连后一条不少、也一条不重', async () => {
  const dir = tmpdir();
  const cursorPath = path.join(dir, 'cli-cursor.json');
  await withPair({ cursorPath }, async ({ client, seen, socketPath, ingressPath, getRt }) => {
    await client.ensure({ workspaceRoot: '/tmp/agent-workspace' });
    getRt()._emit({ tag: '断线前' });
    assert.ok(await until(() => seen.length === 1));

    // The box goes away (restart) - dispose flushes the cursor to disk.
    client.dispose();
    await sleep(60);

    // Three events while disconnected.
    getRt()._emit({ tag: '断线中-1' });
    getRt()._emit({ tag: '断线中-2' });
    getRt()._emit({ tag: '断线中-3' });

    // The box is back and reads its last seq from the cursor file, so:
    //   - the three events while disconnected are replayed
    //   - the one before the disconnect is NOT repeated (duplicates are as bad as losses)
    const back = [];
    const revived = createRemoteRuntime({
      socketPath, ingressPath, cursorPath,
      onEvent: async (p) => { back.push(p); }, reconnectMs: 30,
    });
    try {
      assert.ok(await until(() => back.length >= 3), `断线期间的话没补回来，只收到 ${back.length} 条`);
      await sleep(100);
      assert.deepStrictEqual(back.map((p) => p.tag),
        ['断线中-1', '断线中-2', '断线中-3'],
        '要么漏了，要么把「断线前」那句又投了一遍');
    } finally { revived.dispose(); }
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('★ 补不全的时候要明着喊 incomplete，不许静默', async () => {
  await withPair({}, async ({ client, host, socketPath, ingressPath, getRt }) => {
    await client.ensure({ workspaceRoot: '/tmp/agent-workspace' });
    client.dispose();
    await sleep(60);
    // Overflow the ring (capacity 2000) so the gap is evicted.
    for (let i = 0; i < 2100; i += 1) getRt()._emit({ i });

    const marks = [];
    const revived = createRemoteRuntime({
      socketPath, ingressPath, onEvent: async (p) => { marks.push(p); }, reconnectMs: 30,
    });
    try {
      assert.ok(await until(() => marks.some((m) => m && m.__incomplete)),
        '缺口被挤掉了却没喊 incomplete —— 这就是静默丢消息');
    } finally { revived.dispose(); }
  });
});

test('工具许可：CLI 那头问，盒子那头答', async () => {
  const asked = [];
  await withPair({
    canUseTool: async (name, input) => { asked.push(name); return { behavior: 'deny', message: '不行' }; },
  }, async ({ client, getRt }) => {
    await client.ensure({ workspaceRoot: '/tmp/agent-workspace' });
    await until(() => client.connected);
    const decision = await getRt()._ask('Bash', { command: 'ls' });
    assert.deepStrictEqual(asked, ['Bash']);
    assert.strictEqual(decision.behavior, 'deny');
  });
});

test('★ 盒子不在的时候，工具许可自己放行 —— 不许卡住会话', async () => {
  await withPair({}, async ({ client, getRt }) => {
    await client.ensure({ workspaceRoot: '/tmp/agent-workspace' });
    client.dispose();
    await sleep(80);
    const decision = await getRt()._ask('Read', { file_path: '/tmp/x' });
    assert.strictEqual(decision.behavior, 'allow', 'box is restarting; the agent must not hang on a tool call');
  });
});

test('enqueue 写不进去要抛错传回来（盒子靠它判断「确定没送进去」）', async () => {
  await withPair({ rejectEnqueue: true }, async ({ client }) => {
    await client.ensure({ workspaceRoot: '/tmp/agent-workspace' });
    // Signature matches the real adapter call site: one object, not three args.
    await assert.rejects(
      () => client.enqueue({ uuid: 'u-1', origin: { channel: 'box' },
        message: { type: 'user', message: { role: 'user', content: 'hi' } } }),
      /ledger write failed/,
    );
  });
});

test('enqueue 的参数原样送到 CLI 那头（形状不能在路上变形）', async () => {
  const got = [];
  await withPair({ captureEnqueue: (p) => got.push(p) }, async ({ client }) => {
    await client.ensure({ workspaceRoot: '/tmp/agent-workspace' });
    const payload = { uuid: 'u-9', origin: { channel: 'box', threadId: 'box', recipient: 'gate' },
      message: { type: 'user', message: { role: 'user', content: 'hello' },
        parent_tool_use_id: null, origin: { kind: 'human' } } };
    await client.enqueue(payload);
    assert.strictEqual(got.length, 1);
    assert.deepStrictEqual(got[0], payload, 'payload 在路上变形了');
  });
});

test('get / list 读的是台账文件，形状跟本地版一样', async () => {
  const dir = tmpdir();
  const ingressPath = path.join(dir, 'ingress.json');
  fs.writeFileSync(ingressPath, JSON.stringify({ version: 1, records: [
    { uuid: 'u-1', scope: 'box', payload: {}, state: 'pending', error: null },
    { uuid: 'u-2', scope: 'box', payload: {}, state: 'completed', error: null },
  ] }) + '\n');
  const { createLedgerView } = require('../../cli-host/ledger-view');
  const view = createLedgerView({ filePath: ingressPath });
  assert.strictEqual(view.list('pending').length, 1);
  assert.strictEqual(view.list().length, 2);
  assert.strictEqual(view.get('u-2').state, 'completed');
  assert.strictEqual(view.get('nope'), undefined);
  // 文件还不存在 = CLI 还没起过，不是错
  assert.deepStrictEqual(createLedgerView({ filePath: path.join(dir, 'nope.json') }).list(), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ——————————————————————————————————————————————

(async () => {
  let pass = 0; const fails = [];
  for (const [name, fn] of tests) {
    try { await fn(); pass += 1; console.log('  ✓', name); }
    catch (e) { fails.push([name, e]); console.log('  ✗', name, '\n     ', e.message); }
  }
  console.log(`\n${pass}/${tests.length} 过`);
  if (fails.length) process.exit(1);
})();
