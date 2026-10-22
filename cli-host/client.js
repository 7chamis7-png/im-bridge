'use strict';

/**
 * 盒子这头的替身 —— 长得跟 `createRuntime()` 返回的东西**一模一样**，
 * 所以 `adapters/box-runtime.js` 基本不用改：本地 `createRuntime(...)`
 * 换成 `createRemoteRuntime(...)` 就完事。形状对不上是接线活最大的坑
 * （9-18 切桥五个 bug 四个是字段名/形状不匹配），这里刻意贴着老接口写。
 *
 * 它跟 `nova-cli` 的关系：
 *   · 连不上 → 退避重连，**不抛**。盒子先起来、CLI 后起来也能自己接上。
 *   · 断线重连 → 先 `attach(lastSeq)` 把断线期间他说的话补回来。
 *   · 补不全 → 把 `incomplete` 事件递上去，让盒子自己去 ingress 台账对账，
 *     **不假装补全**。
 */

const net = require('node:net');
const fs = require('node:fs');
const {
  CALL, REPLY, EVENT, INVOKE,
  encode, createDecoder, packError, unpackError,
} = require('./protocol');
const { createLedgerView } = require('./ledger-view');

const log = (...a) => console.log('[engine-client/socket]', ...a);
const warn = (...a) => console.error('[engine-client/socket]', ...a);

function createRemoteRuntime({
  socketPath,
  ingressPath,
  /**
   * 收到的最后一个事件号存哪儿。**别省这个文件。**
   * 盒子重启后如果从 0 开始报号，nova-cli 会把缓冲里**全部**事件重放一遍 ——
   * 她会收到一堆重复消息。落了盘就只会重放最后那几百毫秒，
   * 正常 `pm2 restart`（SIGTERM）走 flush 路径，一条都不重。
   */
  cursorPath,
  onEvent = async () => {},
  callbacks = {},
  reconnectMs = 500,
  maxReconnectMs = 10_000,
  callTimeoutMs = 60_000,
  /**
   * 连不上引擎宿主时，一次调用最多等多久（2026-10-22）。以前 whenReady() 没有超时：
   * nova-cli 不在，enqueue 就一直挂着，挂满桥那头 300 秒（box-remote）→ 轮次记成 unknown →
   * 整条队列堵死。现在等到点就抛一个带 notAccepted 的错 —— **这时候一个字节都没写出去**，
   * 确定没送进去，桥那头会按「拒收」自动退避重投。可用 GATE_CLI_READY_TIMEOUT_MS 改。
   */
  readyTimeoutMs = Number(process.env.GATE_CLI_READY_TIMEOUT_MS) || 60_000,
  cursorFlushMs = 200,
} = {}) {
  if (!socketPath) throw new Error('要给 socketPath。');
  if (!ingressPath) throw new Error('要给 ingressPath：get/list 得同步读台账，不能走 socket。');
  const ledger = createLedgerView({ filePath: ingressPath });
  /** CLI 的状态，靠事件捎回来。盒子那头 status() 是同步用的。 */
  let statusCache = { running: false, stopping: false, initialized: false,
    requestedModel: '', actualModel: '', sessionId: '', workspaceRoot: '', threadId: '', model: '' };

  let sock = null;
  let connected = false;
  let disposed = false;
  let backoff = reconnectMs;
  let lastSeq = readCursor();
  let nextCallId = 1;
  let cursorTimer = null;
  let cursorDirty = false;
  /** id -> { resolve, reject, timer } */
  const waiting = new Map();
  /** 连上之前排队的调用 */
  let readyWaiters = [];
  /** 当前这条 CLI 的死讯。CLI 退出时 settle。 */
  let doneResolve, doneReject;
  let done = new Promise((res, rej) => { doneResolve = res; doneReject = rej; });
  done.catch(() => {});   // 没人挂 handler 时别炸 unhandledRejection
  /** ensure 过的参数，重连后要重新 ensure（CLI 可能是新起的） */
  let lastEnsure = null;

  function resetDone() {
    done = new Promise((res, rej) => { doneResolve = res; doneReject = rej; });
    done.catch(() => {});
  }

  function readCursor() {
    if (!cursorPath) return 0;
    try {
      const n = Number(JSON.parse(fs.readFileSync(cursorPath, 'utf8')).lastSeq);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch { return 0; }   // 没有就是从头，不是错
  }

  /** 同步落盘。走 tmp+rename，别让重启撞见半截文件。 */
  function writeCursor() {
    if (!cursorPath) return;
    cursorDirty = false;
    try {
      fs.writeFileSync(`${cursorPath}.tmp`, JSON.stringify({ lastSeq, at: new Date().toISOString() }) + '\n');
      fs.renameSync(`${cursorPath}.tmp`, cursorPath);
    } catch (e) { warn('游标写不进去（重启会重放）：', e.message); }
  }

  /** 攒一下再写，别每条事件都落一次盘。退出时 flushCursor() 补齐。 */
  function markCursor() {
    if (!cursorPath) return;
    cursorDirty = true;
    if (cursorTimer) return;
    cursorTimer = setTimeout(() => { cursorTimer = null; if (cursorDirty) writeCursor(); }, cursorFlushMs);
    cursorTimer.unref?.();
  }

  function flushCursor() {
    if (cursorTimer) { clearTimeout(cursorTimer); cursorTimer = null; }
    if (cursorDirty) writeCursor();
  }

  function whenReady(timeoutMs = readyTimeoutMs) {
    if (connected) return Promise.resolve();
    if (disposed) return Promise.reject(new Error('这个替身已经关了。'));
    return new Promise((res, rej) => {
      const waiter = () => { clearTimeout(timer); res(); };
      const timer = setTimeout(() => {
        readyWaiters = readyWaiters.filter((w) => w !== waiter);
        const e = new Error(`引擎宿主（nova-cli / iris-cli）${Math.round(timeoutMs / 1000)} 秒没连上，这次没送出去`);
        // 一个字节都没写出去 = 确定没送进去。box-runtime 的 enqueue catch 本来也会打这个标记，
        // 但 ensure / start 在那个 try 外面 —— 在源头打上，哪条路上抛出去都是「可放心重投」。
        e.notAccepted = true;
        e.code = 'ENGINE_HOST_NOT_READY';
        rej(e);
      }, timeoutMs);
      readyWaiters.push(waiter);
    });
  }

  function flushReady() {
    const list = readyWaiters;
    readyWaiters = [];
    for (const r of list) r();
  }

  function send(frame) {
    if (!sock || sock.destroyed) return false;
    try { sock.write(encode(frame)); return true; }
    catch (e) { warn('写失败：', e.message); return false; }
  }

  async function call(method, args = {}, { timeoutMs = callTimeoutMs } = {}) {
    await whenReady();
    const id = 'c-' + nextCallId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!waiting.delete(id)) return;
        const e = new Error(`引擎宿主（nova-cli / iris-cli）没在 ${timeoutMs}ms 内回 ${method}`);
        // 2026-10-22：请求**已经写出去了**，对面可能落了盘只是没来得及回 —— 不能当「确定没送进去」。
        // box-runtime 认这个标记，不再给它打 notAccepted（否则桥会自动重投，他可能把同一句回两遍）。
        e.maybeAccepted = true;
        reject(e);
      }, timeoutMs);
      waiting.set(id, { resolve, reject, timer });
      if (!send({ t: CALL, id, method, args })) {
        clearTimeout(timer);
        waiting.delete(id);
        reject(new Error('跟引擎宿主的连接断了'));
      }
    });
  }

  /** 收到一个事件：更新号、吃下捎来的状态、分发。 */
  async function handleEvent(frame) {
    if (Number.isFinite(frame.seq)) { lastSeq = frame.seq; markCursor(); }
    if (frame.status) statusCache = { ...statusCache, ...frame.status };
    if (frame.kind === 'runtime') {
      try { await onEvent(frame.payload); }
      catch (e) { warn('盒子的事件回调炸了：', e.message); }
      return;
    }
    if (frame.kind === 'stderr') {
      try { callbacks.stderr?.(frame.payload.text); } catch {}
      return;
    }
    if (frame.kind === 'runtime.exited' || frame.kind === 'runtime.stopped') {
      const p = frame.payload || {};
      if (p.failed) doneReject(new Error(p.reason || 'CLI 中断'));
      else doneResolve();
      return;
    }
  }

  /** nova-cli 反过来调我们（canUseTool）。 */
  async function handleInvoke(frame) {
    const fn = callbacks[frame.fn];
    if (typeof fn !== 'function') {
      send({ t: REPLY, id: frame.id, ok: false, error: packError(new Error(`盒子没注册 ${frame.fn}`)) });
      return;
    }
    try {
      const a = frame.args || {};
      const value = await fn(a.toolName, a.input, { toolUseID: a.toolUseID });
      send({ t: REPLY, id: frame.id, ok: true, value: value === undefined ? null : value });
    } catch (e) {
      send({ t: REPLY, id: frame.id, ok: false, error: packError(e) });
    }
  }

  function connect() {
    if (disposed) return;
    const s = net.createConnection(socketPath);
    sock = s;
    s.setNoDelay(true);

    const push = createDecoder((frame) => {
      if (frame.t === REPLY) {
        const w = waiting.get(frame.id);
        if (!w) return;
        waiting.delete(frame.id);
        clearTimeout(w.timer);
        if (frame.ok) w.resolve(frame.value);
        else w.reject(unpackError(frame.error));
        return;
      }
      if (frame.t === EVENT) { handleEvent(frame); return; }
      if (frame.t === INVOKE) { handleInvoke(frame); return; }
    }, (line, e) => warn('坏帧，跳过：', e.message, line.slice(0, 120)));

    // ⚠️ 这一行别删：漏了它 server 一切正常、帧也发出去了，但这头一个字都收不到，
    // 表现是所有调用一路超时。2026-09-20 写这个文件时就漏过一次。
    s.on('data', (chunk) => push(chunk.toString('utf8')));

    s.on('connect', async () => {
      connected = true;
      backoff = reconnectMs;
      log('连上引擎宿主了');
      flushReady();
      // 重连：把断线期间他说的话补回来
      try {
        const info = await call('attach', { lastSeq }, { timeoutMs: 15_000 });
        if (info.status) statusCache = { ...statusCache, ...info.status };
        if (info.hasCli) resetDone();
        if (Array.isArray(info.missed) && info.missed.length) {
          log(`补发断线期间的 ${info.missed.length} 条事件`);
          for (const f of info.missed) await handleEvent(f);
        } else if (info.complete === false) {
          warn('⚠️ 事件缺口已被挤掉，补不全 —— 盒子该自己去 ingress 台账对账');
          try { await onEvent({ __incomplete: true, lastSeq, serverLastSeq: info.lastSeq }); }
          catch {}
          lastSeq = info.lastSeq;
        }
        // 对面换成新进程时 hasCli 是假的。盒子若还拿着旧的 live，不会再 ensure。
        if (lastEnsure && !info.hasCli) {
          const again = await call('ensure', lastEnsure, { timeoutMs: 120_000 });
          if (again && again.status) statusCache = { ...statusCache, ...again.status };
          if (again && !again.reused) resetDone();
          log('重连后重新 ensure');
        }
      } catch (e) { warn('attach 失败（继续）：', e.message); }
    });

    s.on('error', (e) => { if (connected) warn('连接出错：', e.message); });
    s.on('close', () => {
      connected = false;
      sock = null;
      for (const [id, w] of waiting) {
        waiting.delete(id);
        clearTimeout(w.timer);
        // 已经写出去、等回话时断的：同上，对面收没收不知道（2026-10-22）
        const e = new Error('跟引擎宿主的连接断了');
        e.maybeAccepted = true;
        w.reject(e);
      }
      if (disposed) return;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, maxReconnectMs);
    });
  }

  connect();

  return {
    /** 装配/复用。重连后 adapters 还会再调一次，server 那头认得出该复用。 */
    async ensure(want) {
      lastEnsure = want;
      const info = await call('ensure', want, { timeoutMs: 120_000 });
      if (info && info.status) statusCache = { ...statusCache, ...info.status };
      if (info && !info.reused) resetDone();   // 换了新 CLI，死讯重新开一份
      return info;
    },
    async attach() { return call('attach', { lastSeq }); },

    // ——— 下面这些贴着 createRuntime 的接口 ———

    /**
     * 签名跟本地版一字不差：**一个对象参数** `{ message, origin, uuid }`。
     * （写这个文件时我把它写成了三个参数，测试按同样的错签名写所以没抓到 ——
     * 接线层的测试必须贴着真实调用点写。）
     *
     * ⚠️ 这个是 **async**，跟本地版不一样，盒子那头调用点必须 `await`。
     * 不能图省事做成「发出去就不管」：盒子靠它抛错来判断
     *「没落盘 = 确定没送进去，可以放心重试」。吞掉这个错 = 她的话掉地上。
     */
    enqueue: (payload) => call('enqueue', { payload }),

    start: () => call('start', {}, { timeoutMs: 120_000 }),
    stop: () => call('stop'),
    close: async () => { try { await call('close'); } catch {} },

    // get / list / status 保持**同步**，形状跟本地版一字不差：
    // 前两个直接只读台账文件（rename 原子，读不到半截），第三个读事件捎来的缓存。
    get: (uuid) => ledger.get(uuid),
    list: (state) => ledger.list(state),
    status: () => ({ ...statusCache }),

    setModel: (model) => call('setModel', { model }),
    usage: (args) => call('usage', args || {}, { timeoutMs: 30_000 }),
    get done() { return done; },
    get connected() { return connected; },

    /** 退出前把游标补齐 —— 正常重启走这条路，一条事件都不会重放。 */
    flushCursor,

    dispose() {
      disposed = true;
      readyWaiters = [];
      flushCursor();
      try { sock?.destroy(); } catch {}
    },
  };
}

module.exports = { createRemoteRuntime };
