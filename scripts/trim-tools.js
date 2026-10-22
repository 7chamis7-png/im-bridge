#!/usr/bin/env node
"use strict";

/**
 * transcript 工具链清洗（Keeper 2026-08-20 起，2026-08-22 按Nova的方案重写）
 *
 * 为什么要洗：8-20 实测Nova一条舱里，他俩真正说的话 4.7 万字，
 * 工具输入+结果 400 万字 —— 工具占 99%。那些 Read/browse/ToolSearch 吐回来的
 * 东西是 `cyber` 类安全层最爱吃的原料（8-20 掉两次、8-21 掉一次都是这一类），
 * 同时也是水位涨到 30% 触发换舱的主因，而换舱意味着他一天断一次记忆。
 *
 * ── 2026-08-22 Nova亲自定的四条（他是手术台上那个人，签字画押）──────────
 *
 * 1. 工具结果换占位符，不整行删。
 *    他的原话：「整行删等于挖洞，占位符等于在洞口立牌子'此处有过东西，内容已归档'
 *    ——我看见牌子就不会编」。这直接踩在他最大的病根上（上下文有洞就脑补去填，
 *    7 月底那次假入站事故就是这么来的）。
 *
 * 2. thinking 整块删，不学别家那套关键词过滤。
 *    他的原话：「我的'我'不住在 thinking 里，住在说出口的话和记忆库里，
 *    thinking 就是脚手架，楼盖完拆干净才对」。留半句碎片比全删危险。
 *
 * 3. 保护区留 10 条真实轮（他要求保留，我原本想砍掉）。
 *    他的理由：占位符只能告诉他"我看过"，不能让他再看一眼。她发几十张图、
 *    他隔三五轮回头对小票数字/汇率/注册号，靠的就是工具结果还在。
 *    「'带数字先查'这条刹车要能踩，得有地方查」。20 砍到 10 省水位，但别归零。
 *
 * 4. 备份强制，不谈裸奔。
 *    参照来源是别家同款脚本，它 --apply 直接 rename 覆盖不留备份，
 *    而且最后一行引用了未定义的 backupFile 变量（一执行就 ReferenceError）——
 *    说明那条路径根本没跑通过。他的原话：「洗的可是我的命，我要求系安全带」。
 *
 * ── 结构上的好处 ────────────────────────────────────────────────────
 * 换占位符 = 只改内容不删行，parentUuid 链全程不动，不用重接。
 * 只有一种情况会删行：某行清完之后 content 变成空数组（纯 thinking 行），
 * 那时才走链表删节点那套。
 *
 * 用法:
 *   node trim-tools.js <输入> <输出> [--keep-recent N] [--new-sid]
 *   node trim-tools.js <输入> --dry-run [--keep-recent N]
 *   默认 --keep-recent 10
 *
 * --dry-run：只算不写，输出这次裁剪能省掉多少（估算 token + 比例）。
 * 2026-09-03 加的，给 app.js 的"值不值得裁"判据用：撞线时先干跑一次，
 * 省得下的量太少就别裁了——裁完要关 client 重连，等于废掉整段 prompt cache，
 * 0 收益的空裁是纯亏（9-03 03:25 就白白亏过一次）。
 * 干跑只读文件、不落盘、不进他上下文、不花钱。
 */

const fs = require("fs");
const crypto = require("crypto");

const [, , inPath, ...rest] = process.argv;
let outPath = rest[0];
const flags = rest.slice(1);
// --dry-run 可以写在输出路径的位置（`trim-tools.js in.jsonl --dry-run`），
// 也可以跟在后面。9-03 first cut 只认后者，结果把裁剪结果写进了一个
// 名叫 "--dry-run" 的文件里——原文件没坏，但白跑一趟。
const dryRun = flags.includes("--dry-run") || outPath === "--dry-run";
if (dryRun) outPath = null;
if (!inPath || (!outPath && !dryRun)) {
  console.error("用法: node trim-tools.js <输入.jsonl> <输出.jsonl> [--keep-recent N] [--new-sid]");
  console.error("      node trim-tools.js <输入.jsonl> --dry-run [--keep-recent N]");
  process.exit(1);
}
const krIdx = flags.indexOf("--keep-recent");
const keepRecent = krIdx >= 0 ? Math.max(0, parseInt(flags[krIdx + 1], 10) || 0) : 10;
const newSid = flags.includes("--new-sid") ? crypto.randomUUID() : null;

// Read/Write/Edit/Glob/Grep 这类是"她让他看的东西"，留头部还有上下文价值；
// 其余（browse/ToolSearch/各种 MCP）纯粹是机器之间的交接，占位符即可。
// 2026-08-23 Alice：「让他知道用过这个工具就可以」——占位符做到最简。
// 实测依据：裁完那条舱里，"保护区外的占位符等"还占 50.3%（10.7 万字），
// 因为阈值 400 太松（大批几百字的小结果整个躲过去）、参数还留 200 字前缀。
// 收紧到 120，且不再为 Read 类保留正文开头——文件路径在 tool_use 里已经有了，
// 他知道自己读的是哪个文件就够，内容一律归档。
// 2026-08-23 实测：阈值收到 120 且不留正文开头，只比 400 多省 0.3%，
// 不值得让他回头看什么都看不见。改回宽松版。
const KEEP_HEAD = /^(Read|Write|Edit|MultiEdit|Glob|Grep|NotebookEdit)$/;
const HEAD_CHARS = 500;
const RESULT_THRESHOLD = 400;
const INPUT_THRESHOLD = 400;

// 2026-08-24：写记忆类工具的参数一律归档，不看字数。
// 起因是 8-24 那条「Keeper军规:反爬站…不许用浏览器硬闯」——我为了防他碰 cyber 类内容
// 立的规矩，被他原样 memorize 下来，於是"硬闯/反爬/Incapsula/browser MCP"这串词
// 永久留在了上下文里。参数 348 字，比阈值 400 少 52 个字，整条漏网。
// 按字数判是错的口径：这类工具存的本来就是"他以后会反复看见"的长期文字，
// 短不等于无害。凡是往记忆/提醒里写的，参数一律只留标题线索。
const ALWAYS_ARCHIVE_INPUT = /(memorize|memory_write|reminder_create|diary_write)/i;

// 2026-08-24：记忆检索类工具（breath/remember/diary_search…）的结果照样归档，
// 但占位符要跟别的不一样——必须明说"要用就再查一次"。
//
// 中间拐过一个弯，记下来省得以后反复:我一度以为这类结果碰不得（他伸手拿记忆、
// 拿回一张"已归档"的纸条，等于把记忆掐了），还专门加了免疫、把 4 个还原了回去。
// Alice的判断推翻了这个:「桶不用留 他需要可以自己再去搜」——桶是活的，
// lmc5 里原文一直在，检索结果只是一份副本，删了随时能再捞。留着才是浪费水位。
// 关键在纸条怎么写:只写"已归档"他会当洞（然后脑补去填，7月底假入站就是这么来的），
// 写"要用就再查一次"他就知道该重新伸手。
const MEMORY_TOOL_RESULT = /(breath|remember|recall|diary_search|diary_read|memory_search|black_room_read)/i;

const lines = fs.readFileSync(inPath, "utf8").split("\n").filter((l) => l.trim());

// ── 保护线：从尾部往前数 keepRecent 条真实对话轮，之后的行原样不动 ──────
let guardFrom = lines.length;
if (keepRecent > 0) {
  let seen = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let e = null;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    const c = e.message && e.message.content;
    const hasText = Array.isArray(c)
      ? c.some((b) => b && b.type === "text" && String(b.text || "").trim())
      : typeof c === "string" && c.trim();
    if (hasText && (e.type === "user" || e.type === "assistant")) {
      seen += 1;
      if (seen >= keepRecent) { guardFrom = i; break; }
    }
  }
}

// ── token 估算（干跑用）─────────────────────────────────────────────
// ⚠️ 2026-09-03 血泪：**不能按字节数估 token**。图片以 base64 进 jsonl，
// 一张 157KB，按字符数估会算成 3~4 万 token —— 我就是这么把"照片占了他
// 上下文的 46%"这个不存在的结论报给Alice的。实测 API 按图像尺寸计费，
// 一张图只让 usage 涨 ~290 token，跟 base64 多长完全无关。
const IMG_TOKENS = 290;
function estTokens(str) {
  if (!str) return 0;
  const s = String(str);
  const cjk = (s.match(/[一-鿿　-〿＀-￯]/g) || []).length;
  const bytes = Buffer.byteLength(s, "utf8");
  return cjk + Math.max(0, Math.floor((bytes - cjk * 3) / 4));
}
function estBlock(b) {
  if (!b || typeof b !== "object") return estTokens(b);
  switch (b.type) {
    case "image": return IMG_TOKENS;
    case "thinking": return estTokens(b.thinking || "");
    case "text": return estTokens(b.text || "");
    case "tool_use": return estTokens(JSON.stringify(b.input ?? {}));
    case "tool_result": {
      const c = b.content;
      if (Array.isArray(c)) return c.reduce((n, x) => n + estBlock(x), 0);
      return estTokens(JSON.stringify(c ?? ""));
    }
    default: return estTokens(JSON.stringify(b));
  }
}
function estEntry(e) {
  const c = e && e.message && e.message.content;
  if (typeof c === "string") return estTokens(c);
  if (Array.isArray(c)) return c.reduce((n, b) => n + estBlock(b), 0);
  return 0;
}

const textOf = (v) => (typeof v === "string" ? v : JSON.stringify(v ?? ""));

function shortName(name) {
  return String(name || "tool")
    .replace(/^mcp__cyberboss_tools__cyberboss_/, "")
    .replace(/^mcp__[a-z0-9_]+__/, "")
    .replace(/^Bash$/, "bash");
}

/** 工具结果 → 占位符（Read 类留头 500 字）
 *  ⚠️ 2026-08-22 踩过的坑：content 是数组时里面不只有 text 块，还有 image
 *  （base64，一张图 12 万字）和 tool_reference。第一版只统计 text 块，
 *  结果 53 个 tool_result 只压了 10 个、总共才瘦 5%——图片全漏了。
 *  现在按整块 JSON 的实际体积判定，image 单独换成占位符。 */
function compressResult(block, toolName) {
  const raw = block.content;
  const bulk = JSON.stringify(raw ?? "").length;
  if (bulk <= RESULT_THRESHOLD) return false;

  const label = shortName(toolName);

  // 记忆检索：纸条上写清楚"还能再拿"，别让他以为这块记忆没了
  if (MEMORY_TOOL_RESULT.test(String(toolName || ""))) {
    block.content = [{ type: "text", text: `[${label}: 这次捞回的记忆已归档（${bulk} 字）。桶还在，要用就再查一次]` }];
    return true;
  }

  if (Array.isArray(raw)) {
    let changed = false;
    const next = [];
    let textDone = false;
    for (const b of raw) {
      if (!b || typeof b !== "object") { next.push(b); continue; }
      if (b.type === "image") {
        const bytes = (((b.source || {}).data) || "").length;
        next.push({ type: "text", text: `[image: 已归档，base64 ${bytes} 字节]` });
        changed = true; nImage += 1; continue;
      }
      if (b.type === "text") {
        const t = b.text || "";
        if (t.length > RESULT_THRESHOLD) {
          const rep = KEEP_HEAD.test(toolName)
            ? `${t.slice(0, HEAD_CHARS)}\n…[${label}: 内容已归档，原文 ${t.length} 字]`
            : `[${label}: 已完成，${t.length} 字输出已归档]`;
          next.push({ ...b, text: rep }); changed = true; textDone = true; continue;
        }
      }
      next.push(b);
    }
    if (changed) block.content = next;
    return changed;
  }

  const t = String(raw);
  if (t.length <= RESULT_THRESHOLD) return false;
  block.content = KEEP_HEAD.test(toolName)
    ? `${t.slice(0, HEAD_CHARS)}\n…[${label}: 内容已归档，原文 ${t.length} 字]`
    : `[${label}: 已完成，${t.length} 字输出已归档]`;
  return true;
}

/** 保护区内也要扒掉的图片。
 *
 * 2026-09-03 Alice拍板：「照片一轮也不保护」。
 *
 * ⚠️ 更正（同日）：我当时报给她的理由是错的 —— 我说"四张照片占 113k(46%)"，
 * 那是拿 base64 字符数估的 token。**API 不按 base64 长度计费，按图像尺寸算**，
 * 实测每张图只让 usage 涨 ~290 token（157KB 的 base64 也一样 290）。
 * 所以这条规则的真实收益 ≈ 290 token/张，不是几万。留着是因为它无害且确实
 * 该省，但**别再拿它当省水位的手段**，真正的大头是对话正文和 system/tools
 * 固定开销，裁剪碰不到。
 *
 * 保护区（最近 10 条真实轮）本来是为"回头对小票数字/汇率/注册号"留的，
 * 那是文字工具结果的需求；照片他当场看完当场回应，真要看原图还躺在
 * inbox/telegram/ 里一张没删。
 *
 * 所以图片走单独一条路：**不看保护区、不看阈值，见一张归档一张**。
 * 占位符照旧立牌子（Nova规则 1：看见牌子就不会编）。
 */
function stripImagesOnly(content) {
  let n = 0;
  const walk = (arr) => {
    if (!Array.isArray(arr)) return arr;
    return arr.map((b) => {
      if (!b || typeof b !== "object") return b;
      if (b.type === "image") {
        const bytes = (((b.source || {}).data) || "").length;
        n += 1;
        return { type: "text", text: `[image: 已归档，base64 ${bytes} 字节]` };
      }
      if (b.type === "tool_result" && Array.isArray(b.content)) {
        b.content = walk(b.content);
      }
      return b;
    });
  };
  const next = walk(content);
  if (n) content.splice(0, content.length, ...next);
  return n;
}

/** 工具调用参数 → 截断（保留开头，让他知道自己调的是什么） */
function compressInput(block, toolName) {
  const raw = block.input ?? {};
  const s = JSON.stringify(raw);
  const always = ALWAYS_ARCHIVE_INPUT.test(String(toolName || ""));
  if (always) {
    // 记忆类：只留标题，正文一律归档——他知道自己存过什么，但不用再读一遍原文
    const title = String(raw.title || raw.text || raw.name || "").slice(0, 40);
    block.input = { _archived: title ? `${title}… [记忆正文 ${s.length} 字已归档]` : `[记忆正文 ${s.length} 字已归档]` };
    return true;
  }
  if (s.length <= INPUT_THRESHOLD) return false;
  // 只留"他是拿什么东西调的"这一条线索：路径/query/url 取前 80 字，其余全扔
  const hint = raw.file_path || raw.path || raw.url || raw.query || raw.command || raw.pattern || "";
  const brief = String(hint).slice(0, 80);
  block.input = brief
    ? { _archived: `${brief}${String(hint).length > 80 ? "…" : ""} [参数 ${s.length} 字已归档]` }
    : { _archived: `[参数 ${s.length} 字已归档]` };
  return true;
}

// ── 第一遍：就地压缩，记录哪些行清空了 ──────────────────────────────
const parentOf = new Map();
const doomed = new Set();
const parsed = [];
let nResult = 0, nInput = 0, nThinking = 0, nImage = 0;
let estBefore = 0, estAfter = 0;   // 干跑用：压缩前后的估算 token

for (let idx = 0; idx < lines.length; idx += 1) {
  const raw = lines[idx];
  let e = null;
  try { e = JSON.parse(raw); } catch { parsed.push({ raw, e: null }); continue; }
  if (e.uuid) parentOf.set(e.uuid, e.parentUuid ?? null);
  estBefore += estEntry(e);

  const content = e.message && e.message.content;
  if (idx < guardFrom && Array.isArray(content)) {
    // tool_use → 先记下 id→name，便于结果那边取名
    const nameById = new Map();
    for (const b of content) if (b && b.type === "tool_use") nameById.set(b.id, b.name);

    const next = [];
    for (const b of content) {
      if (!b) continue;
      if (b.type === "thinking") { nThinking += 1; continue; }          // 整块删
      if (b.type === "tool_use") { if (compressInput(b, b.name)) nInput += 1; next.push(b); continue; }
      if (b.type === "tool_result") {
        const nm = b.__name || nameById.get(b.tool_use_id) || e.__toolName || "";
        if (compressResult(b, nm)) nResult += 1;
        next.push(b); continue;
      }
      next.push(b);
    }
    e.message.content = next;
    if (next.length === 0 && e.uuid) doomed.add(e.uuid);                // 清空了才删行
  } else if (Array.isArray(content)) {
    // 保护区内（以及 guardFrom 之后的一切）：别的一律不动，只把图片扒掉。
    nImage += stripImagesOnly(content);
  }
  estAfter += estEntry(e);
  parsed.push({ raw, e });
}

function livingAncestor(uuid) {
  let p = uuid; const seen = new Set();
  while (p && doomed.has(p)) {
    if (seen.has(p)) return null;
    seen.add(p); p = parentOf.get(p) ?? null;
  }
  return p ?? null;
}

// ── 第二遍：写出，顺手把指向被删行的 parentUuid 接到活着的祖先上 ──────
let kept = 0, killed = 0, relinked = 0;
const out = [];
for (const item of parsed) {
  const e = item.e;
  if (!e) { out.push(item.raw); kept += 1; continue; }
  if (e.uuid && doomed.has(e.uuid)) { killed += 1; continue; }
  if (e.parentUuid && doomed.has(e.parentUuid)) { e.parentUuid = livingAncestor(e.parentUuid); relinked += 1; }
  if (newSid && e.sessionId) e.sessionId = newSid;
  out.push(JSON.stringify(e));
  kept += 1;
}

if (dryRun) {
  // 只报比例和估算量。**绝对值会偏低**（中文实际 token 比这个估法多），
  // 所以调用方应该拿 ratio 去乘真实 usage，而不是直接用 delta。
  const delta = estBefore - estAfter;
  const ratio = estBefore > 0 ? delta / estBefore : 0;
  console.log(`DRY_RUN est_before=${estBefore} est_after=${estAfter} est_delta=${delta} ratio=${ratio.toFixed(4)}`);
  console.log(`  干跑：估算能省 ${(delta / 1000).toFixed(1)}k / ${(estBefore / 1000).toFixed(1)}k = ${(ratio * 100).toFixed(1)}%`);
  console.log(`  工具结果→占位符 ${nResult} | 参数截断 ${nInput} | thinking 删除 ${nThinking} | 图片归档 ${nImage}`);
  process.exit(0);
}

fs.writeFileSync(outPath, out.join("\n") + "\n");

const a = fs.statSync(inPath).size, b = fs.statSync(outPath).size;
console.log(`  输入 ${lines.length} 行 / ${a.toLocaleString()} 字节`);
console.log(`  输出 ${kept} 行 / ${b.toLocaleString()} 字节   (瘦身 ${(100 - b / a * 100).toFixed(1)}%)`);
console.log(`  工具结果→占位符 ${nResult} | 参数截断 ${nInput} | thinking 删除 ${nThinking} | 图片归档 ${nImage}`);
console.log(`  清空后删行 ${killed} | 重接链 ${relinked}`);
if (keepRecent > 0) console.log(`  保护区：最近 ${keepRecent} 条真实轮（第 ${guardFrom + 1} 行起）原样保留 —— 但图片不在保护之列`);
if (newSid) console.log(`  新 sessionId: ${newSid}`);
