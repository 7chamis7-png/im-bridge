# Gate: two checkpoints + one shared capability layer

The gate is assembled by `src/host/main.js` (process `im-gate`). The box (agent
session) runs in a separate process (`im-box`); the gate connects to it over
`box.sock` (`src/host/box-remote.js`), so restarting the gate does not
interrupt the agent. Full specification: [`docs/SPEC.md`](docs/SPEC.md).

```
platform ──plugin──→ [processing] ─────────────→ [inbound] ──→ CLI (agent)
         fetch/decrypt/    store·transcribe·vision    verify·identify·number·cold log
         decompress/bytes  (shared layer, one copy)

CLI ──→ [outbound] ──plugin──→ platform
        check·ledger·resolve target    format·segment·upload
```

Two boundaries:

- **The gate does not decode.** Platform-specific decryption/decoding belongs to
  the plugin; the gate only checks that the result looks like human text.
- **Processing lives outside the checkpoints.** Plugins only obtain bytes from
  their platform; storing, transcription and vision are shared, so adding a
  new platform does not duplicate them.

## Files

| File | Responsibility |
|---|---|
| **Checkpoints** | |
| `verify.js` | Acceptance: does not decode, but recognises text that is not human-readable |
| `inbound.js` | Inbound: identity normalisation / numbering / cold log; unknown identities are not delivered |
| `outbound.js` | Outbound: target resolved by the gate; silence is the agent's choice; foreign artifacts and quotes are annotated, not blocked |
| `store.js` | Event ledger. Seq assigned at delivery, one sequence across plugins, persists across restarts |
| `cold-writer.js` | The only cold-log writer; plugins cannot reach it |
| `turn-binding.js` | Persists the current turn's origin (tools run in a separate process) |
| `killswitch.js` | File-based switch; unreadable = disabled; no restart needed |
| **Capabilities** | |
| `capabilities.js` | Capability registry + outbound precheck (ask before expensive generation) |
| `surface.js` | Three-layer capability surface: shared / per-plugin / plugin-specific |
| (adapter) | `src/host/gate-capabilities.js` wires concrete services; not part of the gate |
| **Shared processing** | |
| `media-pipeline.js` | `hydrate` = fetch bytes → store → process by type → text |
| `file-store.js` | Content-addressed file store; type sniffed from magic bytes |
| `stickers.js`, `sticker-book.js` | Cross-platform sticker catalogue |
| `segment.js` | Splitting long replies into bubbles |
| `group.js` | Group-chat wake rules and batching |
| `routing.js` | Five-tier routing |
| **Plugins** | |
| `plugins/telegram.js` | Telegram Bot API |
| `plugins/wechat/` | Desktop WeChat on Linux: reads the local encrypted database and sends via accessibility automation. All WeChat-specific decoding lives here. See the warning in the top-level README. |
| `plugins/weixin-bot.js` | A WeChat bot-gateway account (channel `wechat-bot`); separate identity and reply model from `wechat` |
| `plugins/imessage.js` | iMessage (push-based, persisted to disk, then polled) |
| `plugins/phone.js` | Voice-call leg |
| **Assembly** | |
| `wire.js` | `buildGate()` + `makeIntake()` (single inbound entry) + `preflight()` |
| `pipeline.js` | Main loop: inbound → envelope → box → routing → outbound |
| `tools/` | Delivery tools exposed to the agent over MCP (see `tools/README.md`) |
| `tool-socket.js` | Socket the MCP tool server talks to |
| `shadow.js` | Shadow run: feeds real traffic through the checkpoints without sending or injecting |

## Single inbound entry

Collectors (live listener or shadow) only fetch raw records; the rest happens in `intake`:

```js
gate.intake({ channel: "wechat", raw: row, extraMedia: [] })
//  plugin.toDelivery(raw)      plugin decrypts/decodes → delivery (media by reference)
//  media.hydrate(delivery)     fetchMedia gets bytes → ingest stores/transcribes/describes
//  inbound.accept(delivery)    verify / identify / number / cold log
```

Both the shadow and production use this function, so what the shadow validates
is exactly what production delivers.

## Tests

```bash
npm test                 # runtime + gate + cli-host
bash test/run-gate.sh    # gate only
```

Notable ones:

- `intake.js` — the single inbound entry (missing bytes must be reported; file paths must not be lost)
- `wechat-media.js` — WeChat media decoding; tests needing real data skip when keys are absent
- `shadow-direction.js` — database rows have no direction; the sender must be determined

## Design notes embedded in the code

- `verify.js`: newlines are not bad characters.
- `inbound.js`: unknown identities are rejected by default, not by remembering an allow-list.
- `inbound.js` / `media-pipeline.js`: if processing produced text, use it; otherwise fall back to a label — never an empty body.
- `cold-writer.js`: images are stored as `[image]` labels (paths would pull old
  images back into context); voice is stored as its transcript.
- `shadow.js`: transcription is off by default in shadow mode; enable with `GATE_SHADOW_TRANSCRIBE=1`.

## Not implemented

Receiving video on the WeChat plugin.
