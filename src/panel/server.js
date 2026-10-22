#!/usr/bin/env node
"use strict";

/**
 * im-bridge 面板。
 *
 *   node src/panel/server.js               起服务（只听 127.0.0.1:$PANEL_PORT，默认 8790）
 *   node src/panel/server.js --issue-link  发一个一次性登录链接 + 登录码（10 分钟内有效，二选一、只能用一次）
 *   node src/panel/server.js --revoke-all  吊销所有会话（所有设备都得重新登录）
 *   node src/panel/server.js --demo        演示：假数据、免登录、只读（不需要真的桥）
 *
 * 环境变量：
 *   PANEL_PORT          端口，默认 8790
 *   PANEL_STATE_DIR     面板自己的状态目录（token / 会话哈希、错误日志基线、备份、审计），默认 ~/.im-bridge-panel
 *   PANEL_CHARACTERS    "alpha:/home/me/.alpha-gate/alpha-env.sh,beta:/home/me/.beta-gate/beta-env.sh"；
 *                       不给就扫 ~/.*-gate/*-env.sh
 *   PANEL_PUBLIC_URL    生成链接用的外部地址（https 开头时 cookie 带 Secure），默认 http://127.0.0.1:<端口>
 *   PANEL_ACCENTS       "alpha:ruby,beta:sapphire"（宝石色：sapphire / ruby / emerald / amber），不给按名单顺序分
 *   PANEL_SESSION_DAYS  会话期限（天），默认 3650；每次访问滑动续期
 *   PANEL_BACKUP_KEEP   改文件前存的旧版，每个文件留最近几份，默认 20
 *
 * 会写什么（2026-10-22 起，原来「除了状态目录不写任何文件」那句不再准确）：
 *   · PANEL_STATE_DIR：登录 / 会话哈希、错误日志基线、改文件前的旧版备份、审计账（audit.jsonl）。
 *   · 她在「改文件」里**确认过**的那一个文件：只限「这一舱装了什么」里、落在该角色自己目录里的，
 *     乐观锁 + 先备份 + 原子写（见 files.js）。别的文件、别人目录、凭据类一律不碰。
 *   · 换舱：不写文件，只往该角色的桥的本机控制口（$GATE_ROOT/control.sock）发一条 /new，
 *     由桥按 TG /new 同一条路去换（见 control.js / src/gate/control-socket.js）。
 * 其余照旧只读：不调任何会改状态的 pm2 命令（只有 jlist），不联网。
 * 改动类请求只收 POST，带跟会话绑定的 CSRF 令牌，并核对来源（Origin / Sec-Fetch-Site）。
 * 数据隔离：每个角色的路径只从它自己的 env 来；拼底子在子进程里做，子进程只带那个角色的 env。
 */

const http = require("http");
const path = require("path");
const { execFile } = require("child_process");
const { loadAll, classifyPath } = require("./characters");
const { collectCharacter, pm2List, DAY_MS } = require("./collect");
const auth = require("./auth");
const render = require("./render");
const i18n = require("./i18n");
const { L } = i18n;
const { readJson } = require("./state");
const files = require("./files");
const { modelChoices, planRotate } = require("./rotate-plan");
const control = require("./control");
const { appendAudit, readAudit } = require("./audit");
const { diffLines, hunks, stats: diffStats } = require("./diff");

const CHILD = path.join(__dirname, "base-child.js");

/** 面板自带的图（设计稿里的立面 / 教堂内部 / 线稿）。固定白名单，不按路径拼文件名。 */
const ASSETS = {
  "duomo-facade.webp": "image/webp",
  "duomo-interior.webp": "image/webp",
  "cathedral.svg": "image/svg+xml",
  // 主屏幕图标（2026-10-22）：圆形花窗。源文件 icon.svg，PNG 由它渲染
  "icon.svg": "image/svg+xml",
  "apple-touch-icon.png": "image/png",
  "icon-192.png": "image/png",
  "icon-512.png": "image/png",
  "favicon-32.png": "image/png",
};
/** 主屏幕清单：名字跟着请求的语言走。 */
const manifest = () => Buffer.from(JSON.stringify({
  name: i18n.L("桥 · 圣所"), short_name: i18n.L("圣所"), start_url: "/", scope: "/", display: "standalone",
  background_color: "#f7f3eb", theme_color: "#f7f3eb", lang: i18n.lang() === "en" ? "en" : "zh-CN",
  icons: [{ src: "/assets/icon-192.png", sizes: "192x192", type: "image/png" }, { src: "/assets/icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "/assets/icon.svg", sizes: "any", type: "image/svg+xml" }],
}));
const assetCache = new Map();
/** 可选主题图：PANEL_HERO_IMAGE（头图，顶替 duomo-facade）、PANEL_NIGHT_IMAGE（夜间背景，顶替 duomo-interior），指本地文件。 */
const THEME_OVERRIDE = { "duomo-facade.webp": "PANEL_HERO_IMAGE", "duomo-interior.webp": "PANEL_NIGHT_IMAGE" };
const IMG_TYPE = { ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".avif": "image/avif" };
function asset(name, env = process.env) {
  if (!Object.prototype.hasOwnProperty.call(ASSETS, name)) return null;
  const k = THEME_OVERRIDE[name];
  const custom = k ? String(env[k] || "").trim() : "";
  const key = custom ? "custom:" + custom : name;
  if (!assetCache.has(key)) {
    let body = null, type = ASSETS[name];
    if (custom) {
      try { body = require("fs").readFileSync(custom); type = IMG_TYPE[path.extname(custom).toLowerCase()] || type; }
      catch { body = null; }           // 读不到就用自带的那张，不让页面破图
    }
    if (!body) body = require("fs").readFileSync(path.join(__dirname, "assets", name));
    assetCache.set(key, { type, body });
  }
  return assetCache.get(key);
}

function gemsFor(chars, env) {
  const out = {};
  const explicit = {};
  for (const item of String(env.PANEL_ACCENTS || "").split(",")) {
    const [id, gem] = item.split(":").map((s) => (s || "").trim());
    if (id && render.GEMS.includes(gem)) explicit[id] = gem;
  }
  chars.forEach((c, i) => { out[c.id] = explicit[c.id] || render.GEMS[i % render.GEMS.length]; });
  return out;
}

/** 子进程拼底子：env 只给这个角色自己那一份。 */
function runBaseChild(ch, { timeoutMs = 30_000, mode = "" } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CHILD, ...(mode ? [mode] : [])], { env: ch.env, cwd: "/", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (err, stdout) => {
        const line = String(stdout || "").trim().split("\n").pop() || "";
        try { return resolve(JSON.parse(line)); } catch { /* 往下 */ }
        resolve({ ok: false, error: err ? String(err.message || err).split("\n")[0] : "子进程没有输出结果" });
      });
  });
}

function others(all, ch) {
  return all.filter((o) => o.id !== ch.id && !o.error).map((o) => ({ id: o.id, roots: o.roots }));
}

async function baseData(ch, all) {
  const base = await runBaseChild(ch);
  const oth = others(all, ch);
  if (base.ok) {
    for (const s of base.sections) {
      for (const src of s.sources) {
        if (src.kind === "module") { src.cross = false; continue; } // 代码模块（笔记本的 store.js）不是数据
        Object.assign(src, classifyPath(src.path, ch.roots, oth));
      }
      s.cross = s.sources.some((x) => x.cross);
    }
    for (const src of base.persona || []) Object.assign(src, classifyPath(src.path, ch.roots, oth));
  }
  const file = path.join(String(ch.env.GATE_ROOT || ""), "state", "injection-loaded.json");
  const data = ch.env.GATE_ROOT ? readJson(file, null) : null;
  const loaded = { ok: !!data, exists: !!data || require("fs").existsSync(file), data };
  if (data) {
    if (data.workspace) loaded.workspace = classifyPath(data.workspace, ch.roots, oth);
    if (data.injection && data.injection.file) {
      loaded.injection = classifyPath(data.injection.file, ch.roots, oth);
      if (base.ok && base.identitySha) loaded.injectionNow = { same: base.identitySha === data.injection.sha256 };
    }
  }
  return { base, loaded };
}

const POST_LIMIT = 8 * 1024 * 1024;

/** 换舱前的线程号（审计里记「换之前是哪一舱」）。读心跳，读不到就空。 */
function threadOf(ch) {
  const root = String(ch.env.GATE_ROOT || "");
  const file = String(ch.env.GATE_HEARTBEAT_FILE || "").trim() || (root ? path.join(root, "heartbeat.json") : "");
  const j = file ? readJson(file, null) : null;
  return String((j && j.fullness && j.fullness.threadId) || "");
}

/** 尾巴候选 → 一轮一组（她那句起头，后面跟着的他的话都算这一轮；开头没有她那句的算一组「接着上一轮」）。 */
function tailTurns(a) {
  const tailExclude = require("../box/tail-exclude");
  const ex = tailExclude.makeExcluder(a.exclude.entries || []);
  const inTail = new Set((a.tail.items || []).map((t) => t.sourceId).filter(Boolean));
  const turns = [];
  let cur = null;
  for (const it of a.tail.candidates || []) {
    if (it.role === "user" || !cur) { cur = { items: [], orphan: it.role !== "user" }; turns.push(cur); }
    cur.items.push(it);
  }
  return turns.map((t, i) => {
    const head = t.items[0];
    const excluded = !!ex && t.items.some((it) => ex({ id: it.sourceId, role: it.role, at: it.timestamp, text: it.rawText }));
    const included = t.items.some((it) => inTail.has(it.sourceId));
    return { key: head.sourceId || "turn-" + i, items: t.items, orphan: t.orphan, at: Date.parse(head.timestamp || "") || 0,
      excluded, dropped: !excluded && !included };
  });
}

/** 换舱的最终结果只记一次（看进展那页会被刷新好几次）。 */
function noteRotateResult(env, ch, job) {
  const seen = readAudit(env, { role: ch.id, limit: 200 }).some((r) => r.action === "rotate.result" && String(r.detail || "").split(" ")[0] === job.id);
  if (!seen) appendAudit(env, { role: ch.id, action: "rotate.result", before: "", after: threadOf(ch), result: job.state, detail: job.id });
}

function send(res, status, html, extra = {}) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "same-origin",   // 2026-10-22：no-referrer 会让浏览器表单 POST 带 Origin: null（来源核不了）；same-origin 对外照样一个字不漏
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; manifest-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...extra,
  });
  res.end(html);
}

function readBody(req, limit = 4096) {
  // 超限：别再收，但让这个请求正常结束（直接 destroy 的话客户端只看到连接被掐，不知道为什么）
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    let over = false;
    req.on("data", (c) => { n += c.length; if (n > limit) { if (!over) { over = true; const e = new Error("too large"); e.tooLarge = true; reject(e); } } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function isSecure(req, env) {
  return /^https:/i.test(String(env.PANEL_PUBLIC_URL || "")) || String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https";
}

function createServer({ env = process.env, now = () => Date.now(), demo = false } = {}) {
  return http.createServer((req, res) => i18n.run({ env, headers: req.headers }, () => handle(req, res)));
  async function handle(req, res) {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const t = now();
      // 图不带任何角色数据，门口（登录页）也要用 —— 不要登录；只认白名单里那三张。
      const am = /^\/assets\/([a-z0-9.-]+)$/.exec(url.pathname);
      if (am && (req.method === "GET" || req.method === "HEAD")) {
        const a = asset(am[1], env);
        if (!a) return send(res, 404, "");
        res.writeHead(200, { "content-type": a.type, "content-length": a.body.length, "cache-control": "private, max-age=86400",
          "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "cross-origin-resource-policy": "same-origin" });
        return res.end(req.method === "HEAD" ? undefined : a.body);
      }
      if (url.pathname === "/manifest.webmanifest" && (req.method === "GET" || req.method === "HEAD")) {
        res.writeHead(200, { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" });
        return res.end(req.method === "HEAD" ? undefined : manifest());
      }
      // ——— 演示模式（--demo）：假数据、免登录、只读。改动类一律拒，登录页直接回首页 ———
      if (demo) {
        if (url.pathname === "/login") return send(res, 303, "", { location: "/" });
        if (req.method === "POST") return send(res, 403, render.refusedPage(L("演示模式"), L("演示模式只能看，不能改（换舱、改文件、挑暖尾巴都要接上真的桥才能用）。")));
      }
      if (url.pathname === "/login") {
        if (req.method === "GET") {
          const tok = url.searchParams.get("t") || "";
          if (!tok) return send(res, 200, render.codeLoginPage());          // 主屏幕 App：没有链接可点，输登录码
          return auth.peekLink(tok, { env, now: t }) ? send(res, 200, render.loginPage(tok)) : send(res, 401, render.linkDeadPage());
        }
        if (req.method === "POST") {
          const body = new URLSearchParams(await readBody(req));
          const cookieFor = (sid) => ({ location: "/", "set-cookie": auth.sessionCookie(sid, { secure: isSecure(req, env), env }) });
          if (body.has("code")) {
            const r = auth.consumeCode(body.get("code"), req, { env, now: t });
            if (r.sid) return send(res, 303, "", cookieFor(r.sid));
            if (r.locked) return send(res, 429, render.codeLoginPage({ error: L("错太多次了，{0} 分钟后再试。", Math.ceil(r.retryInMs / 60000)) }), { "retry-after": String(Math.ceil(r.retryInMs / 1000)) });
            return send(res, 401, render.codeLoginPage({ error: L("这个码不对，或者已经用过 / 过期了。") }));
          }
          const sid = auth.consumeLink(body.get("t") || "", { env, now: t });
          if (!sid) return send(res, 401, render.linkDeadPage());
          return send(res, 303, "", cookieFor(sid));
        }
        return send(res, 405, "");
      }
      const sid = demo ? "demo" : auth.sessionId(req, { env, now: t });
      if (!sid) return send(res, 401, render.unauthorizedPage());
      // 滑动续期：服务端 expiresAt 已在 sessionId 里顺延，这里把 cookie 的 Max-Age 也同步刷新
      if (!demo) res.setHeader("set-cookie", auth.sessionCookie(sid, { secure: isSecure(req, env), env }));
      const csrf = auth.csrfToken(sid);
      const isGet = req.method === "GET" || req.method === "HEAD";
      if (!isGet && req.method !== "POST") return send(res, 405, "", { allow: "GET, HEAD, POST" });

      // ——— 改动类请求：只收 POST + 表单 + 来源对 + CSRF 令牌对 ———
      let form = null;
      if (req.method === "POST") {
        if (!/^application\/x-www-form-urlencoded\b/i.test(String(req.headers["content-type"] || ""))) {
          return send(res, 415, render.refusedPage(L("没有动"), L("请求的格式不对。")));
        }
        try { form = new URLSearchParams(await readBody(req, POST_LIMIT)); }
        catch (e) { return send(res, e.tooLarge ? 413 : 400, render.refusedPage(L("没有动"), e.tooLarge ? L("内容太大了。") : L("请求没收完整。"))); }
        if (!auth.sameOrigin(req, { env })) return send(res, 403, render.refusedPage(L("没有动"), L("这个请求不是从面板自己的页面发出来的，拒绝。")));
        if (!auth.checkCsrf(sid, form.get("csrf"))) return send(res, 403, render.refusedPage(L("没有动"), L("页面上的令牌对不上（可能页面放太久了，或者不是从面板发的）。刷新页面再试。")));
      }

      const all = loadAll(env);
      const gems = gemsFor(all, env);
      const nav = all.map((c) => ({ id: c.id, displayName: c.displayName }));
      const names = Object.fromEntries(all.map((c) => [c.id, c.displayName || c.id]));
      if (url.pathname === "/" && isGet) {
        const pm2 = pm2List(env);
        const cards = all.map((ch) => {
          try { return collectCharacter(ch, { pm2, env, now: t }); }
          catch (e) { return { id: ch.id, displayName: ch.displayName, error: L("读这个角色时出错：{0}", String(e.message || e).split("\n")[0]) }; }
        });
        return send(res, 200, render.homePage(cards, { now: t, gems }));
      }
      if (url.pathname === "/audit" && isGet) {
        // 面板自己的账 + 每位桥根里「换舱用掉了排除名单」那本（gate 那头写的，见 src/box/tail-exclude.js）
        const tailExclude = require("../box/tail-exclude");
        const used = all.filter((c) => !c.error && c.env.GATE_ROOT).flatMap((c) => tailExclude.readUsedLog(tailExclude.tailExcludeFile(c.env.GATE_ROOT), 50)
          .map((u) => ({ at: u.at, role: c.id, action: "tail.used", file: "", before: L("{0} 条", u.count), after: L("{0} 条", 0), result: "ok",   // 只给页面看，不落盘
            detail: u.threadId ? L("换舱用掉了排除名单（{0}，新舱 {1}），已清空", u.usedBy || "?", String(u.threadId).slice(0, 8))
              : L("换舱用掉了排除名单（{0}），已清空", u.usedBy || "?") })));
        const rows = [...readAudit(env, { limit: 100 }), ...used].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 100);
        return send(res, 200, render.auditPage({ now: t, nav, rows, names }));
      }
      const m = /^\/c\/([^/]+)\/(base|failures|assembled|tail|writings|rotate|rotate\/job|files|files\/edit|files\/preview|files\/save|files\/done|files\/history|files\/backup|files\/restore)\/?$/.exec(url.pathname);
      const ch = m && all.find((c) => c.id === decodeURIComponent(m[1]));
      if (!ch) return send(res, 404, render.notFoundPage());
      const route = m[2];
      const POST_ONLY = new Set(["files/preview", "files/save", "files/restore"]);
      const BOTH = new Set(["rotate", "files/edit", "tail"]);
      if (req.method === "POST" && !POST_ONLY.has(route) && !BOTH.has(route)) return send(res, 405, "", { allow: "GET, HEAD" });
      if (isGet && POST_ONLY.has(route)) return send(res, 405, "", { allow: "POST" });
      const po = { gem: gems[ch.id], now: t, nav, csrf };

      if (route === "base") {
        if (ch.error) return send(res, 200, render.basePage(ch, null, null, { gem: gems[ch.id], now: t, nav }));
        const { base, loaded } = await baseData(ch, all);
        return send(res, 200, render.basePage(ch, base, loaded, { gem: gems[ch.id], now: t, nav }));
      }
      if (route === "failures") {
        const hours = Math.min(168, Math.max(1, Number(url.searchParams.get("h")) || 24));
        let c;
        try { c = collectCharacter(ch, { pm2: pm2List(env), env, now: t, sinceMs: t - hours * 60 * 60 * 1000 }); }
        catch (e) { c = { id: ch.id, error: L("读这个角色时出错：{0}", String(e.message || e).split("\n")[0]) }; }
        return send(res, 200, render.failuresPage(ch, c, { gem: gems[ch.id], now: t, hours, nav }));
      }
      if (ch.error) return send(res, 200, render.refusedPage(L("这位的配置读不出来"), ch.error));

      // ——— 换舱 ———
      if (route === "rotate" && isGet) {
        let card = null;
        try { card = collectCharacter(ch, { pm2: { ok: true, procs: [] }, env, now: t, recordMarks: false }); } catch { card = null; }
        const choices = modelChoices(ch, { requested: card && card.engine ? card.engine.requested : "" });
        return send(res, 200, render.rotateConfirmPage(ch, { ...po, card, choices }));
      }
      if (route === "rotate") {
        const before = threadOf(ch);
        let card = null;
        try { card = collectCharacter(ch, { pm2: { ok: true, procs: [] }, env, now: t, recordMarks: false }); } catch { card = null; }
        const choices = modelChoices(ch, { requested: card && card.engine ? card.engine.requested : "" });
        const plan = planRotate(choices, String(form.get("model") || ""));
        if (!plan.ok) {
          appendAudit(env, { role: ch.id, action: "rotate", before, result: "refused", detail: plan.whyZh || plan.why });
          return send(res, 400, render.rotateResultPage(ch, { ...po, error: plan.why }));
        }
        const r = await control.sendCommands(ch, plan.texts, { waitMs: 3000 });
        const what = plan.texts.map((x) => x.split(" ")[0] + (x.startsWith("/new") ? "" : " " + x.split(" ")[1])).join(" → ");
        if (!r || !r.ok || !r.job) {
          appendAudit(env, { role: ch.id, action: "rotate", before, result: "error", detail: `${what}：${String((r && (r.errorZh || r.error)) || "桥没回")}` });
          return send(res, 502, render.rotateResultPage(ch, { ...po, error: (r && r.error) || L("桥没回") }));
        }
        appendAudit(env, { role: ch.id, action: "rotate", before, result: r.job.state, detail: `${r.job.id} ${what}` });
        if (r.job.state === "done" || r.job.state === "failed") noteRotateResult(env, ch, r.job);
        // 按完跳到「看进展」那一页：刷新页面不会再按一次
        return send(res, 303, "", { location: `/c/${encodeURIComponent(ch.id)}/rotate/job?j=${encodeURIComponent(r.job.id)}` });
      }
      if (route === "rotate/job") {
        const r = await control.jobStatus(ch, String(url.searchParams.get("j") || ""));
        if (!r || !r.ok || !r.job) return send(res, 200, render.rotateResultPage(ch, { ...po, error: (r && r.error) || L("桥没回") }));
        if (r.job.state === "done" || r.job.state === "failed") noteRotateResult(env, ch, r.job);
        return send(res, 200, render.rotateResultPage(ch, { ...po, job: r.job }));
      }

      const oth = others(all, ch);

      // ——— 整舱拼好的全文 / 暖尾巴勾选（同一个子进程算：forge.selectTail + 底子 + 人格，跟换舱同一套代码）———
      if (route === "assembled" && isGet) {
        const a = await runBaseChild(ch, { mode: "assemble", timeoutMs: 60_000 });
        return send(res, 200, render.assembledPage(ch, { ...po, a }));
      }
      if (route === "tail" && isGet) {
        const a = await runBaseChild(ch, { mode: "assemble", timeoutMs: 60_000 });
        return send(res, 200, render.tailPage(ch, { ...po, a, turns: a.ok ? tailTurns(a) : [], saved: url.searchParams.get("saved") || "" }));
      }
      if (route === "tail") {
        const a = await runBaseChild(ch, { mode: "assemble", timeoutMs: 60_000 });
        if (!a.ok) return send(res, 500, render.refusedPage(L("没有动"), L("算不出尾巴：{0}", a.error || "?")));
        if (String(form.get("ver") || "") !== String(a.exclude.updatedAt || "")) {
          return send(res, 409, render.refusedPage(L("没有动"), L("排除名单在你打开之后变了（可能刚换过舱、名单被用掉了）。重新打开再勾。")));
        }
        const turns = tailTurns(a);
        const keep = new Set(form.getAll("keep"));
        const shown = new Set(form.getAll("shown"));
        const tailExclude = require("../box/tail-exclude");
        const candIds = new Set(turns.flatMap((t) => t.items.map((i) => i.sourceId)).filter(Boolean));
        // 这次页面上没出现的旧条目原样留着；页面上出现过的按勾选重算
        const kept = (a.exclude.entries || []).filter((e) => !candIds.has(e.id));
        const add = [];
        for (const t of turns) {
          if (!shown.has(t.key) || keep.has(t.key)) continue;
          for (const it of t.items) add.push({ id: it.sourceId, role: it.role, at: it.timestamp || "", sha: tailExclude.shaOf(it.rawText) });
        }
        const next = [...kept, ...add];
        const file = a.exclude.file;
        const beforeN = (a.exclude.entries || []).length;
        try { tailExclude.writeTailExclude(file, next, { by: "panel" }); }
        catch (e) { return send(res, 500, render.refusedPage(L("没写进去"), String(e.message || e))); }
        appendAudit(env, { role: ch.id, action: "tail.exclude", file, before: `${beforeN} 条`, after: `${next.length} 条`, result: "ok",
          detail: `排掉 ${turns.filter((t) => shown.has(t.key) && !keep.has(t.key)).length} 轮（只对下一次换舱）` });
        return send(res, 303, "", { location: `/c/${encodeURIComponent(ch.id)}/tail?saved=1` });
      }

      // ——— 他写的东西 ———
      if (route === "writings") {
        const w = files.listWritings(ch, { others: oth });
        return send(res, 200, render.writingsPage(ch, { ...po, w }));
      }

      // ——— 改文件 ———
      const { base } = await baseData(ch, all);
      const listed = files.listFiles(base);
      const editable = (p) => {
        if (listed.some((r) => r.path === p)) return files.resolveEditable(ch, oth, p, listed);
        // 不在「这一舱装了什么」里：看是不是「他写的东西」（同一套规矩逐段判，再走同一个 resolveEditable）
        const w = typeof p === "string" && path.isAbsolute(p) && path.resolve(p) === p ? files.writingRow(ch, p) : null;
        return files.resolveEditable(ch, oth, p, w ? [w] : listed);
      };
      const refuse = (why) => send(res, 403, render.refusedPage(L("这个文件不能改"), why));
      const mono = !!(form ? form.get("mono") : url.searchParams.get("mono"));

      if (route === "files") {
        return send(res, 200, render.filesPage(ch, { ...po, list: listed, base, audit: readAudit(env, { role: ch.id, limit: 10 }) }));
      }
      if (route === "files/history") {
        const f = String(url.searchParams.get("f") || "");
        return send(res, 200, render.historyPage(ch, { ...po, file: f, rows: files.listBackups(env, ch.id, f) }));
      }
      if (route === "files/backup") {
        const b = files.readBackup(env, ch.id, url.searchParams.get("b"));
        if (!b) return send(res, 404, render.notFoundPage());
        const tg = editable(b.path);
        if (!tg.ok) return send(res, 200, render.backupPage(ch, { ...po, backup: b, why: tg.why }));
        const cur = files.readTarget(tg);
        if (!cur.ok) return send(res, 200, render.backupPage(ch, { ...po, backup: b, why: cur.why }));
        const lines = diffLines(cur.text, b.text);
        return send(res, 200, render.backupPage(ch, { ...po, backup: b, currentSha: cur.sha, lines: hunks(lines), stat: diffStats(lines) }));
      }
      if (route === "files/done") {
        const b = files.readBackup(env, ch.id, url.searchParams.get("b"));
        if (!b) return send(res, 404, render.notFoundPage());
        let after = "";
        try { after = files.sha(require("fs").readFileSync(b.path)); } catch { after = ""; }
        return send(res, 200, render.writeResultPage(ch, { ...po, file: b.path, mode: b.reason, result: { ok: true, before: b.sha256, after, backup: b } }));
      }

      const f = String((form ? form.get("f") : url.searchParams.get("f")) || "");
      const tg = editable(f);
      if (!tg.ok) return refuse(tg.why);
      const cur = files.readTarget(tg);
      if (!cur.ok) return refuse(cur.why);

      if (route === "files/edit" && isGet) {
        return send(res, 200, render.editPage(ch, { ...po, file: f, text: cur.text, sha: cur.sha, mono }));
      }
      if (route === "files/edit") {        // 从对比页「回去接着改」：带着她那一版回来，锁还是打开时那个
        const text = files.normalizeSubmitted(form.get("text"), cur);
        return send(res, 200, render.editPage(ch, { ...po, file: f, text, sha: String(form.get("base") || ""), mono, draft: true }));
      }
      const baseSha = String(form.get("base") || "");
      if (route === "files/preview") {
        const text = files.normalizeSubmitted(form.get("text"), cur);
        if (cur.sha !== baseSha) {
          return send(res, 409, render.writeResultPage(ch, { ...po, file: f, text, result: { ok: false, conflict: true,
            why: L("你打开之后，这个文件被别人（或者他自己）改过了。没有写入 —— 重新打开看最新的再改。") } }));
        }
        const lines = diffLines(cur.text, text);
        const st = diffStats(lines);
        if (!st.add && !st.del && text === cur.text) {
          return send(res, 200, render.editPage(ch, { ...po, file: f, text, sha: baseSha, mono, note: render.esc(L("跟现在的文件一模一样，没有改动可写。")) }));
        }
        return send(res, 200, render.diffPage(ch, { ...po, file: f, sha: baseSha, text, lines: hunks(lines), stat: st, mono }));
      }
      if (route === "files/save") {
        const text = files.normalizeSubmitted(form.get("text"), cur);
        const r = files.writeTarget(env, ch.id, tg, { text, baseSha, reason: "save" });
        appendAudit(env, { role: ch.id, action: "save", file: f, before: r.ok ? r.before : (r.current || cur.sha), after: r.ok ? r.after : "",
          result: r.ok ? "ok" : r.conflict ? "conflict" : r.unchanged ? "unchanged" : "refused", ...(r.ok ? { detail: "备份 " + r.backup.id } : { detail: r.whyZh || r.why }) });
        if (r.ok) return send(res, 303, "", { location: `/c/${encodeURIComponent(ch.id)}/files/done?b=${encodeURIComponent(r.backup.id)}` });
        return send(res, r.conflict ? 409 : 400, render.writeResultPage(ch, { ...po, file: f, text, result: r }));
      }
      if (route === "files/restore") {
        const b = files.readBackup(env, ch.id, form.get("b"));
        if (!b || b.path !== f) return refuse(L("找不到这个历史版本，或者它不是这个文件的。"));
        const r = files.writeTarget(env, ch.id, tg, { buf: b.buf, baseSha, reason: "restore" });
        appendAudit(env, { role: ch.id, action: "restore", file: f, before: r.ok ? r.before : (r.current || cur.sha), after: r.ok ? r.after : "",
          result: r.ok ? "ok" : r.conflict ? "conflict" : r.unchanged ? "unchanged" : "refused", detail: (r.ok ? "恢复到 " : "想恢复到 ") + b.id });
        if (r.ok) return send(res, 303, "", { location: `/c/${encodeURIComponent(ch.id)}/files/done?b=${encodeURIComponent(r.backup.id)}` });
        return send(res, r.conflict ? 409 : 400, render.writeResultPage(ch, { ...po, file: f, mode: "restore", result: r }));
      }
      return send(res, 404, render.notFoundPage());
    } catch (e) {
      try { send(res, 500, "<!doctype html><meta charset=utf-8><p>" + render.esc(L("面板出错了：{0}", String(e.message || e))) + "</p>"); } catch { /* 已经发了一半 */ }
    }
  }
}

function port(env) { return Number(env.PANEL_PORT) || 8790; }

function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes("--issue-link")) {
    const { token, code, expiresAt } = auth.issueLink({ env });
    const base = String(env.PANEL_PUBLIC_URL || "").trim().replace(/\/+$/, "") || `http://127.0.0.1:${port(env)}`;
    process.stdout.write(`${base}/login?t=${token}\n`);
    process.stdout.write(`登录码：${code}\n`);
    process.stderr.write(`（链接和登录码二选一，一次性，用掉一个另一个也作废；${render.fmtTime(expiresAt)} 北京时间前有效）\n`);
    return;
  }
  if (argv.includes("--revoke-all")) {
    const n = auth.revokeAll({ env });
    process.stdout.write(`清掉了 ${n} 个会话，所有已登录的设备都要重新登录。\n`);
    return;
  }
  if (argv.includes("--demo")) {
    // 假数据造在临时目录里（src/panel/demo-data.js，测试用的同一套），退出时删掉。不读这台机器上的任何角色。
    const { makeFixture } = require("./demo-data");
    const fx = makeFixture();
    const demoEnv = { ...fx.env, PANEL_PORT: env.PANEL_PORT || "", PANEL_LANG: env.PANEL_LANG || "", PANEL_TZ: env.PANEL_TZ || "" };
    const server = createServer({ env: demoEnv, demo: true });
    const bye = () => { try { require("fs").rmSync(fx.home, { recursive: true, force: true }); } catch { /* */ } process.exit(0); };
    process.on("SIGINT", bye); process.on("SIGTERM", bye);
    server.listen(port(env), "127.0.0.1", () => {
      process.stderr.write(`演示面板在 http://127.0.0.1:${port(env)} （假数据、免登录、只读；Ctrl+C 退出）\n`);
    });
    return server;
  }
  const server = createServer({ env });
  server.listen(port(env), "127.0.0.1", () => {
    process.stderr.write(`面板在 http://127.0.0.1:${port(env)} （登录链接：node src/panel/server.js --issue-link）\n`);
  });
  return server;
}

if (require.main === module) main();

module.exports = { createServer, main, runBaseChild, gemsFor, DAY_MS };
