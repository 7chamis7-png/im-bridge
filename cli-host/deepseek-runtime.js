'use strict';

/**
 * DeepSeek 插头 —— 跟 Claude 那套运行时同一张脸，但不起 /usr/bin/claude。
 *
 * 接上现成盒子时听盒子已经在连的那只插座（DEEPSEEK_SOCKET）。
 * 帧仍然是 runtime/decode.js 的形状（assistant 正文 + result subtype=success）。
 *
 * 不走 runtime/index.js。那边 G-1 见 apiKeySource !== 'none' 会把进程杀掉，
 * 专门防「Claude 偷偷按 API 计费」。这根插头本来就是 API，再套那条检查等于自己掐自己。
 *
 * 记忆跟 Claude 的舱分开：对话在 deepseek-thread.json，不写 sessions.json，
 * 也不读 Claude 的 jsonl。切回去，他原来那条舱还在。
 *
 * 工具走桥递来的 MCP，加上 Read / Edit / Write / Bash。没有的就不假装有。
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createIngress } = require('../runtime/ingress');
const { neutral, openaiUsageEvent } = require('./neutral');
const { createToolBelt } = require('./deepseek-tools');
const { deepseekBalance } = require('./usage');

const SCHEMA = 'nova.deepseek-thread.v1';
const MAX_TOOL_ROUNDS = 12;
const PLUG_NOTE = [
  '工具已经接上。要用就调用，不要假装做过。清单里没有的就说没有。',
  '正文直接写就是发给她。reply 只在她指定渠道时用。',
].join('\n');

function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function firstNonEmpty(...values) {
  for (const value of values) if (nonempty(value)) return value.trim();
  return '';
}

/** 配置里的 claude-fable-5[1m] 这种后缀是上下文长度，不是模型名的一部分。 */
function stripContextSuffix(model) {
  return String(model || '').trim().replace(/\[[^\]]+\]$/, '');
}

/**
 * 钥匙和地址只从环境读，不写进代码、不打进日志。
 * 现网这把钥匙原来就在进程环境里（给 Claude Code 的兼容地址用的），这里接着用，不另抄一份。
 */
function resolveDeepseekConfig(env = process.env, overrides = null) {
  // 2026-10-21 S5：单宿主换芯时钥匙 / 地址 / 模型由宿主从登记表 + /root/.secrets 交进来（overrides），
  // 给了就**只用**给的 —— 不再往 env 里那几个历史名字（ANTHROPIC_AUTH_TOKEN 之类）里捡，免得拿错一把钥匙。
  if (overrides && typeof overrides === 'object') {
    const timeoutMs = Number(env.NOVA_DEEPSEEK_TIMEOUT_MS || 90_000);
    const b = String(overrides.baseUrl || 'https://api.deepseek.com').trim().replace(/\/+$/, '').replace(/\/anthropic$/, '');
    return {
      url: /\/chat\/completions$/.test(b) ? b : `${b}/chat/completions`,
      key: String(overrides.apiKey || '').trim(),
      model: stripContextSuffix(overrides.model || 'deepseek-chat'),
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 90_000,
    };
  }
  let base = firstNonEmpty(
    env.NOVA_DEEPSEEK_BASE_URL,
    env.CYBERBOSS_REBUILD_OPENAI_BASE_URL,
    'https://api.deepseek.com',
  ).replace(/\/+$/, '').replace(/\/anthropic$/, '');
  const key = firstNonEmpty(
    env.DEEPSEEK_API_KEY,
    env.NOVA_DEEPSEEK_API_KEY,
    env.CYBERBOSS_REBUILD_OPENAI_API_KEY,
    env.ANTHROPIC_AUTH_TOKEN,
  );
  const model = stripContextSuffix(firstNonEmpty(
    env.NOVA_DEEPSEEK_MODEL,
    env.CYBERBOSS_REBUILD_OPENAI_MODEL,
    env.ANTHROPIC_MODEL,
    'deepseek-chat',
  ));
  const timeoutMs = Number(env.NOVA_DEEPSEEK_TIMEOUT_MS || 90_000);
  return {
    url: /\/chat\/completions$/.test(base) ? base
      : (base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/chat/completions`),
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
  if (images && parts.length === 0) return '（她发了图片。这根插头看不见图。）';
  if (images) parts.push(`（另有 ${images} 张图，这根插头看不见。）`);
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
      catch { /* 半行或坏行跳过 */ }
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/** 冷层只在 DeepSeek 自己还没有对话时垫一层，避免一插上就失忆。只读尾巴，不回写。 */
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
  // S5：{ apiKey, baseUrl, model }（宿主从登记表 + /root/.secrets/<secret>.secret 读好交进来）。不给 = 老样子读 env。
  credentials = null,
} = {}) {
  if (!ingressPath) throw new Error('DeepSeek 插头要 ingressPath，不猜台账位置。');
  if (typeof fetchImpl !== 'function') throw new Error('没有 fetch，DeepSeek 插头发不出请求。');

  const ingress = createIngress({ filePath: ingressPath });
  const storeFile = threadFile || path.join(path.dirname(ingressPath), 'deepseek-thread.json');
  const coldPath = coldFile === undefined
    ? (env.GATE_COLD_FILE || (env.GATE_ROOT ? path.join(env.GATE_ROOT, 'cold.jsonl') : ''))
    : coldFile;
  const cfg = resolveDeepseekConfig(env, credentials);

  let running = false;
  let stopping = false;
  let initialized = false;
  let disposed = false;
  let sessionId = '';
  let messages = [];
  /** 对话本最多留几条。平时 40；换引擎垫进来的尾巴比 40 长就按它（盒子已经按窗口预算截过）。 */
  let maxMessages = 40;
  /** 换舱单（S3c 同款，S5 推广到这根插头）：用过的 token 记在对话本里，同一张单不换第二次。 */
  let rotatedFor = '';
  let lastRebuild = null;
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
        if (Number.isInteger(raw.maxMessages) && raw.maxMessages > 40) maxMessages = raw.maxMessages;
        messages = Array.isArray(raw.messages) ? raw.messages.filter(validTurn).slice(-maxMessages) : [];
        rotatedFor = nonempty(raw.rotatedFor) ? raw.rotatedFor.trim() : '';
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('[engine/deepseek] 对话文件读不了，另起一条：', error.message);
      }
    }
    if (!sessionId) {
      sessionId = (typeof resume === 'string' && resume.startsWith('ds-')) ? resume : (`ds-${randomUUID()}`);
    }
  }

  function saveThread() {
    const next = messages.filter(validTurn).slice(-maxMessages);
    messages = next;
    const tmp = `${storeFile}.tmp`;
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    const body = { schema: SCHEMA, sessionId, messages: next,
      ...(maxMessages > 40 ? { maxMessages } : {}), ...(rotatedFor ? { rotatedFor } : {}) };
    fs.writeFileSync(tmp, JSON.stringify(body) + '\n', { mode: 0o600 });
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
        console.error('[engine/deepseek] 工具没接上，这轮先说话：', error.message);
        return {
          openai: () => [],
          note: () => `工具没接上：${error.message}`,
          call: async (name) => { throw new Error(`没有这个工具：${name}`); },
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
      } catch { /* 工作目录没有 CLAUDE.md 就不拼 */ }
    }
    parts.push(PLUG_NOTE);
    if (extra) parts.push(extra);
    let text = parts.join('\n\n');
    if (text.length > 48_000) text = text.slice(0, 48_000) + '\n\n（系统提示太长，后面截掉了。）';
    return text;
  }

  function apiMessages(userText, extraNote) {
    const out = [{ role: 'system', content: buildSystem(extraNote) }];
    if (messages.length === 0) {
      const seed = coldSeed(coldPath);
      if (seed.length) {
        out.push({ role: 'system', content: '下面是冷层里最近的原话，接得上就接。这不是本轮她刚说的。' });
        out.push(...seed);
      }
    }
    out.push(...messages.map((row) => ({ role: row.role, content: row.content })));
    out.push({ role: 'user', content: userText });
    return out;
  }

  /** S2b（2026-10-21）：直接吐通用事件 imb.event.v1，不再拼假的 Claude 帧（工具调用原来全丢）。 */
  async function emitNeutral(ev, binding) {
    await onEvent({ event: neutral('openai-chat', binding.uuid, { ...ev, model: ev.model || actualModel }), bindings: [binding] });
  }

  function parseArgs(call) {
    const raw = call?.function?.arguments ?? call?.arguments ?? {};
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch { return {}; }
    }
    return raw && typeof raw === 'object' ? raw : {};
  }

  async function callModel(messages, tools, { allowEmpty = false } = {}) {
    if (!cfg.key) throw new Error('没有 DeepSeek 的钥匙（DEEPSEEK_API_KEY 或 CYBERBOSS_REBUILD_OPENAI_API_KEY）。');
    abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), cfg.timeoutMs);
    try {
      const payload = {
        model: cfg.model,
        messages,
        stream: false,
        // Pro 默认先写一大段思考。这段对话没有那些思考记录，请求里又带着工具，
        // 接口会直接 400。关掉思考，正文照旧在 content 里。
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
      catch { /* 下面按非 JSON 报 */ }
      if (!response.ok) {
        const detail = body?.error?.message || raw.slice(0, 180) || response.statusText;
        throw new Error(`DeepSeek HTTP ${response.status}：${detail}`);
      }
      const choice = body?.choices?.[0]?.message;
      if (!choice || typeof choice !== 'object') throw new Error('DeepSeek 这轮没有正文。');
      if (typeof body?.model === 'string' && body.model.trim()) actualModel = body.model.trim();
      const text = typeof choice.content === 'string' ? choice.content.trim() : '';
      const calls = Array.isArray(choice.tool_calls) ? choice.tool_calls : [];
      if (!text && calls.length === 0 && !allowEmpty) throw new Error('DeepSeek 这轮没有正文。');
      return { text, calls, usage: mapUsage(body?.usage), usageRaw: body?.usage };
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(stopping ? '这轮被停掉了。' : `DeepSeek 超过 ${cfg.timeoutMs}ms 没回。`);
      throw error;
    } finally {
      clearTimeout(timer);
      abort = null;
    }
  }

  /** 跑一个工具。返回 { text, isError }（isError：没放行 / 没做成 / 没这个工具 —— 通用事件 tool.result 要分得清）。 */
  async function runTool(tools, call) {
    const name = call?.function?.name || call?.name || '';
    const args = parseArgs(call);
    if (!tools.call) return { text: '没有这个工具。', isError: true };
    const ask = sdkOptions.canUseTool;
    let decision = { behavior: 'allow', updatedInput: args };
    if (typeof ask === 'function') {
      try {
        const answer = await ask(name, args, { toolUseID: call.id || '' });
        if (answer && typeof answer === 'object') decision = answer;
      } catch (error) {
        return { text: `没放行：${error.message || error}`, isError: true };
      }
    }
    if (decision.behavior === 'deny') return { text: decision.message || '没放行。', isError: true };
    try {
      console.log(`[engine/deepseek] 工具 ${name}`);
      return { text: await tools.call(name, decision.updatedInput || args), isError: false };
    } catch (error) {
      return { text: `没做成：${error.message || error}`, isError: true };
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
        if (stopping) throw new Error('这轮被停掉了。');
        const message = await callModel(apiMsgs, openaiTools);
        text = message.text;
        usage = message.usageRaw || usage;
        if (!message.calls.length) break;
        if (text) {
          await emitNeutral({ kind: 'text', id: `dsmsg-${uuid}-${round}`, text, deliverHint: 'text', generatedBy: 'model' }, binding);
        }
        const calls = message.calls.map((call, index) => ({
          ...call,
          id: call.id || `call-${round}-${index}`,
          type: 'function',
          function: call.function || { name: call.name, arguments: JSON.stringify(parseArgs(call)) },
        }));
        apiMsgs.push({ role: 'assistant', content: text || '', tool_calls: calls });
        for (const call of calls) {
          await emitNeutral({ kind: 'tool.call', id: call.id, name: call.function.name || '', server: '', args: parseArgs(call) }, binding);
          const result = await runTool(tools, call);
          const out = String(result.text ?? '');
          await emitNeutral({ kind: 'tool.result', callId: call.id, isError: result.isError, text: out, images: [] }, binding);
          apiMsgs.push({ role: 'tool', tool_call_id: call.id, content: out });
        }
        if (round === MAX_TOOL_ROUNDS - 1) {
          const last = await callModel(apiMsgs, [], { allowEmpty: true });
          text = last.text;
          usage = last.usageRaw || usage;
        }
      }
      const u = openaiUsageEvent(usage, actualModel);
      if (u) await emitNeutral(u, binding);
      if (text) await emitNeutral({ kind: 'text', id: `dsmsg-${uuid}`, text, deliverHint: 'text', generatedBy: 'model' }, binding);
      await emitNeutral({ kind: 'turn.end', status: 'ok', synthetic: false, subtype: 'success', errors: [], text }, binding);
      messages.push({ role: 'user', content: userText }, { role: 'assistant', content: text || '（这轮没有再写字）' });
      // 话已经送出去了。对话文件写失败不能再补一条失败结果，否则她会看到这轮既成功又失败。
      try { saveThread(); }
      catch (error) { console.error('[engine/deepseek] 对话没记下来：', error.message); }
      ingress.complete(uuid, { failed: false });
    } catch (error) {
      const reason = error?.message || String(error);
      console.error('[engine/deepseek] 这一轮没成：', reason);
      try {
        await emitNeutral({ kind: 'turn.end', status: 'error', synthetic: false, subtype: 'error_during_execution',
          errors: [reason], text: '' }, binding);
      } catch (callbackError) {
        console.error('[engine/deepseek] 失败事件没送出去：', callbackError.message);
      }
      try { ingress.complete(uuid, { failed: true, reason }); }
      catch (completeError) { failProcess(completeError); }
    }
  }

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
    if (disposed || stopping) return Promise.reject(new Error('这个 DeepSeek 插头已经停了。'));
    if (running) return Promise.resolve();
    loadThread(sdkOptions.resume);
    // 换舱单（/new、水位、/engine）：没用过 → 新开一本对话；/engine 还会带 rebuild.tail（盒子按新窗口挑好的尾巴）
    const token = nonempty(sdkOptions.freshThread) ? sdkOptions.freshThread.trim() : '';
    if (token && token !== rotatedFor) {
      const rebuild = (sdkOptions.rebuild && typeof sdkOptions.rebuild === 'object') ? sdkOptions.rebuild : null;
      if (rebuild && rebuild.strict && !cfg.key) {
        return Promise.reject(new Error('没有 DeepSeek 的钥匙 —— 换不过来，留在原引擎。'));
      }
      const from = sessionId;
      sessionId = `ds-${randomUUID()}`;
      const tail = rebuild && Array.isArray(rebuild.tail) ? rebuild.tail : [];
      messages = tail.filter((t) => t && (t.role === 'user' || t.role === 'assistant') && String(t.text || '').trim())
        .map((t) => ({ role: t.role, content: String(t.text).trim() }));
      maxMessages = Math.max(40, messages.length);
      rotatedFor = token;
      lastRebuild = { injected: messages.length, verified: true };
      console.log(`[engine/deepseek] 换舱：${from ? from.slice(0, 11) : '(没有)'} → ${sessionId.slice(0, 11)}，垫了 ${messages.length} 条`);
    }
    running = true;
    initialized = true;
    for (const row of ingress.list('pending', scope)) {
      if (row.payload?.brain === 'deepseek') owned.add(row.uuid);
    }
    try { saveThread(); }
    catch (error) { console.error('[engine/deepseek] 对话文件写不进去：', error.message); }
    console.log(`[engine/deepseek] 就绪 model=${cfg.model} session=${sessionId.slice(0, 11)}`);
    void pump();
    return Promise.resolve();
  }

  function enqueue({ message, origin, uuid } = {}) {
    if (disposed) throw refuse('运行时已经关了。');
    if (!running || stopping) throw refuse('现在没有活着的 DeepSeek 插头 —— 先 ensure。');
    if (!cfg.key) throw refuse('没有 DeepSeek 的钥匙（DEEPSEEK_API_KEY 或 CYBERBOSS_REBUILD_OPENAI_API_KEY）。');
    if (message?.type !== 'user' || message.message?.role !== 'user' || message.message?.content == null) {
      throw refuse('请提供会触发回复的 user 消息。');
    }
    const userText = extractText(message);
    if (!userText) throw refuse('这轮没有可送的正文。');
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
    try { abort?.abort(); } catch { /* 已经结束 */ }
    if (pumpPromise) await pumpPromise.catch(() => {});
    running = false;
    if (!settled) { settled = true; doneResolve(); }
  }

  async function close() {
    try { await stop(); }
    finally {
      disposed = true;
      try { if (beltPromise) (await beltPromise).close(); } catch { /* 工具已经停了 */ }
      try { ingress.close(); } catch { /* 已关 */ }
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
      ...(lastRebuild ? { rebuilt: lastRebuild } : {}),
    }),
    /** /usage：按量计费，没有订阅额度 —— 查余额（GET /user/balance，不扣费）。 */
    usage: () => deepseekBalance({ apiKey: cfg.key, baseUrl: cfg.url.replace(/\/chat\/completions$/, ''), fetchImpl }),
    /** 同一家内热切（/model，S5）：下一次请求起用新名字。别家的名字拒绝（跨厂商是 /engine）。 */
    async setModel(m) {
      const next = stripContextSuffix(m || '');
      if (!next) throw new Error('要给模型名');
      if (/^(claude|gpt-|o\d)/i.test(next)) throw new Error(`DeepSeek 插头不认「${next}」—— 跨厂商用 /engine`);
      cfg.model = next;
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
