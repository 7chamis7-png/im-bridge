'use strict';

/**
 * Parsed SDK frame -> array of normalized events. No IO, no dependencies, no state
 * across calls, never mutates the input.
 * Assistant frames are split per content block; every other frame (including unknown
 * ones) yields at least one event.
 * deliver=true marks a deliverable text candidate; turn claiming and channel selection
 * are the caller's job. raw / block / UUID arrays keep the original references and must
 * be treated as read-only.
 */
function decode(frame) {
  const isAssistant = frame.type === 'assistant';

  // runtime-rules D-1: trust the assistant envelope only; never keyword-match the body or guess error codes.
  const cliGenerated = isAssistant && (frame.error != null || frame.isSynthetic === true);

  // runtime-rules B-1/B-2 (origin / ownership). A frame with parent_tool_use_id belongs to a subagent.
  const isSubagent = frame.parent_tool_use_id != null;
  const common = {
    raw: frame,
    deliver: false,
    turnEnded: false,
    // runtime-rules B-2: pass the protocol stamps through untouched; never infer from message ids.
    user_message_uuid: frame.user_message_uuid,
    user_message_uuids: frame.user_message_uuids,
    parent_tool_use_id: frame.parent_tool_use_id,
    isSubagent,
    cliGenerated,
    error: isAssistant ? frame.error : undefined,
    // runtime-rules D-3: observed model only; never written back into the requested config.
    actualModel: isAssistant ? frame.message?.model : undefined,
  };

  // runtime-rules A-1: the turn ends at `result`, not at stop_reason=end_turn
  // (a Stop hook can still produce text after end_turn).
  if (frame.type === 'result') {
    // A subagent result does not end the main turn. result.result usually repeats the
    // assistant text, so it is never delivered as a second copy.
    return [{ ...common, kind: 'result', turnEnded: !isSubagent }];
  }

  if (isAssistant) {
    const content = frame.message?.content;
    if (!Array.isArray(content) || content.length === 0) {
      return [{ ...common, kind: 'assistant' }];
    }

    // Narration is identified only by narration_block_indexes (zero-based positions in
    // this frame's message.content), not by token-count heuristics.
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
          // runtime-rules D-2: real thinking is never delivered or exposed as text.
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

  // runtime-rules F-1: stream_event does not change delivery. Unknown frames/subtypes are
  // passed through (no guessing, no dropping). system/init's apiKeySource stays in raw;
  // the G-1 startup guard is enforced by the caller - decode never touches the process.
  return [{ ...common, kind: 'unknown' }];
}

module.exports = { decode };
