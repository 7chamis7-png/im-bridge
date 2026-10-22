"use strict";
/**
 * 人格文件由桥来交（2026-10-21 第 3 步）。
 *
 * 守的几件事：
 *   · 人格文件读得到 → 拼在宣言后面交给引擎（claude / codex 同一个口）
 *   · 找不到人格文件 → 绝不起空壳：退回旧 CLAUDE.md / AGENTS.md（大声告警），都没有就拒绝起引擎，
 *     而且**拒绝之前不把正在跑的那个关掉**
 *   · 双份人格 → 内容一样就不重复注入；不一样照注入 + 大声告警（宁可多不可少）
 *   · 桥只读不写：跑完人格文件一个字节、mtime 都没变
 *   · 换舱收尾那段话跟着人格文件改名（不再叫他「写进 CLAUDE.md」）
 * 全程临时目录，不碰生产。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  resolvePersona, readPersonaSpec, composeSystemPrompt, joinInstructions, personaConfigPath, PersonaMissingError,
} = require("../../src/host/persona-file");
const { createCliHost } = require("../../cli-host/server");
const { buildClosingNote } = require("../../src/producers/closing-turn");

let pass = 0, fail = 0;
const check = (n, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(g)} want=${JSON.stringify(w)}`));
  ok ? pass++ : fail++;
};
const truthy = (n, v) => check(n, !!v, true);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-file-"));
let n = 0;
/** 一个干净的工作目录 + 人格配置。files: { 相对路径: 内容 } */
function setup(files = {}, cfg = null) {
  const dir = path.join(root, "case-" + (++n));
  const ws = path.join(dir, "ws");
  fs.mkdirSync(ws, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const f = path.isAbsolute(rel) ? rel : path.join(ws, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  }
  const configFile = path.join(dir, "tools.json");
  if (cfg !== null) fs.writeFileSync(configFile, typeof cfg === "string" ? cfg : JSON.stringify(cfg));
  return { dir, ws, configFile };
}

const SELF = "# 我\n我是Nova。她是Alice。\n";

async function main() {
  // ——— 1. 读配置 ———
  console.log("人格配置");
  {
    const c = setup({}, null);
    check("没有人格配置文件 → null（老样子）", readPersonaSpec(c.configFile), null);
    const c2 = setup({}, { persona: "nova", personaFile: "/x/Nova.md" });
    check("personaFile 读出来", readPersonaSpec(c2.configFile).personaFile, "/x/Nova.md");
    const c3 = setup({}, "{坏的");
    truthy("坏 JSON 不抛，带 error 回来", readPersonaSpec(c3.configFile).error);
    check("配置路径：GATE_TOOLS_CONFIG 优先", personaConfigPath({ GATE_TOOLS_CONFIG: "/a/t.json", GATE_ROOT: "/b" }), "/a/t.json");
    check("配置路径：否则 $GATE_ROOT/tools.json（跟 main.js 同口径）", personaConfigPath({ GATE_ROOT: "/b" }), "/b/tools.json");
  }

  // ——— 2. 正常态：桥交 ———
  console.log("正常态");
  {
    const c = setup({ "Nova.md": SELF }, { persona: "nova", personaFile: "" });
    const pf = path.join(c.ws, "Nova.md");
    const spec = { persona: "nova", personaFile: pf, configFile: c.configFile };
    const r = resolvePersona({ spec, workspaceRoot: c.ws, engine: "claude" });
    check("claude：工作目录没有 CLAUDE.md → 桥交", [r.mode, r.text], ["bridge", SELF]);
    check("没有告警", r.warnings, []);
    const rc = resolvePersona({ spec, workspaceRoot: c.ws, engine: "codex" });
    check("codex：同一份文件同一个口", [rc.mode, rc.text], ["bridge", SELF]);
    const rr = resolvePersona({ spec: { ...spec, personaFile: "Nova.md" }, workspaceRoot: c.ws, engine: "claude" });
    check("相对路径按工作目录解", rr.source, pf);
    check("拼在宣言后面", composeSystemPrompt("宣言", SELF), "宣言\n\n" + SELF.trim());
    check("没有宣言就只有人格", composeSystemPrompt(undefined, SELF), SELF.trim());
    check("codex：人格 + IB 底座两样都要", joinInstructions("人格", "底座"), "人格\n\n底座");
    check("codex：给的已经含底座不重复", joinInstructions("人格\n\n底座", "底座"), "人格\n\n底座");
    check("codex：没给就只有底座（老样子）", joinInstructions(undefined, "底座"), "底座");
  }

  // ——— 3. 双份人格 ———
  console.log("双份人格");
  {
    const c = setup({ "Nova.md": SELF, "CLAUDE.md": SELF });
    const spec = { persona: "nova", personaFile: path.join(c.ws, "Nova.md") };
    const r = resolvePersona({ spec, workspaceRoot: c.ws, engine: "claude" });
    check("内容一样（cp 没 mv）→ 拒绝重复注入", [r.mode, r.text], ["skip-identical", ""]);
    truthy("告警点名那份 CLAUDE.md", r.warnings.some((w) => w.includes("双份") && w.includes("CLAUDE.md")));
    check("CLI 自己会读的那份就是来源", r.source, path.join(c.ws, "CLAUDE.md"));

    const c2 = setup({ "Nova.md": SELF, "CLAUDE.md": "# 新规矩\n一行。\n" });
    const r2 = resolvePersona({ spec: { persona: "nova", personaFile: path.join(c2.ws, "Nova.md") }, workspaceRoot: c2.ws, engine: "claude" });
    check("内容不一样 → 照交人格文件（不能让几行的新 CLAUDE.md 顶掉他）", [r2.mode, r2.text], ["bridge+engine-dup", SELF]);
    truthy("大声告警：两份不一样、要人工合并", r2.warnings.some((w) => w.includes("双份") && w.includes("合并")));

    const c3 = setup({ "Iris.md": SELF, "AGENTS.md": SELF });
    const r3 = resolvePersona({ spec: { persona: "iris", personaFile: path.join(c3.ws, "Iris.md") }, workspaceRoot: c3.ws, engine: "codex" });
    check("codex 认 AGENTS.md 双份", r3.mode, "skip-identical");
    const r4 = resolvePersona({ spec: { persona: "iris", personaFile: path.join(c3.ws, "Iris.md") }, workspaceRoot: c3.ws, engine: "claude" });
    check("claude 不读 AGENTS.md → 不算双份，桥照交", [r4.mode, r4.warnings.length], ["bridge", 0]);

    const c4 = setup({ "Nova.md": SELF, ".claude/CLAUDE.md": SELF });
    const r5 = resolvePersona({ spec: { personaFile: path.join(c4.ws, "Nova.md") }, workspaceRoot: c4.ws, engine: "claude" });
    check(".claude/CLAUDE.md 也算 CLI 自读", r5.mode, "skip-identical");
  }

  // ——— 4. 人格文件找不到：绝不起空壳 ———
  console.log("人格文件缺失");
  {
    const c = setup({ "CLAUDE.md": SELF });
    const spec = { persona: "nova", personaFile: path.join(c.ws, "Nova.md") };
    const r = resolvePersona({ spec, workspaceRoot: c.ws, engine: "claude" });
    check("claude + 旧 CLAUDE.md 在 → 退回 CLI 自己读（老样子）", [r.mode, r.source], ["engine-legacy", path.join(c.ws, "CLAUDE.md")]);
    truthy("大声告警", r.warnings.some((w) => w.includes("读不到") && w.includes("⚠️⚠️⚠️")));

    const r2 = resolvePersona({ spec, workspaceRoot: c.ws, engine: "codex" });
    check("codex + 只有 CLAUDE.md（它不读）→ 桥读旧的交进去", [r2.mode, r2.text], ["bridge-legacy", SELF]);

    const c2 = setup({ "Nova.md": "   \n" });
    let err = null;
    try { resolvePersona({ spec: { persona: "nova", personaFile: path.join(c2.ws, "Nova.md") }, workspaceRoot: c2.ws, engine: "claude" }); }
    catch (e) { err = e; }
    truthy("空文件 + 没有旧文件 → 抛 PersonaMissingError", err instanceof PersonaMissingError);
    truthy("错误原文说「拒绝起…空壳」", err && /空壳/.test(err.message));

    const c3 = setup({}, "{坏的");
    let err2 = null;
    try { resolvePersona({ spec: readPersonaSpec(c3.configFile), workspaceRoot: c3.ws, engine: "codex" }); } catch (e) { err2 = e; }
    truthy("配置坏了 + 没有旧文件 → 也拒绝", err2 instanceof PersonaMissingError);

    const c4 = setup({});
    const r4 = resolvePersona({ spec: null, workspaceRoot: c4.ws, engine: "claude" });
    check("没配 personaFile → 不插手", [r4.mode, r4.text], ["unconfigured", ""]);
    truthy("……但工作目录也空着要告警", r4.warnings.some((w) => w.includes("没有人格文件")));
  }

  // ——— 5. 接到 cli-host 上：起引擎那一刻 ———
  console.log("cli-host 接线");
  {
    const c = setup({ "Nova.md": SELF }, {});
    const pf = path.join(c.ws, "Nova.md");
    fs.writeFileSync(c.configFile, JSON.stringify({ persona: "nova", personaFile: pf }));
    const before = { body: fs.readFileSync(pf), mtime: fs.statSync(pf).mtimeMs };
    const made = [];
    const logs = [];
    const origLog = console.log, origErr = console.error;
    console.error = (...a) => logs.push(a.join(" "));
    const host = createCliHost({
      socketPath: path.join(c.dir, "cli.sock"), ingressPath: path.join(c.dir, "ingress.json"),
      claudePath: "/usr/bin/true", engine: "claude",
      personaSpec: () => readPersonaSpec(c.configFile),
      runtimeFactory(cfg) {
        made.push(cfg);
        return { start: async () => {}, close: async () => {}, status: () => ({ running: true }), done: new Promise(() => {}) };
      },
    });
    const { ensure } = host._internals;
    const out = await ensure({ workspaceRoot: c.ws, threadId: "t1", sdkOptions: { systemPrompt: "宣言" } });
    check("交给引擎的系统提示 = 宣言 + 人格", made[0].sdkOptions.systemPrompt, "宣言\n\n" + SELF.trim());
    check("ensure 回执带人格来源", [out.persona.mode, out.persona.source], ["bridge", pf]);
    check("桥只读不写：内容没变", fs.readFileSync(pf).equals(before.body), true);
    check("桥只读不写：mtime 没变", fs.statSync(pf).mtimeMs, before.mtime);

    // 人格文件被挪走 + 没有旧文件 → 拒绝；而且正在跑的那个不能被关掉
    fs.renameSync(pf, pf + ".gone");
    let err = null;
    try { await ensure({ workspaceRoot: c.ws, threadId: "t2", sdkOptions: { systemPrompt: "宣言" } }); }
    catch (e) { err = e; }
    truthy("找不到人格 → ensure 失败", err && /空壳/.test(err.message));
    check("没起新的引擎（不起空壳）", made.length, 1);
    check("正在跑的那个没被关掉", host._internals.live && host._internals.live.threadId, "t1");

    // 双份：CLAUDE.md 跟人格文件一样 → 不重复注入，日志里大声说
    fs.renameSync(pf + ".gone", pf);
    fs.writeFileSync(path.join(c.ws, "CLAUDE.md"), SELF);
    await ensure({ workspaceRoot: c.ws, threadId: "t3", sdkOptions: { systemPrompt: "宣言" } });
    check("双份同内容 → 引擎只拿到宣言（CLI 自己读 CLAUDE.md）", made[1].sdkOptions.systemPrompt, "宣言");
    truthy("告警打到 stderr", logs.some((l) => l.includes("双份")));

    // 不给 personaSpec = 老样子，系统提示原样
    const made2 = [];
    const host2 = createCliHost({
      socketPath: path.join(c.dir, "cli2.sock"), ingressPath: path.join(c.dir, "ingress2.json"), claudePath: "/usr/bin/true",
      runtimeFactory(cfg) { made2.push(cfg); return { start: async () => {}, close: async () => {}, status: () => ({}), done: new Promise(() => {}) }; },
    });
    await host2._internals.ensure({ workspaceRoot: c.ws, threadId: "x", sdkOptions: { systemPrompt: "宣言" } });
    check("不给 personaSpec → 系统提示原样（测试 / 老宿主不受影响）", made2[0].sdkOptions.systemPrompt, "宣言");
    console.error = origErr; console.log = origLog;
  }

  // ——— 6. 换舱收尾那段话 ———
  console.log("换舱收尾");
  {
    const note = buildClosingNote({ reason: "测", selfFile: "Nova.md" });
    truthy("叫他写进 Nova.md", note.includes("写进 Nova.md"));
    check("不再提 CLAUDE.md", note.includes("CLAUDE.md"), false);
    truthy("不给 = 老样子 CLAUDE.md", buildClosingNote({}).includes("写进 CLAUDE.md"));
  }

  console.log(`\n人格文件：通过 ${pass} / ${pass + fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
