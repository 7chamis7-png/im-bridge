"use strict";

/**
 * 远端盒子 —— 桥这头的替身（2026-09-18）
 *
 * 对桥来说它就是个盒子：**五条口一条不多一条不少**，桥根本不知道
 * 真正的 CLI 在另一个进程里。`assertBox` 照样过。
 *
 * 配套的那半在 `box-host.js`，为什么要拆看那儿的注释。
 *
 * ## 三件必须做对的事
 *
 * 1. **重连**。盒子重启（换舱 / 换模型 / 改盒子代码）时 socket 会断，
 *    桥要自己退避重连，不许就这么哑了。
 * 2. **不丢话**。连上就报「我收到第几号」，盒子从那儿往后补。
 *    游标**落盘**，因为桥自己也会重启（那正是这次拆分的目的）。
 * 3. **划账在真办完之后**。`onReply` 的处理函数 resolve 了（冷层写了、
 *    出站账本建了）才回 ack。半路断了就不 ack，下次重连盒子会再补一遍。
 *    重复投递由出站账本的幂等挡（operationId 去重），**宁可重一次，不许少一条**。
 */

const fs = require("fs");
const net = require("net");
const path = require("path");
const { encode, createDecoder, unpackError } = require("../../cli-host/protocol");

const RETRY_MS = [200, 500, 1000, 2000, 5000];

function makeRemoteBox({ socketFile, cursorFile, log = () => {}, timeoutMs = 300_000 } = {}) {
  if (!socketFile) throw new Error("远端盒子要给 socketFile");
  if (!cursorFile) throw new Error("远端盒子要给 cursorFile（不落盘的话桥一重启就重复吃话）");

  const replyHandlers = [];
  const doneHandlers = [];
  const pending = new Map();          // id → {resolve, reject, timer}
  let sock = null;
  let attempt = 0;
  let closed = false;
  let seq = readCursor();
  // 盒子主动推的快照。**桥那头 fullness()/describe() 是同步调用的**
  // （/model、/status、面板三处），所以只能缓存着，不能每次去问一趟。
  let state = { fullness: null, describe: null, turnCapabilities: null };

  function readCursor() {
    try { return Number(JSON.parse(fs.readFileSync(cursorFile, "utf8")).seq) || 0; }
    catch { return 0; }
  }
  function writeCursor(n) {
    const tmp = cursorFile + ".tmp";
    fs.mkdirSync(path.dirname(cursorFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify({ seq: n }), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, cursorFile);
  }

  function send(obj) {
    if (!sock || sock.destroyed) return false;
    try { sock.write(encode(obj)); return true; }
    catch { return false; }
  }

  /** 一条口 = 一次问答。盒子不在就直接说不在，**不许装作送进去了**。 */
  function ask(op, args = {}, { timeoutMs: wait = timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      if (!sock || sock.destroyed) return reject(new Error("盒子没连上（nova-box 在跑吗）"));
      const id = op + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`盒子没回 ${op}（等了 ${Math.round(wait / 1000)} 秒）`));
      }, wait);
      pending.set(id, { resolve, reject, timer });
      if (!send({ op, id, ...args })) {
        clearTimeout(timer); pending.delete(id);
        reject(new Error("写不进盒子那条连接"));
      }
    });
  }

  /**
   * 盒子推上来的一句话。**处理完才划账** —— 处理函数是 async 的
   * （turn-queue 那头要等冷层和出站账本落地），所以这儿要 await。
   */
  async function consume(kind, n, payload) {
    const hs = kind === "reply" ? replyHandlers : doneHandlers;
    for (const h of hs) {
      try { await h(payload); }
      catch (e) {
        // 处理炸了就**不划账**：下次重连盒子会再补一遍，比丢了强。
        log(`处理 #${n}（${kind}）炸了，不划账，等重连补：${(e && e.message) || e}`);
        return;
      }
    }
    if (n > seq) { seq = n; writeCursor(seq); }
    send({ op: "ack", seq });
  }

  function connect() {
    if (closed) return;
    sock = net.createConnection(socketFile);
    sock.setNoDelay(true);

    sock.on("connect", () => {
      attempt = 0;
      log(`连上盒子了（我收到第 ${seq} 号）`);
      send({ op: "attach", since: seq });
    });

    let queue = Promise.resolve();      // 推上来的话按顺序办，别并发插队
    const push = createDecoder((msg) => {
      if (msg.ev === "reply" || msg.ev === "done") {
        const { ev, seq: n, payload } = msg;
        queue = queue.then(() => consume(ev, n, payload)).catch(() => {});
        return;
      }
      if (msg.ev === "state") { state = msg.payload || state; return; }
      if (msg.op === "attach") {
        if (msg.owed) log(`盒子补了 ${msg.owed} 条我没接到的话`);
        return;
      }
      if (msg.op === "ack") return;
      const p = msg.id && pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer); pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      // 错误整个拆回来：message / name / 远端栈 / 白名单标记（notAccepted → turn-queue 判 rejected 重投，
      // 不是 unknown 卡死）。标记清单在 protocol.js 的 ERROR_FLAGS，这儿不手搬。
      else p.reject(unpackError(msg.error || "盒子那头失败了"));
    }, () => log("盒子回的不是 JSON，丢了一行"));
    sock.on("data", (chunk) => push(chunk.toString("utf8")));

    const down = (why) => {
      if (closed) return;
      for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error("盒子断了：" + why)); }
      pending.clear();
      const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
      attempt += 1;
      log(`盒子断了（${why}），${wait}ms 后重连`);
      setTimeout(connect, wait);
    };
    sock.on("error", (e) => { /* close 紧跟着来，退避统一在那儿做 */ log("盒子连接出错：" + ((e && e.message) || e)); });
    sock.once("close", () => down("close"));
  }

  connect();

  // ——— 五条口（跟 gate-box-claudecode 长得一模一样，桥分不出来）———
  const box = {
    deliver: (env) => ask("deliver", { env }),
    // 换引擎（/engine）也走 rotate：盒子要等他静下来、可能放一次 Claude 金丝雀（约 90 秒）、起新引擎 —— 给 15 分钟
    rotate: (reason) => ask("rotate", { reason }, { timeoutMs: Math.max(timeoutMs, 15 * 60_000) }),
    trim: (opts) => ask("trim", opts || {}),
    reloadCli: (opts) => ask("reloadCli", opts || {}),
    // **同步**，跟真盒子一个签名。读的是盒子推上来的快照。
    fullness: () => state.fullness,
    onReply(fn) { replyHandlers.push(fn); return () => replyHandlers.splice(replyHandlers.indexOf(fn), 1); },
    onTurnDone(fn) { doneHandlers.push(fn); return () => doneHandlers.splice(doneHandlers.indexOf(fn), 1); },
    /** 关掉（测试和优雅退出用），不属于五条口。 */
    close() { closed = true; try { sock && sock.end(); } catch { /* 早断了 */ } },
    /** 面板 / 体检用：连上了没、收到第几号。 */
    _state: () => ({ connected: !!(sock && !sock.destroyed), seq, cached: state }),
  };

  /**
   * 运行时替身 —— **只给命令那几条用**（`/model` `/stop`）。
   *
   * 运行时本体跟着 CLI 待在盒子进程里，桥够不着了。但命令表要它三样：
   * `describe()`（同步，报配置里请求的是哪个模型）、`setModelForWorkspace`、`cancelTurn`。
   * 前者走快照，后两者转发过去。
   *
   * 故意**没有** `initialize` / `close`：那是盒子进程自己的生命周期，桥不该插手
   * —— 这次拆分要的就是「桥动不到盒子」。
   */
  const runtime = {
    describe: () => state.describe || {},
    // 识图那条同步调它。不给的话它会退回 `describe().capabilities`（不存在）→ 一律 false，
    // 跟直连那条悄悄不一样。见 box-host 里 snapshot() 的注释。
    getTurnCapabilities: () => state.turnCapabilities || {},
    setModelForWorkspace: ({ model }) => ask("setModel", { model }),
    // /usage：现在这家引擎的订阅额度 / 余额。盒子 → 引擎宿主去查（codex 要问活着的 app-server）
    usage: () => ask("usage", {}, { timeoutMs: Math.min(timeoutMs, 60_000) }),
    cancelTurn: ({ threadId, turnId } = {}) => ask("cancelTurn", { threadId, turnId }),
  };

  return { box, runtime };
}

module.exports = { makeRemoteBox };
