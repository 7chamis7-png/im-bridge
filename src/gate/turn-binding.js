"use strict";

/**
 * 本轮来路的落盘绑定（2026-09-17，接线时自审发现的洞）
 *
 * 出闸要靠「本轮的入站事件」才知道发给谁（§0.2）。可入闸在 app.js 里登记完，
 * 事件就只活在那个进程的内存里 —— 而**工具进程是独立进程**（MCP 子进程，
 * 跟主进程不共享内存），它调回复工具时根本拿不到。
 * 不补这一块，接线打上去会把每一条都判成 `proactive_target_not_configured`。
 *
 * 现网已经踩过同一个坑并且解法是对的：`outbox.db` 的 `routes` 表把每轮来路落盘，
 * 就是因为「内存里的 replyTarget 在重启、裁剪、换舱后全部蒸发，
 * 历史上『头几轮投错渠道』全发生在那个窗口」。这里照同一个思路做。
 *
 * 键用 `threadId:turnId`（跟 stream-delivery 的 buildRunKey 同构），
 * 工具进程那边从 runtimeContextStore 拿得到同一对值。
 */

const fs = require("fs");
const path = require("path");

const KEEP = 500;          // 只留最近这些轮，文件不会长到没边

class TurnBinding {
  constructor({ file }) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }

  #read() {
    try { return JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { return {}; }
  }

  #write(obj) {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    fs.renameSync(tmp, this.file);      // 换 inode，读的那头不会读到半截
  }

  static key(threadId, turnId) { return String(threadId || "") + ":" + String(turnId || ""); }

  /** 入闸放行后立刻记：这一轮是从哪条入站来的。 */
  bind(threadId, turnId, event) {
    const k = TurnBinding.key(threadId, turnId);
    if (!k || k === ":") return;
    const all = this.#read();
    all[k] = {
      eventId: event.eventId, channel: event.channel,
      chatId: event.chatId, accountId: event.accountId,
      // 她那条在平台上的号（2026-09-20 加）。点表情、回复某一条都要它。
      // 老记录没有这个字段 → 读出来是 undefined，调用方自己兜底（别在这儿猜）。
      nativeId: event.nativeId || "",
      at: new Date().toISOString(),
    };
    const keys = Object.keys(all);
    if (keys.length > KEEP) {
      keys.sort((a, b) => String(all[a].at).localeCompare(String(all[b].at)));
      for (const old of keys.slice(0, keys.length - KEEP)) delete all[old];
    }
    this.#write(all);
  }

  /** 出闸 / 工具进程回查。查不到返回 null —— **由调用方决定怎么办，这里不猜**。 */
  lookup(threadId, turnId) {
    return this.#read()[TurnBinding.key(threadId, turnId)] || null;
  }
}

module.exports = { TurnBinding };
