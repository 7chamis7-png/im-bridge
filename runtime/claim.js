'use strict';

const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 状态由调用方持有并注入；调用方不能直接改写已登记的 Map 条目。 */
function createClaim({ bindings, createUuid = randomUUID } = {}) {
  if (!(bindings instanceof Map)) throw new Error('轮次认领需要调用方提供绑定表 Map。');

  function enqueue(message, origin, uuid = message?.uuid ?? createUuid()) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new Error('入队消息必须是对象，才能带上轮次 UUID。');
    }
    if (!nonempty(uuid) || (message.uuid != null && message.uuid !== uuid)) {
      throw new Error('轮次 UUID 为空或与消息自带的 UUID 不一致，不能建立归属。');
    }
    // runtime-rules.md B-1/B-2：只收结构化来路，入队时固定 threadId 和收件人。
    // 待确认假设：渠道适配层使用这三个字符串字段，见当日 worklog「等确认」。
    if (!origin || !['channel', 'threadId', 'recipient'].every((key) => nonempty(origin[key]))) {
      throw new Error('消息缺少渠道、threadId 或收件人，不能猜测回复该发给谁。');
    }
    const binding = freeze(structuredClone({ uuid, message: { ...message, uuid }, origin }));
    if (bindings.has(uuid)) {
      const previous = bindings.get(uuid);
      if (!isDeepStrictEqual(previous, binding)) {
        throw new Error(`轮次 ${uuid} 已绑定另一条消息或归属，不能覆盖。`);
      }
      return previous;
    }
    bindings.set(uuid, binding);
    return binding;
  }

  function lookup(event) {
    // runtime-rules.md B-2：回包只查协议 UUID；不读当前轮、不读正文、不沿用上次命中。
    const ids = new Set([
      event?.user_message_uuid,
      ...(Array.isArray(event?.user_message_uuids) ? event.user_message_uuids : []),
    ]);
    // 待确认假设：返回全部绑定，跨渠道合并/投递策略留给装配层，见 worklog。
    return [...ids].filter((id) => nonempty(id) && bindings.has(id)).map((id) => bindings.get(id));
  }

  return { enqueue, lookup };
}

module.exports = { createClaim };
