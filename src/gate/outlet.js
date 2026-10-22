"use strict";

/**
 * 投递口 —— 桥对外**唯一**的「我要发这个」（2026-09-18，铁律 2）
 *
 * ```
 *   outlet.deliver({ intent, text, args })
 * ```
 *
 * **参数里没有「发给谁」。** 不是「给了会被忽略」，是**根本没有这个参数** ——
 * 想指定也指定不了。落点由路由五档定（§0.2：投递决策不归模型）。
 *
 * 桥**不认识调用者**：工具叫什么名字、有几个、改不改名、删不删，跟桥没关系。
 * 在这之前桥里有一张「工具收编表」，把 14 个工具名写死在闸里 —— 那违反铁律 2，
 * 已经删掉。工具那边爱叫什么叫什么，调这一个口就行。
 *
 * 专属参数（TG 的按钮、回复某一条…）在这里分类：
 *   · 这个渠道认的 → 交给插头
 *   · 不认的       → **正文照发，但必须明说它没出去，并且进冷层**
 * 悄悄丢掉是最坏的：他以为按钮发出去了，她那头只看到一段白文字。
 */

const { classifyArgs } = require("./surface");

/**
 * @param {object} o
 * @param {object} o.outbound  出闸
 * @param {object} o.router    路由五档
 * @param {function} o.currentTurn  () => {turnId, inbound} —— 本轮是回哪条入站的。
 *   **工具进程读不到主进程内存**，所以跨进程那版要从盘上找回（turn-binding）。
 * @param {Map} o.plugins      渠道名 → 插头（分类专属参数要知道这个渠道认什么）
 */
function makeOutlet({ outbound, router, currentTurn, plugins }) {
  if (!outbound || !router || typeof currentTurn !== "function") {
    throw new Error("投递口要 outbound、router 和 currentTurn 三样");
  }

  return {
    /**
     * 发一个东西出去。
     *
     * @param {object} o
     * @param {string} o.intent  send_text / send_generated_image / send_sticker /
     *                           send_voice / send_file / react
     * @param {string} [o.text]
     * @param {object} [o.args]  工具原参数。里面的 channel/chat_id/to 这类**一律丢弃**，
     *                           只记一笔谁试过 —— 那是投递决策，不归调用方。
     * @param {string} [o.by]    调用者标签（"tool" / "command" / 产生者名字）。
     *                           **"tool" 永远拿不到显式落点**。
     *                           `"command"` 另外还意味着**这不是他说的话** —— 见下。
     * @param {object} [o.cold]  `{ write: false, reason }` = 这条别进冷层。
     *                           不给就按 `by` 推：命令回执（/status /help /model …）
     *                           是**桥自己**在说话，冷层只装真实对话，所以默认不写。
     *                           `pipeline.js` 那行「命令不进盒子、不进对话冷层」
     *                           的注释，到这儿才真的落地。
     */
    async deliver({ intent = "send_text", text = "", args = {}, by = "tool", taskId = "", outputId = "", cold = null } = {}) {
      const coldPolicy = cold
        || (by === "command" ? { write: false, reason: "bridge_command_receipt" } : null);
      // taskId identifies a saved bridge context, never an arbitrary recipient.
      const { turnId, inbound, route: savedRoute, missing } = currentTurn(taskId) || {};
      if (missing) return { outcome: "blocked", reason: "没有绑定的轮次，不能猜工具回复地址", notes: [] };
      const route = savedRoute || router.resolve({ replyTo: inbound || null, by });
      if (!route.ok) {
        // 第 5 档：暂存不猜。**告诉调用方「没发出去」，不许让他以为发了。**
        const blocked = await outbound.deliver({ turnId, outputId, intent, text, cold: coldPolicy });
        return { ...blocked, outcome: "blocked", reason: route.reason, policy: route.policy, notes: [] };
      }

      // 投递决策参数：丢掉，但留一笔 —— 他试过指定渠道这件事本身值得看见
      const ROUTING_ARGS = ["channel", "chatId", "chat_id", "to", "handle", "platform", "target"];
      const tried = ROUTING_ARGS.filter((k) => args && args[k] != null);
      const clean = {};
      for (const [k, v] of Object.entries(args || {})) if (!ROUTING_ARGS.includes(k)) clean[k] = v;

      const { extras, unsupported } = classifyArgs({ args: clean, channel: route.target.platform });
      const notes = [];
      for (const n of unsupported) notes.push({ type: "extra_unsupported", ...n });
      if (tried.length) notes.push({ type: "routing_arg_ignored", args: tried });

      const r = await outbound.deliver({
        turnId, outputId,
        replyToEventId: inbound ? inbound.trace_id : "routed-" + turnId,
        inboundEvent: {
          eventId: inbound ? inbound.trace_id : "routed-" + turnId,
          channel: route.target.platform,
          chatId: route.target.chat_id,
          accountId: "",
        },
        text,
        intent,
        extras,
        toolArgs: clean,
        extraNotes: notes,
        cold: coldPolicy,
      });

      return {
        ...r,
        policy: route.policy,
        // 给不了的专属参数**必须明说** —— 调用方据此决定换个方式说
        unsupportedExtras: unsupported,
      };
    },

    /** 把出闸的结果说成人话。**三种结果都要说清楚，尤其「发不出去」不能长得像「发出去了」。** */
    describe(r) {
      const extra = (r.unsupportedExtras || [])
        .map((n) => `${n.name} 这个渠道（${n.channel}）给不了，只有 ${n.honoredBy.join("/")} 有`).join("；");
      if (r.outcome === "sent") return "发出去了" + (extra ? `。但：${extra}` : "");
      if (r.outcome === "silent") return "本轮没有正文，按你选择不说处理，什么都没发。";
      if (r.outcome === "blocked") {
        return `没发出去：${r.reason}。你说的话已经留在冷层了，换个方式再说一遍。`
          + (extra ? ` 另外：${extra}` : "");
      }
      if (r.state === "not_sent") {
        return `没发出去（一个字都没出去）：${r.reason}。她那边什么也没收到，换个法子再说一遍。`;
      }
      return `结果不明（${r.reason || r.state || "unknown"}）。**不要重发** —— `
        + `可能已经发出去了，重发就是同一句话说两遍。等核对。`;
    },
  };
}

module.exports = { makeOutlet };
