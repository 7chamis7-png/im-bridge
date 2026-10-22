"use strict";
/**
 * 远程 MCP 本地代理（tools/_lib/mcp-http-proxy.js，2026-10-21）对一个假的 streamable-http 服务端。
 *
 * 假服务端会：发 mcp-session-id、要求之后每条都带；按 Accept 回 SSE（event: message）或纯 JSON；
 * 认 bearer 或 ?token=；一次性把会话作废（下一条吃 404），看代理会不会自己重新握手。
 */
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

let pass = 0, fail = 0;
const check = (n, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(g)} want=${JSON.stringify(w)}`));
  ok ? pass++ : fail++;
};

const PROXY = path.join(__dirname, "..", "..", "tools", "_lib", "mcp-http-proxy.js");
const TOKEN = "fake-secret-xyz";

function makeServer({ mode, sse }) {
  const st = { sessions: new Set(), n: 0, seen: [], killNext: false };
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const authOk = mode === "bearer" ? req.headers.authorization === `Bearer ${TOKEN}` : url.searchParams.get("token") === TOKEN;
      if (!authOk) { res.writeHead(401); return res.end("no"); }
      const msg = JSON.parse(body);
      st.seen.push({ method: msg.method, sid: req.headers["mcp-session-id"] || "", pv: req.headers["mcp-protocol-version"] || "" });
      if (msg.method === "initialize") {
        const sid = "s" + (++st.n);
        st.sessions.add(sid);
        res.setHeader("mcp-session-id", sid);
      } else {
        const sid = req.headers["mcp-session-id"];
        if (st.killNext && msg.method === "tools/list") { st.killNext = false; st.sessions.delete(sid); }
        if (!st.sessions.has(sid)) { res.writeHead(404); return res.end("session gone"); }
      }
      if (msg.id === undefined) { res.writeHead(202); return res.end(); }
      let result;
      if (msg.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } };
      else if (msg.method === "tools/list") result = { tools: [{ name: "echo", description: "回声", inputSchema: { type: "object" } }] };
      else if (msg.method === "tools/call") result = { content: [{ type: "text", text: "回：" + msg.params.arguments.say }] };
      else result = {};
      const reply = { jsonrpc: "2.0", id: msg.id, result };
      if (sse) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        // 先来一条进度通知（不是回包），再来回包；分两块写，测拼接
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { p: 1 } })}\n\n`);
        const s = `event: message\ndata: ${JSON.stringify(reply)}\n\n`;
        res.write(s.slice(0, 10));
        setTimeout(() => res.end(s.slice(10)), 20);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(reply));
      }
    });
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok({ srv, st, port: srv.address().port })));
}

function runProxy(env, script) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [PROXY], { env: { PATH: process.env.PATH, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const got = [];
    const waiters = new Map();
    c.stderr.on("data", (d) => (err += d));
    c.stdout.on("data", (d) => {
      out += d; let i;
      while ((i = out.indexOf("\n")) >= 0) {
        const m = JSON.parse(out.slice(0, i)); out = out.slice(i + 1);
        got.push(m);
        if (m.id !== undefined && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
      }
    });
    const send = (m) => c.stdin.write(JSON.stringify(m) + "\n");
    const ask = (m) => new Promise((ok) => { waiters.set(m.id, ok); send(m); });
    const t = setTimeout(() => { c.kill(); resolve({ got, err, timeout: true }); }, 10000);
    script({ send, ask }).then((extra) => {
      c.stdin.end();
      c.on("exit", (code) => { clearTimeout(t); resolve({ got, err, code, extra }); });
    });
  });
}

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } };

(async () => {
  for (const [mode, sse] of [["bearer", true], ["query", false]]) {
    console.log(`${mode} + ${sse ? "SSE" : "JSON"}`);
    const { srv, st, port } = await makeServer({ mode, sse });
    const env = { MCP_PROXY_NAME: "fake", MCP_PROXY_URL: `http://127.0.0.1:${port}/mcp`, MCP_PROXY_TOKEN: TOKEN,
      MCP_PROXY_AUTH: mode === "bearer" ? "bearer" : "query:token" };
    const r = await runProxy(env, async ({ send, ask }) => {
      const init = await ask(INIT);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const list = await ask({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const call = await ask({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { say: "你好" } } });
      st.killNext = true;                         // 下一条 tools/list 时会话作废
      const after = await ask({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
      return { init, list, call, after };
    });
    check("initialize 回包原样", r.extra.init.result.serverInfo.name, "fake");
    check("tools/list 拿到工具", r.extra.list.result.tools.map((t) => t.name), ["echo"]);
    check("tools/call 原样回来", r.extra.call.result.content[0].text, "回：你好");
    check("会话过期 → 自己重新握手后照样回来", r.extra.after.result.tools.length, 1);
    check("握了两次手", st.n, 2);
    check("initialize 之后每条都带会话号", st.seen.filter((s) => s.method !== "initialize").every((s) => /^s\d$/.test(s.sid)), true);
    check("带上了协议版本头", st.seen.filter((s) => s.method === "tools/call").map((s) => s.pv), ["2025-03-26"]);
    if (sse) check("SSE 里的进度通知也转过来了", r.got.filter((m) => m.method === "notifications/progress").length >= 1, true);
    check("stderr 里没有钥匙", r.err.includes(TOKEN), false);
    check("stdin 关了代理就退出（0）", r.code, 0);
    srv.close();
  }

  console.log("出错");
  const { srv, port } = await makeServer({ mode: "bearer", sse: false });
  const bad = await runProxy({ MCP_PROXY_NAME: "fake", MCP_PROXY_URL: `http://127.0.0.1:${port}/mcp`, MCP_PROXY_TOKEN: "wrong" },
    async ({ ask }) => ({ init: await ask(INIT) }));
  check("钥匙不对 → JSON-RPC error（不干等）", [bad.extra.init.id, /HTTP 401/.test(bad.extra.init.error.message)], [1, true]);
  check("错误里没有钥匙", JSON.stringify(bad.got).includes("wrong"), false);
  srv.close();
  const dead = await runProxy({ MCP_PROXY_NAME: "fake", MCP_PROXY_URL: "http://127.0.0.1:1/mcp?token=" + TOKEN, MCP_PROXY_TIMEOUT_MS: "3000" },
    async ({ ask }) => ({ init: await ask(INIT) }));
  check("连不上 → JSON-RPC error", typeof dead.extra.init.error.message, "string");
  check("连不上的错误里没有 URL 里的钥匙", JSON.stringify(dead.got).includes(TOKEN) || dead.err.includes(TOKEN), false);

  console.log(`远程代理：通过 ${pass} / ${pass + fail}`);
  process.exit(fail ? 1 : 0);
})();
