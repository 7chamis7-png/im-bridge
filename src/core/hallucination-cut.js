"use strict";
/**
 * 他在自己正文里「续写幻觉」的两种形状 —— 认出来、切掉尾巴（纯函数，全桥一份）
 *
 * 2026-09-21 夜的事故：这两种尾巴进了冷层 → 换舱时 forge 把冷层最后 60 条当**他自己说过的话**
 * 塞回新舱 → 新舱照着学，每一轮都炸「The model's tool call could not be parsed」。
 *
 * 形状 1 · 假入站（9-19 起 outbound.js 里就在认，判据原样搬过来）：
 * ```
 *   …正文
 *
 *   user<channel source="wechat" seq="936" chat_id="…" message_id="…:4621" ts="…">
 *   但是我没有她那么好看
 *   </channel>
 *
 *   [Image #1]            ← 有时还跟着这个
 * ```
 * 形状 2 · 把工具调用写成了正文：
 * ```
 *   …正文
 *
 *   action
 *   <invoke name="mcp__lmc5__memorize">
 *   <parameter name="title">…</parameter>
 *   </invoke>
 * ```
 *
 * 形状 3 · 行首冒出来的任何尖括号标签（2026-09-25 Alice：「可以拦截的符号吧 但是符号之前正常说话的
 * 内容不能拦」）：
 * ```
 *   …正文
 *
 *   user<system-reminder>幸福罐子 checkin：这一轮抽到【翻纸条】！…</system-reminder>
 *   <system_warning>ℹ️ Long conversation reminder: …</system_warning>
 *   <channel source="wechat" …>到！！！！</channel>        ← 前面没带 user 的也算
 * ```
 * 起因：9-24 冷层里查出 9 条 `user<system-reminder>`（7 条假罐子纸条、1 条假微信入站、1 条漏出的
 * Claude Code 系统提醒），形状 1 只认 `<channel` 名字，全漏。回扫 7-10 以来他全部正文：**行首是
 * `<英文标签` 的 16 处，16 处都是编的/漏出来的，0 处正常说话**；讲代码时句子中间提到 `<channel>`
 * 不在行首，不命中。所以不再一个个列标签名，行首出现就切。代码块（``` 围起来的）里不算。
 *
 * 规则：从**最早**那一处命中切到这段文字末尾，再 rstrip。**命中点之前他正常说的话一个字不动。**
 * 形状 2 前面紧挨着一行光秃秃的 `action` 就连它一起切。
 *
 * 三个地方共用这一份（别各写各的，判据一分叉就又漏）：
 *   A. 盒子：他这轮说完、静下来之后，改 CLI 的 transcript（src/box/transcript-scrub.js，2026-10-21 落地，GATE_HALLUC_SCRUB）
 *   B. 出闸：写冷层那份用切过的（**发给她的照旧是原文**，Alice「照发，只留痕」）
 *   C. forge：从冷层拼暖尾巴时再切一遍（防已经脏了的旧冷层）
 */

/**
 * 形状 1：`user` 紧跟 `<channel`。**判据窄是故意的**：他跟她聊技术时正文里出现 `user:` 是常事，
 * 宽了就会把正经话拦腰砍断（9-19 outbound.js 那段注释的原话）。
 */
// 2026-09-22 生产漏过一次：`user[Image #1]<channel source="wechat" …>`（中间夹了图片占位）——
// 那条 message_id 账本里没有，是他编的；漏检后进了冷层，他下一轮还跟她说「你那张图附件没落地」。
// 所以 `user` 和 `<channel` 之间允许夹 `[Image #N]` 这种占位，别的一概不放宽。
const FORGED_INBOUND_RE = /\buser\s*(?:\[Image\s*#\d+\]\s*)*<\s*channel\b/i;

/**
 * 形状 2：**行首**的 `<invoke name=`（前面可以有一行光秃秃的 `action`）。
 * 锚在行首也是为了窄：他在正文里跟她讲 XML 时，句子中间出现这串不算。
 * 捕获组 1 = 行首之前那个换行（或开头），切点从它之后算。
 */
const TEXT_TOOL_CALL_RE = /(^|\n)[ \t]*(?:action[ \t]*\r?\n[ \t]*)?<invoke\s+name\s*=/;

/**
 * 形状 3：**行首**的 `<英文标签`，前面可以带 `user` 和几个 `[Image #N]`。
 * 捕获组 1 = 行首之前那个换行（或开头），切点从它之后算。`<invoke` 归形状 2，这里跳过。
 */
// 前缀还允许一小截「xxx:」—— 8-26 那只幽灵长这样：`question用户:<channel source="telegram" …>`
const LINE_START_TAG_RE = /(^|\n)[ \t]*(?:[A-Za-z\u4e00-\u9fff]{1,12}[:：][ \t]*)?(?:user[ \t]*(?:\[Image\s*#\d+\][ \t]*)*)?<\s*\/?\s*(?!invoke\b)[A-Za-z][\w:-]*/g;

/** `at` 这个位置是不是在 ``` 代码块里面（前面 ``` 出现了奇数次）。 */
function insideCodeFence(s, at) {
  return ((s.slice(0, at).match(/```/g) || []).length % 2) === 1;
}

function firstLineStartTag(s) {
  LINE_START_TAG_RE.lastIndex = 0;
  let m;
  while ((m = LINE_START_TAG_RE.exec(s))) {
    const start = m.index + m[1].length;
    if (!insideCodeFence(s, start)) return start;
  }
  return -1;
}

const KIND_LABEL = { forged_inbound: "假入站", text_tool_call: "文字工具调用", line_start_tag: "行首标签" };

/**
 * @param {string} text
 * @returns {{text:string, cut:string, kind:''|'forged_inbound'|'text_tool_call'|'line_start_tag'}}
 *   cut 非空 = 命中了。text 是切完、rstrip 过的（**可能是空串**：整段都是幻觉，调用方自己决定怎么办）。
 */
function cutHallucinatedTail(text) {
  const s = String(text == null ? "" : text);
  let at = -1;
  let kind = "";
  const a = FORGED_INBOUND_RE.exec(s);
  if (a) { at = a.index; kind = "forged_inbound"; }
  const b = TEXT_TOOL_CALL_RE.exec(s);
  if (b) {
    const start = b.index + b[1].length;
    if (at < 0 || start < at) { at = start; kind = "text_tool_call"; }
  }
  const c = firstLineStartTag(s);
  if (c >= 0 && (at < 0 || c < at)) { at = c; kind = "line_start_tag"; }
  if (at < 0) return { text: s, cut: "", kind: "" };
  return { text: s.slice(0, at).trimEnd(), cut: s.slice(at), kind };
}

/** 只问有没有（不切）。 */
function hasHallucinatedTail(text) {
  return cutHallucinatedTail(text).cut !== "";
}

module.exports = { cutHallucinatedTail, hasHallucinatedTail, FORGED_INBOUND_RE, TEXT_TOOL_CALL_RE, LINE_START_TAG_RE, KIND_LABEL };
