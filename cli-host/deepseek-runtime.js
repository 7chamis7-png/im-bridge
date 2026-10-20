'use strict';

/**
 * DeepSeek runtime adapter for im-bridge.
 *
 * Same face as the Claude runtime, but it never spawns the `claude` CLI: each
 * turn is a call to DeepSeek's OpenAI-compatible chat-completions endpoint.
 * Frames are still shaped for runtime/decode.js (assistant text + a
 * `result` with subtype=success), so the box and gate see nothing new.
 *
 * It does not go through runtime/index.js on purpose: that runtime kills the
 * CLI when `apiKeySource !== 'none'` to prevent accidental API billing for
 * Claude. This adapter *is* an API client, so that guard does not apply.
 *
 * Its conversation is kept separate from Claude's: history lives in
 * `deepseek-thread.json`, not in `sessions.json`, and Claude's transcript is
 * never read. Switching back to Claude finds the old session untouched.
 *
 * Tools: the MCP servers the box hands over, plus local Read / Edit / Write /
 * Bash. Tools that are not available are not pretended.
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createIngress } = require('../runtime/ingress');
const { decode } = require('../runtime/decode');
const { createToolBelt } = require('./deepseek-tools');

const SCHEMA = 'im-bridge.deepseek-thread.v1';
const MAX_TOOL_ROUNDS = 12;
const MAX_HISTORY = 40;
const MAX_SYSTEM_CHARS = 48_000;
const PLUG_NOTE = [
  'Tools are connected. Call them when you need them; never claim you did something you did not. If a tool is not listed, say it is not available.',
  'Plain reply text is delivered to the owner. Use `reply` only when a specific channel is requested.',
].join('\n');

function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function firstNonEmpty(...values) {
  for (const value of values) if (nonempty(value)) return value.trim();
  return '';
}

/** A suffix like `[1m]` in a configured model name is a context size, not part of the name. */
function stripContextSuffix(model) {
  return String(model || '').trim().replace(/\[[^\]]+\]$/, '');
}

/**
 * Key and endpoint come from the environment only; never written to disk or logs.
 * An Anthropic-compatible base URL (`.../anthropic`) is mapped back to the
 * chat-completions root.
 */
function resolveDeepseekConfig(env = process.env) {
  const base = firstNonEmpty(env.DEEPSEEK_BASE_URL, 'https://api.deepseek.com')
    .replace(/\/+$/, '').replace(/\/anthropic$/, '');
  const key = firstNonEmpty(env.DEEPSEEK_API_KEY);
  const model = stripContextSuffix(firstNonEmpty(env.DEEPSEEK_MODEL, 'deepseek-chat'));
  const timeoutMs = Number(env.DEEPSEEK_TIMEOUT_MS || 90_000);
  return {
    url: /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`,
    key,
    model,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 90_000,
  };
}

function refuse(message) {
  const error = new Error(message);
  error.notAccepted = true;
  return error;
}

function extractText(message) {
  const content = message?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  let images = 0;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') images += 1;
  }
  if (images && parts.length === 0) return '(The owner sent an image. This runtime cannot see images.)';
  if (images) parts.push(`(${images} more image(s) attached; this runtime cannot see images.)`);
  return parts.join('\n').trim();
}

function validTurn(row) {
  return row && (row.role === 'user' || row.role === 'assistant') && typeof row.content === 'string' && row.content.trim();
}

function readJsonlTail(file, maxBytes) {
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
    const out = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); }
      catch { /* Skip a partial or malformed line. */ }
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Seed a brand-new DeepSeek conversation from the tail of the cold log so the
 * first turn is not context-free. Read-only; never written back.
 */
function coldSeed(file, { maxMessages = 16, maxChars = 6000 } = {}) {
  if (!file) return [];
  const rows = readJsonlTail(file, 160 * 1024)
    .filter((row) => validTurn({ role: row.role, content: row.text }))
    .map((row) => ({ role: row.role, content: String(row.text).trim() }));
  const kept = [];
  let chars = 0;
  for (let i = rows.length - 1; i >= 0 && kept.length < maxMessages; i -= 1) {
    const row = rows[i];
    if (chars + row.content.length > maxChars && kept.length) break;
    kept.push(row);
    chars += row.content.length;
  }
  kept.reverse();
  return kept;
}

function mapUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const n = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  return {
    input_tokens: n(usage.prompt_tokens ?? usage.input_tokens),
    output_tokens: n(usage.completion_tokens ?? usage.output_tokens),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: n(usage.prompt_cache_hit_tokens ?? usage.cache_read_input_tokens),
  };
}

function createDeepseekRuntime({
  ingressPath,
  cwd = '',
  scope = 'box',
  onEvent = async () => {},
  sdkOptions = {},
  env = process.env,
  fetchImpl = globalThis.fetch,
  threadFile,
  coldFile,
  toolBelt = null,
} = {}) {
  if (!ingressPath) throw new Error('DeepSeek runtime requires ingressPath.');
  if (typeof fetchImpl !== 'function') throw new Error('DeepSeek runtime requires fetch.');

  const ingress = createIngress({ filePath: ingressPath });
  const storeFile = threadFile || path.join(path.dirname(ingressPath), 'deepseek-thread.json');
  const coldPath = coldFile === undefined
    ? (env.GATE_COLD_FILE || (env.GATE_ROOT ? path.join(env.GATE_ROOT, 'cold.jsonl') : ''))
    : coldFile;
  const cfg = resolveDeepseekConfig(env);

  let running = false;
  let stopping = false;
  let initialized = false;
  let disposed = false;
  let sessionId = '';
  let messages = [];
  let actualModel = cfg.model;
  const requestedModel = stripContextSuffix(sdkOptions.model || '');
  const owned = new Set();
  let pumping = false;
  let pumpAgain = false;
  let pumpPromise = null;
  let abort = null;
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

  function loadThread(resume) {
    try {
      const raw = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
      if (raw && raw.schema === SCHEMA && nonempty(raw.sessionId)) {
        sessionId = raw.sessionId.trim();
        messages = Array.isArray(raw.messages) ? raw.messages.filter(validTurn).slice(-MAX_HISTORY) : [];
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('[im-deepseek] cannot read thread file; starting a new one:', error.message);
      }
    }
    if (!sessionId) {
      sessionId = (typeof resume === 'string' && resume.startsWith('ds-')) ? resume : (`ds-${randomUUID()}`);
    }
  }

  function saveThread() {
    const next = messages.filter(validTurn).slice(-MAX_HISTORY);
    messages = next;
    const tmp = `${storeFile}.tmp`;
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ schema: SCHEMA, sessionId, messages: next }) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, storeFile);
  }

  let beltPromise = null;
  function belt() {
    if (toolBelt) return Promise.resolve(toolBelt);
    if (!beltPromise) {
      beltPromise = createToolBelt({
        cwd,
        sdkServers: sdkOptions.mcpServers || null,
        mcpFile: env.DEEPSEEK_MCP_FILE || '',
        fetchImpl,
      }).catch((error) => {
        console.error('[im-deepseek] tools failed to connect; answering without them:', error.message);
        return {
          openai: () => [],
          note: () => `Tools are not connected: ${error.message}`,
          call: async (name) => { throw new Error(`No such tool: ${name}`); },
          close: async () => {},
        };
      });
    }
    return beltPromise;
  }

  function buildSystem(extra) {
    const parts = [];
    if (typeof sdkOptions.systemPrompt === 'string' && sdkOptions.systemPrompt.trim()) {
      parts.push(sdkOptions.systemPrompt.trim());
    }
    if (cwd) {
      try {
        const extraFile = fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8').trim();
        if (extraFile) parts.push(extraFile);
      } catch { /* No CLAUDE.md in the workspace. */ }
    }
    parts.push(PLUG_NOTE);
    if (extra) parts.push(extra);
    let text = parts.join('\n\n');
    if (text.length > MAX_SYSTEM_CHARS) text = text.slice(0, MAX_SYSTEM_CHARS) + '\n\n(System prompt truncated.)';
    return text;
  }

  function apiMessages(userText, extraNote) {
    const out = [{ role: 'system', content: buildSystem(extraNote) }];
    if (messages.length === 0) {
      const seed = coldSeed(coldPath);
      if (seed.length) {
        out.push({ role: 'system', content: 'Below are the most recent messages from the cold log, for continuity. They are not part of this turn.' });
        out.push(...seed);
      }
    }
    out.push(...messages.map((row) => ({ role: row.role, content: row.content })));
    out.push({ role: 'user', content: userText });
    return out;
  }

  async function emitDecoded(frame, binding) {
    const bindings = [binding];
    for (const event of decode(frame)) await onEvent({ event, bindings });
  }

  function parseArgs(call) {
    const raw = call?.function?.arguments ?? call?.arguments ?? {};
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch { return {}; }
    }
    return raw && typeof raw === 'object' ? raw : {};
  }

  async function callModel(apiMsgs, tools, { allowEmpty = false } = {}) {
    if (!cfg.key) throw new Error('DEEPSEEK_API_KEY is not set.');
    abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), cfg.timeoutMs);
    try {
      const payload = {
        model: cfg.model,
        messages: apiMsgs,
        stream: false,
        // Reasoning models emit a thinking block first. This history carries no
        // thinking records and the request includes tools, which the API rejects
        // with 400. Disable thinking; the answer still arrives in `content`.
        thinking: { type: 'disabled' },
      };
      if (tools.length) payload.tools = tools;
      const response = await fetchImpl(cfg.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.key}`,
        },
        body: JSON.stringify(payload),
        signal: abort.signal,
      });
      const raw = await response.text();
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; }
      catch { /* Reported below as a non-JSON body. */ }
      if (!response.ok) {
        const detail = body?.error?.message || raw.slice(0, 180) || response.statusText;
        throw new Error(`DeepSeek HTTP ${response.status}: ${detail}`);
      }
      const choice = body?.choices?.[0]?.message;
      if (!choice || typeof choice !== 'object') throw new Error('DeepSeek returned no message.');
      if (typeof body?.model === 'string' && body.model.trim()) actualModel = body.model.trim();
      const text = typeof choice.content === 'string' ? choice.content.trim() : '';
      const calls = Array.isArray(choice.tool_calls) ? choice.tool_calls : [];
      if (!text && calls.length === 0 && !allowEmpty) throw new Error('DeepSeek returned no message.');
      return { text, calls, usage: mapUsage(body?.usage) };
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(stopping ? 'Turn was stopped.' : `DeepSeek did not answer within ${cfg.timeoutMs}ms.`);
      throw error;
    } finally {
      clearTimeout(timer);
      abort = null;
    }
  }

  async function runTool(tools, call) {
    const name = call?.function?.name || call?.name || '';
    const args = parseArgs(call);
    if (!tools.call) return 'No such tool.';
    const ask = sdkOptions.canUseTool;
    let decision = { behavior: 'allow', updatedInput: args };
    if (typeof ask === 'function') {
      try {
        const answer = await ask(name, args, { toolUseID: call.id || '' });
        if (answer && typeof answer === 'object') decision = answer;
      } catch (error) {
        return `Not permitted: ${error.message || error}`;
      }
    }
    if (decision.behavior === 'deny') return decision.message || 'Not permitted.';
    try {
      console.log(`[im-deepseek] tool ${name}`);
      return await tools.call(name, decision.updatedInput || args);
    } catch (error) {
      return `Failed: ${error.message || error}`;
    }
  }

  async function runTurn(row) {
    const uuid = row.uuid;
    const origin = row.payload?.origin || {};
    const binding = { uuid, origin };
    const userText = extractText(row.payload?.message);
    try {
      const tools = await belt();
      const apiMsgs = apiMessages(userText, tools.note());
      const openaiTools = tools.openai();
      let text = '';
      let usage;
      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        if (stopping) throw new Error('Turn was stopped.');
        const message = await callModel(apiMsgs, openaiTools);
        text = message.text;
        usage = message.usage || usage;
        if (!message.calls.length) break;
        if (text) {
          await emitDecoded({
            type: 'assistant',
            user_message_uuid: uuid,
            session_id: sessionId,
            message: {
              id: `dsmsg-${uuid}-${round}`,
              model: actualModel,
              role: 'assistant',
              content: [{ type: 'text', text }],
            },
          }, binding);
        }
        const calls = message.calls.map((call, index) => ({
          ...call,
          id: call.id || `call-${round}-${index}`,
          type: 'function',
          function: call.function || { name: call.name, arguments: JSON.stringify(parseArgs(call)) },
        }));
        apiMsgs.push({ role: 'assistant', content: text || '', tool_calls: calls });
        for (const call of calls) {
          const result = await runTool(tools, call);
          apiMsgs.push({ role: 'tool', tool_call_id: call.id, content: String(result ?? '') });
        }
        if (round === MAX_TOOL_ROUNDS - 1) {
          const last = await callModel(apiMsgs, [], { allowEmpty: true });
          text = last.text;
          usage = last.usage || usage;
        }
      }
      const assistant = {
        type: 'assistant',
        user_message_uuid: uuid,
        session_id: sessionId,
        message: {
          id: `dsmsg-${uuid}`,
          model: actualModel,
          role: 'assistant',
          content: [{ type: 'text', text }],
          ...(usage ? { usage } : {}),
        },
      };
      if (text) await emitDecoded(assistant, binding);
      await emitDecoded({
        type: 'result', subtype: 'success', is_error: false, result: text,
        session_id: sessionId, user_message_uuid: uuid,
      }, binding);
      messages.push({ role: 'user', content: userText }, { role: 'assistant', content: text || '(no text this turn)' });
      // The reply is already out. A failed history write must not emit a second,
      // failing result, or the owner would see one turn both succeed and fail.
      try { saveThread(); }
      catch (error) { console.error('[im-deepseek] could not save thread:', error.message); }
      ingress.complete(uuid, { failed: false });
    } catch (error) {
      const reason = error?.message || String(error);
      console.error('[im-deepseek] turn failed:', reason);
      try {
        await emitDecoded({
          type: 'result', subtype: 'error_during_execution', is_error: true,
          errors: [reason], result: '', session_id: sessionId, user_message_uuid: uuid,
        }, binding);
      } catch (callbackError) {
        console.error('[im-deepseek] could not deliver failure event:', callbackError.message);
      }
      try { ingress.complete(uuid, { failed: true, reason }); }
      catch (completeError) { failProcess(completeError); }
    }
  }

  /** Only replay pending rows this runtime accepted; never rows another runtime left behind. */
  function findOwnedPending() {
    return ingress.list('pending', scope).find((row) => owned.has(row.uuid) || row.payload?.brain === 'deepseek');
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

  function start() {
    if (disposed || stopping) return Promise.reject(new Error('This DeepSeek runtime has been stopped.'));
    if (running) return Promise.resolve();
    loadThread(sdkOptions.resume);
    running = true;
    initialized = true;
    for (const row of ingress.list('pending', scope)) {
      if (row.payload?.brain === 'deepseek') owned.add(row.uuid);
    }
    try { saveThread(); }
    catch (error) { console.error('[im-deepseek] cannot write thread file:', error.message); }
    console.log(`[im-deepseek] ready model=${cfg.model} session=${sessionId.slice(0, 11)}`);
    void pump();
    return Promise.resolve();
  }

  function enqueue({ message, origin, uuid } = {}) {
    if (disposed) throw refuse('Runtime is closed.');
    if (!running || stopping) throw refuse('No live DeepSeek runtime; call ensure first.');
    if (!cfg.key) throw refuse('DEEPSEEK_API_KEY is not set.');
    if (message?.type !== 'user' || message.message?.role !== 'user' || message.message?.content == null) {
      throw refuse('Expected a user message that triggers a reply.');
    }
    const userText = extractText(message);
    if (!userText) throw refuse('This turn has no text to send.');
    const id = nonempty(uuid) ? uuid : randomUUID();
    let row;
    try {
      row = ingress.accept({
        uuid: id,
        scope,
        payload: { uuid: id, origin: origin || {}, message, brain: 'deepseek' },
      });
    } catch (error) {
      error.notAccepted = true;
      throw error;
    }
    owned.add(id);
    void pump();
    return row;
  }

  async function stop() {
    if (stopping) {
      if (pumpPromise) await pumpPromise.catch(() => {});
      return;
    }
    stopping = true;
    try { abort?.abort(); } catch { /* Already finished. */ }
    if (pumpPromise) await pumpPromise.catch(() => {});
    running = false;
    if (!settled) { settled = true; doneResolve(); }
  }

  async function close() {
    try { await stop(); }
    finally {
      disposed = true;
      try { if (beltPromise) (await beltPromise).close(); } catch { /* Tools already stopped. */ }
      try { ingress.close(); } catch { /* Already closed. */ }
    }
  }

  return {
    enqueue,
    start,
    stop,
    close,
    get done() { return done; },
    get: (uuid) => ingress.get(uuid),
    list: (state) => ingress.list(state),
    status: () => ({
      running, stopping, initialized, requestedModel, actualModel, sessionId,
    }),
    async setModel() {
      // The model comes from DEEPSEEK_MODEL and does not follow Claude's /model
      // names. When the box changes want.model the host restarts the runtime;
      // a Claude model name is never put into a DeepSeek request.
    },
  };
}

module.exports = {
  createDeepseekRuntime,
  resolveDeepseekConfig,
  stripContextSuffix,
  extractText,
  coldSeed,
  PLUG_NOTE,
};
