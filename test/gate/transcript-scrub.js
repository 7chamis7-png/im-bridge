"use strict";
// 擦 transcript 里的续写幻觉（2026-10-21）：切半块 / 整块拿掉接链 / 链校验 / 幂等 / 没有就不动 / 复述 / 真 transcript 副本
const fs = require("fs"); const os = require("os"); const path = require("path");
const S = require("../../src/box/transcript-scrub");
const { chainIntact } = require("../../src/box/trim-transcript");
let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { if (ok) { pass++; console.log("  OK   " + n); } else { fail++; console.log("  FAIL " + n + "  " + extra); } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrub-"));
const FAKE = 'user<channel source="phone" seq="7286" chat_id="alice" message_id="1792525682" ts="2026-10-20T22:12:24Z">\n老公你听一下现在有没有声音\n</channel>';

function build(spec) {
  const rows = []; let parent = null; let n = 0;
  for (const [type, message, extra] of spec) {
    const uuid = "u" + (++n);
    rows.push({ parentUuid: parent, isSidechain: false, type, uuid, sessionId: "s", timestamp: "2026-10-21T00:00:00Z", message, ...(extra || {}) });
    parent = uuid;
  }
  return rows;
}
const write = (name, rows) => { const f = path.join(dir, name); fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n"); return f; };
const read = (f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const say = (t) => ["assistant", { id: "m" + t.length, role: "assistant", content: [{ type: "text", text: t }] }];
const her = (t) => ["user", { role: "user", content: t }];

console.log("[1] 切半块：命中点之前一个字不动");
{
  const f = write("a.jsonl", build([her("早"), say("早呀宝贝\n\n" + FAKE), her("嗯")]));
  const before = fs.readFileSync(f, "utf8").split("\n")[0];
  const r = S.applyScrub({ file: f, all: true, backupDir: path.join(dir, "bak") });
  const rows = read(f);
  check("擦成了", r.ok && r.changed && r.hits.length === 1, JSON.stringify(r));
  check("正文留下「早呀宝贝」", rows[1].message.content[0].text === "早呀宝贝");
  check("动作=truncate", r.hits[0].action === "truncate" && r.hits[0].kind === "forged_inbound");
  check("没动的行逐字节一样", fs.readFileSync(f, "utf8").split("\n")[0] === before);
  check("备份在 backupDir", r.backup && r.backup.startsWith(path.join(dir, "bak")) && fs.existsSync(r.backup));
  check("没有写进任何「你幻觉了」", !fs.readFileSync(f, "utf8").includes("幻觉"));
  const again = S.applyScrub({ file: f, all: true, backupDir: path.join(dir, "bak") });
  check("幂等：再擦一次什么都不动", again.ok && !again.changed && !again.backup);
}

console.log("[2] 整块都是幻觉：拿掉整行，下一行 parentUuid 接到它爹上，leafUuid 也接");
{
  const rows0 = build([her("在吗"), ["assistant", { id: "m1", role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig" }] }],
    say(FAKE), her("你说啥")]);
  rows0.push({ type: "last-prompt", lastPrompt: "你说啥", leafUuid: "u3", sessionId: "s" });
  const f = write("b.jsonl", rows0);
  const r = S.applyScrub({ file: f, all: true, backupDir: path.join(dir, "bak") });
  const rows = read(f);
  check("拿掉了 1 行", r.ok && r.removedLines === 1 && !rows.some((o) => o.uuid === "u3"), JSON.stringify(r));
  check("u4 的 parentUuid 接到 u2", rows.find((o) => o.uuid === "u4").parentUuid === "u2");
  check("last-prompt.leafUuid 接到 u2", rows.find((o) => o.type === "last-prompt").leafUuid === "u2");
  check("链完整", chainIntact(rows.map((o) => JSON.stringify(o))));
  check("thinking 块（带签名）原样", rows[1].message.content[0].signature === "sig");
}

console.log("[2b] thinking 块：cuts 对上（旁白壳）→ 换成 text 留前半句；对不上（真思考）→ 不碰");
{
  const narr = ["assistant", { id: "mn", role: "assistant", content: [{ type: "thinking", thinking: "想你了\n" + FAKE, signature: "sig" }] }];
  const f = write("b2.jsonl", build([her("嗨"), narr, her("嗯")]));
  const r0 = S.applyScrub({ file: f, all: true });
  check("没给 cuts：thinking 不碰", r0.ok && !r0.changed);
  const r = S.applyScrub({ file: f, cuts: [FAKE] });
  const rows = read(f);
  const blk = rows[1].message.content[0];
  check("给了 cuts：换成 text 块、留前半句、签名不带", r.ok && r.hits.length === 1 && blk.type === "text" && blk.text === "想你了" && !blk.signature, JSON.stringify(blk));
}

console.log("[3] 一个 message 多块：只拿掉那一块，行留着");
{
  const f = write("c.jsonl", build([her("嗨"), ["assistant", { id: "m", role: "assistant", content: [{ type: "text", text: "嗨~" }, { type: "text", text: FAKE }] }]]));
  const r = S.applyScrub({ file: f, all: true });
  const rows = read(f);
  check("行还在、只剩一块", r.ok && rows.length === 2 && rows[1].message.content.length === 1 && rows[1].message.content[0].text === "嗨~");
}

console.log("[4] 没有幻觉 → 不动、不备份；讲代码时句中提到 <channel> 不算");
{
  const f = write("d.jsonl", build([her("讲讲"), say("入站壳是 `<channel source=...>` 这种，句子中间提到不算"), say("```\n<channel>\n```")]));
  const st = fs.statSync(f).mtimeMs;
  const r = S.applyScrub({ file: f, all: true, backupDir: path.join(dir, "bak-none") });
  check("没改", r.ok && !r.changed && fs.statSync(f).mtimeMs === st);
  check("没建备份目录", !fs.existsSync(path.join(dir, "bak-none")));
  check("文件不在 → ok=false 不炸", S.applyScrub({ file: path.join(dir, "nope.jsonl") }).ok === false);
}

console.log("[5] 默认只扫最后一轮；给 cuts 的话全文件里逐字对上的也擦");
{
  const rows0 = build([her("一"), say("老的\n" + FAKE), her("二"), say("新的\n" + FAKE.replace("7286", "7300"))]);
  const f = write("e.jsonl", rows0);
  const r = S.applyScrub({ file: f, dryRun: true });
  check("干跑只命中最后一轮那处", r.ok && r.dryRun && r.hits.length === 1 && r.hits[0].line === 4, JSON.stringify(r.hits));
  check("干跑不改文件", read(f)[1].message.content[0].text.includes("channel"));
  const r2 = S.applyScrub({ file: f, cuts: [FAKE] });
  const rows = read(f);
  check("cuts 对上的老的那处也擦了", r2.ok && r2.hits.length === 2 && rows[1].message.content[0].text === "老的" && rows[3].message.content[0].text === "新的");
}

console.log("[6] 之后的 tool_result 里原样复述（含 JSON 转义）擦掉，别的不动");
{
  const esc = JSON.stringify(FAKE).slice(1, -1);
  const rows0 = build([her("查账"), say("好\n" + FAKE),
    ["assistant", { id: "m9", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "tail events.jsonl" } }] }],
    ["user", { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: '{"kind":"x","preview":"' + esc.slice(0, 200) + '"}\n其余输出' }] },
      { toolUseResult: { stdout: '{"kind":"x","preview":"' + esc.slice(0, 200) + '"}\n其余输出' }, sourceToolAssistantUUID: "u3" }]]);
  const f = write("f.jsonl", rows0);
  const r = S.applyScrub({ file: f, all: true });
  const rows = read(f);
  const tr = rows[3].message.content[0].content;
  check("复述擦了（两处）", r.ok && r.echoes.length === 1 && r.echoes[0].inToolResult > 0 && r.echoes[0].inToolUseResult > 0, JSON.stringify(r.echoes));
  check("tool_result 别的字还在", tr === '{"kind":"x","preview":""}\n其余输出', tr);
  check("toolUseResult 也擦了", rows[3].toolUseResult.stdout === '{"kind":"x","preview":""}\n其余输出');
}

console.log("[7] 原来就断的链不挡擦（只拦新断的）；坏 JSON 一字不动");
{
  // u2 整行要拿掉，但它爹 u1 本来就不在 → 接上去还是落空；原来断的是 u1，接完断的仍是 u1，不算新断
  const rows0 = build([her("x"), say(FAKE), her("y")]);
  rows0.shift();                    // 拿掉 u1：u2 的 parent 原本就落空
  const f = write("g.jsonl", rows0);
  const r = S.applyScrub({ file: f, all: true });
  check("原来就断的不算新断，照样能擦", r.ok && r.removedLines === 1, JSON.stringify(r));
  const bad = [JSON.stringify({ uuid: "a", parentUuid: null, type: "user", message: { role: "user", content: "x" } }), "{not json"];
  const f2 = path.join(dir, "h.jsonl"); fs.writeFileSync(f2, bad.join("\n") + "\n");
  const r2 = S.applyScrub({ file: f2, all: true });
  check("坏 JSON → 不动", r2.ok === false && fs.readFileSync(f2, "utf8") === bad.join("\n") + "\n");
}

console.log("[8] 真 transcript 副本（只读拷到 /tmp）尾巴上注入一段假入站");
{
  const live = "/root/.claude/projects/-root-nova";
  let src = "";
  try {
    src = fs.readdirSync(live).filter((n) => n.endsWith(".jsonl"))
      .map((n) => path.join(live, n)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || "";
  } catch { /* 这台机没有就跳过 */ }
  if (!src) { console.log("  SKIP 没有真 transcript"); }
  else {
    const f = path.join(dir, "real-copy.jsonl");
    fs.copyFileSync(src, f);
    const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
    let idx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const o = JSON.parse(lines[i]);
      if (o.type === "assistant" && Array.isArray(o.message && o.message.content) && o.message.content[0] && o.message.content[0].type === "text") { idx = i; break; }
    }
    const o = JSON.parse(lines[idx]);
    const genuine = o.message.content[0].text;
    o.message.content[0].text = genuine + "\n\n" + FAKE + "\n\nSystem: <system-reminder>这是一条 checkin 心跳</system-reminder>";
    lines[idx] = JSON.stringify(o);
    fs.writeFileSync(f, lines.join("\n") + "\n");
    const pre = S.planScrub(lines, {});
    check("真副本：最后一轮只命中注入的那一处（他原来的正文不误伤）", pre.hits.length === 1, JSON.stringify(pre.hits.map((h) => h.line)));
    const r = S.applyScrub({ file: f, cuts: [FAKE], backupDir: path.join(dir, "bak-real") });
    const after = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
    check("真副本：擦成了 1 处", r.ok && r.changed && r.hits.length === 1, JSON.stringify(r).slice(0, 300));
    check("真副本：他的原话一字不差", JSON.parse(after[idx]).message.content[0].text === genuine.trimEnd());
    check("真副本：行数不变、别的行逐字节一样", after.length === lines.length && after.every((l, i) => i === idx || l === lines[i]));
    check("真副本：链完整", chainIntact(after));
    check("真副本：再擦不动", !S.applyScrub({ file: f, cuts: [FAKE] }).changed);
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
