"use strict";

/**
 * 面板 → 某个角色的桥（gate 进程）的本机控制口（src/gate/control-socket.js）。
 * socket 路径只从**这个角色自己的 env** 来：GATE_CONTROL_SOCKET，没有就 $GATE_ROOT/control.sock。
 * 只发两种：command（现在只有 /new）、status（问一个任务的进展）。
 */

const net = require("net");
const path = require("path");
const { L, zh } = require("./i18n");
/** error 给页面看（跟着语言走），errorZh 进审计账（永远中文）。 */
const fail = (s, ...args) => ({ ok: false, error: L(s, ...args), errorZh: zh(s, ...args) });

function socketPath(ch) {
  const env = (ch && ch.env) || {};
  const explicit = String(env.GATE_CONTROL_SOCKET || "").trim();
  if (explicit) return explicit;
  const root = String(env.GATE_ROOT || "").trim();
  return root ? path.join(root, "control.sock") : "";
}

/** 发一条，等一行回。连不上 / 超时都回 { ok:false, error }，不抛。 */
function call(file, req, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    if (!file) return resolve(fail("这个角色的 env 里没有 GATE_ROOT，找不到它的桥"));
    let done = false, buf = "";
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { sock.destroy(); } catch { /* */ } resolve(r); };
    const sock = net.createConnection(file);
    const timer = setTimeout(() => finish(fail("桥没在时限内回话")), timeoutMs);
    sock.on("connect", () => sock.write(JSON.stringify({ id: "p1", ...req }) + "\n"));
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const i = buf.indexOf("\n");
      if (i < 0) return;
      try { finish(JSON.parse(buf.slice(0, i))); } catch { finish(fail("桥回的不是 JSON")); }
    });
    sock.on("error", (e) => finish(e.code === "ENOENT" || e.code === "ECONNREFUSED"
      ? fail("连不上他的桥（控制口不在 —— 桥没在跑，或者还是没有控制口的旧版本）") : fail("连桥出错：{0}", e.code || e.message)));
  });
}

const sendNew = (ch, { reason = "面板手动换舱", waitMs = 3000 } = {}) =>
  call(socketPath(ch), { op: "command", text: "/new " + reason, by: "panel", waitMs }, { timeoutMs: waitMs + 10_000 });
/** 发一条或一串命令（面板换舱：["/new …"]、["/new …", "/model <id>"]、["/engine <id>"]）。 */
const sendCommands = (ch, texts, { waitMs = 3000 } = {}) =>
  call(socketPath(ch), { op: "command", texts, by: "panel", waitMs }, { timeoutMs: waitMs + 10_000 });
const jobStatus = (ch, job) => call(socketPath(ch), { op: "status", job }, { timeoutMs: 5000 });

module.exports = { socketPath, call, sendNew, sendCommands, jobStatus };
