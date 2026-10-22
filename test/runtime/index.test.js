'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createRuntime } = require('../../runtime');
const { createIngress } = require('../../runtime/ingress');

const fixture = fs.readFileSync(path.resolve(__dirname, '../fixtures/cli-raw.jsonl'), 'utf8')
  .trim().split('\n').map(JSON.parse);
const init = { ...fixture.find((f) => f.subtype === 'init'), session_id: 'fake-session' };
const baseText = fixture.find((f) => f.message?.content[0].type === 'text');
const baseThinking = fixture.find((f) => f.message?.content[0].type === 'thinking');
const baseResult = fixture.find((f) => f.type === 'result');
const origin = { channel: 'telegram', threadId: 'thread-1', recipient: 'recipient-1' };
function assistant(text = '收到了。', extra = {}) {
  return { ...baseText, session_id: '$SESSION', user_message_uuid: '$UUID',
    message: { ...baseText.message, id: 'message-$UUID', content: [{ type: 'text', text }] }, ...extra };
}
function result(extra = {}) {
  return { ...baseResult, session_id: '$SESSION', user_message_uuid: '$UUID', ...extra };
}
function message(content = '说三个字：收到了') {
  return { type: 'user', message: { role: 'user', content } };
}
async function until(check) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('假 CLI 接线测试等待超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function harness(t, config = {}, runtimeOptions = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'im-bridge-sdk-'));
  const ingressPath = path.join(directory, 'ingress.json');
  const tracePath = path.join(directory, 'stdin.jsonl');
  const scriptPath = path.join(directory, 'script.json');
  const deliveries = [];
  const events = [];
  const script = { init, turns: [[assistant(), result()]], ...config, ingressPath, tracePath };
  fs.writeFileSync(scriptPath, JSON.stringify(script));
  const settings = {
    ingressPath, cwd: directory, pathToClaudeCodeExecutable: path.resolve(__dirname, 'helpers/fake-cli.js'),
    scope: 'session-scope', stopGraceMs: 30,
    // The executable is always the fake. No inherited API/OAuth secrets or real settings required.
    sdkOptions: { env: { PATH: process.env.PATH, IM_BRIDGE_FAKE_SCRIPT: scriptPath }, model: 'requested[1m]',
      settingSources: [], tools: [], ...runtimeOptions.sdkOptions },
    deliver: async (item) => { deliveries.push(item); },
    onEvent: async (item) => { events.push(item); },
    ...runtimeOptions,
  };
  let runtime;
  t.after(async () => {
    if (runtime) await runtime.close().catch(() => {});
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const trace = () => fs.existsSync(tracePath) ? fs.readFileSync(tracePath, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { directory, ingressPath, deliveries, events, trace, settings,
    open() { runtime = createRuntime(settings); return runtime; } };
}

test('E2E：真 SDK → 假 CLI stdin → decode → claim → deliver → result 落盘；排队时固定来源', { timeout: 6000 }, async (t) => {
  const seenStates = [];
  const first = assistant();
  first.message.stop_reason = 'end_turn';
  const h = harness(t, { initOnUser: true, turns: [[first, result()], [assistant('第二条'), result()]] });
  const runtime = h.open();
  const source = { ...origin };
  const input = message('调用方人格包\n她的原话');
  const a = runtime.enqueue({ message: input, origin: source });
  const b = runtime.enqueue({ message: message('第二轮'), origin: { ...origin, threadId: 'queued-thread' } });
  source.threadId = 'changed';
  input.message.content = 'changed';
  assert.equal(runtime.get(a.uuid).state, 'pending');
  assert.deepEqual(h.trace(), []);
  const deliveryCheck = h.deliveries;
  await runtime.start();
  await until(() => runtime.get(b.uuid).state === 'completed');
  assert.deepEqual(deliveryCheck.map((d) => [d.text, d.origin.threadId]), [['收到了。', 'thread-1'], ['第二条', 'queued-thread']]);
  assert.equal(h.events.find((x) => x.event.turnEnded).bindings[0].uuid, a.uuid);
  const received = h.trace().filter((x) => x.type === 'received');
  assert.equal(received.length, 2);
  for (const item of received) seenStates.push(item.rows.find((r) => r.uuid === item.message.uuid).state);
  assert.deepEqual(seenStates, ['started', 'started']);
  assert.equal(received[0].message.message.content, '调用方人格包\n她的原话');
  assert.deepEqual(received[0].message.origin, { kind: 'channel', server: 'telegram' });
  assert.equal(received[1].rows.find((r) => r.uuid === a.uuid).state, 'completed');
  assert.equal(runtime.status().requestedModel, 'requested[1m]');
  assert.equal(runtime.status().actualModel, baseText.message.model);
  assert.equal(h.trace().find((x) => x.type === 'spawn').args.includes('--include-partial-messages'), false);
  await runtime.stop();
  assert.equal(runtime.get(a.uuid).state, 'completed');
});

test('E2E：首帧 UUID + 同 message.id 拆块不吞正文；旁白投、真思考/子代理/合成帧不投', { timeout: 6000 }, async (t) => {
  const thinking = { ...baseThinking, session_id: '$SESSION', user_message_uuid: '$UUID',
    message: { ...baseThinking.message, id: 'message-$UUID' } };
  const text = assistant();
  delete text.user_message_uuid;
  const narration = assistant('unused', { narration_block_indexes: [0],
    message: { ...baseText.message, id: 'narration-$UUID', content: [{ type: 'thinking', thinking: '旁白' }] } });
  const h = harness(t, { turns: [[thinking, text, narration,
    assistant('子代理', { parent_tool_use_id: 'tool-1' }), result({ parent_tool_use_id: 'tool-1' }),
    assistant('API Error 合成', { isSynthetic: true }), assistant('API Error 是我说的'), result()]] });
  const runtime = h.open();
  const row = runtime.enqueue({ message: message(), origin });
  await runtime.start();
  await until(() => runtime.get(row.uuid).state === 'completed');
  assert.deepEqual(h.deliveries.map((x) => x.text), ['收到了。', '旁白', 'API Error 是我说的']);
  assert.equal(h.events.filter((x) => x.event.kind === 'result').length, 2);
});

test('E2E：end_turn 不 complete，result 前下一条仍 pending，手动停止保留 uncertain', { timeout: 6000 }, async (t) => {
  const frame = assistant(); frame.message.stop_reason = 'end_turn';
  const h = harness(t, { turns: [[frame]] });
  const runtime = h.open();
  const a = runtime.enqueue({ message: message(), origin });
  const b = runtime.enqueue({ message: message('排队'), origin });
  await runtime.start();
  await until(() => h.deliveries.length === 1);
  assert.equal(runtime.get(a.uuid).state, 'started');
  assert.equal(runtime.get(b.uuid).state, 'pending');
  await runtime.stop();
  assert.equal(runtime.get(a.uuid).state, 'uncertain');
  assert.equal(runtime.get(b.uuid).state, 'pending');
  assert.equal(h.trace().filter((x) => x.type === 'received').length, 1);
});

test('E2E：G-1 API key / 缺 apiKeySource 都立即停下，坏 init 后正文与结果不投', { timeout: 6000 }, async (t) => {
  for (const apiKeySource of ['user', undefined]) await t.test(String(apiKeySource), async (t) => {
    const h = harness(t, { init: { ...init, apiKeySource }, initOnUser: true });
    const runtime = h.open();
    const row = runtime.enqueue({ message: message(), origin });
    const queued = runtime.enqueue({ message: message('不能继续烧钱'), origin });
    await runtime.start();
    await assert.rejects(runtime.done, /apiKeySource=.*已停止/);
    assert.equal(h.deliveries.length, 0);
    assert.equal(runtime.get(row.uuid).state, 'uncertain');
    assert.equal(runtime.get(queued.uuid).state, 'pending');
    const pid = h.trace().find((x) => x.type === 'spawn').pid;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  });
});

test('E2E：退出尾帧 assistant + result 读完后才释放进程及状态', { timeout: 6000 }, async (t) => {
  const h = harness(t, { turns: [[]], tail: [assistant('退出时的尾巴'), result()] });
  const runtime = h.open();
  const row = runtime.enqueue({ message: message(), origin });
  await runtime.start();
  await until(() => h.trace().some((x) => x.type === 'received'));
  await runtime.stop();
  assert.equal(runtime.get(row.uuid).state, 'completed');
  assert.deepEqual(h.deliveries.map((x) => x.text), ['退出时的尾巴']);
});

test('E2E：SDK/CLI 失败 result 留 uncertain；无 result 退出也留 uncertain', { timeout: 6000 }, async (t) => {
  for (const frames of [[result({ subtype: 'error_during_execution', is_error: true, errors: ['假工具失败'] })], []]) {
    await t.test(frames.length ? 'failed result' : 'exit without result', async (t) => {
      const h = harness(t, { turns: [frames], exitAfterTurn: true });
      const runtime = h.open();
      const row = runtime.enqueue({ message: message(), origin });
      await runtime.start();
      if (frames.length) await runtime.done;
      else await assert.rejects(runtime.done, /还没有 result/);
      assert.equal(runtime.get(row.uuid).state, 'uncertain');
    });
  }
});

test('E2E：恢复 pending 实际重放一次，started 恢复 uncertain 不重放', { timeout: 6000 }, async (t) => {
  const h = harness(t);
  const old = createIngress({ filePath: h.ingressPath });
  const a = randomUUID(), b = randomUUID();
  for (const uuid of [a, b]) old.accept({ uuid, scope: 'session-scope',
    payload: { uuid, message: { ...message(), uuid, origin: { kind: 'channel', server: 'telegram' }, parent_tool_use_id: null }, origin } });
  old.begin(a);
  await old.submit(a, () => {});
  old.close();
  const runtime = h.open();
  await runtime.start();
  await until(() => runtime.get(b).state === 'completed');
  assert.equal(runtime.get(a).state, 'uncertain');
  assert.deepEqual(h.trace().filter((x) => x.type === 'received').map((x) => x.message.uuid), [b]);
  assert.equal(h.deliveries[0].bindings[0].uuid, b);
});

// 2026-09-20 改：原规则「缺/未知 UUID 一律停进程」对着真 CLI 是错的 ——
// 工具调用之后的 assistant 帧本来就不带戳（fixtures/sdk-tool-turn.jsonl）。
// 串行下没戳的帧只可能属于唯一那条 started；投递失败仍然不许假完成。
test('E2E：缺失/未知 UUID 归给唯一在跑的那轮；投递失败也不假完成', { timeout: 6000 }, async (t) => {
  for (const kind of ['missing', 'unknown']) await t.test(kind, async (t) => {
    const frame = assistant();
    if (kind === 'missing') delete frame.user_message_uuid;
    if (kind === 'unknown') frame.user_message_uuid = randomUUID();
    const h = harness(t, { turns: [[frame, result()]] });
    const runtime = h.open();
    const row = runtime.enqueue({ message: message(), origin });
    await runtime.start();
    await until(() => runtime.get(row.uuid).state === 'completed');
    assert.deepEqual(h.deliveries.map((x) => [x.text, x.bindings[0].uuid]), [['收到了。', row.uuid]]);
  });
  await t.test('delivery', async (t) => {
    const h = harness(t, {}, { deliver: async () => { throw new Error('假渠道发送失败'); } });
    const runtime = h.open();
    const row = runtime.enqueue({ message: message(), origin });
    await runtime.start();
    await assert.rejects(runtime.done, /假渠道发送失败/);
    assert.equal(runtime.get(row.uuid).state, 'uncertain');
  });
});

test('E2E：真 CLI 的工具轮（只有首帧和 result 带戳）两段正文都投、进程不停', { timeout: 6000 }, async (t) => {
  const real = fs.readFileSync(path.resolve(__dirname, '../fixtures/sdk-tool-turn.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse);
  const sent = real.find((f) => f.user_message_uuid).user_message_uuid;
  const turn = real.filter((f) => !['command_lifecycle', 'rate_limit_event'].includes(f.type) && f.subtype !== 'init')
    .map((f) => JSON.parse(JSON.stringify(f).replaceAll(sent, '$UUID')));
  const texts = real.filter((f) => f.type === 'assistant' && f.message.content[0].type === 'text')
    .map((f) => f.message.content[0].text);
  assert.equal(texts.length, 2);
  const h = harness(t, { turns: [turn, [assistant('第二轮'), result()]] });
  const runtime = h.open();
  const a = runtime.enqueue({ message: message('一'), origin });
  const b = runtime.enqueue({ message: message('二'), origin });
  await runtime.start();
  await until(() => runtime.get(b.uuid).state === 'completed');
  assert.equal(runtime.get(a.uuid).state, 'completed');
  assert.deepEqual(h.deliveries.map((x) => [x.text, x.bindings[0].uuid]),
    [[texts[0], a.uuid], [texts[1], a.uuid], ['第二轮', b.uuid]]);
  assert.equal(runtime.status().running, true);
});

test('E2E：没有轮在跑时 CLI 自己开口 —— 不投、不停进程，交给 onEvent', { timeout: 6000 }, async (t) => {
  const stray = assistant('后台任务回报');
  delete stray.user_message_uuid;
  const strayResult = result();
  delete strayResult.user_message_uuid;
  const h = harness(t, { turns: [[assistant(), result(), stray, strayResult], [assistant('还活着'), result()]] });
  const runtime = h.open();
  const a = runtime.enqueue({ message: message('一'), origin });
  await runtime.start();
  await until(() => h.events.filter((x) => x.event.kind === 'result').length === 2);
  const b = runtime.enqueue({ message: message('二'), origin });
  await until(() => runtime.get(b.uuid).state === 'completed');
  assert.equal(runtime.get(a.uuid).state, 'completed');
  assert.deepEqual(h.deliveries.map((x) => x.text), ['收到了。', '还活着']);
  const orphan = h.events.find((x) => x.event.text === '后台任务回报');
  assert.deepEqual(orphan.bindings, []);
});

test('E2E：setModel 等控制回执，请求模型不被实际模型抹掉；fallback 参数透传', { timeout: 6000 }, async (t) => {
  for (const rejectModel of [false, true]) await t.test(String(rejectModel), async (t) => {
    const h = harness(t, { rejectModel });
    h.settings.sdkOptions.fallbackModel = 'fallback-model';
    h.settings.sdkOptions.includePartialMessages = true;
    const runtime = h.open();
    const row = runtime.enqueue({ message: message(), origin });
    await runtime.start();
    await until(() => runtime.get(row.uuid).state === 'completed');
    if (rejectModel) await assert.rejects(runtime.setModel('new[1m]'), /假 CLI 拒绝换模型/);
    else await runtime.setModel('new[1m]');
    assert.equal(runtime.status().requestedModel, rejectModel ? 'requested[1m]' : 'new[1m]');
    const args = h.trace().find((x) => x.type === 'spawn').args;
    assert.equal(args.includes('--include-partial-messages'), true);
    assert.equal(args[args.indexOf('--fallback-model') + 1], 'fallback-model');
    assert.equal(h.trace().filter((x) => x.type === 'spawn').length, 1);
  });
});

test('配置缺少路径/归属/投递函数即报错；禁止 bare；不偷启默认 CLI', (t) => {
  const h = harness(t);
  for (const key of ['ingressPath', 'cwd', 'pathToClaudeCodeExecutable']) {
    assert.throws(() => createRuntime({ ...h.settings, [key]: '' }), /绝对路径/);
  }
  assert.throws(() => createRuntime({ ...h.settings, deliver: undefined }), /投递出口/);
  assert.throws(() => createRuntime({ ...h.settings, sdkOptions: { extraArgs: { bare: null } } }), /API 计费/);
  const runtime = h.open();
  assert.throws(() => runtime.enqueue({ message: message(), origin: {} }), /渠道/);
  assert.equal(h.trace().length, 0);
});

test('E2E：dispatching 落盘失败时假 CLI 一条 user 都收不到', { timeout: 6000 }, async (t) => {
  const h = harness(t);
  const runtime = h.open();
  const row = runtime.enqueue({ message: message(), origin });
  fs.mkdirSync(`${h.ingressPath}.tmp`); // 确定性的写入故障，与 root 权限无关。
  await runtime.start();
  await assert.rejects(runtime.done, /可靠投递无法保存/);
  assert.equal(runtime.get(row.uuid).state, 'pending');
  assert.equal(h.trace().filter((x) => x.type === 'received').length, 0);
});

test('E2E：卡住的假 CLI 可手动作废，SIGKILL 后才留 uncertain，不自动重放', { timeout: 6000 }, async (t) => {
  const h = harness(t, { turns: [[]], ignoreStop: true });
  const runtime = h.open();
  const row = runtime.enqueue({ message: message(), origin });
  await runtime.start();
  await until(() => h.trace().some((x) => x.type === 'received'));
  await runtime.stop();
  assert.equal(runtime.get(row.uuid).state, 'uncertain');
  assert.equal(runtime.status().running, false);
  const pid = h.trace().find((x) => x.type === 'spawn').pid;
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const next = runtime.enqueue({ message: message('进程不在也留存'), origin });
  assert.equal(runtime.get(next.uuid).state, 'pending');
  assert.equal(h.trace().filter((x) => x.type === 'received').length, 1);
});

test('E2E：非零退出也先接住 stdout 尾部的真实成功，不把 completed 降级', { timeout: 6000 }, async (t) => {
  const h = harness(t, { exitAfterTurn: true, exitCode: 7 });
  const runtime = h.open();
  const row = runtime.enqueue({ message: message(), origin });
  await runtime.start();
  await assert.rejects(runtime.done, /code 7/);
  assert.equal(runtime.get(row.uuid).state, 'completed');
  assert.equal(h.deliveries.length, 1);
});

test('E2E：没有 system/init 时停止，不能投正文或把 result 当成功', { timeout: 6000 }, async (t) => {
  const h = harness(t, { init: null });
  const runtime = h.open();
  const row = runtime.enqueue({ message: message(), origin });
  await runtime.start();
  await assert.rejects(runtime.done, /确认订阅计费前/);
  assert.equal(h.deliveries.length, 0);
  assert.equal(runtime.get(row.uuid).state, 'uncertain');
});

test('E2E：停止期间的尾帧投递失败仍向调用方报错', { timeout: 6000 }, async (t) => {
  const h = harness(t, { turns: [[]], tail: [assistant(), result()] }, {
    deliver: async () => { throw new Error('退出尾帧投递失败'); },
  });
  const runtime = h.open();
  const row = runtime.enqueue({ message: message(), origin });
  await runtime.start();
  await until(() => h.trace().some((x) => x.type === 'received'));
  await assert.rejects(runtime.stop(), /退出尾帧投递失败/);
  assert.equal(runtime.get(row.uuid).state, 'uncertain');
});

test('E2E：批量 UUID 同归属只投一次并全部完成，跨收件人不广播', { timeout: 6000 }, async (t) => {
  for (const crossRecipient of [false, true]) await t.test(String(crossRecipient), async (t) => {
    const previous = randomUUID();
    const h = harness(t, { turns: [[
      assistant('合批回复', { user_message_uuids: [previous, '$UUID', previous] }),
      result({ user_message_uuids: [previous, '$UUID'] }),
    ]] });
    const old = createIngress({ filePath: h.ingressPath });
    old.accept({ uuid: previous, scope: 'session-scope', payload: {
      uuid: previous, message: { ...message(), uuid: previous },
      origin: crossRecipient ? { ...origin, recipient: 'another-person' } : origin,
    } });
    old.begin(previous);
    await old.submit(previous, () => {});
    old.close();
    const runtime = h.open();
    const row = runtime.enqueue({ message: message(), origin });
    await runtime.start();
    if (crossRecipient) {
      await assert.rejects(runtime.done, /不同收件人/);
      assert.equal(h.deliveries.length, 0);
      assert.equal(runtime.get(previous).state, 'uncertain');
    } else {
      await until(() => runtime.get(row.uuid).state === 'completed');
      assert.equal(h.deliveries.length, 1);
      assert.equal(runtime.get(previous).state, 'completed');
      assert.equal(h.deliveries[0].bindings.length, 2);
    }
  });
});

test('E2E：token 帧从 onEvent 透传，正文不重复；result 后清掉拆帧归属', { timeout: 6000 }, async (t) => {
  const unclaimed = assistant('不能继承上一轮', { message: { ...baseText.message, id: 'message-$UUID' } });
  delete unclaimed.user_message_uuid;
  const token = { type: 'stream_event', uuid: '$UUID', session_id: '$SESSION', parent_tool_use_id: null,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '收' } } };
  const h = harness(t, { turns: [[token, assistant(), result(), unclaimed]] });
  h.settings.sdkOptions.includePartialMessages = true;
  const runtime = h.open();
  const row = runtime.enqueue({ message: message(), origin });
  await runtime.start();
  // 2026-09-20：result 之后的无戳帧不继承上一轮（不投），也不再停进程
  await until(() => h.events.filter((x) => x.event.kind === 'text').length === 2);
  // 这个帧的 content 被 message 覆盖成了基准正文（同 message.id），看的是归属不是字
  assert.deepEqual(h.events.filter((x) => x.event.kind === 'text')[1].bindings, []);
  assert.equal(runtime.get(row.uuid).state, 'completed');
  assert.deepEqual(h.deliveries.map((x) => x.text), ['收到了。']);
  assert.equal(h.events.filter((x) => x.event.raw.type === 'stream_event').length, 1);
});

test('E2E：CLI 启动路径失效时报错并保留消息，不回退到 SDK 自带真 CLI', { timeout: 6000 }, async (t) => {
  const h = harness(t);
  h.settings.pathToClaudeCodeExecutable = path.join(h.directory, 'missing-cli');
  const runtime = h.open();
  const row = runtime.enqueue({ message: message(), origin });
  await runtime.start();
  await assert.rejects(runtime.done, /CLI|executable|not found/);
  assert.ok(['pending', 'uncertain'].includes(runtime.get(row.uuid).state));
  assert.deepEqual(h.trace(), []);
  await assert.rejects(runtime.start(), /重新装配/);
});
