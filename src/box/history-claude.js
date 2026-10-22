"use strict";

/**
 * Claude 帧 → 通用事件（imb.event.v1，设计稿 §2.1）。**纯函数**，不读写任何东西。
 *
 * 输入是 cli 宿主推过来的 `{event, bindings}` 里的 `event`（runtime/decode.js 的产物，`event.raw` 是 SDK 原帧）。
 * S1 用它把 Claude 帧翻成中性形状再写全本；S2a 的盒子双认也拿它当对照（同一份帧走两条路，结果要一样）。
 *
 * 实测形状（S0，CC 2.1.292 / SDK 0.3.278，夹具 test/fixtures/real/sdk-frames-2.1.292-tool-turn.jsonl）：
 *   · assistant 帧**一块一帧**：同一个 message.id 的 thinking / text / tool_use 各一帧，content 只有一块，
 *     decode 的 blockIndex 永远是 0、usage 每帧重复一份。所以 id 用**帧的 uuid**（补发环原样重放 → 稳定），
 *     没有 uuid 的（codex 拼的假帧）退回 message.id。
 *   · user 帧带 tool_result：content 是 string，或 [{type:'text'}]，或 [{type:'image'},{type:'text'}]
 *   · result 帧：subtype / is_error / result / usage
 *
 * 旁白判据和合成判据**不在这里重写**，由调用方把 box-runtime 里那两个函数递进来（搬逻辑要连判据一起搬，
 * 抄一份就会两头漂）。
 */

const NEUTRAL = "imb.event.v1";

/** `mcp__server__tool` → { server, tool }；不是 MCP 的给空 server。 */
function splitToolName(name) {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(String(name || ""));
  return m ? { server: m[1], tool: m[2] } : { server: "", tool: String(name || "") };
}

/** 引擎家族：codex 插头拼的假帧 message.id 是 cxmsg-…，deepseek 是 dsmsg-…（没有就当 Claude CLI）。 */
function engineOf(raw) {
  const id = String((raw && raw.message && raw.message.id) || "");
  if (id.startsWith("cxmsg-")) return "codex-appserver";
  if (id.startsWith("dsmsg-") || id.startsWith("ds-")) return "openai-chat";
  return "claude-cli";
}

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content.filter((b) => b && b.type === "text").map((b) => String(b.text || "")).join("\n");
}

function toolResultImages(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b && b.type === "image" && b.source && b.source.type === "base64")
    .map((b) => ({ mime: b.source.media_type || "", data: b.source.data || "" }));
}

/**
 * @param {object} event  decode() 的一个事件（带 raw）
 * @param {object} o
 * @param {function} o.isNarration         box-runtime 的旁白判据
 * @param {function} o.isSyntheticMessage  box-runtime 的合成判据
 * @returns {object[]} 通用事件（不带 turn，归属由调用方补）
 */
function claudeToNeutral(event, { isNarration, isSyntheticMessage } = {}) {
  if (!event || typeof event !== "object") return [];
  const raw = event.raw || {};
  const engine = engineOf(raw);
  const sidechain = Boolean(event.isSubagent);
  const base = { v: NEUTRAL, engine, sidechain };

  if (raw.type === "stream_event") {
    const ev = raw.event || {};
    if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta" && ev.delta.text) {
      return [{ ...base, kind: "text.delta", text: ev.delta.text }];
    }
    if (ev.type === "content_block_stop") return [{ ...base, kind: "text.delta", end: true }];
    return [];
  }

  if (raw.type === "assistant") {
    const message = raw.message || {};
    const model = typeof message.model === "string" ? message.model : "";
    const synthetic = Boolean(event.cliGenerated || (isSyntheticMessage && isSyntheticMessage(message)));
    const frameKey = raw.uuid || message.id || "";
    const id = `${frameKey}:${event.blockIndex || 0}`;
    const out = [];
    if (!event.blockIndex && message.usage && typeof message.usage === "object") {
      const u = message.usage;
      const n = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
      const input = n(u.input_tokens);
      const output = n(u.output_tokens);
      const cacheRead = n(u.cache_read_input_tokens);
      const cacheWrite = n(u.cache_creation_input_tokens);
      out.push({ ...base, kind: "usage", model, input, output, cacheRead, cacheWrite,
        context: (input || 0) + (output || 0) + (cacheRead || 0) + (cacheWrite || 0) });
    }
    const block = event.block || {};
    const narration = isNarration ? isNarration(event) : event.kind === "narration";
    if (event.kind === "text") {
      out.push({ ...base, kind: "text", id, model, text: String(event.text || ""), deliverHint: "text",
        generatedBy: synthetic ? "engine" : "model" });
    } else if (narration) {
      out.push({ ...base, kind: "text", id, model, text: String(event.text || block.thinking || ""), deliverHint: "narration",
        generatedBy: synthetic ? "engine" : "model" });
    } else if (block.type === "thinking" || block.type === "redacted_thinking") {
      out.push({ ...base, kind: "reasoning", id, model,
        opaque: { engine: "claude", type: block.type, thinking: block.thinking, signature: block.signature, data: block.data } });
    } else if (block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use") {
      const { server } = splitToolName(block.name);
      out.push({ ...base, kind: "tool.call", id: String(block.id || id), model, name: String(block.name || ""),
        server: block.server_name || server, args: block.input == null ? {} : block.input });
    }
    return out;
  }

  if (raw.type === "user") {
    const content = raw.message && raw.message.content;
    if (!Array.isArray(content)) return [];
    const out = [];
    for (const b of content) {
      if (!b || b.type !== "tool_result") continue;
      out.push({ ...base, kind: "tool.result", callId: String(b.tool_use_id || ""), isError: b.is_error === true,
        text: toolResultText(b.content), images: toolResultImages(b.content) });
    }
    return out;
  }

  if (event.kind === "result" || raw.type === "result") {
    const ok = raw.subtype === "success";
    return [{ ...base, kind: "turn.end",
      status: ok ? "ok" : "error",
      synthetic: raw.is_error === true,
      subtype: raw.subtype || "",
      errors: Array.isArray(raw.errors) ? raw.errors.map(String) : [],
      text: typeof raw.result === "string" ? raw.result : "" }];
  }

  if (raw.type === "system" && raw.subtype === "compact_boundary") {
    return [{ ...base, kind: "engine.notice", id: raw.uuid || "", what: "compacted", meta: raw.compact_metadata || {} }];
  }
  return [];
}

module.exports = { claudeToNeutral, splitToolName, engineOf, toolResultText, NEUTRAL };
