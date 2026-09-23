"use strict";

/**
 * Main loop — connects the parts into a bridge.
 *
 *   owner says something
 *     → plugin translation (raw platform record → standard delivery)
 *     → media processing (fetch bytes / store / transcribe / vision)
 *     → inbound gate (verify · identify · number · write cold layer)
 *     → envelope
 *     → box (CLI)
 *   agent replies
 *     → routing (five policies)
 *     → outbound gate (precheck · send · ledger · trace)
 *     → plugin turns it into a platform action
 *
 * It knows neither Telegram nor Claude: plugins and the box are injected at assembly time.
 */

const { makeEnvelope } = require("./envelope");
const { makeReceiver, makeCursorStore, makeDeadLetter } = require("./receiver");
const { makeOutlet } = require("./outlet");
const { makeUndelivered } = require("./undelivered");
const { makeCommands } = require("./commands");
const { makeTurnQueue } = require("./turn-queue");
const path = require("path");

/**
 * Buffered group messages → one body the agent can read.
 *
 * The speaker is written into the body, not an identity field: a group turn's identity is
 * the group (see inbound.identityForTurn).
 */
function renderGroupBatch(unread) {
  return unread.map((m) => {
    const who = String(m.speaker || "").trim() || "某人";
    // Whether a line is from the owner is computed from the real platform id when buffering,
    // never from the nickname (anyone can rename themselves). Brackets are stripped from
    // nicknames at buffer time, so this marker cannot be forged.
    return (m.isOwner ? "[owner] " : "[群友] ") + who + "：" + String(m.text || "");
  }).join("\n");
}

/**
 * Delivery → envelope (command path only).
 *
 * Commands don't enter the box or the cold layer, but they are still owner inbound: the
 * last-active route must follow them, otherwise a command issued in a group would get its
 * receipt in the private chat.
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

/** Inbound event → envelope. Transitional until the inbound gate emits envelopes directly. */
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
 * @param {Map|object} o.plugins  channel name → plugin (must have get())
 * @param {object} o.inbound      inbound gate
 * @param {object} o.outbound     outbound gate
 * @param {object} o.box          the box
 * @param {object} o.router       router (five policies)
 * @param {object} [o.media]      media pipeline; omitted = text only
 * @param {object} [o.groups]     group gate (group.js); omitted = no group messages
 * @param {string} [o.owner]      owner identity name; only used to decide who may run commands
 * @param {function} [o.log]
 */
function makePipeline({ plugins, inbound, outbound, box, router, media = null, undelivered = null,
  groups = null, owner = "owner", binding = null, enabled = () => true, log = () => {},
  closingNote = null }) {
  if (!plugins || typeof plugins.get !== "function") throw new Error("主循环要一份「渠道名 → 插头」的表");
  if (!box) throw new Error("主循环要一个盒子（没有盒子，话送不进去也拿不出来）");
  if (!router) throw new Error("主循环要一个路由（没有路由，回复不知道发给谁）");

  /**
   * Push a turn from outside the bridge (producer drop-box, closing turn before rotation, ...).
   * A function declaration rather than a method: `commands` below already needs it.
   */
  async function pushSystem({ text, producer = "", target = null, id = "" }) {
    const env = makeEnvelope({
      trace_id: id || "sys-" + require("crypto").randomUUID(),
      source: { kind: "system", producer }, payload: { text }, target,
    });
    const result = await queue.submit(env, router.resolve({ explicit: target, by: "producer" }));
    return { ...result, envelope: env };
  }

  /** Commands (the bridge's built-ins). The host can register more; the bridge doesn't know their names. */
  const commands = makeCommands({
    box,
    stats: () => ({ ...stats }),
    undelivered: () => undelivered,
    held: () => held.slice(),
    lastSeen: () => inbound.store.lastSeen(),
    // Before rotating, push a closing turn and wait for it to finish. The bridge doesn't
    // know its content (the host supplies `closingNote`); omitted = rotate directly.
    // The final state of that turn is returned so the receipt can report honestly whether
    // it actually ran (it may be interrupted immediately, e.g. when the old session refuses).
    beforeRotate: closingNote ? async ({ reason }) => {
      const r = await pushSystem({ text: String(closingNote({ reason }) || ""), producer: "换舱收尾" });
      await queue.idle();
      const row = r && r.taskId ? queue.context(r.taskId) : null;
      return { taskId: r && r.taskId, state: (row && row.state) || (r && r.state) || "unknown", reason: (row && row.reason) || "" };
    } : null,
  });
  /** Messages that could not be routed and are held (policy 5: don't guess). Never lost silently. */
  const held = [];
  const stats = { in: 0, blocked: 0, out: 0, silent: 0, heldCount: 0, failed: 0 };
  const queue = makeTurnQueue({
    file: path.join(inbound.store.root, "turns.json"), box, binding, enabled, log,
    // After a restart, turns that were submitted but never acknowledged are reconciled using
    // the outbox ledger as evidence: any outbox operation for the turn proves the box produced
    // a reply. Without evidence they are left for manual review — never assumed "not run".
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
      // The box marked this text as not genuinely the model's (refusal / API error, see the
      // box's `genuine` flag). Still send it — the owner should know the turn was blocked —
      // but keep it out of the cold layer, which only holds real conversation.
      const cold = genuine === false ? { write: false, reason: "not_model_reply" } : null;
      if (cold) log(`[冷层] 跳过一条非模型正文 turnId=${turnId}（已留在事件账本）`);
      if (!route.ok) {
        held.push({ turnId, text, reason: route.reason, at: new Date().toISOString() });
        stats.heldCount += 1;
        // Outbound writes the content and its blocked receipt durably.
        return outbound.deliver({ turnId, text, outputId, cold });
      }
    // The outbound gate still takes the old shape (turn + inboundEvent). The resolved target is
    // wrapped in so it takes the reply-route branch.
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
        // "Has content but couldn't send" must never masquerade as silence; outbound already traced it.
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
     * An inbound message from some leg. The single inbound entry point.
     * @returns {{accepted:boolean, reason?:string, envelope?:object, turnId?:string}}
     */
    async _ingest({ channel, raw, extraMedia = [] }) {
      const plugin = plugins.get(channel);
      if (!plugin) throw new Error("没有这个渠道的插头：" + channel);

      const delivery = await plugin.toDelivery(raw);
      if (extraMedia && extraMedia.length) {
        delivery.media = (Array.isArray(delivery.media) ? delivery.media : []).concat(extraMedia);
      }

      // ——— Groups: allowlist first ———
      // Decisions here, actions in the plugin (plugins only provide the addressing facts). See group.js.
      const isGroup = delivery.chatType && delivery.chatType !== "private";
      if (isGroup) {
        if (!groups) return { accepted: false, reason: "group_not_supported" };
        if (!groups.isAllowed(delivery)) {
          // Non-allowlisted groups are dropped entirely (not buffered) — no storing chat logs for
          // groups the bot was added to. The allowlist check precedes commands.
          stats.groupIgnored = (stats.groupIgnored || 0) + 1;
          return { accepted: false, reason: "group_not_allowed" };
        }
      }

      // ——— Is this "work for the bridge" rather than "talk to the agent"? ———
      // Only registered commands are intercepted; `/something` otherwise goes to the agent.
      // Identity is checked before commands, so strangers can't run /new.
      // Only the speaker's own identity counts, never the group identity — otherwise anyone in
      // a group could run /new.
      // This must run before group batch rendering, which prefixes the body with the speaker
      // and would move the slash away from the start.
      const who = inbound.resolveIdentity(delivery);
      const cmd = who === owner ? commands.match(delivery.text) : null;
      if (cmd) {
        // The receipt goes back where the command was issued (group → group), via the
        // "last active = owner inbound" routing policy (SPEC §4 policy 3).
        router.noteInbound(envelopeFromDelivery(delivery, who));
        const out = await commands.run(cmd);
        stats.commands = (stats.commands || 0) + 1;
        // Commands don't go into the box or the conversation cold layer.
        const commandEnv = envelopeFromDelivery(delivery, who);
        const commandOutlet = makeOutlet({ outbound, router, plugins,
          currentTurn: () => ({ turnId: commandEnv.trace_id, inbound: commandEnv }) });
        // Commands may carry buttons (e.g. a model picker); only Telegram supports them.
        const cmdArgs = Array.isArray(out.buttons) && out.buttons.length ? { inline_keyboard: out.buttons } : {};
        try { await commandOutlet.deliver({ intent: "send_text", text: out.text || "", args: cmdArgs, by: "command" }); }
        catch (e) { log("[命令] 回执发不出去：" + ((e && e.message) || e)); }
        return { accepted: true, command: cmd.name, ok: out.ok !== false, text: out.text };
      }

      if (!isGroup && who === "unknown") {
        stats.blocked += 1;
        return { accepted: false, reason: "unknown_identity" };
      }
      if (media) await media.hydrate(delivery, plugin);

      // ——— Groups: wake · buffer · batch ———
      let groupBatch = null;
      if (isGroup) {
        const d = groups.decide(delivery, { identity: who, ownerIdentity: owner });
        groups.buffer(delivery, {
          speaker: delivery.senderName || delivery.senderId,
          isOwner: who === owner,          // computed from the real id, not the nickname
        });
        if (!d.wake) {
          // Buffered, not dropped: on wake-up the agent sees what happened in between.
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
        // Unknown identity → not delivered; never defaulted to the owner.
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
     * Push a turn from outside the bridge (check-in, reminder, ...). Same path, no channel origin.
     * Whether to push now is the caller's decision (ask `busy()`); this method doesn't decide,
     * so an agent-initiated message isn't silently blocked by a quiet window.
     */
    push: pushSystem,

    /** A bridge notice for the owner (waterline trim / auto-rotation receipts). Sent via the last-active route; not into the box or the cold layer. */
    async tellOwner(text, { by = "bridge" } = {}) {
      const turnId = "sys-" + require("crypto").randomUUID();
      const outlet = makeOutlet({ outbound, router, plugins, currentTurn: () => ({ turnId, inbound: null }) });
      return outlet.deliver({ intent: "send_text", text: String(text || ""), by });
    },

    /**
     * The bridge's single outlet. The tool side only gets this, and it has no "recipient"
     * parameter — the destination cannot be chosen there.
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
     * Is a turn in flight? That's all it answers.
     *
     * Other timing policies belong to producers (e.g. a check-in producer decides itself that
     * "the owner just spoke" means skip). This only guards against technical collisions:
     * pushing a turn mid-reply would scramble the queue and routing.
     */
    busy() {
      return queue.busy() ? { busy: true, why: "盒子正在处理一轮" } : { busy: false, why: "" };
    },
    progress: () => queue.progress(),
    /** Which turn is running (threadId/turnId) — the tool socket uses it to find the turn's origin */
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
    /** Undelivered ledger (failed / unknown sends). */
    undelivered: () => undelivered,
    /** Command table: the host registers its own commands here. */
    commands,
    stats: () => ({ ...stats }),

    /**
     * Attach a self-polling leg: fetch → main loop → box → outbound → send.
     *
     * Cursor and dead-letter paths are provided by the caller. Returns the receiver; the
     * caller decides when to `run()` / `stop()` — the bridge never starts background loops.
     */
    attach({ channel, cursorFile, deadLetterFile, enabled = () => true, log: legLog = log }) {
      const plugin = plugins.get(channel);
      if (!plugin) throw new Error("没有这个渠道的插头：" + channel);
      return makeReceiver({
        plugin,
        cursor: makeCursorStore({ file: cursorFile }),
        deadLetter: makeDeadLetter({ file: deadLetterFile }),
        log: legLog, enabled,
        // Consuming a raw record = running it through the main loop. Only a throw counts as
        // failure (→ dead letter); "blocked: unknown identity" is a completed outcome, not a fault.
        handle: (raw) => api.ingest({ channel, raw }),
      });
    },
  };
  return api;
}

module.exports = { makePipeline, envelopeFromEvent, renderGroupBatch };
