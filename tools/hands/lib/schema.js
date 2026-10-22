'use strict';

/**
 * 入参校验 —— 老 tool-host.js 的 validateSchema 那套规矩，在这一包里重写一遍。
 *
 * 为什么要自己校验：共用壳（_lib/mcp-stdio.js）只管收发，不看 schema。
 * 老的 nova_tools 在进 handler 之前**每个工具都过一遍**这道闸：
 *   · required 缺了 → `<tool> input.<key> is required.`
 *   · additionalProperties:false 时多给的键 → `<tool> input.<key> is not allowed.`
 *   · 类型不对 → `<tool> input.<key> must be a string/boolean/integer/number/array/object.`
 * 报错原文照旧（他读惯了）。只管 object / array / string / boolean / integer / number，
 * 跟老的一样不管 enum / min / max —— 那些限制在各自 handler 里。
 */

function validateSchema(schema, value, toolName, at = 'input') {
  if (!schema || typeof schema !== 'object') return;
  const type = schema.type;
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${toolName} ${at} must be an object.`);
    }
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!(key in value)) throw new Error(`${toolName} ${at}.${key} is required.`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) throw new Error(`${toolName} ${at}.${key} is not allowed.`);
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) validateSchema(sub, value[key], toolName, `${at}.${key}`);
    }
    return;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${toolName} ${at} must be an array.`);
    if (schema.items) value.forEach((item, i) => validateSchema(schema.items, item, toolName, `${at}[${i}]`));
    return;
  }
  if (type === 'string' && typeof value !== 'string') throw new Error(`${toolName} ${at} must be a string.`);
  if (type === 'boolean' && typeof value !== 'boolean') throw new Error(`${toolName} ${at} must be a boolean.`);
  if (type === 'integer' && !Number.isInteger(value)) throw new Error(`${toolName} ${at} must be an integer.`);
  if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error(`${toolName} ${at} must be a number.`);
  }
}

/** 给一个工具套上校验：先过闸，再进 handler。 */
function guarded(tool) {
  const inner = tool.handler;
  return {
    ...tool,
    handler: async (args) => {
      validateSchema(tool.inputSchema, args, tool.name, 'input');
      return inner(args);
    },
  };
}

module.exports = { validateSchema, guarded };
