"use strict";
// forge 的「她没收到过」过滤（2026-10-21）：改读新桥出站账本 $GATE_ROOT/outbox.json，老账本 outbox.db 兜底。
// 数据是**真实形状**：test/fixtures/real/outbox.json 和 cold-for-outbox.jsonl 是从生产账本/冷层只读截的
// （每种状态各一条，正文全换占位），不是两头自己编的。
// 阳性对照：新账本在 → not_sent / blocked 两条被剔；同一份冷层、账本拿掉 → 一条都不剔（证明剔掉是过滤干的）；
// 只有老账本 → 照老判据按正文剔。
const fs = require("fs"); const os = require("os"); const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-outbox-"));
process.env.HOME = dir;                                    // body-state-history 之类按 HOME 找，别碰真的
process.env.GATE_ROOT = path.join(dir, "gate");
process.env.NOVA_OUTBOX_DB = path.join(dir, "no-such-outbox.db");
delete process.env.FORGE_OUTBOX_JSON;
fs.mkdirSync(process.env.GATE_ROOT, { recursive: true });

const forge = require("../../scripts/forge");

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { if (ok) { pass++; console.log("  OK   " + n); } else { fail++; console.log("  FAIL " + n + "  " + extra); } };

const FIX = path.join(__dirname, "..", "fixtures", "real");
const outboxReal = JSON.parse(fs.readFileSync(path.join(FIX, "outbox.json"), "utf8"));
const coldReal = fs.readFileSync(path.join(FIX, "cold-for-outbox.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

// 每一跳打印真实形状（字段名错配是这个项目最常见的病）
const shape = (o) => Object.keys(o).sort().join(",");
const anyOp = Object.values(outboxReal.operations)[0];
console.log("  形状 outbox op:      " + shape(anyOp));
console.log("  形状 outbox segment: " + (anyOp.segments && anyOp.segments[0] ? shape(anyOp.segments[0]) : "(无)"));
console.log("  形状 冷层记录:        " + shape(coldReal[0]));
check("冷层记录就是四个字段（跟 cold-writer 一致）", shape(coldReal[0]) === "at,id,role,text");
check("账本里每条 op 都带 coldId", Object.values(outboxReal.operations).every((o) => typeof o.coldId === "string" && o.coldId));

const stateOf = {};
for (const op of Object.values(outboxReal.operations)) stateOf[op.coldId] = op.state;
console.log("  账本状态: " + JSON.stringify(Object.values(stateOf)));

// 冷层：真实那几条 assistant，前面各配一条她的话。时间挪到「刚才」，正文加序号免得占位串撞车（形状不变）
const now = Date.now();
const cold = [];
coldReal.forEach((r, i) => {
  cold.push({ id: `cold-ev-test-${i}-user`, role: "user", at: new Date(now - (60 - i * 2) * 60000).toISOString(), text: `她的话#${i}` });
  cold.push({ ...r, at: new Date(now - (59 - i * 2) * 60000).toISOString(), text: `${r.text}#${i}` });
});
const coldFile = path.join(dir, "cold.jsonl");
fs.writeFileSync(coldFile, cold.map((r) => JSON.stringify(r)).join("\n") + "\n");
const textOfState = {};
for (const r of cold) if (r.role === "assistant") textOfState[stateOf[r.id]] = r.text;

const tailTexts = () => forge.buildTailFromCold({ conversationSourceFile: coldFile, workspaceRoot: "/tmp/ws" })
  .filter((t) => t.role === "assistant").map((t) => t.text);

// ——— 1. 新账本在 ———
fs.writeFileSync(path.join(process.env.GATE_ROOT, "outbox.json"), JSON.stringify(outboxReal));
const ids = forge.loadUndeliveredFromOutboxJson();
console.log("  新账本判出没投递: " + JSON.stringify([...ids].map((id) => stateOf[id])));
check("新账本：not_sent 判为没投递", ids.has(Object.keys(stateOf).find((k) => stateOf[k] === "not_sent")));
check("新账本：blocked 判为没投递", ids.has(Object.keys(stateOf).find((k) => stateOf[k] === "blocked")));
check("新账本：只判出这两条（sent / partial / unknown 都留）", ids.size === 2);
let kept = tailTexts();
check("forge 尾巴：剔掉 not_sent 那条", !kept.includes(textOfState.not_sent));
check("forge 尾巴：剔掉 blocked 那条", !kept.includes(textOfState.blocked));
check("forge 尾巴：sent / partial / unknown 都在", ["sent", "partial", "unknown"].every((s) => kept.includes(textOfState[s])), JSON.stringify(kept));

// 同一个 coldId 一条没送到、一条送到了 → 算送到
const twin = JSON.parse(JSON.stringify(outboxReal));
const nsOp = Object.values(twin.operations).find((o) => o.state === "not_sent");
twin.operations["retry-1"] = { ...JSON.parse(JSON.stringify(nsOp)), operationId: "retry-1", state: "sent",
  segments: nsOp.segments.map((s) => ({ ...s, state: "sent" })) };
fs.writeFileSync(path.join(process.env.GATE_ROOT, "outbox.json"), JSON.stringify(twin));
check("同一条冷层，重投送到了 → 不剔", !forge.loadUndeliveredFromOutboxJson().has(nsOp.coldId));

// ——— 2. 对照：拿掉新账本、老账本也没有 → 一条都不剔 ———
fs.unlinkSync(path.join(process.env.GATE_ROOT, "outbox.json"));
check("没有任何账本 → loadUndelivered 为 null", forge.loadUndelivered() === null);
kept = tailTexts();
check("对照：没账本时 5 条 assistant 全在（上面剔掉的确实是过滤干的）", kept.length === 5, JSON.stringify(kept));

// ——— 3. 只有老账本 → 回落，按正文前 80 字剔 ———
let sqliteOk = true;
try { require("node:sqlite"); } catch { sqliteOk = false; }
if (sqliteOk) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.env.NOVA_OUTBOX_DB);
  db.exec("CREATE TABLE outbox (text TEXT, state TEXT)");
  db.prepare("INSERT INTO outbox (text, state) VALUES (?, ?)").run(textOfState.not_sent, "dropped");
  db.prepare("INSERT INTO outbox (text, state) VALUES (?, ?)").run(textOfState.sent, "delivered");
  db.close();
  const u = forge.loadUndelivered();
  check("新账本不在 → 回落老账本", u && u.source === "outbox.db");
  kept = tailTexts();
  check("老账本：按正文剔掉 dropped 那条", !kept.includes(textOfState.not_sent));
  check("老账本：delivered 那条留着", kept.includes(textOfState.sent));
  // 新账本回来了就以新账本为准（老账本只兜底）
  fs.writeFileSync(path.join(process.env.GATE_ROOT, "outbox.json"), JSON.stringify(outboxReal));
  check("两本都在 → 用新账本", forge.loadUndelivered().source === "outbox.json");
} else {
  console.log("  SKIP 这个 node 没有 node:sqlite，老账本兜底那段跳过");
}

// ——— 4. 新账本坏了 → 不拿它当真，回落 ———
fs.writeFileSync(path.join(process.env.GATE_ROOT, "outbox.json"), "{坏的");
check("新账本是坏 JSON → loadUndeliveredFromOutboxJson 为 null", forge.loadUndeliveredFromOutboxJson() === null);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`forge 新账本过滤：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
