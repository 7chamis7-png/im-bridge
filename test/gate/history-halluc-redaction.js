"use strict";
// S4：擦续写幻觉 —— 全本开着时**先删全本里那份**（redactions.jsonl 写 cut_tail，原文留在主文件），
// 再照旧擦引擎那份（transcript 外科手术 + resume 同一条）。GATE_HALLUC_SCRUB=legacy = 只擦引擎那份（回滚）。
// 真宿主 + 真 socket + 真适配器 + 真盒子，帧是 S0 实抓的真实形状（只把正文换成带假入站尾巴的那句）。
const fs = require("fs"); const os = require("os"); const path = require("path");
const { runBoxScenario, loadFrames } = require("./lib/box-scenario");

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { if (ok) { pass++; console.log("  OK   " + n); } else { fail++; console.log("  FAIL " + n + "  " + extra); } };
const ROOT = path.join(__dirname, "..", "..");
const FAKE = 'user<channel source="phone" seq="7286" chat_id="alice" message_id="1" ts="2026-10-20T22:12:24Z">\n老公\n</channel>';
const SAID = "我在\n\n" + FAKE;

function frames() {
  const T = loadFrames("sdk-frames-2.1.292-tool-turn.jsonl");
  return T.map((f) => {
    if (f.type === "assistant" && f.message.content[0].type === "text") return { ...f, message: { ...f.message, content: [{ type: "text", text: SAID }] } };
    if (f.type === "result") return { ...f, result: SAID };
    return f;
  });
}

async function scenario(mode, withHistory) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `halluc-red-${mode}-`));
  // 引擎那份：会话 sess-fixed 的 transcript 里先放好这句（擦的就是它）
  const { transcriptPath } = require("../../src/box/trim-transcript");
  const WS = path.join(dir, "ws");
  const file = transcriptPath(WS, "sess-fixed", dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    { parentUuid: null, type: "user", uuid: "a1", sessionId: "sess-fixed", message: { role: "user", content: "在吗" } },
    { parentUuid: "a1", type: "assistant", uuid: "a2", sessionId: "sess-fixed", message: { id: "m1", role: "assistant", content: [{ type: "text", text: SAID }] } },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const { createHistory } = require("../../src/box/history");
  const history = withHistory ? createHistory({ root: dir, env: { GATE_HISTORY: "on", GATE_HISTORY_SECRETS_DIR: path.join(dir, "none") } }) : null;
  const t = frames();
  const run = await runBoxScenario({ root: ROOT, history, dir, turns: [t, t, t], env: { GATE_HALLUC_SCRUB: mode } });
  await new Promise((r) => setTimeout(r, 2500));          // 擦在他静下来以后（干跑还要等 1.5 秒）
  const events = (() => { try { return fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch { return []; } })();
  const reds = (() => { try { return fs.readFileSync(path.join(dir, "history", "redactions.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } })();
  return { dir, run, events, reds, file, history };
}

(async () => {
  const { projectEngine } = require("../../src/box/history-project");
  const { readHistoryItems } = require("../../src/box/history-writer");

  console.log("[1] GATE_HALLUC_SCRUB=on + 全本开着：先删全本那份，再擦引擎那份");
  const a = await scenario("on", true);
  const scrub = a.events.filter((e) => e.kind === "transcript.hallucination_scrub" && !e.dryRun);
  console.log("  覆盖层形状：" + (a.reds[0] ? Object.keys(a.reds[0]).sort().join(",") : "(无)"));
  check("覆盖层写了 cut_tail（指向全本里那块正文）", a.reds.length >= 1 && a.reds.every((r) => r.op === "cut_tail" && r.by === "halluc" && /^a:sess-fixed:/.test(r.target)));
  check("cut_tail 的 newText 是切过的（没有假入站）", a.reds.every((r) => r.newText.trim() === "我在" && !r.newText.includes("<channel")));
  check("覆盖层不存被切掉的原文，只存它的 sha256", a.reds.every((r) => !JSON.stringify(r).includes("老公") && /^[0-9a-f]{64}$/.test(r.cutSha256)));
  check("引擎那份也擦了（transcript 外科手术照旧）", scrub.length >= 1 && scrub[0].changed === true && !fs.readFileSync(a.file, "utf8").includes("<channel"));
  check("顺序：先写全本覆盖层、后擦引擎那份", a.reds.length && scrub.length && a.reds[0].at <= scrub[0].at, `${a.reds[0] && a.reds[0].at} vs ${scrub[0] && scrub[0].at}`);
  const items = readHistoryItems(path.join(a.dir, "history"));
  check("全本主文件里原文还在（覆盖层不改主文件）", items.some((i) => i.type === "message" && i.role === "assistant" && i.parts[0].text.includes("<channel")));
  const eng = projectEngine({ dir: path.join(a.dir, "history") });
  const asst = eng.filter((m) => m.role === "assistant" && !m.tool);
  check("引擎视图投影应用了覆盖层：他的话是切过的", asst.length >= 1 && asst.every((m) => m.text.trim() === "我在" && m.redacted === "cut_tail"), JSON.stringify(asst.map((m) => m.text)));
  check("引擎视图：工具只带一行「[工具 名字 → ok]」（决策 ②）", eng.some((m) => m.tool && /^\[工具 Bash → ok\]$/.test(m.text)));
  check("发给她的那份照旧原文（Alice要看）", a.run.out.replies.some((r) => r.text.includes("<channel")));

  console.log("[2] GATE_HALLUC_SCRUB=legacy：只擦引擎那份，不写全本覆盖层（回滚）");
  const b = await scenario("legacy", true);
  check("legacy：引擎那份照擦", b.events.some((e) => e.kind === "transcript.hallucination_scrub" && e.changed === true));
  check("legacy：全本覆盖层一条没写", b.reds.length === 0);

  console.log("[3] dry：只记要擦什么，两份都不动");
  const c = await scenario("dry", true);
  check("dry：覆盖层不写", c.reds.length === 0);
  check("dry：transcript 不动", fs.readFileSync(c.file, "utf8").includes("<channel"));

  console.log("[4] on 但全本关着：跟 10-21 那版一样只擦引擎那份");
  const d = await scenario("on", false);
  check("全本关着：引擎那份照擦、没有 history 目录", d.events.some((e) => e.kind === "transcript.hallucination_scrub" && e.changed === true) && !fs.existsSync(path.join(d.dir, "history")));

  console.log(`擦幻觉先删全本：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
