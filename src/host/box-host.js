"use strict";

/**
 * 盒子进程 —— Nova住的地方（2026-09-18 Alice定的拆法）
 *
 * ```
 *   pm2 nova-cli   →  claude CLI 住这儿（cli-host/），盒子连 cli.sock 过去
 *   pm2 nova-box   →  这个进程：会话 / forge / 人格注入 / 记账本
 *                       unix socket: <root>/box.sock
 *                              ▲
 *   pm2 nova-gate  →  插头 + 共用层 + 冷层 + 路由
 * ```
 *
 * **她的原话**：「别的都是盒子外面的插头 插头坏了拔下来重新插就可以 没必要动盒子。」
 *
 * 在这之前是反的：CLI 是桥的**子进程**，还靠管道说话（`process-client.js` 的
 * `spawn(..., {stdio:["pipe","pipe","pipe"]})`，没有 detached）。桥一重启，
 * 管道两端就断了，新桥也没有任何办法接回旧 CLI 的 stdin/stdout —— 于是
 * **改一行投递层的代码都要把他打断一次**。SPEC §8 早写了这条价值观
 * （「重启粒度…重启会打断他」），这次是把它推到底。
 *
 * 拆完之后的重启粒度：
 *   · 改插头 / 共用层 / 路由 / 冷层 → 重启 `nova-gate`，**他一点感觉都没有**
 *   · 改盒子 / 记账本 / 人格注入     → 重启 `nova-box`，他也没感觉（CLI 在 nova-cli 里）
 *   · 换舱 / 换模型 / 改 nova-cli    → 才打断他
 *
 * ## 桥不在的时候他说话了怎么办
 *
 * 记在 `box-journal.js` 里，编号、落盘、等桥回来补。桥处理完（冷层写了、
 * 出站账本建了）才回一句「收到第几号」，记账本才划掉。
 * **划账在桥那头真办完之后，不是在网线上。**
 *
 * ## 为什么工具不用跟着改
 *
 * MCP 工具壳那头是**一次一连、不留长连接**（`tools/mcp-server.js:42` 自己写着），
 * 所以桥重启后他下一次调工具直接连上新桥。2026-09-18 特意先验的就是这条。
 *
 * ## 一个盒子只服务一个桥
 *
 * 后来的连接会把前一个顶掉（正常场景就是桥重启，老连接已经是死的）。
 * 不做排队 —— 两个桥同时驱动一个盒子是配置错误，不是要支持的用法。
 *
 * ## 线上格式
 *
 * 一行一条 JSON，编解码和错误打包用 `cli-host/protocol.js` 那一份（跟 cli.sock 同一套）。
 * 2026-09-20 16:35 那次：这儿原来手写 `{ok:false, error: e.message}`，`notAccepted` 掉在线上，
 * 桥记 unknown 堵死队列。现在错误走 `packError`，要带过线的标记登记在 `ERROR_FLAGS`，不再手搬。
 */

const fs = require("fs");
const net = require("net");
const path = require("path");

const { readConfig, BOXES } = require("./main");
const { loadPersona } = require("./persona");
const { buildBox } = require("./box-build");
const { BoxJournal } = require("./box-journal");
const { encode, createDecoder, packError } = require("../../cli-host/protocol");

const defaultLog = (m) => console.log(
  new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 19) + " 京时 | [盒子] " + m,
);

function writeLine(sock, obj) {
  try { sock.write(encode(obj)); return true; }
  catch { return false; }
}

/**
 * 把一个盒子摆到 socket 上给桥用。**不认识配置、不造盒子** —— 那是 main() 的事，
 * 这样测试可以拿假盒子直接验线上行为（错误标记过不过线、欠账补不补、顶不顶老桥）。
 *
 * @param {object} o.box       五条口的盒子（deliver / rotate / fullness / onReply / onTurnDone）
 * @param {object} o.runtime   运行时（setModelForWorkspace / cancelTurn / describe / getTurnCapabilities）
 * @param {object} o.journal   BoxJournal
 * @param {string} o.sockFile  监听哪个 unix socket
 * @param {string} o.workspaceRoot  换模型 / 停轮要报的工作目录
 * @param {string} [o.model]   配置里请求的模型（快照里 turnCapabilities 要）
 */
function serveBox({ box, runtime, journal, sockFile, workspaceRoot, model = "", log = defaultLog }) {
  /** 当前接着的那个桥。没有就是 null —— 他照说，记账本照记。 */
  let bridge = null;

  function emit(kind, payload) {
    const row = journal.append(kind, payload);
    if (bridge) {
      if (!writeLine(bridge, { ev: kind, seq: row.seq, payload })) {
        log(`桥那头写不进去了，第 #${row.seq} 条先欠着`);
      }
    } else {
      log(`桥不在，第 #${row.seq} 条（${kind}）先记着，一共欠 ${journal.pending()} 条`);
    }
  }

  /**
   * 快照：多满了 + 底座自报。
   *
   * ⚠️ **这两样在桥那头是同步调用的**（`/model`、`/status`、面板，三处），
   * 所以不能让桥每次去问一趟 —— 改成盒子主动推、桥缓存着，签名才保得住原样。
   * 快照丢一次无所谓（下一轮就覆盖了），所以**不进记账本**：
   * 记账本是给"他说的话"用的，快照不是话。
   */
  function snapshot() {
    const pick = (fn) => { try { return fn() || null; } catch { return null; } };
    return {
      fullness: pick(() => box.fullness()),
      describe: pick(() => (typeof runtime.describe === "function" ? runtime.describe() : null)),
      // 「这个模型吃不吃原生图 / 能不能自己 Read 图片文件」。
      // ⚠️ 必须一起推过去：识图那条拿不到 `getTurnCapabilities` 就退回 `describe().capabilities`，
      // 而 describe 里**没有**这一项 —— 结果是两条路悄悄不一样。现在他跑 fable 两边都是 false
      // 看不出来，但他的 fallback 是 opus，**落到 opus 那一刻直连会变 true、替身还是 false**。
      turnCapabilities: pick(() => (typeof runtime.getTurnCapabilities === "function"
        ? runtime.getTurnCapabilities({ model }) : null)),
    };
  }
  function pushState() {
    if (bridge) writeLine(bridge, { ev: "state", payload: snapshot() });
  }

  box.onReply((e) => emit("reply", e));
  box.onTurnDone((e) => { emit("done", e); pushState(); });

  // ——— 摆到 socket 上的口 ———
  // 五条口里的 deliver / rotate 在这儿；onReply / onTurnDone 是反向推的；
  // fullness 走快照（见上）。剩下三条是**命令要的**（换模型 / 停这一轮 / 关门），
  // 它们本来就在 runtime 上，桥只是够不着了。
  const OPS = {
    async deliver({ env }) { return { ok: true, result: await box.deliver(env) }; },
    async rotate({ reason }) {
      const result = await box.rotate(reason);
      pushState();                       // 换舱之后满度和会话号都变了，立刻推
      return { ok: true, result };
    },
    async fullness() { return { ok: true, result: snapshot().fullness }; },
    async trim(opts) {
      if (typeof box.trim !== "function") throw new Error("这个盒子不会裁工具链");
      const result = await box.trim(opts || {});
      pushState();
      return { ok: true, result };
    },
    async reloadCli(opts) {
      if (typeof box.reloadCli !== "function") throw new Error("这个盒子不会重连 CLI");
      return { ok: true, result: await box.reloadCli(opts || {}) };
    },
    async setModel({ model: m }) {
      if (typeof runtime.setModelForWorkspace !== "function") throw new Error("这个底座不能换模型");
      const r = await runtime.setModelForWorkspace({ workspaceRoot, model: m });
      pushState();
      return { ok: true, result: { model: m, ...(r && typeof r === "object" ? r : {}) } };
    },
    async usage() {
      if (typeof runtime.usage !== "function") throw new Error("这个底座查不了额度");
      return { ok: true, result: await runtime.usage() };
    },
    async cancelTurn({ threadId, turnId }) {
      if (typeof runtime.cancelTurn !== "function") throw new Error("这个底座停不了正在跑的那一轮");
      await runtime.cancelTurn({ threadId: threadId || "", turnId: turnId || "", workspaceRoot });
      return { ok: true, result: {} };
    },
  };

  async function handle(sock, msg) {
    // 接上来：把这条连接认成当前的桥，并把欠的话补给它
    if (msg.op === "attach") {
      if (bridge && bridge !== sock) {
        log("来了个新桥，把上一条连接顶掉（多半是桥重启了）");
        try { bridge.end(); } catch { /* 早断了 */ }
      }
      bridge = sock;
      // 桥记的号比我大 = 我这边归过零（老版本重启就归零）。跳上去，别跟它记过的号撞。
      if (journal.raiseTo(msg.since)) log(`桥记到第 ${msg.since} 号，比我这儿大 —— 号码跳到 ${msg.since} 接着数`);
      const owed = journal.since(msg.since);
      writeLine(sock, { ok: true, op: "attach", lastSeq: journal.lastSeq(), owed: owed.length });
      // 快照先给 —— 桥刚起来，面板和 /status 马上就要用，别让它空着
      pushState();
      for (const r of owed) writeLine(sock, { ev: r.kind, seq: r.seq, payload: r.payload, replay: true });
      log(`桥接上了（它说收到第 ${Number(msg.since) || 0} 号）`
        + (owed.length ? `，补了 ${owed.length} 条` : "，没欠账"));
      return;
    }

    // 划账：桥那头真办完了才划
    if (msg.op === "ack") {
      const n = journal.ack(msg.seq);
      if (n) writeLine(sock, { ok: true, op: "ack", cleared: n, pending: journal.pending() });
      return;
    }

    const fn = OPS[msg.op];
    if (!fn) { writeLine(sock, { id: msg.id, ok: false, error: packError(new Error("不认识这条口：" + msg.op)) }); return; }
    try {
      const r = await fn(msg);
      writeLine(sock, { id: msg.id, ...r });
    } catch (e) {
      // **炸了要照实说**，不许让桥以为送进去了（跟投递层同一条规矩）。
      // 错误整个打包过去：message / name / 栈头几行 / 白名单标记（notAccepted 等）。
      writeLine(sock, { id: msg.id, ok: false, error: packError(e) });
      log(`${msg.op} 炸了：${(e && e.message) || e}`);
    }
  }

  const server = net.createServer((sock) => {
    sock.setNoDelay(true);
    // 帧按顺序办（attach 必须先于后面的 op 生效）；坏行记一笔就过，不掀桌
    let queue = Promise.resolve();
    const push = createDecoder(
      (msg) => { queue = queue.then(() => handle(sock, msg)).catch((e) => log("处理帧炸了：" + ((e && e.message) || e))); },
      (line, e) => writeLine(sock, { ok: false, error: packError(new Error("不是 JSON：" + e.message + " " + line.slice(0, 80))) }),
    );
    sock.on("data", (chunk) => push(chunk.toString("utf8")));
    sock.on("error", (e) => log("连接出错：" + ((e && e.message) || e)));
    sock.on("close", () => {
      if (bridge === sock) {
        bridge = null;
        log(`桥走了。他照说，欠的话记着（现在欠 ${journal.pending()} 条）`);
      }
    });
  });

  async function listen() {
    try { fs.unlinkSync(sockFile); } catch { /* 没有就算了 */ }
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockFile, () => { server.removeListener("error", reject); resolve(); });
    });
    fs.chmodSync(sockFile, 0o600);
  }

  function close() {
    try { server.close(); } catch { /* 无所谓 */ }
    try { fs.unlinkSync(sockFile); } catch { /* 无所谓 */ }
  }

  return { listen, close, pushState, _state: () => ({ attached: !!bridge, pending: journal.pending() }) };
}

async function main() {
  const log = defaultLog;
  const cfg = readConfig(process.env);
  const backend = BOXES[cfg.boxKind];
  if (!backend) throw new Error("不认识这个底座：" + cfg.boxKind);

  const persona = loadPersona(cfg.persona, { name: cfg.personaName });
  const { runtime, box } = await buildBox({ cfg, backend, persona, log });

  const sockFile = process.env.GATE_BOX_SOCKET || path.join(cfg.root, "box.sock");
  const journal = new BoxJournal({ file: path.join(cfg.root, "box-journal.jsonl"), log });

  const served = serveBox({ box, runtime, journal, sockFile, workspaceRoot: cfg.workspaceRoot, model: cfg.model, log });
  await served.listen();

  log(`起来了。他在这儿，桥来连 ${sockFile}`);
  log(`底座 ${cfg.boxKind}　工作目录 ${cfg.workspaceRoot}　会话绑定 ${cfg.bindingKey}`);
  if (journal.pending()) log(`⚠️ 上回还欠着 ${journal.pending()} 条没被桥接走，等桥上来补`);

  const bye = (sig) => {
    log(`收到 ${sig}，关门。欠着的 ${journal.pending()} 条已经落盘，下次起来接着补。`);
    served.close();
    process.exit(0);
  };
  process.on("SIGINT", () => bye("SIGINT"));
  process.on("SIGTERM", () => bye("SIGTERM"));
}

if (require.main === module) {
  main().catch((e) => { console.error("[盒子] 起不来：", e); process.exit(1); });
}

module.exports = { main, serveBox };
