#!/usr/bin/env node
"use strict";
// 假的 `codex app-server`（换行分隔 JSON-RPC over stdio），给 codex 驱动 / 插头的接线测试用。
// 形状照 0.163.0 的 generate-ts（/tmp/codex-research/ts）和 S0 实测（docs/design-engine-agnostic.md §8）：
//   · item/started|completed 的 item.type="contextCompaction"（方法名里没有 compact）
//   · thread/tokenUsage/updated 的 tokenUsage = { total（整条 thread 累计）, last（上一次请求）, modelContextWindow }
// 每个收到的请求追加一行到 $FAKE_CODEX_LOG（JSON：{pid, method, params, argv}），测试读它断言。
// 她这一轮的正文里带：
//   DIE      → 进程当场退出（模拟 app-server 崩了）
//   TOOL     → 正文前先发 reasoning / commandExecution / mcpToolCall 三个 item/completed（S2b 翻通用事件用）
//   COMPACT  → 这一轮开头先发一次 contextCompaction（started + completed）和一条老的 thread/compacted
//   --version → 打印 codex-cli $FAKE_CODEX_VERSION（默认 0.163.0）就退出（换引擎的版本闸用）
//   $FAKE_CODEX_ROLLOUT_DIR 给了：thread/start 回一个 rollout 路径，inject_items 往里追加 response_item 行（回读核对用）
//   $FAKE_CODEX_INJECT_FAIL=1：inject_items 报错
const fs = require("fs");
if (process.argv.includes("--version")) { process.stdout.write(`codex-cli ${process.env.FAKE_CODEX_VERSION || "0.163.0"}\n`); process.exit(0); }
const rolloutDir = process.env.FAKE_CODEX_ROLLOUT_DIR || "";
const rollouts = new Map();
const logFile = process.env.FAKE_CODEX_LOG;
const record = (o) => { if (logFile) fs.appendFileSync(logFile, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), ...o }) + "\n"); };
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let seq = 0;
const loaded = new Set();
const known = new Set((process.env.FAKE_CODEX_KNOWN || "").split(",").filter(Boolean));
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line));
  }
});
function handle(msg) {
  if (!msg.method || msg.id == null) return;           // 通知 / 我们发出去请求的应答
  record({ method: msg.method, params: msg.params });
  const p = msg.params || {};
  const ok = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
  const err = (message) => send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message } });
  switch (msg.method) {
    case "initialize": return ok({ codexHome: "/tmp/fake-codex-home" });
    case "thread/start": {
      const id = `thr-${process.pid}-${++seq}`;
      known.add(id); loaded.add(id);
      const rp = rolloutDir ? require("path").join(rolloutDir, `${id}.jsonl`) : "";
      if (rp) { fs.writeFileSync(rp, JSON.stringify({ type: "session_meta", payload: { id } }) + "\n"); rollouts.set(id, rp); }
      return ok({ thread: { id, path: rp } });
    }
    case "thread/resume":
      if (!known.has(p.threadId) && !String(p.threadId).startsWith("thr-")) return err(`no rollout found for thread id ${p.threadId}`);
      loaded.add(p.threadId);
      return ok({ thread: { id: p.threadId, path: "" } });
    case "thread/inject_items": {
      if (process.env.FAKE_CODEX_INJECT_FAIL === "1") return err("inject 不让塞");
      const rp = rollouts.get(p.threadId);
      if (rp) for (const item of p.items || []) fs.appendFileSync(rp, JSON.stringify({ type: "response_item", payload: item }) + "\n");
      return ok({});
    }
    case "turn/interrupt": return ok({});
    case "account/rateLimits/read":
      if (process.env.FAKE_CODEX_RATELIMITS_FAIL === "1") return err("rate limits 读不了");
      return ok({ ordinaryUsageAllowed: true, rateLimitsByLimitId: null, rateLimitResetCredits: null, accountId: null, rateLimitUpsell: null,
        rateLimits: { limitId: "codex", limitName: null, normalModelSlug: null, credits: null, individualLimit: null, spendControlReached: null,
          rateLimitReachedType: null, planType: "pro",
          primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1792600000 },
          secondary: { usedPercent: 7.5, windowDurationMins: 10080, resetsAt: 1793000000 } } });
    case "turn/start": {
      if (!loaded.has(p.threadId)) return err(`thread not loaded: ${p.threadId}`);
      const text = (p.input || []).map((i) => i.text || "").join(" ");
      if (text.includes("DIE")) { process.exit(3); }
      ok({ turn: { id: "turn-1" } });
      const turnId = `turn-${++seq}`;
      const note = (method, params) => send({ jsonrpc: "2.0", method, params: { threadId: p.threadId, turnId, ...params } });
      if (text.includes("COMPACT")) {
        note("item/started", { item: { type: "contextCompaction", id: "cc-1" } });
        note("item/completed", { item: { type: "contextCompaction", id: "cc-1" } });
        note("thread/compacted", {});
      }
      if (text.includes("TOOL")) {
        note("item/completed", { item: { type: "reasoning", id: "r1", summary: ["想一下"], content: [] } });
        note("item/completed", { item: { type: "commandExecution", id: "x1", command: "ls", cwd: "/w", status: "completed",
          aggregatedOutput: "a.txt\n", exitCode: 0, durationMs: 3, processId: null, source: "agent", commandActions: [], pluginId: null, scriptPath: null } });
        note("item/completed", { item: { type: "mcpToolCall", id: "x2", server: "im_bridge", tool: "reply", status: "failed",
          arguments: { text: "hi" }, result: null, error: { message: "渠道不在" }, appContext: null, mcpAppUi: null, pluginId: null, readOnlyHint: null } });
      }
      note("item/started", { item: { type: "agentMessage", id: "m1", phase: "final_answer" } });
      note("item/agentMessage/delta", { itemId: "m1", delta: "嗯" });
      note("item/completed", { item: { type: "agentMessage", id: "m1", phase: "final_answer", text: "嗯。" } });
      note("thread/tokenUsage/updated", { tokenUsage: {
        total: { totalTokens: 795897, inputTokens: 791233, cachedInputTokens: 700288, cacheWriteInputTokens: 0, outputTokens: 4664, reasoningOutputTokens: 1589 },
        last: { totalTokens: 56112, inputTokens: 55924, cachedInputTokens: 11264, cacheWriteInputTokens: 0, outputTokens: 188, reasoningOutputTokens: 120 },
        modelContextWindow: 258400 } });
      note("turn/completed", {});
      return;
    }
    default: return ok({});
  }
}
