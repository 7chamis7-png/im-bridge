"use strict";
/** --demo：假数据、免登录、只读，一跑就能看到完整的样子。 */
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : "  " + extra)); ok ? pass++ : fail++; };
const PORT = 20000 + Math.floor(Math.random() * 20000);
const req = (method, p, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: "127.0.0.1", port: PORT, method, path: p, headers: body != null ? { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) } : {} },
    (res) => { let s = ""; res.on("data", (d) => (s += d)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: s })); });
  r.on("error", reject); if (body != null) r.write(body); r.end();
});

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "..", "src", "panel", "server.js"), "--demo"],
    { env: { PATH: process.env.PATH, HOME: process.env.HOME, PANEL_PORT: String(PORT) }, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  for (let i = 0; i < 100 && !/演示面板在/.test(err); i++) await new Promise((r) => setTimeout(r, 100));
  try {
    check("起得来", /演示面板在/.test(err), err);
    const home = await req("GET", "/");
    check("首页免登录 200、不发 cookie", home.status === 200 && !home.headers["set-cookie"]);
    check("两位假角色、卡住的消息、出过的错都在", home.body.includes("晨星") && home.body.includes("暮雨") && home.body.includes('id="stuck"') && home.body.includes("这一轮失败"));
    for (const p of ["/c/alpha/base", "/c/alpha/assembled", "/c/alpha/tail", "/c/alpha/rotate", "/c/alpha/files", "/c/alpha/writings", "/audit"]) {
      const r = await req("GET", p);
      check(`${p} 200`, r.status === 200, String(r.status));
    }
    const tail = await req("GET", "/c/alpha/tail");
    check("暖尾巴页有候选轮", /name="keep"/.test(tail.body));
    const post = await req("POST", "/c/alpha/rotate", "csrf=x");
    check("改动类一律拒（403、写明演示模式）", post.status === 403 && post.body.includes("演示模式"));
    const lg = await req("GET", "/login");
    check("登录页直接回首页", lg.status === 303 && lg.headers.location === "/");
  } finally { child.kill("SIGTERM"); }
  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
