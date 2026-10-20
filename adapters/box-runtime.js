'use strict';

/**
 * Thin adapter: wraps the im-bridge runtime (runtime/, official Agent SDK, hosted in im-cli)
 * in the interface the box expects (same as the older `createClaudeCodeRuntimeAdapter`):
 *   initialize / onEvent / sendTurn / startFreshSharedSession / setModelForWorkspace /
 *   cancelTurn / respondApproval / describe / getTurnCapabilities / getSessionStore / close
 * Event names and fields (runtime.reply.candidate / runtime.turn.completed / ...) are unchanged.
 *
 * Only the CLI layer is replaced; the session store (src/box/session-store.js, same on-disk
 * sessions.json format) and opening-turn injection (box + persona) are reused as-is.
 *
 * Behaviours carried over from the previous client:
 *   1. images are inlined as base64 content blocks (>4.5MB skipped)      -> buildMessageContent
 *   2. narration blocks are promoted to reply candidates                  -> mapEvent
 *   3. CLI-generated messages (<synthetic> / refusal) are flagged         -> isSyntheticMessage
 *   4. tool permission requests are answered by the box                   -> canUseTool
 *   5. turn timing / first token / requested vs actual model logging
 *   6. env vars that make a child CLI think it is nested inside another CLI are filtered out
 *
 * The CLI itself lives in im-cli; the box connects over cli.sock, so restarting the box does
 * not interrupt the session. This layer only supports the remote host.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createRemoteRuntime } = require('../cli-host/client');
const { SessionStore } = require('../src/box/session-store');
const trimmer = require('../src/box/trim-transcript');

/** In box mode there is a single recipient (the gate); routing happens on the gate side by trace_id. */
const ORIGIN = { channel: 'box', threadId: 'box', recipient: 'gate' };
const SESSION_WAIT_MS = 30_000;
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;
const SYNTHETIC_MODEL = '<synthetic>';

const FILTERED_ENV = new Set(['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH', 'CLAUDE_EFFORT', 'AI_AGENT']);

const log = (m) => console.log(`[im-bridge-runtime] ${m}`);
const warn = (m) => console.warn(`[im-bridge-runtime] ${m}`);
const text = (v) => (typeof v === 'string' ? v.trim() : '');

function isSyntheticMessage(message) {
  if (!message || typeof message !== 'object') return false;
  if (message.model === SYNTHETIC_MODEL) return true;
  if (message.stop_reason === 'refusal') return true;
  return message.stop_details?.type === 'refusal';
}

/** Narration: official index first; the signature tag check is kept as a fallback. */
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

function hasClaudeImageFileRead(model) {
  const n = text(model).toLowerCase();
  if (!n) return false;
  return n === 'sonnet' || n === 'opus' || n === 'haiku'
    || /\b(?:sonnet|opus|haiku)\b/.test(n) || /^claude-(?:3|4)(?:\b|-)/.test(n);
}

function normalizeImageMediaType(contentType) {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  return ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(ct) ? ct : 'image/jpeg';
}

async function buildMessageContent(body, attachments) {
  const images = (Array.isArray(attachments) ? attachments : []).filter((item) =>
    Boolean(item?.isImage)
    || String(item?.contentType || '').toLowerCase().startsWith('image/')
    || String(item?.kind || '').toLowerCase() === 'image');
  const blocks = [];
  for (const image of images) {
    const abs = text(image?.absolutePath);
    if (!abs) continue;
    try {
      const bytes = await fsp.readFile(abs);
      if (bytes.length > MAX_IMAGE_BYTES) { warn(`image too large, skipped ${abs} (${bytes.length} bytes)`); continue; }
      blocks.push({ type: 'image', source: { type: 'base64',
        media_type: normalizeImageMediaType(image.contentType), data: bytes.toString('base64') } });
    } catch { /* unreadable: skip; the path is still in the text */ }
  }
  if (!blocks.length) return body;
  blocks.push({ type: 'text', text: body });
  return blocks;
}

function whichClaude(command) {
  if (path.isAbsolute(command)) return command;
  for (const dir of String(process.env.PATH || '').split(':')) {
    const p = path.join(dir, command);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  throw new Error(`${command} not found in PATH`);
}

/** box-build hands over CLI args; the SDK wants options. Map the three the box uses, pass the rest through. */
function parseExtraArgs(args) {
  const out = { systemPromptFile: '', fallbackModel: '', mcpConfigs: [], passthrough: {} };
  const list = Array.isArray(args) ? args : [];
  for (let i = 0; i < list.length; i += 1) {
    const flag = list[i];
    const value = list[i + 1];
    if (flag === '--system-prompt-file') { out.systemPromptFile = value; i += 1; }
    else if (flag === '--fallback-model') { out.fallbackModel = value; i += 1; }
    else if (flag === '--mcp-config') { out.mcpConfigs.push(value); i += 1; }
    else if (typeof flag === 'string' && flag.startsWith('--')) {
      const hasValue = typeof value === 'string' && !value.startsWith('--');
      out.passthrough[flag.slice(2)] = hasValue ? value : null;
      if (hasValue) i += 1;
    }
  }
  return out;
}

function readMcpServers(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers || {}; }
  catch (e) { warn(`cannot read MCP config ${file}: ${e.message}`); return {}; }
}

function createImBridgeRuntimeAdapter(config) {
  const sessionStore = new SessionStore({ filePath: config.sessionsFile, runtimeId: 'claudecode' });
  const configuredModel = text(config.claudeModel);
  const extra = parseExtraArgs(config.claudeExtraArgs);
  const fallbackModel = text(extra.fallbackModel) || text(process.env.CC_FALLBACK_MODEL);
  const claudePath = whichClaude(config.claudeCommand || 'claude');
  const ingressPath = path.join(config.stateDir, 'im-bridge-ingress.json');

  let listener = null;
  /** Current CLI. null = not started / stopped; the next sendTurn starts one. */
  let live = null;            // { rt, workspaceRoot, threadId, model, stopping }
  let launching = null;
  let seq = 0;
  /** uuid -> per-turn bookkeeping (turnId, timings, synthetic flag) */
  const turns = new Map();
  /** requestId -> resolve(decision) */
  const approvals = new Map();
  const auditKeys = new Set();

  const emit = (type, payload) => {
    if (!listener) return;
    try { listener({ type, payload }, null); }
    catch (e) { warn(`event listener failed (${type}): ${e.message}`); }
  };

  function resolveModel(model = '', workspaceRoot = '') {
    if (configuredModel) return configuredModel;
    if (text(model)) return text(model);
    for (const b of sessionStore.listBindings()) {
      const stored = text(sessionStore.getRuntimeParamsForWorkspace(b.bindingKey, workspaceRoot).model);
      if (stored) return stored;
    }
    return '';
  }

  function turnOf(bindings) {
    const b = bindings && bindings[0];
    const uuid = b && b.uuid;
    if (!uuid) return { uuid: '', turn: null };
    let turn = turns.get(uuid);
    // After a box restart the turn was sent by the previous process and is not in the table.
    // The turnId travels in origin and is persisted in im-cli's ledger; recover it from there.
    if (!turn && b.origin && text(b.origin.turnId)) {
      turn = { turnId: b.origin.turnId, writtenAt: 0, firstOutputAt: 0, firstKind: '', firstTokenAt: 0, synthetic: false, orphan: true };
      turns.set(uuid, turn);
      log(`turn sent by a previous process came back turn=${turn.turnId}; recovered from the ledger`);
    }
    return { uuid, turn: turn || null };
  }

  /** Runtime events -> box events. Must not throw: the runtime would stop the CLI. */
  async function onRuntimeEvent(payload) {
    // The replay-gap marker ({__incomplete}, sent by the client when the gap was evicted) is not
    // a normal event. Treating it as one would crash on event.raw, leave the turn `unknown` and
    // block the queue. Log it and return; unfinished turns are settled by watch().
    if (payload && payload.__incomplete) {
      warn(`replay incomplete lastSeq=${payload.lastSeq}->${payload.serverLastSeq}; unfinished turns are left to watch`);
      return;
    }
    const { event, bindings } = payload || {};
    try {
      const raw = (event && event.raw) || {};
      const { uuid, turn } = turnOf(bindings);
      const turnId = turn ? turn.turnId : '';
      const threadId = (live && live.threadId) || raw.session_id || '';
      if (event.isSubagent) return;               // subagent output is not the agent's reply

      if (raw.type === 'stream_event') {
        if (turn && !turn.firstTokenAt && raw.event?.type === 'content_block_delta') {
          turn.firstTokenAt = Date.now();
          console.log(`[agent] first token turnId=${turnId} write→token=${turn.firstTokenAt - turn.writtenAt}ms `
            + `kind=${raw.event?.delta?.type || '?'}`);
        }
        // Pass reply text through as it is written. The box uses it only for
        // turns that came from the phone leg (src/host/phone-stream.js).
        const ev = raw.event || {};
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          emit('runtime.reply.delta', { threadId, turnId, text: ev.delta.text });
        } else if (ev.type === 'content_block_stop') {
          emit('runtime.reply.delta', { threadId, turnId, end: true });
        }
        return;
      }

      if (raw.type === 'assistant') {
        const message = raw.message || {};
        const synthetic = event.cliGenerated || isSyntheticMessage(message);
        if (synthetic && turn) turn.synthetic = true;
        // One assistant frame becomes several events; handle usage / model only on the first block.
        if (!event.blockIndex) {
          if (message.model) auditModel(message.model, turnId, threadId);
          if (message.usage && typeof message.usage === 'object') {
            const u = message.usage;
            const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
            const payload = { runtimeId: 'claudecode', threadId, model: text(message.model),
              inputTokens: n(u.input_tokens), cacheCreationInputTokens: n(u.cache_creation_input_tokens),
              cacheReadInputTokens: n(u.cache_read_input_tokens), outputTokens: n(u.output_tokens) };
            payload.currentTokens = payload.inputTokens + payload.cacheCreationInputTokens
              + payload.cacheReadInputTokens + payload.outputTokens;
            emit('runtime.context.updated', payload);
          }
        }
        const kind = event.kind;
        if (turn && !turn.firstOutputAt && (kind === 'text' || kind === 'thinking' || kind === 'narration'
          || event.block?.type === 'tool_use')) {
          turn.firstOutputAt = Date.now();
          turn.firstKind = event.block?.type || kind;
        }
        const narration = isNarration(event);
        const body = kind === 'text' ? text(event.text)
          : narration ? text(event.text || event.block?.thinking) : '';
        if (!body) return;
        if (narration) {
          log(`narration block promoted to text turn=${turnId} chars=${body.length} preview=${JSON.stringify(body.slice(0, 60))}`);
        }
        if (!turn) log(`agent spoke with no turn running (${body.length} chars); passing to the box with an empty turnId`);
        emit('runtime.reply.candidate', { threadId, turnId, text: body, narration, synthetic });
        return;
      }

      if (event.kind === 'result') {
        if (turn && turn.writtenAt) {
          const now = Date.now();
          const toFirst = turn.firstOutputAt ? turn.firstOutputAt - turn.writtenAt : -1;
          const gen = turn.firstOutputAt ? now - turn.firstOutputAt : -1;
          const queued = live ? live.rt.list('pending').length : 0;
          console.log(`[agent] turn timing turnId=${turnId} write→first=${toFirst}ms first→result=${gen}ms `
            + `total=${now - turn.writtenAt}ms firstKind=${turn.firstKind || 'none'} queuedBehind=${queued}`);
        }
        if (raw.is_error === true || raw.subtype !== 'success') {
          warn(`CLI reported failure turn=${turnId} subtype=${raw.subtype} ${JSON.stringify(raw.errors || raw.result || '').slice(0, 200)}`);
        }
        // Execution interrupted (cancelled / aborted): report as failed.
        if (raw.subtype !== 'success') {
          emit('runtime.turn.failed', { threadId, turnId,
            text: `CLI interrupted (${raw.subtype})` + (Array.isArray(raw.errors) ? '：' + raw.errors.join('；') : '') });
          if (uuid) turns.delete(uuid);
          return;
        }
        // Normal end (including is_error API errors) -> completed: the error text still reaches the owner, flagged as synthetic.
        emit('runtime.turn.completed', {
          threadId, turnId, coldLayerExempt: false,
          synthetic: Boolean(turn && turn.synthetic) || raw.is_error === true,
          text: typeof raw.result === 'string' ? raw.result.trim() : '',
        });
        if (uuid) turns.delete(uuid);
      }
    } catch (e) {
      warn(`event translation failed (CLI unaffected): ${e.message}`);
    }
  }

  function auditModel(actual, turnId, threadId) {
    const key = `${threadId}\0${turnId}\0${actual}`;
    if (auditKeys.has(key)) return;
    auditKeys.add(key);
    if (auditKeys.size > 500) auditKeys.clear();
    const requested = (live && live.model) || configuredModel || '';
    console.log(`[claudecode-runtime] model requested_model=${requested || '(default)'} actual_model=${actual} `
      + `fallback=${Boolean(requested && actual && requested !== actual)}`);
  }

  async function canUseTool(toolName, input, options = {}) {
    const requestId = options.toolUseID || randomUUID();
    if (!listener) return { behavior: 'allow', updatedInput: input };
    const decision = await new Promise((resolve) => {
      approvals.set(requestId, resolve);
      options.signal?.addEventListener?.('abort', () => { approvals.delete(requestId); resolve('decline'); });
      emit('runtime.approval.requested', {
        requestId, toolName, input,
        commandTokens: toolName === 'Bash' && typeof input?.command === 'string' ? [input.command] : undefined,
        threadId: live ? live.threadId : '',
      });
    });
    return decision === 'accept'
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: "The user denied this tool use. Stop and wait for the user's instructions." };
  }

  /** The CLI went away by itself: fail the running turn and start again on the next turn. */
  function watch(entry) {
    entry.rt.done.then(
      () => { if (!entry.stopping) warn('CLI exited by itself'); },
      (e) => { if (!entry.stopping) warn(`CLI interrupted: ${e.message}`); },
    ).finally(() => {
      if (live === entry) live = null;
      if (entry.stopping) return;
      for (const [uuid, turn] of turns) {
        const row = entry.rt.get(uuid);
        if (row && row.state === 'uncertain') {
          emit('runtime.turn.failed', { threadId: entry.threadId, turnId: turn.turnId, text: row.error || 'CLI interrupted' });
          turns.delete(uuid);
        }
      }
      try { entry.rt.close().catch(() => {}); } catch { /* already closed */ }
      // Still queued rows: restart right away instead of waiting for the next inbound message.
      let pending = 0;
      try { pending = entry.rt.list('pending').length; } catch { /* already closed */ }
      if (pending && entry.threadId) {
        warn(`${pending} rows still queued, restarting in 3s`);
        setTimeout(() => {
          if (!live && !launching) ensureRuntime(entry.workspaceRoot, entry.threadId, entry.model)
            .catch((e) => warn(`restart failed: ${e.message}`));
        }, 3000).unref?.();
      }
    });
  }

  async function stopLive({ reason = '' } = {}) {
    const entry = live;
    if (!entry) return;
    entry.stopping = true;
    live = null;
    log(`stopping CLI: ${reason}`);
    try { await entry.rt.close(); } catch (e) { warn(`error while stopping (stopped anyway): ${e.message}`); }
  }

  /**
   * The connection to im-cli. Exactly one per process: it handles backoff reconnect and replay,
   * and a new connection per CLI would corrupt the event cursor (= duplicate delivery).
   */
  let remoteRuntime = null;
  function remote() {
    if (remoteRuntime) return remoteRuntime;
    remoteRuntime = createRemoteRuntime({
      // The socket lives in GATE_ROOT like box.sock / tools.sock, NOT in config.stateDir
      // (GATE_ROOT/state, where the ledger is). Both sides must agree.
      socketPath: process.env.AGENT_CLI_SOCKET
        || path.join(process.env.GATE_ROOT || config.stateDir, 'cli.sock'),
      ingressPath,
      cursorPath: path.join(config.stateDir, 'cli-cursor.json'),
      onEvent: onRuntimeEvent,
      callbacks: {
        canUseTool,
        stderr: (t) => { if (t) console.error(`[claudecode-runtime] stderr: ${t}`); },
      },
    });
    // Flush the cursor on normal exit so nothing is replayed next time.
    const flush = () => { try { remoteRuntime.flushCursor(); } catch {} };
    process.once('SIGTERM', flush);
    process.once('SIGINT', flush);
    process.once('exit', flush);
    return remoteRuntime;
  }

  async function ensureRuntime(workspaceRoot, threadId, model) {
    if (launching) await launching.catch(() => {});
    if (live && live.workspaceRoot === workspaceRoot
      && (!threadId || !live.threadId || live.threadId === threadId)
      && (!model || live.model === model)) return live;
    await stopLive({ reason: 'session/model changed' });
    launching = (async () => {
      // Ledger pruning belongs to im-cli (single owner); the box only reads it.
      // The workspace .mcp.json is read by the CLI itself; this layer never writes it.
      let mcpServers = {};
      for (const f of extra.mcpConfigs) mcpServers = { ...mcpServers, ...readMcpServers(f) };
      const env = {};
      for (const [k, v] of Object.entries(process.env)) if (!FILTERED_ENV.has(k)) env[k] = v;
      const sdkOptions = {
        env,
        mcpServers,
        permissionMode: config.claudePermissionMode || 'default',
        canUseTool,
        includePartialMessages: String(process.env.GATE_CLAUDE_PARTIAL || '').toLowerCase() === 'on',
        stderr: (chunk) => { const t = String(chunk).trim(); if (t) console.error(`[claudecode-runtime] stderr: ${t}`); },
        ...(model ? { model } : {}),
        ...(fallbackModel && fallbackModel !== model ? { fallbackModel } : {}),
        ...(threadId ? { resume: threadId } : {}),
        // Must be explicit: without it the SDK sends an empty system prompt on init.
        ...(extra.systemPromptFile ? { systemPrompt: fs.readFileSync(extra.systemPromptFile, 'utf8') } : {}),
        ...(Object.keys(extra.passthrough).length ? { extraArgs: extra.passthrough } : {}),
      };
      log(`launching cli=${claudePath} cwd=${workspaceRoot} resume=${threadId || '(new session)'} model=${model || '(default)'} `
        + `mcp=${Object.keys(mcpServers).join(',')}`);
      // Functions cannot cross the socket: canUseTool / stderr stay here and im-cli calls back.
      const { canUseTool: _c, stderr: _s, ...wire } = sdkOptions;
      const rt = remote();
      await rt.ensure({ workspaceRoot, threadId: threadId || '', model, claudePath, ingressPath,
        sdkOptions: wire });
      const entry = { rt, workspaceRoot, threadId: threadId || '', model, stopping: false };
      live = entry;
      // watch() must come after start(): before start, rt.done is an already-resolved promise
      // and would immediately be read as "CLI exited".
      await rt.start();
      watch(entry);
      return entry;
    })();
    try { return await launching; } finally { launching = null; }
  }

  async function waitForSessionId(entry) {
    const deadline = Date.now() + SESSION_WAIT_MS;
    while (Date.now() < deadline) {
      const sid = entry.rt.status().sessionId;
      if (sid) return sid;
      if (live !== entry) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    return '';
  }

  const api = {
    describe() {
      // When not pinned (GATE_MODEL empty), report the model stored in sessions.json - that is
      // what /model writes.
      let model = configuredModel;
      if (!model) {
        for (const b of sessionStore.listBindings()) {
          const ws = (live && live.workspaceRoot) || text(b.activeWorkspaceRoot);
          model = text(sessionStore.getRuntimeParamsForWorkspace(b.bindingKey, ws).model);
          if (model) break;
        }
      }
      return { id: 'claudecode', kind: 'runtime', command: claudePath, sessionsFile: config.sessionsFile,
        model, engine: 'im-bridge' };
    },
    onEvent(fn) {
      if (typeof fn !== 'function') return () => {};
      listener = fn;
      return () => { if (listener === fn) listener = null; };
    },
    getSessionStore() { return sessionStore; },
    getTurnCapabilities({ model = '' } = {}) {
      return { nativeImageInput: false, toolImageRead: hasClaudeImageFileRead(resolveModel(model)) };
    },
    async initialize() {
      fs.mkdirSync(config.stateDir, { recursive: true });
      // Connect to im-cli immediately rather than on the next sendTurn. If the box restarted
      // mid-turn, the result sits in im-cli's buffer while the gate waits for that turn to end
      // before sending more - a deadlock. Connecting now replays the buffered events.
      remote();
      return { command: claudePath, models: [] };
    },

    async sendTurn({ bindingKey, workspaceRoot, text: body, attachments = [], metadata = {}, model = '' }) {
      const desiredModel = resolveModel(model, workspaceRoot);
      let threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
      if (desiredModel) {
        sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, { model: desiredModel, modelProvider: '' });
      }
      const entry = await ensureRuntime(workspaceRoot, threadId, desiredModel);

      const content = await buildMessageContent(body, attachments);
      const uuid = randomUUID();
      const turnId = `turn-${Date.now()}-${seq += 1}`;
      const turn = { turnId, writtenAt: Date.now(), firstOutputAt: 0, firstKind: '', firstTokenAt: 0, synthetic: false };
      turns.set(uuid, turn);
      try {
        // Any error thrown before enqueue persisted means "definitely not delivered": flag it
        // notAccepted so the gate retries instead of recording `unknown` and stalling the queue.
        // (This includes list() throwing because the CLI just died.)
        const queued = entry.rt.list('pending').length + entry.rt.list('started').length;
        if (queued) console.log(`[agent] turn queued turnId=${turnId} waitingBehind=${queued}`);
        // Must await: this is a cross-process call; without it the catch below never fires and
        // the message would be silently lost. turnId travels in origin so replayed events can be
        // matched back to the turn after a box restart (see turnOf).
        await entry.rt.enqueue({ uuid, origin: { ...ORIGIN, turnId },
          message: { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, origin: { kind: 'human' } } });
      } catch (e) {
        turns.delete(uuid);
        e.notAccepted = true;       // not persisted = definitely not delivered; safe to retry
        throw e;
      }

      const sid = threadId || await waitForSessionId(entry);
      if (!sid) throw new Error('claudecode did not report a session id');
      if (!entry.threadId) entry.threadId = sid;
      sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, sid, metadata);
      emit('runtime.turn.started', { threadId: sid, turnId, telegramInbound: null, channelInbound: null });
      return { threadId: sid, turnId };
    },

    async startFreshSharedSession({ workspaceRoot }) {
      const ws = text(workspaceRoot);
      await stopLive({ reason: 'new session' });
      turns.clear();
      let clearedBindings = 0;
      for (const b of sessionStore.listBindings()) {
        if (!sessionStore.getThreadIdForWorkspace(b.bindingKey, ws)) continue;
        sessionStore.clearThreadIdForWorkspace(b.bindingKey, ws);
        clearedBindings += 1;
      }
      return { workspaceRoot: ws, clearedBindings, base: null };
    },

    /**
     * Trim tool-call payloads from the transcript. The decision is the gate's (watchdog on
     * context usage); this only does: find threadId -> dry-run estimate -> stop CLI -> apply.
     * The binding is kept, so the next ensureRuntime resumes the same threadId from the trimmed file.
     * If the dry run fails, trim anyway (unknown gain is not zero gain).
     */
    async trimTranscript({ workspaceRoot, currentTokens = 0, minGain = 80_000, keepRecent = 10 } = {}) {
      const ws = text(workspaceRoot);
      let threadId = '';
      for (const b of sessionStore.listBindings()) {
        const t = sessionStore.getThreadIdForWorkspace(b.bindingKey, ws);
        if (t) { threadId = t; break; }
      }
      if (!threadId) return { trimmed: false, reason: 'no active session for this workspace' };
      if (turns.size > 0) return { trimmed: false, busy: true, reason: 'agent is mid-turn', threadId };
      const file = trimmer.transcriptPath(ws, threadId);
      const est = trimmer.estimateTrimGain({ file, currentTokens, keepRecent });
      if (est.ok) log(`[trim] dry run: ~${(est.ratio * 100).toFixed(1)}% ≈ ${Math.round(est.gain / 1000)}k (context ${Math.round(currentTokens / 1000)}k)`);
      else warn(`[trim] dry run failed, trimming anyway: ${est.reason}`);
      if (est.ok && est.gain < minGain) {
        return { trimmed: false, gain: est.gain, ratio: est.ratio, minGain, threadId, reason: `dry run saves only ${Math.round(est.gain / 1000)}k < ${Math.round(minGain / 1000)}k` };
      }
      if (turns.size > 0) return { trimmed: false, busy: true, reason: 'agent is mid-turn', threadId };
      await stopLive({ reason: 'trim transcript' });
      const r = trimmer.applyTrim({ file, keepRecent });
      if (r.ok) log(`[trim] ${(r.before / 1048576).toFixed(1)}MB -> ${(r.after / 1048576).toFixed(1)}MB, backup ${path.basename(r.backup)}; session kept thread=${threadId.slice(0, 8)}`);
      else warn(`[trim] failed, original file kept: ${r.reason}`);
      return { trimmed: r.ok, gain: est.ok ? est.gain : null, ratio: est.ok ? est.ratio : null, minGain, threadId,
        before: r.before, after: r.after, backup: r.backup, reason: r.ok ? '' : r.reason };
    },

    /**
     * Reload the CLI after /undo edited the transcript. The live CLI still remembers the deleted
     * line as its leaf and would chain new lines onto it (broken parentUuid chain). Stopping it
     * makes the next ensureRuntime resume the same threadId and re-read the leaf from disk.
     * No binding change, no new session, no trim. Returns busy while a turn is running.
     */
    async reloadCli({ workspaceRoot } = {}) {
      const ws = text(workspaceRoot);
      if (turns.size > 0) return { reloaded: false, busy: true, reason: 'agent is mid-turn' };
      if (!live || (ws && live.workspaceRoot !== ws)) return { reloaded: false, reason: 'no live CLI; the next turn re-reads from disk anyway' };
      await stopLive({ reason: 'reload leaf after undo' });
      return { reloaded: true };
    },

    async setModelForWorkspace({ workspaceRoot, model }) {
      const ws = text(workspaceRoot);
      const m = text(model);
      if (!ws || !m) throw new Error('workspaceRoot and model are both required');
      if (configuredModel) {
        throw new Error(`model is pinned to ${configuredModel} by config (GATE_MODEL); change the config first`);
      }
      for (const b of sessionStore.listBindings()) sessionStore.setRuntimeParamsForWorkspace(b.bindingKey, ws, { model: m });
      if (!live || live.workspaceRoot !== ws) return { model: m, applied: 'next-launch' };
      await live.rt.setModel(m);
      live.model = m;
      log(`set_model workspace=${ws} model=${m}`);
      return { model: m, applied: 'live' };
    },

    /** Cancelling stops the CLI. The running turn stays `uncertain` (possibly submitted, never auto-replayed). */
    async cancelTurn({ threadId, turnId, workspaceRoot }) {
      const entry = live;
      if (!entry || (workspaceRoot && entry.workspaceRoot !== text(workspaceRoot))) return { threadId, turnId };
      await stopLive({ reason: `cancel current turn ${turnId || ''}` });
      for (const [uuid, turn] of turns) {
        const row = entry.rt.get(uuid);
        if (row && row.state !== 'completed') {
          emit('runtime.turn.failed', { threadId: entry.threadId, turnId: turn.turnId, text: 'turn cancelled' });
        }
        turns.delete(uuid);
      }
      return { threadId, turnId };
    },

    async respondApproval({ requestId, decision }) {
      const resolve = approvals.get(requestId);
      if (!resolve) throw new Error('no active claudecode session to respond to approval');
      approvals.delete(requestId);
      resolve(decision === 'accept' ? 'accept' : 'decline');
      return { requestId, decision: decision === 'accept' ? 'accept' : 'decline' };
    },

    async close() { await stopLive({ reason: 'close' }); },
  };
  return api;
}

module.exports = { createImBridgeRuntimeAdapter, parseExtraArgs, isSyntheticMessage, isNarration };
