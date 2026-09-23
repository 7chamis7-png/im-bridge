'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createClaim } = require('../../runtime/claim');

const origin = () => ({ channel: 'telegram', threadId: 'thread-a', recipient: 'person-a' });
const setup = (options = {}) => createClaim({ bindings: new Map(), ...options });

test('B-2：入队生成 UUID，写进消息且登记在调用方的表中', () => {
  const bindings = new Map();
  const claim = setup({ bindings, createUuid: () => 'generated' });
  const message = { text: 'owner message' };
  const binding = claim.enqueue(message, origin());
  assert.equal(binding.uuid, 'generated');
  assert.equal(binding.message.uuid, 'generated');
  assert.equal(message.uuid, undefined);
  assert.strictEqual(bindings.get('generated'), binding);
  assert.deepEqual(claim.lookup({ user_message_uuid: 'generated' }), [binding]);
});

test('接受显式 UUID 或消息自身 UUID；默认生成有效 UUID', () => {
  const claim = setup();
  assert.equal(claim.enqueue({ text: 'a' }, origin(), 'explicit').uuid, 'explicit');
  assert.equal(claim.enqueue({ uuid: 'own', text: 'b' }, origin()).uuid, 'own');
  assert.match(claim.enqueue({ text: 'c' }, origin()).uuid, /^[0-9a-f-]{36}$/);
  assert.throws(() => claim.enqueue({ uuid: 'own' }, origin(), 'other'), /不一致/);
});

test('B-2：排队后修改当前来源及原消息，交错回包仍查入队时的快照', () => {
  const claim = setup();
  const current = origin();
  const message = { content: [{ text: '第一条' }] };
  const a = claim.enqueue(message, current, 'a');
  current.threadId = 'thread-b';
  current.channel = 'wechat';
  current.recipient = 'person-b';
  message.content[0].text = '第二条';
  const b = claim.enqueue(message, current, 'b');
  current.threadId = '';
  assert.deepEqual(claim.lookup({ user_message_uuid: 'b' }), [b]);
  assert.deepEqual(claim.lookup({ user_message_uuid: 'a' })[0].origin, origin());
  assert.equal(a.message.content[0].text, '第一条');
  assert.throws(() => { a.origin.threadId = 'overwrite'; }, TypeError);
  assert.throws(() => { a.message.content[0].text = 'overwrite'; }, TypeError);
});

test('B-2：单个与数组 UUID 取并集；未知单个不挡住数组命中，重复项只返回一次', () => {
  const claim = setup();
  const a = claim.enqueue({}, origin(), 'a');
  const b = claim.enqueue({}, { ...origin(), channel: 'wechat' }, 'b');
  assert.deepEqual(claim.lookup({ user_message_uuids: ['missing', 'b', 'a', 'b'] }), [b, a]);
  assert.deepEqual(claim.lookup({ user_message_uuid: 'a', user_message_uuids: ['b', 'a'] }), [a, b]);
  assert.deepEqual(claim.lookup({ user_message_uuid: 'missing', user_message_uuids: ['a'] }), [a]);
});

test('B-1/B-2：缺失或未知 UUID 不拿当前轮、帧 ID、session 或正文猜归属', () => {
  const claim = setup();
  claim.enqueue({}, origin(), 'a');
  claim.lookup({ user_message_uuid: 'a' });
  for (const event of [undefined, {}, { user_message_uuid: 'unknown' },
    { uuid: 'a', session_id: 'a', message: { id: 'a' }, text: '<channel telegram>' },
    { user_message_uuid: null, user_message_uuids: 'a' }]) {
    assert.deepEqual(claim.lookup(event), []);
  }
});

test('重复登记相同绑定幂等，UUID 冲突不能篡改消息或归属', () => {
  const claim = setup();
  const a = claim.enqueue({ text: 'a' }, origin(), 'a');
  assert.strictEqual(claim.enqueue(a.message, origin()), a);
  assert.throws(() => claim.enqueue({ text: 'b' }, origin(), 'a'), /不能覆盖/);
  assert.throws(() => claim.enqueue({ text: 'a' }, { ...origin(), recipient: 'other' }, 'a'), /不能覆盖/);
  assert.deepEqual(claim.lookup({ user_message_uuid: 'a' }), [a]);
});

test('状态必须显式注入；不同表隔离，同一表可被另一个实例查询', () => {
  assert.throws(() => createClaim(), /绑定表/);
  const bindings = new Map();
  const a = setup({ bindings }).enqueue({}, origin(), 'a');
  assert.deepEqual(setup({ bindings }).lookup({ user_message_uuid: 'a' }), [a]);
  assert.deepEqual(setup().lookup({ user_message_uuid: 'a' }), []);
});

test('缺少结构化归属或空 UUID 时明确报错，不建立半条绑定', () => {
  const bindings = new Map();
  const claim = setup({ bindings });
  for (const key of ['channel', 'threadId', 'recipient']) {
    assert.throws(() => claim.enqueue({}, { ...origin(), [key]: '' }, 'a'), /不能猜测/);
  }
  assert.throws(() => claim.enqueue({}, origin(), ' '), /UUID/);
  assert.throws(() => claim.enqueue('text', origin(), 'a'), /必须是对象/);
  assert.equal(bindings.size, 0);
});
