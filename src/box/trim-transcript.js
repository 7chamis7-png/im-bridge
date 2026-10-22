"use strict";
/**
 * 裁工具链（2026-09-21 从老桥 app.js 搬进新桥 —— 切桥时整套漏了）
 *
 * Alice 8-23 / 9-03 定的判据：1M 档到 30%（300k）撞线，**先裁工具链、别急着换舱**。
 * 裁 = 把他回头不看的工具输出换成占位符（`scripts/trim-tools.js`，Nova亲自定的四条：
 * 占位符不整行删 / thinking 整块删 / 保护最近 10 条真实轮 / 强制备份）。
 * 裁完 resume 同一条 threadId，对话一句不丢。干跑估收益 ≥ 80k 才裁，不够就换舱。
 *
 * 这里只有纯函数（估算 / 落刀），停 CLI、找 threadId 那些在 box-runtime 里。
 * 数 token 的坑（9-03 实测，别重算）：字节口径会骗人，只信脚本算的 token 比例 × 真实水位 × 0.85。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const DEFAULT_SCRIPT = path.join(__dirname, "..", "..", "scripts", "trim-tools.js");
const CALIBRATION = 0.85;   // 9-03 拿 16:57 那次备份验的：干跑估 37.9%、真实 33.9%

/** transcript 在哪：~/.claude/projects/<workspace 的 slug>/<threadId>.jsonl（跟 gate-box-claudecode 同一个算法） */
function transcriptPath(workspaceRoot, threadId, home = os.homedir()) {
  const slug = String(workspaceRoot || "").replace(/[/.]/g, "-");
  return path.join(home, ".claude", "projects", slug, String(threadId) + ".jsonl");
}

/**
 * 干跑估收益。
 * @returns {{ok:true, ratio:number, gain:number}|{ok:false, reason:string}}
 */
function estimateTrimGain({ file, currentTokens = 0, keepRecent = 10, script = DEFAULT_SCRIPT, timeoutMs = 120_000 }) {
  if (!file || !fs.existsSync(file)) return { ok: false, reason: "transcript 不存在：" + file };
  if (!fs.existsSync(script)) return { ok: false, reason: "裁剪脚本不存在：" + script };
  let out;
  try {
    out = execFileSync(process.execPath, [script, file, "--dry-run", "--keep-recent", String(keepRecent)], { encoding: "utf8", timeout: timeoutMs });
  } catch (e) { return { ok: false, reason: "干跑失败：" + ((e && e.message) || e) }; }
  const m = /ratio=([0-9.]+)/.exec(out);
  if (!m) return { ok: false, reason: "干跑没报 ratio" };
  const ratio = Number(m[1]);
  if (!Number.isFinite(ratio) || ratio < 0) return { ok: false, reason: "ratio 不是数：" + m[1] };
  return { ok: true, ratio, gain: Math.round(ratio * (Number(currentTokens) || 0) * CALIBRATION), out: out.trim() };
}

/** 裁完的文件必须还是一条完整的链：每行 parentUuid 都指得到（9-18 断链那次的教训） */
function chainIntact(lines) {
  const ids = new Set();
  for (const l of lines) { try { const o = JSON.parse(l); if (o.uuid) ids.add(o.uuid); } catch { return false; } }
  for (const l of lines) {
    const o = JSON.parse(l);
    if (o.parentUuid && !ids.has(o.parentUuid)) return false;
  }
  return true;
}

/**
 * 真落刀：备份 → 脚本写到 tmp → 校验（非空 / 每行 JSON / 链完整）→ rename 覆盖。
 * 任何一步不过：原文件一字不动，tmp 删掉。
 * ⚠️ 调用方必须先把 CLI 停了（文件正在被追加时改它 = 在人家写字的时候擦纸）。
 */
function applyTrim({ file, keepRecent = 10, script = DEFAULT_SCRIPT, timeoutMs = 120_000, now = new Date() }) {
  if (!file || !fs.existsSync(file)) return { ok: false, reason: "transcript 不存在：" + file };
  if (!fs.existsSync(script)) return { ok: false, reason: "裁剪脚本不存在：" + script };
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
  const backup = `${file}.bak-autotrim-${stamp}`;
  const tmp = `${file}.trimtmp`;
  try {
    const before = fs.statSync(file).size;
    fs.copyFileSync(file, backup);
    const out = execFileSync(process.execPath, [script, file, tmp, "--keep-recent", String(keepRecent)], { encoding: "utf8", timeout: timeoutMs });
    const lines = fs.readFileSync(tmp, "utf8").split("\n").filter((l) => l.trim());
    if (!lines.length) throw new Error("裁剪输出为空");
    if (!chainIntact(lines)) throw new Error("裁完链断了（有 parentUuid 指向不存在的行）");
    fs.renameSync(tmp, file);
    const after = fs.statSync(file).size;
    return { ok: true, before, after, backup, lines: lines.length, out: out.trim() };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 没写出来就没得删 */ }
    return { ok: false, reason: (e && e.message) || String(e), backup };
  }
}

module.exports = { transcriptPath, estimateTrimGain, applyTrim, chainIntact, DEFAULT_SCRIPT, CALIBRATION };
