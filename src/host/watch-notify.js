"use strict";

/**
 * 守护告警推到她手机（2026-10-22）
 *
 * 以前 main.js 里守护的 notify 只写 pm2 日志（`notify: (m) => log(...)`）：
 * turn_acceptance_unknown（有轮卡住、整条队列停摆）、in_no_out（话进去了没出来）
 * 这种要命的，她不翻日志就永远不知道。生产死信里那 4 句话就是这么躺了两个礼拜。
 *
 * 现在：日志照写（原文，排查用）；**另外**走 push-notify（掉档提醒那个推送 bot，
 * 系统警报走系统的身份，不串他的号）推一句人话给她。
 *
 * 节流：**同一类告警 1 小时内最多推一次**（守护自己 30 分钟会重复报一次，那是给日志的）。
 * 没配推送（拿不到 token / chat_id）就只写日志，不报错。
 */

const DEFAULT_THROTTLE_MS = 60 * 60_000;

/** 每类告警推给她的那句话。她看得懂、知道下一步按什么。没列的类别不推（只进日志）。 */
const HUMAN = {
  turn_acceptance_unknown: (n) => `有 ${n || "几"} 条消息卡住了，他后面的话也排着进不去。发 /pending 看看`,
  in_no_out: (n) => `有 ${n || "几"} 条消息等了好几分钟他还没回，可能卡住了。发 /status 看看`,
  unknown_growing: (n) => `有 ${n || "几"} 条他的话不知道发没发到你那，发 /pending 看看`,
  failed_growing: (n) => `有 ${n || "几"} 条他的话发失败了，发 /pending 看看`,
  held_growing: (n) => `有 ${n || "几"} 句他的话找不到发给谁，暂存着。发 /status 看看`,
  heartbeat_stale: () => "桥好像不动了（心跳停了），收发可能都停了",
  no_heartbeat: () => "读不到桥的心跳，桥可能没在跑",
};

/**
 * @param {object} o
 * @param {function|null} o.push   (text) => Promise<boolean>；null = 没配推送，只写日志
 * @param {function} [o.log]
 * @param {number} [o.throttleMs]  同一类多久推一次（默认 1 小时）
 * @param {string} [o.prefix]      推送开头（哪座桥，同机多人格时分得清）
 * @returns {function(string, {issues?:Array}=): void}  直接当 makeWatch 的 notify 用
 */
function makeWatchNotify({ push = null, log = () => {}, throttleMs = DEFAULT_THROTTLE_MS, prefix = "",
  now = () => Date.now() } = {}) {
  const pushedAt = new Map();
  return function notify(message, report = {}) {
    log(String(message || "").replace(/\n/g, " | "));
    if (typeof push !== "function") return null;
    const t = now();
    const lines = [];
    for (const i of (report && Array.isArray(report.issues) ? report.issues : [])) {
      const say = HUMAN[i.code];
      if (!say) continue;
      if (pushedAt.has(i.code) && t - pushedAt.get(i.code) < throttleMs) continue;
      pushedAt.set(i.code, t);
      lines.push(say(i.n));
    }
    if (!lines.length) return null;
    const text = (prefix ? prefix + "：" : "") + lines.join("\n");
    return Promise.resolve().then(() => push(text))
      .then((ok) => { if (!ok) log("[守护] 推送没发出去（看上面 [推送] 那行）"); return ok; })
      .catch((e) => { log("[守护] 推送出错：" + ((e && e.message) || e)); return false; });
  };
}

module.exports = { makeWatchNotify, HUMAN, DEFAULT_THROTTLE_MS };
