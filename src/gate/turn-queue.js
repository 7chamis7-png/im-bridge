"use strict";

const { TurnStore } = require("./turn-store");

// Exactly one box turn in flight. Route/context is durable before deliver(),
// including boxes which call onReply/onTurnDone before deliver resolves.
function makeTurnQueue({ file, box, onReply, onDone, binding = null, enabled = () => true,
  reconciler = null, log = () => {} }) {
  const store = new TurnStore({ file });
  store.recover();
  let active = null;
  const slots = new Map();
  let stopping = false;
  let lastProgressAt = new Date().toISOString();

  function bind(row, event) {
    if (!event.turnId) return row;
    row = store.update(row.id, { turnId: event.turnId, threadId: event.threadId || row.threadId || "" });
    if (binding && row.route.ok) binding.bind(row.threadId, row.turnId, {
      eventId: row.id, channel: row.route.target.platform, chatId: row.route.target.chat_id,
      accountId: "",
      // Platform-native id of the owner's message (Telegram message_id / WeChat row id),
      // carried through so reactions know which message to target.
      nativeId: (row.envelope && row.envelope.source && row.envelope.source.native_id) || "",
    });
    return row;
  }

  function identify(event) {
    const explicit = event.trace_id ? store.get(event.trace_id) : store.byTurn(event.turnId, event.threadId);
    if (explicit) {
      if (!["submitting", "accepted", "unknown"].includes(explicit.state)) return null;
      if ((explicit.turnId && event.turnId && explicit.turnId !== event.turnId)
        || (explicit.threadId && event.threadId && explicit.threadId !== event.threadId)) {
        log("[轮次] 盒子事件的 trace_id 与轮次回执冲突，拒绝投递");
        return null;
      }
      return bind(explicit, event);
    }
    if (event.trace_id) return null;
    if (active && !active.returned) {
      const row = store.get(active.id);
      if (!row.turnId || row.turnId === event.turnId) return bind(row, event);
    }
    // If the box restarts after a turn was accepted, the CLI (in im-cli) still finishes
    // it, but events replayed to the new box carry no turnId (the turn table lived in
    // the old process). The runtime is strictly serial, so at most one turn can be
    // "submitted, no verdict yet"; when there is exactly one, it owns the event.
    // With two or more we don't guess. Without this the whole reply would be lost.
    if (!event.turnId) {
      const inflight = store.list().filter((r) => ["accepted", "unknown"].includes(r.state));
      if (inflight.length === 1) {
        log("[轮次] 盒子事件没带 turnId，归给唯一在跑的那轮 " + inflight[0].id + "（" + inflight[0].state + "）");
        return bind(inflight[0], event);
      }
    }
    log("[轮次] 收到没有绑定的盒子事件，保留日志、不猜回复地址：" + String(event.turnId || ""));
    return null;
  }

  function finish(slot) {
    if (!slot.returned || !slot.done) return Promise.resolve();
    if (slot.finishPromise) return slot.finishPromise;
    slot.finishPromise = (async () => {
      try {
        await Promise.all(slot.outputs);
        await onDone(store.get(slot.id), slot.done);
        store.update(slot.id, { state: slot.done.failed ? "failed" : "completed", reason: slot.done.reason || "" });
      } catch (e) {
        store.update(slot.id, { state: "unknown", reason: "收尾失败：" + e.message });
        throw e;
      } finally {
        lastProgressAt = new Date().toISOString();
        if (active === slot) active = null;
        slots.delete(slot.id);
        if (!stopping) queueMicrotask(() => { pump().catch((e) => log("[轮次] " + e.message)); });
      }
    })();
    return slot.finishPromise;
  }

  function slotFor(row) {
    if (!slots.has(row.id)) slots.set(row.id, { id: row.id, returned: true, done: null, outputs: [] });
    return slots.get(row.id);
  }

  box.onReply((event) => {
    const row = identify(event);
    if (!row) return;
    const slot = slotFor(row);
    if (slot.done) return; // onTurnDone closes the output stream.
    const index = (row.replyCount || 0) + 1;
    store.update(row.id, { replyCount: index });
    lastProgressAt = new Date().toISOString();
    const output = Promise.resolve().then(() => onReply(store.get(row.id), {
      ...event, outputId: event.outputId || row.id + "-reply-" + index,
    })).catch((e) => { log("[轮次] 输出处理失败：" + e.message); throw e; });
    // Attach a rejection handler even for late events from an interrupted turn.
    output.catch(() => {});
    slot.outputs.push(output);
    return output;
  });

  box.onTurnDone((event) => {
    const row = identify(event);
    if (!row || ["completed", "failed"].includes(row.state)) return;
    const slot = slotFor(row);
    if (slot.done) return;
    slot.done = event;
    finish(slot).catch((e) => log("[轮次] 收尾失败，保留待核对：" + e.message));
  });

  /**
   * After a restart every "submitted, no receipt" turn is unknown, and pump() starts
   * no new turn while any unknown exists - without this the bridge would stall after
   * every restart until someone reconciled by hand.
   *
   * Only the provable half is settled automatically: if the host's reconciler can
   * show evidence (e.g. the outbound ledger shows this turn was delivered), the turn
   * is marked completed. "Proven not run" is never auto-decided - getting that
   * wrong means duplicate delivery, which costs more than waiting for a human.
   */
  async function autoReconcile() {
    if (!reconciler) return [];
    const settled = [];
    for (const row of store.list()) {
      if (row.state !== "unknown" || slots.has(row.id)) continue;
      let verdict = null;
      try { verdict = await reconciler(row); }
      catch (e) { log("[轮次] 自动核对出错，保留待人工：" + e.message); continue; }
      const evidence = String((verdict && verdict.evidence) || "").trim();
      if (!verdict || !evidence) continue;
      if (verdict.done) store.update(row.id, { state: "completed", evidence, reconciledBy: "auto" });
      else if (verdict.notAccepted) store.update(row.id, { state: "queued", evidence, reconciledBy: "auto" });
      else continue;
      settled.push(row.id);
      log("[轮次] 自动核对认定 " + row.id + "：" + evidence);
    }
    return settled;
  }

  async function pump() {
    if (active || stopping || !enabled()) return null;
    // An unacknowledged submission may still be executing in the box. Do not
    // start a later task until that boundary has been reconciled.
    if (store.list().some((r) => r.state === "unknown")) return null;
    const row = store.list().find((r) => r.state === "queued");
    if (!row) return null;
    store.update(row.id, { state: "submitting" });
    const slot = { id: row.id, returned: false, done: null, outputs: [], finishing: false };
    active = slot;
    slots.set(row.id, slot);
    try {
      const result = await box.deliver(row.envelope);
      if (!result || !result.turnId) throw new Error("盒子没有返回轮次回执，接收结果不明");
      bind(store.get(row.id), result);
      store.update(row.id, { state: "accepted" });
      slot.returned = true;
      lastProgressAt = new Date().toISOString();
      if (slot.done) await finish(slot);
      return { taskId: row.id, ...result };
    } catch (e) {
      // Only an explicit rejection proves it is safe to try again. A generic
      // transport error can occur after stdin/IPC accepted the message.
      const rejected = e.notAccepted === true && !slot.done && slot.outputs.length === 0;
      store.update(row.id, { state: rejected ? "rejected" : "unknown", reason: String(e.message || e) });
      await Promise.allSettled(slot.outputs);
      if (active === slot) active = null;
      slots.delete(slot.id);
      log("[轮次] " + row.id + " " + (rejected ? "盒子明确未接收，可重投" : "接收结果不明，等待核对"));
      throw e;
    }
  }

  return {
    store,
    async submit(envelope, route) {
      let { row, duplicate } = store.ensure(envelope, route);
      if (row.state === "rejected") row = store.update(row.id, { state: "queued" });
      if (row.state !== "queued") return { taskId: row.id, turnId: row.turnId, duplicate: true, state: row.state };
      if (active || stopping) return { taskId: row.id, queued: true, duplicate, state: "queued" };
      const result = await pump();
      return result && result.taskId === row.id ? result : { taskId: row.id, queued: true, state: "queued" };
    },
    autoReconcile,
    async recover() { await autoReconcile(); return pump(); },
    context(id) { return id ? store.get(id) : (active ? store.get(active.id) : null); },
    progress() {
      const pending = store.list().filter((r) => ["queued", "submitting", "accepted"].includes(r.state))
        .sort((a, b) => String(a.queuedAt || "").localeCompare(String(b.queuedAt || "")));
      const unknownRows = store.list().filter((r) => r.state === "unknown");
      // Include who/what/why for unknown turns so an alert points straight at the
      // entry to reconcile (ledger = the bridge's turns.json).
      const brief = (r) => {
        const env = r.envelope || {}; const src = env.source || {}; const pl = env.payload || {};
        const text = String(pl.text || "").trim();
        const media = Array.isArray(pl.media) && pl.media.length ? "[" + pl.media.length + " 个附件]" : "";
        return { id: r.id, state: r.state, platform: src.platform || "", queuedAt: r.queuedAt || null,
          text: (text ? text.slice(0, 40) : media) || "(空)", reason: String(r.reason || "").slice(0, 120) };
      };
      return { pending: pending.length, oldestPendingAt: pending[0] ? pending[0].queuedAt : null,
        oldestPending: pending[0] ? brief(pending[0]) : null,
        lastProgressAt, phase: active ? store.get(active.id).state : "idle",
        unknown: unknownRows.length, unknownRows: unknownRows.map(brief), ledger: "turns.json" };
    },
    busy: () => Boolean(active),
    stop() { stopping = true; },
    async idle() {
      while (active) await new Promise((r) => setTimeout(r, 20));
    },
    async reconcile(id, { notAccepted = false, evidence = "" } = {}) {
      const row = store.get(id);
      if (!row || row.state !== "unknown" || !evidence.trim()) throw new Error("只能核对 unknown 轮次，并提供证据");
      if (slots.has(id)) throw new Error("这一轮仍有回复正在收尾，暂不能核对");
      store.update(id, { state: notAccepted ? "queued" : "completed", evidence });
      if (notAccepted) return pump();
      await pump();
      return store.get(id);
    },
  };
}

module.exports = { makeTurnQueue };
