# Gate specification

This document defines the gate (the message pipeline in `src/gate/`): its
architecture, iron rules and the protocols between its parts. Code comments
refer to its sections (e.g. "SPEC §4").

## 0 What it is

The gate is a **message pipeline**, independent of any particular agent
runtime. It connects chat platforms (plugins, "legs") to one agent session (the
"box"). Scheduled or proactive content (check-ins, reminders, etc.) is produced
by **event producers** that push into the gate; they are not part of it.

Test of success: copy `src/gate/` to a clean machine, provide configuration and
credentials, and it runs.

## 1 Architecture

```
                      producers (check-ins, reminders, ...)
                                   │  pushed in, not routed through plugins
                                   ▼
owner ─→ inbound plugin ─→ shared layer ─→ [ box / CLI ] ─→ shared layer ─→ outbound plugin ─→ owner
         fetch from          identify·number   the agent      segment·pace      platform actions
         platform            verify·cold log   five-call       clean·ledger
         decrypt/decode      batch·transcribe  interface       cold log
```

- **Plugins** guarantee two things: messages can be received and sent. Platform
  specifics (decryption, decoding, download) live only in the plugin.
- **The shared layer** exists once; every plugin gets it automatically.
- **The box is replaceable** and not part of the gate. Its interface has five
  calls: deliver a turn / get replies out / turn done / rotate (new session) /
  fullness. Runtime-specific work (resume, trimming, fallback) stays inside the box.
- **Producers are not part of the gate.** Removing them leaves the gate working.

### Decision in the shared layer, action in the plugin

| Concern | Decision | Action |
|---|---|---|
| Segmenting | how many parts, what spacing → shared | send the parts → plugin |
| Typing indicator | whether to show → shared | which platform API → plugin |
| Image batching | shared only | — |
| Transcription / vision | shared end-to-end | plugin provides clean bytes |
| Decryption / decoding | — | plugin only |

## 2 Iron rules

1. **Portable**: nothing under `src/gate/` requires files outside it; no
   hard-coded paths (everything is passed in); external commands it depends on
   (ffmpeg, zstd, sqlcipher, decoder scripts) are checked at startup and
   reported immediately if missing.
2. **No tool names in the gate.** The gate exposes a single outlet: "I want to
   send this (intent + content)". It does not know who calls it. Renaming,
   removing or replacing tools requires no gate change. There is no "send to
   whom" parameter on the outlet at all.
3. **All tools are removable.** Removing any tool leaves the core running.
4. **No extra fields in the cold log** (see §6).

Self-check:
```bash
grep -rn 'require("\.\./\.\./\|require("\.\./services\|require("\.\./core\|require("\.\./adapters' \
  src/gate/ --include=*.js | grep -v 'plugins/.*require("\.\./\.\./errors")'   # rule 1 → 0 hits
```

## 3 Envelope (unified message format)

Everything that enters the box has this shape, whether it came from the owner
or from a producer. Origin is a **structured field**, never a line of text in
the body.

```
Envelope
├─ trace_id          identity of one message through inbound → box → outbound; on every log line
├─ seq               sequence number, assigned when delivered to the box; serial across plugins
├─ created_at
├─ source
│   ├─ kind          user | system | box
│   ├─ producer      free-form producer name (not validated or enumerated by the gate)
│   ├─ platform      telegram | imessage | wechat | …   (empty when kind≠user)
│   ├─ chat_id       native, bare (no "telegram:" prefix)
│   ├─ sender_id     real platform id — never identify people by nickname
│   └─ native_id     platform message id, used for inbound dedup
├─ target
│   ├─ person
│   ├─ platform / chat_id    resolved destination
│   └─ policy        which routing tier resolved it (see §4)
├─ identity          who it is; unrecognised = unknown = not delivered
├─ verdict           ok | undecoded | no_content
├─ processing[]      none | decrypted | transcribed | vision | acoustic
├─ payload
│   ├─ text
│   └─ media[]       {kind, ref, path, bytes_len, …}
└─ cold              whether it goes to the cold log and with what text
```

`schema_version` is attached to on-disk log records only, never to cold-log
records (§6) and not to in-process objects.

## 4 Routing — five tiers

Evaluated in order; first match wins:

1. **Original route** (this turn answers a specific inbound message) → reply there.
2. **Explicit target** (system producers only; tools cannot set one) → use it.
3. **Proactive message** → `last_active_route`. Only the owner's inbound
   messages count as activity, never the agent's outbound messages.
4. If that route is unusable → `preferred_route` (from configuration).
5. Nothing → **hold, do not guess**.

## 5 Delivery semantics

### Two kinds of failure

| | Criterion | Handling |
|---|---|---|
| **Definitely not sent** | failed before touching the platform, or platform explicitly rejected | may retry or use another plugin |
| **Unknown** | timeout, connection drop, crash mid-send | **never auto-resend**; goes to dead letters for review |

Supported platforms do not honour idempotency keys; a resend is a duplicate.

### Dedup

- **Inbound**: a platform message (`native_id`) is processed once; a redelivery
  keeps its original seq and is not written to the cold log twice.
- **Outbound**: record "about to send" before sending and the result after. A
  crash in between leaves an "unknown" record that is surfaced, not resent.

### Ordering

- The box handles one turn at a time; the gate must not bypass the queue.
- Sequence numbers are assigned serially in one process across all plugins.
- Outbound ordering on some platforms is not guaranteed; spacing between
  segments mitigates it.

### Silence

No text = the agent chose not to reply; the cold log records "no reply this
turn". **Content that could not be delivered must never look like silence** —
it is recorded in the event log (§6).

## 6 Cold log and event log — two files joined by id

### Cold log (for memory lookup and session warm-up)

Exactly four fields: `id` / `role` / `at` / `text`.

- **No additional fields.** Cold-log text may be replayed into a session, so
  technical fields would become noise in the agent's context.
- Delivery notes ("not delivered", etc.) never go into the text; they go into
  the event log.
- `cold-writer.js` is the **only** writer; plugins cannot reach it.
- Recommended: keep an append-only archive copy on separate storage; cleanup
  scripts touch only the primary copy.

### Event log (for tracing)

trace_id, seq, plugin, event id, turn id, verdict, delivered or not, failure
kind, `schema_version`, and the **id of the cold-log record** it refers to. No
message text — text lives only in the cold log.

## 7 Status view (optional, read-only, outside the core)

A table of time / speaker / plugin / status / text (joined from the cold log by
id), searchable by trace_id:

| Seen | Meaning |
|---|---|
| record marked not delivered | the agent replied; delivery layer failed |
| record without mark | delivered; problem is on the platform side |
| only "no reply this turn" | the agent chose not to reply |

## 8 Component notes

- **Receivers** (`receiver.js`) advance a plugin's cursor only after a message is
  fully digested; an undigestible message goes to dead letters without blocking
  the rest; a failed fetch leaves the cursor untouched.
- **Push-based platforms** (e.g. iMessage) write each pushed message to disk
  (`tmp → rename`) and `poll()` reads from disk, so they share the polling
  interface and survive crashes.
- **Capabilities** are default-deny per plugin: a plugin handles only intents
  it explicitly implements; anything else is reported as unsupported, never
  degraded into a text message.
- **Segmentation** (`segment.js`) is shared: split on blank lines only (single
  newlines are formatting), merge very short parts, cap the number of bubbles,
  hard-split as a last resort. Platform length limits are the plugin's job.
  Only `send_text` is segmented; the cold log stores the full text, not the fragments.
- **Groups** (`group.js`) are a shared-layer concern, not a plugin: allow-list
  keys are `channel:groupId`; wake rules are decided here from facts the plugin
  provides (`chatType`, `senderId`, `senderName`,
  `addressing{mentionsMe,repliedToMe,senderIsBot}`); owner identity comes from
  platform ids, never display names; commands are matched before batch
  rendering and are never authorised by group identity.
- **Outlet** (`outlet.js`) is the single "send this" entry point with no
  destination parameter; destination fields supplied by callers are dropped
  and logged.
- **Box contract** (`box.js`): five calls, validated at assembly; a fake box is
  provided for tests. `buildGate` requires `box` explicitly (`null` for
  read-only use such as the shadow).
- **Host** (`src/host/main.js`, not part of the gate): reads configuration from
  environment variables, assembles the gate, attaches plugins, runs forever,
  writes a heartbeat file. `--check` validates without running. Persona
  (`GATE_PERSONA`) decides *what* is injected; the box decides *how*.
  Injection goes to the CLI only, never into the cold log; an injection failure
  is logged loudly but never drops the owner's turn. One persona per process.

## 9 Non-goals

- No grafting onto other bridges; the gate is complete on its own.
- The box interface is shaped by Claude Code's needs; other runtimes adapt to it.
