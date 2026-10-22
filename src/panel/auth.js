"use strict";

/**
 * 面板登录：一次性链接 / 登录码（10 分钟，二选一、用掉一个另一个也作废）→ 会话 cookie。
 * token、登录码、会话 id 都只存 sha256 哈希；明文只出现在链接 / 终端输出 / cookie 里。
 *
 * 链接点开先是一页「进门」按钮（GET 不消耗 token），点按钮 POST 才消耗。
 * 这样 Telegram 之类的链接预览抓一下也不会把一次性链接用掉。
 *
 * 2026-10-22：
 *   · 「永久登录」：会话期限 PANEL_SESSION_DAYS（默认 3650 天），**滑动续期** —— 每次登录状态下的请求
 *     都把服务端 expiresAt 顺延、重新下发 cookie（Max-Age 同步）。老的 7 天会话第一次访问就续成新期限。
 *     吊销：node src/panel/server.js --revoke-all（清空所有会话）。
 *   · 登录码：iPhone 主屏幕 App 的 cookie 跟 Safari 隔开、全屏没有地址栏，点不了 TG 里的链接 ——
 *     --issue-link 同时打一个 8 位码（去掉 0/O/1/I/L 这类易混字），登录页输入即可。
 *     同一来源 IP 连错 5 次锁 15 分钟；全站 10 分钟内错 30 次也锁 15 分钟（防换 IP 硬猜）。
 */

const crypto = require("crypto");
const path = require("path");
const { stateDir, ensureDir, readJson, writeJson } = require("./state");

const LINK_TTL_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const COOKIE = "panel_sid";
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // 没有 0 O 1 I L
const CODE_LEN = 8;
const FAIL_LIMIT = 5;
const LOCK_MS = 15 * 60 * 1000;
const GLOBAL_WINDOW_MS = 10 * 60 * 1000;
const GLOBAL_LIMIT = 30;

/** 会话期限（毫秒）。PANEL_SESSION_DAYS，默认 3650 天。 */
function sessionTtlMs(env = process.env) {
  const d = Number(env.PANEL_SESSION_DAYS);
  return (d > 0 ? d : 3650) * DAY_MS;
}
const SESSION_TTL_MS = sessionTtlMs({});

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const token = () => crypto.randomBytes(32).toString("base64url");
function makeCode() {
  let out = "";
  for (let i = 0; i < CODE_LEN; i++) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
}
/** 她敲进来的码：大小写、空格、横杠都不算。 */
function normalizeCode(c) {
  return String(c || "").toUpperCase().replace(/[\s\-_]/g, "");
}
const prettyCode = (c) => c.slice(0, 4) + "-" + c.slice(4);

function files(env) {
  const dir = ensureDir(stateDir(env));
  return { links: path.join(dir, "login-links.json"), sessions: path.join(dir, "sessions.json"), throttle: path.join(dir, "login-throttle.json") };
}

function prune(map, now) {
  for (const [k, v] of Object.entries(map)) if (!v || !(v.expiresAt > now)) delete map[k];
  return map;
}

function openSession(env, now) {
  const f = files(env);
  const sid = token();
  const sessions = prune(readJson(f.sessions, {}), now);
  sessions[sha(sid)] = { createdAt: now, expiresAt: now + sessionTtlMs(env) };
  writeJson(f.sessions, sessions);
  return sid;
}

/** 发一个一次性登录 token + 登录码（同一条记录）。返回明文（只此一次），磁盘上只留哈希。 */
function issueLink({ env = process.env, now = Date.now() } = {}) {
  const f = files(env);
  const links = prune(readJson(f.links, {}), now);
  const t = token();
  const code = makeCode();
  links[sha(t)] = { createdAt: now, expiresAt: now + LINK_TTL_MS, code: sha(normalizeCode(code)) };
  writeJson(f.links, links);
  return { token: t, code: prettyCode(code), expiresAt: now + LINK_TTL_MS };
}

/** 只看不用（GET 进门页）。 */
function peekLink(t, { env = process.env, now = Date.now() } = {}) {
  if (!t) return false;
  const links = readJson(files(env).links, {});
  const row = links[sha(t)];
  return !!(row && row.expiresAt > now);
}

/** 用掉一次性 token：有效就删掉（连同它的登录码）并开一个会话，返回会话 id 明文；否则 null。 */
function consumeLink(t, { env = process.env, now = Date.now() } = {}) {
  if (!t) return null;
  const f = files(env);
  const links = readJson(f.links, {});
  const h = sha(t);
  const row = links[h];
  delete links[h];
  writeJson(f.links, prune(links, now));
  if (!row || !(row.expiresAt > now)) return null;
  return openSession(env, now);
}

/** 限速表的键：来源 IP 的哈希（面板只听 127.0.0.1，外面进来都经 Cloudflare，它会填 CF-Connecting-IP）。 */
function clientKey(req) {
  const h = req.headers || {};
  const ip = String(h["cf-connecting-ip"] || String(h["x-forwarded-for"] || "").split(",")[0] || (req.socket && req.socket.remoteAddress) || "?").trim();
  return sha("ip:" + ip).slice(0, 32);
}

/**
 * 用登录码登录。
 * @returns {{sid?:string, locked?:boolean, retryInMs?:number}}
 */
function consumeCode(code, req, { env = process.env, now = Date.now() } = {}) {
  const f = files(env);
  const th = readJson(f.throttle, {});
  const key = clientKey(req);
  const me = th[key] || { fails: 0, lockedUntil: 0 };
  const g = th._global || { windowStart: now, fails: 0, lockedUntil: 0 };
  if (me.lockedUntil > now) return { locked: true, retryInMs: me.lockedUntil - now };
  if (g.lockedUntil > now) return { locked: true, retryInMs: g.lockedUntil - now };
  const want = normalizeCode(code);
  const links = readJson(f.links, {});
  let hit = null;
  if (want.length === CODE_LEN) {
    const h = sha(want);
    for (const [k, row] of Object.entries(links)) {
      if (row && row.code && row.code.length === h.length && crypto.timingSafeEqual(Buffer.from(row.code), Buffer.from(h))) { hit = k; break; }
    }
  }
  if (hit && links[hit].expiresAt > now) {
    delete links[hit];                      // 码跟链接是同一条记录：用掉一个，另一个也作废
    writeJson(f.links, prune(links, now));
    delete th[key];
    writeJson(f.throttle, th);
    return { sid: openSession(env, now) };
  }
  me.fails += 1;
  if (me.fails >= FAIL_LIMIT) { me.lockedUntil = now + LOCK_MS; me.fails = 0; }
  if (now - g.windowStart > GLOBAL_WINDOW_MS) { g.windowStart = now; g.fails = 0; }
  g.fails += 1;
  if (g.fails >= GLOBAL_LIMIT) { g.lockedUntil = now + LOCK_MS; g.fails = 0; g.windowStart = now; }
  th[key] = me; th._global = g;
  for (const [k, v] of Object.entries(th)) if (k !== "_global" && !v.fails && !(v.lockedUntil > now)) delete th[k];
  writeJson(f.throttle, th);
  return me.lockedUntil > now ? { locked: true, retryInMs: me.lockedUntil - now } : {};
}

/** 吊销全部会话（--revoke-all）。返回清掉了几个。 */
function revokeAll({ env = process.env } = {}) {
  const f = files(env);
  const n = Object.keys(readJson(f.sessions, {})).length;
  writeJson(f.sessions, {});
  return n;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** 这个请求带的 cookie 是不是一个有效会话。 */
function checkSession(req, { env = process.env, now = Date.now() } = {}) {
  return !!sessionId(req, { env, now, renew: false });
}

/** 这个请求的会话 id 明文（有效才给，否则 ""）。 */
function sessionId(req, { env = process.env, now = Date.now(), renew = true } = {}) {
  const sid = parseCookies(req.headers.cookie)[COOKIE];
  if (!sid) return "";
  const f = files(env);
  const sessions = readJson(f.sessions, {});
  const row = sessions[sha(sid)];
  if (!(row && row.expiresAt > now)) return "";
  // 滑动续期：顺延到 now + 期限。一分钟内重复的请求不重写文件（同一页的几个请求不必各写一次）
  const next = now + sessionTtlMs(env);
  if (renew && next - row.expiresAt > 60_000) {
    row.expiresAt = next;
    row.renewedAt = now;
    writeJson(f.sessions, prune(sessions, now));
  }
  return sid;
}

/**
 * 改动类请求的 CSRF 令牌（2026-10-22，面板上了公网之后）。跟会话绑死：由会话 id 推出来（HMAC），
 * 换个会话就对不上；磁盘上只有会话 id 的哈希，推不出它。页面里的每个改动表单都带一个隐藏字段 csrf。
 */
function csrfToken(sid) {
  if (!sid) return "";
  return crypto.createHmac("sha256", String(sid)).update("im-bridge-panel csrf v1").digest("base64url");
}

function checkCsrf(sid, given) {
  const want = csrfToken(sid);
  const got = String(given || "");
  if (!want || !got || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got));
}

/**
 * 请求来源：浏览器带了 Origin / Sec-Fetch-Site 就核一下（多一道闸，CSRF 令牌才是主闸）。
 * 认：PANEL_PUBLIC_URL 的源、或者请求自己的 Host。没带这两个头的（老浏览器 / curl）只靠令牌。
 */
function sameOrigin(req, { env = process.env } = {}) {
  const site = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = String(req.headers.origin || "");
  // 没带 Origin，或者是 "null"（隐私模式 / 某些跳转后浏览器会这么填）：核不了来源，交给 Sec-Fetch-Site + CSRF 令牌
  if (!origin || origin === "null") return true;
  const ok = new Set();
  try { if (env.PANEL_PUBLIC_URL) ok.add(new URL(env.PANEL_PUBLIC_URL).origin); } catch { /* 配错了就只认 Host */ }
  const host = String(req.headers.host || "");
  if (host) { ok.add("http://" + host); ok.add("https://" + host); }
  return ok.has(origin);
}

function sessionCookie(sid, { secure, env = process.env }) {
  return [`${COOKIE}=${sid}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${Math.floor(sessionTtlMs(env) / 1000)}`,
    ...(secure ? ["Secure"] : [])].join("; ");
}

module.exports = { consumeCode, revokeAll, normalizeCode, clientKey, sessionTtlMs, issueLink, peekLink, consumeLink, checkSession, sessionId, csrfToken, checkCsrf, sameOrigin, sessionCookie, parseCookies, LINK_TTL_MS, SESSION_TTL_MS, COOKIE };
