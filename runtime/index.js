'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { createClaim } = require('./claim');
const { createIngress } = require('./ingress');
const { decode } = require('./decode');

// 下文 A-1～G-1 均指向 docs/runtime-rules.md；新增边界见 docs/runtime-arch.md。
// E-1：180 秒是外层快照重建时限。本层不给模型/工具轮次套超时，只有主动 stop 的终止宽限。

function absolute(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error(`请配置 ${name} 的绝对路径，运行时不能猜默认位置。`);
  }
  return value;
}

function inputQueue() {
  const values = [];
  let waiter;
  let ended = false;
  return {
    push(value) {
      if (ended) throw new Error('CLI 输入已关闭，消息不能继续写出。');
      if (waiter) { const resolve = waiter; waiter = undefined; resolve({ value, done: false }); }
      else values.push(value);
    },
    end() {
      ended = true;
      values.length = 0;
      if (waiter) { waiter({ done: true }); waiter = undefined; }
    },
    [Symbol.asyncIterator]() { return this; },
    next() {
      if (values.length) return Promise.resolve({ value: values.shift(), done: false });
      if (ended) return Promise.resolve({ done: true });
      return new Promise((resolve) => { waiter = resolve; });
    },
  };
}

/** One CLI session / scope / exclusively owned ingress file. No automatic process restart. */
function createRuntime({
  ingressPath = process.env.IM_BRIDGE_INGRESS_PATH,
  cwd = process.env.IM_BRIDGE_CLI_CWD,
  pathToClaudeCodeExecutable = process.env.IM_BRIDGE_CLI_PATH,
  scope,
  deliver,
  onEvent = async () => {},
  sdkOptions = {},
  stopGraceMs = 1000,
} = {}) {
  absolute(ingressPath, 'ingressPath');
  absolute(cwd, 'cwd');
  absolute(pathToClaudeCodeExecutable, 'pathToClaudeCodeExecutable');
  if (typeof scope !== 'string' || !scope.trim()) throw new Error('请指定此 CLI 会话的 scope。');
  if (typeof deliver !== 'function') throw new Error('请提供 deliver 回调，正文必须有明确的投递出口。');
  if (!Number.isFinite(stopGraceMs) || stopGraceMs < 0) throw new Error('停止宽限时间必须是非负毫秒数。');
  // G-1：不允许覆盖进程、输入、取消及路径接线；其余 SDK 参数由调用方显式提供。
  for (const key of ['cwd', 'pathToClaudeCodeExecutable', 'spawnClaudeCodeProcess', 'abortController']) {
    if (key in sdkOptions) throw new Error(`sdkOptions.${key} 由装配层管理，请使用运行时的顶层参数。`);
  }
  if ('bare' in (sdkOptions.extraArgs ?? {})) throw new Error('不能使用 --bare：它可能禁用订阅登录，转为 API 计费。');
  const options = { ...sdkOptions };
  const ingress = createIngress({ filePath: ingressPath });
  const claim = createClaim({ bindings: new Map() });
  for (const row of ingress.list()) {
    if (row.scope !== scope) throw new Error(`存储包含其他会话 ${row.scope}，不能交给当前 CLI ${scope}。`);
    claim.enqueue(row.payload.message, row.payload.origin, row.uuid);
  }
  const input = inputQueue();
  const messageClaims = new Map();
  let query;
  let child;
  let closed = Promise.resolve();
  let childClosed = false;
  let running = false;
  let finished = false;
  let starting;
  let stopping = false;
  let disposed = false;
  let initialized = false;
  let firstSubmitted = false;
  let fatal;
  let pumpTask;
  let done = Promise.resolve();
  let requestedModel = options.model;
  let actualModel;
  let sessionId;
  const timers = [];

  function terminate(immediate = false) {
    stopping = true;
    input.end();
    if (!child || childClosed) return;
    const kill = (signal) => { if (!childClosed) child.kill(signal); };
    if (immediate) kill('SIGTERM');
    else {
      // A-1：interrupt 的控制回执不代表轮次成功，也不据此释放槽。
      query?.interrupt().catch(() => {});
      timers.push(setTimeout(() => kill('SIGTERM'), stopGraceMs));
    }
    timers.push(setTimeout(() => kill('SIGKILL'), immediate ? stopGraceMs : stopGraceMs * 2));
  }

  function fail(error) {
    fatal ??= error instanceof Error ? error : new Error(String(error));
    terminate(true);
  }

  function pump() {
    if (pumpTask || !running || stopping || (!initialized && firstSubmitted)) return;
    pumpTask = (async () => {
      // 单 CLI 串行；A-1：assistant/end_turn 绝不释放这里的 started 占位。
      if (ingress.list('started').length) return;
      const row = ingress.list('pending', scope)[0];
      if (!row || !ingress.begin(row.uuid)) return;
      // A-2/B-2：dispatching 落盘 → 建立归属 → submit 内 started 落盘 → AsyncIterable。
      const binding = claim.enqueue(row.payload.message, row.payload.origin, row.uuid);
      await ingress.submit(row.uuid, () => {
        firstSubmitted = true;
        input.push(structuredClone(binding.message));
      });
    })().catch(fail).finally(() => { pumpTask = undefined; });
  }

  function enqueue({ message, origin, uuid } = {}) {
    if (disposed) throw new Error('运行时存储已关闭，请重新打开后接收消息。');
    if (message?.type !== 'user' || message.message?.role !== 'user' ||
        message.message.content == null || message.shouldQuery === false) {
      throw new Error('请提供会触发回复的 SDK user 消息（message.role=user 和 content）。');
    }
    // C-1/C-2：不拼装开场、不读取交接摘要、不包装正文；群/私聊注入由调用方隔离。
    // B-1 待确认：SDK origin 与路由 origin 类型不同，见 worklog 的映射说明。
    const wire = { ...message, parent_tool_use_id: null,
      origin: message.origin ?? { kind: 'channel', server: origin?.channel } };
    // 只在临时表验证/冻结快照；真正认领表在 dispatching 后登记。
    const binding = createClaim({ bindings: new Map() }).enqueue(wire, origin, uuid);
    const row = ingress.accept({ uuid: binding.uuid, scope, payload: binding });
    pump();
    return row;
  }

  function owners(event) {
    let stamped = event;
    if (event.raw.type === 'assistant' && !event.isSubagent) {
      const { message, session_id } = event.raw;
      const key = message?.id && JSON.stringify([session_id, message.id]);
      const explicit = event.user_message_uuid !== undefined || event.user_message_uuids !== undefined;
      if (key && explicit) messageClaims.set(key, {
        user_message_uuid: event.user_message_uuid, user_message_uuids: event.user_message_uuids,
      });
      // B-2 待确认假设：同一 assistant message 的拆块继承其明确盖戳，不沿用上一轮。
      // decode/claim 保持无状态且不修改；无盖戳的新 message.id 不猜，见 worklog。
      if (key && !explicit && messageClaims.has(key)) stamped = { ...event, ...messageClaims.get(key) };
    }
    const stampedOwners = claim.lookup(stamped).filter((binding) =>
      ['started', 'uncertain'].includes(ingress.get(binding.uuid)?.state));
    if (stampedOwners.length || event.isSubagent) return stampedOwners;
    // B-2 实测修正（2026-09-20，fixtures/sdk-tool-turn-0.3.278.jsonl）：CLI 只给这轮
    // **第一条** assistant 消息和 result 盖戳，工具调用之后的新 message.id 一律不带。
    // 原来这里认不出就判「无法认领」停进程 —— 等于他每用一次工具就被掐断。
    // 本层严格串行（同一时刻最多一条 started，见 pump），所以没盖戳的帧只可能属于
    // 正在跑的那一轮；归属仍是入队时定死的那份，不是从正文或提交时刻去猜。
    const started = ingress.list('started', scope);
    return started.length === 1 ? claim.lookup({ user_message_uuid: started[0].uuid }) : [];
  }

  async function consume() {
    try {
      for await (const frame of query) {
        try {
          // G-1：收到 init 的同一轮同步检查并停进程，不能先 await 业务回调。
          if (frame.type === 'system' && frame.subtype === 'init') {
            if (frame.apiKeySource !== 'none') {
              fail(new Error(`CLI 未使用订阅登录（apiKeySource=${String(frame.apiKeySource)}），已停止，避免按 API 费率计费。`));
            } else { initialized = true; sessionId = frame.session_id; }
          }
          for (const event of decode(frame)) {
            if (fatal) continue;
            if (event.actualModel !== undefined) actualModel = event.actualModel; // D-3：只读观测。
            const bindings = owners(event);
            if (event.deliver || event.turnEnded) {
              if (!initialized) throw new Error('CLI 在确认订阅计费前就返回了正文或结果，已停止，请核对 system/init。');
            }
            // 没有任何一轮在跑时 CLI 自己开口（后台任务回报之类）：认不出归属就不投，
            // 但**不停进程** —— 停了他后面的话全断。原样交给 onEvent，由装配层决定。
            if (event.deliver && bindings.length) {
              const destinations = new Set(bindings.map(({ origin }) => JSON.stringify([
                origin.channel, origin.threadId, origin.recipient,
              ])));
              // B-1/C-2 待确认：跨收件人合批不广播私聊正文；同一归属只投一次。
              if (destinations.size !== 1) throw new Error('CLI 把不同收件人的消息合成一轮，无法安全选择投递对象，已停止并保留待对账。');
              await deliver({ event, text: event.text, origin: bindings[0].origin, bindings });
            }
            if (event.turnEnded) {
              const failed = frame.is_error === true || frame.subtype !== 'success';
              for (const binding of bindings) ingress.complete(binding.uuid, {
                failed, reason: `CLI 返回失败结果（${frame.subtype}）：${frame.errors?.join('；') || frame.result || '未提供原因'}；请对账。`,
              });
              messageClaims.clear();
            }
            // F-1：默认不投 token；开启后从 onEvent 收原始 stream_event，正文仍只走 deliver。
            await onEvent({ event, bindings });
          }
          pump();
        } catch (cause) {
          // 回调/认领失败即使发生在 stop 的尾帧中也必须可见，不能被正常停止掩盖。
          fail(new Error(`CLI 回包处理失败：${cause.message}`, { cause }));
        }
      }
      if (!initialized && !stopping) throw new Error('CLI 已退出，但没有返回 system/init，无法确认订阅计费。');
      if (!stopping && ingress.list('started').length) {
        throw new Error('CLI 已退出，但已提交消息还没有 result，不能确认完成，请对账。');
      }
    } catch (cause) {
      if (!stopping || fatal) fail(new Error(`CLI 运行中断：${cause.message}`, { cause }));
    } finally {
      running = false;
      finished = true;
      input.end();
      if (child && !childClosed) terminate(true);
      // A-2 / runtime-arch.md §4：SDK 迭代已读完尾帧，再等 Node close，才标 uncertain。
      await closed;
      for (const timer of timers) clearTimeout(timer);
      await pumpTask;
      for (const row of ingress.list()) {
        if (row.state === 'dispatching' || row.state === 'started') {
          ingress.interrupted(row.uuid, fatal?.message ?? 'CLI 已停止且尾部输出已读完');
        }
      }
      query?.close();
    }
    if (fatal) throw fatal;
  }

  function start() {
    if (disposed || stopping || finished) return Promise.reject(new Error('此运行时已停止；确认旧进程关闭后，请由调用方重新装配会话。'));
    if (starting) return starting;
    starting = (async () => {
      const { query: sdkQuery } = await import('@anthropic-ai/claude-agent-sdk');
      if (stopping || disposed) throw new Error('启动已取消，未创建 CLI。');
      query = sdkQuery({ prompt: input, options: {
        ...options,
        cwd, pathToClaudeCodeExecutable,
        // F-1：默认关；环境变量或显式配置可开。D-4：fallbackModel 仅透传，不承诺兜拒答。
        includePartialMessages: options.includePartialMessages ?? process.env.IM_BRIDGE_STREAM_TOKENS === '1',
        spawnClaudeCodeProcess(spec) {
          child = spawn(spec.command, spec.args, {
            cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'], signal: spec.signal,
          });
          // 自定义 spawn 必须消费 stderr；否则管道填满会令她一直收不到后续正文。
          child.stderr.on('data', (chunk) => {
            try { options.stderr?.(chunk.toString()); }
            catch (cause) { fail(new Error(`CLI 错误日志处理失败：${cause.message}`, { cause })); }
          });
          closed = new Promise((resolve) => child.once('close', () => { childClosed = true; resolve(); }));
          if (stopping) terminate(true);
          return child;
        },
      } });
      running = true;
      done = consume();
      done.catch(() => {}); // 允许消息先持久排队；错误仍由公开的 done 原样 reject。
      pump();
    })();
    return starting;
  }

  async function stop() {
    terminate();
    if (starting) await starting.catch(() => {});
    await done;
  }

  async function close() {
    try { await stop(); }
    finally { disposed = true; ingress.close(); }
  }

  return {
    enqueue, start, stop, close,
    get done() { return done; },
    get: (uuid) => ingress.get(uuid),
    list: (state) => ingress.list(state),
    status: () => ({ running, stopping, initialized, requestedModel, actualModel, sessionId }),
    async setModel(model) {
      if (!running || stopping) throw new Error('CLI 当前不可用，模型未切换。');
      // A-1/D-5：等真实控制回执，成功后才更新请求值；D-3 不用 actualModel 回写。
      await query.setModel(model);
      requestedModel = model;
    },
  };
}

module.exports = { createRuntime };
