'use strict';

/**
 * 入参校验 + 说明书里那截「Input: {…}」签名（2026-09-20 从老 tool-host.js 搬过来）。
 *
 * 两样都得**跟老的一字不差**：
 *   · 校验报错的原文他见过几个月（`nova_xxx input.foo is not allowed.`），换个说法他会以为是新毛病
 *   · 老壳往每个工具的说明后面拼了一段 ` Input: { query: string, limit?: integer }`，
 *     那是他看到的说明书的一部分，不拼 = 换个壳就换了说明书
 *
 * ⚠️ 老的校验**不查 enum**（黑屋的 kind、self_state 的 parts 都是 enum）——
 * 那两个的把关在各自的逻辑里（黑屋抛错、self_state 静默忽略）。这里照旧不查，
 * 否则报错原文会变。
 */

function text(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** 老 validateSchema 的逐条对照：必填 → 多余键 → 逐键递归 → 数组逐项 → 标量类型。 */
function validateSchema(schema, value, toolName, at) {
  if (!schema || typeof schema !== 'object') return;
  const t = schema.type;
  if (t === 'object') {
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
  if (t === 'array') {
    if (!Array.isArray(value)) throw new Error(`${toolName} ${at} must be an array.`);
    if (schema.items) value.forEach((item, i) => validateSchema(schema.items, item, toolName, `${at}[${i}]`));
    return;
  }
  if (t === 'string' && typeof value !== 'string') throw new Error(`${toolName} ${at} must be a string.`);
  if (t === 'boolean' && typeof value !== 'boolean') throw new Error(`${toolName} ${at} must be a boolean.`);
  if (t === 'integer' && !Number.isInteger(value)) throw new Error(`${toolName} ${at} must be an integer.`);
  if (t === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error(`${toolName} ${at} must be a number.`);
  }
}

/** `{ query: string, limit?: integer }` 那种签名。可选键带 `?`，数组写成 `string[]`。 */
function summarizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return '';
  const t = text(schema.type).toLowerCase();
  if (t === 'object') {
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const entries = Object.entries(props);
    if (!entries.length) return '{}';
    return `{ ${entries.map(([k, v]) => `${k}${required.has(k) ? '' : '?'}: ${summarizeSchema(v) || 'any'}`).join(', ')} }`;
  }
  if (t === 'array') return `${summarizeSchema(schema.items) || 'any'}[]`;
  if (['integer', 'number', 'string', 'boolean'].includes(t)) return t;
  return t || 'any';
}

/** 他看到的说明书 = 原描述 + ` Input: 签名`（老 buildToolDescription）。 */
function buildDescription(description, inputSchema) {
  const base = text(description);
  const sig = summarizeSchema(inputSchema);
  return sig ? `${base} Input: ${sig}` : base;
}

module.exports = { validateSchema, summarizeSchema, buildDescription };
