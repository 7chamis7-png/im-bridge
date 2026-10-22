"use strict";

/**
 * 面板的审计账（2026-10-22）：每一次换舱 / 保存 / 恢复写一行，落在 PANEL_STATE_DIR/audit.jsonl（0600）。
 * 一行：{ at, role, action, file?, before?, after?, result, detail? }
 *   action: rotate（按了换舱）· rotate.result（换舱的最终结果）· save · restore
 *   before / after: 文件改动前后的 sha256；换舱记的是换之前的线程号
 * 只追加，不改不删。
 */

const fs = require("fs");
const path = require("path");
const { stateDir, ensureDir } = require("./state");

function auditFile(env) { return path.join(stateDir(env), "audit.jsonl"); }

function appendAudit(env, row) {
  const f = auditFile(env);
  ensureDir(path.dirname(f));
  const line = JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n";
  const fd = fs.openSync(f, "a", 0o600);
  try { fs.writeSync(fd, line); } finally { fs.closeSync(fd); }
  fs.chmodSync(f, 0o600);
}

/** 最近 n 条（新的在前）。role 给了就只看那个角色的。 */
function readAudit(env, { role = "", limit = 50 } = {}) {
  let text = "";
  try {
    const f = auditFile(env);
    const st = fs.statSync(f);
    const max = 2 * 1024 * 1024;
    const fd = fs.openSync(f, "r");
    try {
      const len = Math.min(st.size, max);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      text = buf.toString("utf8");
    } finally { fs.closeSync(fd); }
  } catch { return []; }
  const rows = [];
  for (const line of text.split("\n").reverse()) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (role && r.role !== role) continue;
    rows.push(r);
    if (rows.length >= limit) break;
  }
  return rows;
}

module.exports = { appendAudit, readAudit, auditFile };
