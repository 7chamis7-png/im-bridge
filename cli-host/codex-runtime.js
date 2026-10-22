'use strict';

/**
 * codex 插头 —— Iris的运行时。跟 Claude / DeepSeek 那套同一张脸，底下驱动 codex app-server。
 *
 * 跟 deepseek-runtime.js 一个骨架（ingress / pump / 吐 Claude 帧给 decode），差别：
 *   · 不在 JS 里跑工具循环 —— codex app-server 服务端自己跑完工具，只把最终答复吐回来。
 *   · 会话连续性靠 codex 的 threadId（服务端存 rollout），这里只把 threadId 落盘，换舱/重启能续。
 *   · 工具、审批、流式都在 codex-appserver.js 那层处理。
 *
 * 钱的硬闸（AGENTS.md 第6条对应）：Iris必须跑在 ChatGPT 订阅上（auth.json auth_mode=chatgpt）。
 * 见到按量计费的 API key 就当场停 —— 别偷偷花钱。
 */

const fs = require('node:fs');
const path = require('node:path');
const { homeDir: userHome } = require('../src/core/paths');
const { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createIngress } = require('../runtime/ingress');
const { neutral, codexItemToNeutral, codexUsageEvent } = require('./neutral');
const { createCodexAppServer, stripContextSuffix, configOverridesFromEnv } = require('./codex-appserver');
const { coldSeed } = require('./deepseek-runtime');   // 冷层暖尾巴的读法跟 deepseek 一个口径，复用
const { rebuildCodexThread } = require('./rebuild-codex');
const { forgeSwitch } = require('../src/box/forge-switch');
const { historyMode, historyDir } = require('../src/box/history');
const { codexUsage } = require('./usage');

const SCHEMA = 'nova.codex-thread.v1';

function nonempty(v) { return typeof v === 'string' && v.trim().length > 0; }

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

/**
 * 用量：codex 的 tokenUsage → Claude 帧的 usage 形状（盒子拿四个数相加当水位）。
 *
 * S3c 修了两处（10-21 Iris rollout 实测：total.input=791,233，last.input=55,924 其中缓存命中 11,264）：
 *   · 用 **last**（上一次请求 = 现在上下文多大），不是 total（整条 thread 累计，几轮就把水位顶穿，桥会一直换舱）
 *   · codex 的 inputTokens **已经含**缓存命中（OpenAI 口径），原来又把 cachedInputTokens 当 cache_read 加一遍 → 重复算。
 *     现在 input_tokens 只放没命中的那部分，四个数加起来 = inputTokens + outputTokens（跟 codex 自己的 totalTokens 一致）
 * 也认老的直接给一个 breakdown 的调用（当它就是 last）。
 */
function mapUsage(tokenUsage) {
  if (!tokenUsage || typeof tokenUsage !== 'object') return undefined;
  const b = (tokenUsage.last && typeof tokenUsage.last === 'object') ? tokenUsage.last
    : (tokenUsage.total && typeof tokenUsage.total === 'object' ? null : tokenUsage);
  if (!b) return undefined;   // 只有累计数没有 last：宁可不报水位，也别拿累计数冒充
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const cached = n(b.cachedInputTokens);
  const written = n(b.cacheWriteInputTokens);
  return {
    input_tokens: Math.max(0, n(b.inputTokens) - cached - written),
    output_tokens: n(b.outputTokens),
    cache_creation_input_tokens: written,
    cache_read_input_tokens: cached,
  };
}

/** 钱的硬闸：auth.json 必须是 chatgpt 订阅，不是按量计费的 key。 */
function assertSubscription(authFile) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(authFile, 'utf8')); }
  catch (error) {
    throw new Error(`codex 登录态读不到（${authFile}）：${error.message}。Iris起不来，别猜。`);
  }
  const mode = String(raw.auth_mode || '').toLowerCase();
  const hasApiKey = nonempty(raw.OPENAI_API_KEY);
  if (mode === 'chatgpt') return;                       // 订阅：放行
  if (mode === 'apikey' || hasApiKey) {
    throw new Error('codex 登录态是 API key（按量计费）。Iris只许跑 ChatGPT 订阅，拒绝起来 —— 别偷偷花钱。');
  }
  throw new Error(`codex auth_mode 认不出（"${raw.auth_mode}"）。为安全起见不起，先确认是订阅。`);
}

/**
 * 版本闸（设计稿 §3.4，S5 换引擎才用）：认识的 codex 版本才许往新 thread 里重建历史。
 * 白名单 CODEX_VERSION_ALLOW（逗号分隔，默认 0.163.0 = S0 实测过 inject_items 的那版）。
 * 读不到版本 / 不在白名单 → 拒绝，留在原引擎。TODO：协议指纹（generate-json-schema 的 sha256）还没做。
 */
function codexVersionGuard({ codexPath, env = process.env } = {}) {
  let out = '';
  try { out = execFileSync(codexPath, ['--version'], { env, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); }
  catch (e) { return { ok: false, version: '', reason: `读不到 codex 版本（${codexPath} --version：${e.message.split('\n')[0]}）` }; }
  const m = /(\d+\.\d+\.\d+)/.exec(out);
  const version = m ? m[1] : '';
  const allow = String(env.CODEX_VERSION_ALLOW || '0.163.0').split(',').map((v) => v.trim()).filter(Boolean);
  if (!version) return { ok: false, version, reason: `codex --version 输出认不出：${out.trim().slice(0, 60)}` };
  if (!allow.includes(version)) return { ok: false, version, reason: `codex ${version} 不在白名单（${allow.join(', ')}）：inject_items 没在这版上验过` };
  return { ok: true, version, reason: `codex ${version}` };
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
  authFile = '',
  codexPath = '/usr/local/bin/codex',
  home = userHome(),
  // 2026-10-21 S5：这个人格自己的 CODEX_HOME（thread / rollout / auth.json 都在里面）。不给 = 老样子（~/.codex，Iris今天这样）。
  // 两个人格共用一个 CODEX_HOME 会把 thread 混进同一个 sessions 目录（设计稿 §5.1），Nova切 codex 之前必须先分开。
  codexHome = '',
  driverFactory = createCodexAppServer,   // 测试换假驱动用；生产就是 codex app-server
} = {}) {
  if (!ingressPath) throw new Error('codex 插头要 ingressPath，不猜台账位置。');
  if (!cwd) throw new Error('codex 插头要 cwd（工作目录），不猜。');

  const homeDir = nonempty(codexHome) ? codexHome.trim() : '';
  const authPath = nonempty(authFile) ? authFile : (homeDir ? path.join(homeDir, 'auth.json') : path.join(userHome(), '.codex', 'auth.json'));
  assertSubscription(authPath);   // 起之前就把钱的闸验了

  const ingress = createIngress({ filePath: ingressPath });
  const storeFile = threadFile || path.join(path.dirname(ingressPath), 'codex-thread.json');
  const imageDir = path.join(path.dirname(ingressPath), 'codex-images');
  // 2026-10-21 S5：模型名由盒子按登记表（$GATE_ROOT/models.json）给，这里**不再悄悄回落**。
  // 原来（10-09）见到不是 gpt / o 系列的名字就回落 GATE_MODEL —— 她点了别的模型、他其实没换，没人知道。
  // 现在：明显是别家的名字就当场拒绝起来（盒子会留在原引擎、把原因告诉她）；没给才用默认（GATE_MODEL）。
  const wanted = stripContextSuffix(sdkOptions.model || '');
  if (wanted && /^(claude|deepseek|anthropic)/i.test(wanted)) {
    throw new Error(`codex 插头不认「${wanted}」（是别家的模型）—— 不回落，拒绝起来。查 models.json 里它登记的引擎。`);
  }
  let model = wanted || stripContextSuffix(env.GATE_MODEL || 'gpt-5.6-sol');

  // 工具：优先用桥递来的 sdkOptions.mcpServers（gate 写的 im_bridge 那套嘴）；
  // 没递就读 gate 落盘的 mcp-im-bridge.json（GATE_MCP_FILE 或 cfg.root 下那份）。
  let mcpServers = (sdkOptions.mcpServers && typeof sdkOptions.mcpServers === 'object') ? sdkOptions.mcpServers : null;
  if (!mcpServers) {
    const mcpFile = env.GATE_MCP_FILE || (env.GATE_ROOT ? path.join(env.GATE_ROOT, 'mcp-im-bridge.json') : '');
    if (mcpFile) {
      try {
        const parsed = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
        if (parsed && parsed.mcpServers && typeof parsed.mcpServers === 'object') mcpServers = parsed.mcpServers;
      } catch { /* 没有就没有，不假装有工具 */ }
    }
  }

  // 登记表给的 codex -c 覆盖（窗口等）压在 env 那份上面（同名键以登记表为准）
  const overrides = configOverridesFromEnv(env, (m) => console.error(m));
  const fromRegistry = (sdkOptions.codexConfig && typeof sdkOptions.codexConfig === 'object') ? sdkOptions.codexConfig : null;
  if (fromRegistry) {
    for (const [k, v] of Object.entries(fromRegistry)) {
      if (!/^[a-z_]+$/.test(k) || !Number.isInteger(Number(v)) || Number(v) <= 0) continue;
      for (let i = overrides.length - 1; i >= 0; i -= 1) if (overrides[i].startsWith(`${k}=`)) overrides.splice(i, 1);
      overrides.push(`${k}=${Number(v)}`);
    }
  }
  const driver = driverFactory({
    codexPath, cwd, model, home, env: homeDir ? { ...env, CODEX_HOME: homeDir } : env,
    developerInstructions: nonempty(sdkOptions.systemPrompt) ? sdkOptions.systemPrompt.trim() : '',
    mcpServers,
    configOverrides: overrides,
    log: (m) => console.log(m),
    onCompaction: (info) => { void noteCompaction(info); },
  });

  /**
   * codex 自己压缩了（S3c：桥本该抢在它前面换舱，没抢到）。记成通用事件 engine.notice{compacted}
   * 交给盒子（盒子记全本 + 日志喊一声，设计稿 §8.2）。挂在正在跑的那一轮上。不许抛。
   */
  let currentBinding = null;
  async function noteCompaction(info) {
    try {
      const binding = currentBinding;
      await onEvent({
        event: { v: 'imb.event.v1', engine: 'codex-appserver', kind: 'engine.notice', what: 'compacted', ...(binding ? { turn: binding.uuid } : {}),
          id: `cx-compact-${info.turnId || info.count}`, threadId: info.threadId || threadId,
          meta: { count: info.count } },
        bindings: binding ? [binding] : [],
      });
    } catch (e) { console.error('[engine/codex] 压缩事件没送出去：', e.message); }
  }

  // 冷层暖尾巴：起全新 thread 时垫进第一轮，别让Iris一上来就失忆。续上旧 thread 就不垫（codex 自己有历史）。
  const coldPath = env.GATE_COLD_FILE || (env.GATE_ROOT ? path.join(env.GATE_ROOT, 'cold.jsonl') : '');
  let freshThread = true;   // start() 里续上旧 thread 会置 false
  let seeded = false;       // 冷层只垫一次（第一轮）

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

  // codex-thread.json：{ schema, threadId, rotatedFor?, rotatedAt?, previousThreadId? }
  //   rotatedFor = 最后一次用掉的换舱单 token（盒子 → sdkOptions.freshThread）。同一张单再来（client 重连会把
  //   同一份 ensure 重发一遍、cli 重启后盒子也会重发）就只续，不再换第二次。
  //   previousThreadId = 换舱前那条（回滚：把它写回 threadId 就能 resume 回去，rollout 文件没动）。
  let rotatedFor = '';
  let rotatedAt = '';
  let previousThreadId = '';
  /** 这次起来垫了什么（S5 换引擎回执要说）。 */
  let lastRebuild = null;
  function loadThread() {
    try {
      const raw = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
      if (raw && raw.schema === SCHEMA && nonempty(raw.threadId)) threadId = raw.threadId.trim();
      if (raw && raw.schema === SCHEMA) {
        rotatedFor = nonempty(raw.rotatedFor) ? raw.rotatedFor.trim() : '';
        rotatedAt = nonempty(raw.rotatedAt) ? raw.rotatedAt : '';
        previousThreadId = nonempty(raw.previousThreadId) ? raw.previousThreadId.trim() : '';
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('[engine/codex] threadId 文件读不了，另起：', error.message);
    }
  }

  function saveThread() {
    const tmp = `${storeFile}.tmp`;
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    const body = { schema: SCHEMA, threadId,
      ...(rotatedFor ? { rotatedFor, rotatedAt } : {}), ...(previousThreadId ? { previousThreadId } : {}) };
    fs.writeFileSync(tmp, JSON.stringify(body) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, storeFile);
  }

  /** 换舱流水（追加，只给人看 / 回滚找号用）：哪天从哪条换到哪条。写不进去不挡换舱。 */
  function logRotation(entry) {
    try {
      fs.appendFileSync(path.join(path.dirname(storeFile), 'codex-rotations.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
    } catch (e) { console.error('[engine/codex] 换舱流水写不进去：', e.message); }
  }

  /**
   * S2b（2026-10-21）：直接吐通用事件 imb.event.v1（设计稿 §2.1），不再拼假的 Claude 帧给 decode —— 那条路把工具调用、
   * reasoning 全丢了，用量还得先翻成 Claude 的字段名。盒子从 S2a 起双认。⚠️ 上线顺序：盒子必须先是 S2a 以后的版本。
   */
  async function emitNeutral(ev, binding) {
    await onEvent({ event: neutral('codex-appserver', binding.uuid, ev), bindings: [binding] });
  }

  async function runTurn(row) {
    const uuid = row.uuid;
    const origin = row.payload?.origin || {};
    const binding = { uuid, origin };
    currentBinding = binding;
    const turnInput = extractTurnInput(row.payload?.message, imageDir);
    try {
      if (!turnInput.length) throw new Error('这轮没有可送的正文或图片。');
      // 全新 thread 的第一轮：把冷层暖尾巴垫在她这句话前面，Iris回来接得上。
      let toSend = turnInput;
      if (freshThread && !seeded) {
        seeded = true;
        const seedRows = coldPath ? coldSeed(coldPath) : [];
        if (seedRows.length) {
          const tail = seedRows.map((r) => `${r.role === 'user' ? '她' : '我'}：${r.content}`).join('\n');
          toSend = [
            { type: 'text', text: `【接上次（冷层里最近的原话，接得上就接，这不是她这一轮刚说的）】\n${tail}\n\n【她现在说】` },
            ...turnInput,
          ];
          console.log(`[engine/codex] 冷层垫了 ${seedRows.length} 轮暖尾巴`);
        }
      }
      // 这一轮的工具 / reasoning / 边写边念，按到达顺序排队送（回调是同步的，送是异步的）
      let chain = Promise.resolve();
      let deltas = 0;
      const later = (ev) => { chain = chain.then(() => emitNeutral(ev, binding)).catch((e) => console.error('[engine/codex] 事件没送出去：', e.message)); };
      let result;
      try {
        result = await driver.runTurn(toSend, {
          onDelta: (d) => { deltas += 1; later({ kind: 'text.delta', text: d }); },
          onItem: (item) => { for (const ev of codexItemToNeutral(item)) later({ ...ev, model: actualModel }); },
        });
      } finally { await chain; }
      if (deltas) await emitNeutral({ kind: 'text.delta', end: true }, binding);
      const { text, usage } = result;
      // 驱动起/续 thread 后 threadId 可能变，跟上并落盘。
      if (driver.threadId && driver.threadId !== threadId) { threadId = driver.threadId; try { saveThread(); } catch {} }
      let reply = String(text || '').trim();
      // 日记/冒泡的提示词要他「不想说就回 NO_REPLY」；桥不认这个词，这里当没说话，不然她会收到一条 NO_REPLY。
      if (/^NO_REPLY[。.!！\s]*$/i.test(reply)) { console.log('[engine/codex] 这轮他选了沉默（NO_REPLY）'); reply = ''; }
      const u = codexUsageEvent(usage, actualModel);
      if (u) await emitNeutral(u, binding);
      if (reply) {
        await emitNeutral({ kind: 'text', id: `cxmsg-${uuid}`, model: actualModel, text: reply,
          deliverHint: 'text', generatedBy: 'model', threadId }, binding);
      }
      await emitNeutral({ kind: 'turn.end', status: 'ok', synthetic: false, subtype: 'success', errors: [], text: reply, threadId }, binding);
      ingress.complete(uuid, { failed: false });
    } catch (error) {
      const reason = error?.message || String(error);
      console.error('[engine/codex] 这一轮没成：', reason);
      try {
        await emitNeutral({ kind: 'turn.end', status: 'error', synthetic: false, subtype: 'error_during_execution',
          errors: [reason], text: '', threadId }, binding);
      } catch (cbErr) { console.error('[engine/codex] 失败事件没送出去：', cbErr.message); }
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

  /**
   * forge 的 codex 那一半（2026-10-21）：按人开（$GATE_ROOT/tools.json 的 forge，没写认 FORGE_ENABLED=true）。
   * 新开的 thread 用 thread/inject_items 把最近的真实对话当**真的轮**塞进去（跟 claude 合成 transcript 同一份料），
   * 代替原来第一轮前面拼的那段「【接上次…】」文字。塞不进去就照旧走文字垫底，不挡她这一轮。
   */
  async function maybeForge() {
    const sw = forgeSwitch({ env, log: (m) => console.log(m) });
    if (!sw.on) return;
    try {
      const { selectTail } = require('../scripts/forge');
      const hdir = historyMode(env) === 'on' ? historyDir(env.GATE_ROOT, env) : '';
      // withBody / oldOutboxDb 关掉：那两样是Nova一个人的（~/.nova 底下），别垫进别人的舱
      const picked = selectTail({ conversationSourceFile: coldPath, workspaceRoot: cwd, historyDir: hdir,
        withBody: false, oldOutboxDb: false, log: (m) => console.log(m) });
      const r = await rebuildCodexThread({ driver, tail: picked.tail, log: (m) => console.error(m) });
      if (r.ok) {
        seeded = true;
        console.log(`[engine/codex] forge（${sw.from}）垫了 ${r.injected} 条真实轮，料源=${picked.source}`
          + `${r.verified ? '，rollout 回读一致' : ''}`);
      } else console.log(`[engine/codex] forge 没垫上（${r.reason}），照旧冷层文字垫底`);
    } catch (e) {
      console.error(`[engine/codex] forge 出错（照旧冷层文字垫底）：${e.message}`);
    }
  }

  async function start() {
    if (disposed || stopping) return Promise.reject(new Error('这个 codex 插头已经停了。'));
    if (running) return;
    loadThread();
    // 盒子递来的号只在自己没记的时候用（codex-thread.json 才是真账；盒子那份标签以前会落后，S3c 第 5 条）
    if (!threadId && nonempty(sdkOptions.resume)) threadId = sdkOptions.resume.trim();
    // 换舱单（S3c）：盒子 /new 或水位撞线后递来的一次性 token。没用过 → 这次开新 thread，不续旧的。
    const token = nonempty(sdkOptions.freshThread) ? sdkOptions.freshThread.trim() : '';
    const rotating = Boolean(token) && token !== rotatedFor;
    if (token && !rotating) console.log(`[engine/codex] 换舱单 ${token.slice(0, 8)} 已经用过（${rotatedAt || '?'}），只续 thread=${threadId.slice(0, 13)}`);
    // S5 换引擎（/engine）：盒子已经按新窗口挑好尾巴交过来（sdkOptions.rebuild）。strict = 任何一步不成就抛，
    // 盒子回原引擎 —— 不像 S3c 的 forge 那样「垫不上就退回文字垫底」。
    const rebuild = (rotating && sdkOptions.rebuild && typeof sdkOptions.rebuild === 'object') ? sdkOptions.rebuild : null;
    const strict = Boolean(rebuild && rebuild.strict);
    if (strict) {
      const g = codexVersionGuard({ codexPath, env });
      if (!g.ok) throw new Error(`codex 版本闸没过：${g.reason}`);
      console.log(`[engine/codex] 版本闸过了（${g.reason}）`);
    }
    await driver.ensure();
    let from = '';
    if (rotating) {
      from = threadId;
      await driver.startThread();
      console.log(`[engine/codex] 换舱：离开 thread=${from ? from.slice(0, 13) : '(没有)'}，新 thread=${driver.threadId.slice(0, 13)}`);
    } else {
      // 有旧的就只续，续不上（或者本来就没有）才开新的 —— 起进程不再白开一条空 thread（S3c）
      const resumed = threadId ? await driver.resumeThread(threadId) : false;
      if (resumed) { freshThread = false; seeded = true; }   // 续上了，不用垫冷层
      else await driver.startThread();
    }
    if (rebuild && Array.isArray(rebuild.tail)) {
      const items = rebuild.tail.filter((t) => t && String(t.text || '').trim());
      if (!items.length) {
        lastRebuild = { injected: 0, verified: true, reason: '没有可垫的历史' };
        seeded = true;
      } else {
        const r = await rebuildCodexThread({ driver, tail: items, log: (m) => console.error(m) });
        if (strict && !(r.ok && r.verified)) throw new Error(`往新 thread 里垫历史没成：${r.reason || '回读没对上'}`);
        if (r.ok) seeded = true;
        lastRebuild = { injected: r.injected || 0, verified: Boolean(r.verified), reason: r.reason || '' };
        console.log(`[engine/codex] 换引擎重建：垫了 ${lastRebuild.injected} 条${lastRebuild.verified ? '，rollout 回读一致' : ''}`);
      }
    } else if (freshThread && !seeded) await maybeForge();
    if (driver.threadId) threadId = driver.threadId;
    if (rotating) {
      rotatedFor = token; rotatedAt = new Date().toISOString();
      if (from && from !== threadId) previousThreadId = from;
      logRotation({ at: rotatedAt, from, to: threadId, token });
    }
    running = true;
    initialized = true;
    for (const row of ingress.list('pending', scope)) {
      if (row.payload?.brain === 'codex') owned.add(row.uuid);
    }
    // forge 垫完才落盘：垫到一半进程没了，这张单还算没用过，下次重新换一遍（多一条孤儿 thread，不丢历史）
    try { saveThread(); } catch (error) { console.error('[engine/codex] threadId 写不进去：', error.message); }
    console.log(`[engine/codex] 就绪 model=${model} thread=${threadId.slice(0, 13)}`);
    void pump();
  }

  function enqueue({ message, origin, uuid } = {}) {
    if (disposed) throw refuse('运行时已经关了。');
    if (!running || stopping) throw refuse('现在没有活着的 codex 插头 —— 先 ensure。');
    if (message?.type !== 'user' || message.message?.role !== 'user' || message.message?.content == null) {
      throw refuse('请提供会触发回复的 user 消息。');
    }
    const turnInput = extractTurnInput(message, imageDir);
    if (!turnInput.length) throw refuse('这轮没有可送的正文或图片。');
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
    try { await driver.interrupt(); } catch { /* 没在跑 */ }
    if (pumpPromise) await pumpPromise.catch(() => {});
    running = false;
    if (!settled) { settled = true; doneResolve(); }
  }

  async function close() {
    try { await stop(); }
    finally {
      disposed = true;
      try { await driver.close(); } catch { /* 已停 */ }
      try { ingress.close(); } catch { /* 已关 */ }
    }
  }

  return {
    enqueue, start, stop, close,
    get done() { return done; },
    get: (uuid) => ingress.get(uuid),
    list: (state) => ingress.list(state),
    status: () => ({ running, stopping, initialized, requestedModel: model, actualModel, sessionId: threadId,
      compactions: typeof driver.compactions === 'function' ? driver.compactions() : 0,
      ...(lastRebuild ? { rebuilt: lastRebuild } : {}) }),
    /** /usage：问活着的 app-server 现在的额度。 */
    usage: () => codexUsage({ driver }),
    /**
     * 同一家内热切（/model，S5）：下一轮的 turn/start 带上新名字（app-server「本轮及之后」）。
     * 别家的名字拒绝 —— /model 只管同一家，跨厂商是 /engine（换舱）。
     */
    async setModel(m) {
      const next = stripContextSuffix(m || '');
      if (!next) throw new Error('要给模型名');
      if (/^(claude|deepseek|anthropic)/i.test(next)) throw new Error(`codex 插头不认「${next}」—— 跨厂商用 /engine`);
      if (typeof driver.setModel !== 'function') throw new Error('这个 codex 驱动不支持热切模型');
      driver.setModel(next);
      model = next; actualModel = next;
    },
  };
}

module.exports = { createCodexRuntime, extractTurnInput, mapUsage, assertSubscription, codexVersionGuard };
