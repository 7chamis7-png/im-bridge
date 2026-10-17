'use strict';

/**
 * Codex runtime adapter for im-bridge, backed by a persistent app-server.
 *
 * The app-server owns tool execution and streaming. This layer owns the reliable
 * ingress ledger, converts bridge messages into Codex input items, and persists
 * the thread id so restarts resume the same conversation.
 *
 * Safety guard: this adapter only accepts a ChatGPT-subscription Codex login.
 * API-key authentication is rejected to prevent accidental usage billing.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { createIngress } = require('../runtime/ingress');
const { decode } = require('../runtime/decode');
const { createCodexAppServer, stripContextSuffix } = require('./codex-appserver');

const SCHEMA = 'im-bridge.codex-thread.v1';

function nonempty(v) { return typeof v === 'string' && v.trim().length > 0; }

function validColdTurn(row) {
  return row && (row.role === 'user' || row.role === 'assistant')
    && typeof row.text === 'string' && row.text.trim();
}

/** Read a bounded tail of the cold JSONL log for a brand-new thread only. */
function coldSeed(file, { maxMessages = 16, maxChars = 6000, maxBytes = 160 * 1024 } = {}) {
  if (!file) return [];
  let fd;
  try { fd = fs.openSync(file, 'r'); }
  catch { return []; }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    const rows = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (validColdTurn(row)) rows.push({ role: row.role, content: row.text.trim() });
      } catch { /* Ignore a partial first line or malformed record. */ }
    }
    const kept = [];
    let chars = 0;
    for (let i = rows.length - 1; i >= 0 && kept.length < maxMessages; i -= 1) {
      const row = rows[i];
      if (chars + row.content.length > maxChars && kept.length) break;
      kept.push(row);
      chars += row.content.length;
    }
    return kept.reverse();
  } finally {
    fs.closeSync(fd);
  }
}

const IMAGE_EXTENSIONS = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
]);
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

function cacheBase64Image(source, imageDir) {
  const mime = String(source?.media_type || '').toLowerCase();
  const ext = IMAGE_EXTENSIONS.get(mime);
  if (!ext || !nonempty(source?.data)) return '';
  const bytes = Buffer.from(source.data, 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return '';

  const digest = createHash('sha256').update(bytes).digest('hex');
  const file = path.join(imageDir, `${digest}.${ext}`);
  fs.mkdirSync(imageDir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(file)) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, bytes, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  return file;
}

function extractTurnInput(message, imageDir) {
  const content = message?.message?.content;
  if (typeof content === 'string') {
    const text = content.trim();
    return text ? [{ type: 'text', text }] : [];
  }
  if (!Array.isArray(content)) return [];
  const input = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && nonempty(block.text)) {
      input.push({ type: 'text', text: block.text.trim() });
      continue;
    }
    if (block.type !== 'image') continue;
    const source = block.source || {};
    if (source.type === 'path' && nonempty(source.path) && fs.existsSync(source.path)) {
      input.push({ type: 'localImage', path: source.path });
      continue;
    }
    if (source.type === 'base64') {
      const file = cacheBase64Image(source, imageDir);
      if (file) input.push({ type: 'localImage', path: file });
    }
  }
  return input;
}

/** Map Codex token usage to the bridge's existing usage shape. */
function mapUsage(total) {
  if (!total || typeof total !== 'object') return undefined;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    input_tokens: n(total.inputTokens),
    output_tokens: n(total.outputTokens),
    cache_creation_input_tokens: n(total.cacheWriteInputTokens),
    cache_read_input_tokens: n(total.cachedInputTokens),
  };
}

/** Require a ChatGPT subscription login instead of API-key billing. */
function assertSubscription(authFile) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(authFile, 'utf8')); }
  catch (error) {
    throw new Error(`Cannot read Codex authentication (${authFile}): ${error.message}`);
  }
  const mode = String(raw.auth_mode || '').toLowerCase();
  const hasApiKey = nonempty(raw.OPENAI_API_KEY);
  if (mode === 'chatgpt') return;
  if (mode === 'apikey' || hasApiKey) {
    throw new Error('Codex is authenticated with an API key. This runtime only permits ChatGPT subscription auth.');
  }
  throw new Error(`Unsupported Codex auth_mode "${raw.auth_mode}"; expected "chatgpt".`);
}

function refuse(message) {
  const error = new Error(message);
  error.notAccepted = true;
  return error;
}

function createCodexRuntime({
  ingressPath,
  cwd = '',
  scope = 'box',
  onEvent = async () => {},
  sdkOptions = {},
  env = process.env,
  threadFile,
  authFile = path.join(os.homedir(), '.codex', 'auth.json'),
  codexPath = 'codex',
  home = os.homedir(),
} = {}) {
  if (!ingressPath) throw new Error('Codex runtime requires ingressPath.');
  if (!cwd) throw new Error('Codex runtime requires cwd.');

  assertSubscription(authFile);

  const ingress = createIngress({ filePath: ingressPath });
  const storeFile = threadFile || path.join(path.dirname(ingressPath), 'codex-thread.json');
  const imageDir = path.join(path.dirname(ingressPath), 'codex-images');
  // Ignore Claude model names that may arrive from a shared /model command.
  // CODEX_MODEL is the explicit override for this runtime.
  const wanted = stripContextSuffix(sdkOptions.model || '');
  const fallbackModel = stripContextSuffix(env.CODEX_MODEL || env.GATE_MODEL || '');
  const model = /^(gpt-|o\d)/i.test(wanted) ? wanted : fallbackModel;
  if (wanted && wanted !== model) console.error(`[im-cli/codex] ignored non-Codex model "${wanted}"; using ${model || 'account default'}`);

  // Prefer MCP servers passed by the box; otherwise read the gate's generated config.
  let mcpServers = (sdkOptions.mcpServers && typeof sdkOptions.mcpServers === 'object') ? sdkOptions.mcpServers : null;
  if (!mcpServers) {
    const mcpFile = env.GATE_MCP_FILE || (env.GATE_ROOT ? path.join(env.GATE_ROOT, 'mcp-im-bridge.json') : '');
    if (mcpFile) {
      try {
        const parsed = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
        if (parsed && parsed.mcpServers && typeof parsed.mcpServers === 'object') mcpServers = parsed.mcpServers;
      } catch { /* Optional configuration. */ }
    }
  }

  const driver = createCodexAppServer({
    codexPath, cwd, model, home, env,
    developerInstructions: nonempty(sdkOptions.systemPrompt) ? sdkOptions.systemPrompt.trim() : '',
    mcpServers,
    approvalPolicy: env.CODEX_APPROVAL_POLICY || 'never',
    startTimeoutMs: Number(env.CODEX_START_TIMEOUT_MS || 60_000),
    turnTimeoutMs: Number(env.CODEX_TURN_TIMEOUT_MS || 300_000),
    log: (m) => console.log(m),
  });

  // Seed only a brand-new thread from the cold log. A resumed thread already has history.
  const coldPath = env.GATE_COLD_FILE || (env.GATE_ROOT ? path.join(env.GATE_ROOT, 'cold.jsonl') : '');
  let freshThread = true;   // start() 里续上旧 thread 会置 false
  let seeded = false;

  let running = false;
  let stopping = false;
  let initialized = false;
  let disposed = false;
  let threadId = '';
  let actualModel = model;
  const owned = new Set();

  let pumping = false;
  let pumpAgain = false;
  let pumpPromise = null;
  let settled = false;
  let doneResolve;
  let doneReject;
  const done = new Promise((resolve, reject) => { doneResolve = resolve; doneReject = reject; });
  done.catch(() => {});

  function failProcess(error) {
    if (settled) return;
    settled = true;
    doneReject(error instanceof Error ? error : new Error(String(error)));
  }

  function loadThread() {
    try {
      const raw = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
      if (raw && raw.schema === SCHEMA && nonempty(raw.threadId)) threadId = raw.threadId.trim();
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('[im-cli/codex] cannot read saved thread id; starting new:', error.message);
    }
  }

  function saveThread() {
    const tmp = `${storeFile}.tmp`;
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ schema: SCHEMA, threadId }) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, storeFile);
  }

  async function emitDecoded(frame, binding) {
    const bindings = [binding];
    for (const event of decode(frame)) await onEvent({ event, bindings });
  }

  async function runTurn(row) {
    const uuid = row.uuid;
    const origin = row.payload?.origin || {};
    const binding = { uuid, origin };
    const turnInput = extractTurnInput(row.payload?.message, imageDir);
    try {
      if (!turnInput.length) throw new Error('Turn has no supported text or image input.');
      let toSend = turnInput;
      if (freshThread && !seeded) {
        seeded = true;
        const seedRows = coldPath ? coldSeed(coldPath) : [];
        if (seedRows.length) {
          const tail = seedRows.map((r) => `${r.role === 'user' ? 'User' : 'Assistant'}: ${r.content}`).join('\n');
          toSend = [
            { type: 'text', text: `[Recent delivered conversation for continuity; this is context, not the current user message]\n${tail}\n\n[Current user message]` },
            ...turnInput,
          ];
          console.log(`[im-cli/codex] seeded new thread with ${seedRows.length} cold-log messages`);
        }
      }
      const { text, usage } = await driver.runTurn(toSend);
      // Persist the app-server's authoritative thread id.
      if (driver.threadId && driver.threadId !== threadId) { threadId = driver.threadId; try { saveThread(); } catch {} }
      let reply = String(text || '').trim();
      if (/^NO_REPLY[。.!！\s]*$/i.test(reply)) { console.log('[im-cli/codex] model chose NO_REPLY'); reply = ''; }
      if (reply) {
        await emitDecoded({
          type: 'assistant',
          user_message_uuid: uuid,
          session_id: threadId,
          message: {
            id: `cxmsg-${uuid}`,
            model: actualModel,
            role: 'assistant',
            content: [{ type: 'text', text: reply }],
            ...(mapUsage(usage) ? { usage: mapUsage(usage) } : {}),
          },
        }, binding);
      }
      await emitDecoded({
        type: 'result', subtype: 'success', is_error: false, result: reply,
        session_id: threadId, user_message_uuid: uuid,
      }, binding);
      ingress.complete(uuid, { failed: false });
    } catch (error) {
      const reason = error?.message || String(error);
      console.error('[im-cli/codex] turn failed:', reason);
      try {
        await emitDecoded({
          type: 'result', subtype: 'error_during_execution', is_error: true,
          errors: [reason], result: '', session_id: threadId, user_message_uuid: uuid,
        }, binding);
      } catch (cbErr) { console.error('[im-cli/codex] could not emit failure event:', cbErr.message); }
      try { ingress.complete(uuid, { failed: true, reason }); }
      catch (completeError) { failProcess(completeError); }
    }
  }

  function findOwnedPending() {
    return ingress.list('pending', scope).find((row) => owned.has(row.uuid) || row.payload?.brain === 'codex');
  }

  function pump() {
    if (pumping) { pumpAgain = true; return pumpPromise; }
    pumping = true;
    pumpPromise = (async () => {
      try {
        do {
          pumpAgain = false;
          while (running && !stopping) {
            const row = findOwnedPending();
            if (!row) break;
            owned.add(row.uuid);
            if (!ingress.begin(row.uuid)) break;
            await ingress.submit(row.uuid, async () => {});
            await runTurn(row);
          }
        } while (pumpAgain && running && !stopping);
      } finally {
        pumping = false;
        pumpPromise = null;
      }
    })();
    return pumpPromise;
  }

  async function start() {
    if (disposed || stopping) return Promise.reject(new Error('Codex runtime is stopped.'));
    if (running) return;
    loadThread();
    await driver.ensure();
    if (threadId) {
      const resumed = await driver.resumeThread(threadId);
      if (resumed) { freshThread = false; seeded = true; }
    }
    if (driver.threadId) threadId = driver.threadId;
    running = true;
    initialized = true;
    for (const row of ingress.list('pending', scope)) {
      if (row.payload?.brain === 'codex') owned.add(row.uuid);
    }
    try { saveThread(); } catch (error) { console.error('[im-cli/codex] could not persist thread id:', error.message); }
    console.log(`[im-cli/codex] ready model=${model || 'account default'} thread=${threadId.slice(0, 13)}`);
    void pump();
  }

  function enqueue({ message, origin, uuid } = {}) {
    if (disposed) throw refuse('Codex runtime is closed.');
    if (!running || stopping) throw refuse('Codex runtime is not running; call ensure first.');
    if (message?.type !== 'user' || message.message?.role !== 'user' || message.message?.content == null) {
      throw refuse('Expected a user message that can trigger a reply.');
    }
    const turnInput = extractTurnInput(message, imageDir);
    if (!turnInput.length) throw refuse('Turn has no supported text or image input.');
    const id = nonempty(uuid) ? uuid : randomUUID();
    let row;
    try {
      row = ingress.accept({ uuid: id, scope, payload: { uuid: id, origin: origin || {}, message, brain: 'codex' } });
    } catch (error) { error.notAccepted = true; throw error; }
    owned.add(id);
    void pump();
    return row;
  }

  async function stop() {
    if (stopping) { if (pumpPromise) await pumpPromise.catch(() => {}); return; }
    stopping = true;
    try { await driver.interrupt(); } catch { /* No active turn. */ }
    if (pumpPromise) await pumpPromise.catch(() => {});
    running = false;
    if (!settled) { settled = true; doneResolve(); }
  }

  async function close() {
    try { await stop(); }
    finally {
      disposed = true;
      try { await driver.close(); } catch { /* Already stopped. */ }
      try { ingress.close(); } catch { /* Already closed. */ }
    }
  }

  return {
    enqueue, start, stop, close,
    get done() { return done; },
    get: (uuid) => ingress.get(uuid),
    list: (state) => ingress.list(state),
    status: () => ({ running, stopping, initialized, requestedModel: model, actualModel, sessionId: threadId }),
    async setModel() { /* CODEX_MODEL controls this runtime independently. */ },
  };
}

module.exports = { createCodexRuntime, extractTurnInput, mapUsage, assertSubscription, coldSeed };
