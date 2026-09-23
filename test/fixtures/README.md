# Test fixtures

Synthetic Claude Code / Agent SDK stream-json frames used by `test/runtime/*`.
They mirror the frame types and envelope fields observed from real runs
(CLI 2.1.278, SDK 0.3.278) but contain only fake UUIDs, a fake cwd and
neutral text.

- `cli-raw.jsonl` - one plain turn: two SessionStart hook frames, `system/init`,
  two `thinking_tokens`, a thinking block, a text block, `rate_limit_event`, `result`.
- `sdk-tool-turn.jsonl` - one turn with a tool call. As observed with the real CLI,
  only the first assistant message and the `result` carry `user_message_uuid`;
  assistant messages after the tool call are unstamped.

If you upgrade the SDK or CLI, capture a real run and compare its shape against
these files before changing `runtime/decode.js`.
