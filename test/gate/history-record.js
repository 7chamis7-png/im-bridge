"use strict";
// 全本 S1：盒子把两头的事记成 imb.item.v1。数据是真实形状：S0 实抓的 SDK 帧（正文占位）走真 socket / 真适配器 / 真盒子。
// 每一跳打印真实形状：SDK 帧 → decode 事件 → 通用事件 → 全本记录（字段名错配是这个项目最常见的病）。
const fs = require("fs"); const os = require("os"); const path = require("path");
const { runBoxScenario, loadFrames } = require("./lib/box-scenario");

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { if (ok) { pass++; console.log("  OK   " + n); } else { fail++; console.log("  FAIL " + n + "  " + extra); } };
const ROOT = path.join(__dirname, "..", "..");
const keys = (o) => Object.keys(o || {}).sort().join(",");

(async () => {
  const { decode } = require("../../runtime/decode");
  const { claudeToNeutral } = require("../../src/box/history-claude");
  const { isNarration, isSyntheticMessage } = require("../../adapters/box-runtime");
  const { createHistory } = require("../../src/box/history");
  const { HistoryWriter, readHistoryItems } = require("../../src/box/history-writer");
  const { createHistoryRecorder } = require("../../src/box/history-recorder");

  console.log("[0] 每一跳的形状（真实帧）");
  const frames = loadFrames("sdk-frames-2.1.292-tool-turn.jsonl");
  for (const f of frames.filter((x) => ["assistant", "user", "result"].includes(x.type))) {
    for (const ev of decode(f)) {
      const neutral = claudeToNeutral(ev, { isNarration, isSyntheticMessage });
      console.log(`  帧 ${f.type}${f.message && Array.isArray(f.message.content) ? "[" + f.message.content.map((b) => b.type).join("+") + "]" : ""}`
        + ` → decode{kind:${ev.kind},blockIndex:${ev.blockIndex}} → ${neutral.map((n) => n.kind).join("+") || "(不记)"}`);
    }
  }
  const tu = frames.find((f) => f.type === "assistant" && f.message.content[0].type === "tool_use");
  const nTool = claudeToNeutral(decode(tu)[0], { isNarration, isSyntheticMessage }).find((n) => n.kind === "tool.call");
  console.log("  tool.call 形状: " + keys(nTool));
  check("tool.call 的 id 就是真帧里的 toolu_ 号", nTool && nTool.id === tu.message.content[0].id);
  const tr = frames.find((f) => f.type === "user");
  const nRes = claudeToNeutral(decode(tr)[0], {}).find((n) => n.kind === "tool.result");
  console.log("  tool.result 形状: " + keys(nRes) + "  （真帧 user 键：" + keys(tr) + "）");
  check("tool.result 对上 tool_use_id", nRes && nRes.callId === tu.message.content[0].id);
  const sameMsg = frames.filter((f) => f.type === "assistant" && f.message.id === tu.message.id);
  check("实测：同一 message.id 拆成几帧、blockIndex 都是 0（所以 id 用帧 uuid）",
    sameMsg.length >= 2 && sameMsg.every((f) => decode(f).every((e) => e.blockIndex === 0)));

  console.log("[1] 整条线跑一遍（开关开着）");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-record-"));
  const secretsDir = path.join(dir, "secrets");
  fs.mkdirSync(secretsDir);
  fs.writeFileSync(path.join(secretsDir, "fake-key.secret"), "sk-test-ABCDEFGH12345678\n");
  const env = { GATE_HISTORY: "on", GATE_HISTORY_SECRETS_DIR: secretsDir };
  const history = createHistory({ root: dir, persona: "测试", env });
  // 第二轮的工具结果里塞一个「已知密钥」和一大段（>16KB），看脱敏和 blob
  const t2 = loadFrames("sdk-frames-2.1.292-tool-turn.jsonl", "-t2").map((f) => (f.type !== "user" ? f : {
    ...f, message: { ...f.message, content: f.message.content.map((b) => ({ ...b, tool_use_id: b.tool_use_id + "-t2",
      content: "key=sk-test-ABCDEFGH12345678 " + "x".repeat(20000) })) } }))
    .map((f) => (f.type === "assistant" && f.message.content[0].type === "tool_use"
      ? { ...f, message: { ...f.message, content: [{ ...f.message.content[0], id: f.message.content[0].id + "-t2" }] } } : f));
  const turns = [loadFrames("sdk-frames-2.1.292-tool-turn.jsonl"), t2, loadFrames("../sdk-tool-turn.jsonl")];
  const run = await runBoxScenario({ root: ROOT, history, dir, turns });
  const hdir = path.join(dir, "history");
  const items = readHistoryItems(hdir);
  console.log("  全本记录种类: " + JSON.stringify(items.reduce((m, i) => { const k = i.type + (i.kind ? ":" + i.kind : ""); m[k] = (m[k] || 0) + 1; return m; }, {})));
  for (const t of ["message", "tool_call", "tool_result", "turn_end", "marker"]) {
    const one = items.find((i) => i.type === t);
    if (one) console.log(`  形状 ${t}: ${keys(one)}`);
  }
  const ids = items.map((i) => i.id);
  check("id 没有重复", new Set(ids).size === ids.length);
  const users = items.filter((i) => i.type === "message" && i.role === "user");
  check("三条进来的话都记了（u:trace_id）", ["u:ev-scn-1", "u:ev-scn-2", "u:sys-scn-3"].every((id) => ids.includes(id)), JSON.stringify(users.map((u) => u.id)));
  const u1 = users.find((u) => u.id === "u:ev-scn-1");
  check("她的话：producer=her、不带 <channel> 壳、origin 带平台和 seq", u1 && u1.producer === "her" && !JSON.stringify(u1.parts).includes("<channel")
    && u1.origin.platform === "telegram" && u1.origin.seq === 7001 && u1.at === "2026-10-21T01:00:00.000Z");
  const u2 = users.find((u) => u.id === "u:ev-scn-2");
  check("带图的那条：parts 里有 image（mime、路径）", u2 && u2.parts.some((p) => p.t === "image" && p.mime === "image/png" && p.path));
  const u3 = users.find((u) => u.id === "u:sys-scn-3");
  check("心脏推的那条：producer 是 heart:checkin，不是 her", u3 && u3.producer === "heart:checkin");
  const asst = items.filter((i) => i.type === "message" && i.role === "assistant");
  check("他的正文：4 块（每轮最后一段 + 第三轮工具前那句）", asst.length === 4, String(asst.length));
  check("正文 id = a:<会话>:<帧uuid>:0", asst.every((a) => /^a:sess-fixed:[^:]+:0$/.test(a.id)), asst.map((a) => a.id).join(" "));
  const calls = items.filter((i) => i.type === "tool_call");
  const results = items.filter((i) => i.type === "tool_result");
  check("工具调用 3 个、结果 3 个、两两对上", calls.length === 3 && results.length === 3
    && calls.every((c) => results.some((r) => r.result.callId === c.call.id)));
  check("工具调用在她那条之后、结果之前（顺序是真的）", ids.indexOf("u:ev-scn-1") < ids.indexOf(calls[0].id) && ids.indexOf(calls[0].id) < ids.indexOf("t:" + calls[0].call.id + ":result"));
  const big = results.find((r) => r.result.callId.endsWith("-t2"));
  check("大工具结果：内联截到 16KB、全文进 blob", big && big.result.blob && Buffer.byteLength(big.result.text) <= 16384
    && fs.statSync(path.join(hdir, "blobs", big.result.blob)).size > 20000);
  const raw = fs.readFileSync(path.join(hdir, fs.readdirSync(hdir).find((f) => f.startsWith("items-"))), "utf8");
  const blobRaw = fs.readFileSync(path.join(hdir, "blobs", big.result.blob), "utf8");
  check("已知密钥值：主文件和 blob 里都换掉了", !raw.includes("sk-test-ABCDEFGH12345678") && !blobRaw.includes("sk-test-ABCDEFGH12345678")
    && raw.includes("«secret:fake-key.secret»") && big.secretsScrubbed >= 1);
  const ends = items.filter((i) => i.type === "turn_end");
  check("每轮一个 turn_end，带用量（引擎给的四个数）", ends.length === 3 && ends.every((e) => e.usage && e.usage.context > 0 && e.status === "ok"));
  check("turn_end 跟入站对上（traceId）", ends.map((e) => e.traceId).join(",") === "ev-scn-1,ev-scn-2,sys-scn-3", ends.map((e) => e.traceId).join(","));
  const outs = items.filter((i) => i.kind === "reply_out");
  check("交给桥的每一段都记了（跟盒子给桥的 4 段一一对上）", outs.length === run.out.replies.length
    && outs.every((o, i) => o.meta.text === run.out.replies[i].text));
  check("每轮收尾都记了", items.filter((i) => i.kind === "turn_done").length === 3);
  const opaque = fs.readFileSync(path.join(hdir, "opaque", fs.readdirSync(path.join(hdir, "opaque"))[0]), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  check("thinking 进 opaque/，不进主文件", opaque.length >= 4 && opaque.every((o) => o.kind === "claude.reasoning" && o.payload.signature)
    && !raw.includes("\"signature\""));
  const epochs = fs.readFileSync(path.join(hdir, "epochs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  check("舱台账：第 1 舱绑到 sess-fixed", epochs.length >= 1 && epochs[0].epoch === 1 && epochs.some((e) => e.engineThread === "sess-fixed"), JSON.stringify(epochs));

  console.log("[2] 重启 / 补发环重放：同一批事件再来一遍不写重");
  const before = raw.length;
  const again = createHistoryRecorder({ writer: new HistoryWriter({ dir: hdir, secretsDir }), persona: "测试" });
  for (const f of loadFrames("sdk-frames-2.1.292-tool-turn.jsonl")) {
    for (const ev of decode(f)) for (const n of claudeToNeutral(ev, { isNarration, isSyntheticMessage })) again.onNeutral(n, { uuid: "x", turnId: "turn-1792500000000-1", threadId: "sess-fixed" });
  }
  const after = fs.readFileSync(path.join(hdir, fs.readdirSync(hdir).find((f) => f.startsWith("items-"))), "utf8").length;
  // turn_end 的 id 是 e:<轮 uuid>，这里换了 uuid 所以会多一条；正文 / 工具都按引擎的号去重
  const added = readHistoryItems(hdir).length - items.length;
  check("重放：正文和工具一条都没多（只多一个新 uuid 的 turn_end）", added === 1, `多了 ${added} 条，字节 ${before}→${after}`);
  check("重放：舱号没变（同一条会话）", again.epoch === 1);

  console.log("[3] 断线补不全 → 记一个 gap，不假装补全");
  again.noteGap({ lastSeq: 10, serverLastSeq: 2050 });
  check("gap marker", readHistoryItems(hdir).some((i) => i.kind === "gap" && i.meta.serverLastSeq === 2050));

  console.log("[4] 换舱 → 新舱号，会话号等第一次见到再绑");
  again.noteRotate("水位");
  again.onNeutral({ v: "imb.event.v1", kind: "text", id: "zz:0", text: "新舱第一句", engine: "claude-cli" }, { uuid: "y", turnId: "t9", threadId: "sess-2" });
  const ep2 = fs.readFileSync(path.join(hdir, "epochs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  check("换舱后是第 2 舱、绑到 sess-2", again.epoch === 2 && ep2.some((e) => e.epoch === 2 && e.reason === "rotate") && ep2.some((e) => e.epoch === 2 && e.engineThread === "sess-2"));

  console.log("[5] 已知密钥只认真密钥：.env 里的路径、模型名不算（补录实测踩过：误伤 3842 条）");
  const { loadSecretValues } = require("../../src/box/history-writer");
  const sd = fs.mkdtempSync(path.join(os.tmpdir(), "sec-"));
  fs.writeFileSync(path.join(sd, "a.env"), "GATE_ROOT=/root/.nova-gate\nGATE_MODEL=claude-fable-5-long\nexport TG_BOT_TOKEN=123456:abcdefghijk\n");
  fs.writeFileSync(path.join(sd, "b.secret"), "sk-abcdefgh12345\n");
  fs.writeFileSync(path.join(sd, "c.env.bak-1"), "OPENAI_API_KEY=\"sk-zzzzzzzzzzzz\"\nHOME_DIR_PATH=/root/somewhere\n");
  const vals = loadSecretValues(sd).map((x) => x.value).sort();
  check(".env 只取键名像密钥的值、去引号；路径和模型名不算", JSON.stringify(vals) === JSON.stringify(["123456:abcdefghijk", "sk-abcdefgh12345", "sk-zzzzzzzzzzzz"]), JSON.stringify(vals));

  console.log(`全本记账：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
