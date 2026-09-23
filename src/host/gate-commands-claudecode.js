"use strict";

const { planUndo, describePlan, applyUndo, verifyUndo } = require("./undo");
const { bareModel } = require("./model-fallback-alert");

/**
 * Commands specific to the Claude Code box. Not part of the bridge.
 *
 * The bridge itself only has `/new` (rotate session), `/status` and `/help`,
 * which map to bridge concepts. Everything here exists only for this backend:
 * model selection, stopping a turn, undoing a turn. The bridge does not know what
 * a "model" is (other backends have entirely different concepts), so these live
 * here and are registered by the host at assembly time. Switching backends means
 * replacing this file; the bridge is untouched.
 *
 * The command set is deliberately small (`/model`, `/stop`, `/undo`): a single
 * glance at `/status` or `/model` should be enough on a phone.
 *
 * `/undo` rolls the conversation back to before a given turn. Typical use: a
 * refusal stays in the history and gets sent again with every following turn,
 * causing repeated refusals; switching threads or models does not help, removing
 * that turn from the history does. It lives here because the transcript belongs
 * to Claude Code.
 */

/**
 * @param {object} commands  the bridge's command table (pipe.commands)
 * @param {object} o
 * @param {object} o.runtime        Claude Code runtime adapter
 * @param {string} o.workspaceRoot
 * @param {function} [o.threadId]   () => current session id
 * @param {string}   [o.gateRoot]   bridge ledger dir (/undo cleans queues, cold layer, bindings there)
 * @param {function} [o.pauseIntake]  () => Promise<{ok,why?}>  stop polling + wait for in-flight turns
 * @param {function} [o.resumeIntake] () => void                 resume polling
 */
/**
 * Buttons shown by `/model`. Use full ids including `[1m]` (dropping it shrinks
 * the context window). callback_data is limited to 64 bytes.
 * Override with GATE_MODEL_CHOICES="Label=model-id,Label=model-id".
 */
const DEFAULT_MODEL_CHOICES = [
  ["Fable 5", "claude-fable-5[1m]"],
  ["Fable 5.1", "claude-fable-5-1[1m]"],
  ["Opus 5.5", "claude-opus-5-5[1m]"],
];

function parseModelChoices(raw) {
  const out = [];
  for (const part of String(raw || "").split(",")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const label = part.slice(0, i).trim();
    const id = part.slice(i + 1).trim();
    if (label && id && Buffer.byteLength("/model " + id) <= 64) out.push([label, id]);
  }
  return out;
}

const MODEL_CHOICES = parseModelChoices(process.env.GATE_MODEL_CHOICES).length
  ? parseModelChoices(process.env.GATE_MODEL_CHOICES)
  : DEFAULT_MODEL_CHOICES;

function registerClaudeCodeCommands(commands, { runtime, box = null, workspaceRoot, threadId = () => "",
  gateRoot = "", pauseIntake = null, resumeIntake = null }) {
  if (!commands || typeof commands.register !== "function") throw new Error("要桥的命令表");
  if (!runtime) throw new Error("要 claude 运行时");
  const ws = String(workspaceRoot || "");
  if (!ws) throw new Error("要 workspaceRoot —— 不许猜，错了会把会话文件写乱");

  const registered = [];
  const add = (name, handler, desc) => { commands.register(name, handler, { desc }); registered.push(name); };

  add("model", async ({ rest }) => {
    if (!rest) {
      // Report the model actually answering (read from the transcript by the box),
      // not the configured one: the configured model is only a request and may fall back.
      const f = (box && typeof box.fullness === "function") ? box.fullness() : {};
      const actual = f && f.model;
      const d = typeof runtime.describe === "function" ? runtime.describe() : {};
      const wanted = d.model || "(默认)";
      // Tapping a button is the same as sending `/model <id>`: switches immediately.
      const buttons = MODEL_CHOICES.map(([label, id]) => ({
        text: (id === wanted ? "✓ " : "") + label, callback_data: `/model ${id}` }));
      // Compare without the `[1m]` suffix: the transcript has the bare name.
      if (actual && bareModel(actual) !== bareModel(wanted) && wanted !== "(默认)") {
        return { text: `**实际在跑：${actual}**（配置里请求的是 ${wanted}，没给到）`, buttons };
      }
      return { text: actual ? `实际在跑：${actual}` : `还没跑过轮，读不到实际模型（配置请求的是 ${wanted}）`, buttons };
    }
    await runtime.setModelForWorkspace({ workspaceRoot: ws, model: rest });
    return { text: `换成 ${rest} 了。下一轮生效。` };
  }, "看 / 换模型");

  add("stop", async () => {
    if (typeof runtime.cancelTurn !== "function") return { text: "这个底座停不了正在跑的那一轮。" };
    await runtime.cancelTurn({ threadId: threadId(), turnId: "", workspaceRoot: ws });
    // Be explicit: stopping does not unsend segments that were already delivered.
    return { text: "叫停了。已经发出去的那几段收不回来，只是后面不再说了。" };
  }, "停掉正在跑的这一轮");

  // --- Undo a turn ---
  //
  // Undo removes the turn's effect on everything that follows, not just a file:
  //   1. context and memory (CLI history, cold layer, shadow, and summaries /
  //      handoff packages derived from them)
  //   2. queues and derived files (pending, outbox, retries, turn bindings, voice files)
  //      — ingestion cursors and ids never move backwards; body-less tombstones
  //      keep old messages from being re-ingested
  //   3. external actions (sent / created / modified), classified as undone /
  //      cannot undo / needs attention
  // The work happens in undo.js; this handler does: preview scope, wait for
  // confirmation, pause intake, apply, verify, resume.
  //
  // The previewed plan lives in memory; after a restart it must be recomputed anyway.
  let previewed = null;

  add("undo", async ({ rest }) => {
    const arg = String(rest || "").trim().toLowerCase();
    const tid = String(threadId() || "");
    if (!tid) return { text: "现在没有在跑的会话，没什么可退的。" };
    if (!gateRoot) return { text: "装配时没给 gateRoot，撤不了（桥的账本在哪不许猜）。" };

    const execMode = ["ok", "确认", "好"].includes(arg) ? "undo"
      : ["purge", "彻底", "清"].includes(arg) ? "purge" : null;

    // Preview: read-only, shows the scope
    if (!execMode) {
      const target = arg ? { kind: "before", nativeId: arg } : { kind: "last" };
      const plan = planUndo({ gateRoot, workspaceRoot: ws, threadId: tid, target });
      previewed = plan.ok ? { plan, target, at: Date.now() } : null;
      const tail = plan.ok
        ? "\n\n要真撤：`/undo ok`（留备份，后悔得回来）· `/undo 彻底`（连正文备份一起清，只留审计）"
        : "";
      return { ok: plan.ok, text: describePlan(plan) + tail };
    }

    // Execute
    if (!previewed) return { text: "先空按一次 `/undo` 看影响范围，再来确认。" };

    // 1. Pause intake and wait for in-flight turns (so nothing is written back after deletion)
    if (pauseIntake) {
      const paused = await pauseIntake();
      if (!paused.ok) return { ok: false, text: "没撤：" + paused.why + "（在途的没停干净，这时候动手会删完又写回来）" };
    }
    try {
      // 2. Recompute: new messages may have arrived since the preview. If the scope changed, abort.
      const fresh = planUndo({ gateRoot, workspaceRoot: ws, threadId: tid, target: previewed.target });
      if (!fresh.ok) return { ok: false, text: "没撤：" + fresh.why };
      const same = JSON.stringify(fresh.ids) === JSON.stringify(previewed.plan.ids);
      if (!same) {
        previewed = { plan: fresh, target: previewed.target, at: Date.now() };
        return { ok: false, text: "这中间又有新消息进来了，范围变了。重新看一遍：\n\n" + describePlan(fresh) };
      }

      // 3. Apply
      const r = applyUndo({ plan: fresh, mode: execMode });
      if (!r.ok) return { ok: false, text: "没撤：" + r.why };

      // 3.5 Reload the CLI after removing transcript lines: the running CLI still
      //     holds the deleted leaf in memory, and the next turn would attach to it
      //     and break the parent chain.
      let reloadNote = "";
      if (r.removed && r.removed.transcript > 0 && box && typeof box.reloadCli === "function") {
        try {
          const rl = await box.reloadCli({ workspaceRoot: ws });
          if (rl && rl.busy) reloadNote = "⚠️ agent 正在说话，CLI 没能重连——下一轮可能接到被删的行上，等这轮结束再重连一次";
        } catch (e) { reloadNote = "⚠️ CLI 重连没成：" + ((e && e.message) || e) + "（下一轮可能断链）"; }
      }

      // 4. Verify consistency before resuming intake
      const v = verifyUndo(fresh, { mode: execMode });

      const L = [];
      L.push(execMode === "purge" ? "🔥 彻底删除完成。" : "↩️ 撤销完成。");
      const moved = Object.entries(r.removed).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(" · ");
      L.push("动了：" + (moved || "（一处都没有）"));
      L.push(`撤销标记 ${r.tombstones} 条（无正文；采集游标没动，旧消息进不来）`);
      L.push(r.backup ? "备份：" + r.backup : "**没留正文备份**（这是彻底删除那一档）");
      L.push(v.clean ? "验收：干净，没有残留。" : "⚠️ 验收：还有残留 " + v.leftovers.join("、"));
      const undone = fresh.external.sent.filter((x) => /可撤回/.test(x.verdict));
      if (undone.length) L.push(`⚠️ 已经发出去的 ${undone.length} 条**还在 owner 那头**（删历史不等于撤回），要撤你说一声。`);
      if (fresh.external.tools.length) {
        const names = [...new Set(fresh.external.tools.map((t) => t.name))].join("、");
        L.push(`⚠️ 那轮调过的工具（${names}）动的是别人的库，**这儿没碰**，待处理。`);
      }
      if (fresh.derived.length) L.push(`⚠️ ${fresh.derived.length} 份摘要/交接包混着别轮内容，标成待重建，没删。`);
      if (reloadNote) L.push(reloadNote);
      previewed = null;
      return { text: L.join("\n") };
    } finally {
      // 5. Always resume intake, success or not; otherwise nothing gets in anymore
      if (resumeIntake) { try { resumeIntake(); } catch { /* visible in the next heartbeat */ } }
    }
  }, "撤销一轮（先给影响范围）");

  return registered;
}

module.exports = { registerClaudeCodeCommands };
