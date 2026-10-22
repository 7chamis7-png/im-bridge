"use strict";

/**
 * 系统级推送 —— 不是Nova的嘴，是给Alice的运维提醒（2026-09-21）
 *
 * 掉档提醒之类「机器在说话，不是他在说话」的东西不走桥的出闸（那条走冷层、
 * 走人设、走Nova的号）。这里直接拿 `/root/.secrets/ib-notify-bot.secret`
 * 那个推送 bot 发（记忆 `reference-push-bot`），跟老桥 `fable-guard` 用
 * `@Alice_Keeper_bot` 是一个道理：系统警报走系统的身份，不串人格的号。
 *
 * **这个文件不属于桥**（住在 `src/host/`）——token 是宿主层的东西，
 * `src/gate/` 不认识 telegram，更不该认识密钥文件在哪。
 */

const fs = require("fs");

/** `123456:AbC...` 一份文件里可能还有别的行，只认这个形状的第一个匹配。 */
const TOKEN_RE = /[0-9]+:[A-Za-z0-9_-]+/;
const CHAT_ID_RE = /IB_NOTIFY_CHAT_ID\s*=\s*(-?[0-9]+)/;

function readBotSecret(file) {
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8"); } catch { return { token: "", chatId: "" }; }
  const tm = raw.match(TOKEN_RE);
  const cm = raw.match(CHAT_ID_RE);
  return { token: tm ? tm[0] : "", chatId: cm ? cm[1] : "" };
}

/**
 * @param {object} o
 * @param {string} o.secretFile  存 token（+ 可能的 chat_id）的文件
 * @param {string} [o.chatId]    给了就用这个，不给就读文件里 `IB_NOTIFY_CHAT_ID=`
 * @param {function} [o.log]
 * @param {number} [o.timeoutMs]
 * @returns {function(string): Promise<boolean>}  (text) => 发没发出去
 */
function makeTelegramPush({ secretFile, chatId: chatIdOverride = "", log = () => {}, timeoutMs = 10_000 } = {}) {
  if (!String(secretFile || "").trim()) throw new Error("makeTelegramPush 要一个 secretFile");
  return async function push(text) {
    const { token, chatId: fileChatId } = readBotSecret(secretFile);
    const chatId = String(chatIdOverride || fileChatId || "").trim();
    if (!token || !chatId) {
      log("[推送] 拿不到 token/chat_id（" + secretFile + "），这条没发出去：" + String(text || "").slice(0, 40));
      return false;
    }
    try {
      const res = await fetch(require("../gate/plugins/telegram").telegramApiBase() + "/bot" + token + "/sendMessage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        log("[推送] telegram 回了 " + res.status + "：" + body.slice(0, 200));
        return false;
      }
      return true;
    } catch (e) {
      log("[推送] 发不出去：" + ((e && e.message) || e));
      return false;
    }
  };
}

module.exports = { makeTelegramPush, readBotSecret };
