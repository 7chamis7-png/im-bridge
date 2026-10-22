'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDeepseekRuntime, resolveDeepseekConfig } = require('../../cli-host/deepseek-runtime');
const { createCliHost } = require('../../cli-host/server');
const { createRemoteRuntime } = require('../../cli-host/client');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nova-deepseek-'));
}

function env(extra = {}) {
  return {
    DEEPSEEK_API_KEY: 'test-key',
    NOVA_DEEPSEEK_API_KEY: '',
    CYBERBOSS_REBUILD_OPENAI_API_KEY: '',
    ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_BASE_URL: '',
    NOVA_DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
    NOVA_DEEPSEEK_MODEL: 'deepseek-chat',
    GATE_ROOT: '',
    GATE_COLD_FILE: '',
    ...extra,
  };
}

function userMessage(text) {
  return { type: 'user', message: { role: 'user', content: text }, origin: { kind: 'human' } };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERR',
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}

function replyFetch(text, calls) {
  return async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body), authorization: opts.headers.authorization });
    return jsonResponse({
      model: 'deepseek-chat',
      choices: [{ message: { role: 'assistant', content: text } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });
  };
}

async function until(fn, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return false;
}

test('地址和模型：脱掉 [1m]，anthropic 那个根改回补全接口', () => {
  const cfg = resolveDeepseekConfig({
    NOVA_DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic/',
    NOVA_DEEPSEEK_MODEL: 'deepseek-flash[1m]',
    DEEPSEEK_API_KEY: 'k',
  });
  assert.equal(cfg.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(cfg.model, 'deepseek-flash');
  assert.equal(cfg.key, 'k');
});

test('没有钥匙：还没落盘就拒绝，并标 notAccepted', async () => {
  const dir = tmp();
  let called = false;
  const rt = createDeepseekRuntime({
    ingressPath: path.join(dir, 'ingress.json'),
    threadFile: path.join(dir, 'thread.json'),
    coldFile: '',
    env: env({ DEEPSEEK_API_KEY: '' }),
    fetchImpl: async () => { called = true; throw new Error('不该打到网上'); },
  });
  await rt.start();
  await assert.rejects(
    async () => rt.enqueue({ uuid: 'u1', origin: { turnId: 't1' }, message: userMessage('在吗') }),
    (error) => error.notAccepted === true && !String(error.message).includes('test-key'),
  );
  assert.equal(called, false);
  assert.equal(rt.list('pending').length, 0);
  await rt.close();
});

test('一轮：正文进候选，result 成功，第二轮带上上一轮', async () => {
  const dir = tmp();
  const calls = [];
  const seen = [];
  const rt = createDeepseekRuntime({
    ingressPath: path.join(dir, 'ingress.json'),
    threadFile: path.join(dir, 'thread.json'),
    coldFile: '',
    cwd: dir,
    sdkOptions: { systemPrompt: '你是Nova。', model: 'claude-fable-5[1m]' },
    env: env(),
    fetchImpl: replyFetch('在。', calls),
    onEvent: async (payload) => { seen.push(payload); },
  });
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '声线：短。');
  await rt.start();
  const sid = rt.status().sessionId;
  assert.ok(sid.startsWith('ds-'), sid);

  await rt.enqueue({ uuid: 'u1', origin: { channel: 'box', threadId: 'box', recipient: 'gate', turnId: 't1' }, message: userMessage('在吗') });
  assert.ok(await until(() => seen.some((row) => row.event.kind === 'turn.end')));

  const text = seen.find((row) => row.event.kind === 'text');
  const result = seen.find((row) => row.event.kind === 'turn.end');
  assert.equal(text.event.text, '在。');
  // S2b：插头直接吐通用事件 imb.event.v1（不再拼假 Claude 帧）
  assert.equal(text.event.v, 'imb.event.v1');
  assert.equal(text.event.engine, 'openai-chat');
  assert.equal(text.event.deliverHint, 'text');
  assert.equal(text.event.generatedBy, 'model');
  assert.equal(text.event.model, 'deepseek-chat');
  assert.equal(text.event.turn, 'u1');
  assert.equal(text.bindings[0].uuid, 'u1');
  assert.equal(text.bindings[0].origin.turnId, 't1');
  assert.equal(result.event.status, 'ok');
  assert.equal(rt.get('u1').state, 'completed');
  assert.equal(calls[0].authorization, 'Bearer test-key');
  assert.ok(calls[0].body.messages.some((row) => row.role === 'system' && row.content.includes('你是Nova。')));
  assert.ok(calls[0].body.messages.some((row) => row.content.includes('声线：短。')));
  assert.equal(calls[0].body.model, 'deepseek-chat');
  assert.deepEqual(calls[0].body.thinking, { type: 'disabled' });
  assert.equal(calls[0].body.messages.some((row) => String(row.content).includes('只能回文字')), false);
  assert.ok(calls[0].body.tools.some((tool) => tool.function.name === 'Read'));
  assert.equal(calls[0].body.messages.at(-1).content, '在吗');

  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'thread.json'), 'utf8'));
  assert.equal(saved.schema, 'nova.deepseek-thread.v1');
  assert.deepEqual(saved.messages.map((row) => row.content), ['在吗', '在。']);

  await rt.enqueue({ uuid: 'u2', origin: { turnId: 't2' }, message: userMessage('还在吗') });
  assert.ok(await until(() => rt.get('u2')?.state === 'completed'));
  assert.equal(calls[1].body.messages.some((row) => row.role === 'assistant' && row.content === '在。'), true);
  assert.equal(calls[1].body.messages.at(-1).content, '还在吗');
  await rt.close();
});

test('接口失败：result 不是 success，台账标 uncertain，不把钥匙写进错误', async () => {
  const dir = tmp();
  const seen = [];
  const rt = createDeepseekRuntime({
    ingressPath: path.join(dir, 'ingress.json'),
    threadFile: path.join(dir, 'thread.json'),
    coldFile: '',
    env: env({ DEEPSEEK_API_KEY: 'sk-do-not-leak' }),
    fetchImpl: async () => jsonResponse('{"error":{"message":"bad key"}}', 401),
    onEvent: async (payload) => { seen.push(payload); },
  });
  await rt.start();
  await rt.enqueue({ uuid: 'u1', origin: { turnId: 't1' }, message: userMessage('喂') });
  assert.ok(await until(() => seen.some((row) => row.event.kind === 'turn.end')));
  const result = seen.find((row) => row.event.kind === 'turn.end');
  assert.equal(result.event.status, 'error');
  assert.equal(result.event.errors.some((line) => line.includes('sk-do-not-leak')), false);
  assert.equal(rt.get('u1').state, 'uncertain');
  await rt.close();
});

test('别人留下的 pending 不重放；自己没跑完的会补', async () => {
  const dir = tmp();
  const ingressPath = path.join(dir, 'ingress.json');
  const foreign = {
    uuid: 'old', scope: 'box', state: 'pending', error: null,
    payload: { uuid: 'old', origin: { turnId: 't-old' }, message: userMessage('旧的，别发') },
  };
  const mine = {
    uuid: 'mine', scope: 'box', state: 'pending', error: null,
    payload: { uuid: 'mine', origin: { turnId: 't-mine' }, message: userMessage('补上'), brain: 'deepseek' },
  };
  fs.writeFileSync(ingressPath, JSON.stringify({ version: 1, records: [foreign, mine] }) + '\n');
  const calls = [];
  const rt = createDeepseekRuntime({
    ingressPath,
    threadFile: path.join(dir, 'thread.json'),
    coldFile: '',
    env: env(),
    fetchImpl: replyFetch('补好了', calls),
  });
  await rt.start();
  assert.ok(await until(() => rt.get('mine')?.state === 'completed'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.messages.at(-1).content, '补上');
  assert.equal(rt.get('old').state, 'pending');
  await rt.close();
});

test('工具：先问许可，结果喂回去，拒绝的命令不跑', async () => {
  const dir = tmp();
  const note = path.join(dir, 'note.txt');
  const marker = path.join(dir, 'ran.txt');
  fs.writeFileSync(note, '纸条');
  const asked = [];
  const calls = [];
  let n = 0;
  const seen = [];
  const rt = createDeepseekRuntime({
    ingressPath: path.join(dir, 'ingress.json'),
    threadFile: path.join(dir, 'thread.json'),
    coldFile: '',
    cwd: dir,
    sdkOptions: {
      canUseTool: async (name, input) => {
        asked.push(name);
        if (name === 'Bash') return { behavior: 'deny', message: '不行' };
        return { behavior: 'allow', updatedInput: input };
      },
    },
    env: env(),
    fetchImpl: async (_url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body);
      n += 1;
      if (n === 1) {
        return jsonResponse({
          model: 'deepseek-chat',
          choices: [{ message: { role: 'assistant', content: '', tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ path: note }) } },
            { id: 'c2', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: `touch ${marker}` }) } },
          ] } }],
        });
      }
      return jsonResponse({
        model: 'deepseek-chat',
        choices: [{ message: { role: 'assistant', content: '看到纸条了。' } }],
      });
    },
    onEvent: async (payload) => { seen.push(payload); },
  });
  await rt.start();
  await rt.enqueue({ uuid: 'u-tool', origin: { turnId: 't-tool' }, message: userMessage('看看') });
  assert.ok(await until(() => seen.some((row) => row.event.kind === 'turn.end')));
  assert.deepEqual(asked, ['Read', 'Bash']);
  assert.equal(fs.existsSync(marker), false);
  const toolMsgs = calls[1].messages.filter((row) => row.role === 'tool');
  assert.equal(toolMsgs.some((row) => row.content.includes('纸条')), true);
  assert.equal(toolMsgs.some((row) => row.content.includes('不行')), true);
  assert.equal(seen.find((row) => row.event.kind === 'text').event.text, '看到纸条了。');
  // S2b：工具调用不再只活在这一轮的内存里 —— 吐成 tool.call / tool.result 交给盒子（全本记得下来）
  const callsSeen = seen.filter((row) => row.event.kind === 'tool.call').map((row) => row.event.name);
  const results = seen.filter((row) => row.event.kind === 'tool.result').map((row) => row.event);
  assert.deepEqual(callsSeen, ['Read', 'Bash']);
  assert.equal(results.length, 2);
  assert.equal(results[0].isError, false);
  assert.equal(results[1].isError, true, '没放行的那个记成失败');
  assert.equal(results[0].callId, seen.find((row) => row.event.kind === 'tool.call').event.id);
  await rt.close();
});

test('MCP：stdio 工具用 mcp__ 的名字', async () => {
  const dir = tmp();
  const calls = [];
  let n = 0;
  const seen = [];
  const rt = createDeepseekRuntime({
    ingressPath: path.join(dir, 'ingress.json'),
    threadFile: path.join(dir, 'thread.json'),
    coldFile: '',
    cwd: dir,
    sdkOptions: {
      mcpServers: {
        ping: { command: process.execPath, args: [path.join(__dirname, '..', 'smoke', 'ping-mcp.js')] },
      },
      canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }),
    },
    env: env(),
    fetchImpl: async (_url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body);
      n += 1;
      if (n === 1) {
        assert.ok(body.tools.some((tool) => tool.function.name === 'mcp__ping__ping'));
        return jsonResponse({
          model: 'deepseek-chat',
          choices: [{ message: { role: 'assistant', content: '', tool_calls: [
            { id: 'p1', type: 'function', function: { name: 'mcp__ping__ping', arguments: '{}' } },
          ] } }],
        });
      }
      return jsonResponse({
        model: 'deepseek-chat',
        choices: [{ message: { role: 'assistant', content: 'pong 到了。' } }],
      });
    },
    onEvent: async (payload) => { seen.push(payload); },
  });
  await rt.start();
  await rt.enqueue({ uuid: 'u-mcp', origin: { turnId: 't-mcp' }, message: userMessage('ping') });
  assert.ok(await until(() => seen.some((row) => row.event.kind === 'turn.end'), 8000));
  assert.equal(calls[1].messages.some((row) => row.role === 'tool' && row.content.includes('pong-42')), true);
  assert.equal(seen.find((row) => row.event.kind === 'text').event.text, 'pong 到了。');
  await rt.close();
});

test('插座：盒子那头能收到正文和成功结果', async () => {
  const dir = tmp();
  const socketPath = path.join(dir, 'cli.sock');
  const ingressPath = path.join(dir, 'ingress.json');
  const calls = [];
  const host = createCliHost({
    socketPath,
    ingressPath,
    claudePath: '/usr/bin/claude',
    scope: 'box',
    runtimeFactory: (cfg) => createDeepseekRuntime({
      ...cfg,
      threadFile: path.join(dir, 'thread.json'),
      coldFile: '',
      env: env(),
      fetchImpl: replyFetch('插座通了', calls),
    }),
  });
  await host.listen();
  const seen = [];
  const client = createRemoteRuntime({
    socketPath,
    ingressPath,
    onEvent: async (payload) => { seen.push(payload); },
    reconnectMs: 30,
  });
  try {
    await client.ensure({ workspaceRoot: dir, model: 'claude-fable-5[1m]', sdkOptions: { systemPrompt: '系统' } });
    await client.start();
    assert.ok(client.status().sessionId.startsWith('ds-'));
    await client.enqueue({
      uuid: 'u-sock',
      origin: { channel: 'box', threadId: 'box', recipient: 'gate', turnId: 'turn-sock' },
      message: userMessage('通不通'),
    });
    assert.ok(await until(() => seen.some((row) => row.event?.kind === 'turn.end' && row.event.status === 'ok')));
    const text = seen.find((row) => row.event?.kind === 'text');
    assert.equal(text.event.text, '插座通了');
    assert.equal(text.bindings[0].origin.turnId, 'turn-sock');
  } finally {
    client.dispose();
    await host.shutdown().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('没再 ensure：enqueue 自己把运行时补上', async () => {
  const dir = tmp();
  const socketPath = path.join(dir, 'cli.sock');
  const ingressPath = path.join(dir, 'ingress.json');
  const calls = [];
  const host = createCliHost({
    socketPath,
    ingressPath,
    claudePath: '/usr/bin/true',
    scope: 'deepseek',
    fallbackEnsure: () => ({ workspaceRoot: dir, ingressPath, sdkOptions: { systemPrompt: '补上的' } }),
    runtimeFactory: (cfg) => createDeepseekRuntime({
      ...cfg,
      threadFile: path.join(dir, 'thread.json'),
      coldFile: '',
      env: env(),
      fetchImpl: replyFetch('补上了', calls),
    }),
  });
  await host.listen();
  const seen = [];
  const client = createRemoteRuntime({
    socketPath,
    ingressPath,
    onEvent: async (payload) => { seen.push(payload); },
    reconnectMs: 30,
  });
  try {
    await client.enqueue({
      uuid: 'u-fallback',
      origin: { turnId: 'turn-fallback' },
      message: userMessage('在吗'),
    });
    assert.ok(await until(() => seen.some((row) => row.event?.kind === 'turn.end' && row.event.status === 'ok')));
    assert.equal(seen.find((row) => row.event?.kind === 'text').event.text, '补上了');
    assert.ok(calls[0].body.messages.some((row) => String(row.content).includes('补上的')));
  } finally {
    client.dispose();
    await host.shutdown().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
