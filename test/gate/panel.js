"use strict";
/**
 * 只读面板（src/panel）：鉴权、一次性链接、跨角色标红、单个角色坏了不拖垮整页、只读。
 * 全用临时目录里的假数据（test/panel-fixture.js），不碰真实数据、不碰 pm2。
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { makeFixture } = require("../panel-fixture");
const { createServer } = require("../../src/panel/server");
const auth = require("../../src/panel/auth");
const { classifyPath, ownRoots } = require("../../src/panel/characters");

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : "  " + extra)); ok ? pass++ : fail++; };

function req(port, method, p, { cookie, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers: {
      ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) } : {}), ...headers } }, (res) => {
      let s = ""; res.setEncoding("utf8"); res.on("data", (d) => (s += d)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: s }));
    });
    r.on("error", reject); if (body) r.write(body); r.end();
  });
}

/** 一个目录树的指纹（路径 + 大小 + mtime），用来证明面板没写它。 */
function snapshot(dir) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else { const st = fs.statSync(p); out.push(p + ":" + st.size + ":" + st.mtimeMs); }
  } };
  walk(dir);
  return out.sort().join("\n");
}

(async () => {
  const fx = makeFixture();
  const env = fx.env;
  const server = createServer({ env });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const roleDirs = [".alpha-gate", ".alpha", ".beta-gate", ".beta", "alpha-identity", "beta-identity"].map((d) => path.join(fx.home, d))
    .filter((d) => fs.existsSync(d));
  const before = roleDirs.map(snapshot).join("\n");

  try {
    console.log("\n[1] 没有 cookie 一律 401，不渲染内容");
    for (const p of ["/", "/c/alpha/base", "/c/alpha/failures", "/c/nope/base", "/favicon.ico"]) {
      const r = await req(port, "GET", p);
      check(`GET ${p} → 401`, r.status === 401, String(r.status));
      check(`GET ${p} 页面里没有角色内容`, !/晨星|暮雨|alpha|假/.test(r.body));
    }
    const bad = await req(port, "GET", "/", { cookie: "panel_sid=forged-value" });
    check("伪造的 cookie → 401", bad.status === 401);

    console.log("\n[2] 一次性链接：只能用一次、过期作废、只存哈希");
    const { token } = auth.issueLink({ env });
    const g = await req(port, "GET", "/login?t=" + encodeURIComponent(token));
    check("GET 链接 → 进门页 200（不消耗）", g.status === 200 && /进 门/.test(g.body));
    const g2 = await req(port, "GET", "/login?t=" + encodeURIComponent(token));
    check("再 GET 一次还在（预览抓取不会用掉它）", g2.status === 200);
    const p1 = await req(port, "POST", "/login", { body: "t=" + encodeURIComponent(token) });
    const setCookie = String((p1.headers["set-cookie"] || [])[0] || "");
    check("POST 用掉 → 303 回首页", p1.status === 303 && p1.headers.location === "/", String(p1.status));
    check("cookie 带 HttpOnly / SameSite=Strict / 默认 3650 天（2026-10-22 起「永久登录」）", /HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie) && /Max-Age=315360000/.test(setCookie), setCookie);
    check("http 下不带 Secure", !/Secure/.test(setCookie));
    const p2 = await req(port, "POST", "/login", { body: "t=" + encodeURIComponent(token) });
    check("同一个链接第二次 → 401", p2.status === 401 && !p2.headers["set-cookie"], String(p2.status));
    const g3 = await req(port, "GET", "/login?t=" + encodeURIComponent(token));
    check("用过之后 GET 也 → 401", g3.status === 401);
    const old = auth.issueLink({ env, now: Date.now() - 11 * 60 * 1000 });
    const p3 = await req(port, "POST", "/login", { body: "t=" + encodeURIComponent(old.token) });
    check("11 分钟前发的链接 → 401", p3.status === 401);
    const sd = env.PANEL_STATE_DIR;
    check("状态目录 0700", (fs.statSync(sd).mode & 0o777) === 0o700, (fs.statSync(sd).mode & 0o777).toString(8));
    const files = fs.readdirSync(sd);
    check("状态文件全是 0600", files.length > 0 && files.every((f) => (fs.statSync(path.join(sd, f)).mode & 0o777) === 0o600), files.join(","));
    const disk = files.map((f) => fs.readFileSync(path.join(sd, f), "utf8")).join("\n");
    const sid = /panel_sid=([^;]+)/.exec(setCookie)[1];
    check("磁盘上没有 token / 会话 id 明文", !disk.includes(token) && !disk.includes(sid) && disk.includes(crypto.createHash("sha256").update(sid).digest("hex")));
    const s3 = auth.issueLink({ env });
    const secureSrv = createServer({ env: { ...env, PANEL_PUBLIC_URL: "https://panel.example" } });
    await new Promise((r) => secureSrv.listen(0, "127.0.0.1", r));
    const ps = await req(secureSrv.address().port, "POST", "/login", { body: "t=" + encodeURIComponent(s3.token) });
    check("https 时 cookie 带 Secure", /Secure/.test(String((ps.headers["set-cookie"] || [])[0])));
    secureSrv.close();
    const cookie = "panel_sid=" + sid;
    const longAgo = Date.now() - 3651 * 86400_000;
    const expired = auth.consumeLink(auth.issueLink({ env, now: longAgo }).token, { env, now: longAgo + 1000 });
    const re = await req(port, "GET", "/", { cookie: "panel_sid=" + expired });
    check("过了期限（3650 天前、没再来过）的会话 → 401", re.status === 401);

    console.log("\n[3] 首页：每个角色一张卡，坏掉的角色只坏它自己那张");
    const home = await req(port, "GET", "/", { cookie });
    check("首页 200", home.status === 200, String(home.status));
    check("显示名来自 env（晨星 / 暮雨）", home.body.includes("晨星") && home.body.includes("暮雨"));
    check("gamma 的 env 缺了 → 它那张卡报错", /gamma[\s\S]*这张卡片读不出来[\s\S]*env 文件不存在/.test(home.body));
    check("当前模型", home.body.includes("claude-fable-5[1m]") && home.body.includes("gpt-5.6-sol"));
    check("上下文水位 28%", /28<small>%<\/small>/.test(home.body));
    check("悬着的入站 2 条（没确认 + 排队中）", home.body.includes("入站记录里悬着 2 条（没确认 1、排队中 1）"));
    check("最老一条悬了 3 小时", home.body.includes("最老一条悬了 3 小时"));
    const alphaCard = (home.body.match(/<section class="ch [^"]*" id="c-alpha">[\s\S]*?<\/section>/) || [""])[0];
    const betaCard = (home.body.match(/<section class="ch [^"]*" id="c-beta">[\s\S]*?<\/section>/) || [""])[0];
    check("alpha 24 小时出错 = 3（turn.failed + blocked + 模型告警，窗口外的不算）", /24 小时出错<\/span><b>3<\/b>/.test(alphaCard), alphaCard.slice(0, 0));
    check("出过的错列表里有三类、没有窗口外那条", home.body.includes("这一轮失败") && home.body.includes("发送被拦")
      && home.body.includes("模型兜底告警") && !home.body.includes("发出去没确认"));
    const iFail = home.body.indexOf("假错误：API 超时"), iBlock = home.body.indexOf("假原因：白名单");
    check("出过的错倒序（2 小时前在 4 小时前上面）", iFail > 0 && iBlock > iFail);
    check("停着的进程看得出来", /<b>cli<\/b>[^]*?<span class="ps-t off">停着<\/span>/.test(betaCard));
    check("pm2 环境里的密钥不往页面上漏", !home.body.includes("pm2-env-secret"));
    check("聊天正文不上页面", !home.body.includes("假的入站正文"));
    check("不加载外部资源", !/(src|href)="(https?:)?\/\//.test(home.body) && !/url\((https?:)?\/\//.test(home.body) && !/@import/.test(home.body));
    check("CSP 默认全禁", /default-src 'none'/.test(String(home.headers["content-security-policy"])));
    check("没有脚本", !/<script/i.test(home.body));

    console.log("\n[3b] 两个角色同一页并排 + 真正在用的模型");
    check("两张角色卡都在首页", !!alphaCard && !!betaCard && home.body.indexOf('id="c-alpha"') < home.body.indexOf('id="c-beta"'));
    check("模型取盒子实测（心跳），请求的不一样时并列说明", alphaCard.includes('<div class="model">claude-fable-5[1m]</div>') && alphaCard.includes("盒子实测"));
    check("掉档告警亮出来", alphaCard.includes("掉档了：实际答话的是 claude-opus-4-8"));
    const { engineOf } = require("../../src/panel/collect");
    const eng0 = engineOf({ ok: true, models: [{ runtime: "claudecode", model: "req-model" }] }, { ok: false, model: "" }, { ok: true, bad: false });
    check("没有实测 → actual 空（页面写「未确认」），不拿请求的冒充", eng0.actual === "" && eng0.requested === "req-model");
    const fxU = makeFixture({ missingRole: false });
    fs.writeFileSync(path.join(fxU.home, ".beta-gate", "heartbeat.json"), JSON.stringify({ at: new Date().toISOString() }));
    const srvU = createServer({ env: fxU.env });
    await new Promise((r) => srvU.listen(0, "127.0.0.1", r));
    const tU = auth.issueLink({ env: fxU.env });
    const lU = await req(srvU.address().port, "POST", "/login", { body: "t=" + encodeURIComponent(tU.token) });
    const hU = await req(srvU.address().port, "GET", "/", { cookie: String((lU.headers["set-cookie"] || [])[0]).split(";")[0] });
    const bU = (hU.body.match(/id="c-beta">[\s\S]*?<\/section>/) || [""])[0];
    check("心跳里没模型 → 写「未确认」，请求的只当旁注", bU.includes('<div class="model none">未确认</div>') && bU.includes("请求的是 gpt-5.6-sol"));
    srvU.close();
    fs.rmSync(fxU.home, { recursive: true, force: true });

    console.log("\n[3c] 卡住的消息（跟 /pending 同一套口径）");
    const stuck = (home.body.match(/<section class="panel pad" id="stuck">[\s\S]*?<\/section>/) || [""])[0];
    const tally = (label) => { const m = new RegExp("<b>(\\d+)</b>" + label).exec(stuck); return m ? Number(m[1]) : -1; };
    check("一共 5 条", tally("条一共") === 5, String(tally("条一共")));
    check("unknown 算卡住 1", tally("卡住") === 1);
    check("rejected（新状态）认得：拒收 2（alpha 自动重投中 + beta 旧账）", tally("拒收") === 2, String(tally("拒收")));
    check("死信 1 = 2 条减掉 handled-dead-letters 里处理过的 1 条", tally("死信") === 1 && !stuck.includes("已经处理过的死信"));
    check("待核对 1（已 resolved 的那条不算）", tally("待核对") === 1 && !stuck.includes("已经补发过的"));
    check("状态是中文", stuck.includes("卡住了（不知道他收没收）") && stuck.includes("拒收（旧账，不会自动重投）") && stuck.includes("进了死信") && stuck.includes("不知道发没发"));
    check("提示去 TG 发 /pending", stuck.includes("在 Telegram 发 <code>/pending</code> 处理"));
    check("正文只露前 20 字", stuck.includes("「这是一句很长很长的假正文，后半句绝对不能…」") && !home.body.includes("秘密尾巴") && !home.body.includes("尾巴不许露") && !home.body.includes("后半句也不能露出来"));
    check("只读：没有重投 / 放弃按钮、没有表单", !/<form|<button|method=|\/pending (retry|drop) /i.test(stuck));
    check("编号跟 /pending 一致（类别字母 + 哈希）", /#t[0-9a-f]{4,}/.test(stuck) && /#d[0-9a-f]{4,}/.test(stuck) && /#u[0-9a-f]{4,}/.test(stuck));
    const visible = home.body.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, " ");
    check("界面上不露 uncertain / rejected / undelivered / pending 这类术语（/pending 命令除外）",
      !/uncertain|rejected|undelivered/i.test(visible) && !/pending/i.test(visible.replace(/\/pending/g, "")));

    console.log("\n[3d] 自带的图");
    const img = await req(port, "GET", "/assets/duomo-facade.webp");
    check("图不用登录，类型对", img.status === 200 && img.headers["content-type"] === "image/webp");
    for (const bad of ["/assets/../server.js", "/assets/render.js", "/assets/%2e%2e%2fserver.js"]) {
      const r = await req(port, "GET", bad);
      check(`${bad} → 拿不到`, r.status === 404 || r.status === 401, String(r.status));
    }

    console.log("\n[4] 底子页：跨角色的来源标红");
    const bb = await req(port, "GET", "/c/beta/base", { cookie });
    check("beta 底子页 200", bb.status === 200, String(bb.status));
    check("beta 拼出了自己的记忆", bb.body.includes("暮雨的假长期记忆"));
    check("beta 的笔记本指进 alpha 目录 → 那一节整块标红", /<details class="sec cross">[\s\S]*?PENDING PROMISES[\s\S]*?来自别的角色[\s\S]*?属于 alpha/.test(bb.body));
    check("只有那一节标红", (bb.body.match(/<details class="sec cross">/g) || []).length === 1, String((bb.body.match(/<details class="sec cross">/g) || []).length));
    check("代码模块不算跨角色", !/class="x"><span class="k">代码模块/.test(bb.body));
    const ab = await req(port, "GET", "/c/alpha/base", { cookie });
    check("alpha 底子页没有标红", ab.status === 200 && !ab.body.includes('class="sec cross"'));
    check("alpha 底子里没有 beta 的东西（侧栏导航里的名字不算）", !ab.body.includes("暮雨的假"));
    check("alpha 有六节、列出来源文件", ["执行规则", "身份底座", "LONG-TERM MEMORY", "PENDING PROMISES", "RECENT DIARY", "BODY STATE"].every((n) => ab.body.includes(n))
      && ab.body.includes(path.join(fx.home, ".alpha", "memory.md")));
    check("下半部分：当前这一舱注入记录 + 指纹变了", ab.body.includes("当前这一舱实际注入的") && ab.body.includes("文件已经变了"));
    const gb = await req(port, "GET", "/c/gamma/base", { cookie });
    check("gamma 底子页报错但不崩", gb.status === 200 && gb.body.includes("配置读不出来"));
    const nf = await req(port, "GET", "/c/nope/base", { cookie });
    check("不认识的角色 → 404", nf.status === 404);

    console.log("\n[5] 失败详情");
    const fl = await req(port, "GET", "/c/alpha/failures", { cookie });
    check("失败详情 200，列出 turn.failed 及原因", fl.status === 200 && fl.body.includes("这一轮失败") && fl.body.includes("假错误：API 超时"));
    const i1 = fl.body.indexOf("这一轮失败"), i2 = fl.body.indexOf("发送被拦");
    check("按时间倒序（2 小时前的在 4 小时前的上面）", i1 > 0 && i2 > i1);
    check("悬着的入站也列出来（状态用中文）", fl.body.includes("悬着的入站（2）") && fl.body.includes("没确认") && !fl.body.includes("uncertain"));
    const f7 = await req(port, "GET", "/c/alpha/failures?h=168", { cookie });
    check("?h=168 能看到 30 小时前那条", f7.body.includes("发出去没确认"));

    console.log("\n[6] 路径判定");
    const mine = ownRoots({ HOME: "/home/x", GATE_ROOT: "/home/x/.a-gate", NOVA_STATE_DIR: "/home/x/.a", GATE_WORKSPACE_ROOT: "/home/x" });
    check("HOME 本身不算本角色目录", !mine.some((r) => r.dir === "/home/x"));
    check("/home/x/.a 不包含 /home/x/.a-gate 之外的 .a-gate2", classifyPath("/home/x/.a-gate2/f", mine).cross);
    check("不在本角色目录下 → 标红", classifyPath("/srv/other/notes.json", mine).cross);
    check("在本角色目录下 → 不标", !classifyPath("/home/x/.a/memory.md", mine).cross);
    check("落进别人目录 → 标红并点名", classifyPath("/home/x/.b/n.json", mine, [{ id: "b", roots: [{ dir: "/home/x/.b" }] }]).foreign[0] === "b");

    console.log("\n[7] 拼底子的子进程只带角色自己的 env");
    const fx2 = makeFixture({ crossLeak: false, missingRole: false, betaNoNotebook: true });
    const alphaNb = path.join(fx2.home, ".alpha", "notebook.json");
    const store = path.join(fx2.home, "notebook-code", "store");
    // 面板自己的进程（和传给它的 env）里有笔记本配置 —— 不许漏进 beta 的子进程
    const saved = { m: process.env.NOVA_NOTEBOOK_MODULE, f: process.env.NOVA_NOTEBOOK_FILE };
    process.env.NOVA_NOTEBOOK_MODULE = store; process.env.NOVA_NOTEBOOK_FILE = alphaNb;
    const srv2 = createServer({ env: { ...fx2.env, NOVA_NOTEBOOK_MODULE: store, NOVA_NOTEBOOK_FILE: alphaNb } });
    await new Promise((r) => srv2.listen(0, "127.0.0.1", r));
    const t2 = auth.issueLink({ env: fx2.env });
    const l2 = await req(srv2.address().port, "POST", "/login", { body: "t=" + encodeURIComponent(t2.token) });
    const c2 = String((l2.headers["set-cookie"] || [])[0]).split(";")[0];
    const b2 = await req(srv2.address().port, "GET", "/c/beta/base", { cookie: c2 });
    check("beta 没配笔记本 → 底子里没有 PENDING PROMISES（面板的 env 不漏进去）", b2.status === 200 && b2.body.includes("暮雨的假长期记忆")
      && !b2.body.includes("晨星的假待办") && /这几节这次是空的[^<]*PENDING PROMISES/.test(b2.body));
    srv2.close();
    if (saved.m === undefined) delete process.env.NOVA_NOTEBOOK_MODULE; else process.env.NOVA_NOTEBOOK_MODULE = saved.m;
    if (saved.f === undefined) delete process.env.NOVA_NOTEBOOK_FILE; else process.env.NOVA_NOTEBOOK_FILE = saved.f;
    fs.rmSync(fx2.home, { recursive: true, force: true });

    console.log("\n[8] 错误日志基线（pm2 日志没时间戳，靠面板自己记的大小）");
    const { errLogDelta } = require("../../src/panel/collect");
    const lg = path.join(fx.home, "pm2-logs", "probe-error.log");
    fs.writeFileSync(lg, "旧的一行\n");
    const T0 = Date.now();
    const e0 = errLogDelta("probe", lg, { env, now: T0 });
    check("第一次看：没有基线，只给尾巴、不计数", !e0.baseline && e0.newLines.length === 0 && e0.tail.length === 1);
    fs.appendFileSync(lg, "新错误 A\n新错误 B\n");
    const e1 = errLogDelta("probe", lg, { env, now: T0 + 25 * 3600_000 });
    check("25 小时后：基线之后新增的 2 行算新错误", e1.baseline && e1.newLines.length === 2 && e1.newLines[0] === "新错误 A", JSON.stringify(e1.newLines));

    console.log("\n[9] 只读");
    check("角色目录一个字节都没动", roleDirs.map(snapshot).join("\n") === before);
  } finally {
    server.close();
    fs.rmSync(fx.home, { recursive: true, force: true });
  }
  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
