#!/usr/bin/env node
"use strict";

/**
 * MCP shell for the bridge tools: exposes the tool plugins to the agent.
 *
 * Claude Code only speaks MCP: it reads a config at startup and each server
 * reports its tools. Without this shell the files in `src/gate/tools/` would
 * be invisible to the agent.
 *
 * The shell makes no decisions. It never touches tokens, platforms or channel
 * selection; it only:
 *   1. scans the plugin directory at startup and reports the tools
 *   2. forwards each tool call over a unix socket to the bridge, which runs it
 *      through the outbound gate, and returns the result verbatim
 *
 * Because delivery goes through the bridge, the channel follows the current
 * turn and every outbound message is recorded (cold log, outbound ledger).
 *
 * Plugins with a `handler` (non-delivery work) run in this process directly.
 *
 * Usage: node src/gate/tools/mcp-server.js
 *   GATE_TOOL_SOCKET=<socket opened by the bridge>   required
 */

const net = require("net");
const path = require("path");
const { loadTools } = require("./index");

const SOCKET = process.env.GATE_TOOL_SOCKET || "";
const SERVER_NAME = process.env.GATE_TOOL_SERVER_NAME || "im_bridge";

/** Logs go to stderr only: stdout is the MCP protocol channel. */
const log = (m) => { try { process.stderr.write("[工具壳] " + m + "\n"); } catch { /* ignore */ } };

const { byName, errors } = loadTools({ log });
for (const e of errors) log("装不上 " + e.file + "：" + e.why);

/** Send one request to the bridge and wait for the result. One connection per call. */
function askGate(payload, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    if (!SOCKET) return resolve({ ok: false, error: "没有配 GATE_TOOL_SOCKET，壳够不着桥" });
    const sock = net.createConnection(SOCKET);
    let buf = "";
    let done = false;
    const finish = (res) => { if (done) return; done = true; try { sock.end(); } catch { /* already closed */ } resolve(res); };
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

/** MCP result shape: a content array. Failures carry a readable message. */
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
  // handler tools run in-process
  if (typeof plugin.handler === "function") {
    try { return asContent(await plugin.handler(args || {}, { log })); }
    catch (e) { return asContent({ ok: false, error: String((e && e.message) || e) }); }
  }
  // delivery tools go to the bridge; the shell never sends by itself
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
      // notifications/* (e.g. initialized) have no id and need no reply
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
