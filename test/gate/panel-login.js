"use strict";
/**
 * 面板登录（2026-10-22）：永久登录 + 滑动续期、登录码（主屏幕 App 用）、限速、码和链接互斥一次性、--revoke-all。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { createServer } = require("../../src/panel/server");
const auth = require("../../src/panel/auth");

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : "  " + extra)); ok ? pass++ : fail++; };
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

function req(port, method, p, { cookie, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers: {
      ...(cookie ? { cookie } : {}), ...(body != null ? { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) } : {}), ...headers } }, (res) => {
      let s = ""; res.setEncoding("utf8"); res.on("data", (d) => (s += d)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: s }));
    });
    r.on("error", reject); if (body != null) r.write(body); r.end();
  });
}
const sc = (r) => String((r.headers["set-cookie"] || [])[0] || "");

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "panel-login-"));
  const env = { HOME: home, PATH: process.env.PATH, PANEL_STATE_DIR: path.join(home, "state"), PANEL_CHARACTERS: "none:" + path.join(home, "nope.sh") };
  const server = createServer({ env });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const sessFile = path.join(env.PANEL_STATE_DIR, "sessions.json");

  try {
    console.log("[1] 登录码登录");
    const { token, code } = auth.issueLink({ env });
    check("码是 XXXX-XXXX、不含易混字", /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code) && !/[01OIL]/.test(code), code);
    const disk = fs.readFileSync(path.join(env.PANEL_STATE_DIR, "login-links.json"), "utf8");
    check("磁盘上没有码的明文", !disk.includes(code.replace("-", "")) && disk.includes(sha(code.replace("-", ""))));
    const lp = await req(port, "GET", "/login");
    check("GET /login 没带链接 → 输码页", lp.status === 200 && lp.body.includes('name="code"'));
    const ua = await req(port, "GET", "/");
    check("没登录的首页也能直接输码", ua.status === 401 && ua.body.includes('name="code"'));
    const ok = await req(port, "POST", "/login", { body: "code=" + encodeURIComponent(code.toLowerCase().replace("-", " ")) });
    check("输码（小写、带空格也认）→ 303 + cookie", ok.status === 303 && /panel_sid=/.test(sc(ok)), String(ok.status));
    const cookie = sc(ok).split(";")[0];
    check("进得去", (await req(port, "GET", "/", { cookie })).status === 200);

    console.log("\n[2] 码和链接是同一条：用掉一个，另一个也作废");
    const again = await req(port, "POST", "/login", { body: "code=" + code });
    check("同一个码第二次 → 401", again.status === 401);
    check("它配的那条链接也作废了", (await req(port, "POST", "/login", { body: "t=" + encodeURIComponent(token) })).status === 401);
    const b = auth.issueLink({ env });
    check("先用链接", (await req(port, "POST", "/login", { body: "t=" + encodeURIComponent(b.token) })).status === 303);
    check("再用它的码 → 401", (await req(port, "POST", "/login", { body: "code=" + b.code })).status === 401);
    const old = auth.issueLink({ env, now: Date.now() - 11 * 60_000 });
    check("11 分钟前的码 → 401", (await req(port, "POST", "/login", { body: "code=" + old.code })).status === 401);

    console.log("\n[3] 错码限速：同一 IP 连错 5 次锁 15 分钟");
    const good = auth.issueLink({ env });
    const A = { "cf-connecting-ip": "203.0.113.7" };
    let last;
    for (let i = 0; i < 5; i++) last = await req(port, "POST", "/login", { body: "code=ZZZZ-ZZZZ", headers: A });
    check("第 5 次错 → 429 + Retry-After", last.status === 429 && Number(last.headers["retry-after"]) > 800, String(last.status));
    const locked = await req(port, "POST", "/login", { body: "code=" + good.code, headers: A });
    check("锁着的时候连对的码也不收", locked.status === 429 && !sc(locked));
    const other = await req(port, "POST", "/login", { body: "code=" + good.code, headers: { "cf-connecting-ip": "198.51.100.2" } });
    check("别的 IP 不受影响（对的码照进）", other.status === 303);
    const th = fs.readFileSync(path.join(env.PANEL_STATE_DIR, "login-throttle.json"), "utf8");
    check("限速表里不存 IP 明文", !th.includes("203.0.113.7"));
    const later = auth.issueLink({ env, now: Date.now() + 15.5 * 60_000 });
    const r15 = auth.consumeCode(later.code, { headers: A }, { env, now: Date.now() + 16 * 60_000 });
    check("15 分钟后解锁", !!r15.sid);

    console.log("\n[4] 永久登录 + 滑动续期");
    const r1 = await req(port, "GET", "/", { cookie });
    check("已登录的请求都重新下发 cookie，Max-Age = 3650 天", /Max-Age=315360000/.test(sc(r1)) && /HttpOnly/.test(sc(r1)) && /SameSite=Strict/.test(sc(r1)), sc(r1));
    const env7 = { ...env, PANEL_SESSION_DAYS: "7" };
    const srv7 = createServer({ env: env7 });
    await new Promise((r) => srv7.listen(0, "127.0.0.1", r));
    const r7 = await req(srv7.address().port, "GET", "/", { cookie });
    check("PANEL_SESSION_DAYS=7 → Max-Age 7 天", /Max-Age=604800/.test(sc(r7)), sc(r7));
    srv7.close();
    // 线上已有的旧会话：7 天期限、还剩 1 天 —— 第一次访问就续成新期限，不用重新登录
    const oldSid = "legacy-session-id-from-before";
    const sessions = JSON.parse(fs.readFileSync(sessFile, "utf8"));
    const T = Date.now();
    sessions[sha(oldSid)] = { createdAt: T - 6 * 86400_000, expiresAt: T + 86400_000 };
    fs.writeFileSync(sessFile, JSON.stringify(sessions));
    const lr = await req(port, "GET", "/", { cookie: "panel_sid=" + oldSid });
    const row = JSON.parse(fs.readFileSync(sessFile, "utf8"))[sha(oldSid)];
    check("旧的 7 天会话：照样进得去", lr.status === 200);
    check("服务端 expiresAt 续成 ~3650 天后", row.expiresAt > T + 3649 * 86400_000, new Date(row.expiresAt).toISOString());
    check("cookie 也续了", /panel_sid=legacy-session-id-from-before/.test(sc(lr)) && /Max-Age=315360000/.test(sc(lr)));
    const dead = "legacy-already-expired";
    const s2 = JSON.parse(fs.readFileSync(sessFile, "utf8"));
    s2[sha(dead)] = { createdAt: T - 9 * 86400_000, expiresAt: T - 2 * 86400_000 };
    fs.writeFileSync(sessFile, JSON.stringify(s2));
    check("已经过期的旧会话不复活", (await req(port, "GET", "/", { cookie: "panel_sid=" + dead })).status === 401);

    console.log("\n[4b] 主屏幕：图标 / manifest 不用登录，登录页带全套 head");
    for (const f of ["apple-touch-icon.png", "icon-192.png", "icon-512.png", "favicon-32.png", "icon.svg"]) {
      const a = await req(port, "GET", "/assets/" + f);
      check(`/assets/${f} 不登录也能取`, a.status === 200 && /^image\//.test(a.headers["content-type"]), String(a.status));
    }
    const mf = await req(port, "GET", "/manifest.webmanifest");
    const mj = JSON.parse(mf.body);
    check("manifest：桥 · 圣所 / 圣所 / standalone / 192+512", mf.status === 200 && mj.name === "桥 · 圣所" && mj.short_name === "圣所" && mj.display === "standalone"
      && mj.icons.some((i) => i.sizes === "512x512"));
    const lg = (await req(port, "GET", "/login")).body;
    check("登录页 head：apple-touch-icon / favicon / 圣所 / 全屏 / theme-color 两套 / manifest",
      lg.includes('rel="apple-touch-icon"') && lg.includes('rel="icon"') && lg.includes('name="apple-mobile-web-app-title" content="圣所"')
      && lg.includes('name="apple-mobile-web-app-capable" content="yes"') && lg.includes('name="mobile-web-app-capable" content="yes"')
      && (lg.match(/name="theme-color"/g) || []).length === 2 && lg.includes('rel="manifest"'));
    check("CSP 放行 manifest", /manifest-src 'self'/.test(String((await req(port, "GET", "/login")).headers["content-security-policy"])));

    console.log("\n[5] --revoke-all");
    const out = execFileSync(process.execPath, [path.join(__dirname, "..", "..", "src", "panel", "server.js"), "--revoke-all"], { env, encoding: "utf8" });
    check("命令说清清掉几个", /清掉了 \d+ 个会话/.test(out), out);
    check("之前的会话全进不去了", (await req(port, "GET", "/", { cookie })).status === 401
      && (await req(port, "GET", "/", { cookie: "panel_sid=" + oldSid })).status === 401);
    const link = execFileSync(process.execPath, [path.join(__dirname, "..", "..", "src", "panel", "server.js"), "--issue-link"], { env, encoding: "utf8" });
    check("--issue-link 同时打出链接和登录码", /\/login\?t=/.test(link) && /登录码：[A-Z2-9]{4}-[A-Z2-9]{4}/.test(link), link);
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
