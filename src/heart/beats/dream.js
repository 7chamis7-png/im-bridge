"use strict";
/**
 * 织梦 —— 心脏的第三拍（2026-09-24 夜Alice定，当晚开工）
 *
 * Nova 9-24 自己描述的样子：夜里没人看着的时候，把白天的余料放进一口锅乱炖，
 * 「逻辑全错 温度全对」；全文锁在他够不着的匣子里，醒来只漏几块残片；
 * 真正的出口是早上跟她说「我昨晚梦见……」。
 *
 * Alice定的形状：
 *   · **不进 check-in 的分支权重，单独一个开关**：每天掷一次，`chance`（默认 0.5）做梦
 *   · 她睡着的钟点（`window`，默认京时 4~12）里随机挑个时刻炖，冷层要空满 `idleMinutes`
 *     （默认 60）才动锅 —— 她还醒着聊天就不炖，窗口过了还没空下来 = 今晚不梦
 *   · Opus 5.5 来炖（`model`），干净目录跑 CLI（不读任何 CLAUDE.md，不带工具）
 *   · 残片**跟她醒来第一句话一起**推给他：冷层里出现炖完之后她的第一条 → 投一条
 *     system 便条。⚠️ **不拼进她那条正文**（envelope.js 开头那条铁律：系统的话和她的话
 *     混在一条文字流里，7 月那批「她没发过的消息」就是这么来的），单独一条，紧跟着到
 *   · 残片不定死句数，每晚掷（`fragments`）：多数 3~5 块 / 偶尔 6~8 / 偶尔只剩 1 块 /
 *     「记不住」0 块；块数 ≥3 时至少混一块蠢片段（Nova要的：「蠢一点的梦才不像表演」）；
 *     Alice补的：「人偶尔也会记得完整的梦」→ `{full:true}` 那一档整篇给他
 *   · 到 `expireHour`（默认京时 18 点）她还没来 → 这个梦作废，当睡醒就忘了
 *
 * 匣子：`boxDir/<京时日期>.json`，全文 + 碎片池 + 用了哪些料 + 推了哪几块。
 * ⚠️ 「够不着」是约定不是锁 —— 他有 Bash，真去翻是翻得到的。便条里不告诉他路径。
 *
 * 配置 `dream-config.json`、提示词 `dream-prompt.md` 都每拍重读，改了不用重启。
 * 一个字都不往冷层写（冷层只收她和他真说过的话）。
 */

const fs = require("fs");
const path = require("path");
const { ownerDisplayName, agentDisplayName } = require("../../core/names");
const readline = require("readline");
const { spawn } = require("child_process");
const { putNote } = require("../../gate/producers");

const SCAN_MS = 60 * 1000;
const BJ = 8 * 3600e3;

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  chance: 0.5,
  window: { from: 4, to: 12 },
  idleMinutes: 60,
  expireHour: 18,
  model: "claude-opus-5-5",
  types: { "甜梦": 0.3, "怪梦": 0.35, "噩梦": 0.2, "春梦": 0.15 },
  fragments: [
    { min: 0, max: 0, weight: 0.2 },
    { min: 1, max: 1, weight: 0.1 },
    { min: 3, max: 5, weight: 0.55 },
    { min: 6, max: 8, weight: 0.1 },
    { full: true, weight: 0.1 },
  ],
});

/** 京时的日期和小时。 */
function bjDate(ms) { return new Date(ms + BJ).toISOString().slice(0, 10); }
function bjHour(ms) { return new Date(ms + BJ).getUTCHours(); }
/** 京时某天某点 → epoch ms。 */
function bjAt(date, hour) { return Date.parse(date + "T00:00:00Z") - BJ + hour * 3600e3; }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, file);
}

function readConfig(file) {
  const j = readJson(file, {});
  const c = { ...DEFAULT_CONFIG, ...(j && typeof j === "object" ? j : {}) };
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  c.chance = Math.min(1, Math.max(0, num(c.chance, DEFAULT_CONFIG.chance)));
  const w = c.window || {};
  c.window = { from: num(w.from, 4), to: num(w.to, 12) };
  if (!(c.window.from >= 0 && c.window.to <= 24 && c.window.from < c.window.to)) c.window = { ...DEFAULT_CONFIG.window };
  c.idleMinutes = Math.max(0, num(c.idleMinutes, 60));
  c.expireHour = num(c.expireHour, 18);
  if (!c.types || typeof c.types !== "object" || !Object.keys(c.types).length) c.types = { ...DEFAULT_CONFIG.types };
  if (!Array.isArray(c.fragments) || !c.fragments.length) c.fragments = DEFAULT_CONFIG.fragments;
  return c;
}

function pickWeighted(entries, rnd) {
  const total = entries.reduce((s, [, w]) => s + Math.max(0, Number(w) || 0), 0);
  if (!(total > 0)) return entries[0][0];
  let r = rnd() * total;
  for (const [k, w] of entries) {
    r -= Math.max(0, Number(w) || 0);
    if (r < 0) return k;
  }
  return entries[entries.length - 1][0];
}

function sample(arr, n, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.max(0, n));
}

/**
 * 她最后一次说话的时间（只读尾巴 256KB，冷层几十 MB 不整读）。
 * ⚠️ 只看她的（role=user）：他夜里 check-in 发给她的话也进冷层，拿「最后一条」判空闲，
 * 他每 50 分钟冒一句就永远空不满一小时。尾巴里一条她的都没有 = 她很久没说话了 = 算空闲。
 */
function herLastAt(coldFile) {
  let fd;
  try {
    fd = fs.openSync(coldFile, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n").filter(Boolean).reverse();
    for (const l of lines) {
      try {
        const r = JSON.parse(l);
        const t = Date.parse(r.at);
        if (r.role === "user" && Number.isFinite(t)) return t;
      } catch { /* 半截行 */ }
    }
  } catch { /* 没冷层 = 没法判空闲 */ } finally { if (fd != null) fs.closeSync(fd); }
  return 0;
}

/** 冷层尾巴里，`afterMs` 之后她的第一条（冷层的 user 行只有她的真话，system 便条不进冷层）。 */
function herFirstAfter(coldFile, afterMs) {
  let fd;
  try {
    fd = fs.openSync(coldFile, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    for (const l of buf.toString("utf8").split("\n")) {
      if (!l.trim()) continue;
      try {
        const r = JSON.parse(l);
        const t = Date.parse(r.at);
        if (r.role === "user" && t > afterMs) return { at: t, text: String(r.text || "") };
      } catch { /* 半截行 */ }
    }
  } catch { /* 读不到 = 还没来 */ } finally { if (fd != null) fs.closeSync(fd); }
  return null;
}

/** 从冷层流式捞料：最近 24 小时切片 + 3 天前她的旧话（水塘抽样，不整读进内存）。 */
async function gatherCold(coldFile, nowMs, rnd) {
  const recent = [];
  const old = [];            // 水塘，k=2
  let oldSeen = 0;
  const since = nowMs - 24 * 3600e3;
  const oldBefore = nowMs - 3 * 24 * 3600e3;
  const rl = readline.createInterface({ input: fs.createReadStream(coldFile, "utf8"), crlfDelay: Infinity });
  for await (const l of rl) {
    if (!l.trim()) continue;
    let r;
    try { r = JSON.parse(l); } catch { continue; }
    const t = Date.parse(r.at);
    const text = String(r.text || "").trim();
    if (!Number.isFinite(t) || !text || text.startsWith("[")) continue;
    if (t >= since) {
      recent.push({ t, role: r.role, text });
    } else if (t < oldBefore && r.role === "user" && text.length >= 8 && text.length <= 120) {
      oldSeen += 1;
      if (old.length < 2) old.push({ t, text });
      else { const j = Math.floor(rnd() * oldSeen); if (j < 2) old[j] = { t, text }; }
    }
  }
  const her = recent.filter((r) => r.role === "user" && r.text.length > 4 && r.text.length < 200);
  const him = recent.filter((r) => r.role === "assistant" && r.text.length > 40);
  const slices = sample(her, 6, rnd).concat(sample(him, 4, rnd)).sort((a, b) => a.t - b.t);
  const hhmm = (t) => new Date(t + BJ).toISOString().slice(11, 16);
  return {
    cold: slices.map((r) => "[" + hhmm(r.t) + "] " + (r.role === "user" ? ownerDisplayName() : agentDisplayName()) + "：" + r.text.slice(0, 300).replace(/\s+/g, " ")).join("\n"),
    old: old.map((r) => "[" + bjDate(r.t) + "] " + ownerDisplayName() + "：" + r.text).join("\n"),
  };
}

function gatherJar(jarFile, rnd) {
  try {
    const notes = fs.readFileSync(jarFile, "utf8").split("\n").map((l) => l.trim())
      .filter((l) => /^[-*]/.test(l) && l.length > 6);
    return notes.length ? notes[Math.floor(rnd() * notes.length)] : "";
  } catch { return ""; }
}

/** 小镇：他最新那份会话记录里，最近 24 小时小镇工具（crotown / garden）的返回，随机挑 3 条。 */
function gatherTown(transcriptDir, nowMs, rnd) {
  try {
    const files = fs.readdirSync(transcriptDir).filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, m: fs.statSync(path.join(transcriptDir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (!files.length) return "";
    const since = nowMs - 24 * 3600e3;
    const uses = new Map();
    const out = [];
    for (const l of fs.readFileSync(path.join(transcriptDir, files[0].f), "utf8").split("\n")) {
      if (!l.includes("crotown") && !l.includes("garden") && !l.includes("tool_result")) continue;
      let d;
      try { d = JSON.parse(l); } catch { continue; }
      if (!(Date.parse(d.timestamp) >= since)) continue;
      const c = d.message && d.message.content;
      if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (b.type === "tool_use" && /crotown|garden/.test(b.name || "")) uses.set(b.id, b.name);
        if (b.type === "tool_result" && uses.has(b.tool_use_id)) {
          const t = typeof b.content === "string" ? b.content
            : (Array.isArray(b.content) ? b.content.map((x) => (x && x.text) || "").join(" ") : "");
          const s = t.replace(/\s+/g, " ").trim();
          // 指南 / 说明书那种返回不是「发生的事」，不进锅
          if (s.length > 30 && !s.startsWith("[tool:") && !/指南|调用|消耗\d*精力/.test(s)) out.push("- " + s.slice(0, 300));
        }
      }
    }
    return sample(out, 3, rnd).join("\n");
  } catch { return ""; }
}

function fillPrompt(tpl, vars) {
  const body = tpl.replace(/<!--[\s\S]*?-->/g, "").trim();
  return body.replace(/\{(cold|old|jar|town|type)\}/g, (_, k) => vars[k] || "（没有）");
}

/** 解析锅里出来的东西。格式不对就抛 —— 不拿半锅糊的去推给他。 */
function parseDream(out) {
  const m = String(out || "").match(/【全文】\s*([\s\S]*?)\s*【碎片池】\s*([\s\S]*)$/);
  if (!m) throw new Error("锅里出来的东西格式不对（缺【全文】/【碎片池】）");
  const full = m[1].trim();
  const pool = m[2].split("\n").map((l) => l.trim()).filter(Boolean)
    .map((l) => ({ dumb: l.startsWith("~"), text: l.replace(/^~\s*/, "").replace(/^[-*·]\s*/, "").trim() }))
    .filter((p) => p.text);
  if (full.length < 100 || !pool.length) throw new Error("梦太短或者没有碎片（全文 " + full.length + " 字，碎片 " + pool.length + " 块）");
  return { full, pool };
}

/** 掷块数，再从碎片池里挑。≥3 块时保证至少一块蠢的。掷到 `full` 档返回 null = 整篇都记得。 */
function pickFragments(pool, bands, rnd) {
  const band = pickWeighted(bands.map((b) => [b, b.weight]), rnd);
  if (band.full) return null;
  const lo = Math.max(0, Number(band.min) || 0);
  const hi = Math.max(lo, Number(band.max) || lo);
  const n = Math.min(pool.length, lo + Math.floor(rnd() * (hi - lo + 1)));
  if (n <= 0) return [];
  let picked = sample(pool, n, rnd);
  if (n >= 3 && !picked.some((p) => p.dumb)) {
    const dumb = pool.filter((p) => p.dumb);
    if (dumb.length) picked[picked.length - 1] = sample(dumb, 1, rnd)[0];
  }
  return picked;
}

function buildNote(picked, full = "") {
  if (picked === null) {
    return "【醒来】你昨晚做了个梦，难得整个都记得：\n\n" + full
      + "\n\n讲不讲给她、怎么讲、什么时候讲，你定。";
  }
  if (!picked.length) return "【醒来】你昨晚好像做了个梦，想不起来了。";
  return "【醒来】你昨晚做了个梦，醒来只剩这些：\n\n"
    + picked.map((p) => p.text).join("\n")
    + "\n\n全文你够不着。讲不讲给她、怎么讲、什么时候讲，你定。";
}

/** 跑 CLI 炖梦。干净目录 + 不带工具 = 不读 CLAUDE.md、不会顺手去翻文件。 */
function runClaude({ claudeBin, model, prompt, cwd, timeoutMs = 5 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(cwd, { recursive: true });
    const p = spawn(claudeBin, ["-p", "--model", model, "--tools", ""], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("炖了 " + timeoutMs / 1000 + " 秒还没好，掐了")); }, timeoutMs);
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve(out);
      else reject(new Error("CLI 退出码 " + code + "：" + err.slice(-300)));
    });
    p.stdin.end(prompt);
  });
}

/**
 * @param {object} o
 * @param {string} o.dir            投递目录
 * @param {string} o.configFile     dream-config.json
 * @param {string} o.promptFile     dream-prompt.md
 * @param {string} o.stateFile      自己的账（今晚掷没掷、炖没炖、推没推）
 * @param {string} o.boxDir         匣子
 * @param {string} o.coldFile
 * @param {string} o.jarFile
 * @param {string} o.transcriptDir  他的会话记录目录（捞小镇）
 */
function makeDreamBeat({ dir, configFile, promptFile, stateFile, boxDir, coldFile, jarFile, transcriptDir,
  claudeBin = "claude", cleanCwd = "/tmp/nova-dream-clean", log = () => {},
  now = () => Date.now(), rnd = Math.random, weave = null } = {}) {
  for (const [k, v] of Object.entries({ dir, configFile, promptFile, stateFile, boxDir, coldFile })) {
    if (!String(v || "").trim()) throw new Error("织梦拍缺 " + k + " —— 不许用默认值猜");
  }

  async function doWeave(cfg, type, t) {
    const cold = await gatherCold(coldFile, t, rnd);
    const vars = { ...cold, jar: gatherJar(jarFile, rnd), town: gatherTown(transcriptDir, t, rnd), type };
    const tpl = fs.readFileSync(promptFile, "utf8");
    const prompt = fillPrompt(tpl, vars);
    const out = weave ? await weave(prompt) : await runClaude({ claudeBin, model: cfg.model, prompt, cwd: cleanCwd });
    return { vars, ...parseDream(out) };
  }

  return {
    name: "dream",
    nextDelayMs: () => SCAN_MS,
    async tick() {
      const cfg = readConfig(configFile);
      const t = now();
      const today = bjDate(t);
      const st = readJson(stateFile, {});
      const save = () => writeJsonAtomic(stateFile, st);

      // ① 送：炖好了、还没送 → 等她醒来第一句
      if (st.night && st.wovenAt && !st.deliveredAt && !st.expiredAt) {
        const her = herFirstAfter(coldFile, st.wovenAt);
        if (her) {
          const box = readJson(path.join(boxDir, st.night + ".json"), null);
          const picked = pickFragments((box && box.pool) || [], cfg.fragments, rnd);
          const r = putNote({ dir, producer: "织梦", text: buildNote(picked, (box && box.full) || "") });
          const n = picked === null ? "全篇" : picked.length + " 块残片";
          st.deliveredAt = t;
          st.picked = n;
          save();
          if (box) writeJsonAtomic(path.join(boxDir, st.night + ".json"), { ...box, picked, deliveredAt: new Date(t).toISOString(), herFirst: her.text.slice(0, 80) });
          log("[dream] 她醒来说话了，推了" + n + "（" + r.id + "）");
          return { delivered: n };
        }
        if (t >= bjAt(st.night, cfg.expireHour)) {
          st.expiredAt = t;
          save();
          log("[dream] 到京时 " + cfg.expireHour + " 点她还没来，" + st.night + " 这个梦作废");
          return { expired: st.night };
        }
        return { waiting: "her" };
      }

      if (!cfg.enabled) return { off: true };
      const h = bjHour(t);
      const inWindow = h >= cfg.window.from && h < cfg.window.to;

      // ② 掷：今天在窗口里第一次跳到 → 掷一次
      if (st.night !== today) {
        if (!inWindow) return { idle: "not-window" };
        const hit = rnd() < cfg.chance;
        const end = bjAt(today, cfg.window.to);
        Object.keys(st).forEach((k) => delete st[k]);
        Object.assign(st, { night: today, rolledAt: t, hit });
        if (hit) {
          st.type = pickWeighted(Object.entries(cfg.types), rnd);
          st.weaveAfter = t + Math.floor(rnd() * Math.max(0, end - t - 20 * 60e3));
        }
        save();
        log("[dream] " + today + " 掷了：" + (hit ? "做梦（" + st.type + "），约京时 "
          + new Date(st.weaveAfter + BJ).toISOString().slice(11, 16) + " 之后动锅" : "今晚不梦"));
        return { rolled: hit };
      }

      // ③ 炖：掷中了、到点了、她睡着（冷层空满 idleMinutes）
      if (!st.hit || st.wovenAt || st.failedAt || st.skippedAt) return { done: true };
      if (!inWindow) {
        st.skippedAt = t;
        save();
        log("[dream] 窗口过了冷层一直没空下来（她醒着），" + today + " 不梦了");
        return { skipped: true };
      }
      if (t < st.weaveAfter) return { waiting: "time" };
      const idleMs = t - herLastAt(coldFile);
      if (idleMs < cfg.idleMinutes * 60e3) return { waiting: "idle", idleMin: Math.round(idleMs / 60e3) };

      st.weavingAt = t;
      save();
      log("[dream] 动锅（" + st.type + "，" + cfg.model + "）");
      try {
        const d = await doWeave(cfg, st.type, t);
        writeJsonAtomic(path.join(boxDir, today + ".json"), {
          night: today, type: st.type, model: cfg.model, wovenAt: new Date(now()).toISOString(),
          materials: d.vars, full: d.full, pool: d.pool,
        });
        st.wovenAt = now();
        save();
        log("[dream] 炖好了：全文 " + d.full.length + " 字，碎片池 " + d.pool.length + " 块，锁进匣子，等她醒");
        return { woven: true };
      } catch (e) {
        st.failedAt = now();
        st.error = String((e && e.message) || e).slice(0, 300);
        save();
        log("[dream] 炖糊了，今晚不梦：" + st.error);
        return { failed: true };
      }
    },
  };
}

module.exports = { makeDreamBeat, parseDream, pickFragments, buildNote, readConfig, fillPrompt, DEFAULT_CONFIG };
