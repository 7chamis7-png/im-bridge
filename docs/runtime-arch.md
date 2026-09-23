# Runtime layer architecture (Agent SDK)

The runtime layer talks to Claude Code through the official
`@anthropic-ai/claude-agent-sdk`, pointed at the local `claude` binary
(`pathToClaudeCodeExecutable`). The SDK speaks the same stream-json protocol as
the CLI and adds typed control methods (`setModel`, `interrupt`, resume,
streaming input). The rules it must satisfy are in
[`runtime-rules.md`](runtime-rules.md).

## 1. Verified SDK behaviour

Verified by running the same prompt through the bare CLI and through the SDK
and comparing the raw frames:

1. **`user_message_uuid` can be used for claiming.** A message written with its
   own uuid gets that uuid stamped on the first assistant frame of the turn and
   on the `result` frame. `user_message_uuids` (array) covers batched turns.
2. **The SDK passes frames through raw.** Nothing is dropped or merged; it only
   adds `command_lifecycle` frames and its own `uuid`. Decisions stay ours.
3. **Same binary.** It is a different way of invoking the CLI, not a different engine.
4. **Every CLI flag we use is available**, plus an `extraArgs` escape hatch.

## 2. Rules mapped to responsibilities

| Rule | Owner | How |
|---|---|---|
| B-1 structured origin | SDK | `SDKUserMessage.origin` |
| B-2 thread id fixed at enqueue | SDK | `user_message_uuid` stamped at protocol level |
| D-5 model switch in session | SDK | `query.setModel()` |
| F-1 token streaming | SDK | `includePartialMessages` |
| D-1 envelope-only synthetic detection | SDK data, our criterion | assistant `error` / `isSynthetic` / `<synthetic>` model / refusal |
| D-2 narration as text | SDK data, our criterion | `narration_block_indexes` |
| A-1 ack waits for real result | partly SDK | control methods return Promises; delivery state tracked by us |
| A-2 no dropped messages | us | `runtime/ingress.js` |
| C-1 no double injection | us | prompt is built entirely by the caller |
| C-2 hand-off never in groups | us | business logic |
| D-3 observed model read-only | us | `message.model` is never written back |

Two additional criteria:

- **`parent_tool_use_id != null` means subagent output.** It must be filtered,
  otherwise a subagent's text is delivered as the agent's reply.
- **`result` is the only true turn boundary.** After `end_turn` a Stop hook can
  keep the turn running.

## 3. Modules

```
runtime/
  decode.js    SDK message -> canonical events   (pure functions; all criteria live here)
  claim.js     claim replies by user_message_uuid (bind at enqueue, attribute by uuid)
  ingress.js   durable ingress (persist + three states)
  index.js     assembly: query() + the three above
cli-host/      the long-lived process that owns the CLI (im-cli) and serves it over a socket
adapters/box-runtime.js   adapts the runtime to the box interface used by the gate
```

### Ingress state machine (`ingress.js`)

| Crashed while | Becomes | Because |
|---|---|---|
| `dispatching` | `pending` | definitely not submitted → safe to replay |
| `started` | `uncertain` | possibly submitted → never auto-replayed, kept for reconciliation |

Persisting must happen **before** writing to the CLI's stdin. Persisting after
the write reopens the window where a message is written, the process restarts,
and the message is replayed — the owner receives it twice or a tool runs twice.

## 4. When the process dies

Shutdown ladder: `interrupt()` → `SIGTERM` → `SIGKILL` → wait for Node's
`close` event (not `exit`). Waiting for `close` drains any stdout not yet read,
so a reply produced right before exit is still delivered. Only then are rows
marked `uncertain`, the owner notified, and a new process started.

Two processes resuming the same session id do not interleave — they fork the
history. Always confirm the old process has stopped before starting a new one.

## 5. Stuck processes

A child that is alive but unresponsive produces no exit event, so the current
turn holds its slot forever and later messages never get submitted. Minimum
handling: tell the owner the turn is stuck, and provide a command that
abandons the current turn and frees the slot. Long tool calls are not killed
automatically.

## 6. Versioning

Pin exact SDK/CLI versions in `package.json`. Upgrades are manual; after an
upgrade, rerun a probe (same prompt through CLI and SDK) and compare against
the decode tests before changing `decode.js`.
