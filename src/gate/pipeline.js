"use strict";

/**
 * 主循环 —— 把零件串成一座桥（2026-09-18）
 *
 *   她说一句
 *     → 插头翻译（平台原始记录 → 标准交付）
 *     → 媒体加工（取字节 / 落仓 / 转写 / 识图）
 *     → 入闸（验收 · 认人 · 编号 · 写冷层）
 *     → 信封
 *     → 盒子（CLI）
 *   他回一句
 *     → 路由定落点（五档）
 *     → 出闸（预检 · 发 · 记账 · 留痕）
 *     → 插头变成平台动作
 *
 * 在这之前 `src/gate/` 是一堆零件：每个都测过，但没有一条路把它们连起来。
 * 这个文件就是那条路。**它不认识 telegram，也不认识 claude** —— 插头和盒子
 * 都是装配时给的。
 */

const { makeEnvelope } = require("./envelope");
const { makeReceiver, makeCursorStore, makeDeadLetter } = require("./receiver");
const { makeOutlet } = require("./outlet");
const { makeUndelivered } = require("./undelivered");
const { makeCommands } = require("./commands");
const { makeTurnQueue } = require("./turn-queue");
const path = require("path");

/**
 * 攒着的那批群消息 → 一段他看得懂的正文。
 *
 * **谁说的写在正文里**，不走身份字段 —— 群轮的身份是「群」（见 inbound.identityForTurn）。
 * 老桥也是这么做的（buildBatchedChannelTag），这里只是把它搬进共用层。
 */
function renderGroupBatch(unread) {
  return unread.map((m) => {
    const who = String(m.speaker || "").trim() || "某人";
    // **谁是她，由真实平台 id 算出来**（群闸 buffer 时定的），不是看昵称 ——
    // 群里任何人都能把昵称改成「Alice」。老桥那头是 `from_is_alice`，一个道理。
    // 昵称里的方括号在 buffer 时已经剥掉，伪造不出这个标记。
    return (m.isOwner ? "[她本人] " : "[群友] ") + who + "：" + String(m.text || "");
  }).join("\n");
}

/**
 * 交付 → 信封（只给命令那条路用）。
 *
 * 命令不进盒子、不落冷层，但它**是她的一条入站** —— 最近活跃路要跟着它走，
 * 否则在群里下的命令，回执会跑去私聊（第 3 档拿的是上一条入站的来路）。
 */
function envelopeFromDelivery(d, identity) {
  return makeEnvelope({
    trace_id: "cmd-" + (d.nativeId || Date.now()),
    role: "user",
    source: {
      kind: "user", platform: d.channel || "", chat_id: d.chatId || "",
      sender_id: d.senderId || "", native_id: d.nativeId || "",
    },
    identity,
    payload: { text: d.text || "" },
    created_at: d.receivedAt || new Date().toISOString(),
  });
}

/** 入闸的事件 → 信封。过渡用：等入闸本身改成直接产出信封，这个函数就没了。 */
function envelopeFromEvent(event, { producer = "" } = {}) {
  return makeEnvelope({
    trace_id: event.eventId,
    role: "user",
    source: {
      kind: event.channel ? "user" : "system",
      producer,
      platform: event.channel || "",
      chat_id: event.chatId || "",
      sender_id: event.senderId || "",
      native_id: event.nativeId || "",
    },
    identity: event.identity || "unknown",
    verdict: event.verdict || "accepted",
    processing: event.processing || ["none"],
    seq: event.userSeq ?? null,
    payload: { text: event.text || "", media: event.media || [] },
    created_at: event.receivedAt || new Date().toISOString(),
  });
}

/**
 * @param {object} o
 * @param {Map|object} o.plugins  渠道名 → 插头（要有 get()）
 * @param {object} o.inbound      入闸
 * @param {object} o.outbound     出闸
 * @param {object} o.box          盒子（五条口）
 * @param {object} o.router       路由（五档）
 * @param {object} [o.media]      媒体流水线；不给就只走文本
 * @param {object} [o.groups]     群闸（group.js）。不给 = 这座桥不收群消息
 * @param {string} [o.owner]      她的身份名。**只用来判「谁有资格下命令」**
 * @param {function} [o.log]
 */
function makePipeline({ plugins, inbound, outbound, box, router, media = null, undelivered = null,
  groups = null, owner = "alice", binding = null, enabled = () => true, log = () => {},
  closingNote = null }) {
  if (!plugins || typeof plugins.get !== "function") throw new Error("主循环要一份「渠道名 → 插头」的表");
  if (!box) throw new Error("主循环要一个盒子（没有盒子，话送不进去也拿不出来）");
  if (!router) throw new Error("主循环要一个路由（没有路由，他的话不知道发给谁）");

  /**
   * 桥外面的东西推一轮进来（生产者投递口、换舱收尾…）。
   * 函数声明而不是对象方法：`commands` 在它上面就要用到它（换舱前的收尾轮）。
   */
  async function pushSystem({ text, producer = "", target = null, id = "" }) {
    const env = makeEnvelope({
      trace_id: id || "sys-" + require("crypto").randomUUID(),
      source: { kind: "system", producer }, payload: { text }, target,
    });
    const result = await queue.submit(env, router.resolve({ explicit: target, by: "producer" }));
    return { ...result, envelope: env };
  }

  /** 命令（桥自己能干的那几件）。宿主可以往上注册自己的，桥不认识它们叫什么。 */
  const commands = makeCommands({
    box,
    stats: () => ({ ...stats }),
    undelivered: () => undelivered,
    held: () => held.slice(),
    lastSeen: () => inbound.store.lastSeen(),
    // 关舱前先送一轮进去，**等他做完再换**（2026-09-19）。
    // ⚠️ **桥不认识那一轮里写的是什么**（铁律 2/3）：正文由宿主给（`closingNote`），
    // 桥只负责「换舱之前先 push 一轮、等它跑完」。不给就没有这一步，照旧直接换。
    // 2026-09-21：不再只 push 就算数。今天 12:39 那次收尾轮 0.1 秒就被 CLI 中断（旧舱在拒答），
    // 桥却报「他收了尾，用时 0 秒」。现在等它真跑完，把这一轮的最终状态交回去，让回执如实说。
    beforeRotate: closingNote ? async ({ reason }) => {
      const r = await pushSystem({ text: String(closingNote({ reason }) || ""), producer: "换舱收尾" });
      await queue.idle();
      const row = r && r.taskId ? queue.context(r.taskId) : null;
      return { taskId: r && r.taskId, state: (row && row.state) || (r && r.state) || "unknown", reason: (row && row.reason) || "" };
    } : null,
  });
  /** 发不出去、暂存下来的那些（第 5 档：不猜）。**不许无声丢失。** */
  const held = [];
  const stats = { in: 0, blocked: 0, out: 0, silent: 0, heldCount: 0, failed: 0 };
  const queue = makeTurnQueue({
    file: path.join(inbound.store.root, "turns.json"), box, binding, enabled, log,
    // 重启后「提交了但没等到回执」的那些，用出站账本当证据自动认掉能认的那一半：
    // 出站账本里只要有这一轮的操作，就说明盒子对这一轮产出过回复（`outbox.create`
    // 发生在 onReply → deliver 的路上）。查不到就原样留着等人核对，绝不反向判「没跑」。
    reconciler: (row) => {
      const outbox = outbound && outbound.outbox;
      if (!row.turnId || !outbox || typeof outbox.all !== "function") return null;
      const op = outbox.all().find((o) => o.turnId === row.turnId);
      if (!op) return null;
      return { done: true,
        evidence: "出站账本里有这一轮的投递记录 operationId=" + op.operationId + "（状态 " + op.state + "）" };
    },
    onReply: async (task, { turnId, text, outputId, genuine }) => {
      const inbEnv = task.envelope;
      const route = task.route;
      // 盒子说这句**不是他说的**（安全层拒答 / API 报错，见 gate-box 的 genuine）。
      // 照发 —— 她得知道他这轮被挡了；但不进冷层，冷层只装真实对话。
      // 桥不判断「为什么不是」，那是盒子的活（铁律 3）。
      const cold = genuine === false ? { write: false, reason: "not_model_reply" } : null;
      if (cold) log(`[冷层] 跳过一条非模型正文 turnId=${turnId}（已留在事件账本）`);
      if (!route.ok) {
        held.push({ turnId, text, reason: route.reason, at: new Date().toISOString() });
        stats.heldCount += 1;
        // Outbound writes the content and its blocked receipt durably.
        return outbound.deliver({ turnId, text, outputId, cold });
      }
    // 出闸吃的还是旧形状（turn + inboundEvent）。路由解析出来的落点包装进去，
    // 让它走「原路返回」那一支 —— 等出闸改成直接吃信封，这层包装就没了。
    const turn = {
      turnId, outputId,
      replyToEventId: inbEnv ? inbEnv.trace_id : "routed-" + turnId,
      inboundEvent: {
        eventId: inbEnv ? inbEnv.trace_id : "routed-" + turnId,
        channel: route.target.platform,
        chatId: route.target.chat_id,
        accountId: "",
      },
      text,
      intent: "send_text",
      cold,
    };
    try {
      const r = await outbound.deliver(turn);
      if (r.outcome === "sent") stats.out += 1;
      else if (r.outcome === "silent") stats.silent += 1;
      else {
        stats.failed += 1;
        // 「有内容但发不出去」绝不许伪装成沉默 —— 出闸自己已经留痕，这里只记日志。
        log(`[主循环] 没发出去 outcome=${r.outcome} reason=${r.reason || ""}`);
      }
      return r;
    } catch (e) {
      stats.failed += 1;
      log(`[主循环] 出闸炸了：${(e && e.message) || e}`);
      throw e;
    }
    },
    onDone: async (task, { turnId, silent, failed, reason }) => {
      if (failed) {
        stats.failed += 1;
        inbound.store.appendEvent({ kind: "turn.failed", trace_id: task.id, turnId, reason });
      } else if (silent) {
        stats.silent += 1;
        await outbound.deliver({ turnId, text: "", outputId: task.id + "-silent" });
      }
    },
  });

  let ingestTail = Promise.resolve();
  const api = {
    // All channels use the same preparation/numbering lane. Media latency cannot
    // let another input overtake this one inside the bridge.
    ingest(input) {
      const pending = ingestTail.then(() => api._ingest(input));
      ingestTail = pending.catch(() => {});
      return pending;
    },
    /**
     * 她说了一句（或某条腿捞上来一条）。**这是入站唯一入口。**
     * @returns {{accepted:boolean, reason?:string, envelope?:object, turnId?:string}}
     */
    async _ingest({ channel, raw, extraMedia = [] }) {
      const plugin = plugins.get(channel);
      if (!plugin) throw new Error("没有这个渠道的插头：" + channel);

      const delivery = await plugin.toDelivery(raw);
      if (extraMedia && extraMedia.length) {
        delivery.media = (Array.isArray(delivery.media) ? delivery.media : []).concat(extraMedia);
      }

      // ——— 群那一套：白名单先过 ———
      // 决定在这儿，动作在插头（插头只交出 addressing 那几个事实）。见 src/gate/group.js。
      const isGroup = delivery.chatType && delivery.chatType !== "private";
      if (isGroup) {
        if (!groups) return { accepted: false, reason: "group_not_supported" };
        if (!groups.isAllowed(delivery)) {
          // 不在白名单的群**整条不要**，也不攒 —— 免得被拉进陌生群还替人存着聊天记录。
          // 白名单必须在命令之前：陌生群里的 /new 连看都不该看一眼。
          stats.groupIgnored = (stats.groupIgnored || 0) + 1;
          return { accepted: false, reason: "group_not_allowed" };
        }
      }

      // ——— 这句话是不是「让桥干活」而不是「跟他说话」 ———
      // ⚠️ 只拦**注册过的**命令。她发 `/想你了` 绝不能因为有个斜杠就被吞掉。
      // ⚠️ **先认人再看命令**（2026-09-18 测试当场抓到的安全洞）：
      // 原来命令层在入闸之前跑，任何陌生人发一句 /new 就能把他的舱换掉。
      // ⚠️⚠️ 而且**只认发言人本人，不认群身份** —— 群轮的身份是「群」，
      // 拿它当门票，等于群里随便谁一句 /new 就能把他的舱换掉（同一个洞的群版）。
      // ⚠️⚠️⚠️ **必须在群批量渲染之前**：渲染会把正文包成「[她本人] Alice：/status」，
      // 斜杠不在开头，命令当场失效。老桥也是先认命令再攒群消息（listener.js 的顺序）。
      const who = inbound.resolveIdentity(delivery);
      const cmd = who === owner ? commands.match(delivery.text) : null;
      if (cmd) {
        // 命令的回执该回到她下命令的地方 —— 在群里下的就回群里。
        // 靠的是「最近活跃路只算她的入站」那一档（SPEC §4 第 3 档），不是给投递口加参数。
        router.noteInbound(envelopeFromDelivery(delivery, who));
        // 命令不进盒子、不进对话冷层 —— 那不是跟他说的话。
        const commandEnv = envelopeFromDelivery(delivery, who);
        const commandOutlet = makeOutlet({ outbound, router, plugins,
          currentTurn: () => ({ turnId: commandEnv.trace_id, inbound: commandEnv }) });
        // 慢命令先垫一句（/engine：「排上了，等这一轮说完」），回执照旧在最后
        const say = async (text) => {
          try { await commandOutlet.deliver({ intent: "send_text", text: String(text || ""), args: {}, by: "command" }); }
          catch (e) { log("[命令] 先垫的那句发不出去：" + ((e && e.message) || e)); }
        };
        const out = await commands.run(cmd, { say });
        stats.commands = (stats.commands || 0) + 1;
        // 命令可以带一排按钮（`/model` 弹模型选单）；只有 TG 认，别的渠道出闸会明说没带上。
        const hasButtons = Array.isArray(out.buttons) && out.buttons.length;
        const canButtons = require("./surface").PLUGIN_EXTRAS.inline_keyboard.includes(channel);
        const cmdArgs = hasButtons && canButtons ? { inline_keyboard: out.buttons } : {};
        // 没按钮的渠道（微信/iMessage）把选项写成文字，照着手打（10-21 Alice）
        const cmdText = (out.text || "") + (hasButtons && !canButtons ? buttonsAsText(out.buttons) : "");
        try { await commandOutlet.deliver({ intent: "send_text", text: cmdText, args: cmdArgs, by: "command" }); }
        catch (e) { log("[命令] 回执发不出去：" + ((e && e.message) || e)); }
        return { accepted: true, command: cmd.name, ok: out.ok !== false, text: out.text };
      }

      if (!isGroup && who === "unknown") {
        stats.blocked += 1;
        return { accepted: false, reason: "unknown_identity" };
      }
      if (media) await media.hydrate(delivery, plugin);

      // ——— 群那一套：叫醒 · 攒着 · 批量 ———
      let groupBatch = null;
      if (isGroup) {
        const d = groups.decide(delivery, { identity: who, ownerIdentity: owner });
        groups.buffer(delivery, {
          speaker: delivery.senderName || delivery.senderId,
          isOwner: who === owner,          // ← 真实 id 算出来的，不是昵称
        });
        if (!d.wake) {
          // **不是丢掉，是攒着。** 他醒来那一刻要看见这中间发生了什么。
          stats.groupBuffered = (stats.groupBuffered || 0) + 1;
          return { accepted: true, buffered: true, reason: d.reason,
            unread: groups.unreadCount(delivery) };
        }
        groupBatch = typeof groups.peekUnread === "function"
          ? groups.peekUnread(delivery) : groups.takeUnread(delivery);
        delivery.text = renderGroupBatch(groupBatch);
        delivery.media = groupBatch.flatMap((item) => Array.isArray(item.media) ? item.media : []);
        stats.groupWoke = (stats.groupWoke || 0) + 1;
      }

      const res = inbound.accept(delivery);
      stats.in += 1;
      if (!res.accepted) {
        // 认不出人就不投递 —— **绝不硬填成她**。
        stats.blocked += 1;
        return { accepted: false, reason: "unknown_identity", event: res.event };
      }
      const env = envelopeFromEvent(res.event);
      // A duplicate registration does not prove the box accepted the task.
      if (who === owner) router.noteInbound(env);
      const result = await queue.submit(env, router.resolve({ replyTo: env }));
      if (groupBatch && typeof groups.ackUnread === "function") {
        groups.ackUnread(delivery, groupBatch.map((item) => item.nativeId).filter(Boolean));
      }
      return { accepted: true, envelope: env, event: res.event, ...result };

    },

    /**
     * 桥外面的东西推一轮（check-in、提醒…）。走同一条路，只是没有渠道来路。
     * ⚠️ **要不要现在推由调用方判断**（拿 `busy()` 问一句）—— 这儿不替它决定，
     * 否则「他自己想说话」这种也会被静默窗挡掉，而那不该挡。
     */
    push: pushSystem,

    /** 桥自己有话跟她说（水位裁剪/自动换舱的回执）。走她最近活跃的那条路，不进盒子、不进冷层。 */
    async tellOwner(text, { by = "bridge" } = {}) {
      const turnId = "sys-" + require("crypto").randomUUID();
      const outlet = makeOutlet({ outbound, router, plugins, currentTurn: () => ({ turnId, inbound: null }) });
      return outlet.deliver({ intent: "send_text", text: String(text || ""), by });
    },

    /**
     * **桥对外唯一的投递口**（铁律 2）。工具那侧只拿这个，
     * 参数里没有「发给谁」—— 想指定也指定不了。
     */
    outlet: makeOutlet({
      outbound, router, plugins,
      currentTurn: (taskId) => {
        const task = queue.context(taskId);
        if (!task) return { missing: true };
        return { turnId: task.turnId || task.id, inbound: task.envelope, route: task.route };
      },
    }),

    /**
     * 现在有没有轮在飞。**只答这个。**
     *
     * 别的时机判断**归生产者自己** —— 比如「她刚说过话，这次 check-in 没意义」
     * 是在 `src/producers/checkin.js` 里判的，投都不投（Alice 2026-09-18：
     *「是从脚本那里就直接丢掉」）。桥不认识各个生产者的时机策略。
     *
     * 这里只挡**技术撞车**：他正说着话再塞一轮进去，排队会乱、来路会串。
     */
    busy() {
      return queue.busy() ? { busy: true, why: "盒子正在处理一轮" } : { busy: false, why: "" };
    },
    progress: () => queue.progress(),
    /** 现在在跑的是哪一轮（threadId/turnId）—— 工具口靠它找这轮的来路 */
    activeTurn: () => {
      const row = queue.context();
      return row ? { threadId: row.threadId || "", turnId: row.turnId || "" } : null;
    },
    tasks: () => queue.store.list(),
    recover: () => queue.recover(),
    reconcile: (id, evidence) => queue.reconcile(id, evidence),
    async stop() {
      queue.stop();
      await ingestTail;
      await queue.idle();
    },

    held: () => held.slice(),
    /** 没送到的账（发不出去 / 不知道发没发）。不给就没有。 */
    undelivered: () => undelivered,
    /** 命令表：宿主往这儿注册自己的命令，桥不认识它们叫什么。 */
    commands,
    stats: () => ({ ...stats }),

    /**
     * 给某条腿装上「自己去捞」。装完这条腿就是活的：
     * 捞 → 主循环 → 盒子 → 出闸 → 发回去，中间不用人手喂。
     *
     * 游标和死信的路径**由调用方给**（铁律 1）。返回收信人，调用方决定
     * 什么时候 `run()`、什么时候 `stop()` —— 桥不自己起后台循环。
     */
    attach({ channel, cursorFile, deadLetterFile, enabled = () => true, log: legLog = log }) {
      const plugin = plugins.get(channel);
      if (!plugin) throw new Error("没有这个渠道的插头：" + channel);
      return makeReceiver({
        plugin,
        cursor: makeCursorStore({ file: cursorFile }),
        deadLetter: makeDeadLetter({ file: deadLetterFile }),
        log: legLog, enabled,
        // 一条原始记录怎么消化 = 走主循环。**抛错才算没消化成**（进死信）；
        // 「认不出人挡下了」不抛错 —— 那是处理完了的结论，不是故障。
        handle: (raw) => api.ingest({ channel, raw }),
      });
    },
  };
  return api;
}

/** 按钮 → 文字选项（每行一条：「标签：/命令 参数」）。没有 callback_data 的跳过。 */
function buttonsAsText(rows) {
  const lines = [];
  for (const row of rows) for (const b of (Array.isArray(row) ? row : [row])) {
    if (b && b.callback_data) lines.push(`  ${b.text || ""}：${b.callback_data}`);
  }
  return lines.length ? "\n\n可选（照着发）：\n" + lines.join("\n") : "";
}

module.exports = { buttonsAsText, makePipeline, envelopeFromEvent, renderGroupBatch };
