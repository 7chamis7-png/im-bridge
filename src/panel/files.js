"use strict";

/**
 * 面板改文件（2026-10-22）。
 *
 * ## 能改哪些
 * 只能改「这一舱装了什么」里列出来的、**落在这个角色自己目录里**的文件（classifyPath：own 且没有 foreign），
 * 加上人格文件（人格配置指的那份 + 工作目录里的 CLAUDE.md / AGENTS.md），同一把尺子判。
 * 一律不能改：标红的（别人目录 / 不在本角色目录）、.env / *.secret / *-env.sh / 凭据类、
 * 软链接指出角色目录的（**realpath 之后再判一遍**）、不是普通文件的、太大的、二进制的。
 * 路径从来不信请求：请求只给一个路径字符串，必须**原样**在当场重算出来的可改清单里。
 *
 * ## 怎么写
 *   ① 乐观锁：编辑页带着打开时的 sha256，写之前比对；不一样 = 有人（往往是他自己）改过 → 拒绝，不写。
 *   ② 先备份旧版到 PANEL_STATE_DIR/backups/<角色>/<日期>/，同一个文件只留最近 N 份（PANEL_BACKUP_KEEP，默认 20）。
 *   ③ 原子写：同目录临时文件（原权限、原属主）→ fsync → rename 前再比一次锁 → rename。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { classifyPath } = require("./characters");
const { stateDir, ensureDir } = require("./state");
const { L, zh } = require("./i18n");
/** 不让写 / 不让改的理由：why 给页面看（跟着语言走），whyZh 进审计账（永远中文）。 */
const no = (s, ...args) => ({ ok: false, why: L(s, ...args), whyZh: zh(s, ...args) });

const MAX_BYTES = 2 * 1024 * 1024;
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** 凭据类：文件名或路径里任何一段像这些的，一律不给改（也不给看全文）。 */
const SECRET_PATTERNS = [
  /^\.env(\..*)?$/i, /\.env$/i, /-env\.sh$/i, /\.secrets?$/i, /^\.secrets?$/i,
  /secret/i, /credential/i, /passw(or)?d/i, /token/i, /api[-_]?key/i,
  /\.(pem|key|p12|pfx|crt|keystore|jks)$/i, /^auth\.json$/i, /^\.?netrc$/i, /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^\.ssh$/i, /^\.gnupg$/i,
];
function secretWhy(p) {
  const segs = String(p || "").split(path.sep).filter(Boolean);
  const hit = segs.find((s) => SECRET_PATTERNS.some((re) => re.test(s)));
  return hit ? L("「{0}」像是凭据类文件，不给改", hit) : "";
}

function realRoots(roots) {
  const out = [];
  for (const r of roots || []) {
    try { out.push({ ...r, dir: fs.realpathSync(r.dir) }); } catch { /* 目录不在就不算 */ }
  }
  return out;
}

/**
 * 从底子数据（父进程已经 classifyPath 过的）列出所有来源文件，标上能不能改、为什么不能。
 * @returns {{path, section, own, foreign, editable, why}[]}
 */
function listFiles(base) {
  const out = [];
  const seen = new Map();
  const push = (src, section) => {
    if (!src || src.kind === "module" || src.kind === "dir") return;
    const p = String(src.path || "");
    if (!p || seen.has(p)) { if (seen.has(p) && !seen.get(p).sections.includes(section)) seen.get(p).sections.push(section); return; }
    let why = "";
    if (src.foreign && src.foreign.length) why = L("在 {0} 的目录里（标红），不能改", src.foreign.join(" / "));
    else if (!src.own) why = L("不在本角色目录下（标红），不能改");
    else if (secretWhy(p)) why = secretWhy(p);
    else if (src.exists === false) why = L("文件不存在");
    const row = { path: p, section, sections: [section], own: !!src.own, foreign: src.foreign || [], editable: !why, why };
    seen.set(p, row);
    out.push(row);
  };
  if (base && base.ok) {
    for (const s of base.sections || []) for (const src of s.sources || []) push(src, s.name);
    for (const src of base.persona || []) push(src, "人格 · " + (src.role || "人格文件"));
  }
  return out;
}

/**
 * 判一个请求来的路径能不能改，能就给出 realpath 和 stat。
 * @param {object} ch      角色（roots）
 * @param {{id, roots}[]} others
 * @param {string} p       请求里的路径
 * @param {object[]} listed  listFiles 的结果（当场重算的）
 */
function resolveEditable(ch, others, p, listed) {
  const want = String(p || "");
  if (!want || !path.isAbsolute(want) || want.includes("\0")) return no("路径不对");
  if (path.resolve(want) !== want) return no("路径里不许有 .. 或多余的斜杠");
  const row = listed.find((r) => r.path === want);
  if (!row) return no("这个文件不在「这一舱装了什么」的清单里，不能改");
  if (!row.editable) return { ok: false, why: row.why };
  if (secretWhy(want)) return { ok: false, why: secretWhy(want) };
  let real;
  try { real = fs.realpathSync(want); } catch (e) { return no("读不到：{0}", e.code || e.message); }
  if (secretWhy(real)) return { ok: false, why: L("软链接指向 {0}", secretWhy(real)) };
  // 软链接逃逸：realpath 之后用同一把尺子再判 —— 两边的目录也都 realpath 过
  const mine = realRoots(ch.roots);
  const theirs = (others || []).map((o) => ({ id: o.id, roots: realRoots(o.roots) }));
  const c = classifyPath(real, mine, theirs);
  if (!c.own) return no("实际指向 {0}，不在本角色目录下（软链接逃出去了），不能改", real);
  if (c.foreign.length) return no("实际指向 {0} 的目录，不能改", c.foreign.join(" / "));
  let st;
  try { st = fs.statSync(real); } catch (e) { return no("读不到：{0}", e.code || e.message); }
  if (!st.isFile()) return no("不是普通文件");
  if (st.size > MAX_BYTES) return no("文件太大（{0} 字节，上限 {1}），面板不改", st.size, MAX_BYTES);
  return { ok: true, path: want, real, st, row };
}

function readTarget(t) {
  const buf = fs.readFileSync(t.real);
  if (buf.includes(0)) return no("看起来是二进制文件，面板不改");
  return { ok: true, text: buf.toString("utf8"), sha: sha(buf), bytes: buf.length, crlf: buf.includes("\r\n") };
}

/** 文本框交上来的：浏览器把换行统一成 \r\n。原文件不是 \r\n 的就还原成 \n。 */
function normalizeSubmitted(text, { crlf = false } = {}) {
  const s = String(text || "");
  return crlf ? s : s.replace(/\r\n/g, "\n");
}

// ——— 「他写的东西」（2026-10-22）：他自己目录里的文字文件 ———
//
// 范围：characters.js ownRoots 给的本角色目录，**桥根（GATE_ROOT）整棵不走**（那是桥的运行账本，不是他写的）。
// 只列文字文件（扩展名白名单）；凭据类不列；桥的账本类文件名（下面 LEDGER）列出来但不给改；
// 跳过依赖 / 浏览器配置 / 媒体收发件箱这类目录（SKIP_DIRS），隐藏目录除了 .claude 一律不进。
const TEXT_EXT = new Set([".md", ".markdown", ".txt", ".json", ".jsonl", ".yaml", ".yml", ".csv", ".org", ".rst"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", ".venv", "venv", "dist", "build", ".cache", ".playwright-mcp",
  "browser-profile", "wechat-profile", "inbox", "outbox", "blobs", "opaque", "history", "sessions", "projects"]);
const LEDGER = [
  /^turns\.json$/, /^events\.jsonl$/, /^outbox\.json$/, /^cold\.jsonl$/, /^conversation-sources.*\.jsonl$/, /^cursor-.*\.json$/,
  /^dead-.*\.jsonl$/, /^handled-dead-letters\.jsonl$/, /^undelivered\.jsonl$/, /^sessions\.json$/, /^heartbeat\.json$/,
  /^box-journal\.jsonl/, /^turn-bindings\.json$/, /^im-bridge-ingress\.json$/, /^injection-loaded\.json$/,
  /^forge-(state|prepared)\.json$/, /^tail-exclude/, /^last-active-route\.json$/, /^model-fallback-alert\.json$/,
  /^engine-switches\.jsonl$/, /^codex-(thread|rotations)\.jsonl?$/, /^deepseek-thread\.json$/, /^groups\.json$/,
  /^mcp-.*\.json$/, /^system-message-queue\.json$/, /^producers-cron-state\.json$/, /^redactions\.jsonl$/,
  /^body-state-history\.jsonl$/, /^state\.json$/, /^handoff\.json$/,
];
const MAX_DEPTH = 6;
const MAX_LIST = 4000;

function ledgerWhy(name) { return LEDGER.some((re) => re.test(name)) ? L("桥的运行账本，不给改（改了会把桥搞坏或改掉真实记录）") : ""; }
const isTextName = (name) => TEXT_EXT.has(path.extname(name).toLowerCase());
const skipDir = (name) => SKIP_DIRS.has(name) || (name.startsWith(".") && name !== ".claude");

/** 「他写的东西」的根：本角色目录去掉桥根，嵌套的只留最外层。 */
function writingRoots(ch) {
  const gateRoot = path.resolve(String((ch.env && ch.env.GATE_ROOT) || "/nonexistent-gate-root"));
  const dirs = (ch.roots || []).map((r) => r.dir).filter((d) => d !== gateRoot && !isUnderDir(d, gateRoot));
  return dirs.filter((d) => !dirs.some((o) => o !== d && isUnderDir(d, o))).sort();
}
function isUnderDir(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 判一个路径在不在「他写的东西」里、能不能改（不走目录树，按同一套规矩逐段判）。 */
function writingRow(ch, p, st = null) {
  const roots = writingRoots(ch);
  const root = roots.find((r) => isUnderDir(p, r));
  if (!root || p === root) return null;
  const segs = path.relative(root, p).split(path.sep);
  if (segs.length > MAX_DEPTH + 1) return null;
  if (segs.slice(0, -1).some(skipDir)) return null;
  const name = segs[segs.length - 1];
  if (!isTextName(name) || secretWhy(p)) return null;
  let s = st;
  if (!s) { try { s = fs.lstatSync(p); } catch { return null; } }
  if (!s.isFile() && !s.isSymbolicLink()) return null;
  let why = ledgerWhy(name);
  if (!why && s.isFile() && s.size > MAX_BYTES) why = L("太大了（{0} 字节），只列不改", s.size);
  return { path: p, root, dir: path.dirname(p), name, size: s.size, mtimeMs: s.mtimeMs, symlink: s.isSymbolicLink(),
    section: "他写的东西", sections: ["他写的东西"], own: true, foreign: [], editable: !why, why };
}

/** 走一遍他的目录，列出文字文件（新改的在前）。二进制要打开才看得出来，这里不读内容。 */
function listWritings(ch, { others = [] } = {}) {
  const out = [];
  let truncated = false;
  for (const root of writingRoots(ch)) {
    const walk = (dir, depth) => {
      if (out.length >= MAX_LIST) { truncated = true; return; }
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (depth < MAX_DEPTH && !skipDir(e.name) && !secretWhy(e.name)) walk(p, depth + 1); continue; }
        if (!e.isFile() && !e.isSymbolicLink()) continue;
        if (!isTextName(e.name)) continue;
        let st; try { st = fs.lstatSync(p); } catch { continue; }
        const row = writingRow(ch, p, st);
        if (!row) continue;
        // 落进别的角色目录的（目录配错时会有）：列出来、标红、不给改
        const c = classifyPath(p, ch.roots, others);
        if (c.foreign.length) { row.editable = false; row.why = L("在 {0} 的目录里，不能改", c.foreign.join(" / ")); row.foreign = c.foreign; }
        out.push(row);
        if (out.length >= MAX_LIST) { truncated = true; return; }
      }
    };
    walk(root, 0);
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { rows: out, truncated, roots: writingRoots(ch) };
}

// ——— 备份 ———
function backupRoot(env, role) { return path.join(stateDir(env), "backups", role); }
function indexFile(env, role) { return path.join(backupRoot(env, role), "index.jsonl"); }
function keepN(env) { return Math.max(1, Number(env.PANEL_BACKUP_KEEP) || 20); }

function readIndex(env, role) {
  let text = "";
  try { text = fs.readFileSync(indexFile(env, role), "utf8"); } catch { return []; }
  return text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function writeIndex(env, role, rows) {
  const f = indexFile(env, role);
  const tmp = f + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

function bjDay(ms) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/** 把旧版存一份。返回备份记录。 */
function makeBackup(env, role, { path: p, buf, reason, now = Date.now() }) {
  const day = bjDay(now);
  const dir = path.join(backupRoot(env, role), day);
  ensureDir(stateDir(env)); ensureDir(path.join(stateDir(env), "backups")); ensureDir(backupRoot(env, role)); ensureDir(dir);
  const id = new Date(now).toISOString().replace(/[-:.TZ]/g, "").slice(0, 17) + "-" + crypto.randomBytes(3).toString("hex");
  const file = path.join(day, id + "-" + path.basename(p).replace(/[^\w.-]/g, "_") + ".bak");
  const abs = path.join(backupRoot(env, role), file);
  fs.writeFileSync(abs, buf, { mode: 0o600, flag: "wx" });
  const row = { id, at: new Date(now).toISOString(), path: p, sha256: sha(buf), bytes: buf.length, file, reason };
  const rows = readIndex(env, role);
  rows.push(row);
  // 同一个文件只留最近 N 份
  const n = keepN(env);
  const mineRows = rows.filter((r) => r.path === p);
  const drop = new Set(mineRows.slice(0, Math.max(0, mineRows.length - n)).map((r) => r.id));
  for (const r of rows) if (drop.has(r.id)) { try { fs.unlinkSync(path.join(backupRoot(env, role), r.file)); } catch { /* 已经没了 */ } }
  writeIndex(env, role, rows.filter((r) => !drop.has(r.id)));
  return row;
}

/** 某个角色的备份（新的在前）；给了 p 就只看那个文件的。 */
function listBackups(env, role, p = "") {
  return readIndex(env, role).filter((r) => !p || r.path === p).reverse();
}

function readBackup(env, role, id) {
  const row = readIndex(env, role).find((r) => r.id === String(id || ""));
  if (!row) return null;
  const abs = path.join(backupRoot(env, role), row.file);
  if (!abs.startsWith(backupRoot(env, role) + path.sep)) return null;
  try { const buf = fs.readFileSync(abs); return { ...row, buf, text: buf.toString("utf8") }; } catch { return null; }
}

/**
 * 写入（保存 / 恢复共用）。
 * @returns {{ok:true, before, after, backup} | {ok:false, conflict?:boolean, unchanged?:boolean, why}}
 */
function writeTarget(env, role, t, { text, buf = null, baseSha, reason, now = Date.now() }) {
  if (!/^[0-9a-f]{64}$/.test(String(baseSha || ""))) return no("缺打开时的版本指纹，重新打开再改");
  const cur = fs.readFileSync(t.real);
  const curSha = sha(cur);
  if (curSha !== baseSha) return { ...no("你打开之后，这个文件被别人（或者他自己）改过了。没有写入 —— 重新打开看最新的再改。"), conflict: true, current: curSha };
  const next = buf ? Buffer.from(buf) : Buffer.from(String(text), "utf8");
  if (next.includes(0)) return no("内容里有空字符，不写");
  if (next.length > MAX_BYTES) return no("内容太大，不写");
  const after = sha(next);
  if (after === curSha) return { ...no("内容跟现在的一样，没有改动"), unchanged: true };
  const backup = makeBackup(env, role, { path: t.path, buf: cur, reason, now });

  const dir = path.dirname(t.real);
  const tmp = path.join(dir, "." + path.basename(t.real) + ".panel-" + process.pid + "-" + crypto.randomBytes(4).toString("hex"));
  const st = fs.statSync(t.real);
  const mode = st.mode & 0o7777;
  let fd;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    fs.writeSync(fd, next);
    try { fs.fchownSync(fd, st.uid, st.gid); } catch (e) { if (e.code !== "EPERM" || (process.getuid && process.getuid() === 0)) throw e; }
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    // rename 前最后再比一次：这几毫秒里他要是刚写过，宁可不写
    const again = sha(fs.readFileSync(t.real));
    if (again !== baseSha) {
      fs.unlinkSync(tmp);
      return { ...no("就在写入的那一刻，这个文件被改了。没有写入 —— 重新打开再改。"), conflict: true, current: again, backup };
    }
    fs.renameSync(tmp, t.real);
  } catch (e) {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* */ } }
    try { fs.unlinkSync(tmp); } catch { /* */ }
    throw e;
  }
  try { const dfd = fs.openSync(dir, "r"); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } } catch { /* 有的文件系统不让 fsync 目录 */ }
  return { ok: true, before: curSha, after, backup };
}

module.exports = { listWritings, writingRow, writingRoots, ledgerWhy, listFiles, resolveEditable, readTarget, normalizeSubmitted, writeTarget, makeBackup, listBackups, readBackup,
  secretWhy, sha, MAX_BYTES };
