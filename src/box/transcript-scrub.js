"use strict";
/**
 * 从他自己的 CLI transcript 里擦掉续写幻觉的尾巴（2026-10-21）
 *
 * 10-20 夜的事：他正文尾巴上编了一条 `user<channel source="phone" …>老公…`，出闸只把冷层那份切了
 * （outbound.js #writeCold），**transcript 里还留着** —— 下一轮他回头看历史，看见一条长得跟她一模一样的
 * 「入站」，照着又编，一晚上升级了三次。当晚是手工删的（keeper-worklog 2026-10-21 05:03）。
 * Alice定：检测到了，他下一轮之前就得跑在干净的历史上。这里是「怎么擦」，什么时候擦在 adapters/box-runtime.js。
 *
 * 规矩（跟手工那次一样）：
 *   · 判据只用 src/core/hallucination-cut.js 那一份，不另写
 *   · text 块：从命中点切到块尾，**命中点之前他说的话一个字不动**；切完空了就整块/整行拿掉
 *   · thinking 块带签名改不了字。**只认盒子当正文递出去过的那种（旁白壳，cuts 里对得上）**：
 *     换成一个 text 块装命中点之前的话（她收到的本来就是这段正文）；切完空了就整块拿掉。
 *     cuts 对不上的 thinking 是他自己的思考，不碰 —— 别把私下想的翻成说出口的
 *   · 拿掉整行要把指向它的 parentUuid / leafUuid / logicalParentUuid / sourceToolAssistantUUID
 *     接到它的父亲上（9-18 删行没接链，resume 只装回 87 条）
 *   · 之后的 tool_result 里**原样复述**的假文字（他 grep 账本时会把 preview 读回来）一起擦，
 *     只擦跟假文字逐字相同的那一截（含 JSON 转义一层/两层的写法），别的不碰
 *   · **绝不往里写任何「你刚才幻觉了」的说明** —— 那等于再喂他一个模板
 *   · 没改动的行原样保留（不重新序列化）
 *
 * ⚠️ 调用方必须先把 CLI 停了（跟 applyTrim 一样：人家在写字的时候别擦纸）。
 */
const fs = require("fs");
const path = require("path");
const { cutHallucinatedTail } = require("../core/hallucination-cut");

/** 指向别的行的字段。拿掉一行，这些字段指着它的都要改指它的父亲。 */
const LINK_FIELDS = ["parentUuid", "logicalParentUuid", "leafUuid", "sourceToolAssistantUUID"];
/** 复述匹配：假文字至少这么长才去 tool_result 里找（太短会误伤）；找的时候先对这么长的开头。 */
const ECHO_MIN = 32;
const ECHO_HEAD = 48;

function parseLines(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    try { out.push(JSON.parse(lines[i])); }
    catch { throw new Error(`第 ${i + 1} 行不是 JSON，不敢动`); }
  }
  return out;
}

/** 她真说的那一轮的开头（不是工具结果、不是子代理）。 */
function isRealPrompt(o) {
  if (!o || o.type !== "user" || o.isSidechain || o.isMeta || o.isCompactSummary) return false;
  const c = o.message && o.message.content;
  if (typeof c === "string") return true;
  return Array.isArray(c) && c.some((b) => b && b.type !== "tool_result");
}

/** 最后一轮从哪行开始（找不到就从头）。 */
function lastTurnStart(objs) {
  for (let i = objs.length - 1; i >= 0; i -= 1) if (isRealPrompt(objs[i])) return i;
  return 0;
}

/** 指出去的 parentUuid 有哪些落空的（坏链）。 */
function danglingRefs(objs) {
  const ids = new Set(objs.map((o) => o.uuid).filter(Boolean));
  const bad = new Set();
  for (const o of objs) if (o.parentUuid && !ids.has(o.parentUuid)) bad.add(o.parentUuid);
  return bad;
}

function blockText(b) {
  if (!b || typeof b !== "object") return "";
  if (b.type === "text") return typeof b.text === "string" ? b.text : "";
  if (b.type === "thinking") return typeof b.thinking === "string" ? b.thinking : "";
  return "";
}

/** 假文字的几种写法：原文 / JSON 转义一层 / 两层（账本行被 cat 出来再进 tool_result 就是两层）。 */
function echoVariants(forged) {
  const out = new Set();
  let v = forged;
  for (let i = 0; i < 3; i += 1) {
    if (v.length >= ECHO_MIN) out.add(v);
    v = JSON.stringify(v).slice(1, -1);
  }
  return [...out];
}

/** 从 s 里擦掉所有「跟假文字某个开头逐字相同」的片段。返回 [新串, 擦了几个字]。 */
function stripEchoes(s, variants) {
  let removed = 0;
  for (const v of variants) {
    const head = v.slice(0, Math.min(ECHO_HEAD, v.length));
    let from = 0;
    for (;;) {
      const at = s.indexOf(head, from);
      if (at < 0) break;
      let k = head.length;
      while (k < v.length && at + k < s.length && s[at + k] === v[k]) k += 1;
      s = s.slice(0, at) + s.slice(at + k);
      removed += k;
      from = at;
    }
  }
  return [s, removed];
}

/** 深走一遍对象里的字符串（toolUseResult 形状不固定）。 */
function stripDeep(v, variants, acc) {
  if (typeof v === "string") { const [s, n] = stripEchoes(v, variants); acc.n += n; return s; }
  if (Array.isArray(v)) return v.map((x) => stripDeep(x, variants, acc));
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = stripDeep(x, variants, acc);
    return o;
  }
  return v;
}

/**
 * 纯函数：给一份 transcript 的行，算出擦完的行。
 * @param {string[]} lines   非空行（原样字符串）
 * @param {object}   o
 * @param {string[]} [o.cuts]  盒子在这一轮正文里看见的假尾巴（cutHallucinatedTail(...).cut）。
 *                             全文件里跟它们逐字对上的都算；**另外**最后一轮里检测器命中的也算。
 * @param {boolean}  [o.all]   全文件扫（手工清旧账用）。默认只扫最后一轮 + cuts 对得上的。
 */
function planScrub(lines, { cuts = [], all = false } = {}) {
  const objs = parseLines(lines);
  const hints = new Set((cuts || []).map((c) => String(c || "").trimEnd()).filter(Boolean));
  const regionStart = all ? 0 : lastTurnStart(objs);
  const out = lines.slice();
  const changed = new Map();         // idx -> obj（改过的行）
  const removed = new Map();         // uuid -> parentUuid
  const removedIdx = new Set();
  const hits = [];
  const forged = new Set();
  let firstIdx = -1;

  objs.forEach((o, i) => {
    if (!o || o.type !== "assistant" || o.isSidechain) return;
    const content = o.message && o.message.content;
    if (!Array.isArray(content)) return;
    let touched = false;
    const next = [];
    for (const b of content) {
      const t = blockText(b);
      const r = t ? cutHallucinatedTail(t) : { cut: "" };
      const cut = r.cut ? r.cut.trimEnd() : "";
      const eligible = b.type === "text" ? (i >= regionStart || hints.has(cut)) : hints.has(cut);
      if (!cut || !eligible) { next.push(b); continue; }
      touched = true;
      forged.add(cut);
      const keep = r.text.trimEnd();
      const action = keep.trim() ? "truncate" : "drop";
      hits.push({ line: i + 1, uuid: o.uuid || "", block: b.type, kind: r.kind, cutChars: r.cut.length,
        keptChars: keep.length, action, preview: cut.slice(0, 200) });
      if (action === "truncate") next.push(b.type === "text" ? { ...b, text: keep } : { type: "text", text: keep });
    }
    if (!touched) return;
    if (firstIdx < 0) firstIdx = i;
    if (next.length) changed.set(i, { ...o, message: { ...o.message, content: next } });
    else { removedIdx.add(i); if (o.uuid) removed.set(o.uuid, o.parentUuid || null); }
  });

  // 之后的工具结果里原样复述的假文字
  const echoes = [];
  if (firstIdx >= 0) {
    const variants = [];
    for (const f of new Set([...forged, ...hints])) variants.push(...echoVariants(f));
    if (variants.length) {
      for (let i = firstIdx + 1; i < objs.length; i += 1) {
        if (removedIdx.has(i)) continue;
        const o = changed.get(i) || objs[i];
        if (!o || o.type !== "user" || isRealPrompt(o)) continue;
        const c = o.message && o.message.content;
        if (!Array.isArray(c) || !c.some((b) => b && b.type === "tool_result")) continue;
        const acc = { n: 0 };
        const content = c.map((b) => (b && b.type === "tool_result" ? { ...b, content: stripDeep(b.content, variants, acc) } : b));
        const n1 = acc.n;
        const tur = o.toolUseResult !== undefined ? stripDeep(o.toolUseResult, variants, acc) : undefined;
        if (!acc.n) continue;
        const next = { ...o, message: { ...o.message, content } };
        if (tur !== undefined) next.toolUseResult = tur;
        changed.set(i, next);
        echoes.push({ line: i + 1, uuid: o.uuid || "", removedChars: acc.n, inToolResult: n1, inToolUseResult: acc.n - n1 });
      }
    }
  }

  // 拿掉的行：指向它的接到它（最近一个没被拿掉的）祖先上
  const resolve = (u) => { const seen = new Set(); while (u && removed.has(u) && !seen.has(u)) { seen.add(u); u = removed.get(u); } return u; };
  if (removed.size) {
    objs.forEach((o, i) => {
      if (removedIdx.has(i)) return;
      const base = changed.get(i) || o;
      let relinked = null;
      for (const f of LINK_FIELDS) {
        if (typeof base[f] === "string" && removed.has(base[f])) {
          relinked = relinked || { ...base };
          relinked[f] = resolve(base[f]) || null;
        }
      }
      if (relinked) changed.set(i, relinked);
    });
  }

  const newLines = [];
  for (let i = 0; i < out.length; i += 1) {
    if (removedIdx.has(i)) continue;
    newLines.push(changed.has(i) ? JSON.stringify(changed.get(i)) : out[i]);
  }
  return { hits, echoes, removedLines: removedIdx.size, changedLines: changed.size,
    changed: hits.length > 0 || echoes.length > 0, lines: newLines, regionStart: regionStart + 1 };
}

function stampOf(now) { return now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z"); }

/**
 * 真落刀：读 → 算 → 校验链 → 备份 → tmp + rename。任何一步不过，原文件一字不动。
 * @returns {{ok:boolean, changed:boolean, dryRun?:boolean, hits, echoes, removedLines, backup?, reason?}}
 */
function applyScrub({ file, cuts = [], all = false, backupDir = "", dryRun = false, now = new Date() }) {
  if (!file || !fs.existsSync(file)) return { ok: false, changed: false, reason: "transcript 不存在：" + file };
  const tmp = `${file}.scrubtmp-${process.pid}`;
  try {
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    const plan = planScrub(lines, { cuts, all });
    const summary = { hits: plan.hits, echoes: plan.echoes, removedLines: plan.removedLines };
    if (!plan.changed) return { ok: true, changed: false, ...summary };
    if (!plan.lines.length) throw new Error("擦完一行不剩，不对劲");
    // 链：不许比原来多出落空的 parentUuid（原来就断的不归这里管，但不能新断）
    const before = danglingRefs(parseLines(lines));
    const after = danglingRefs(parseLines(plan.lines));
    const fresh = [...after].filter((u) => !before.has(u));
    if (fresh.length) throw new Error(`擦完链断了：${fresh.length} 处 parentUuid 落空`);
    if (dryRun) return { ok: true, changed: true, dryRun: true, ...summary, bytesBefore: Buffer.byteLength(raw) };
    const dir = backupDir || path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const backup = path.join(dir, `${path.basename(file)}.bak-scrub-${stampOf(now)}`);
    fs.copyFileSync(file, backup);
    const mode = fs.statSync(file).mode & 0o777;
    fs.writeFileSync(tmp, plan.lines.join("\n") + "\n", { encoding: "utf8", mode });
    const check = fs.readFileSync(tmp, "utf8").split("\n").filter((l) => l.trim());
    if (check.length !== plan.lines.length) throw new Error("tmp 写出来行数不对");
    fs.renameSync(tmp, file);
    return { ok: true, changed: true, ...summary, backup, bytesBefore: Buffer.byteLength(raw), bytesAfter: fs.statSync(file).size };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 没写出来就没得删 */ }
    return { ok: false, changed: false, reason: (e && e.message) || String(e) };
  }
}

module.exports = { planScrub, applyScrub, isRealPrompt, lastTurnStart, danglingRefs, echoVariants, stripEchoes };

// 手工用：node src/box/transcript-scrub.js <transcript.jsonl> [--all] [--apply] [--backup-dir DIR]
// 默认只干跑（打印会擦什么）。**CLI 在跑的时候别 --apply。**
if (require.main === module) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const bi = args.indexOf("--backup-dir");
  const r = applyScrub({ file, all: args.includes("--all"), dryRun: !args.includes("--apply"),
    backupDir: bi >= 0 ? args[bi + 1] : "" });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
