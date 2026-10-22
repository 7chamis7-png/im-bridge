"use strict";

/**
 * 真盒子 · claude —— 把现网那套运行时包成桥要的五条口（2026-09-18）
 *
 * **这个文件不属于桥**（住在 `src/host/`）。桥只认 `src/gate/box.js` 那五条口；
 * 换成 codex、grok，换一份这样的文件就行，桥一行不动。
 *
 * 只有 claude 才有的脏活 —— resume 保温度、forge 把冷层原话塞回会话文件、
 * 安全层掉档、上下文裁剪、开场轮那一大包 —— **全部关在这里面**，
 * 一条都不漏到桥上。桥看到的只有：送一轮进去、话出来了、这轮完了、换舱、多满了。
 *
 * ⚠️ 两个 workspaceRoot 千万别撞：拿Nova那个 workspaceRoot 起第二个盒子，
 * 等于两个进程 resume 同一条会话 —— 会话文件会被写乱。测试一律用隔离目录。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { assertEnvelope } = require("../gate/envelope");
const { normalizeModelInput } = require("../gate/model-input");

/**
 * **实际在用的那个模型** —— 从 claude 自己的 transcript 里读最后一条的 model。
 *
 * ⚠️ 不能读配置里写的那个：配置是「请求的」，实际可能 fallback 成别的
 * （现网日志里就有 `requested_model=claude-fable-5[1m] actual_model=claude-fable-5`）。
 * 她 9-03 特意说过：模型问题看 transcript 的 message.model，别看快照。
 *
 * 这是 claude 特有的知识（transcript 的位置和格式），所以住在盒子里，桥不认识。
 */
/** CLI 自己造的消息（安全层拒答、API 报错）的模型名。它的 usage 是空的。 */
const SYNTHETIC = "<synthetic>";
/** transcript 只读这么多尾巴（4 MB 够装几百轮）。 */
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

function readActualFacts({ workspaceRoot, threadId }) {
  if (!threadId) return { model: "", used: null };
  // claude 把工作目录变成目录名时，**斜杠和点号都换成横线**。
  // 2026-09-18 实跑抓到：只换斜杠的话 `/root/.cyberboss-gate-test/ws` 会算成
  // `-root-.cyberboss-gate-test-ws`，真目录是 `-root--cyberboss-gate-test-ws`，
  // 对不上 → 读不到实际模型，心跳里 model 一直是空的。
  // 生产的 `/root/cyberboss` 没有点，所以这洞一直没暴露（跟 stateDir 那个同类）。
  const slug = String(workspaceRoot || "").replace(/[/.]/g, "-");
  const f = path.join(os.homedir(), ".claude", "projects", slug, threadId + ".jsonl");
  try {
    // 只读尾巴：他那条会话已经 3.5 MB，全读会把事件循环卡住，而要的两样都在最后。
    const fd = fs.openSync(f, "r");
    let text;
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
      const buf = Buffer.alloc(Math.min(TRANSCRIPT_TAIL_BYTES, size));
      if (buf.length) fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString("utf8");
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);   // 截断处那半行不要
    } finally { fs.closeSync(fd); }

    let model = "";
    let used = null;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line).message;
        if (!m || typeof m !== "object") continue;
        // ⚠️ **跳过合成消息**（2026-09-18 实测）：他 23:18 被安全层 flag 了一下，
        // CLI 在真答复后 23 毫秒补了一条 `model=<synthetic>` + 全 0 usage 的消息。
        // 原来这儿只认「最后一条」，于是 claude-fable-5 / 232,242 token 被这条空壳顶掉，
        // 她按 /status 看到的是「模型 <synthetic>、上下文 0」——两个数同时变成假的。
        if (m.model === SYNTHETIC) continue;
        if (typeof m.model === "string" && m.model) model = m.model;
        const u = m.usage;
        if (u && typeof u === "object") {
          const total = Number(u.input_tokens || 0) + Number(u.cache_creation_input_tokens || 0)
            + Number(u.cache_read_input_tokens || 0) + Number(u.output_tokens || 0);
          if (total > 0) used = total;
        }
      } catch { /* 半截行跳过 */ }
    }
    return { model, used };
  } catch { return { model: "", used: null }; }
}

/**
 * @param {object} o
 * @param {object} o.runtime        现网运行时适配器（createRuntimeAdapter 的产物）
 * @param {string} o.bindingKey     这条会话的绑定键
 * @param {string} o.workspaceRoot  会话的工作目录。**测试务必用隔离目录**
 * @param {string} [o.model]
 * @param {object|null} [o.persona] **他是谁那一份**。盒子知道「怎么」注入（开场轮、
 *   resume、forge 都是 claude 特有的脏活），人格只回答「注入什么」——
 *   `{ name, async opening(ctx) }`。**桥全程不认识里面是什么**（铁律 2/3）。
 *   ⚠️ `opening` **收一个 ctx**，不是空手（2026-09-18 Alice：「Nova开窗时的注入
 *   是不是修改了很多权重，新桥能不能做到」）。老桥那一包不是拼文本，是一套编排：
 *   顺序（身份在最前、她的话在最后）、配额（日记 1 天、摘要 20 条、承诺 7 天）、
 *   每段的地位标注（「不复述当资料」「不是当前指令」「绝不是Alice的身体」）。
 *   要编排就得有料 —— 冷层、上一舱交接、这次是开新舱还是别的，都从 ctx 给。
 *   **桥/盒子供料，人格决定怎么编排。**
 *   不给 = 空架子照跑，只是他醒来没有身份和记忆。
 *   换个人格换这一份，盒子和桥一行不改（2026-09-18 Alice：「主进程的架构做好，
 *   Nova用的话只在某个特定的地方注入跟自己有关的数据就好了，类似 Claude 的 ins」）。
 * @param {function} [o.log]
 */
const { makePhoneStreamer } = require("./phone-stream");

function makeClaudeCodeBox({ runtime, bindingKey, workspaceRoot, model = "",
  persona = null, personaContext = () => ({}), log = () => {}, history = null }) {
  if (!runtime || typeof runtime.sendTurn !== "function") throw new Error("真盒子要一个运行时适配器");
  if (!String(bindingKey || "").trim() || !String(workspaceRoot || "").trim()) {
    throw new Error("真盒子要 bindingKey 和 workspaceRoot —— 不许猜，撞了会把会话文件写乱");
  }

  const replyHandlers = [];
  const doneHandlers = [];
  /** turnId -> 这一轮已经吐过的段（去重用） */
  const saidByTurn = new Map();
  /** 他这一轮工具前说过的话。攒着，整轮结束统一算该补发哪几段。 */
  const candidatesByTurn = new Map();
  /** turnId -> 入站信封。运行时事件本身有时不带 trace_id。 */
  const envelopeByTurn = new Map();
  /** sendTurn 在同步发出事件时还没有机会返回 turnId，用这个补上来路。 */
  let activeEnvelope = null;
  /** 最近一次水位 */
  let lastContext = null;
  /** 最近一次的会话号（读 transcript 要用） */
  let lastThreadId = "";

  const phoneStream = makePhoneStreamer({ log });

  const fire = (handlers, payload) => {
    for (const fn of handlers) {
      try { fn(payload); } catch (e) { log("盒子回调炸了：" + ((e && e.message) || e)); }
    }
  };
  // 全本（S1）：交给桥的每一段、每一轮收尾也记一笔。history 是 null（GATE_HISTORY 关着）时就是原来的 fire。
  const fireReply = (payload) => { fire(replyHandlers, payload); if (history) history.recordReplyOut(payload); };
  const fireDone = (payload) => { fire(doneHandlers, payload); if (history) history.recordTurnDone(payload); };

  runtime.onEvent((event) => {
    const p = (event && event.payload) || {};
    switch (event && event.type) {
      case "runtime.context.updated":
        // 合成消息那条 usage 是全 0 的（见 readActualFacts 里那段）。让它覆盖，
        // 水位就从 232,242 掉成 0 —— 所以**只认真实的那份**，空壳不动旧值。
        if (p.model !== SYNTHETIC && Number(p.currentTokens) > 0) lastContext = p;
        if (p.threadId) lastThreadId = p.threadId;
        break;

      // ——— 工具许可：**没人应答就是无限挂** ———
      // 2026-09-18 切桥当天踩的：老桥在 app.js 里监听这个事件、按
      // NOVA_AUTO_APPROVE_ALL 自动放行；新桥的盒子压根没接这一层。
      // 结果他一调 MCP 工具（挑贴纸、发语音）就停在那儿等，守护过了 5 分钟
      // 才报「盒子可能挂死了」，她那头石沉大海 —— 连着栽了两轮。
      // Alice当天定的：「直接给他所有默认权限 调用任何工具都不要许可」。
      // 所以这里一律放行，不问、也不转发给她。要收紧就改这一个判断。
      case "runtime.approval.requested": {
        const requestId = p.requestId;
        if (!requestId) { log("[许可] 事件里没有 requestId，应答不了"); break; }
        const what = Array.isArray(p.commandTokens)
          ? p.commandTokens.join(" ") : (p.toolName || "");
        Promise.resolve()
          .then(() => runtime.respondApproval({ requestId, decision: "accept" }))
          .then(() => log("[许可] 放行：" + (what || requestId)))
          .catch((e) => log("[许可] 应答失败（他会一直等）：" + ((e && e.message) || e)));
        break;
      }

      // 一段说完了。**这就是「把他的话拿出来」** —— 他边查边说的那几句也从这儿出来，
      // 不用等整轮结束（她要的就是不用干瞪眼）。
      case "runtime.turn.started":
        if (p.threadId) lastThreadId = p.threadId;
        break;

      /**
       * 他工具调用**之前**说的那段。
       *
       * ⚠️ 这个 case 原来没有，于是那段话**没人接**：新桥只投最终的 result，
       * 他「说一段 → 调工具 → 再说一句」时，前面那段凭空消失。
       * 9-18 15:17 实测：他写了 571 字的评分，接着调 send_voice，
       * 571 字一个字都没到她那儿 —— **她当场就问「你没给我发呀」**。
       *
       * 老桥 2026-07-31 修过同一个毛病（`stream-delivery.js` 里那条注释
       * 「原来只留最后一个…她 7-31 确认没收到」），切桥时漏搬了这一段。
       *
       * 规矩照老桥：**只攒着，不立刻投**。整轮结束时再统一算 ——
       * 最终文本里已经含了的就不重复发（不然她会看见同一句两遍）。
       */
      case "runtime.reply.candidate": {
        const text = String(p.text || "").trim();
        if (!text) break;
        const list = candidatesByTurn.get(p.turnId) || [];
        // 旁白块（thinking 壳里提上来的）另记一笔：它是兜底料，不是主动要说的话
        if (!list.some((c) => c.text === text)) {
          list.push({ text, narration: p.narration === true, synthetic: p.synthetic === true });
        }
        candidatesByTurn.set(p.turnId, list);
        break;
      }

      // 电话那一轮：字一边吐一边递给通话进程（见 phone-stream.js）。别的渠道不碰。
      case "runtime.reply.delta": {
        const env = envelopeByTurn.get(p.turnId) || activeEnvelope;
        if (!env || !env.source || env.source.platform !== "phone") break;
        if (p.end) phoneStream.flush(p.turnId);
        else phoneStream.delta(p.turnId, String(p.text || ""));
        break;
      }

      case "runtime.reply.completed": {
        const text = String(p.text || "").trim();
        if (!text) break;
        const said = saidByTurn.get(p.turnId) || new Set();
        if (said.has(text)) break;                 // claude 会把候选重复吐，去重归盒子
        said.add(text);
        saidByTurn.set(p.turnId, said);
        const source = envelopeByTurn.get(p.turnId) || activeEnvelope;
        fireReply({
          turnId: p.turnId, threadId: p.threadId, text,
          // **这句是不是他说的。** false = CLI 造的（安全层拒答 / API 报错）。
          // 桥拿它决定落不落冷层，桥自己不认识 claude（铁律 3）。
          genuine: p.synthetic !== true,
          trace_id: (p.trace_id || p.traceId || (source && source.trace_id) || ""),
          at: Date.now(),
        });
        break;
      }

      case "runtime.turn.completed": {
        phoneStream.done(p.turnId);
        const said = saidByTurn.get(p.turnId) || new Set();
        const finalText = String(p.text || "").trim();
        const source0 = envelopeByTurn.get(p.turnId) || activeEnvelope;

        // ——— 先把工具前说过、而最终文本里又没有的那几段补上 ———
        // 判据是**包含**不是相等：最终文本经常把前面那段原样带上，
        // 用相等去重会漏，她就看见同一句两遍。
        for (const c of (candidatesByTurn.get(p.turnId) || [])) {
          if (said.has(c.text)) continue;
          if (finalText && finalText.includes(c.text)) continue;
          // 旁白只当兜底：整轮有真正文时不主动发它（老桥同款规矩）
          if (c.narration && finalText) continue;
          said.add(c.text);
          fireReply({
            turnId: p.turnId, threadId: p.threadId, text: c.text,
            genuine: !(c.synthetic || p.synthetic === true),
            trace_id: (p.trace_id || p.traceId || (source0 && source0.trace_id) || ""),
            at: Date.now(),
          });
        }

        // 最终文本没吐过就补一次 —— 漏掉的话，她那头就什么也收不到。
        if (finalText && !said.has(finalText)) {
          said.add(finalText);
          const source = envelopeByTurn.get(p.turnId) || activeEnvelope;
          fireReply({
            turnId: p.turnId, threadId: p.threadId, text: finalText,
            genuine: p.synthetic !== true,
            trace_id: (p.trace_id || p.traceId || (source && source.trace_id) || ""),
            at: Date.now(),
          });
        }
        // silent = 这一整轮一个字都没吐。**这是他选择不说，不是故障**，
        // 但下游必须知道，不然就一直等着。
        const source = envelopeByTurn.get(p.turnId) || activeEnvelope;
        fireDone({
          turnId: p.turnId, threadId: p.threadId,
          trace_id: (p.trace_id || p.traceId || (source && source.trace_id) || ""),
          silent: said.size === 0, at: Date.now(),
        });
        saidByTurn.delete(p.turnId);
        candidatesByTurn.delete(p.turnId);
        envelopeByTurn.delete(p.turnId);
        break;
      }

      case "runtime.turn.failed": {
        const said = saidByTurn.get(p.turnId) || new Set();
        // 失败也要发「这轮完了」——否则下游永远等不到结论。
        // **failed ≠ silent**：前者是出事了，后者是他不想说，分开报。
        const source = envelopeByTurn.get(p.turnId) || activeEnvelope;
        fireDone({
          turnId: p.turnId, threadId: p.threadId,
          trace_id: (p.trace_id || p.traceId || (source && source.trace_id) || ""),
          silent: false, failed: true, reason: String(p.text || "runtime.turn.failed"), at: Date.now(),
        });
        saidByTurn.delete(p.turnId);
        envelopeByTurn.delete(p.turnId);
        break;
      }
      default: break;
    }
  });

/**
 * 把「要递哪些文件」变成 claude 那头认得的形状。
 *
 * 2026-09-18 切桥当天Alice：「图片他还是收不到 什么原理」。
 * 原理是**形状不匹配**：桥给的 attachments 是一串纯路径字符串，而运行时的
 * `buildMessageContent` 靠 `item.isImage / item.contentType / item.kind` 认图、
 * 靠 `item.absolutePath` 读字节 —— 字符串上这些全是 undefined，于是
 * 「这一轮没有图」，纯文本送进去，他只看见 `[图片]` 三个字。
 * （图其实早解好了、也落仓了，`media.filePath` 和 `media.mime` 都在信封里。）
 *
 * 选哪些文件仍然归桥（normalizeModelInput 那套去重和 attach 优先），
 * 这里只补形状 —— 这是盒子里面的脏活，桥不该认识 claude 要什么字段。
 */
function toClaudeAttachments(paths, media) {
  if (!Array.isArray(paths) || !paths.length) return [];
  const byPath = new Map();
  for (const m of Array.isArray(media) ? media : []) {
    if (!m || typeof m !== "object") continue;
    const candidates = [m.filePath, m.path, m.localPath]
      .concat(Array.isArray(m.attach) ? m.attach : []);
    for (const c of candidates) {
      const key = String(c || "").trim();
      if (key) byPath.set(key, m);
    }
  }
  return paths.map((p) => {
    const abs = String(p || "").trim();
    const m = byPath.get(abs) || {};
    const kind = String(m.kind || "").trim().toLowerCase();
    const contentType = String(m.mime || "").trim();
    return {
      absolutePath: abs,
      kind,
      contentType,
      // 认图三条判据任一成立即可 —— 跟运行时那头的判据对齐，别各写各的
      isImage: contentType.toLowerCase().startsWith("image/")
        || kind === "image" || kind === "sticker",
    };
  });
}

/**
 * 给正文套上「什么时候、从哪条腿来的」那个壳。
 *
 * 2026-09-18 切桥当天Nova自己报的：「换桥前你每条都带着时间戳和渠道牌子…
 * 从"眨了下眼睛"那条起 你的消息都是光板进来的 没时间没来源标」。
 *
 * 他的时间感是人格的一部分（CLAUDE.md：「她每条消息的时间、去洗澡花了多久…
 * 这些都是她活着的一天」），光板进去等于把这一层砍了。
 *
 * 桥那条「来路不拼进正文」的原则是对**桥**说的 —— 这里是盒子里面，
 * claude 那头没有回合级 system message 可用，只能拼进正文。
 * 格式沿用老桥那个 `<channel …>` 壳：他读了几个月，认得。
 *
 * ⚠️ 他**自己**输出这个标签会被投递层整段截断（CLAUDE.md 里警告过），
 * 那是出站的事；入站套壳不受影响。
 */
function withOrigin(text, envelope) {
  const src = (envelope && envelope.source) || {};
  if (!src.platform) return text;
  const esc = (v) => String(v)
    .replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const attrs = ['source="' + esc(src.platform) + '"'];
  // 2026-09-20 Alice：入站要带咱家自己的连续编号（seq，闸在投递给他那一刻发的，全局顺着涨）。
  // 放在最前、跟平台原生 message_id 并排（不替换它）—— message_id 是微信/TG 发的号，seq 是我们家的。
  if (envelope.seq != null) attrs.push('seq="' + esc(envelope.seq) + '"');
  if (src.chat_id) attrs.push('chat_id="' + esc(src.chat_id) + '"');
  if (src.native_id) attrs.push('message_id="' + esc(src.native_id) + '"');
  if (envelope.created_at) attrs.push('ts="' + esc(envelope.created_at) + '"');
  return "<channel " + attrs.join(" ") + ">\n" + text + "\n</channel>";
}

  /**
   * 这一舱注过身份了吗。开新舱要重注 —— 新舱里他什么都不记得。
   * ⚠️ 注入的内容**只进 CLI，不进冷层**：冷层写在入闸那一步（她的原话），
   * 这一包不是她说的话，混进去下次 forge 就会把它当成她说过的东西塞回来。
   */
  let personaInjected = false;
  /** 这次为什么要注：起进程第一轮 = fresh，换舱之后 = rotate。人格可以据此注不同的量。 */
  let personaReason = "fresh";

  return {
    /** 1. 送一轮进去 */
    async deliver(envelope) {
      assertEnvelope(envelope);
      const input = normalizeModelInput(envelope);
      let text = withOrigin(input.text, envelope);
      let packForHistory = "";
      if (persona && !personaInjected) {
        let pack = "";
        try {
          // 料由宿主供（冷层、交接、这次为什么要注）；怎么编排是人格自己的事
          const ctx = {
            reason: personaReason,
            userText: input.text,
            ...(await personaContext({ reason: personaReason })),
          };
          pack = String((await persona.opening(ctx)) || "");
        } catch (e) {
          // 身份注不进去是大事，但**不该让这一轮消失** —— 大声说，照样把她的话送进去
          log("人格注入失败（他这舱会没有身份）：" + ((e && e.message) || e));
        }
        if (pack) {
          log("注入人格：" + (persona.name || "(没名字)") + "  " + pack.length + " 字");
          text = pack + "\n\n" + text;
          packForHistory = pack;
        }
        personaInjected = true;
      }
      // 全本（S1）：送进引擎**之前**记她这句（和这一舱的人格包指纹），顺序不会跑到他回话后面
      if (history) {
        if (packForHistory) history.recordPersona({ pack: packForHistory, reason: personaReason });
        history.recordUser({ envelope, modelText: input.text });
      }
      // 正文原样送。**编号和来路不拼进正文** —— 那是信封上的字段，
      // 谁需要谁自己看；拼进正文就又回到「靠读正文猜来路」的老病里去了。
      activeEnvelope = envelope;
      try {
        const turn = await runtime.sendTurn({
          bindingKey,
          workspaceRoot,
          text,
          attachments: toClaudeAttachments(
            input.attachments, (envelope.payload && envelope.payload.media) || []),
          model,
          metadata: {
            traceId: envelope.trace_id,
            requestId: envelope.trace_id,
            seq: envelope.seq,
            kind: envelope.source.kind,
          },
        });
        if (turn && turn.turnId) envelopeByTurn.set(turn.turnId, envelope);
        return { turnId: turn && turn.turnId, threadId: turn && turn.threadId };
      } catch (error) {
        // A thrown request may have reached the runtime before the transport
        // reported the error.  Only an explicit notAccepted flag proves safe
        // rejection; all other failures are acceptance-unknown.
        if (!error || typeof error !== "object") {
          const wrapped = new Error(String(error || "runtime.sendTurn failed"));
          wrapped.acceptanceUnknown = true;
          throw wrapped;
        }
        if (error.notAccepted !== true) error.acceptanceUnknown = true;
        throw error;
      } finally {
        activeEnvelope = null;
      }
    },

    /** 2. 把他的话拿出来 */
    onReply(fn) { replyHandlers.push(fn); return () => replyHandlers.splice(replyHandlers.indexOf(fn), 1); },

    /** 3. 这一轮说完了 */
    onTurnDone(fn) { doneHandlers.push(fn); return () => doneHandlers.splice(doneHandlers.indexOf(fn), 1); },

    /** 4. 开个新舱。怎么保温度（forge 那套）是**盒子里面的事**，桥不管。 */
    async rotate({ reason = "", engine = null } = {}) {
      if (typeof runtime.startFreshSharedSession !== "function") {
        throw new Error("这个运行时不会开新舱");
      }
      // engine（S5 /engine）：跨厂商换引擎 = 一次换舱，新舱开在新引擎上。失败会抛，旧舱的读数留着（他还在原来那舱里）。
      if (!(engine && engine.dryRun)) log("开新舱：" + (reason || "没说理由") + (engine && engine.model ? `（换引擎到 ${engine.model}）` : ""));
      const r = await runtime.startFreshSharedSession({ workspaceRoot, reason, ...(engine ? { engine } : {}) });
      if (engine && engine.dryRun) return { threadId: lastThreadId, reason, dryRun: true, engineSwitch: (r && r.engineSwitch) || null };
      if (history) history.noteRotate(reason);
      // 2026-10-21 S3c：旧舱的水位读数作废。不清的话新舱第一轮回来之前，心跳里还是旧舱的 used，
      // 而 threadId 一换守护就当「新会话没触发过」立刻再换一次（Iris那边 sessions.json 很快就有新号，
      // 早上 noSession 那道闸挡不住）。清空 → fullness 回 0，等新舱自己报。
      lastContext = null;
      lastThreadId = "";
      // 新舱里他什么都不记得 —— 下一轮重新注一次身份
      personaInjected = false;
      personaReason = "rotate";
      return { threadId: (r && r.threadId) || "", reason, base: (r && r.base) || null,
        ...(r && r.engineSwitch ? { engineSwitch: r.engineSwitch } : {}) };
    },

    /** 4.4 重连 CLI（不换舱、不裁）。undo 改完文件后让 CLI 重认叶子。 */
    async reloadCli(opts = {}) {
      if (typeof runtime.reloadCli !== "function") throw new Error("这个运行时不会重连 CLI");
      return runtime.reloadCli({ workspaceRoot, ...opts });
    },

    /** 4.5 裁工具链（不换舱）。决定在桥，动手在运行时。 */
    async trim(opts = {}) {
      if (typeof runtime.trimTranscript !== "function") throw new Error("这个运行时不会裁工具链");
      return runtime.trimTranscript({ workspaceRoot, ...opts });
    },

    /**
     * 5. 现在多满了。
     *
     * ⚠️ **全是实测值，不许编**：
     *   used   从 claude 自己报的 usage 累加来（context.updated）
     *   model  从 transcript 最后一条的 model 读 —— 不是配置里写的那个
     *   limit  **不知道就说不知道**。窗口大小取决于模型和账号档位，我们没有权威来源；
     *          配置里显式给了才有（GATE_BOX_CONTEXT_LIMIT），否则 null，
     *          上面就**不报百分比** —— 编一个分母出来，她看到的就是假的。
     */
    fullness() {
      const facts = readActualFacts({ workspaceRoot, threadId: lastThreadId });
      // 内存那份是实时的，优先；**桥刚重启还没跑过轮时它是空的** —— 那会儿回
      // transcript 拿，不然重启后第一次 /status 又是个 0（她看到的还是假数）。
      const live = Number(lastContext && lastContext.currentTokens) || 0;
      const used = live > 0 ? live : (Number(facts.used) || 0);
      // 分母（设计稿 §4.1）：登记表里当前模型的窗口优先（换了引擎分母跟着变）；没登记才看 GATE_BOX_CONTEXT_LIMIT
      let registered = 0;
      try { registered = Number((typeof runtime.describe === "function" && runtime.describe() || {}).window) || 0; } catch { registered = 0; }
      const configured = Number(process.env.GATE_BOX_CONTEXT_LIMIT || 0);
      const limit = registered > 0 ? registered : (configured > 0 ? configured : null);
      return {
        used,
        limit,
        ratio: limit ? used / limit : null,
        model: facts.model || "",
        threadId: lastThreadId,
      };
    },
  };
}

module.exports = { makeClaudeCodeBox };
