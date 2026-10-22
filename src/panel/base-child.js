"use strict";

/**
 * 面板的子进程：用**这个角色自己的 env**（父进程只给它这一份，别的什么都不带）
 * 预演「下次换舱会拼进去的底子」。
 *
 * config 的口径跟生产完全一样：main.js readConfig → box-build forgeBaseConfig → buildForgeBaseText。
 * 只读：buildForgeBaseText 只读文件；这里不写任何东西。结果一份 JSON 打到 stdout。
 */

const fs = require("fs");
const path = require("path");

// 被 require 的模块可能往 stdout 打日志 —— 全挪去 stderr，stdout 只留结果那一行。
const realWrite = process.stdout.write.bind(process.stdout);
console.log = (...a) => process.stderr.write(a.join(" ") + "\n");
console.info = console.log;

function sourcesFor(name, text, config) {
  const f = (p, kind = "file") => (p ? [{ path: p, kind, exists: fs.existsSync(p) }] : []);
  switch (name) {
    case "执行规则": {
      const out = f(config.operationsFile);
      const dir = String(config.channelsDir || "").trim();
      if (dir) {
        let names = [];
        try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort(); } catch { names = []; }
        if (names.length) for (const n of names) out.push({ path: path.join(dir, n), kind: "file", exists: true });
        else out.push({ path: dir, kind: "dir", exists: fs.existsSync(dir) });
      }
      return out;
    }
    case "身份底座": return f(config.identityInjectionFile);
    case "SESSION HANDOFF": return f(config.sessionHandoffStateFile);
    case "LONG-TERM MEMORY": return f(config.memoryFile);
    case "PENDING PROMISES": return [...f(config.notebookFile), ...(config.notebookModule ? [{ path: config.notebookModule, kind: "module", exists: true }] : [])];
    case "RECENT DIARY": {
      const dir = String(config.diaryDir || "");
      const dates = [...String(text).matchAll(/^### (\d{4}-\d{2}-\d{2})$/gm)].map((m) => m[1]);
      // 跟拼底子的 readDiaryDay 同一个规则（平铺 diary/YYYY-MM-DD.md 优先，再年份目录 diary/YYYY/YYYY-MM-DD.md），存在与否真查
      const { diaryDayPath } = require("../box/instructions");
      return dates.length ? dates.map((d) => { const p = diaryDayPath(dir, d); return { path: p || path.join(dir, d + ".md"), kind: "file", exists: !!p && fs.existsSync(p) }; })
        : f(dir, "dir");
    }
    case "BODY STATE": return f(config.bodyStateFile);
    default: return [];
  }
}

function main() {
  const { readConfig } = require("../host/main");
  const { forgeBaseConfig } = require("../host/box-build");
  const { buildForgeBaseText, FORGE_BASE_HEADERS } = require("../box/instructions");
  const cfg = readConfig(process.env);
  const config = forgeBaseConfig(cfg);
  const text = buildForgeBaseText(config);

  // 跟 describeForgeBase 同一个切法（只认底子自己那几个大块标题），字数才能跟 injection-loaded.json 对上
  const parts = [];
  let name = "执行规则", header = "", buf = [];
  const flush = () => {
    const body = buf.join("\n").trim();
    if (body) parts.push({ name, header, chars: body.length, text: body });
  };
  for (const line of text.split("\n")) {
    const m = /^## (.+)$/.exec(line);
    const top = m && FORGE_BASE_HEADERS.find((h) => m[1].startsWith(h));
    if (top) { flush(); name = top; header = m[1]; buf = []; } else buf.push(line);
  }
  flush();
  for (const p of parts) p.sources = sourcesFor(p.name, p.text, config);

  const paths = {};
  for (const k of ["memoryFile", "bodyStateFile", "operationsFile", "channelsDir", "diaryDir", "identityInjectionFile",
    "notebookModule", "notebookFile", "sessionHandoffStateFile", "conversationSourceFile", "workspaceRoot"]) paths[k] = config[k] || "";
  // 现在的 IB 文件指纹：跟 injection-loaded.json 里记的对一下，看「这一舱带的」是不是已经过时
  let identitySha = "";
  try { if (config.identityInjectionFile) identitySha = require("crypto").createHash("sha256").update(fs.readFileSync(config.identityInjectionFile)).digest("hex"); } catch { /* 读不到就空着 */ }
  return { ok: true, total: text.length, sections: parts, paths, expected: FORGE_BASE_HEADERS, identitySha, persona: personaSources(cfg, config) };
}

/**
 * 人格文件（2026-10-22）：不在底子的那几段里，但同样是**开舱时读一次**的 ——
 * 人格配置（tools.json 的 personaFile）指的那份，加上工作目录里引擎自己会读的 CLAUDE.md / AGENTS.md。
 * 只列存在的；判断「是不是他自己目录里的」在父进程里做（跟底子来源同一把尺子）。
 */
function personaSources(cfg, config) {
  const out = [];
  const seen = new Set();
  const add = (p, role) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    let ok = false;
    try { ok = fs.statSync(p).isFile(); } catch { ok = false; }
    if (ok) out.push({ path: p, kind: "file", exists: true, role });
  };
  const ws = String(config.workspaceRoot || cfg.workspaceRoot || "").trim();
  try {
    const { readPersonaSpec, personaConfigPath } = require("../host/persona-file");
    const spec = readPersonaSpec(cfg.toolsConfigFile || personaConfigPath(process.env));
    if (spec && spec.personaFile) add(path.isAbsolute(spec.personaFile) ? spec.personaFile : path.resolve(ws || ".", spec.personaFile), "人格文件");
  } catch { /* 人格配置读不了就只列工作目录里的 */ }
  if (ws) {
    for (const n of ["CLAUDE.md", "CLAUDE.local.md", path.join(".claude", "CLAUDE.md"), "AGENTS.md", "AGENTS.override.md"]) {
      add(path.join(ws, n), "工作目录里引擎自己读的");
    }
  }
  return out;
}

/**
 * 整舱预演（2026-10-22：「拼起来给我看」）：按开新舱时**真实的顺序**把每一段拼出来。
 * 每一段都是调换舱那几处真用的函数算的，不另拼近似的：
 *   系统提示   = $GATE_SYSTEM_PROMPT_FILE（box-runtime launchRuntime 读的那份）
 *   人格       = persona-file resolvePersona + composeSystemPrompt（cli-host/server.js pickPersona 那套）
 *   身份底座   = codex 单独接在 developerInstructions 后面（cli-host/engines.js joinInstructions）；claude 的在底子里
 *   底子       = instructions.buildForgeBaseText：claude 的 forge 把它当第一条 user 写进合成的新舱；
 *                codex 的 /new 由盒子拼好递给插头，开新 thread 时经 thread/inject_items 当第一条垫进去 ——
 *                身份底座已经在开发者指令里时，插头用 omitForgeBaseSection 拿掉底子里那一段（这里照做，不显示两份）
 *   暖尾巴     = scripts/forge.js selectTail（两家同一份料；排除名单在里面生效）
 * 返回的 tail.candidates 是**不排除**时的全部候选（面板逐轮列、给勾选框用），tail.items 是排除之后真会进去的。
 */
function assemble() {
  const { readConfig } = require("../host/main");
  const { forgeBaseConfig } = require("../host/box-build");
  const { buildForgeBaseText } = require("../box/instructions");
  const { forgeSwitch, boxEngine } = require("../box/forge-switch");
  const { readPersonaSpec, resolvePersona, composeSystemPrompt, joinInstructions } = require("../host/persona-file");
  const { historyMode, historyDir } = require("../box/history");
  const forge = require("../../scripts/forge");
  const tailExclude = require("../box/tail-exclude");
  const cfg = readConfig(process.env);
  const config = forgeBaseConfig(cfg);
  const engine = boxEngine({ env: process.env, model: cfg.model });
  const sw = forgeSwitch({ env: process.env, configFile: cfg.toolsConfigFile });
  const sections = [];
  const add = (key, title, text, source, note = "") => { if (text && String(text).trim()) sections.push({ key, title, text: String(text), chars: String(text).length, source, note }); };

  // 1. 系统提示 + 人格（+ codex 的身份底座）
  let sysText = "";
  if (cfg.systemPromptFile) { try { sysText = fs.readFileSync(cfg.systemPromptFile, "utf8"); } catch { sysText = ""; } }
  let persona = { mode: "unconfigured", text: "", source: "", engineFiles: [], warnings: [] };
  try { persona = resolvePersona({ spec: readPersonaSpec(cfg.toolsConfigFile), workspaceRoot: cfg.workspaceRoot, engine }); }
  catch (e) { persona = { mode: "missing", text: "", source: "", engineFiles: [], warnings: [String(e.message || e)] }; }
  const composed = composeSystemPrompt(sysText, persona.text);
  add("system", "系统提示", sysText, cfg.systemPromptFile, "盒子交给引擎的系统提示（GATE_SYSTEM_PROMPT_FILE）。");
  add("persona", "人格", persona.text, persona.source, `桥交给引擎的人格（${persona.mode}），接在系统提示后面。`);
  // 工作目录里引擎自己会读的那几份（CLAUDE.md / AGENTS.md）：桥管不着，引擎开舱时自己读进去 —— 也是他这一舱的一部分
  for (const f of persona.engineFiles || []) {
    let t = ""; try { t = fs.readFileSync(f, "utf8"); } catch { t = ""; }
    add("persona-engine", "人格（引擎自己读）", t, f, persona.text
      ? "桥已经交了人格文件，引擎还会自己从工作目录再读这一份（两份内容不一样，他会同时看到）。"
      : "桥这次不交人格，引擎开舱时自己从工作目录读这份。");
  }
  let devInstructions = composed;
  if (engine === "codex") {
    let ident = "";
    try { if (config.identityInjectionFile) ident = fs.readFileSync(config.identityInjectionFile, "utf8"); } catch { ident = ""; }
    const full = joinInstructions(composed, ident);
    devInstructions = full;
    if (full.length > composed.length) add("identity", "身份底座", full.slice(composed.length).replace(/^\s+/, ""), config.identityInjectionFile, "codex 把它接在开发者指令最后（engines.js joinInstructions）。");
  }

  // 2. 底子（两家都拼，forge 开着才有）
  let baseText = "";
  if ((engine === "claude" || engine === "codex") && sw.on) {
    baseText = buildForgeBaseText(config) || "";
    if (engine === "codex") {
      // 跟 codex 插头同一个判法（cli-host/codex-runtime.js forgeBase）：IB 已经在开发者指令里 → 底子里那段拿掉
      const { forgeBaseSectionBody, omitForgeBaseSection } = require("../box/instructions");
      const ib = forgeBaseSectionBody(baseText, "身份底座");
      const dropped = !!(ib && String(devInstructions).trim().includes(ib));
      if (dropped) baseText = omitForgeBaseSection(baseText, "身份底座");
      add("base", "底子", baseText, "", "开新 thread 时经 thread/inject_items 当第一条（她那一侧的）消息垫进去，在暖尾巴前面。"
        + (dropped ? "身份底座已经在开发者指令里，底子里那一段拿掉了（不让他看见两份）。" : ""));
    } else {
      add("base", "底子", baseText, "", "forge 把它写成新舱里的第一条（她那一侧的）消息。");
    }
  }

  // 3. 暖尾巴
  const privateMaterial = engine === "claude";   // 身体态 / 旧账本只给 claude 那一家垫（box-runtime / codex-runtime 同一判据）
  const hdir = historyMode(process.env) === "on" ? historyDir(cfg.root, process.env) : "";
  const args = { conversationSourceFile: config.conversationSourceFile, workspaceRoot: cfg.workspaceRoot, historyDir: hdir,
    withBody: privateMaterial, oldOutboxDb: privateMaterial, log: () => {} };
  let picked = { tail: [], source: "", reconcile: null, cap: {} };
  let all = { tail: [], source: "" };
  const excludeFile = tailExclude.tailExcludeFile(cfg.root);
  const ex = tailExclude.readTailExclude(excludeFile);
  if (sw.on) {
    picked = forge.selectTail({ ...args, exclude: ex.entries });
    all = forge.selectTail({ ...args, exclude: false });
  }
  const strip = (t) => ({ role: t.role, text: t.text, timestamp: t.timestamp, sourceId: t.sourceId || "", rawText: t.rawText || "" });
  const tailText = picked.tail.map((t) => t.text).join("\n\n");
  const bytes = (s) => Buffer.byteLength(String(s || ""), "utf8");
  const totalChars = sections.reduce((n, x) => n + x.chars, 0) + picked.tail.reduce((n, t) => n + String(t.text || "").length, 0);
  const tokens = Math.ceil((sections.reduce((n, x) => n + bytes(x.text), 0) + bytes(tailText)) / 2);
  return {
    ok: true, engine, forge: sw, persona: { mode: persona.mode, source: persona.source, warnings: persona.warnings },
    sections, totalChars, tokens,
    tail: { source: picked.source, reconcile: picked.reconcile, cap: picked.cap, items: picked.tail.map(strip),
      candidates: all.tail.map(strip), candidateSource: all.source },
    exclude: { file: excludeFile, entries: ex.entries, updatedAt: ex.updatedAt, used: tailExclude.readUsedLog(excludeFile, 10) },
  };
}

let result;
try { result = process.argv[2] === "assemble" ? assemble() : main(); } catch (e) { result = { ok: false, error: String((e && e.message) || e) }; }
realWrite(JSON.stringify(result) + "\n");
