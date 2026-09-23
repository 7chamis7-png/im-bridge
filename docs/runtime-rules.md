# Runtime layer rules

These are the invariants the CLI/SDK runtime layer (`runtime/`, `cli-host/`,
`adapters/box-runtime.js`) must keep. Each rule exists because breaking it
causes the owner to receive a message twice, receive the wrong thing, or
receive nothing. Code comments refer to rules by id (`A-1`, `B-2`, ...).

Use this file as an acceptance checklist whenever the runtime layer is changed:
every rule must either have a corresponding implementation (with a comment
pointing here) or a test that covers it.

---

## A. Acknowledgements and state: never send a fake receipt

**A-1 — Control-command acks wait for the real result.**
A command such as `/new` or a model switch must not report success at the
moment the request is written to a socket. It reports success only after the
runtime confirms the change. Likewise, a `write()` returning is not a result:
an ingress row stays `started` until the real `result` frame arrives.

**A-2 — No live CLI process must never mean a silently dropped message.**
If no CLI is running when a message arrives, the message is persisted and the
full `sendTurn` path is taken (start process → bind thread id → run opening
injection). Do not spawn an ad-hoc process that does not know which session to
resume. Only rows in `dispatching` (definitely not submitted) may be replayed
automatically; see the ingress table in `runtime-arch.md`.

## B. Origin and routing: reply where the message came from, never guess

**B-1 — Origin is a structured field, never inferred from the body.**
Prefixes injected into the prompt (channel instructions, state blocks, etc.)
can push any in-body tag away from the start of the text. Trust the structured
origin first, then the unprefixed original text, and only as a last resort the
full body.

**B-2 — The thread id is fixed at enqueue time, not at submit time.**
A queued turn is submitted only after the previous turn's result, by which time
the "active thread" may already have been cleared. Reading it at submit time
yields an empty thread id and a lost routing mark. Replies are matched to their
turn by the protocol UUID (`user_message_uuid`), never by "current turn",
body text or a previous hit.

## C. Injection: hard boundary between the agent's context and the owner's words

**C-1 — When the caller manages opening injection, the runtime must not wrap it again.**
Wrapping an injected persona block in `Current user message:` would label
system context as something the owner said. The bridge always runs in
"caller manages injection" mode.

**C-2 — Hand-off summaries belong to the private thread and must never leak
into a group session's opening.**

## D. Models and fallback

**D-1 — Decide "CLI-generated vs. agent-authored" from the envelope only.**
A refusal or synthetic API error looks like an ordinary text block; only the
message envelope distinguishes it (`model: "<synthetic>"`,
`stop_reason: "refusal"`, `stop_details.type: "refusal"`, SDK `error` /
`isSynthetic`). Keyword matching on the body breaks whenever the wording
changes.

**D-2 — Narration blocks are delivered as text; real thinking blocks are not.**
Some models emit user-facing "narration" between tool calls inside a
thinking-shaped block. Use the SDK's `narration_block_indexes` (with the
signature tag as a fallback). `thinking_tokens=0` is not a reliable criterion.
Real thinking is never delivered or exposed as text.

**D-3 — The observed model is recorded in a read-only snapshot and never
written back into the requested value.**
The observed model id may lack suffixes present in the requested id (e.g. a
context-window suffix). Writing it back would silently drop that suffix on the
next launch. A differing observed id is therefore not by itself proof of a
fallback.

**D-4 — Do not claim `--fallback-model` handles refusals.**
It is wired through, but it is documented for overload/unavailability; refusal
handling is a separate path.

**D-5 — Switching model on the same thread uses `setModel`.**
This avoids process churn; it does not avoid rebuilding the prompt cache
(caches are model-scoped). Keep the client-side model in sync so the next
comparison does not trigger a needless restart.

## E. Timeouts

**E-1 — Long-running external rebuild steps get generous timeouts.**
If a timeout fires while the session is being cleared, a message arriving in
that window can wake the agent with stale state. Timeouts for such steps must
be sized from measurement, not guessed.

## F. Streaming

**F-1 — Token-level streaming is off by default and enabled via environment
variable** (`GATE_CLAUDE_PARTIAL=on`). `stream_event` frames must not change
delivery behaviour; unknown frames and subtypes are ignored.

## G. Billing

**G-1 — After launch, check `init.apiKeySource`.**
Wrapping the local CLI uses whatever authentication that CLI is configured
with. If you intend to run on a subscription login, verify that
`apiKeySource === "none"` on every launch and stop with an error otherwise, so
the bridge never silently switches to metered API billing (for example because
`ANTHROPIC_API_KEY` appeared in the environment or `--bare` was passed).

---

## Other invariants

- **Deleting lines from a transcript breaks the chain.** When removing a line,
  fix the next line's `parentUuid`, otherwise a resume only loads part of the
  history. After such an edit, a running CLI must be reloaded so it re-reads
  the leaf from disk.
- **Two processes must never resume the same session id concurrently.** Each
  keeps its own in-memory leaf and appends to the same file; the history forks.
- **Restarting the process does not invalidate the prompt cache**; rewriting
  history (new session, trimming) does.

## Tests that guard this layer

`test/runtime/*.test.js`, and in `test/gate/`: `reliability-integration.js`,
`turn-recovery.js`, `model-input.js`, `cold-real-replies-only.js`,
`imessage-wiring.js`. These are behavioural contracts and must stay green.
