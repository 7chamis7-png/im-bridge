"use strict";

/**
 * Real box · claude — wraps the runtime adapter into the five box methods.
 *
 * Not part of the bridge (lives in `src/host/`). The bridge only knows the
 * contract in `src/gate/box.js`; another engine means another file like this.
 *
 * Claude-specific work — resume, session rebuild, model fallback, transcript
 * trimming, the opening pack — stays in here. The bridge only sees: deliver a
 * turn, replies come out, turn done, new session, fullness.
 *
 * Never start two boxes on the same workspaceRoot: two processes resuming the
 * same session corrupt the session file. Tests always use isolated directories.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { assertEnvelope } = require("../gate/envelope");
const { normalizeModelInput } = require("../gate/model-input");

/**
 * The model ACTUALLY in use, read from the last message in claude's own
 * transcript. The configured model is only what was requested; the CLI may
 * have fallen back to another one. Transcript location/format is
 * claude-specific knowledge, so it lives in the box.
 */
/** Model name of CLI-generated messages (refusals, API errors). Their usage is empty. */
const SYNTHETIC = "<synthetic>";
/** Only the transcript tail is read (4 MB holds hundreds of turns). */
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

function readActualFacts({ workspaceRoot, threadId }) {
  if (!threadId) return { model: "", used: null };
  // Claude maps the workspace path to a directory name by replacing BOTH
  // slashes and dots with dashes (e.g. `/home/u/.x/ws` → `-home-u--x-ws`).
  const slug = String(workspaceRoot || "").replace(/[/.]/g, "-");
  const f = path.join(os.homedir(), ".claude", "projects", slug, threadId + ".jsonl");
  try {
    // Read only the tail: transcripts grow to many MB and both facts are at the end.
    const fd = fs.openSync(f, "r");
    let text;
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
      const buf = Buffer.alloc(Math.min(TRANSCRIPT_TAIL_BYTES, size));
      if (buf.length) fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString("utf8");
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);   // drop the partial first line
    } finally { fs.closeSync(fd); }

    let model = "";
    let used = null;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line).message;
        if (!m || typeof m !== "object") continue;
        // Skip synthetic messages: the CLI may append a `model=<synthetic>`
        // message with all-zero usage after a real reply; taking "the last
        // message" would report model <synthetic> and 0 context.
        if (m.model === SYNTHETIC) continue;
        if (typeof m.model === "string" && m.model) model = m.model;
        const u = m.usage;
        if (u && typeof u === "object") {
          const total = Number(u.input_tokens || 0) + Number(u.cache_creation_input_tokens || 0)
            + Number(u.cache_read_input_tokens || 0) + Number(u.output_tokens || 0);
          if (total > 0) used = total;
        }
      } catch { /* skip partial lines */ }
    }
    return { model, used };
  } catch { return { model: "", used: null }; }
}

/**
 * @param {object} o
 * @param {object} o.runtime        runtime adapter
 * @param {string} o.bindingKey     session binding key
 * @param {string} o.workspaceRoot  session workspace. Use isolated dirs in tests.
 * @param {string} [o.model]
 * @param {object|null} [o.persona] `{ name, async opening(ctx) }` — WHAT to inject.
 *   The box decides HOW (opening turn, resume, …). `opening` receives a ctx with
 *   material (cold tail, handoff, reason) and decides ordering, quotas and labels.
 *   The bridge never sees its contents. No persona = runs without an identity.
 * @param {function} [o.log]
 */
function makeClaudeCodeBox({ runtime, bindingKey, workspaceRoot, model = "",
  persona = null, personaContext = () => ({}), log = () => {} }) {
  if (!runtime || typeof runtime.sendTurn !== "function") throw new Error("claude box requires a runtime adapter");
  if (!String(bindingKey || "").trim() || !String(workspaceRoot || "").trim()) {
    throw new Error("claude box requires bindingKey and workspaceRoot (no guessing: collisions corrupt session files)");
  }

  const replyHandlers = [];
  const doneHandlers = [];
  /** turnId -> segments already emitted this turn (dedupe) */
  const saidByTurn = new Map();
  /** Text the agent produced before tool calls; resolved at turn end. */
  const candidatesByTurn = new Map();
  /** turnId -> inbound envelope (runtime events do not always carry trace_id). */
  const envelopeByTurn = new Map();
  /** Envelope in flight while sendTurn emits events synchronously (before turnId is known). */
  let activeEnvelope = null;
  /** last context usage */
  let lastContext = null;
  /** last session id (for reading the transcript) */
  let lastThreadId = "";

  const fire = (handlers, payload) => {
    for (const fn of handlers) {
      try { fn(payload); } catch (e) { log("box callback failed: " + ((e && e.message) || e)); }
    }
  };

  runtime.onEvent((event) => {
    const p = (event && event.payload) || {};
    switch (event && event.type) {
      case "runtime.context.updated":
        // Synthetic messages report all-zero usage; ignore them so the level does not drop to 0.
        if (p.model !== SYNTHETIC && Number(p.currentTokens) > 0) lastContext = p;
        if (p.threadId) lastThreadId = p.threadId;
        break;

      // ——— Tool approval: an unanswered request hangs the turn forever ———
      // Policy here: approve everything automatically (the agent runs
      // unattended; nobody is there to click "allow"). To restrict tools,
      // change this one decision.
      case "runtime.approval.requested": {
        const requestId = p.requestId;
        if (!requestId) { log("[approval] event has no requestId; cannot answer"); break; }
        const what = Array.isArray(p.commandTokens)
          ? p.commandTokens.join(" ") : (p.toolName || "");
        Promise.resolve()
          .then(() => runtime.respondApproval({ requestId, decision: "accept" }))
          .then(() => log("[approval] allowed: " + (what || requestId)))
          .catch((e) => log("[approval] answer failed (the turn will hang): " + ((e && e.message) || e)));
        break;
      }

      case "runtime.turn.started":
        if (p.threadId) lastThreadId = p.threadId;
        break;

      /**
       * Text the agent wrote BEFORE a tool call. Without handling this, in a
       * "say something → call tool → say more" turn the first part is lost,
       * because only the final result is delivered.
       *
       * Collected, not sent immediately: at turn end anything not already
       * contained in the final text is emitted (so nothing is sent twice).
       */
      case "runtime.reply.candidate": {
        const text = String(p.text || "").trim();
        if (!text) break;
        const list = candidatesByTurn.get(p.turnId) || [];
        // Narration blocks (promoted from thinking) are fallback material only.
        if (!list.some((c) => c.text === text)) {
          list.push({ text, narration: p.narration === true, synthetic: p.synthetic === true });
        }
        candidatesByTurn.set(p.turnId, list);
        break;
      }

      case "runtime.reply.completed": {
        const text = String(p.text || "").trim();
        if (!text) break;
        const said = saidByTurn.get(p.turnId) || new Set();
        if (said.has(text)) break;                 // claude may repeat candidates; dedupe here
        said.add(text);
        saidByTurn.set(p.turnId, said);
        const source = envelopeByTurn.get(p.turnId) || activeEnvelope;
        fire(replyHandlers, {
          turnId: p.turnId, threadId: p.threadId, text,
          // false = generated by the CLI (refusal / API error), not the agent.
          // The bridge uses it to decide whether to write the cold log.
          genuine: p.synthetic !== true,
          trace_id: (p.trace_id || p.traceId || (source && source.trace_id) || ""),
          at: Date.now(),
        });
        break;
      }

      case "runtime.turn.completed": {
        const said = saidByTurn.get(p.turnId) || new Set();
        const finalText = String(p.text || "").trim();
        const source0 = envelopeByTurn.get(p.turnId) || activeEnvelope;

        // ——— First emit pre-tool segments that the final text does not contain ———
        // Containment, not equality: the final text often repeats earlier segments.
        for (const c of (candidatesByTurn.get(p.turnId) || [])) {
          if (said.has(c.text)) continue;
          if (finalText && finalText.includes(c.text)) continue;
          // Narration is fallback only: skip it when the turn has real text.
          if (c.narration && finalText) continue;
          said.add(c.text);
          fire(replyHandlers, {
            turnId: p.turnId, threadId: p.threadId, text: c.text,
            genuine: !(c.synthetic || p.synthetic === true),
            trace_id: (p.trace_id || p.traceId || (source0 && source0.trace_id) || ""),
            at: Date.now(),
          });
        }

        // Emit the final text if it has not been emitted yet.
        if (finalText && !said.has(finalText)) {
          said.add(finalText);
          const source = envelopeByTurn.get(p.turnId) || activeEnvelope;
          fire(replyHandlers, {
            turnId: p.turnId, threadId: p.threadId, text: finalText,
            genuine: p.synthetic !== true,
            trace_id: (p.trace_id || p.traceId || (source && source.trace_id) || ""),
            at: Date.now(),
          });
        }
        // silent = nothing was said this turn. That is a choice, not a failure,
        // but downstream must know so it does not wait forever.
        const source = envelopeByTurn.get(p.turnId) || activeEnvelope;
        fire(doneHandlers, {
          turnId: p.turnId, threadId: p.threadId,
          trace_id: (p.trace_id || p.traceId || (source && source.trace_id) || ""),
          silent: said.size === 0, at: Date.now(),
        });
        saidByTurn.delete(p.turnId);
        candidatesByTurn.delete(p.turnId);
        envelopeByTurn.delete(p.turnId);
        break;
      }

      case "runtime.turn.failed": {
        const said = saidByTurn.get(p.turnId) || new Set();
        // Failed turns also emit "done". failed ≠ silent: report them separately.
        const source = envelopeByTurn.get(p.turnId) || activeEnvelope;
        fire(doneHandlers, {
          turnId: p.turnId, threadId: p.threadId,
          trace_id: (p.trace_id || p.traceId || (source && source.trace_id) || ""),
          silent: false, failed: true, reason: String(p.text || "runtime.turn.failed"), at: Date.now(),
        });
        saidByTurn.delete(p.turnId);
        envelopeByTurn.delete(p.turnId);
        break;
      }
      default: break;
    }
  });

/**
 * Convert the bridge's attachment paths into the shape the runtime expects.
 *
 * The bridge passes plain path strings, while the runtime's
 * `buildMessageContent` detects images via `isImage / contentType / kind` and
 * reads bytes from `absolutePath`. Without this mapping images arrive as text
 * only. Which files to attach is still decided by the bridge
 * (normalizeModelInput); this only adds the shape.
 */
function toClaudeAttachments(paths, media) {
  if (!Array.isArray(paths) || !paths.length) return [];
  const byPath = new Map();
  for (const m of Array.isArray(media) ? media : []) {
    if (!m || typeof m !== "object") continue;
    const candidates = [m.filePath, m.path, m.localPath]
      .concat(Array.isArray(m.attach) ? m.attach : []);
    for (const c of candidates) {
      const key = String(c || "").trim();
      if (key) byPath.set(key, m);
    }
  }
  return paths.map((p) => {
    const abs = String(p || "").trim();
    const m = byPath.get(abs) || {};
    const kind = String(m.kind || "").trim().toLowerCase();
    const contentType = String(m.mime || "").trim();
    return {
      absolutePath: abs,
      kind,
      contentType,
      // Any of the three criteria marks an image (aligned with the runtime).
      isImage: contentType.toLowerCase().startsWith("image/")
        || kind === "image" || kind === "sticker",
    };
  });
}

/**
 * Wrap the text in a `<channel …>` tag carrying source, time and ids.
 *
 * The agent's sense of time and of which channel a message came from depends
 * on this. The bridge itself never puts origin into the text; the box does,
 * because claude has no per-turn system message to carry it.
 *
 * If the agent ever writes this tag itself, outbound cuts it
 * (see src/core/hallucination-cut.js); inbound wrapping is unaffected.
 */
function withOrigin(text, envelope) {
  const src = (envelope && envelope.source) || {};
  if (!src.platform) return text;
  const esc = (v) => String(v)
    .replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const attrs = ['source="' + esc(src.platform) + '"'];
  // seq: the bridge's own monotonically increasing number, issued at delivery;
  // shown alongside (not instead of) the platform's native message_id.
  if (envelope.seq != null) attrs.push('seq="' + esc(envelope.seq) + '"');
  if (src.chat_id) attrs.push('chat_id="' + esc(src.chat_id) + '"');
  if (src.native_id) attrs.push('message_id="' + esc(src.native_id) + '"');
  if (envelope.created_at) attrs.push('ts="' + esc(envelope.created_at) + '"');
  return "<channel " + attrs.join(" ") + ">\n" + text + "\n</channel>";
}

  /**
   * Has the persona been injected into this session? A new session needs it
   * again. The injected text goes to the CLI only, never to the cold log (the
   * cold log holds the owner's actual words; persona text is not one of them).
   */
  let personaInjected = false;
  /** Why we inject: first turn of the process = fresh, after rotation = rotate. */
  let personaReason = "fresh";

  return {
    /** 1. send one turn in */
    async deliver(envelope) {
      assertEnvelope(envelope);
      const input = normalizeModelInput(envelope);
      let text = withOrigin(input.text, envelope);
      if (persona && !personaInjected) {
        let pack = "";
        try {
          // The host supplies material; the persona decides how to arrange it.
          const ctx = {
            reason: personaReason,
            userText: input.text,
            ...(await personaContext({ reason: personaReason })),
          };
          pack = String((await persona.opening(ctx)) || "");
        } catch (e) {
          // Loud, but do not drop the turn: deliver the message without the persona.
          log("persona injection failed (this session has no identity): " + ((e && e.message) || e));
        }
        if (pack) {
          log("persona injected: " + (persona.name || "(unnamed)") + "  " + pack.length + " chars");
          text = pack + "\n\n" + text;
        }
        personaInjected = true;
      }
      activeEnvelope = envelope;
      try {
        const turn = await runtime.sendTurn({
          bindingKey,
          workspaceRoot,
          text,
          attachments: toClaudeAttachments(
            input.attachments, (envelope.payload && envelope.payload.media) || []),
          model,
          metadata: {
            traceId: envelope.trace_id,
            requestId: envelope.trace_id,
            seq: envelope.seq,
            kind: envelope.source.kind,
          },
        });
        if (turn && turn.turnId) envelopeByTurn.set(turn.turnId, envelope);
        return { turnId: turn && turn.turnId, threadId: turn && turn.threadId };
      } catch (error) {
        // A thrown request may have reached the runtime before the transport
        // reported the error.  Only an explicit notAccepted flag proves safe
        // rejection; all other failures are acceptance-unknown.
        if (!error || typeof error !== "object") {
          const wrapped = new Error(String(error || "runtime.sendTurn failed"));
          wrapped.acceptanceUnknown = true;
          throw wrapped;
        }
        if (error.notAccepted !== true) error.acceptanceUnknown = true;
        throw error;
      } finally {
        activeEnvelope = null;
      }
    },

    /** 2. get the agent's replies out */
    onReply(fn) { replyHandlers.push(fn); return () => replyHandlers.splice(replyHandlers.indexOf(fn), 1); },

    /** 3. the turn has finished */
    onTurnDone(fn) { doneHandlers.push(fn); return () => doneHandlers.splice(doneHandlers.indexOf(fn), 1); },

    /** 4. start a new session (continuity strategy is the box's business) */
    async rotate({ reason = "" } = {}) {
      if (typeof runtime.startFreshSharedSession !== "function") {
        throw new Error("this runtime cannot start a new session");
      }
      log("new session: " + (reason || "no reason given"));
      const r = await runtime.startFreshSharedSession({ workspaceRoot });
      // re-inject the persona on the next turn
      personaInjected = false;
      personaReason = "rotate";
      return { threadId: (r && r.threadId) || "", reason, base: (r && r.base) || null };
    },

    /** 4.4 reload the CLI (same session). Used after /undo edits the transcript. */
    async reloadCli(opts = {}) {
      if (typeof runtime.reloadCli !== "function") throw new Error("this runtime cannot reload the CLI");
      return runtime.reloadCli({ workspaceRoot, ...opts });
    },

    /** 4.5 trim tool output from the transcript (same session). */
    async trim(opts = {}) {
      if (typeof runtime.trimTranscript !== "function") throw new Error("this runtime cannot trim the transcript");
      return runtime.trimTranscript({ workspaceRoot, ...opts });
    },

    /**
     * 5. how full the context is. Measured values only:
     *   used   from usage reported by claude (context.updated)
     *   model  from the last transcript message, not the configured one
     *   limit  unknown unless GATE_BOX_CONTEXT_LIMIT is set; otherwise null and
     *          no percentage is reported (never invent a denominator)
     */
    fullness() {
      const facts = readActualFacts({ workspaceRoot, threadId: lastThreadId });
      // In-memory value first; right after a restart it is empty, so fall back to the transcript.
      const live = Number(lastContext && lastContext.currentTokens) || 0;
      const used = live > 0 ? live : (Number(facts.used) || 0);
      const configured = Number(process.env.GATE_BOX_CONTEXT_LIMIT || 0);
      const limit = configured > 0 ? configured : null;
      return {
        used,
        limit,
        ratio: limit ? used / limit : null,
        model: facts.model || "",
        threadId: lastThreadId,
      };
    },
  };
}

module.exports = { makeClaudeCodeBox };
