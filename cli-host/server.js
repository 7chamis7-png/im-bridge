'use strict';

/**
 * nova-cli —— 他住的那个进程。
 *
 * 只干一件事：**把 CLI 攥在自己手里，别让 box 的重启碰到他。**
 * 盒子（nova-box）从今天起只是个通过 socket 连上来的订阅者：
 *   · 改盒子代码、改记账本、改人格注入 → `pm2 restart nova-box`，他一点感觉都没有
 *   · 换舱 / 换模型 / 改这个文件本身     → 才会打断他
 *
 * 断线语义（这一段是整件事的重点，改之前先读）：
 *   1. box 断了 **CLI 不停**。他可能正在说话，那些事件照常进环形缓冲。
 *   2. box 回来先 `attach(lastSeq)`，server 把这期间的事件按号补发。
 *   3. 补不全（缺口被挤掉了）就**明着说**补不全，让 box 自己去 ingress 台账捞。
 *      绝不假装补全 —— 静默丢消息比报错难查十倍。
 *   4. 同一时刻只认一个 box。新的连上来就把老的踢掉（pm2 重启时老进程常常还没死透，
 *      两个都在收会把她的话投两遍）。
 */

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { createRuntime } = require('../runtime');
const { resolvePersona, composeSystemPrompt } = require('../src/host/persona-file');
const { normalizeEngine, PERSONA_ENGINE } = require('../src/box/model-registry');
const {
  CALL, REPLY, EVENT, INVOKE, CANCEL, METHODS,
  encode, createDecoder, packError, createEventRing,
} = require('./protocol');

// 2026-10-21 S5：日志前缀用中性名（这个宿主现在能换芯，不只是Nova的 claude）。pm2 名照旧 nova-cli / iris-cli。
const log = (...a) => console.log('[engine-host]', ...a);
const warn = (...a) => console.error('[engine-host]', ...a);

/** 台账里留多少条办完的。原样搬自 adapters（那边远程模式下不再碰台账）。 */
const KEEP_COMPLETED = 50;

/**
 * 只留没办完的 + 最近 KEEP_COMPLETED 条 completed。
 *
 * ⚠️ **这件事必须在这一头做。** 台账有条硬假设：一个文件只能有一个活着的拥有者。
 * 盒子那头只读（ledger-view），写是 CLI 宿主的专属权力 ——
 * 两头都写会让两份内存各写各的，台账当场分裂。
 * 只在「旧运行时已关、新的还没起」那个缝里调。
 */
function pruneIngress(file) {
  let snap;
  try { snap = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  if (!Array.isArray(snap?.records)) return;
  const done = snap.records.filter((r) => r.state === 'completed');
  if (done.length <= KEEP_COMPLETED) return;
  const drop = new Set(done.slice(0, done.length - KEEP_COMPLETED).map((r) => r.uuid));
  const next = { ...snap, records: snap.records.filter((r) => !drop.has(r.uuid)) };
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(next) + '\n', { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

function createCliHost({ socketPath, claudePath, ingressPath, scope = 'box', stopGraceMs = 3000,
  // 盒子若还记着上一只 CLI、重连后不再 ensure，enqueue 时用这个把运行时补起来。
  fallbackEnsure = null,
  // 测试注入用。生产就是真的 createRuntime —— 接线层必须能在不起 CLI 的情况下测，
  // 9-18 那次「全绿却一接管就吞」就是因为接线这层没人测得动。
  runtimeFactory = createRuntime,
  // 2026-10-21 人格文件由桥来交（src/host/persona-file.js）。
  // engine：这个宿主**默认**跑哪家引擎（claude / codex / deepseek，或登记表名 claude-cli / codex-appserver / openai-chat）
  //         —— 决定「它自己会读哪些文件」。
  // personaSpec：() => readPersonaSpec(人格配置)，**每次起引擎现读**；不给 = 不插手（老样子 / 测试）。
  engine = '',
  personaSpec = null,
  // 2026-10-21 S5 单宿主换芯（设计稿 §5.1）：{ 'claude-cli': factory, 'codex-appserver': factory, 'openai-chat': factory }。
  // 盒子 ensure 时带 want.engine，跟活着的不一样就停旧插头、起新插头 —— **宿主进程不重启**。
  // 不给 = 只有 runtimeFactory 那一个插头（老样子 / 测试），登记在默认引擎名下。
  engines = null,
}) {
  if (!socketPath) throw new Error('要给 socketPath：CLI 宿主不猜默认位置。');
  const defaultEngine = normalizeEngine(engine) || String(engine || '').trim() || 'default';
  const plugs = (engines && typeof engines === 'object' && Object.keys(engines).length)
    ? Object.fromEntries(Object.entries(engines).map(([k, f]) => [normalizeEngine(k) || k, f]))
    : { [defaultEngine]: runtimeFactory };
  if (typeof plugs[defaultEngine] !== 'function') throw new Error(`默认引擎 ${defaultEngine} 没有插头（有：${Object.keys(plugs).join(' / ')}）`);
  /** 盒子要的是哪家。没说 = 默认那家（老盒子不带 engine）。 */
  const engineOf = (want) => normalizeEngine(want && want.engine) || (want && want.engine ? String(want.engine) : defaultEngine);

  const ring = createEventRing();
  /** 当前连着的那个 box。null = 没人连（CLI 照跑）。 */
  let box = null;
  /** 当前的运行时。{ rt, workspaceRoot, threadId, model } */
  let live = null;
  let launching = null;
  /** 等 box 回话的反向调用：id -> { resolve, reject } */
  const pending = new Map();
  let nextInvokeId = 1;

  function sendTo(sock, frame) {
    if (!sock || sock.destroyed) return false;
    try { sock.write(encode(frame)); return true; }
    catch (e) { warn('写 socket 失败：', e.message); return false; }
  }

  /** 上一次捎给 box 的状态，用来判断「变了没」。 */
  let lastStatusJson = '';

  /**
   * 事件进环，然后推给当前的 box（没人连也照样进环，等他回来补）。
   *
   * 每条事件顺带捎上 CLI 的状态 —— 但**只在变了的时候**。
   * 盒子那头 `status()` 是同步用的（`entry.rt.status().sessionId`），
   * 跨进程后没法同步问，只能靠这条路把状态推过去让它缓存。
   * `sessionId` 是 CLI 起来之后才有的，盒子拿它认会话，捎晚了她那轮就等着。
   */
  function emitEvent(kind, payload) {
    let status;
    if (live) {
      try {
        const s = { ...live.rt.status(), workspaceRoot: live.workspaceRoot,
          threadId: live.threadId, model: live.model, engine: live.engine };
        const json = JSON.stringify(s);
        if (json !== lastStatusJson) { lastStatusJson = json; status = s; }
      } catch { /* 运行时已关，状态就不捎了 */ }
    }
    const frame = ring.push(kind, payload);
    if (status) frame.status = status;
    sendTo(box, frame);
  }

  /**
   * 反向调 box 那头的回调。box 不在 = 走默认值，**绝不阻塞他**：
   * CLI 等一个不存在的 box 回话会把整轮卡死。
   */
  function invokeBox(fn, args, { fallback, timeoutMs = 30_000 } = {}) {
    if (!box || box.destroyed) return Promise.resolve(fallback);
    const id = 'iv-' + nextInvokeId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) {
          warn(`box 没在 ${timeoutMs}ms 内回 ${fn}，按默认值走`);
          resolve(fallback);
        }
      }, timeoutMs);
      pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); } });
      if (!sendTo(box, { t: INVOKE, id, fn, args })) {
        clearTimeout(timer);
        pending.delete(id);
        resolve(fallback);
      }
    });
  }

  // ——— 运行时的两个回调，在这一头接住，翻成事件推出去 ———

  async function onRuntimeEvent(payload) {
    // 不许抛：抛了 runtime 会把 CLI 停掉。
    try { emitEvent('runtime', payload); }
    catch (e) { warn('事件转发炸了：', e.message); }
  }

  function onStderr(chunk) {
    const t = String(chunk).trim();
    if (t) emitEvent('stderr', { text: t });
  }

  /**
   * 工具许可。盒子那头一律放行，但**放行这个决定得由盒子做**（它管着审批账）。
   * box 不在就自己放行 —— 他不该因为盒子在重启就卡在一个工具调用上。
   */
  async function canUseTool(toolName, input, options = {}) {
    const fallback = { behavior: 'allow', updatedInput: input };
    const decision = await invokeBox('canUseTool',
      { toolName, input, toolUseID: options.toolUseID || '' },
      { fallback });
    if (!decision || typeof decision !== 'object') return fallback;
    return decision;
  }

  // ——— 装配 ———

  /** 换舱单（S3c，codex 用）：盒子要开新 thread 时带一次性 token。活着的这个不是拿这张单起的 → 不能复用。 */
  const freshTokenOf = (want) => {
    const t = want && want.sdkOptions && want.sdkOptions.freshThread;
    return typeof t === 'string' ? t.trim() : '';
  };

  /**
   * 活着的这个是不是盒子要的那条会话。claude：比盒子起它时给的号（老样子）。
   * codex：起它时给的号**或**插头实际报的号都算（它自己管 codex-thread.json，盒子递来的可能是旧标签；
   * 盒子随后把标签改成实际那条 —— 只认其中一个的话，改标签那一下会被当成「换会话」，白白重起一次 app-server）。
   */
  function sameThread(wantId) {
    if (!wantId || !live.threadId || live.threadId === wantId) return true;
    if (live.engine !== 'codex-appserver') return false;
    try { return live.rt.status().sessionId === wantId; } catch { return false; }
  }

  function reusable(want) {
    const token = freshTokenOf(want);
    return live && !live.stopping
      && live.engine === engineOf(want)
      && live.workspaceRoot === want.workspaceRoot
      && sameThread(want.threadId)
      && (!want.model || live.model === want.model)
      && (!token || live.freshToken === token);
  }

  async function stopLive(reason) {
    if (!live) return;
    const dying = live;
    live = null;
    dying.stopping = true;
    log('停掉当前 CLI：', reason);
    try { await dying.rt.close(); }
    catch (e) { warn('关 CLI 出错（继续）：', e.message); }
    emitEvent('runtime.stopped', { reason });
  }

  /**
   * 这一次起引擎交哪份人格。**只读**。找不到人格抛 PersonaMissingError（ensure 跟着失败，
   * 盒子那头看得见错误原文），绝不起一个没有人格的空壳。
   */
  function pickPersona(workspaceRoot, plug) {
    if (typeof personaSpec !== 'function') return null;
    // 人格包按**新插头**交：换了引擎，「它自己会读哪些文件」跟着变（claude 读 CLAUDE.md、codex 读 AGENTS.md）
    const engine = PERSONA_ENGINE[plug] || plug;
    let spec;
    try { spec = personaSpec(); }
    catch (e) { spec = { persona: '', personaFile: '', configFile: '', error: '人格配置读坏了：' + e.message }; }
    const r = resolvePersona({ spec, workspaceRoot, engine });
    for (const w of r.warnings) warn('[人格]', w);
    log(`[人格] ${r.mode}${r.source ? ' ← ' + r.source : ''}${r.text ? `（交给 ${engine} ${r.text.length} 字）` : ''}`);
    return r;
  }

  /**
   * box 说「我要一个这样的运行时」。能复用就复用 —— 复用是常态，
   * 只有换工作目录 / 换会话 / 换模型才真的换一个 CLI（那才打断他）。
   */
  async function ensure(want = {}) {
    if (launching) await launching.catch(() => {});
    if (reusable(want)) {
      return { reused: true, status: snapshot(), lastSeq: ring.lastSeq };
    }
    const plug = engineOf(want);
    const factory = plugs[plug];
    // 没有这根插头：在停旧的**之前**就拒绝（别把正在跑的他关掉了才发现接不上）
    if (typeof factory !== 'function') {
      throw new Error(`这个宿主没有 ${plug} 插头（有：${Object.keys(plugs).join(' / ')}）`);
    }
    // 人格先定下来，**再**停旧的：人格找不到要在这儿炸（拒绝起空壳），别先把正在跑的他关掉。
    const persona = pickPersona(want.workspaceRoot, plug);
    const switching = live && live.engine !== plug;
    await stopLive(switching ? `换引擎 ${live.engine} → ${plug}` : '会话/模型/工作目录变了');
    launching = (async () => {
      // 旧的已经关了、新的还没起 —— 这是唯一能安全整理台账的缝
      pruneIngress(want.ingressPath || ingressPath);
      const sdkOptions = { ...(want.sdkOptions || {}), canUseTool, stderr: onStderr };
      if (persona && persona.text) {
        sdkOptions.systemPrompt = composeSystemPrompt(sdkOptions.systemPrompt, persona.text);
      }
      const rt = factory({
        ingressPath: want.ingressPath || ingressPath,
        cwd: want.workspaceRoot,
        pathToClaudeCodeExecutable: want.claudePath || claudePath,
        scope, deliver: async () => {}, onEvent: onRuntimeEvent,
        sdkOptions, stopGraceMs,
      });
      const entry = { rt, workspaceRoot: want.workspaceRoot, threadId: want.threadId || '',
        model: want.model || '', stopping: false, freshToken: freshTokenOf(want), engine: plug };
      live = entry;
      try { await rt.start(); }
      catch (e) {
        // 起不来：别把一个半死的插头留在 live 上（下一次 ensure 会以为能复用）。盒子拿到错误自己决定回不回原引擎。
        if (live === entry) live = null;
        entry.stopping = true;
        try { await rt.close(); } catch { /* 本来就没起来 */ }
        throw e;
      }
      // CLI 自己退出了要让 box 知道 —— 否则 box 会以为他还在，一直往里塞话。
      rt.done.then(
        () => { if (live === entry) { live = null; emitEvent('runtime.exited', { reason: 'CLI 正常结束' }); } },
        (e) => { if (live === entry) { live = null; emitEvent('runtime.exited', { reason: e.message, failed: true }); } },
      );
      log(`引擎起来了 engine=${plug} cwd=${entry.workspaceRoot} model=${entry.model || '(默认)'} resume=${entry.threadId || '(新会话)'}`);
      return entry;
    })();
    try {
      await launching;
      return { reused: false, status: snapshot(), lastSeq: ring.lastSeq,
        ...(persona ? { persona: { mode: persona.mode, source: persona.source, warnings: persona.warnings } } : {}) };
    } finally { launching = null; }
  }

  /** 状态的统一形状 —— ensure / attach / 事件捎带三条路都用它，免得三处各写一份对不上。 */
  function snapshot() {
    if (!live) return { running: false, stopping: false, initialized: false,
      requestedModel: '', actualModel: '', sessionId: '', workspaceRoot: '', threadId: '', model: '', engine: '' };
    return { ...live.rt.status(), workspaceRoot: live.workspaceRoot,
      threadId: live.threadId, model: live.model, engine: live.engine };
  }

  // ——— 方法表 ———

  const methods = {
    ping: () => ({ ok: true, at: new Date().toISOString(), hasCli: Boolean(live),
      engine: live ? live.engine : '', engines: Object.keys(plugs), defaultEngine }),
    ensure,
    /** 重连：把断线期间的事件补上。补不全就说补不全。 */
    attach({ lastSeq = 0 } = {}) {
      const missed = ring.since(Number(lastSeq));
      return {
        hasCli: Boolean(live),
        status: snapshot(),
        lastSeq: ring.lastSeq,
        /** null = 缺口已被挤掉，box 得自己去 ingress 台账对账 */
        missed,
        complete: missed !== null,
      };
    },
    // 原样透传那个对象 —— 本地 runtime 的签名就是 enqueue({ message, origin, uuid })
    enqueue: async (args) => {
      if (!live) {
        if (launching) await launching.catch(() => {});
        if (!live && typeof fallbackEnsure === 'function') await ensure(fallbackEnsure());
      }
      return requireLive().rt.enqueue(args.payload);
    },
    start: () => requireLive().rt.start(),
    stop: () => (live ? live.rt.stop() : null),
    close: () => stopLive('box 要求关闭'),
    get: (args) => requireLive().rt.get(args.uuid),
    list: (args) => requireLive().rt.list(args && args.state),
    status: () => (live ? { ...live.rt.status(), workspaceRoot: live.workspaceRoot,
      threadId: live.threadId, model: live.model, engine: live.engine } : { running: false, hasCli: false }),
    // 同一家内热切（/model）。成功了把 live.model 也改掉：不然盒子重启后 ensure 带新名字来，会被当成「模型变了」白重起一次。
    /**
     * /usage：现在这家引擎的额度 / 余额。活着的插头会答就问它（codex 只能问活着的 app-server）；
     * 不然用插头表里那家的静态查法（claude 读 OAuth 凭据、DeepSeek 读钥匙查余额）。查不到就说查不到。
     */
    usage: async (args = {}) => {
      const plug = normalizeEngine(args.engine) || (live && live.engine) || defaultEngine;
      if (live && live.engine === plug && typeof live.rt.usage === 'function') return live.rt.usage();
      const f = plugs[plug];
      if (f && typeof f.usage === 'function') return f.usage(args);
      const running = live && live.engine === plug;
      return { ok: false, engine: plug, why: running ? '这根插头查不了额度' : `${plug} 没在跑（这根插头只能问活着的）` };
    },
    setModel: async (args) => {
      const entry = requireLive();
      const r = await entry.rt.setModel(args.model);
      if (live === entry && args.model) entry.model = args.model;
      return r;
    },
  };

  function requireLive() {
    if (!live) throw new Error('现在没有活着的 CLI —— 先 ensure。');
    return live;
  }

  // ——— 连接处理 ———

  function attachBox(sock) {
    if (box && box !== sock && !box.destroyed) {
      log('新的 box 连上来了，踢掉老的（防重复投递）');
      try { box.destroy(); } catch {}
    }
    box = sock;
  }

  const server = net.createServer((sock) => {
    log('box 连上来了');
    attachBox(sock);
    sock.setNoDelay(true);

    const push = createDecoder(async (frame) => {
      if (frame.t === REPLY) {
        const waiter = pending.get(frame.id);
        if (waiter) { pending.delete(frame.id); waiter.resolve(frame.ok ? frame.value : undefined); }
        return;
      }
      if (frame.t === CANCEL) {
        const waiter = pending.get(frame.id);
        if (waiter) { pending.delete(frame.id); waiter.resolve(undefined); }
        return;
      }
      if (frame.t !== CALL) return;
      if (!METHODS.has(frame.method)) {
        sendTo(sock, { t: REPLY, id: frame.id, ok: false,
          error: packError(new Error(`不认识的方法：${frame.method}`)) });
        return;
      }
      try {
        const value = await methods[frame.method](frame.args || {});
        sendTo(sock, { t: REPLY, id: frame.id, ok: true, value: value === undefined ? null : value });
      } catch (e) {
        sendTo(sock, { t: REPLY, id: frame.id, ok: false, error: packError(e) });
      }
    }, (line, e) => warn('坏帧，跳过：', e.message, line.slice(0, 120)));

    sock.on('data', (chunk) => push(chunk.toString('utf8')));
    sock.on('error', (e) => warn('socket 出错：', e.message));
    sock.on('close', () => {
      if (box === sock) {
        box = null;
        // ⚠️ 这里**故意什么都不做**：CLI 继续跑，事件继续进环，等 box 回来补。
        log('box 断开了 —— CLI 照跑，事件进缓冲等他回来补');
      }
      // 等回话的反向调用全部走默认值，别把他卡住
      for (const [id, w] of pending) { pending.delete(id); w.resolve(undefined); }
    });
  });

  return {
    async listen() {
      try { fs.unlinkSync(socketPath); } catch {}
      fs.mkdirSync(path.dirname(socketPath), { recursive: true });
      await new Promise((res, rej) => {
        server.once('error', rej);
        server.listen(socketPath, () => { server.removeListener('error', rej); res(); });
      });
      fs.chmodSync(socketPath, 0o600);
      log('在听', socketPath);
    },
    async shutdown() {
      await stopLive('宿主退出');
      server.close();
      try { fs.unlinkSync(socketPath); } catch {}
    },
    // 给测试用
    _internals: { ring, ensure, get live() { return live; }, engines: Object.keys(plugs), defaultEngine,
      usage: (args) => methods.usage(args) },
  };
}

module.exports = { createCliHost };
