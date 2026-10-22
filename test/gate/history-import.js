"use strict";
// S1b 补录：只读引擎文件 → 全本（epoch 0 imported）。夹具是从生产 transcript / rollout 只读截出、正文换占位的真实形状。
const fs = require("fs"); const os = require("os"); const path = require("path");
const imp = require("../../scripts/history-import");
const { readHistoryItems } = require("../../src/box/history-writer");

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { if (ok) { pass++; console.log("  OK   " + n); } else { fail++; console.log("  FAIL " + n + "  " + extra); } };
const FIX = path.join(__dirname, "..", "fixtures", "real");
const CC = path.join(FIX, "cc-transcript-2.1.292.jsonl");
const RO = path.join(FIX, "codex-rollout-0.144.5-legacy.jsonl");
const quiet = { log: () => {} };

const rows = fs.readFileSync(CC, "utf8").trim().split("\n").map((l) => JSON.parse(l));
console.log("  夹具 CC 行的形状：" + [...new Set(rows.map((r) => r.type))].join(","));

console.log("[1] 干跑什么都不写");
const dry = fs.mkdtempSync(path.join(os.tmpdir(), "imp-dry-"));
const before = fs.readdirSync(dry).length;
const st = imp.run(["--claude", CC, "--rollout", RO], quiet);
check("干跑：目录里什么都没多", fs.readdirSync(dry).length === before);
check("干跑也算出了记录数", st.items > 20, String(st.items));

console.log("[2] --out 指生产 GATE_ROOT → 拒");
for (const bad of ["/root/.nova-gate/history", "/root/.iris-gate", "/root/.nova-gate"]) {
  let threw = false;
  try { imp.run(["--claude", CC, "--out", bad], quiet); } catch (e) { threw = /生产/.test(e.message); }
  check(`拒写 ${bad}`, threw);
}
process.env.GATE_ROOT = path.join(dry, "gate-root");
let threw = false;
try { imp.run(["--claude", CC, "--out", path.join(process.env.GATE_ROOT, "history")], quiet); } catch (e) { threw = true; }
check("拒写当前 $GATE_ROOT 底下", threw);
delete process.env.GATE_ROOT;

console.log("[3] CC transcript 导出来对不对");
const out = path.join(dry, "out");
imp.run(["--claude", CC, "--out", out], quiet);
const items = readHistoryItems(out);
check("全部 epoch 0 + imported + 带 source 行号", items.every((i) => i.epoch === 0 && i.imported === true && i.source && Number.isInteger(i.source.line)));
const forgedRows = rows.filter((r) => (r.type === "assistant" && String(r.message.id || "").startsWith("msg_synth_"))
  || (r.type === "user" && !("entrypoint" in r) && !(Array.isArray(r.message.content) && r.message.content.some((b) => b.type === "tool_result"))));
check("forge 回填的行默认不导", forgedRows.length > 0 && !items.some((i) => forgedRows.some((r) => i.source.line === rows.indexOf(r))), `forge 行 ${forgedRows.length}`);
const her = items.filter((i) => i.producer === "her");
const channelRows = rows.filter((r) => r.type === "user" && "entrypoint" in r && !r.isMeta && JSON.stringify(r.message.content).includes("<channel "));
check("<channel> 壳拆开：origin 有平台/seq，正文不带壳", her.length === channelRows.length && her.length >= 2 && her.every((u) => u.origin.platform && Number.isInteger(u.origin.seq)
  && !u.parts[0].text.includes("<channel")), JSON.stringify(her.map((u) => u.origin)));
const apiErr = rows.find((r) => r.type === "assistant" && r.message.model === "<synthetic>");
const apiItem = items.find((i) => i.source.line === rows.indexOf(apiErr));
check("CC 造的 API 报错标 generatedBy=engine", apiItem && apiItem.generatedBy === "engine");
const meta = items.filter((i) => i.producer === "engine");
check("isMeta 的 user 行标 producer=engine", meta.length === rows.filter((r) => r.isMeta).length && meta.length > 0);
const calls = items.filter((i) => i.type === "tool_call");
const res = items.filter((i) => i.type === "tool_result");
check("MCP 工具调用拆出 server", calls.some((c) => c.call.server === "notebook" || c.call.server === "stickers"), calls.map((c) => c.call.name).join(","));
check("工具结果里的图进 blob", res.some((r) => r.result.images.length > 0 && fs.existsSync(path.join(out, "blobs", r.result.images[0]))));
check("没加 --opaque 时 thinking 一条都不导", !fs.readdirSync(path.join(out, "opaque")).length);
const ep = fs.readFileSync(path.join(out, "epochs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
check("epochs 记了来源会话（epoch 0 imported）", ep.length === 1 && ep[0].epoch === 0 && ep[0].reason === "imported" && ep[0].engineThread);

console.log("[4] 重复导一次不写重");
const n1 = readHistoryItems(out).length;
imp.run(["--claude", CC, "--out", out], quiet);
check("第二次导：一条没多", readHistoryItems(out).length === n1);

console.log("[5] codex rollout");
const out2 = path.join(dry, "out2");
imp.run(["--rollout", RO, "--opaque", "--out", out2], quiet);
const ri = readHistoryItems(out2);
const rrows = fs.readFileSync(RO, "utf8").trim().split("\n").map((l) => JSON.parse(l));
check("compacted 副本不导", !ri.some((i) => rrows[i.source.line] && rrows[i.source.line].type === "compacted"));
check("context_compacted 记成 engine_compacted marker", ri.some((i) => i.kind === "engine_compacted"));
check("developer 指令不导", !ri.some((i) => rrows[i.source.line].payload && rrows[i.source.line].payload.role === "developer"));
check("<environment_context> 标 producer=engine", ri.some((i) => i.producer === "engine"));
check("commentary 段标 deliverHint=commentary", ri.some((i) => i.deliverHint === "commentary") && ri.some((i) => i.role === "assistant" && i.deliverHint === "text"));
check("exec 工具调用和输出对上", ri.filter((i) => i.type === "tool_call").every((c) => ri.some((r) => r.type === "tool_result" && r.result.callId === c.call.id)));
check("task_complete → turn_end，带 token_count 的用量", ri.some((i) => i.type === "turn_end" && i.usage && i.usage.input > 0));
check("<channel> 那条 producer=her", ri.some((i) => i.producer === "her" && i.origin && i.origin.platform));
const op = fs.readdirSync(path.join(out2, "opaque")).flatMap((f) => fs.readFileSync(path.join(out2, "opaque", f), "utf8").trim().split("\n"));
check("--opaque 时加密 reasoning 进 opaque/", op.length === rrows.filter((r) => r.payload && r.payload.type === "reasoning").length);

fs.rmSync(dry, { recursive: true, force: true });
console.log(`补录：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
