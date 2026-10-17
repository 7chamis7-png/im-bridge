'use strict';

/**
 * Persistent Codex app-server driver for im-bridge.
 *
 * 起一个常驻的 `codex app-server`（换行分隔的 JSON-RPC over stdio），
 * initialize 一次，之后每轮 turn/start，把 item/agentMessage/delta 的 final_answer
 * 累成一句答复流式吐出去。工具（bash / codex 自带 MCP）由 app-server 服务端自己跑完，
 * Approval requests are answered according to the configured policy instead of
 * relying on the one-shot `codex exec` process lifecycle.
 *
 * 这一层只管「喂一句话 → 拿一句答复 + 用量」。会话连续性靠 threadId（codex 服务端存）。
 * 不碰 im-bridge 的事件格式、不碰冷层——那是 codex-runtime.js 的事。
 */

const os = require('node:os');
const { spawn } = require('node:child_process');

/** config 后缀 gpt-5.6-sol[1m] 里的 [..] 是上下文长度，不是模型名。 */
function stripContextSuffix(model) {
  return String(model || '').trim().replace(/\[[^\]]+\]$/, '');
}

function createCodexAppServer({
  codexPath = 'codex',
  cwd,
  model = '',
  home = os.homedir(),
  env = process.env,
  approvalPolicy = 'never',   // 探针实测：never = 不问直接跑，不触发 user cancelled
  developerInstructions = '', // Optional identity/system text supplied at thread/start.
  mcpServers = null,          // 桥递来的 MCP（im_bridge 那套嘴）→ 用 -c 覆盖注入，不改 config.toml
  log = () => {},
  startTimeoutMs = 60_000,
  turnTimeoutMs = 300_000,
} = {}) {
  if (!cwd) throw new Error('codex 驱动要 cwd（工作目录），不猜。');

  let child = null;
  let buf = '';
  let nextId = 1;
  let initialized = false;
  let threadId = '';
  let disposed = false;
  let startPromise = null;

  const pending = new Map();          // JSON-RPC id -> {resolve, reject}
  let activeTurn = null;              // 当前这轮的收集器
  const mcpStatus = new Map();        // MCP server 名 -> 'starting'|'ready'|'failed'
  let compactions = 0;                // codex 自动压缩触发次数（掉档风险计数）

  function writeMsg(obj) {
    if (!child || !child.stdin.writable) throw new Error('codex app-server 没在跑，发不出请求。');
    child.stdin.write(JSON.stringify(obj) + '\n');
  }

  /** 发一个需要应答的请求，返回 Promise<result>。 */
  function call(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { writeMsg({ jsonrpc: '2.0', id, method, params: params || {} }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }

  /** 发一个通知（无需应答）。 */
  function notify(method, params) {
    try { writeMsg({ jsonrpc: '2.0', method, params: params || {} }); }
    catch (error) { log('[codex] 通知发不出：' + error.message); }
  }

  /** 服务端反过来问我们（审批、输入请求）时，回它。只放行，不卡住。 */
  function answerServerRequest(msg) {
    const id = msg.id;
    const method = String(msg.method || '');
    // 审批类：一律放行（approvalPolicy=never 时一般不会来，这里是兜底，别让 codex 干等）。
    if (/[Aa]pproval/.test(method) || /exec.*approv/i.test(method)) {
      writeMsg({ jsonrpc: '2.0', id, result: { decision: 'approved' } });
      log('[codex] 审批请求已放行：' + method);
      return;
    }
    // 其它不认识的服务端请求：回一个空结果，别让它阻塞。标准 JSON-RPC 不允许悬着。
    writeMsg({ jsonrpc: '2.0', id, result: {} });
    log('[codex] 兜底应答了服务端请求：' + method);
  }

  function handleNotification(msg) {
    const method = String(msg.method || '');
    const p = msg.params || {};

    // MCP 启动状态（在 thread/start 时就来，不等 turn）：记下来，失败的喊一声。
    if (method === 'mcpServer/startupStatus/updated' && p.name) {
      mcpStatus.set(p.name, p.status);
      if (p.status === 'failed') log('[codex] MCP 没起来 ' + p.name + '：' + (p.error || '').slice(0, 160));
      else if (p.status === 'ready') log('[codex] MCP 就绪 ' + p.name);
      return;
    }

    // Keep automatic compaction visible to operators; it changes the thread context.
    if (/compact/i.test(method)) {
      compactions += 1;
      log(`[codex] automatic compaction observed (#${compactions}, method=${method})`);
      return;
    }

    if (!activeTurn) return;

    if (method === 'item/agentMessage/delta') {
      const delta = typeof p.delta === 'string' ? p.delta : '';
      if (!delta) return;
      // phase 在 item/started 里给（final_answer vs commentary）。delta 本身不带 phase，
      // 用 itemId 认门：记住哪个 item 是 final_answer，只收它。
      if (activeTurn.finalItemId && p.itemId === activeTurn.finalItemId) {
        activeTurn.finalText += delta;
        if (activeTurn.onDelta) { try { activeTurn.onDelta(delta); } catch { /* 回调炸了不影响收字 */ } }
      } else if (activeTurn.commentaryItems.has(p.itemId)) {
        activeTurn.commentaryText += delta;
      }
      return;
    }

    if (method === 'item/started' && p.item && p.item.type === 'agentMessage') {
      if (p.item.phase === 'final_answer') activeTurn.finalItemId = p.item.id;
      else activeTurn.commentaryItems.add(p.item.id);
      return;
    }

    if (method === 'item/completed' && p.item && p.item.type === 'agentMessage'
        && p.item.phase === 'final_answer' && typeof p.item.text === 'string' && p.item.text.trim()) {
      // 以 completed 里的全文为准（delta 偶尔会漏拼）。
      activeTurn.finalText = p.item.text;
      return;
    }

    if (method === 'thread/tokenUsage/updated' && p.tokenUsage && p.tokenUsage.total) {
      activeTurn.usage = p.tokenUsage.total;
      return;
    }

    if (method === 'turn/completed') {
      activeTurn.complete();
      return;
    }

    if (method === 'turn/failed' || (method === 'thread/error')) {
      activeTurn.fail(new Error(p.error && p.error.message ? p.error.message : 'codex 这轮失败了。'));
    }
  }

  function onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      // 这是对我们请求的应答
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else waiter.resolve(msg.result);
      }
      return;
    }
    if (msg.id != null && msg.method) { answerServerRequest(msg); return; }  // 服务端请求
    if (msg.method) handleNotification(msg);                                  // 通知
  }

  /**
   * 把桥递来的 mcpServers 拼成 codex 的 `-c` 覆盖参数。
   * 不改 config.toml（那里的 stmem/garden 保留），只在这个进程临时加 im_bridge 这些。
   * 值按 TOML 解析，字符串/数组用 JSON.stringify 正好是合法 TOML 字面量。
   */
  function mcpOverrideArgs() {
    if (!mcpServers || typeof mcpServers !== 'object') return [];
    const args = [];
    const push = (k, v) => { args.push('-c', `${k}=${v}`); };
    for (const [name, spec] of Object.entries(mcpServers)) {
      if (!spec || typeof spec !== 'object') continue;
      const base = `mcp_servers.${name}`;
      if (spec.url) { push(`${base}.url`, JSON.stringify(spec.url)); }
      if (spec.command) push(`${base}.command`, JSON.stringify(spec.command));
      if (Array.isArray(spec.args)) push(`${base}.args`, JSON.stringify(spec.args));
      if (spec.env && typeof spec.env === 'object') {
        for (const [ek, ev] of Object.entries(spec.env)) push(`${base}.env.${ek}`, JSON.stringify(String(ev)));
      }
    }
    return args;
  }

  function spawnServer() {
    const extra = mcpOverrideArgs();
    if (extra.length) log('[codex] 注入 MCP：' + Object.keys(mcpServers).join(', '));
    child = spawn(codexPath, ['app-server', ...extra], {
      cwd,
      env: { ...env, HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onLine(line);
      }
    });
    child.stderr.on('data', (d) => {
      const s = d.toString().trim();
      // bubblewrap 那条警告是良性的（用自带的），别当错误刷屏。
      if (s && !/bubblewrap/.test(s)) log('[codex stderr] ' + s.slice(0, 300));
    });
    child.on('exit', (code) => {
      const err = new Error('codex app-server 退出了 code=' + code);
      for (const w of pending.values()) w.reject(err);
      pending.clear();
      if (activeTurn) activeTurn.fail(err);
      child = null;
      initialized = false;
    });
  }

  async function ensure() {
    if (initialized && child) return;
    if (startPromise) return startPromise;
    startPromise = (async () => {
      spawnServer();
      const initResult = await withTimeout(
        call('initialize', { clientInfo: { name: 'im-bridge', version: '1.0.0' } }),
        startTimeoutMs, 'codex initialize 超时',
      );
      // codexHome 让我们能回头验 auth_mode（硬闸在 codex-runtime 做）。
      notify('initialized', {});
      const started = await withTimeout(
        call('thread/start', {
          model: stripContextSuffix(model) || undefined,
          cwd,
          approvalPolicy,
          ...(developerInstructions ? { developerInstructions } : {}),
        }),
        startTimeoutMs, 'codex thread/start 超时',
      );
      threadId = (started && started.thread && started.thread.id) || '';
      if (!threadId) throw new Error('codex thread/start 没给 threadId。');
      initialized = true;
      log('[codex] 起来了 thread=' + threadId.slice(0, 13) + ' home=' + (initResult && initResult.codexHome || '?'));
    })();
    try { await startPromise; }
    finally { startPromise = null; }
  }

  /** 续一条已有的 thread（换舱/重启后保持连续）。续上返回 true，续不上返回 false（当新 thread）。 */
  async function resumeThread(id) {
    if (!id) return false;
    try {
      await ensure();   // 先确保 server 活着
      const r = await call('thread/resume', { threadId: id });
      threadId = (r && r.thread && r.thread.id) || id;
      log('[codex] 续上旧 thread=' + threadId.slice(0, 13));
      return true;
    } catch (error) {
      log('[codex] 旧 thread 续不上，用新的：' + error.message);
      return false;
    }
  }

  /** 喂文字或 app-server input items，拿一句答复。onDelta 逐字回调（可选）。 */
  async function runTurn(value, { onDelta } = {}) {
    if (disposed) throw new Error('codex 驱动已经关了。');
    await ensure();
    if (activeTurn) throw new Error('上一轮还没结束，不能并发。');
    const input = typeof value === 'string'
      ? [{ type: 'text', text: value }]
      : (Array.isArray(value) ? value : []);
    if (!input.length) throw new Error('codex 这轮没有 input items。');

    return await new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true; activeTurn = null;
        reject(new Error(`codex 这轮超过 ${turnTimeoutMs}ms 没回。`));
      }, turnTimeoutMs);

      activeTurn = {
        finalItemId: '',
        finalText: '',
        commentaryItems: new Set(),
        commentaryText: '',
        usage: null,
        onDelta,
        complete() {
          if (done) return;
          done = true; clearTimeout(timer);
          const out = activeTurn;
          activeTurn = null;
          // Older/newer app-server builds may only emit commentary; do not return an empty turn.
          const reply = out.finalText.trim() || out.commentaryText.trim();
          resolve({ text: reply, usage: out.usage });
        },
        fail(error) {
          if (done) return;
          done = true; clearTimeout(timer);
          activeTurn = null;
          reject(error);
        },
      };

      call('turn/start', { threadId, input })
        .catch((error) => activeTurn && activeTurn.fail(error));
    });
  }

  async function interrupt() {
    if (!initialized || !threadId) return;
    try { await call('turn/interrupt', { threadId }); } catch { /* 没在跑就算了 */ }
  }

  async function close() {
    disposed = true;
    try { await interrupt(); } catch { /* 忽略 */ }
    if (child) { try { child.kill('SIGTERM'); } catch { /* 已退 */ } }
    child = null;
    initialized = false;
  }

  function withTimeout(promise, ms, msg) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
    ]);
  }

  return {
    ensure,
    resumeThread,
    runTurn,
    interrupt,
    close,
    get threadId() { return threadId; },
    get initialized() { return initialized; },
    mcpStatus: () => new Map(mcpStatus),
    compactions: () => compactions,
  };
}

module.exports = { createCodexAppServer, stripContextSuffix };
