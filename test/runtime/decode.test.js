'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { decode } = require('../../runtime/decode');

const textBlock = (text) => ({ type: 'text', text });
const thinkingBlock = (thinking) => ({ type: 'thinking', thinking });
const assistant = (content, envelope = {}, message = {}) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { content, ...message },
  ...envelope,
});
const delivered = (events) => events.filter((event) => event.deliver).map((event) => event.text);

test('真实 CLI 2.1.278：九帧都保留，只投一次正文，只在 result 结束', () => {
  const frames = readFileSync(path.join(__dirname, '../fixtures/cli-raw.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(frames.length, 9);
  const events = frames.flatMap((frame) => {
    const decoded = decode(frame);
    assert.ok(decoded.length > 0);
    for (const event of decoded) assert.strictEqual(event.raw, frame);
    return decoded;
  });
  assert.deepEqual(delivered(events), ['收到了。']);
  assert.deepEqual(events.map((event) => event.kind), [
    'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'thinking', 'text', 'unknown', 'result',
  ]);
  assert.deepEqual(events.filter((event) => event.turnEnded).map((event) => event.raw), [frames[8]]);
  assert.equal(events[2].raw.apiKeySource, 'none'); // G-1：保留给后续装配层检查。
  assert.equal(events[5].deliver, false);
  assert.equal(events[6].actualModel, 'claude-haiku-4-5-20251001');
  assert.equal(events[6].user_message_uuid, undefined); // 不拿帧 uuid 冒充轮次 uuid。
});

test('D-1：正文含 API Error / safeguards flagged 也仍是他说的话', () => {
  const body = 'API Error: safeguards flagged，刚才屏幕上就是这么写的。';
  const [event] = decode(assistant([textBlock(body)], { isSynthetic: false }));
  assert.equal(event.cliGenerated, false);
  assert.deepEqual(delivered([event]), [body]);
});

test('D-1：只凭 assistant.error 或 isSynthetic 拦下普通正文和旁白', () => {
  for (const envelope of [
    { error: 'authentication_failed' },
    { error: 'future_error_code' },
    { isSynthetic: true },
    { error: 'rate_limit', isSynthetic: false },
  ]) {
    const events = decode(assistant([textBlock('抱着呢'), thinkingBlock('蛋还没破')], {
      ...envelope, narration_block_indexes: [1],
    }));
    assert.deepEqual(delivered(events), []);
    assert.ok(events.every((event) => event.cliGenerated));
    assert.ok(events.every((event) => event.error === envelope.error));
    assert.deepEqual(events.map((event) => event.kind), ['text', 'narration']);
  }
  const [normal] = decode(assistant([textBlock('收到了')], { error: null, isSynthetic: false }));
  assert.equal(normal.deliver, true);
});

test('D-2：旁白索引对应原始 content 位置，保持正文顺序和空白', () => {
  const blocks = [
    thinkingBlock('私下思考'),
    { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
    thinkingBlock(' 蛋还没破，喂了小白菜…\n'),
    textBlock('（记好了 等她）'),
  ];
  const events = decode(assistant(blocks, { narration_block_indexes: [2] }));
  assert.deepEqual(events.map((event) => event.kind), ['thinking', 'unknown', 'narration', 'text']);
  assert.deepEqual(events.map((event) => event.blockIndex), [0, 1, 2, 3]);
  assert.deepEqual(delivered(events), [' 蛋还没破，喂了小白菜…\n', '（记好了 等她）']);
  assert.strictEqual(events[1].block, blocks[1]);
});

test('D-2：thinking_tokens 为零、非零或缺失均不改变旁白判据', () => {
  for (const tokens of [0, 42, undefined]) {
    const events = decode(assistant([
      { ...thinkingBlock('绝不能投'), signature: 'narration', thinking_tokens: 0 },
      thinkingBlock('要送给她'),
    ], { narration_block_indexes: [1], thinking_tokens: tokens }, {
      usage: { output_tokens_details: { thinking_tokens: tokens } },
    }));
    assert.deepEqual(delivered(events), ['要送给她']);
    assert.equal(events[0].kind, 'thinking');
  }
});

test('D-2：没有旁白索引的真 thinking 和 redacted_thinking 不投', () => {
  for (const indexes of [undefined, []]) {
    const events = decode(assistant([
      thinkingBlock('私下思考'), { type: 'redacted_thinking', data: 'secret' },
    ], { narration_block_indexes: indexes }));
    assert.deepEqual(delivered(events), []);
    assert.equal(events[0].kind, 'thinking');
    assert.equal(events[0].text, undefined);
    assert.equal(events[1].text, undefined);
  }
});

test('D-2：旁白索引不能把未知块或隐藏思考猜成正文', () => {
  const events = decode(assistant([
    { type: 'future_block', text: '不能猜' },
    { type: 'redacted_thinking', data: 'secret' },
    textBlock('正文'),
  ], { narration_block_indexes: [0, 1, 2] }));
  assert.deepEqual(delivered(events), ['正文']);
  assert.deepEqual(events.map((event) => event.kind), ['unknown', 'unknown', 'text']);
});

test('子代理：非 null parent_tool_use_id 保留且禁止正文、旁白投递', () => {
  // 架构 §2 新增判据；runtime-rules.md 暂未给它单独编号。
  for (const parent of ['tool-123', '']) {
    const events = decode(assistant([textBlock('子代理的话'), thinkingBlock('子代理旁白')], {
      parent_tool_use_id: parent, narration_block_indexes: [1], user_message_uuid: 'turn-a',
    }));
    assert.deepEqual(delivered(events), []);
    for (const event of events) {
      assert.equal(event.isSubagent, true);
      assert.equal(event.parent_tool_use_id, parent);
      assert.equal(event.user_message_uuid, 'turn-a');
    }
  }
  assert.equal(decode(assistant([textBlock('主代理')]))[0].deliver, true);
});

test('result 才结束：end_turn 后仍可有下一条 assistant', () => {
  const frames = [
    assistant([textBlock('第一段')], {}, { stop_reason: 'end_turn' }),
    { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } },
    assistant([textBlock('Stop hook 后的第二段')]),
    { type: 'result', subtype: 'success', result: 'Stop hook 后的第二段', user_message_uuid: 'turn-a' },
  ];
  const events = frames.flatMap(decode);
  assert.deepEqual(events.map((event) => event.turnEnded), [false, false, false, true]);
  assert.deepEqual(delivered(events), ['第一段', 'Stop hook 后的第二段']);
  assert.equal(events[3].user_message_uuid, 'turn-a');
});

test('失败 result 也结束；子代理 result 不结束主代理轮次', () => {
  const failure = { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['出错了'] };
  const [event] = decode(failure);
  assert.equal(event.kind, 'result');
  assert.equal(event.turnEnded, true);
  assert.equal(event.deliver, false);
  assert.strictEqual(event.raw, failure);
  const [child] = decode({ ...failure, parent_tool_use_id: 'tool-1' });
  assert.equal(child.kind, 'result');
  assert.equal(child.isSubagent, true);
  assert.equal(child.turnEnded, false);
});

test('B-2：单个与批量轮次 UUID 原样保留，绝不从 uuid / message.id 认领', () => {
  for (const frame of [
    assistant([textBlock('正文')]),
    { type: 'result' },
    { type: 'future_event' },
  ]) {
    const ids = { user_message_uuid: 'turn-a', user_message_uuids: ['turn-a', 'turn-b'] };
    const [event] = decode({ ...frame, ...ids, uuid: 'frame-id' });
    assert.equal(event.user_message_uuid, 'turn-a');
    assert.deepEqual(event.user_message_uuids, ['turn-a', 'turn-b']);
    const [unclaimed] = decode({ ...frame, uuid: 'frame-id' });
    assert.equal(unclaimed.user_message_uuid, undefined);
    assert.equal(unclaimed.user_message_uuids, undefined);
  }
  const [batchOnly] = decode({ type: 'result', user_message_uuids: ['turn-b', 'turn-c'] });
  assert.equal(batchOnly.user_message_uuid, undefined);
  assert.deepEqual(batchOnly.user_message_uuids, ['turn-b', 'turn-c']);
});

test('未知帧、system 子类型和流式事件原样带出，不猜正文、不猜结束', () => {
  for (const frame of [
    { type: 'future_event', text: '别猜', stop_reason: 'end_turn', extra: { a: 1 } },
    { type: 'system', subtype: 'future_subtype', content: [textBlock('别猜')] },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '半句话' } } },
  ]) {
    const [event] = decode(frame);
    assert.equal(event.kind, 'unknown');
    assert.equal(event.deliver, false);
    assert.equal(event.turnEnded, false);
    assert.strictEqual(event.raw, frame);
    assert.equal(event.text, undefined);
  }
});

test('空 assistant 信封仍输出事件，保留错误与轮次信息', () => {
  const frame = assistant([], { error: 'server_error', user_message_uuid: 'turn-a' });
  const [event] = decode(frame);
  assert.equal(event.kind, 'assistant');
  assert.equal(event.deliver, false);
  assert.equal(event.cliGenerated, true);
  assert.equal(event.user_message_uuid, 'turn-a');
  assert.strictEqual(event.raw, frame);
});

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

test('纯函数 / D-3：冻结输入可解码，重复调用一致，实际模型不改请求值', () => {
  const frame = deepFreeze(assistant([thinkingBlock('旁白'), textBlock('正文')], {
    narration_block_indexes: [0], user_message_uuid: 'turn-a', user_message_uuids: ['turn-a'],
    runtimeParams: { model: 'claude-opus-5[1m]' },
  }, { model: 'claude-opus-5' }));
  const before = JSON.stringify(frame);
  const first = decode(frame);
  decode(assistant([textBlock('另一轮')], { user_message_uuid: 'turn-b' }));
  assert.deepEqual(decode(frame), first);
  assert.equal(JSON.stringify(frame), before);
  assert.equal(first[0].actualModel, 'claude-opus-5');
  assert.equal(frame.runtimeParams.model, 'claude-opus-5[1m]');
  assert.equal(decode(assistant([textBlock('无戳')]))[0].user_message_uuid, undefined);
});

test('模块隔离守卫：加载和调用不需要 require、process、计时器等 IO 能力', () => {
  const source = readFileSync(path.join(__dirname, '../../runtime/decode.js'), 'utf8');
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(source, sandbox, { timeout: 1000 });
  const [event] = sandbox.module.exports.decode(assistant([textBlock('收到了')]));
  assert.equal(event.deliver, true);
  assert.equal(event.text, '收到了');
});
