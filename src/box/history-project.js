"use strict";

/**
 * 全本的投影（S3）。设计稿 §3.0。
 *
 * 现在只做 forge 要的那一种：**对话视图**（include.tools='none'）—— 从全本投影出一串**跟冷层同口径**的记录
 * `{id, role, at, text, turnId, rawText}`，让 forge 换料源以后行为跟今天等价（只是料从全本来）。
 *
 * 「跟冷层同口径」逐条对着冷层的写手抄的（搬逻辑要连过滤条件一起搬）：
 *   · 她的话   = 冷层 inbound.js:99 那条：**只有她从渠道说的**（producer=her）进冷层，生产者推的不进；
 *               正文按 cold-writer.bodyForCold：没解码 → [未解码内容]；没字有媒体 → 媒体行（语音存转写、图存 [图片]）
 *               时间用信封 created_at（= 入站 receivedAt，跟冷层 at 同一个值）
 *   · 他的话   = 冷层 outbound.js #writeCold 那几处：
 *               盒子交给桥的每一段（reply_out），genuine=false 的不进；
 *               他用桥工具（mcp__im_bridge__*）发出去的，正文 = args.text || args.caption（tool-socket.js 同口径）；
 *               整轮一个字没吐（turn_done.silent）→ 桥替他写「[本轮未回复]」（outbound.js:270）
 *               以上都过一遍 cutHallucinatedTail：切掉续写幻觉尾巴，整条都是幻觉的不进
 *   · 覆盖层   = redactions.jsonl：drop 的不要，cut_tail / replace 用 newText
 *
 * 排序按 at（稳定排序）。冷层是按「写的那一刻」追加的，两者在同一秒内的先后可能不同 ——
 * 对不上就由 forge 的对账拒绝切换（scripts/forge.js selectTail），不在这里硬凑。
 */

const { readHistoryItems, readHistoryRedactions } = require("./history-writer");
const { cutHallucinatedTail } = require("../core/hallucination-cut");

const SILENT_TEXT = "[本轮未回复]";
const BRIDGE_TOOL_SERVER = "im_bridge";

/** cold-writer.js 的 bodyForCold / coldMediaLine，按全本 user 记录的 parts 重算。 */
function coldBodyOf(item) {
  if (item.verdict === "undecoded") return "[未解码内容]";
  const parts = Array.isArray(item.parts) ? item.parts : [];
  const textPart = parts.find((p) => p && p.t === "text");
  const text = textPart ? String(textPart.text || "") : "";
  const media = parts.filter((p) => p && p.t !== "text");
  if (!text && media.length) {
    return media.map((m) => {
      const kind = m.kind || (m.t === "image" ? "image" : m.t === "audio" ? "voice" : "media");
      if (kind === "voice" || kind === "audio") {
        const t = String(m.transcript || "").trim();
        if (t) return "[语音] " + t;
      }
      return kind === "image" ? "[图片]" : "[" + kind + "]";
    }).join(" ");
  }
  return text;
}

/** 冷层 #writeCold 的切法：切过的存切过的，整条都是幻觉的不要。 */
function coldAssistantText(text) {
  const raw = String(text || "");
  const clean = cutHallucinatedTail(raw);
  if (clean.cut && !clean.text.trim()) return null;
  return clean.cut ? clean.text : raw;
}

function isBridgeTool(call) {
  if (!call) return false;
  return call.server === BRIDGE_TOOL_SERVER || String(call.name || "").startsWith(`mcp__${BRIDGE_TOOL_SERVER}__`);
}

/**
 * @param {object} o
 * @param {string} [o.dir]          全本目录（给了就自己读）
 * @param {object[]} [o.items]      或者直接给记录
 * @param {object[]} [o.redactions]
 * @returns {{records: object[], stats: object}}
 */
function projectDialogue({ dir = "", items = null, redactions = null } = {}) {
  const all = items || readHistoryItems(dir);
  const reds = redactions || (dir ? readHistoryRedactions(dir) : []);
  const byTarget = new Map();
  for (const r of reds) if (r && r.target) byTarget.set(r.target, r);
  const stats = { items: all.length, her: 0, replies: 0, toolReplies: 0, silent: 0, skipped: {} };
  const skip = (k) => { stats.skipped[k] = (stats.skipped[k] || 0) + 1; };
  const out = [];
  for (const it of all) {
    if (it.imported) { skip("补录的（epoch 0）"); continue; }
    if (it.sidechain) { skip("子代理"); continue; }
    const red = byTarget.get(it.id);
    if (red && red.op === "drop") { skip("覆盖层 drop"); continue; }
    if (it.type === "message" && it.role === "user") {
      if (it.producer !== "her") { skip("不是她说的（冷层不收）"); continue; }
      const text = red && red.newText != null ? String(red.newText) : coldBodyOf(it);
      out.push({ id: it.id, role: "user", at: it.at, text, turnId: it.turnId || "", rawText: text });
      stats.her += 1;
    } else if (it.type === "marker" && it.kind === "reply_out") {
      const m = it.meta || {};
      if (m.genuine === false) { skip("不是模型说的（genuine=false）"); continue; }
      const raw = red && red.newText != null ? String(red.newText) : String(m.text || "");
      const text = coldAssistantText(raw);
      if (text == null) { skip("整条是幻觉"); continue; }
      out.push({ id: it.id, role: "assistant", at: it.at, text, turnId: it.turnId || "", rawText: String(m.text || "") });
      stats.replies += 1;
    } else if (it.type === "tool_call" && isBridgeTool(it.call)) {
      const args = (it.call && it.call.args) || {};
      const raw = String((typeof args.text === "string" && args.text) || (typeof args.caption === "string" && args.caption) || "");
      const text = coldAssistantText(raw);
      if (text == null) { skip("整条是幻觉"); continue; }
      out.push({ id: it.id, role: "assistant", at: it.at, text, turnId: it.turnId || "", rawText: raw });
      stats.toolReplies += 1;
    } else if (it.type === "marker" && it.kind === "turn_done") {
      const m = it.meta || {};
      if (m.silent === true && m.failed !== true) {
        out.push({ id: it.id, role: "assistant", at: it.at, text: SILENT_TEXT, turnId: it.turnId || "", rawText: "" });
        stats.silent += 1;
      }
    }
  }
  // 稳定排序：同一时刻保留原来的先后
  const records = out.map((r, i) => ({ r, i }))
    .sort((a, b) => (String(a.r.at) < String(b.r.at) ? -1 : String(a.r.at) > String(b.r.at) ? 1 : a.i - b.i))
    .map((x) => x.r);
  return { records, stats };
}

/**
 * 引擎视图（设计稿 §3.0，给重建引擎用的那种）：他上下文里实际发生过的，**应用覆盖层**之后的样子。
 *   · user：送进引擎的那份正文（modelText，不带 <channel> 壳；壳在渲染时套），没有就按冷层口径算
 *   · assistant：只要 generatedBy=model 的正文（引擎造的拒答 / 报错不进去：药里不能掺病）；narration 不进
 *   · 工具：include='none' 不带；'calls'（决策 ②，默认）只带一行「[工具 名字 → ok|error]」；'full' 这一步不做
 *   · 覆盖层：drop 的不要；cut_tail / replace 用 newText（切幻觉在这里生效 —— 「先删桥里那份」）
 * 子代理、引擎塞的（producer=engine）不进。
 */
function projectEngine({ dir = "", items = null, redactions = null, include = "calls" } = {}) {
  if (!["none", "calls"].includes(include)) throw new Error(`include=${include} 这一步不支持（只有 none / calls）`);
  const all = items || readHistoryItems(dir);
  const reds = redactions || (dir ? readHistoryRedactions(dir) : []);
  const byTarget = new Map();
  for (const r of reds) if (r && r.target) byTarget.set(r.target, r);
  const resultOf = new Map();
  for (const it of all) if (it.type === "tool_result" && it.result) resultOf.set(it.result.callId, it.result);
  const out = [];
  for (const it of all) {
    if (it.sidechain) continue;
    const red = byTarget.get(it.id);
    if (red && red.op === "drop") continue;
    if (it.type === "message" && it.role === "user") {
      if (it.producer === "engine") continue;
      const text = red && red.newText != null ? String(red.newText) : (it.modelText || coldBodyOf(it));
      out.push({ id: it.id, role: "user", text, at: it.at });
    } else if (it.type === "message" && it.role === "assistant") {
      if (it.generatedBy === "engine" || it.deliverHint === "narration") continue;
      const raw = (it.parts || []).filter((p) => p && p.t === "text").map((p) => p.text || "").join("\n");
      const text = red && red.newText != null ? String(red.newText) : raw;
      if (!text.trim()) continue;
      out.push({ id: it.id, role: "assistant", text, at: it.at, ...(red ? { redacted: red.op } : {}) });
    } else if (it.type === "tool_call" && include === "calls") {
      const r = resultOf.get(it.call && it.call.id);
      out.push({ id: it.id, role: "assistant", text: `[工具 ${(it.call && it.call.name) || "?"} → ${r ? (r.isError ? "error" : "ok") : "没有结果"}]`,
        at: it.at, tool: true });
    }
  }
  return out;
}

module.exports = { projectDialogue, projectEngine, coldBodyOf, coldAssistantText, SILENT_TEXT };
