'use strict';

/**
 * Claude 帧的两个判据（原样从 adapters/box-runtime.js 搬来，2026-10-21 S2b）。
 * 盒子（Claude 帧那条老路、全本记账）和引擎宿主里的 Claude 插头（翻成通用事件）用**同一份**。
 */

const SYNTHETIC_MODEL = '<synthetic>';

/** CLI 造的消息（<synthetic> / 安全层拒答）：不算他说的话。 */
function isSyntheticMessage(message) {
  if (!message || typeof message !== 'object') return false;
  if (message.model === SYNTHETIC_MODEL) return true;
  if (message.stop_reason === 'refusal') return true;
  return message.stop_details?.type === 'refusal';
}

/** 旁白判据：官方索引优先；老代码的签名标签留着兜底（9-03 事故就是靠它修的）。 */
function isNarration(event) {
  if (event.kind === 'narration') return true;
  if (event.kind !== 'thinking') return false;
  const signature = typeof event.block?.signature === 'string' ? event.block.signature : '';
  if (!signature) return false;
  try {
    const decoded = Buffer.from(signature, 'base64').toString('latin1');
    return decoded.includes('narration') && !decoded.includes('thinking');
  } catch { return false; }
}

module.exports = { isSyntheticMessage, isNarration, SYNTHETIC_MODEL };
