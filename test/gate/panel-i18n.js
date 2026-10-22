"use strict";
/**
 * 面板双语（2026-10-22）：浏览器要英文时每一页都有译文（漏译的键一条不许有）、<html lang> 跟着走、
 * PANEL_LANG=zh 能强制中文、PANEL_COPY_FILE 能改文案。全用临时目录里的假数据，不碰真实数据、不碰 pm2。
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { makeFixture } = require("../panel-fixture");
const { createServer } = require("../../src/panel/server");
const auth = require("../../src/panel/auth");
const i18n = require("../../src/panel/i18n");
const { makeControlSocket } = require("../../src/gate/control-socket");

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : "  " + extra)); ok ? pass++ : fail++; };

function req(port, method, p, { cookie, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers: {
      ...(cookie ? { cookie } : {}), ...(body != null ? { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) } : {}), ...headers } }, (res) => {
      let s = ""; res.setEncoding("utf8"); res.on("data", (d) => (s += d)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: s }));
    });
    r.on("error", reject); if (body != null) r.write(body); r.end();
  });
}
const form = (o) => Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => encodeURIComponent(k) + "=" + encodeURIComponent(x))).join("&");
const csrfOf = (html) => (/name="csrf" value="([^"]+)"/.exec(html) || [])[1] || "";
const baseOf = (html) => (/name="base" value="([0-9a-f]{64})"/.exec(html) || [])[1] || "";
const enc = encodeURIComponent;
const EN = { "accept-language": "en-US,en;q=0.9" };
const CJK = /[㐀-鿿＀-￯　-〿]/;
/** 页面上看得见的字：去掉 style / 标签。 */
const visible = (html) => html.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, "\n");

async function listen(env) {
  const server = createServer({ env });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: server.address().port };
}

(async () => {
  const fx = makeFixture({ names: { alpha: "Nova", beta: "Vega" } });
  const env = fx.env;
  const H = fx.home;
  const { server, port } = await listen(env);
  const login = async (p = port, e = env) => {
    const { token } = auth.issueLink({ env: e });
    const l = await req(p, "POST", "/login", { body: "t=" + enc(token) });
    return String((l.headers["set-cookie"] || [])[0]).split(";")[0];
  };
  const cookie = await login();
  const memory = path.join(H, ".alpha", "memory.md");
  const ctl = makeControlSocket({ file: path.join(H, ".alpha-gate", "control.sock"), owner: "owner-x",
    run: async (text, o) => { o.onStart(); return { ok: true, command: "new", text: "rotated. new session fake-thread-9." }; } });
  await ctl.start();
  const servers = [server];

  try {
    console.log("\n[1] 英文：每一页都有译文，一个漏译的键都没有");
    i18n.misses.clear();
    const pages = ["/", "/c/alpha/base", "/c/beta/base", "/c/alpha/failures", "/c/alpha/failures?h=168", "/c/alpha/rotate", "/c/beta/rotate",
      "/c/alpha/files", "/c/alpha/writings", "/c/alpha/tail", "/c/alpha/assembled", "/c/beta/assembled", "/audit", "/c/alpha/files/history",
      "/c/gamma/base", "/c/alpha/rotate/job?j=nope", "/nope"];
    const got = {};
    for (const p of pages) {
      const r = await req(port, "GET", p, { cookie, headers: EN });
      got[p] = r.body;
      check(`GET ${p} → ${p === "/nope" ? 404 : 200}，<html lang="en">`, r.status === (p === "/nope" ? 404 : 200) && r.body.includes('<html lang="en"'), String(r.status));
    }
    const files = got["/c/alpha/files"];
    const editHref = (/href="(\/c\/alpha\/files\/edit\?f=[^"]+)"/.exec(files) || [])[1];
    check("文件列表里有能打开的文件", !!editHref);
    const ed = await req(port, "GET", editHref.replace(/&amp;/g, "&"), { cookie, headers: EN });
    check("编辑页 200（英文）", ed.status === 200 && ed.body.includes("Review changes"));
    const edMem = await req(port, "GET", "/c/alpha/files/edit?f=" + enc(memory), { cookie, headers: EN });
    const csrf = csrfOf(edMem.body), base = baseOf(edMem.body);
    const pv = await req(port, "POST", "/c/alpha/files/preview", { cookie, headers: EN,
      body: form({ csrf, f: memory, base, text: "a new line\n" + fs.readFileSync(memory, "utf8") }) });
    check("改动对比页（英文）", pv.status === 200 && pv.body.includes("Confirm these changes?") && pv.body.includes("lines added"));
    const same = await req(port, "POST", "/c/alpha/files/preview", { cookie, headers: EN, body: form({ csrf, f: memory, base, text: fs.readFileSync(memory, "utf8") }) });
    check("没改动的提示（英文）", same.body.includes("Identical to the current file"));
    const conflict = await req(port, "POST", "/c/alpha/files/save", { cookie, headers: EN, body: form({ csrf, f: memory, base: "0".repeat(64), text: "x" }) });
    check("冲突页（英文）", conflict.status === 409 && conflict.body.includes("Not saved: the file was changed"));
    const sv = await req(port, "POST", "/c/alpha/files/save", { cookie, headers: EN, body: form({ csrf, f: memory, base, text: "saved in english\n" }) });
    check("保存 → 303", sv.status === 303, String(sv.status));
    const done = await req(port, "GET", sv.headers.location, { cookie, headers: EN });
    check("写完页（英文）", done.body.includes("Saved") && done.body.includes("Old version saved as"));
    const hist = await req(port, "GET", "/c/alpha/files/history?f=" + enc(memory), { cookie, headers: EN });
    const bid = (/files\/backup\?b=([^"]+)"/.exec(hist.body) || [])[1];
    const bk = await req(port, "GET", "/c/alpha/files/backup?b=" + bid, { cookie, headers: EN });
    check("历史版本页（英文）", bk.status === 200 && bk.body.includes("Restore this version"));
    const secret = await req(port, "GET", "/c/alpha/files/edit?f=" + enc(path.join(H, ".alpha", "secrets", "api.secret")), { cookie, headers: EN });
    check("凭据文件 → 拒绝页（英文）", secret.status === 403 && secret.body.includes("This file can&#39;t be edited"), String(secret.status));
    const rotBad = await req(port, "POST", "/c/alpha/rotate", { cookie, headers: EN, body: form({ csrf, model: "no-such-model" }) });
    check("换舱选了不存在的模型 → 拒绝（英文）", rotBad.status === 400 && rotBad.body.includes("isn&#39;t in the registry"));
    const rot = await req(port, "POST", "/c/alpha/rotate", { cookie, headers: EN, body: form({ csrf, model: "" }) });
    const job = await req(port, "GET", rot.headers.location || "/", { cookie, headers: EN });
    check("换舱进展页（英文）", job.status === 200 && /Rotated|Queued|Rotating/.test(job.body), String(rot.status));
    const tl = await req(port, "POST", "/c/alpha/tail", { cookie, headers: EN, body: form({ csrf, ver: "stale" }) });
    check("暖尾巴名单变了 → 拒绝（英文）", tl.status === 409 && tl.body.includes("Nothing changed"));
    const aud = await req(port, "GET", "/audit", { cookie, headers: EN });
    check("操作记录页（英文）", aud.body.includes("Actions taken in the panel") && aud.body.includes("Rotate pressed"));
    const lg = await req(port, "GET", "/login", { headers: EN });
    check("登录码页（英文）", lg.body.includes("Enter login code") && lg.body.includes('<html lang="en"'));
    const { token } = auth.issueLink({ env });
    const lk = await req(port, "GET", "/login?t=" + enc(token), { headers: EN });
    check("登录链接页（英文）", lk.body.includes("Welcome back") && lk.body.includes("The door is open for you."));
    const bad = await req(port, "POST", "/login", { headers: EN, body: "code=ZZZZ-ZZZZ" });
    check("登录码不对（英文）", bad.status === 401 && bad.body.includes("That code is wrong"));
    const u = await req(port, "GET", "/", { headers: EN });
    check("401 页（英文）", u.status === 401 && u.body.includes("This door needs a key"));
    const mf = await req(port, "GET", "/manifest.webmanifest", { headers: EN });
    check("主屏幕清单（英文）", JSON.parse(mf.body).name === "Bridge · Sanctuary" && JSON.parse(mf.body).lang === "en");
    const miss = [...i18n.misses];
    check("没有漏译的键", miss.length === 0, "\n    漏了：\n" + miss.map((k) => "      " + JSON.stringify(k)).join("\n"));

    console.log("\n[2] 英文：看得见的框架文字没有中文");
    const home = got["/"];
    for (const s of ["Overview", "Characters", "Held messages", "Recent errors", "Ledger", "On watch", "Worth a look", "Model actually in use", "Context used", "Beijing time"]) {
      check(`首页有「${s}」`, home.includes(s));
    }
    const navOf = (html) => visible((/<aside class="side">[\s\S]*?<\/aside>/.exec(html) || [""])[0] + (/<header class="top"[\s\S]*?<\/header>/.exec(html) || [""])[0]
      + (/<footer[\s\S]*?<\/footer>/.exec(html) || [""])[0]).split("\n").map((x) => x.trim()).filter(Boolean);
    for (const p of ["/", "/c/alpha/base", "/c/alpha/files", "/audit"]) {
      const cjk = navOf(got[p]).filter((x) => CJK.test(x));
      check(`${p}：侧栏 / 顶栏 / 页脚没有中文`, cjk.length === 0, JSON.stringify(cjk));
    }
    // 首页整页：去掉假数据里本来就是中文的东西（正文预览、理由、错误、gamma 的报错路径）之后不该再有中文
    const leftover = visible(home).split("\n").map((x) => x.trim()).filter((x) => CJK.test(x))
      .filter((x) => !/假|旧账|超时|进程中断|盒子忙|媒体下载|很长|env 文件不存在|gamma/.test(x));
    check("首页除了假数据没有中文", leftover.length === 0, JSON.stringify(leftover));
    check("时长是英文（… ago）", / ago\b/.test(home));
    check("水位用 k / M（284k / 1M）", home.includes("284k / 1M tokens"));

    console.log("\n[3] 默认中文；PANEL_LANG=zh 强制中文");
    const zhHome = await req(port, "GET", "/", { cookie });
    check('不带 Accept-Language → <html lang="zh-CN">', zhHome.body.includes('<html lang="zh-CN"') && zhHome.body.includes("卡住的消息"));
    check("中文水位照旧（28.4 万 / 100 万）", zhHome.body.includes("28.4 万 / 100 万 tokens"));
    const zhEnv = { ...env, PANEL_LANG: "zh" };
    const z = await listen(zhEnv); servers.push(z.server);
    const zc = await login(z.port, zhEnv);
    const forced = await req(z.port, "GET", "/", { cookie: zc, headers: EN });
    check("PANEL_LANG=zh + 英文浏览器 → 中文", forced.body.includes('<html lang="zh-CN"') && forced.body.includes("卡住的消息") && !forced.body.includes("Held messages"));
    const enEnv = { ...env, PANEL_LANG: "en" };
    const e = await listen(enEnv); servers.push(e.server);
    const forcedEn = await req(e.port, "GET", "/login");
    check("PANEL_LANG=en + 没有 Accept-Language → 英文", forcedEn.body.includes('<html lang="en"') && forcedEn.body.includes("Enter login code"));

    console.log("\n[4] PANEL_COPY_FILE 改文案");
    const copyFile = path.join(H, "panel-copy.json");
    fs.writeFileSync(copyFile, JSON.stringify({ zh: { "门已经为你开好了。": "欢迎。" }, en: { "门已经为你开好了。": "Come on in." } }));
    const cpEnv = { ...env, PANEL_COPY_FILE: copyFile };
    const cp = await listen(cpEnv); servers.push(cp.server);
    const t1 = auth.issueLink({ env: cpEnv }).token;
    const zhLink = await req(cp.port, "GET", "/login?t=" + enc(t1));
    check("中文登录链接页用了改过的文案", zhLink.body.includes("<p>欢迎。</p>") && !zhLink.body.includes("门已经为你开好了。"));
    const enLink = await req(cp.port, "GET", "/login?t=" + enc(t1), { headers: EN });
    check("英文登录链接页也能改", enLink.body.includes("<p>Come on in.</p>"));
  } finally {
    await ctl.stop();
    for (const s of servers) s.close();
    fs.rmSync(fx.home, { recursive: true, force: true });
  }
  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
