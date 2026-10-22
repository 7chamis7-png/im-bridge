'use strict';

/**
 * 已解析的 SDK 帧 -> 规范事件数组。无 IO、依赖或跨调用状态，不修改输入。
 * assistant 按内容块拆事件；其余帧（包括未知帧）至少保留一个事件。
 * deliver=true 表示可投递正文候选；轮次认领、渠道选择由上层负责。
 * raw、block 和 UUID 数组保留原引用，消费者必须只读。
 */
function decode(frame) {
  const isAssistant = frame.type === 'assistant';

  // runtime-rules.md D-1：只认 assistant 信封，不查正文关键词，也不猜错误码列表。
  const cliGenerated = isAssistant && (frame.error != null || frame.isSynthetic === true);

  // runtime-rules.md B-1/B-2（来源/归属）；具体子代理判据见 runtime-arch.md §2 新增规则。
  const isSubagent = frame.parent_tool_use_id != null;
  const common = {
    raw: frame,
    deliver: false,
    turnEnded: false,
    // runtime-rules.md B-2，架构 v2：原样带出协议盖戳，不用消息 ID 猜，不补上一轮。
    user_message_uuid: frame.user_message_uuid,
    user_message_uuids: frame.user_message_uuids,
    parent_tool_use_id: frame.parent_tool_use_id,
    isSubagent,
    cliGenerated,
    error: isAssistant ? frame.error : undefined,
    // runtime-rules.md D-3：只提供模型观测值，绝不写回请求配置。
    actualModel: isAssistant ? frame.message?.model : undefined,
  };

  // runtime-rules.md A-1（等真结果）；result 边界见 runtime-arch.md §2 新增规则。
  // 不看 stop_reason=end_turn，Stop hook 后还可能有正文。
  if (frame.type === 'result') {
    // 待确认假设：子代理 result 不结束主轮；kind/raw 仍完整保留给上层。
    // result.result 常重复 assistant 正文，不能作为第二份正文投递。
    return [{ ...common, kind: 'result', turnEnded: !isSubagent }];
  }

  if (isAssistant) {
    const content = frame.message?.content;
    if (!Array.isArray(content) || content.length === 0) {
      return [{ ...common, kind: 'assistant' }];
    }

    // runtime-rules.md D-2 的旧 token 判据已被架构 v2 / 本轮要求纠正：只读索引。
    // 待确认假设：索引是本帧 message.content 的零基位置；真实 fixture 暂无旁白。
    const narrationIndexes = frame.narration_block_indexes ?? [];
    return content.map((block, blockIndex) => {
      let kind = 'unknown';
      let text;
      if (block.type === 'text') {
        kind = 'text';
        text = block.text;
      } else if (block.type === 'thinking') {
        if (narrationIndexes.includes(blockIndex)) {
          kind = 'narration';
          text = block.thinking;
        } else {
          // runtime-rules.md D-2：真 thinking 不投、不提取为 text；原块仅供内部使用。
          kind = 'thinking';
        }
      }
      return {
        ...common,
        kind,
        block,
        blockIndex,
        ...(kind === 'text' || kind === 'narration' ? { text } : {}),
        deliver: !cliGenerated && !isSubagent && (kind === 'text' || kind === 'narration'),
      };
    });
  }

  // runtime-rules.md F-1：stream_event 不改变默认投递行为；本轮要求未知事件原样带出。
  // 未知帧/子类型不猜正文，不丢弃；system/init 的 apiKeySource 也在 raw 中保留，
  // runtime-rules.md G-1 的启动阻断必须由后续装配层执行，纯 decode 不操作进程。
  return [{ ...common, kind: 'unknown' }];
}

module.exports = { decode };
