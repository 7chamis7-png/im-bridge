// 2026-10-22（Fable N6）：沉默轮的「[本轮未回复]」占位符不许当他的原话进换舱尾巴 / 冷层摘录。
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : "  " + extra)); ok ? pass++ : fail++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nhw-"));
process.env.NOVA_STATE_DIR = path.join(tmp, "state");
process.env.GATE_ROOT = path.join(tmp, "gate");
fs.mkdirSync(process.env.NOVA_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.GATE_ROOT, { recursive: true });

const { isNotHisWords } = require("../../src/core/not-his-words");
console.log("\n[1] 判据");
check("id 以 -silent 结尾 → 不是他的话", isNotHisWords({ role: "assistant", id: "cold-ev-x-silent", text: "随便" }));
check("正文就是占位符 → 不是他的话", isNotHisWords({ role: "assistant", id: "h-1", text: " [本轮未回复] " }));
check("他真说的话 → 留", !isNotHisWords({ role: "assistant", id: "cold-ev-x-reply-1-assistant", text: "嗯，在呢" }));
check("她说的占位符字样 → 不归这条管（只管 assistant）", !isNotHisWords({ role: "user", id: "u", text: "[本轮未回复]" }));
check("他话里提到占位符 → 留（不按内容猜）", !isNotHisWords({ role: "assistant", id: "a", text: "刚才那个[本轮未回复]是啥" }));

console.log("\n[2] 冷层 → 尾巴");
const now = Date.now();
const at = (m) => new Date(now - m * 60000).toISOString();
const cold = path.join(tmp, "cold.jsonl");
fs.writeFileSync(cold, [
  { id: "cold-ev-1-user", role: "user", at: at(5), text: "在吗" },
  { id: "cold-ev-1-silent-silent", role: "assistant", at: at(4), text: "[本轮未回复]" },
  { id: "cold-ev-2-user", role: "user", at: at(3), text: "睡了吗" },
  { id: "cold-ev-2-reply-1-assistant", role: "assistant", at: at(2), text: "没呢" },
].map((r) => JSON.stringify(r)).join("\n") + "\n");
const { ConversationRecoveryService } = require("../../src/services/conversation-recovery-service");
const recs = new ConversationRecoveryService({ conversationSourceFile: cold }).listRecentColdRecords({});
check("冷层摘录不含占位符", recs.length === 3 && !recs.some((r) => r.text === "[本轮未回复]"), JSON.stringify(recs.map((r) => r.text)));
check("他真说的那句还在", recs.some((r) => r.text === "没呢"));

const forge = require("../../scripts/forge");
if (typeof forge.buildTailFromCold === "function") {
  const tail = forge.buildTailFromCold({ conversationSourceFile: cold, workspaceRoot: "", withBody: false, oldOutboxDb: false });
  const texts = JSON.stringify(tail);
  check("forge 尾巴不含占位符", !texts.includes("本轮未回复"), texts.slice(0, 300));
  check("forge 尾巴里有他真说的那句", texts.includes("没呢"), texts.slice(0, 300));
} else {
  check("forge 导出了 buildTailFromCold", false, "没导出，测不到 forge 那条路");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
