'use strict';

/**
 * 插头 → 通用事件（imb.event.v1，设计稿 §2.1）的翻译，S2b（2026-10-21）。
 *
 * 原来 codex / DeepSeek 插头先拼一个**假的 Claude 帧**再丢给 runtime/decode.js —— 工具调用、reasoning 全丢，
 * 用量还要先翻成 Claude 的字段名。现在插头直接吐中性事件，盒子（S2a 起双认）直接吃。
 * Claude 插头吐的是真 SDK 帧，在宿主里用 src/box/history-claude.js 的 claudeToNeutral 翻（跟盒子全本记账同一份）。
 *
 * 只放纯函数：不读写任何东西。
 */

const { claudeToNeutral, NEUTRAL } = require('../src/box/history-claude');
const { isNarration, isSyntheticMessage } = require('../src/box/claude-judges');

/** 一条通用事件（补齐 v / engine / sidechain / turn）。 */
function neutral(engine, turn, ev) {
  return { v: NEUTRAL, engine, sidechain: false, ...(turn ? { turn } : {}), ...ev };
}

function mcpResultText(result) {
  if (!result || !Array.isArray(result.content)) return '';
  return result.content.map((c) => {
    if (c && typeof c === 'object' && c.type === 'text') return String(c.text || '');
    return typeof c === 'string' ? c : JSON.stringify(c);
  }).join('\n');
}

/**
 * codex app-server 0.163.0 的 ThreadItem（item/completed 里的）→ 通用事件（不带 v/engine/turn，调用方补）。
 *   commandExecution → tool.call(shell) + tool.result
 *   mcpToolCall      → tool.call(mcp__server__tool) + tool.result
 *   dynamicToolCall  → tool.call + tool.result
 *   fileChange       → tool.call(apply_patch) + tool.result
 *   reasoning        → reasoning（opaque 里放 summary / content；app-server 不给 encrypted_content）
 * agentMessage / userMessage / contextCompaction 不在这里（正文和压缩各有自己的路）。
 */
function codexItemToNeutral(item) {
  if (!item || typeof item !== 'object' || !item.id) return [];
  const id = String(item.id);
  switch (item.type) {
    case 'commandExecution': {
      const failed = item.status === 'failed' || item.status === 'declined' || (Number.isInteger(item.exitCode) && item.exitCode !== 0);
      return [
        { kind: 'tool.call', id, name: 'shell', server: '', args: { command: String(item.command || ''), cwd: String(item.cwd || '') } },
        { kind: 'tool.result', callId: id, isError: Boolean(failed), text: String(item.aggregatedOutput || ''), images: [],
          meta: { status: item.status || '', exitCode: item.exitCode ?? null, durationMs: item.durationMs ?? null } },
      ];
    }
    case 'mcpToolCall': {
      const server = String(item.server || '');
      const tool = String(item.tool || '');
      const err = item.error && item.error.message ? String(item.error.message) : '';
      return [
        { kind: 'tool.call', id, name: `mcp__${server}__${tool}`, server, args: item.arguments == null ? {} : item.arguments },
        { kind: 'tool.result', callId: id, isError: Boolean(err) || item.status === 'failed', text: err || mcpResultText(item.result), images: [] },
      ];
    }
    case 'dynamicToolCall': {
      const text = (Array.isArray(item.contentItems) ? item.contentItems : [])
        .map((c) => (c && typeof c === 'object' && typeof c.text === 'string' ? c.text : JSON.stringify(c))).join('\n');
      return [
        { kind: 'tool.call', id, name: String(item.tool || ''), server: String(item.namespace || ''), args: item.arguments == null ? {} : item.arguments },
        { kind: 'tool.result', callId: id, isError: item.success === false || item.status === 'failed', text, images: [] },
      ];
    }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      return [
        { kind: 'tool.call', id, name: 'apply_patch', server: '', args: { paths: changes.map((c) => c && c.path).filter(Boolean) } },
        { kind: 'tool.result', callId: id, isError: item.status === 'failed' || item.status === 'declined',
          text: changes.map((c) => `${c.kind || '?'} ${c.path || ''}`).join('\n'), images: [] },
      ];
    }
    case 'reasoning':
      return [{ kind: 'reasoning', id, opaque: { engine: 'codex', summary: Array.isArray(item.summary) ? item.summary : [],
        content: Array.isArray(item.content) ? item.content : [] } }];
    default:
      return [];
  }
}

/**
 * codex 的 tokenUsage → usage 事件。context = 上一次请求的 input + output（跟 codex 自己的 totalTokens 一个口径，
 * 也就是原来折成 Claude 四个数相加的那个数，S3c 实测 56,112）。只有累计数没有 last：不报（别拿累计数冒充水位）。
 */
function codexUsageEvent(tokenUsage, model) {
  if (!tokenUsage || typeof tokenUsage !== 'object') return null;
  const b = (tokenUsage.last && typeof tokenUsage.last === 'object') ? tokenUsage.last
    : (tokenUsage.total && typeof tokenUsage.total === 'object' ? null : tokenUsage);
  if (!b) return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const cached = n(b.cachedInputTokens);
  const written = b.cacheWriteInputTokens == null ? null : n(b.cacheWriteInputTokens);
  const input = Math.max(0, n(b.inputTokens) - cached - (written || 0));
  const output = n(b.outputTokens);
  return { kind: 'usage', model, input, output, cacheRead: cached, cacheWrite: written, context: n(b.inputTokens) + output };
}

/** OpenAI 兼容（DeepSeek）的 usage → usage 事件。没有缓存写这一项 → null（不是 0）。 */
function openaiUsageEvent(usage, model) {
  if (!usage || typeof usage !== 'object') return null;
  const n = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const prompt = n(usage.prompt_tokens ?? usage.input_tokens) || 0;
  const hit = n(usage.prompt_cache_hit_tokens ?? usage.cache_read_input_tokens);
  const output = n(usage.completion_tokens ?? usage.output_tokens) || 0;
  return { kind: 'usage', model, input: Math.max(0, prompt - (hit || 0)), output, cacheRead: hit, cacheWrite: null, context: prompt + output };
}

/**
 * Claude 插头的 onEvent 包一层：runtime/decode 的事件（带真 SDK 帧）→ 通用事件。
 * 归属（bindings）原样带着；翻不出东西的帧（system/init 之类）不往外送 —— 盒子那头本来也不用它们。
 */
function wrapClaudeOnEvent(onEvent) {
  return async ({ event, bindings }) => {
    for (const ev of claudeToNeutral(event, { isNarration, isSyntheticMessage })) {
      const turn = bindings && bindings[0] && bindings[0].uuid;
      await onEvent({ event: { ...ev, ...(turn ? { turn } : {}) }, bindings });
    }
  };
}

module.exports = { neutral, codexItemToNeutral, codexUsageEvent, openaiUsageEvent, wrapClaudeOnEvent, mcpResultText, NEUTRAL };
