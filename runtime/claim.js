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

/** State is owned and injected by the caller; registered Map entries are frozen and must not be mutated. */
function createClaim({ bindings, createUuid = randomUUID } = {}) {
  if (!(bindings instanceof Map)) throw new Error('轮次认领需要调用方提供绑定表 Map。');

  function enqueue(message, origin, uuid = message?.uuid ?? createUuid()) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new Error('入队消息必须是对象，才能带上轮次 UUID。');
    }
    if (!nonempty(uuid) || (message.uuid != null && message.uuid !== uuid)) {
      throw new Error('轮次 UUID 为空或与消息自带的 UUID 不一致，不能建立归属。');
    }
    // runtime-rules B-1/B-2: only accept a structured origin; threadId and recipient are fixed at enqueue time.
    // Assumption: channel adapters use these three string fields.
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
    // runtime-rules B-2: replies are matched by protocol UUID only - never by "current turn", body text or a previous hit.
    const ids = new Set([
      event?.user_message_uuid,
      ...(Array.isArray(event?.user_message_uuids) ? event.user_message_uuids : []),
    ]);
    // Returns every binding; cross-channel merge / delivery policy is left to the assembly layer.
    return [...ids].filter((id) => nonempty(id) && bindings.has(id)).map((id) => bindings.get(id));
  }

  return { enqueue, lookup };
}

module.exports = { createClaim };
