"use strict";
// 裁工具链（2026-09-21 搬回）：干跑估收益 / 落刀备份 / 链不断 / 路径算法
const assert = require("assert");
const fs = require("fs"); const os = require("os"); const path = require("path");
const T = require("../../src/box/trim-transcript");
let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { if (ok) { pass++; console.log("  OK   " + n); } else { fail++; console.log("  FAIL " + n + "  " + extra); } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trim-"));
const file = path.join(dir, "s.jsonl");
const rows = []; let parent = null; let n = 0;
const row = (type, message, extra = {}) => { const uuid = "u" + (++n); rows.push({ type, uuid, parentUuid: parent, sessionId: "s", timestamp: new Date().toISOString(), message, ...extra }); parent = uuid; };
for (let i = 0; i < 16; i++) {
  row("user", { role: "user", content: "第 " + i + " 句" });
  row("assistant", { role: "assistant", content: [{ type: "thinking", thinking: "想一想".repeat(200), signature: "x" }, { type: "tool_use", id: "t" + i, name: "Read", input: { file_path: "/x/" + i } }] });
  row("user", { role: "user", content: [{ type: "tool_result", tool_use_id: "t" + i, content: "工具吐出来的东西".repeat(2000) }] });
  row("assistant", { role: "assistant", content: [{ type: "text", text: "好的 " + i }] });
}
fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

console.log("[1] 路径算法跟 gate-box-claudecode 一致");
check("/root/nova → -root-nova", T.transcriptPath("/root/nova", "abc", "/home/x") === "/home/x/.claude/projects/-root-nova/abc.jsonl");

console.log("[2] 干跑估收益");
const est = T.estimateTrimGain({ file, currentTokens: 300_000 });
check("干跑 ok", est.ok, JSON.stringify(est));
check("ratio 在 (0,1)", est.ok && est.ratio > 0 && est.ratio < 1, String(est.ratio));
check("gain = ratio × 水位 × 0.85", est.ok && est.gain === Math.round(est.ratio * 300_000 * 0.85));
check("文件不在 → 不 ok 不炸", T.estimateTrimGain({ file: path.join(dir, "nope.jsonl") }).ok === false);

console.log("[3] 落刀：备份 / 变小 / 链完整 / tmp 清掉");
const before = fs.statSync(file).size;
const r = T.applyTrim({ file });
check("裁成了", r.ok, r.reason || "");
check("有备份且跟原文件一样大", r.ok && fs.existsSync(r.backup) && fs.statSync(r.backup).size === before);
check("文件变小了", r.ok && r.after < before, `${before} → ${r.after}`);
const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
check("每行 JSON 合法 + 链完整", T.chainIntact(lines));
check("tmp 没留下", !fs.existsSync(file + ".trimtmp"));
check("保护区那几轮的工具结果还在", lines.slice(-8).some((l) => l.includes("工具吐出来的东西")));
check("早年的工具结果换成占位符了", !lines.slice(0, 8).some((l) => l.includes("工具吐出来的东西".repeat(2))));

console.log("[4] 链断了要认得出");
check("指向不存在的 parent → false", T.chainIntact([JSON.stringify({ uuid: "a", parentUuid: null }), JSON.stringify({ uuid: "b", parentUuid: "zzz" })]) === false);
check("坏 JSON → false", T.chainIntact(["{not json"]) === false);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
