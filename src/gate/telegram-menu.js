"use strict";
/**
 * TG 输入框旁边那个「/」菜单 —— 起来时按桥的命令表重设一遍（2026-10-21 Alice：「加在桥上吧」）。
 *
 * 以前菜单是手打 setMyCommands 设的，跟命令表是两份：9-18 /ctx 就是菜单上有、桥里没有。
 * 现在只有一份：commands.list()，跟 /help 读的是同一张表。加命令 = 注册一下，重启 gate 菜单就跟上。
 *
 * 失败只记一行日志，不拦启动 —— 菜单是方便，不是收发链路。
 */

// 常用的排前面；表里有、这里没列的按注册顺序跟在后面。
const ORDER = ["status", "usage", "model", "engine", "new", "stop", "undo", "help"];

function menuFrom(list) {
  const ok = list.filter((c) => /^[a-z0-9_]{1,32}$/.test(c.name));
  const rank = (n) => { const i = ORDER.indexOf(n); return i < 0 ? ORDER.length : i; };
  return ok
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c.name) - rank(b.c.name) || a.i - b.i)
    .map(({ c }) => ({ command: c.name, description: (c.desc || c.name).slice(0, 256) }))
    .slice(0, 100);
}

async function syncTelegramMenu({ commands, call, log = () => {} }) {
  if (!commands || typeof commands.list !== "function" || typeof call !== "function") return { ok: false, why: "没有命令表或没有 TG 插头" };
  const menu = menuFrom(commands.list());
  try {
    await call("setMyCommands", { commands: menu });
    log("TG 菜单：已按命令表设好 /" + menu.map((m) => m.command).join(" /"));
    return { ok: true, menu };
  } catch (e) {
    log("⚠️ TG 菜单没设上（不影响收发）：" + ((e && e.message) || e));
    return { ok: false, why: String((e && e.message) || e) };
  }
}

module.exports = { syncTelegramMenu, menuFrom, ORDER };
