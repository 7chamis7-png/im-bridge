'use strict';

/**
 * codex app-server 驱动 —— Iris的发动机。
 *
 * 起一个常驻的 `codex app-server`（换行分隔的 JSON-RPC over stdio），
 * initialize 一次，之后每轮 turn/start，把 item/agentMessage/delta 的 final_answer
 * 累成一句答复流式吐出去。工具（bash / codex 自带 MCP）由 app-server 服务端自己跑完，
 * 我们只把审批请求放行——这正是绕开 `codex exec` 那个「user cancelled」老坑的地方
 * （见 project-iris-codex-appserver：exec 默认把审批当拒，app-server 是正经请求-应答）。
 *
 * 这一层只管「喂一句话 → 拿一句答复 + 用量」。会话连续性靠 threadId（codex 服务端存）。
 * 不碰 im-bridge 的事件格式、不碰冷层——那是 codex-runtime.js 的事。
 */

const { spawn } = require('node:child_process');

/** config 后缀 gpt-5.6-sol[1m] 里的 [..] 是上下文长度，不是模型名。 */
function stripContextSuffix(model) {
  return String(model || '').trim().replace(/\[[^\]]+\]$/, '');
}

/** 是不是 codex 自动压缩的通知（0.163.0：item.type=contextCompaction；老的：thread/compacted）。 */
function isCompactionNotice(method, params) {
  const p = params || {};
  if ((method === 'item/started' || method === 'item/completed') && p.item && p.item.type === 'contextCompaction') return true;
  return method === 'thread/compacted';
}

function createCodexAppServer({
  codexPath = '/usr/local/bin/codex',
  cwd,
  model = '',
  home = require('../src/core/paths').homeDir(),
  env = process.env,
  approvalPolicy = 'never',   // 探针实测：never = 不问直接跑，不触发 user cancelled
  developerInstructions = '', // Iris的身份底座，thread/start 时塞进去
  mcpServers = null,          // 桥递来的 MCP（im_bridge 那套嘴）→ 用 -c 覆盖注入，不改 config.toml
  configOverrides = [],       // 额外的 -c k=v（S3c：model_context_window 等，见 configOverridesFromEnv）
  log = () => {},
  onCompaction = () => {},    // codex 自己压缩了（桥没抢到）：插头拿去告警
  startTimeoutMs = 60_000,
  turnTimeoutMs = 300_000,
} = {}) {
  if (!cwd) throw new Error('codex 驱动要 cwd（工作目录），不猜。');

  let child = null;
  let buf = '';
  let nextId = 1;
  let initialized = false;
  let threadId = '';
  let threadPath = '';               // rollout 文件路径（thread/start / resume 给的），forge 注入后回读核对用
  let disposed = false;
  let startPromise = null;

  const pending = new Map();          // JSON-RPC id -> {resolve, reject}
  let activeTurn = null;              // 当前这轮的收集器
  const mcpStatus = new Map();        // MCP server 名 -> 'starting'|'ready'|'failed'
  let compactions = 0;                // codex 自动压缩触发次数（掉档风险计数）
  const compactionKeys = new Set();   // 同一次压缩 started / completed / thread/compacted 会来好几条，按轮去重
  let mcpEnv = {};                    // 各包的 env（base64 JSON），只放 app-server 自己的环境，不上命令行
  let turnModel = '';                 // /model 热切过的名字（空 = 用 thread 开的时候那个）
  let lastRateLimits = null;          // 最近一条 account/rateLimits/updated：{ snapshot, at }

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

    // 额度滚动更新（/usage 读不到 account/rateLimits/read 时拿最近这条兜底，注明是哪一刻的）
    if (method === 'account/rateLimits/updated' && p.rateLimits) {
      lastRateLimits = { snapshot: p.rateLimits, at: new Date().toISOString() };
      return;
    }

    // MCP 启动状态（在 thread/start 时就来，不等 turn）：记下来，失败的喊一声。
    if (method === 'mcpServer/startupStatus/updated' && p.name) {
      mcpStatus.set(p.name, p.status);
      if (p.status === 'failed') log('[codex] MCP 没起来 ' + p.name + '：' + (p.error || '').slice(0, 160));
      else if (p.status === 'ready') log('[codex] MCP 就绪 ' + p.name);
      return;
    }

    // 掉档可见：codex 自动压缩时喊一声，别让它无声把原文换摘要（Iris的老病）。
    // 0.163.0 的通知是 item/started|completed、item.type="contextCompaction"，方法名里**没有** compact
    // （S0 §8.2；原来的 /compact/i.test(method) 认不出，10-15～10-20 压了 5 次日志里 0 条）。
    // 老的 thread/compacted（已标 deprecated）也认，同一轮只算一次。
    // 关不掉它（实际阈值≈min(配置, 90% 窗口)），S3c 靠桥抢在前面换舱；它一旦发生说明桥没抢到，要喊。
    if (isCompactionNotice(method, p)) {
      const key = p.turnId || (p.item && p.item.id) || '';
      if (!key || !compactionKeys.has(key)) {
        if (key) { compactionKeys.add(key); if (compactionKeys.size > 64) compactionKeys.delete(compactionKeys.values().next().value); }
        compactions += 1;
        log(`[codex] ⚠️ 自动压缩触发了（第 ${compactions} 次，${method}${p.item ? ':' + p.item.type : ''}）—— 桥没抢在它前面换舱，原文被换成摘要了`);
        try { onCompaction({ count: compactions, threadId: p.threadId || threadId, turnId: p.turnId || '' }); } catch { /* 回调炸了不影响 */ }
      }
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

    // S2b：工具 / reasoning 这些 item 原来一个都不看（设计稿 §0.2），现在交给插头翻成通用事件（tool.call / tool.result / reasoning）
    if (method === 'item/completed' && p.item && p.item.type !== 'agentMessage' && activeTurn.onItem) {
      try { activeTurn.onItem(p.item, { turnId: p.turnId || '', threadId: p.threadId || threadId }); } catch { /* 回调炸了不影响这一轮 */ }
      return;
    }

    // 整个 tokenUsage 都留着：total 是整条 thread 的**累计**（几轮就上百万），水位要的是 last（上一次请求）。
    // 怎么折成水位是插头的事（codex-runtime.mapUsage）。
    if (method === 'thread/tokenUsage/updated' && p.tokenUsage && (p.tokenUsage.last || p.tokenUsage.total)) {
      activeTurn.usage = p.tokenUsage;
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
   * 把桥递来的 mcpServers 拼成 codex 的 `-c` 覆盖参数（实现在文件底部 buildMcpOverrides）。
   * 不改 config.toml（那里的 stmem 保留），只在这个进程临时覆盖。
   */
  function mcpOverrideArgs() {
    const r = buildMcpOverrides(mcpServers);
    mcpEnv = r.env;
    return r.args;
  }

  function spawnServer() {
    const extra = mcpOverrideArgs();
    if (extra.length) log('[codex] 注入 MCP：' + Object.keys(mcpServers).join(', '));
    const conf = [];
    for (const kv of Array.isArray(configOverrides) ? configOverrides : []) conf.push('-c', String(kv));
    if (conf.length) log('[codex] 启动参数：' + configOverrides.join(' '));
    child = spawn(codexPath, ['app-server', ...conf, ...extra], {
      cwd,
      env: { ...env, ...mcpEnv, HOME: home },
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

  /**
   * 只保证 app-server 活着并 initialize 过 —— **不开 thread**（2026-10-21 S3c）。
   * 原来这里每次起进程都先 thread/start 一条，紧接着 codex-runtime 再 resume 旧的 → 每次重启多一条空 thread。
   * 现在开不开新的由调用方决定（startThread / resumeThread）。
   * 进程中途死了又被拉起来时，手上原来那条 thread 自动 resume 回去（新进程里那条 thread 没加载，
   * 不续就只能新开一条 —— 那等于一次没垫历史的静默换舱）。
   */
  async function ensure() {
    if (initialized && child) return;
    if (startPromise) return startPromise;
    startPromise = (async () => {
      spawnServer();
      const initResult = await withTimeout(
        call('initialize', { clientInfo: { name: 'iris', version: '1.0.0' } }),
        startTimeoutMs, 'codex initialize 超时',
      );
      // codexHome 让我们能回头验 auth_mode（硬闸在 codex-runtime 做）。
      notify('initialized', {});
      initialized = true;
      log('[codex] app-server 起来了 home=' + (initResult && initResult.codexHome || '?'));
      if (threadId) {
        const was = threadId;
        try {
          await withTimeout(doResume(was), startTimeoutMs, 'codex thread/resume 超时');
          log('[codex] app-server 重起过，续回原来的 thread=' + threadId.slice(0, 13));
        } catch (error) {
          // 续不回来只能新开（下一轮 runTurn 兜底开）。大声说：这一下等于没垫历史的换舱。
          threadId = ''; threadPath = '';
          log(`[codex] ⚠️ app-server 重起后续不回原 thread=${was.slice(0, 13)}：${error.message} —— 下一轮会开新的`);
        }
      }
    })();
    try { await startPromise; }
    catch (error) { initialized = false; throw error; }
    finally { startPromise = null; }
  }

  async function doResume(id) {
    // cwd 显式带上（2026-10-21）：codex 把工作目录记在线程里，resume 不给就沿用线程里记的那个。
    // Iris目录改名（telegram-nova-workspace → /root/iris）之后，老线程记的是一个已经不存在的目录 ——
    // 不覆盖，他的命令就全在空目录里跑。今天两边一样，带上是空操作。
    // ⚠️ 没带 developerInstructions：续上的线程历史里已经有一份，再带会不会叠一份没验过，宁可等换舱生效。
    const r = await call('thread/resume', { threadId: id, ...(cwd ? { cwd } : {}) });
    threadId = (r && r.thread && r.thread.id) || id;
    threadPath = (r && r.thread && r.thread.path) || '';
    return threadId;
  }

  /** 开一条新 thread（第一次 / 换舱 / 旧的续不上）。人格底座在这时候塞进去。 */
  async function startThread() {
    await ensure();
    if (activeTurn) throw new Error('正在跑一轮，不能这时候换 thread。');
    const started = await withTimeout(
      call('thread/start', {
        model: stripContextSuffix(model) || undefined,
        cwd,
        approvalPolicy,
        ...(developerInstructions ? { developerInstructions } : {}),
      }),
      startTimeoutMs, 'codex thread/start 超时',
    );
    const id = (started && started.thread && started.thread.id) || '';
    if (!id) throw new Error('codex thread/start 没给 threadId。');
    threadId = id;
    threadPath = (started && started.thread && started.thread.path) || '';
    log('[codex] 开了新 thread=' + threadId.slice(0, 13));
    return threadId;
  }

  /** 续一条已有的 thread（换舱/重启后保持连续）。续上返回 true，续不上返回 false（调用方再 startThread）。 */
  async function resumeThread(id) {
    if (!id) return false;
    try {
      await ensure();   // 先确保 server 活着
      if (threadId === id) return true;   // ensure 里刚续过（进程重起那条路）
      await doResume(id);
      log('[codex] 续上旧 thread=' + threadId.slice(0, 13));
      return true;
    } catch (error) {
      log('[codex] 旧 thread 续不上：' + error.message);
      return false;
    }
  }

  /** 喂文字或 app-server input items，拿一句答复。onDelta 逐字回调（可选）。 */
  async function runTurn(value, { onDelta, onItem } = {}) {
    if (disposed) throw new Error('codex 驱动已经关了。');
    await ensure();
    if (!threadId) await startThread();   // 兜底：调用方没开也没续（正常路径 codex-runtime.start 已经定好了）
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
        onItem,
        complete() {
          if (done) return;
          done = true; clearTimeout(timer);
          const out = activeTurn;
          activeTurn = null;
          // 没有 final_answer 就退而用 commentary，别让她空手（陪伴项目判据：别让她少收）。
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

      // 同一家内热切（/model，S5）：turn/start 带 model = 「本轮及之后」用它（app-server 0.163.0 TurnStartParams）。
      // 没切过就不带，跟原来一字不差。
      call('turn/start', { threadId, input, ...(turnModel ? { model: turnModel } : {}) })
        .catch((error) => activeTurn && activeTurn.fail(error));
    });
  }

  /**
   * 往当前 thread 里追加模型看得见的历史（thread/inject_items，稳定接口，S0 实测过）。
   * forge 的 codex 插头用（cli-host/rebuild-codex.js）。items 是 Responses API 的 item。
   */
  async function injectItems(items) {
    await ensure();
    if (!threadId) throw new Error('还没有 thread，没处塞。');
    if (activeTurn) throw new Error('正在跑一轮，不能这时候往里塞历史。');
    return call('thread/inject_items', { threadId, items });
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
    // 计时器要清掉：不清的话关掉驱动之后进程还要白挂到超时（测试里一挂就是 60 秒）
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(msg)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  return {
    ensure,
    startThread,
    resumeThread,
    runTurn,
    injectItems,
    interrupt,
    close,
    get threadId() { return threadId; },
    get threadPath() { return threadPath; },
    get initialized() { return initialized; },
    mcpStatus: () => new Map(mcpStatus),
    compactions: () => compactions,
    /** /usage：问 app-server 现在的额度（0.163.0 account/rateLimits/read）。不起新进程 —— 没在跑就抛。 */
    async readRateLimits() {
      if (!initialized || !child) throw new Error('app-server 没在跑');
      return withTimeout(call('account/rateLimits/read', { excludeResetCreditDetails: true }), 15_000, 'account/rateLimits/read 超时');
    },
    lastRateLimits: () => lastRateLimits,
    /** 同一家内热切：下一轮起用这个模型（turn/start 的 model）。 */
    setModel(m) { turnModel = stripContextSuffix(m); },
  };
}


/**
 * Iris那份 app-server 的 -c 覆盖（S3c，2026-10-21），从 env 读，**只在这个进程里**生效、不改 ~/.codex/config.toml：
 *   CODEX_MODEL_CONTEXT_WINDOW       → model_context_window（窗口；codex 的有效窗口 = 它 × 95%）
 *   CODEX_AUTO_COMPACT_TOKEN_LIMIT   → model_auto_compact_token_limit（自压缩阈值；实测关不掉，
 *                                      实际 ≈ min(它, 有效窗口 × 90%)，设文档 §8.2）
 * 只认正整数；写错了大声说、不带上（别让一个拼错的值把 app-server 起不来）。
 */
function configOverridesFromEnv(env = process.env, log = () => {}) {
  const out = [];
  const map = [['CODEX_MODEL_CONTEXT_WINDOW', 'model_context_window'], ['CODEX_AUTO_COMPACT_TOKEN_LIMIT', 'model_auto_compact_token_limit']];
  for (const [name, key] of map) {
    const raw = String(env[name] || '').trim();
    if (!raw) continue;
    if (!/^\d+$/.test(raw) || Number(raw) <= 0) { log(`[codex] ${name}=${raw} 不是正整数，不带上`); continue; }
    out.push(`${key}=${Number(raw)}`);
  }
  return out;
}

const LAUNCH_SCRIPT = require('node:path').join(__dirname, 'codex-mcp-launch.js');

/**
 * mcpServers → codex 的 `-c` 覆盖 + 要塞进 app-server 环境的变量（2026-10-21 重写）。
 *
 * 原来是 `-c mcp_servers.X.env.K=V` 一条条拼：钥匙进命令行（ps 看得见），远程的 headers 也丢了。
 * 现在：
 *   · 有 env 的包 → 起 codex-mcp-launch.js 跳板，env 打成 base64 JSON 放进 IMB_MCP_<包>，
 *     只用 env_vars 透传这一个变量（codex 不透传环境，这是它唯一认的口子）
 *   · 远程的（url）照旧给 url；桥渲染出来的远程包已经是本地代理（stdio），一般走不到这支
 *   · 每包都给 default_tools_approval_mode="approve"（Alice 8-02：「给Iris MCP 调用的所有权限」；
 *     值必须是 approve，auto = 跟全局 policy 走 = 拒）
 *   · 启动 30 秒 / 单次调用 120 秒，跟Nova CLI 的 MCP_TIMEOUT / MCP_TOOL_TIMEOUT 对齐
 * ⚠️ -c 是**合并**进 config.toml 同名那节，不是整节替换（实测）：同名那节原来是 url 的会冲突报错。
 */
function buildMcpOverrides(mcpServers, { nodePath = process.execPath, launchScript = LAUNCH_SCRIPT } = {}) {
  if (!mcpServers || typeof mcpServers !== 'object') return { args: [], env: {} };
  const args = [];
  const env = {};
  const push = (k, v) => { args.push('-c', `${k}=${v}`); };
  for (const [name, spec] of Object.entries(mcpServers)) {
    if (!spec || typeof spec !== 'object') continue;
    if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;           // TOML 裸键只认这些
    const base = `mcp_servers.${name}`;
    if (spec.url && !spec.command) {
      push(`${base}.url`, JSON.stringify(spec.url));
    } else if (spec.command) {
      const hasEnv = spec.env && typeof spec.env === 'object' && Object.keys(spec.env).length > 0;
      if (hasEnv) {
        const varName = 'IMB_MCP_' + name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
        const clean = {};
        for (const [k, v] of Object.entries(spec.env)) clean[k] = String(v);
        env[varName] = Buffer.from(JSON.stringify(clean), 'utf8').toString('base64');
        push(`${base}.command`, JSON.stringify(nodePath));
        push(`${base}.args`, JSON.stringify([launchScript, varName, String(spec.command), ...(Array.isArray(spec.args) ? spec.args.map(String) : [])]));
        push(`${base}.env_vars`, JSON.stringify([varName]));
      } else {
        push(`${base}.command`, JSON.stringify(String(spec.command)));
        push(`${base}.args`, JSON.stringify(Array.isArray(spec.args) ? spec.args.map(String) : []));
      }
    } else {
      continue;
    }
    push(`${base}.default_tools_approval_mode`, '"approve"');
    push(`${base}.startup_timeout_sec`, '30');
    push(`${base}.tool_timeout_sec`, '120');
  }
  return { args, env };
}

module.exports = { createCodexAppServer, stripContextSuffix, buildMcpOverrides, isCompactionNotice, configOverridesFromEnv };
