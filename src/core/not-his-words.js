"use strict";

/**
 * 冷层里「不是他说过的话」的记录 —— 换舱垫尾巴（forge）和冷层摘录都不许当他的原话塞回去。
 *
 * 2026-10-22（Fable 审查 N6）：他选择不说话的轮，出站层往冷层写一条
 * `role:assistant, text:"[本轮未回复]"`（src/gate/outbound.js 的 silent 分支，id 以 -silent 结尾），
 * 只为对账。forge 一直没滤它：每次换舱，近期所有沉默轮都以**他自己说的话**进了新舱 ——
 * 跟 10-16「粉色大象」同型（注入层里的占位符被他当模板学）。Nova冷层当时已有 5 条。
 *
 * 判据只认结构（id 后缀 / 整句等于占位符），不按内容猜。以后再有「只为对账、不是他说的」
 * 记录，加在这里，forge 和摘录两条路一起生效。
 */
const SILENT_PLACEHOLDER = "[本轮未回复]";

function isNotHisWords(r) {
  if (!r || r.role !== "assistant") return false;
  if (/-silent$/.test(String(r.id || ""))) return true;
  return String(r.text || "").trim() === SILENT_PLACEHOLDER;
}

module.exports = { isNotHisWords, SILENT_PLACEHOLDER };
