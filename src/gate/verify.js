"use strict";

/**
 * 入闸验收（设计稿 v1.5 §0.1）
 *
 * 闸不解码，但闸验收。插件漏了某步加工（例如忘记 zstd 解压）交上来一坨乱码，
 * 闸认得出「这不像人话」，标注并登记，但**不让它冒充她说过的话**。
 *
 * 判据来源：linux-db-watch.py 的 looks_binary()。2026-09-17 我抄这个判据时
 * 漏了 `ch not in "\n\r\t"`，把换行当坏字符，19729 条正常消息被判成乱码
 * （真实是 4 条）。**换行、回车、制表符是正常文本，不是坏字符。**
 */

/** 与 linux-db-watch.py:looks_binary 一字不差 */
function looksBinary(text) {
  const s = String(text || "");
  if (!s) return false;
  let bad = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 0xfffd || (c < 32 && ch !== "\n" && ch !== "\r" && ch !== "\t")) bad += 1;
  }
  return bad >= 3 || bad / s.length > 0.05;
}

/** 0.5：插件必须声明自己做了哪几步加工，闸据此判断该按什么验收 */
const KNOWN_STEPS = new Set([
  "decrypted",      // 平台解密
  "decompressed",   // 解压（微信长文本走 zstd）
  "parsed",         // 平台私有格式解析（如 appmsg xml）
  "transcribed",    // 语音转写
  "none",           // 明确声明「无需加工」
]);

/**
 * @returns {{ok: boolean, verdict: string, reasons: string[]}}
 *   verdict: accepted | undecoded | no_content
 *   undecoded 不是丢弃 —— 事件照样登记，只是正文不得充当用户原话。
 */
function verifyInbound(delivery) {
  const reasons = [];
  const steps = Array.isArray(delivery && delivery.processing) ? delivery.processing : [];
  for (const s of steps) {
    if (!KNOWN_STEPS.has(s)) reasons.push("未知的处理步骤声明: " + s);
  }
  if (!steps.length) reasons.push("缺少处理链声明（0.5 要求插件声明自己做了什么）");

  const text = String((delivery && delivery.text) || "");
  const media = (delivery && delivery.media) || [];
  const hasMedia = Array.isArray(media) && media.length > 0;

  if (!text && !hasMedia) {
    return { ok: false, verdict: "no_content", reasons: reasons.concat("既无正文也无媒体") };
  }
  if (text && looksBinary(text)) {
    reasons.push("正文未能解码成人类可读文本 —— 插件可能漏了某一步加工");
    return { ok: false, verdict: "undecoded", reasons };
  }
  return { ok: reasons.length === 0, verdict: "accepted", reasons };
}

module.exports = { looksBinary, verifyInbound, KNOWN_STEPS };
