'use strict';

/**
 * codex 的重建插头 —— forge（换舱垫历史）的 codex 那一半（2026-10-21）。
 *
 * claude 那一半是 scripts/forge.js：合成一份 transcript 再 --resume。codex 不写 rollout 文件（格式只在第一行有版本号、
 * 一年换过两种 history_mode，手写太脆，见设计稿 §3.2），走 app-server 的稳定接口：
 *   新开 thread（thread/start）→ thread/inject_items 把投影翻成 Responses API 的 item 塞进去
 * S0 在隔离 CODEX_HOME 里实测过（docs/design-engine-agnostic.md §8.1）：注入的 assistant 话模型认是自己说的、
 * inject 一回来就落进 rollout、重启 resume 后还在、RPC 无大小限制、形状不对当场拒。
 *
 * 料跟 claude 是同一份（scripts/forge.js selectTail：冷层或全本投影，过对账才用全本），这里只管「怎么塞进 codex」。
 * 工具对这一步不塞（include=none，跟今天的 forge 一样）；孤儿 function_call_output inject 时 codex 不拒、模型那轮才 400，
 * 所以以后带工具时必须成对检查（§3.3）。
 */

const fs = require('node:fs');

/** forge 尾巴 [{role, text}] → Responses API 的 message item。空的不要。 */
function tailToResponseItems(tail) {
  const items = [];
  for (const t of Array.isArray(tail) ? tail : []) {
    const text = String((t && t.text) || '');
    if (!text.trim()) continue;
    if (t.role === 'user') items.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
    else if (t.role === 'assistant') items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  }
  return items;
}

const itemText = (content) => (Array.isArray(content) ? content : [])
  .filter((b) => b && (b.type === 'input_text' || b.type === 'output_text')).map((b) => b.text || '').join('');

/**
 * 读回 rollout：rollout 里最后那几条 user/assistant message 必须跟刚注入的逐条一样（角色 + 正文）。
 * 这是 forge verifySynth 的 codex 版：验的是「写对了没有」，不验「模型认不认」（那是 S0 金丝雀的活）。
 */
function verifyInjected({ rolloutPath, items }) {
  if (!rolloutPath) return { ok: false, reason: '不知道 rollout 在哪（thread/start 没给 path）' };
  let lines;
  try { lines = fs.readFileSync(rolloutPath, 'utf8').split('\n').filter((l) => l.trim()); }
  catch (e) { return { ok: false, reason: `读不回 rollout：${e.message}` }; }
  const msgs = [];
  for (const l of lines) {
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    const p = o && o.payload;
    if (o && o.type === 'response_item' && p && p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      msgs.push({ role: p.role, text: itemText(p.content) });
    }
  }
  if (msgs.length < items.length) return { ok: false, reason: `rollout 里只有 ${msgs.length} 条 message，少于注入的 ${items.length} 条` };
  const tail = msgs.slice(-items.length);
  for (let i = 0; i < items.length; i += 1) {
    if (tail[i].role !== items[i].role || tail[i].text !== itemText(items[i].content)) {
      return { ok: false, reason: `第 ${i + 1} 条对不上（rollout ${tail[i].role} vs 注入 ${items[i].role}）` };
    }
  }
  return { ok: true, count: items.length };
}

/**
 * 往**刚开的** thread 里垫历史。driver = codex-appserver 的驱动（要有 threadId / threadPath / injectItems）。
 * @returns {{ok, injected?, verified?, reason?}}
 *   inject 本身失败 → ok:false（什么都没塞进去，调用方照旧走冷层文字垫底）
 *   塞进去了但读不回来 → ok:true, verified:false（**不能**再垫一遍文字，否则他会看见两份），大声说
 */
async function rebuildCodexThread({ driver, tail, log = () => {} }) {
  const items = tailToResponseItems(tail);
  if (!items.length) return { ok: false, reason: '没有可垫的历史' };
  if (!driver || !driver.threadId) return { ok: false, reason: '还没有 thread' };
  try { await driver.injectItems(items); }
  catch (e) { return { ok: false, reason: `thread/inject_items 失败：${e.message}` }; }
  const v = verifyInjected({ rolloutPath: driver.threadPath, items });
  if (!v.ok) {
    log(`[engine/codex] ⚠️ forge 垫了 ${items.length} 条，但回读没对上：${v.reason}（不再补文字垫底，免得他看见两份）`);
    return { ok: true, injected: items.length, verified: false, reason: v.reason };
  }
  return { ok: true, injected: items.length, verified: true };
}

module.exports = { tailToResponseItems, verifyInjected, rebuildCodexThread };
