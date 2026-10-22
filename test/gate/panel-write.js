"use strict";
/**
 * 面板会改东西的那几样（2026-10-22）：换舱、改文件、他写的东西、暖尾巴挑选、整舱预演。
 * 全用临时目录里的假数据（test/panel-fixture.js）+ 假的桥控制口，不碰真实数据、不碰 pm2。
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { makeFixture } = require("../panel-fixture");
const { createServer } = require("../../src/panel/server");
const auth = require("../../src/panel/auth");
const { makeControlSocket } = require("../../src/gate/control-socket");

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : "  " + extra)); ok ? pass++ : fail++; };
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

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

(async () => {
  const fx = makeFixture();
  const env = fx.env;
  const H = fx.home;
  const server = createServer({ env });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const login = async () => {
    const { token } = auth.issueLink({ env });
    const l = await req(port, "POST", "/login", { body: "t=" + enc(token) });
    return String((l.headers["set-cookie"] || [])[0]).split(";")[0];
  };
  const cookie = await login();
  const memory = path.join(H, ".alpha", "memory.md");
  const ctlFile = path.join(H, ".alpha-gate", "control.sock");
  const ran = [];
  const ctl = makeControlSocket({ file: ctlFile, owner: "owner-x",
    run: async (text, o) => { o.onStart(); ran.push({ text, by: o.by }); return { ok: true, command: "new", text: "换好了。新舱 fake-thread-9。" }; } });
  await ctl.start();

  try {
    console.log("\n[1] 没登录：改动类请求一律 401，什么都不动");
    const before = fs.readFileSync(memory, "utf8");
    for (const [m, p] of [["POST", "/c/alpha/rotate"], ["POST", "/c/alpha/files/save"], ["POST", "/c/alpha/tail"], ["GET", "/c/alpha/files"], ["GET", "/c/alpha/writings"], ["GET", "/audit"], ["GET", "/c/alpha/assembled"]]) {
      const r = await req(port, m, p, m === "POST" ? { body: form({ f: memory, text: "x", base: "0".repeat(64) }) } : {});
      check(`${m} ${p} → 401`, r.status === 401, String(r.status));
    }
    check("没换舱、没写文件", ran.length === 0 && fs.readFileSync(memory, "utf8") === before);

    console.log("\n[2] CSRF / 方法 / 来源");
    const ed = await req(port, "GET", "/c/alpha/files/edit?f=" + enc(memory), { cookie });
    const csrf = csrfOf(ed.body);
    const base0 = baseOf(ed.body);
    check("编辑页 200，带 CSRF 令牌和打开时的指纹", ed.status === 200 && csrf.length > 20 && base0 === sha(fs.readFileSync(memory)));
    const saveBody = (o = {}) => form({ csrf, f: memory, base: base0, text: "改过的长期记忆\n", ...o });
    let r = await req(port, "POST", "/c/alpha/files/save", { cookie, body: form({ f: memory, base: base0, text: "x" }) });
    check("没令牌 → 403", r.status === 403, String(r.status));
    r = await req(port, "POST", "/c/alpha/files/save", { cookie, body: saveBody({ csrf: csrf.slice(0, -2) + "xx" }) });
    check("错令牌 → 403", r.status === 403);
    const cookie2 = await login();
    const csrf2 = csrfOf((await req(port, "GET", "/c/alpha/files/edit?f=" + enc(memory), { cookie: cookie2 })).body);
    r = await req(port, "POST", "/c/alpha/files/save", { cookie, body: saveBody({ csrf: csrf2 }) });
    check("别的会话的令牌 → 403（令牌跟会话绑死）", r.status === 403 && csrf2 !== csrf);
    r = await req(port, "POST", "/c/alpha/files/save", { cookie, body: saveBody(), headers: { origin: "https://evil.example" } });
    check("别的网站发来的（Origin 不对）→ 403", r.status === 403);
    r = await req(port, "POST", "/c/alpha/files/save", { cookie, body: saveBody(), headers: { "sec-fetch-site": "cross-site" } });
    check("Sec-Fetch-Site: cross-site → 403", r.status === 403);
    r = await req(port, "GET", "/c/alpha/files/save?f=" + enc(memory) + "&text=x&csrf=" + enc(csrf), { cookie });
    check("改动只收 POST（GET 保存 → 405）", r.status === 405);
    r = await req(port, "PUT", "/c/alpha/files/save", { cookie, body: saveBody() });
    check("PUT → 405", r.status === 405);
    check("以上都没写进去", fs.readFileSync(memory, "utf8") === before);

    console.log("\n[3] 换舱：走桥的 /new，以主人身份，结果回显");
    const rc = await req(port, "GET", "/c/alpha/rotate", { cookie });
    check("确认页写清：打断这一句 / 下一句开新舱 / 跟 TG /new 一样", rc.status === 200 && rc.body.includes("会打断他正在说的那一句") && rc.body.includes("开新舱") && rc.body.includes("/new") && /<form method="post" action="\/c\/alpha\/rotate">/.test(rc.body));
    check("GET 确认页不触发换舱", ran.length === 0);
    r = await req(port, "POST", "/c/alpha/rotate", { cookie, body: form({}) });
    check("没令牌按换舱 → 403、没换", r.status === 403 && ran.length === 0);
    r = await req(port, "POST", "/c/alpha/rotate", { cookie, body: form({ csrf: csrfOf(rc.body) }) });
    check("按下 → 303 去看进展（刷新不会再按一次）", r.status === 303 && /\/c\/alpha\/rotate\/job\?j=j-/.test(r.headers.location || ""), String(r.status));
    check("桥收到的就是 /new，经控制口", ran.length === 1 && /^\/new /.test(String(ran[0].text)) && ran[0].by === "panel", JSON.stringify(ran));
    const job = await req(port, "GET", r.headers.location, { cookie });
    check("进展页：换好了 + 主人身份 + 桥的回执原文", job.body.includes("换好了") && job.body.includes("主人（owner-x）") && job.body.includes("fake-thread-9"));
    await req(port, "GET", r.headers.location, { cookie });
    const nb = await req(port, "POST", "/c/beta/rotate", { cookie, body: form({ csrf }) });
    check("beta 的桥没有控制口 → 明说连不上（502），不假装成功", nb.status === 502 && nb.body.includes("连不上"));

    console.log("\n[3c] 换舱时选模型：发出去的命令序列");
    check("确认页：模型清单来自登记表，默认「不换，还用 Fable 5」", /<input type="radio" name="model" value="" checked>/.test(rc.body)
      && rc.body.includes("不换，还用 Fable 5") && rc.body.includes('value="claude-opus-5-5[1m]"') && rc.body.includes('value="gpt-5.6-sol"')
      && !/value="claude-fable-5\[1m\]"/.test(rc.body), "");
    check("每项写着引擎和上下文窗口", rc.body.includes("Claude · 上下文 100 万") && rc.body.includes("Codex · 上下文 87.2 万"));
    check("写明跨引擎的后果（带过去 / 带不过去）", rc.body.includes("带过去的") && rc.body.includes("带不过去的") && rc.body.includes("/engine"));
    const rot = async (model) => {
      const n = ran.length;
      const x = await req(port, "POST", "/c/alpha/rotate", { cookie, body: form({ csrf: csrfOf(rc.body), model }) });
      return { status: x.status, sent: ran.slice(n).map((y) => y.text) };
    };
    const seq = (v) => JSON.stringify(Array.isArray(v) ? v : [v]);
    let o = await rot("");
    check("不换 → 只发 /new", o.status === 303 && o.sent.length === 1 && /^\["\/new [^"]*"\]$/.test(seq(o.sent[0])), JSON.stringify(o));
    o = await rot("claude-fable-5[1m]");
    check("选的就是现在这个 → 也只发 /new", o.sent.length === 1 && /^\["\/new /.test(seq(o.sent[0])), JSON.stringify(o));
    o = await rot("claude-opus-5-5[1m]");
    check("同一家别的模型 → 先 /new 再 /model <id>（一串）", o.status === 303 && o.sent.length === 1 && Array.isArray(o.sent[0]) && o.sent[0].length === 2
      && /^\/new /.test(o.sent[0][0]) && o.sent[0][1] === "/model claude-opus-5-5[1m]", JSON.stringify(o));
    o = await rot("gpt-5.6-sol");
    check("跨引擎 → 只发 /engine <id>（不叠 /new）", o.status === 303 && seq(o.sent[0]) === JSON.stringify(["/engine gpt-5.6-sol"]), JSON.stringify(o));
    o = await rot("claude-not-registered");
    check("登记表里没有的 id → 400、什么都没发", o.status === 400 && o.sent.length === 0, JSON.stringify(o));
    o = await rot("claude-opus-5-5[1m]\n/undo ok");
    check("夹带别的命令 → 400、什么都没发", o.status === 400 && o.sent.length === 0, JSON.stringify(o));
    const nc = await req(port, "POST", "/c/alpha/rotate", { cookie, body: form({ model: "claude-opus-5-5[1m]" }) });
    check("选模型也要 CSRF 令牌（没有 → 403、没发）", nc.status === 403);
    const bc = await req(port, "GET", "/c/beta/rotate", { cookie });
    check("beta 登记表只有一个：写明只有这一个", bc.body.includes("登记表里只有这一个模型"));

    console.log("\n[4] 能改哪些");
    const fl = await req(port, "GET", "/c/alpha/files", { cookie });
    check("alpha 文件列表 200，列出长期记忆和人格", fl.status === 200 && fl.body.includes(enc(memory)) && fl.body.includes(enc(path.join(H, ".alpha", "persona.md"))));
    check("页面写着改动下次换舱才生效 + 现在换舱入口", fl.body.includes("下次换舱才生效") && fl.body.includes('href="/c/alpha/rotate"'));
    const bl = await req(port, "GET", "/c/beta/files", { cookie });
    const alphaNb = path.join(H, ".alpha", "notebook.json");
    check("beta 的笔记本指进 alpha 目录 → 列在「不能改」里、标红", bl.body.includes("不能改的") && bl.body.includes(alphaNb) && /在 alpha 的目录里/.test(bl.body));
    const refused = async (who, f, why) => {
      const x = await req(port, "GET", `/c/${who}/files/edit?f=` + enc(f), { cookie });
      check(why, x.status === 403, x.status + " " + (x.body.match(/<p>([^<]*)<\/p>/) || [])[1]);
      return x;
    };
    await refused("beta", alphaNb, "别人目录的文件（beta 打开 alpha 的笔记本）→ 403");
    await refused("beta", path.join(H, ".alpha", "memory.md"), "别人目录、清单里没有的 → 403");
    await refused("alpha", fx.envFiles.alpha, "*-env.sh → 403");
    await refused("alpha", path.join(H, ".alpha", "secrets", "api.secret"), "*.secret → 403");
    fs.writeFileSync(path.join(H, ".alpha", ".env"), "TOKEN=fake\n");
    await refused("alpha", path.join(H, ".alpha", ".env"), ".env → 403");
    await refused("alpha", H + "/.alpha/notes/../memory.md", "路径里带 .. → 403");
    await refused("alpha", H + "/.alpha//memory.md", "路径里多余的斜杠 → 403");
    await refused("alpha", path.join(H, ".beta", "memory.md"), "beta 的记忆（alpha 名下）→ 403");
    await refused("alpha", path.join(H, ".alpha-gate", "turns.json"), "桥根里的运行账本 → 403");
    fs.writeFileSync(path.join(H, ".alpha", "sessions.json"), "{}");
    await refused("alpha", path.join(H, ".alpha", "sessions.json"), "他目录里的账本类文件名（sessions.json）→ 403");
    fs.symlinkSync(path.join(H, ".beta", "memory.md"), path.join(H, ".alpha", "notes", "逃出去.md"));
    await refused("alpha", path.join(H, ".alpha", "notes", "逃出去.md"), "软链接指到 beta 目录 → 403");
    fs.writeFileSync(path.join(H, "outside.md"), "外面的");
    fs.symlinkSync(path.join(H, "outside.md"), path.join(H, ".alpha", "notes", "指外面.md"));
    await refused("alpha", path.join(H, ".alpha", "notes", "指外面.md"), "软链接指出角色目录 → 403");
    fs.writeFileSync(path.join(H, ".alpha", "notes", "藏着空字符.txt"), Buffer.from("abc\0def"));
    await refused("alpha", path.join(H, ".alpha", "notes", "藏着空字符.txt"), "二进制（有空字符）→ 403");
    fs.writeFileSync(path.join(H, ".alpha", "notes", "太大.md"), "a".repeat(2 * 1024 * 1024 + 10));
    await refused("alpha", path.join(H, ".alpha", "notes", "太大.md"), "超过 2MB → 403");
    r = await req(port, "POST", "/c/alpha/files/save", { cookie, body: form({ csrf, f: path.join(H, ".alpha", "secrets", "api.secret"), base: sha(fs.readFileSync(path.join(H, ".alpha", "secrets", "api.secret"))), text: "pwned" }) });
    check("直接 POST 保存凭据文件也不行 → 403、原样", r.status === 403 && fs.readFileSync(path.join(H, ".alpha", "secrets", "api.secret"), "utf8") === "fake-secret-value");
    r = await req(port, "POST", "/c/alpha/files/save", { cookie, body: form({ csrf, f: path.join(H, ".alpha", "notes", "逃出去.md"), base: sha(fs.readFileSync(path.join(H, ".beta", "memory.md"))), text: "pwned" }) });
    check("直接 POST 写软链接逃逸 → 403、beta 的文件原样", r.status === 403 && !fs.readFileSync(path.join(H, ".beta", "memory.md"), "utf8").includes("pwned"));

    console.log("\n[5] 保存：先看改动 → 确认 → 备份 + 原子写 + 保留权限");
    fs.chmodSync(memory, 0o640);
    const ino0 = fs.statSync(memory).ino;
    const pv = await req(port, "POST", "/c/alpha/files/preview", { cookie, body: saveBody() });
    check("对比页 200：有加的行、有去掉的行", pv.status === 200 && /class="dl add"[\s\S]*改过的长期记忆/.test(pv.body) && /class="dl del"[\s\S]*喜欢下雨天/.test(pv.body));
    check("对比页还没写", fs.readFileSync(memory, "utf8") === before);
    check("对比页带着确认写入的表单（同一个指纹）", pv.body.includes('action="/c/alpha/files/save"') && baseOf(pv.body) === base0);
    r = await req(port, "POST", "/c/alpha/files/save", { cookie, body: saveBody({ text: "改过的长期记忆\r\n" }) });
    check("确认 → 303", r.status === 303 && /\/c\/alpha\/files\/done\?b=/.test(r.headers.location || ""), String(r.status));
    check("写进去了（浏览器的 \\r\\n 还原成 \\n）", fs.readFileSync(memory, "utf8") === "改过的长期记忆\n");
    const st = fs.statSync(memory);
    check("权限保持 0640", (st.mode & 0o777) === 0o640, (st.mode & 0o777).toString(8));
    check("原子写（换了 inode = 临时文件 rename 过来的）", st.ino !== ino0);
    check("目录里没留临时文件", !fs.readdirSync(path.dirname(memory)).some((n) => n.includes(".panel-")));
    const bdir = path.join(env.PANEL_STATE_DIR, "backups", "alpha");
    const idx = fs.readFileSync(path.join(bdir, "index.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const bk = idx.find((x) => x.path === memory);
    check("写前备份了旧版（内容一字不差、0600）", !!bk && fs.readFileSync(path.join(bdir, bk.file), "utf8") === before
      && (fs.statSync(path.join(bdir, bk.file)).mode & 0o777) === 0o600 && bk.sha256 === base0);
    const done = await req(port, "GET", r.headers.location, { cookie });
    check("结果页：写进去了 + 下次换舱生效 + 现在换舱", done.body.includes("写进去了") && done.body.includes("下次换舱才生效") && done.body.includes("现在换舱"));

    console.log("\n[6] 乐观锁：打开之后他自己改过 → 拒绝，不写");
    const ed2 = await req(port, "GET", "/c/alpha/files/edit?f=" + enc(memory), { cookie });
    const base2 = baseOf(ed2.body);
    fs.writeFileSync(memory, "他自己刚写的一句\n");
    const pv2 = await req(port, "POST", "/c/alpha/files/preview", { cookie, body: form({ csrf, f: memory, base: base2, text: "我的版本\n" }) });
    check("看改动时就发现被改过 → 409，把她那版留着", pv2.status === 409 && pv2.body.includes("被别人（或者他自己）改过") && pv2.body.includes("我的版本"));
    r = await req(port, "POST", "/c/alpha/files/save", { cookie, body: form({ csrf, f: memory, base: base2, text: "我的版本\n" }) });
    check("硬保存也 409", r.status === 409);
    check("他的改动原样在（没被盖掉）", fs.readFileSync(memory, "utf8") === "他自己刚写的一句\n");
    const nBk = fs.readFileSync(path.join(bdir, "index.jsonl"), "utf8").trim().split("\n").length;
    check("冲突时不多存备份", nBk === idx.length);

    console.log("\n[7] 历史版本：查看 + 一键恢复（也走对比 + 锁 + 再备份）");
    const hist = await req(port, "GET", "/c/alpha/files/history?f=" + enc(memory), { cookie });
    check("历史页列出那一份", hist.status === 200 && hist.body.includes("files/backup?b=" + enc(bk.id)));
    const bp = await req(port, "GET", "/c/alpha/files/backup?b=" + enc(bk.id), { cookie });
    check("备份页：全文 + 恢复会怎么变 + 恢复表单", bp.status === 200 && bp.body.includes("喜欢下雨天") && bp.body.includes('action="/c/alpha/files/restore"') && /class="dl del"[\s\S]*他自己刚写的一句/.test(bp.body));
    const curSha = baseOf(bp.body);
    check("恢复表单带的是现在的指纹", curSha === sha(fs.readFileSync(memory)));
    r = await req(port, "POST", "/c/alpha/files/restore", { cookie, body: form({ csrf, f: memory, b: bk.id, base: "1".repeat(64) }) });
    check("指纹不对（期间又被改过）→ 409、不动", r.status === 409 && fs.readFileSync(memory, "utf8") === "他自己刚写的一句\n");
    r = await req(port, "POST", "/c/alpha/files/restore", { cookie, body: form({ csrf, f: memory, b: bk.id, base: curSha }) });
    check("恢复 → 303", r.status === 303, String(r.status));
    check("内容回到那一版", fs.readFileSync(memory, "utf8") === before);
    const idx2 = fs.readFileSync(path.join(bdir, "index.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    check("恢复前把「他自己刚写的一句」也存了一份", idx2.some((x) => x.reason === "restore" && fs.readFileSync(path.join(bdir, x.file), "utf8") === "他自己刚写的一句\n"));
    r = await req(port, "POST", "/c/alpha/files/restore", { cookie, body: form({ csrf, f: path.join(H, ".alpha", "persona.md"), b: bk.id, base: curSha }) });
    check("拿 A 文件的备份去恢复 B 文件 → 403", r.status === 403);

    console.log("\n[8] 他写的东西");
    const wr = await req(port, "GET", "/c/alpha/writings", { cookie });
    check("列出他自己写的备忘", wr.status === 200 && wr.body.includes("备忘.md") && wr.body.includes(enc(path.join(H, ".alpha", "notes", "备忘.md"))));
    check("凭据不列", !wr.body.includes("api.secret") && !wr.body.match(/>\.env</));
    check("桥根（.alpha-gate）整个不列", !wr.body.includes(path.join(H, ".alpha-gate")));
    check("账本类文件名列出来但不给改", /sessions\.json[\s\S]{0,400}桥的运行账本/.test(wr.body));
    check("超大的只列不改", /太大\.md[\s\S]{0,300}太大了/.test(wr.body));
    check("别人的目录不列", !wr.body.includes(path.join(H, ".beta")));
    const memo = path.join(H, ".alpha", "notes", "备忘.md");
    const em = await req(port, "GET", "/c/alpha/files/edit?f=" + enc(memo), { cookie });
    check("备忘能打开编辑", em.status === 200 && em.body.includes("周五买花"));
    r = await req(port, "POST", "/c/alpha/files/save", { cookie, body: form({ csrf, f: memo, base: baseOf(em.body), text: "周六买花\n" }) });
    check("备忘能保存（同一套：303、写进去）", r.status === 303 && fs.readFileSync(memo, "utf8") === "周六买花\n");

    console.log("\n[9] 暖尾巴挑选 + 整舱预演");
    const tp = await req(port, "GET", "/c/alpha/tail", { cookie });
    const keys = [...tp.body.matchAll(/name="keep" value="([^"]+)"/g)].map((m) => m[1]);
    check("逐轮列出 4 轮、默认全勾", tp.status === 200 && keys.length === 4 && (tp.body.match(/name="keep"[^>]* checked/g) || []).length === 4, String(keys.length));
    check("前 60 字 + 可展开全文", tp.body.includes("…") && tp.body.includes("后面这半句应该被折叠起来"));
    const asm0 = await req(port, "GET", "/c/alpha/assembled", { cookie });
    check("整舱预演：系统提示 → 人格 → 底子 → 暖尾巴，按顺序", ["系统提示", "人格", "底子", "暖尾巴", "她的下一句"].map((x) => asm0.body.indexOf(">" + x + "<")).every((v, i, a) => v > 0 && (i === 0 || v > a[i - 1])),
      ["系统提示", "人格", "底子", "暖尾巴"].map((x) => asm0.body.indexOf(">" + x + "<")).join(","));
    check("整舱预演：总字数 + 估算 token", asm0.body.includes("总字数") && asm0.body.includes("估算 token"));
    check("整舱预演里有第 2 轮", asm0.body.includes("晨星第2轮她的假话"));
    const ver = (/name="ver" value="([^"]*)"/.exec(tp.body) || [])[1];
    const keep = keys.filter((k) => !k.includes("-1-"));
    r = await req(port, "POST", "/c/alpha/tail", { cookie, body: form({ csrf, ver: "过期的", shown: keys, keep }) });
    check("名单在打开之后变过 → 409、不写", r.status === 409 && !fs.existsSync(path.join(H, ".alpha-gate", "tail-exclude.json")));
    r = await req(port, "POST", "/c/alpha/tail", { cookie, body: form({ shown: keys, keep, ver }) });
    check("没令牌 → 403", r.status === 403);
    r = await req(port, "POST", "/c/alpha/tail", { cookie, body: form({ csrf, ver, shown: keys, keep }) });
    check("取消勾选第 2 轮 → 303", r.status === 303, String(r.status));
    const exf = path.join(H, ".alpha-gate", "tail-exclude.json");
    const ex = JSON.parse(fs.readFileSync(exf, "utf8"));
    check("排除名单写在桥根（换舱那处读它），按冷层 id，0600", ex.entries.map((e) => e.id).sort().join(",") === "cold-alpha-1-reply-1-assistant,cold-alpha-1-user"
      && (fs.statSync(exf).mode & 0o777) === 0o600, JSON.stringify(ex.entries.map((e) => e.id)));
    const tp2 = await req(port, "GET", "/c/alpha/tail", { cookie });
    check("刷新后第 2 轮不勾了", (tp2.body.match(/name="keep"[^>]* checked/g) || []).length === 3 && tp2.body.includes("这次不带"));
    const asm1 = await req(port, "GET", "/c/alpha/assembled", { cookie });
    check("整舱预演跟着变：第 2 轮没了，第 1、3 轮还在", !asm1.body.includes("晨星第2轮她的假话") && asm1.body.includes("晨星第1轮她的假话") && asm1.body.includes("晨星第3轮的假回答"));
    check("冷层原文没动", fs.readFileSync(path.join(H, ".alpha-gate", "cold.jsonl"), "utf8").includes("晨星第2轮她的假话"));
    const asmB = await req(port, "GET", "/c/beta/assembled", { cookie });
    check("beta（Codex）：也有底子，写明经 thread/inject_items 当第一条垫进去", asmB.status === 200 && asmB.body.includes(">底子<") && asmB.body.includes("thread/inject_items"));
    const ibText = "暮雨的假身份底座：我是暮雨。";
    check("beta：身份底座只出现一份（开发者指令里那份；底子里那段拿掉了）", asmB.body.includes(">身份底座<") && asmB.body.split(ibText).length - 1 === 1 && asmB.body.includes("底子里那一段拿掉了"),
      String(asmB.body.split(ibText).length - 1));
    check("beta：按年目录放的日记也拼进了底子", asmB.body.includes("暮雨昨天的假日记（按年放的）"));
    const bbase = await req(port, "GET", "/c/beta/base", { cookie });
    const yd = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() - 86400_000));
    check("beta 底子页：日记来源指到年份目录那个文件、存在（不写死）", bbase.body.includes(path.join(H, ".beta", "diary", yd.slice(0, 4), yd + ".md"))
      && !new RegExp(yd + "\\.md <span class=\"k\">不存在").test(bbase.body));

    console.log("\n[10] 审计");
    const lines = fs.readFileSync(path.join(env.PANEL_STATE_DIR, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const has = (pred) => lines.some(pred);
    check("审计文件 0600", (fs.statSync(path.join(env.PANEL_STATE_DIR, "audit.jsonl")).mode & 0o777) === 0o600);
    const resIds = lines.filter((x) => x.action === "rotate.result").map((x) => x.detail);
    check("换舱：按下 + 结果都记了，同一个任务的结果只记一行（刷新不重记）", lines.some((x) => x.action === "rotate" && x.role === "alpha" && /\/model claude-opus/.test(x.detail))
      && resIds.length > 0 && new Set(resIds).size === resIds.length, JSON.stringify(resIds));
    check("被拒的选模型也记了", has((x) => x.action === "rotate" && x.result === "refused"));
    check("连不上的换舱也记了", has((x) => x.action === "rotate" && x.role === "beta" && x.result === "error"));
    check("保存：文件 + 前后指纹", has((x) => x.action === "save" && x.file === memory && x.result === "ok" && x.before === base0 && x.after === sha("改过的长期记忆\n")));
    check("冲突也记", has((x) => x.action === "save" && x.result === "conflict"));
    check("恢复记了", has((x) => x.action === "restore" && x.result === "ok"));
    check("挑暖尾巴记了", has((x) => x.action === "tail.exclude" && x.role === "alpha"));
    const tx = require("../../src/box/tail-exclude");
    tx.consumeTailExclude(exf, { usedBy: "forge/claude", threadId: "t-new" });
    const au = await req(port, "GET", "/audit", { cookie });
    check("操作记录页：面板的 + 换舱用掉排除名单的都在", au.status === 200 && au.body.includes("保存") && au.body.includes("换舱用掉排除名单") && au.body.includes("恢复历史版本"));
    check("首页角色卡上有换舱按钮和改文件", (await req(port, "GET", "/", { cookie })).body.includes('href="/c/alpha/rotate"'));
  } finally {
    await ctl.stop();
    server.close();
    fs.rmSync(fx.home, { recursive: true, force: true });
  }
  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
