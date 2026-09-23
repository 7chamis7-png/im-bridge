"use strict";

/**
 * Outlet: the bridge's single "send this" entry point.
 *
 * ```
 *   outlet.deliver({ intent, text, args })
 * ```
 *
 * There is no "recipient" parameter at all - not ignored, simply absent. The
 * destination is decided by the routing tiers; delivery decisions never belong
 * to the model.
 *
 * The bridge does not know its callers: tool names, how many there are, and
 * renames are irrelevant. Tools just call this one function.
 *
 * Channel-specific args (Telegram buttons, reply-to...) are classified here:
 *   - supported by this channel -> passed to the plugin
 *   - unsupported               -> text is still sent, but the result states
 *                                  explicitly that the extra did not go out.
 * Dropping them silently is the worst option: the agent believes it sent
 * buttons while the owner only sees plain text.
 */

const { classifyArgs } = require("./surface");

/**
 * @param {object} o
 * @param {object} o.outbound  outbound gate
 * @param {object} o.router    routing tiers
 * @param {function} o.currentTurn  () => {turnId, inbound} - which inbound this turn answers.
 *   The tool process cannot read main-process memory, so the cross-process
 *   variant looks it up on disk (turn-binding).
 * @param {Map} o.plugins      channel -> plugin (needed to classify channel-specific args)
 */
function makeOutlet({ outbound, router, currentTurn, plugins }) {
  if (!outbound || !router || typeof currentTurn !== "function") {
    throw new Error("投递口要 outbound、router 和 currentTurn 三样");
  }

  return {
    /**
     * Send something out.
     *
     * @param {object} o
     * @param {string} o.intent  send_text / send_generated_image / send_sticker /
     *                           send_voice / send_file / react
     * @param {string} [o.text]
     * @param {object} [o.args]  raw tool args. Routing args (channel/chat_id/to...)
     *                           are always dropped and only noted - routing is
     *                           not the caller's decision.
     * @param {string} [o.by]    caller label ("tool" / "command" / producer name).
     *                           "tool" never gets an explicit destination.
     *                           "command" also means these are not the agent's words.
     * @param {object} [o.cold]  `{ write: false, reason }` = don't archive this.
     *                           Defaults from `by`: command receipts (/status,
     *                           /help, /model...) are the bridge talking, and the
     *                           archive (cold layer) only holds real conversation.
     */
    async deliver({ intent = "send_text", text = "", args = {}, by = "tool", taskId = "", outputId = "", cold = null } = {}) {
      const coldPolicy = cold
        || (by === "command" ? { write: false, reason: "bridge_command_receipt" } : null);
      // taskId identifies a saved bridge context, never an arbitrary recipient.
      const { turnId, inbound, route: savedRoute, missing } = currentTurn(taskId) || {};
      if (missing) return { outcome: "blocked", reason: "没有绑定的轮次，不能猜工具回复地址", notes: [] };
      const route = savedRoute || router.resolve({ replyTo: inbound || null, by });
      if (!route.ok) {
        // Tier 5: hold, never guess. Tell the caller it was NOT sent.
        const blocked = await outbound.deliver({ turnId, outputId, intent, text, cold: coldPolicy });
        return { ...blocked, outcome: "blocked", reason: route.reason, policy: route.policy, notes: [] };
      }

      // Routing args: drop them, but record that the caller tried to pick a destination.
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
        // Unsupported extras must be reported so the caller can rephrase.
        unsupportedExtras: unsupported,
      };
    },

    /** Human-readable result. "Not sent" must never look like "sent". */
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
        return `没发出去（一个字都没出去）：${r.reason}。owner 那边什么也没收到，换个法子再说一遍。`;
      }
      return `结果不明（${r.reason || r.state || "unknown"}）。**不要重发** —— `
        + `可能已经发出去了，重发就是同一句话说两遍。等核对。`;
    },
  };
}

module.exports = { makeOutlet };
