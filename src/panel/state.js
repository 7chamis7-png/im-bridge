"use strict";

/**
 * 面板自己的状态目录（PANEL_STATE_DIR，默认 ~/.im-bridge-panel）：
 * 登录 token 的哈希、会话的哈希、错误日志的基线。**面板唯一会写的地方**。
 * 目录 0700，文件 0600，写法是先写临时文件再 rename。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

function stateDir(env = process.env) {
  const v = String(env.PANEL_STATE_DIR || "").trim();
  if (v) return path.resolve(v);
  return path.join(String(env.HOME || "").trim() || os.homedir(), ".im-bridge-panel");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

module.exports = { stateDir, ensureDir, readJson, writeJson };
