#!/usr/bin/env node
"use strict";

/**
 * S3 上线检查：同一时刻用冷层 forge 一份、用全本 forge 一份，比条数和正文。**只读**。
 *
 * 跟换舱时 scripts/forge.js selectTail 跑的是**同一套**（buildTailFromCold / buildTailFromHistory / compareTails），
 * 所以这里过了，换舱那一刻就会用全本；这里不过，换舱那一刻也会自己退回冷层。
 *
 * 另外报一项「冷层 ⊆ 全本」：冷层窗口里她的每一条，全本里有没有（u:<trace_id>）—— 全本刚开、还没覆盖到
 * forge 窗口时，对账必然不过，这一项告诉你还差多少。
 *
 * 用法：
 *   node scripts/history-reconcile.js                    # 读 $GATE_ROOT/cold.jsonl、$GATE_ROOT/history、$GATE_WORKSPACE_ROOT
 *   node scripts/history-reconcile.js --cold F --history D --workspace W [--show]
 * 退出码：0 一致；1 不一致；2 用法 / 读不了。默认不打印正文（--show 才打第一处不一致的前 80 字）。
 */

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const root = process.env.GATE_ROOT || "";
  const a = { cold: root ? path.join(root, "cold.jsonl") : "", history: process.env.GATE_HISTORY_DIR || (root ? path.join(root, "history") : ""),
    workspace: process.env.GATE_WORKSPACE_ROOT || "", show: false };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === "--cold") a.cold = argv[++i];
    else if (k === "--history") a.history = argv[++i];
    else if (k === "--workspace") a.workspace = argv[++i];
    else if (k === "--show") a.show = true;
    else throw new Error("不认识的参数：" + k);
  }
  return a;
}

function main() {
  let a;
  try { a = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); return 2; }
  if (!a.cold || !fs.existsSync(a.cold)) { console.error(`冷层读不到：${a.cold || "(没给)"}`); return 2; }
  if (!a.history || !fs.existsSync(a.history)) { console.error(`全本目录读不到：${a.history || "(没给)"}（GATE_HISTORY 开了没有？）`); return 2; }
  const forge = require("./forge");
  const coldTail = forge.buildTailFromCold({ conversationSourceFile: a.cold, workspaceRoot: a.workspace });
  const histTail = forge.buildTailFromHistory({ historyDir: a.history, workspaceRoot: a.workspace });
  const rec = forge.compareTails(coldTail, histTail);

  // 冷层 ⊆ 全本：冷层这个窗口里她的话（cold-<trace>-user）在全本里有没有 u:<trace>
  const { readHistoryItems } = require("../src/box/history-writer");
  const ids = new Set(readHistoryItems(a.history).map((i) => i.id));
  const { ConversationRecoveryService } = require("../src/services/conversation-recovery-service");
  const window = new ConversationRecoveryService({ conversationSourceFile: a.cold }).listRecentColdRecords({ workspaceRoot: a.workspace });
  const herCold = window.filter((r) => r.role === "user" && /^cold-.+-user$/.test(String(r.id || "")));
  const missing = herCold.filter((r) => !ids.has("u:" + String(r.id).slice(5, -5)));

  console.log(`冷层 forge 尾巴 ${rec.cold} 条；全本 forge 尾巴 ${rec.history} 条 → ${rec.ok ? "一致" : "不一致：" + rec.reason}`);
  console.log(`冷层窗口里她的话 ${herCold.length} 条，全本里缺 ${missing.length} 条${missing.length ? `（最早缺的在 ${missing[0].at}）` : ""}`);
  if (!rec.ok && a.show && rec.firstDiff >= 0) {
    const c = coldTail[rec.firstDiff];
    const h = histTail[rec.firstDiff];
    console.log(`  第 ${rec.firstDiff + 1} 条  冷层: ${c ? c.role + " " + JSON.stringify(String(c.text).slice(0, 80)) : "(无)"}`);
    console.log(`            全本: ${h ? h.role + " " + JSON.stringify(String(h.text).slice(0, 80)) : "(无)"}`);
  }
  console.log(rec.ok ? "→ 换舱时会用全本（FORGE_SOURCE=cold 可一键回去）" : "→ 换舱时会自己退回冷层；全本覆盖到 forge 窗口之前这是正常的");
  return rec.ok ? 0 : 1;
}

if (require.main === module) process.exit(main());
module.exports = { main };
