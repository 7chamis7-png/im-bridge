"use strict";

/**
 * 全本的记账员（S1）：盒子两头的事 → imb.item.v1 → HistoryWriter。设计稿 §1.2–1.4。
 *
 * 盒子是唯一写手（§1.3）：
 *   · 她的话 / 生产者推的话   gate-box deliver 时 recordUser（送进引擎之前记，顺序不会跑到他回话后面）
 *   · 人格那一包              gate-box deliver 注入时 recordPersona（只记 sha 和字节数）
 *   · 他的事件                box-runtime onRuntimeEvent → onNeutral（Claude 帧先过 history-claude.js 翻成通用事件）
 *   · 出闸的话                gate-box 交给桥的每一段 recordReplyOut（=冷层那份的来源，S3 forge 对账要用）
 *   · 一轮完了                gate-box 的 done → recordTurnDone（silent → 桥会写「[本轮未回复]」）
 *   · 换舱                    gate-box rotate → noteRotate
 *
 * 确定性 id（§1.4，按 S0 实测改了 assistant 那条）：
 *   u:<trace_id>   p:<epoch>:<sha16>   a:<engineThread>:<帧uuid或message.id>:<块>
 *   t:<callId>:call / t:<callId>:result   e:<轮uuid>   r:<turnId>:<sha16>   d:<turnId>
 *
 * **不许抛**：记账出错只记日志，绝不影响他说话和她收话。
 */

const crypto = require("crypto");
const { HistoryWriter, ITEM_VERSION } = require("./history-writer");

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

function createHistoryRecorder({ writer, persona = "", log = () => {} } = {}) {
  if (!(writer instanceof HistoryWriter)) throw new Error("记账员要一个 HistoryWriter");
  const warn = (m) => log("[全本] " + m);

  // ——— 舱（epochs.jsonl）———
  const epochs = writer.readEpochs();
  let epoch = 0;
  let engineThread = "";
  for (const e of epochs) {
    if (Number(e.epoch) >= epoch) { epoch = Number(e.epoch); if (e.engineThread) engineThread = e.engineThread; }
  }
  let pendingReason = epoch ? "" : "fresh";

  /** turnId(盒子的轮号) → trace_id；uuid(cli 台账号) → 这一轮的账 */
  const traceByTurn = new Map();
  const turnState = new Map();
  /** turnId → 这一轮记下的正文块 [{id, text}]（切幻觉找目标用），只留最近几十轮 */
  const textsByTurn = new Map();

  const now = () => new Date().toISOString();
  const safe = (what, fn) => { try { return fn(); } catch (e) { warn(`${what} 没记上：${(e && e.message) || e}`); return null; } };

  function base(extra) {
    return { v: ITEM_VERSION, at: now(), epoch, persona: persona || undefined, ...extra };
  }

  function newEpoch(reason, thread = "", meta = {}) {
    epoch += 1;
    engineThread = thread;
    writer.appendEpoch({ epoch, at: now(), persona, reason, engineThread: thread, ...meta });
    pendingReason = "";
  }

  /** 看见一个会话号：新舱第一次见到就补绑，跟当前舱不一样就开一个新舱。 */
  function noteThread(threadId, { engine = "", model = "" } = {}) {
    if (!threadId) return;
    if (!epoch) { newEpoch(pendingReason || "fresh", threadId, { engine, model }); return; }
    if (!engineThread) {
      engineThread = threadId;
      writer.appendEpoch({ epoch, at: now(), persona, bind: true, engineThread: threadId, engine, model });
      return;
    }
    if (threadId !== engineThread) newEpoch(pendingReason || "observed", threadId, { engine, model });
  }

  function rememberText(turnId, id, text) {
    if (!turnId) return;
    const list = textsByTurn.get(turnId) || [];
    list.push({ id, text });
    textsByTurn.set(turnId, list);
    if (textsByTurn.size > 64) textsByTurn.delete(textsByTurn.keys().next().value);
  }

  function mediaPart(m) {
    if (!m || typeof m !== "object") return null;
    const kind = String(m.kind || "media");
    const part = { t: kind === "image" || kind === "sticker" ? "image" : kind === "voice" || kind === "audio" ? "audio" : "media", kind };
    if (m.mime) part.mime = String(m.mime);
    if (m.transcript) part.transcript = String(m.transcript);
    if (m.text) part.text = String(m.text);
    const p = m.filePath || m.path || m.localPath;
    if (p) part.path = String(p);
    if (m.processed) part.processed = String(m.processed);
    return part;
  }

  return {
    get epoch() { return epoch; },
    get engineThread() { return engineThread; },

    /** 她的话（或生产者推的）。在送进引擎**之前**记。 */
    recordUser({ envelope, modelText = "" }) {
      return safe("她的话", () => {
        if (!envelope || !envelope.trace_id) return null;
        const src = envelope.source || {};
        const payload = envelope.payload || {};
        const parts = [{ t: "text", text: String(payload.text || "") }];
        for (const m of Array.isArray(payload.media) ? payload.media : []) {
          const p = mediaPart(m);
          if (p) parts.push(p);
        }
        return writer.append(base({
          id: `u:${envelope.trace_id}`,
          at: envelope.created_at || now(),
          role: "user", type: "message",
          traceId: envelope.trace_id,
          producer: src.kind === "user" ? "her" : (src.producer || src.kind || "system"),
          verdict: envelope.verdict || "accepted",
          parts,
          modelText: String(modelText || ""),
          origin: { platform: src.platform || "", chat_id: src.chat_id || "", native_id: src.native_id || "",
            seq: envelope.seq == null ? null : envelope.seq, created_at: envelope.created_at || "" },
        }));
      });
    },

    /** 人格那一包：只记指纹，正文是重建时现拼的。 */
    recordPersona({ pack, reason = "" }) {
      return safe("人格包", () => {
        const s = String(pack || "");
        if (!s) return null;
        const h = sha(s);
        return writer.append(base({ id: `p:${epoch}:${h.slice(0, 16)}`, role: "system", type: "marker", kind: "persona_pack",
          meta: { sha256: h, bytes: Buffer.byteLength(s, "utf8"), reason } }));
      });
    },

    /** 盒子把这一轮的 turnId 跟入站 trace_id、cli 台账号对上（box-runtime sendTurn）。 */
    linkTurn({ traceId = "", turnId = "", uuid = "" }) {
      if (turnId && traceId) traceByTurn.set(turnId, traceId);
      if (uuid) turnState.set(uuid, { ...(turnState.get(uuid) || {}), turnId, traceId });
      if (traceByTurn.size > 500) traceByTurn.delete(traceByTurn.keys().next().value);
      if (turnState.size > 500) turnState.delete(turnState.keys().next().value);
    },

    /**
     * 一个通用事件（imb.event.v1）。ctx = { uuid, turnId, threadId }。
     * text.delta 不记（电话边写边念用的，完整块另有一条 text）。
     */
    onNeutral(ev, ctx = {}) {
      return safe(`事件 ${ev && ev.kind}`, () => {
        if (!ev || typeof ev !== "object") return null;
        const uuid = ctx.uuid || ev.turn || "";
        const st = (uuid && turnState.get(uuid)) || {};
        const turnId = ctx.turnId || st.turnId || "";
        const traceId = st.traceId || (turnId && traceByTurn.get(turnId)) || "";
        const thread = ctx.threadId || "";
        if (thread && !ev.sidechain) noteThread(thread, { engine: ev.engine, model: ev.model });
        const common = { turn: uuid || undefined, turnId: turnId || undefined, traceId: traceId || undefined,
          engine: ev.engine, ...(ev.sidechain ? { sidechain: true } : {}) };
        const keep = (patch) => { if (uuid) turnState.set(uuid, { ...(turnState.get(uuid) || st), ...patch }); };
        switch (ev.kind) {
          case "text": {
            const id = `a:${thread || engineThread}:${ev.id}`;
            if (!ev.sidechain && ev.deliverHint !== "commentary") rememberText(turnId, id, ev.text);
            return writer.append(base({ id, role: "assistant", type: "message", ...common, model: ev.model || "",
              parts: [{ t: "text", text: String(ev.text || "") }],
              generatedBy: ev.generatedBy || "model", deliverHint: ev.deliverHint || "text" }));
          }
          case "reasoning":
            return writer.appendOpaque({ id: `o:${thread || engineThread}:${ev.id}`, at: now(), epoch, ...common,
              model: ev.model || "", kind: `${(ev.opaque && ev.opaque.engine) || ev.engine}.reasoning`, payload: ev.opaque || {} });
          case "tool.call":
            return writer.append(base({ id: `t:${ev.id}:call`, role: "assistant", type: "tool_call", ...common, model: ev.model || "",
              call: { id: ev.id, name: ev.name, server: ev.server || "", args: ev.args == null ? {} : ev.args } }));
          case "tool.result": {
            const body = writer.inlineOrBlob(ev.text);
            const images = (Array.isArray(ev.images) ? ev.images : [])
              .map((im) => (im && im.data ? writer.putBlob(Buffer.from(im.data, "base64")) : (im && im.blob) || null)).filter(Boolean);
            return writer.append(base({ id: `t:${ev.callId}:result`, role: "tool", type: "tool_result", ...common,
              result: { callId: ev.callId, isError: ev.isError === true, text: body.text, blob: body.blob,
                ...(body.truncated ? { truncated: true } : {}), images },
              ...(body.scrubbed ? { secretsScrubbed: body.scrubbed } : {}) }));
          }
          case "usage":
            if (!ev.sidechain) keep({ usage: { input: ev.input, output: ev.output, cacheRead: ev.cacheRead, cacheWrite: ev.cacheWrite,
              context: ev.context, model: ev.model || "" } });
            return null;
          case "turn.end": {
            if (ev.sidechain || !uuid) return null;
            const usage = (turnState.get(uuid) || {}).usage || null;
            turnState.delete(uuid);
            return writer.append(base({ id: `e:${uuid}`, role: "system", type: "turn_end", ...common,
              status: ev.status || "ok", synthetic: ev.synthetic === true, errors: ev.errors || [], usage }));
          }
          case "engine.notice":
            return writer.append(base({ id: `n:${ev.id || uuid || "none"}:${ev.what}`,
              role: "system", type: "marker", kind: ev.what === "compacted" ? "engine_compacted" : `engine_${ev.what}`, ...common, meta: ev.meta || {} }));
          default:
            return null;
        }
      });
    },

    /** cli 补发环被挤掉了：记一个缺口，不假装补全。 */
    noteGap({ lastSeq, serverLastSeq }) {
      return safe("缺口", () => writer.append(base({ id: `g:${lastSeq}:${serverLastSeq}`, role: "system", type: "marker", kind: "gap",
        meta: { lastSeq, serverLastSeq } })));
    },

    /** 盒子交给桥的一段话（冷层那份的来源）。 */
    recordReplyOut({ turnId = "", text = "", genuine = true, trace_id = "" }) {
      return safe("出闸的话", () => {
        const s = String(text || "");
        if (!s) return null;
        return writer.append(base({ id: `r:${turnId}:${sha(s).slice(0, 16)}`, role: "assistant", type: "marker", kind: "reply_out",
          turnId: turnId || undefined, traceId: trace_id || traceByTurn.get(turnId) || undefined,
          meta: { text: s, genuine: genuine !== false } }));
      });
    },

    /** 这一轮在盒子这头完了（silent = 一个字都没吐，桥会替他写「[本轮未回复]」）。 */
    recordTurnDone({ turnId = "", trace_id = "", silent = false, failed = false, reason = "" }) {
      return safe("一轮收尾", () => {
        if (!turnId) return null;
        return writer.append(base({ id: `d:${turnId}`, role: "system", type: "marker", kind: "turn_done", turnId,
          traceId: trace_id || traceByTurn.get(turnId) || undefined, meta: { silent: silent === true, failed: failed === true, reason } }));
      });
    },

    /** 换舱：开一个新舱，会话号等第一次见到再绑。 */
    noteRotate(reason = "rotate") {
      return safe("换舱", () => newEpoch("rotate", "", { note: String(reason || "") }));
    },

    /**
     * 切幻觉（S4）：先删桥里这份 —— 往 redactions.jsonl 写 cut_tail，原文还在主文件里。
     * 目标 = 这一轮里正文等于 body 的那几块（同一段可能被拆成几块帧，按正文对）。
     */
    redactHallucination({ turnId = "", body = "", newText = "", cut = "", kind = "" }) {
      return safe("切幻觉", () => {
        const list = textsByTurn.get(turnId) || [];
        const targets = list.filter((x) => String(x.text || "").trim() === String(body || "").trim()
          || (cut && String(x.text || "").includes(cut.trim())));
        const out = [];
        for (const t of targets) {
          const rec = { at: now(), target: t.id, op: "cut_tail", by: "halluc", kind, turnId,
            newText: String(t.text || "").trim() === String(body || "").trim() ? newText : String(t.text || "").split(cut.trim())[0].trimEnd(),
            cutSha256: sha(cut) };
          writer.appendRedaction(rec);
          out.push(rec);
        }
        if (!targets.length) warn(`切幻觉：turn=${turnId || "(无)"} 在全本里没找到对应的正文块`);
        return out;
      });
    },
  };
}

module.exports = { createHistoryRecorder };
