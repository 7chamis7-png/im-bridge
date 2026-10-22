"use strict";

/**
 * 全本的总开关（S1）。`GATE_HISTORY`：
 *   不设 / off（默认） → 返回 null，盒子一行新代码都不走，行为跟以前逐字节一样（test/gate/history-off-identical.js 守着）
 *   on                 → 写全本；forge 的料源默认也换成全本（见 scripts/forge.js 的 FORGE_SOURCE，=cold 一键回去）
 *
 * 目录默认 $GATE_ROOT/history；`GATE_HISTORY_DIR` 可以指到别处。
 * ⚠️ $GATE_ROOT 整个目录每天被 /root/vps-backup/backup.sh rsync 进 git 备份仓库，history/ 会被一起带进去
 *    （含工具结果；已知密钥写入时已替换）。设计稿 §1.7 / S7：开之前先在 backup.sh 给 history/ 加排除或加密包。
 */

const path = require("path");
const { HistoryWriter } = require("./history-writer");
const { createHistoryRecorder } = require("./history-recorder");

function historyMode(env = process.env) {
  const v = String(env.GATE_HISTORY || "").trim().toLowerCase();
  return ["on", "1", "true", "yes"].includes(v) ? "on" : "off";
}

function historyDir(root, env = process.env) {
  if (env.GATE_HISTORY_DIR) return env.GATE_HISTORY_DIR;
  const r = root || env.GATE_ROOT;
  return r ? path.join(r, "history") : "";
}

/** 开着就给一个记账员，关着给 null。目录建不起来也给 null（大声说），绝不挡盒子起来。 */
function createHistory({ root = "", persona = "", log = () => {}, env = process.env } = {}) {
  if (historyMode(env) !== "on") return null;
  const dir = historyDir(root, env);
  if (!dir) { log("[全本] GATE_HISTORY=on 但没有 GATE_ROOT / GATE_HISTORY_DIR，不记"); return null; }
  try {
    const writer = new HistoryWriter({ dir, log, ...(env.GATE_HISTORY_SECRETS_DIR ? { secretsDir: env.GATE_HISTORY_SECRETS_DIR } : {}) });
    log(`[全本] 开着，写到 ${dir}（已知密钥 ${writer.secrets.length} 个会被替换）`);
    const rec = createHistoryRecorder({ writer, persona, log });
    rec.dir = dir;
    rec.writer = writer;
    return rec;
  } catch (e) {
    log(`[全本] 起不来，这次不记：${(e && e.message) || e}`);
    return null;
  }
}

module.exports = { createHistory, historyMode, historyDir };
