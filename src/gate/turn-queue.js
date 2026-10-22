"use strict";

const { TurnStore } = require("./turn-store");

// Exactly one box turn in flight. Route/context is durable before deliver(),
// including boxes which call onReply/onTurnDone before deliver resolves.
// 2026-10-22：盒子明确拒收（notAccepted）之后的自动重投参数。
// 以前拒收 = 行状态 rejected + 抛给收信人进死信，全仓没有任何地方会再捡起它（生产死信里躺着她 4 句话）。
// 现在 pump 自己重投：最多 maxAttempts 次，间隔从 baseMs 起翻倍、封顶 capMs；
// 次数用完转 unknown（堵住队列 + 守护推给她），由她用 /pending 决定，不再无限重来。
const RETRY_DEFAULTS = Object.freeze({ maxAttempts: 5, baseMs: 5_000, capMs: 5 * 60_000 });

function makeTurnQueue({ file, box, onReply, onDone, binding = null, enabled = () => true,
  reconciler = null, log = () => {}, retry = {}, now = () => Date.now() }) {
  const store = new TurnStore({ file });
  store.recover();
  const retryCfg = { ...RETRY_DEFAULTS, ...(retry || {}) };
  let retryTimer = null;
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
      // 她那条在平台上的号（TG 的 message_id / 微信的行号）。2026-09-20 加：
      // 点表情要知道点哪一条，而这个号一路从入站带到这儿，以前到这就断了。
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
    // 2026-09-20 17:39 踩过：盒子在一轮被接收之后重启，CLI（在 nova-cli 里）照常把那轮跑完，
    // 新盒子补发回来的事件**带不出 turnId**（轮次表在旧进程里）。运行时严格串行，桥这头
    // 「提交了还没结论」的最多只有一条 —— 恰好一条时它就是主人。有事件 = 证明跑过，
    // 属于「只认能证明已经跑完的那一半」；两条以上照旧不猜。少了这一步她少收他一整段话。
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
   * 重启之后，所有「提交过但没等到回执」的轮次都是 unknown，而 pump 见到任何一条
   * unknown 就不再开新轮 —— 没有这一步的话，桥每重启一次就停摆到有人手工核对为止。
   *
   * 这里只认**能证明已经跑完**的那一半：宿主给的 reconciler 拿得出平台回执
   * （比如出站账本里这一轮确实发出去过），就认它完成。证明不了就原样留着等人。
   * 「证明没跑」永远不自动判 —— 那一侧判错就是重复投递，代价比等人高。
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

  /** 退避到点了再敲一下 pump。宿主每秒的 recover() 也会捡，这个只是不依赖它。 */
  function scheduleRetry(at) {
    if (stopping) return;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      pump().catch((e) => log("[轮次] 自动重投：" + e.message));
    }, Math.max(0, at - now()));
    if (retryTimer.unref) retryTimer.unref();
  }

  /**
   * 下一条该投的。2026-10-22 改：rejected 且标了 autoRetry 的也算（到点才投）。
   * **按入队顺序**：最前面那条还在退避里，后面的也不越过它 —— 不打乱她说话的顺序，
   * 而且盒子刚拒收过，后面那条多半也会被拒。
   * 没标 autoRetry 的 rejected 是这次改动之前留下的旧账（可能是几天前的话），
   * 不自动重投、也不挡队列，只在 /pending 里列出来让她决定。
   */
  function nextRow() {
    const head = store.list().find((r) => r.state === "queued" || (r.state === "rejected" && r.autoRetry));
    if (!head) return null;
    if (head.state === "rejected") {
      const at = Date.parse(head.retryAt || "") || 0;
      if (at > now()) { scheduleRetry(at); return null; }
    }
    return head;
  }

  async function pump() {
    if (active || stopping || !enabled()) return null;
    // An unacknowledged submission may still be executing in the box. Do not
    // start a later task until that boundary has been reconciled.
    if (store.list().some((r) => r.state === "unknown")) return null;
    const row = nextRow();
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
      const reason = String(e.message || e);
      if (!rejected) {
        store.update(row.id, { state: "unknown", reason });
      } else {
        // 2026-10-22：明确拒收 → 记次数、排下一次重投；次数用完转 unknown 等她决定。
        const attempts = (Number(store.get(row.id).attempts) || 0) + 1;
        if (attempts >= retryCfg.maxAttempts) {
          store.update(row.id, { state: "unknown", attempts, exhausted: true, retryAt: null,
            reason: "盒子连续 " + attempts + " 次明确拒收（确定没送进去）：" + reason });
        } else {
          const wait = Math.min(retryCfg.baseMs * 2 ** (attempts - 1), retryCfg.capMs);
          const retryAt = new Date(now() + wait).toISOString();
          store.update(row.id, { state: "rejected", attempts, autoRetry: true, retryAt, reason });
          scheduleRetry(now() + wait);
        }
      }
      await Promise.allSettled(slot.outputs);
      if (active === slot) active = null;
      slots.delete(slot.id);
      const after = store.get(row.id);
      log("[轮次] " + row.id + " " + (!rejected ? "接收结果不明，等待核对"
        : after.state === "rejected" ? "盒子明确未接收，第 " + after.attempts + " 次，" + after.retryAt + " 自动重投"
          : "盒子明确未接收，已重投 " + after.attempts + " 次仍不行，转为待人工（/pending）"));
      throw e;
    }
  }

  return {
    store,
    async submit(envelope, route) {
      let { row, duplicate } = store.ensure(envelope, route);
      if (row.state === "rejected") row = store.update(row.id, { state: "queued", retryAt: null });
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
      const rejectedRows = store.list().filter((r) => r.state === "rejected");
      // 2026-09-20：守护只报「有 1 条不明」害我们找了 40 分钟找错账本。把那条是谁、说了啥、
      // 为什么不明一起带出去，看一眼报警就知道该去哪儿核对（账本 = 桥的 turns.json）。
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
        unknown: unknownRows.length, unknownRows: unknownRows.map(brief),
        // 2026-10-22：拒收待重投的也摆出来（/status 和守护都看得见），不算进 pending —— /undo 停收等的是 pending 归零。
        rejected: rejectedRows.length, ledger: "turns.json" };
    },
    busy: () => Boolean(active),
    stop() { stopping = true; if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } },
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

    /**
     * 她用 /pending retry 放行（2026-10-22）。unknown 是「不知道盒子收没收」—— 只有她能拍板重投，
     * 重投可能让他把同一句回两遍，这个代价她点了按钮就是认了；rejected 是确定没收，放行等于立刻重投。
     * 次数清零、排回原位（入队顺序没变，所以它在后面那些前头）。**不在这里等投递**：
     * 命令跑在入站那条串行道上，等盒子会把她后面的话也堵住 —— 返回 kick 让调用方自己决定等不等。
     */
    retry(id, { evidence = "她用 /pending 放行重投" } = {}) {
      const row = store.get(id);
      if (!row || !["unknown", "rejected"].includes(row.state)) throw new Error("这一轮现在不是卡住/拒收状态，不用放行");
      if (slots.has(id)) throw new Error("这一轮仍有回复正在收尾，暂不能放行");
      store.update(id, { state: "queued", attempts: 0, exhausted: false, retryAt: null, autoRetry: true,
        evidence, reconciledBy: "owner" });
      const kick = pump();
      kick.catch((e) => log("[轮次] 放行后重投：" + e.message));
      return { row: store.get(id), kick };
    },

    /**
     * 她用 /pending drop 确认放弃（2026-10-22）：标成终态 failed（dropped），不再堵队列，后面的接着走。
     * 不标 completed —— 那等于说「他回过了」，账上不能撒这个谎。
     */
    drop(id, { evidence = "她用 /pending 确认放弃" } = {}) {
      const row = store.get(id);
      if (!row || !["unknown", "rejected"].includes(row.state)) throw new Error("这一轮现在不是卡住/拒收状态，没什么可放弃的");
      if (slots.has(id)) throw new Error("这一轮仍有回复正在收尾，暂不能放弃");
      store.update(id, { state: "failed", dropped: true, retryAt: null, evidence, reconciledBy: "owner",
        reason: "她确认放弃（/pending drop）；原因：" + String(row.reason || "").slice(0, 200) });
      const kick = pump();
      kick.catch((e) => log("[轮次] 放弃之后接着投：" + e.message));
      return { row: store.get(id), kick };
    },
  };
}

module.exports = { makeTurnQueue };
