"use strict";

/**
 * 机器上的默认位置 —— 原来散在代码里写死的 `/root/...`，统一从这里推（2026-10-21 「拉下来就能用」）。
 *
 * 规矩：**默认值 = 生产现在的结果**。生产所有进程都是 HOME=/root，所以
 *   homePath("nova-notebook") === "/root/nova-notebook"
 * 生产 env 一个字不改照常跑；换台机器、换个用户，跟着 HOME 走。
 *
 *   HOME                    家目录（不设就 os.homedir()）
 *   IM_BRIDGE_SECRETS_DIR   钥匙柜，默认 ~/.secrets（<名字>.secret，600）
 *   NOVA_STATE_DIR          这个人格的数据目录（记忆/纸条/贴纸本…），默认 ~/.nova（名字是历史遗留）
 *
 * ⚠️ IM_BRIDGE_HOME 在生产 env 里指的是**代码目录**（/root/im-bridge），不是数据目录 —— 这里不碰它。
 */

const os = require("os");
const path = require("path");

/** 代码仓库根（这份文件往上两层）。 */
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function homeDir(env = process.env) {
  const v = String(env.HOME || "").trim();
  return v || os.homedir();
}

/** `~/<...parts>` */
function homePath(...parts) {
  return path.join(homeDir(), ...parts);
}

/** 钥匙柜：`<dir>/<名字>.secret`。 */
function secretsDir(env = process.env) {
  const v = String(env.IM_BRIDGE_SECRETS_DIR || "").trim();
  return v || path.join(homeDir(env), ".secrets");
}

/** 这个人格的数据目录（老名字 NOVA_STATE_DIR，没给 = ~/.nova，跟以前一样）。 */
function personaStateDir(env = process.env) {
  const v = String(env.NOVA_STATE_DIR || "").trim();
  return v || path.join(homeDir(env), ".nova");
}

/** 桥目录（GATE_ROOT）。只给「没配也得有个去处」的边角用；主进程照旧必须显式给。 */
function gateRoot(env = process.env, fallbackName = ".nova-gate") {
  const v = String(env.GATE_ROOT || "").trim();
  return v || path.join(homeDir(env), fallbackName);
}

/** Claude Code 的项目目录名：工作目录里的 / 换成 -（/root/nova → -root-nova）。 */
function claudeProjectDir(workspace, env = process.env) {
  return path.join(homeDir(env), ".claude", "projects", String(workspace).replace(/[/.]/g, "-"));
}

module.exports = { REPO_ROOT, homeDir, homePath, secretsDir, personaStateDir, gateRoot, claudeProjectDir };
