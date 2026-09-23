"use strict";

/**
 * System-level push notifications for the operator (e.g. model fallback alerts).
 *
 * These are "the machine talking", not the agent talking, so they do not go
 * through the gate's outbound path (which writes the cold layer and uses the
 * agent's own bot). They are sent by a separate notification bot instead.
 *
 * Lives in src/host/ on purpose: bot tokens are a host concern; src/gate/ knows
 * nothing about Telegram credentials.
 *
 * Configuration (all optional — without them, notifications only go to the log):
 *   GATE_NOTIFY_BOT_TOKEN   bot token given directly
 *   GATE_NOTIFY_BOT_SECRET  or: path to a file containing the token
 *                           (and optionally a line `NOTIFY_CHAT_ID=<id>`)
 *   GATE_NOTIFY_CHAT_ID     chat to notify (overrides the file)
 */

const fs = require("fs");

/** `123456:AbC...` — the file may contain other lines; take the first match. */
const TOKEN_RE = /[0-9]+:[A-Za-z0-9_-]+/;
const CHAT_ID_RE = /NOTIFY_CHAT_ID\s*=\s*(-?[0-9]+)/;

function readBotSecret(file) {
  let raw = "";
  if (!String(file || "").trim()) return { token: "", chatId: "" };
  try { raw = fs.readFileSync(file, "utf8"); } catch { return { token: "", chatId: "" }; }
  const tm = raw.match(TOKEN_RE);
  const cm = raw.match(CHAT_ID_RE);
  return { token: tm ? tm[0] : "", chatId: cm ? cm[1] : "" };
}

/**
 * @param {object} o
 * @param {string} [o.token]      bot token (takes precedence over the file)
 * @param {string} [o.secretFile] file holding the token (+ optional chat id)
 * @param {string} [o.chatId]     overrides the chat id from the file
 * @param {function} [o.log]
 * @param {number} [o.timeoutMs]
 * @returns {function(string): Promise<boolean>}  (text) => sent or not
 */
function makeTelegramPush({ token: tokenOverride = "", secretFile = "", chatId: chatIdOverride = "", log = () => {}, timeoutMs = 10_000 } = {}) {
  return async function push(text) {
    const fromFile = readBotSecret(secretFile);
    const token = String(tokenOverride || fromFile.token || "").trim();
    const chatId = String(chatIdOverride || fromFile.chatId || "").trim();
    if (!token || !chatId) {
      log("[notify] no bot token / chat id configured, not sent: " + String(text || "").slice(0, 80));
      return false;
    }
    try {
      const res = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        log("[notify] telegram returned " + res.status + ": " + body.slice(0, 200));
        return false;
      }
      return true;
    } catch (e) {
      log("[notify] send failed: " + ((e && e.message) || e));
      return false;
    }
  };
}

module.exports = { makeTelegramPush, readBotSecret };
