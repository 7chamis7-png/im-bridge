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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'im-bridge-deepseek-'));
}

function env(extra = {}) {
  return {
    DEEPSEEK_API_KEY: 'test-key',
    DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
    DEEPSEEK_MODEL: 'deepseek-chat',
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

test('config: strips [1m] suffix and maps the anthropic root back to chat completions', () => {
  const cfg = resolveDeepseekConfig({
    DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic/',
    DEEPSEEK_MODEL: 'deepseek-flash[1m]',
    DEEPSEEK_API_KEY: 'k',
  });
  assert.equal(cfg.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(cfg.model, 'deepseek-flash');
  assert.equal(cfg.key, 'k');
});

test('no key: refused before anything is written, marked notAccepted', async () => {
  const dir = tmp();
  let called = false;
  const rt = createDeepseekRuntime({
    ingressPath: path.join(dir, 'ingress.json'),
    threadFile: path.join(dir, 'thread.json'),
    coldFile: '',
    env: env({ DEEPSEEK_API_KEY: '' }),
    fetchImpl: async () => { called = true; throw new Error('must not reach the network'); },
  });
  await rt.start();
  await assert.rejects(
    async () => rt.enqueue({ uuid: 'u1', origin: { turnId: 't1' }, message: userMessage('hello') }),
    (error) => error.notAccepted === true && !String(error.message).includes('test-key'),
  );
  assert.equal(called, false);
  assert.equal(rt.list('pending').length, 0);
  await rt.close();
});

test('one turn: text is delivered, result succeeds, second turn carries the first', async () => {
  const dir = tmp();
  const calls = [];
  const seen = [];
  const rt = createDeepseekRuntime({
    ingressPath: path.join(dir, 'ingress.json'),
    threadFile: path.join(dir, 'thread.json'),
    coldFile: '',
    cwd: dir,
    sdkOptions: { systemPrompt: 'You are the agent.', model: 'claude-opus-4-6[1m]' },
    env: env(),
    fetchImpl: replyFetch('Here.', calls),
    onEvent: async (payload) => { seen.push(payload); },
  });
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'Voice: short.');
  await rt.start();
  const sid = rt.status().sessionId;
  assert.ok(sid.startsWith('ds-'), sid);

  await rt.enqueue({ uuid: 'u1', origin: { channel: 'box', threadId: 'box', recipient: 'gate', turnId: 't1' }, message: userMessage('hello') });
  assert.ok(await until(() => seen.some((row) => row.event.kind === 'result')));

  const text = seen.find((row) => row.event.kind === 'text');
  const result = seen.find((row) => row.event.kind === 'result');
  assert.equal(text.event.text, 'Here.');
  assert.equal(text.event.deliver, true);
  assert.equal(text.event.raw.type, 'assistant');
  assert.equal(text.event.raw.message.model, 'deepseek-chat');
  assert.equal(text.bindings[0].uuid, 'u1');
  assert.equal(text.bindings[0].origin.turnId, 't1');
  assert.equal(result.event.raw.subtype, 'success');
  assert.equal(rt.get('u1').state, 'completed');
  assert.equal(calls[0].authorization, 'Bearer test-key');
  assert.ok(calls[0].body.messages.some((row) => row.role === 'system' && row.content.includes('You are the agent.')));
  assert.ok(calls[0].body.messages.some((row) => row.content.includes('Voice: short.')));
  assert.equal(calls[0].body.model, 'deepseek-chat');
  assert.deepEqual(calls[0].body.thinking, { type: 'disabled' });
  assert.equal(calls[0].body.messages.some((row) => String(row.content).includes('text only')), false);
  assert.ok(calls[0].body.tools.some((tool) => tool.function.name === 'Read'));
  assert.equal(calls[0].body.messages.at(-1).content, 'hello');

  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'thread.json'), 'utf8'));
  assert.equal(saved.schema, 'im-bridge.deepseek-thread.v1');
  assert.deepEqual(saved.messages.map((row) => row.content), ['hello', 'Here.']);

  await rt.enqueue({ uuid: 'u2', origin: { turnId: 't2' }, message: userMessage('still there?') });
  assert.ok(await until(() => rt.get('u2')?.state === 'completed'));
  assert.equal(calls[1].body.messages.some((row) => row.role === 'assistant' && row.content === 'Here.'), true);
  assert.equal(calls[1].body.messages.at(-1).content, 'still there?');
  await rt.close();
});

test('API failure: result is not success, ledger marks uncertain, key never appears in the error', async () => {
  const dir = tmp();
  const seen = [];
  const rt = createDeepseekRuntime({
    ingressPath: path.join(dir, 'ingress.json'),
    threadFile: path.join(dir, 'thread.json'),
    coldFile: '',
    env: env({ DEEPSEEK_API_KEY: 'secret-do-not-leak' }),
    fetchImpl: async () => jsonResponse('{"error":{"message":"bad key"}}', 401),
    onEvent: async (payload) => { seen.push(payload); },
  });
  await rt.start();
  await rt.enqueue({ uuid: 'u1', origin: { turnId: 't1' }, message: userMessage('hey') });
  assert.ok(await until(() => seen.some((row) => row.event.kind === 'result')));
  const result = seen.find((row) => row.event.kind === 'result');
  assert.notEqual(result.event.raw.subtype, 'success');
  assert.equal(result.event.raw.errors.some((line) => line.includes('secret-do-not-leak')), false);
  assert.equal(rt.get('u1').state, 'uncertain');
  await rt.close();
});

test('pending rows left by another runtime are not replayed; its own unfinished rows are', async () => {
  const dir = tmp();
  const ingressPath = path.join(dir, 'ingress.json');
  const foreign = {
    uuid: 'old', scope: 'box', state: 'pending', error: null,
    payload: { uuid: 'old', origin: { turnId: 't-old' }, message: userMessage('old, do not send') },
  };
  const mine = {
    uuid: 'mine', scope: 'box', state: 'pending', error: null,
    payload: { uuid: 'mine', origin: { turnId: 't-mine' }, message: userMessage('finish me'), brain: 'deepseek' },
  };
  fs.writeFileSync(ingressPath, JSON.stringify({ version: 1, records: [foreign, mine] }) + '\n');
  const calls = [];
  const rt = createDeepseekRuntime({
    ingressPath,
    threadFile: path.join(dir, 'thread.json'),
    coldFile: '',
    env: env(),
    fetchImpl: replyFetch('finished', calls),
  });
  await rt.start();
  assert.ok(await until(() => rt.get('mine')?.state === 'completed'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.messages.at(-1).content, 'finish me');
  assert.equal(rt.get('old').state, 'pending');
  await rt.close();
});

test('tools: permission asked first, results fed back, denied command never runs', async () => {
  const dir = tmp();
  const note = path.join(dir, 'note.txt');
  const marker = path.join(dir, 'ran.txt');
  fs.writeFileSync(note, 'a note');
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
        if (name === 'Bash') return { behavior: 'deny', message: 'denied' };
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
        choices: [{ message: { role: 'assistant', content: 'Saw the note.' } }],
      });
    },
    onEvent: async (payload) => { seen.push(payload); },
  });
  await rt.start();
  await rt.enqueue({ uuid: 'u-tool', origin: { turnId: 't-tool' }, message: userMessage('take a look') });
  assert.ok(await until(() => seen.some((row) => row.event.kind === 'result')));
  assert.deepEqual(asked, ['Read', 'Bash']);
  assert.equal(fs.existsSync(marker), false);
  const toolMsgs = calls[1].messages.filter((row) => row.role === 'tool');
  assert.equal(toolMsgs.some((row) => row.content.includes('a note')), true);
  assert.equal(toolMsgs.some((row) => row.content.includes('denied')), true);
  assert.equal(seen.find((row) => row.event.kind === 'text').event.text, 'Saw the note.');
  await rt.close();
});

test('MCP: stdio tools are exposed with mcp__ names', async () => {
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
        choices: [{ message: { role: 'assistant', content: 'Got pong.' } }],
      });
    },
    onEvent: async (payload) => { seen.push(payload); },
  });
  await rt.start();
  await rt.enqueue({ uuid: 'u-mcp', origin: { turnId: 't-mcp' }, message: userMessage('ping') });
  assert.ok(await until(() => seen.some((row) => row.event.kind === 'result'), 8000));
  assert.equal(calls[1].messages.some((row) => row.role === 'tool' && row.content.includes('pong-42')), true);
  assert.equal(seen.find((row) => row.event.kind === 'text').event.text, 'Got pong.');
  await rt.close();
});

test('socket: the box side receives text and a successful result', async () => {
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
      fetchImpl: replyFetch('socket works', calls),
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
    await client.ensure({ workspaceRoot: dir, model: 'claude-opus-4-6[1m]', sdkOptions: { systemPrompt: 'system' } });
    await client.start();
    assert.ok(client.status().sessionId.startsWith('ds-'));
    await client.enqueue({
      uuid: 'u-sock',
      origin: { channel: 'box', threadId: 'box', recipient: 'gate', turnId: 'turn-sock' },
      message: userMessage('working?'),
    });
    assert.ok(await until(() => seen.some((row) => row.event?.kind === 'result' && row.event.raw.subtype === 'success')));
    const text = seen.find((row) => row.event?.kind === 'text');
    assert.equal(text.event.text, 'socket works');
    assert.equal(text.bindings[0].origin.turnId, 'turn-sock');
  } finally {
    client.dispose();
    await host.shutdown().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no ensure after reconnect: enqueue recreates the runtime itself', async () => {
  const dir = tmp();
  const socketPath = path.join(dir, 'cli.sock');
  const ingressPath = path.join(dir, 'ingress.json');
  const calls = [];
  const host = createCliHost({
    socketPath,
    ingressPath,
    claudePath: '/usr/bin/true',
    scope: 'deepseek',
    fallbackEnsure: () => ({ workspaceRoot: dir, ingressPath, sdkOptions: { systemPrompt: 'fallback prompt' } }),
    runtimeFactory: (cfg) => createDeepseekRuntime({
      ...cfg,
      threadFile: path.join(dir, 'thread.json'),
      coldFile: '',
      env: env(),
      fetchImpl: replyFetch('recreated', calls),
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
      message: userMessage('hello'),
    });
    assert.ok(await until(() => seen.some((row) => row.event?.kind === 'result' && row.event.raw.subtype === 'success')));
    assert.equal(seen.find((row) => row.event?.kind === 'text').event.text, 'recreated');
    assert.ok(calls[0].body.messages.some((row) => String(row.content).includes('fallback prompt')));
  } finally {
    client.dispose();
    await host.shutdown().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
