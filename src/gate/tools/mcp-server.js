#!/usr/bin/env node
"use strict";

/**
 * 工具的 MCP 壳（2026-09-18）—— 把插件变成他能调的东西
 *
 * claude 只认 MCP 协议：启动时读一份 config，每个 server 报自己有哪些工具。
 * 没有这层壳，`src/gate/tools/` 里那些文件对他来说**根本不存在**。
 *
 * ## 这层壳里不做任何决定
 *
 * 它**不碰 token、不连平台、不猜渠道**，只干两件事：
 *   1. 起来时扫一遍插件目录，把工具报给 claude
 *   2. 他调某个工具 → 通过 unix socket 递给桥 → 桥走出闸 → 结果原样回给他
 *
 * 这正是跟老桥的区别：老桥那 11 个投递工具是**在壳里自己把消息发出去的**，
 * 于是渠道靠猜（她在微信说话、他的语音发去了 TG）、桥也不知道他说过话
 * （不进冷层、不进账本，一换舱就失忆）。
 *
 * ## 干活类插件
 *
 * 带 `handler` 的插件（读日记、查记忆…）不投递，**就在这个进程里直接跑**，
 * 不走 socket —— 那条通路是给"要发出去"的东西用的。
 *
 * 用法：node src/gate/tools/mcp-server.js
 *   GATE_TOOL_SOCKET=<桥开的那个 socket>   必给
 */

const net = require("net");
const path = require("path");
const { loadTools } = require("./index");

const SOCKET = process.env.GATE_TOOL_SOCKET || "";
const SERVER_NAME = process.env.GATE_TOOL_SERVER_NAME || "im_bridge";

/** 日志只能走 stderr —— stdout 是 MCP 的协议通道，写一个字就把它搞坏。 */
const log = (m) => { try { process.stderr.write("[工具壳] " + m + "\n"); } catch { /* 无所谓 */ } };

const { byName, errors } = loadTools({ log });
for (const e of errors) log("装不上 " + e.file + "：" + e.why);

/** 递一条给桥，等它把结论带回来。**一次一连，不留长连接** —— 工具调用本来就不密。 */
function askGate(payload, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    if (!SOCKET) return resolve({ ok: false, error: "没有配 GATE_TOOL_SOCKET，壳够不着桥" });
    const sock = net.createConnection(SOCKET);
    let buf = "";
    let done = false;
    const finish = (res) => { if (done) return; done = true; try { sock.end(); } catch { /* 已经断了 */ } resolve(res); };
    const timer = setTimeout(() => finish({ ok: false, error: "桥没回（等了 " + Math.round(timeoutMs / 1000) + " 秒）" }), timeoutMs);
    sock.on("connect", () => sock.write(JSON.stringify(payload) + "\n"));
    sock.on("data", (c) => {
      buf += c.toString("utf8");
      const i = buf.indexOf("\n");
      if (i < 0) return;
      clearTimeout(timer);
      try { finish(JSON.parse(buf.slice(0, i))); }
      catch (e) { finish({ ok: false, error: "桥回的不是 JSON：" + ((e && e.message) || e) }); }
    });
    sock.on("error", (e) => { clearTimeout(timer); finish({ ok: false, error: "连不上桥：" + ((e && e.message) || e) }); });
  });
}

function toolList() {
  return [...byName.values()].map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.schema || { type: "object", properties: {} },
  }));
}

/** MCP 要的回包形状：content 数组。**失败也要说人话**，别只给一个 false。 */
function asContent(obj) {
  const text = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  return { content: [{ type: "text", text }] };
}

async function callTool(name, args) {
  const plugin = byName.get(name);
  if (!plugin) {
    return asContent({ ok: false, error: "没有这个工具：" + name
      + "；装上的是 " + [...byName.keys()].join(" / ") });
  }
  // 干活类：就地跑，不走桥
  if (typeof plugin.handler === "function") {
    try { return asContent(await plugin.handler(args || {}, { log })); }
    catch (e) { return asContent({ ok: false, error: String((e && e.message) || e) }); }
  }
  // 投递类：交给桥。**壳自己不发**
  const { channel, text, ...rest } = args || {};
  const res = await askGate({
    id: "mcp-" + Date.now() + "-" + Math.random().toString(16).slice(2, 8),
    tool: name,
    text: text != null ? String(text) : "",
    ...(channel ? { channel: String(channel) } : {}),
    args: rest,
  });
  return asContent(res);
}

// ——— JSON-RPC over stdio ———
let inbuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  inbuf += chunk;
  const lines = inbuf.split("\n");
  inbuf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let req = null;
    try { req = JSON.parse(line); } catch { continue; }
    const reply = (result) => process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\n");

    try {
      if (req.method === "initialize") {
        reply({
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: "1.0.0" },
        });
      } else if (req.method === "tools/list") {
        reply({ tools: toolList() });
      } else if (req.method === "tools/call") {
        const p = req.params || {};
        reply(await callTool(p.name, p.arguments));
      } else if (req.method === "ping") {
        reply({});
      } else if (req.id != null) {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0", id: req.id,
          error: { code: -32601, message: "不认识这个方法：" + req.method },
        }) + "\n");
      }
      // notifications/*（比如 initialized）没有 id，不用回
    } catch (e) {
      if (req.id != null) {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0", id: req.id,
          error: { code: -32603, message: String((e && e.message) || e) },
        }) + "\n");
      }
    }
  }
});

log("装上 " + byName.size + " 个工具：" + [...byName.keys()].join(" ")
  + (SOCKET ? "  桥在 " + SOCKET : "  ⚠️ 没配 GATE_TOOL_SOCKET"));
