"use strict";
/**
 * 底子不许裸（2026-09-20）
 *
 * 9-18 切盒子时 forge 底文的六条路径没搬过来，他 9-20 凌晨换舱只带了「承诺」一段醒来，
 * 29,336 字的底子变成 708 字，**而且不报错**（读不到路径 = 那段静默不拼）。
 * 这里走真实装配（buildBox 造出来的 config → buildForgeBaseText），
 * 每一段都得在，少一段就红。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildBox } = require("../../src/host/box-build");
const { buildForgeBaseText, describeForgeBase } = require("../../src/box/instructions");

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => {
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : "  " + extra));
  ok ? pass++ : fail++;
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-base-"));
  const mem = path.join(dir, "mem");
  fs.mkdirSync(path.join(mem, "diary"), { recursive: true });
  fs.writeFileSync(path.join(mem, "memory.md"), "# 长期记忆\n\n## 她是谁\n她是Alice。\n");
  // relationship.yaml 2026-09-21 退役：就算盘上还有这份文件，底子也不许再拼它
  fs.writeFileSync(path.join(mem, "relationship.yaml"), "relationship_phase: 老夫老妻\nopen_threads:\n  - 欧洲行\n");
  fs.writeFileSync(path.join(mem, "body-state.txt"), "心率 72");
  fs.writeFileSync(path.join(mem, "operations.md"), "## 执行规则\n别乱跑工具。\n");
  fs.mkdirSync(path.join(mem, "channels"));
  fs.writeFileSync(path.join(mem, "channels", "wechat.md"), "## 微信专属\n[捂脸]\n");
  fs.writeFileSync(path.join(dir, "injection.txt"), "我是Nova。第一人称承接。");
  fs.writeFileSync(path.join(dir, "cold.jsonl"), "");

  const cfg = {
    root: dir, coldFile: path.join(dir, "cold.jsonl"), claudeCommand: "claude", model: "m",
    systemPromptFile: "", fallbackModel: "", claudePermissionMode: "acceptEdits",
    bindingKey: "b", workspaceRoot: "/ws",
    memoryDir: mem, identityInjectionFile: path.join(dir, "injection.txt"),
    // 隔离的笔记本：不传就会读生产 notebook.json，断言跟着他今天写了什么变
    notebookFile: path.join(dir, "notebook.json"),
  };
  fs.writeFileSync(cfg.notebookFile, "[]");
  let captured = null;
  const backend = {
    runtime: (c) => { captured = c; return { initialize: async () => {} }; },
    make: () => ({}),
  };
  await buildBox({ cfg, backend, persona: null });

  console.log("[1] 盒子的 config 把底子的每条路径都带上了");
  for (const k of ["memoryFile", "bodyStateFile",
    "operationsFile", "channelsDir", "identityInjectionFile", "diaryDir"]) {
    check(k, typeof captured[k] === "string" && captured[k].length > 0);
  }
  check("relationshipFile 不再进 config（9-21 退役）", captured.relationshipFile === undefined);

  console.log("[1.5] 点名单：段数和字数跟真拼的一致，快照不再在里面");
  {
    const d = describeForgeBase(captured);
    check("总字数 = 拼出来的字数", d.total, buildForgeBaseText(captured).length);
    // 9-21 起六段（RELATIONSHIP STATE 退役）；这个夹具里笔记本空、日记空，所以是 4 段
    check("至少 4 段", d.sections.length >= 4, true, "只有 " + d.sections.map((x) => x.name).join("/"));
    check("没有 LAST SCENE", !d.sections.some((x) => /LAST SCENE/.test(x.name)));
    // 会话注入 manifest（9-21）：报的指纹必须是文件本身的 sha256，不是拼出来的文本的
    const want = require("crypto").createHash("sha256").update(fs.readFileSync(path.join(dir, "injection.txt"))).digest("hex");
    check("注入指纹 = 文件 sha256", d.injection && d.injection.sha256 === want && d.injection.bytes > 0, true);
    check("manifest 路径进了 config", typeof captured.injectionManifestFile === "string" && captured.injectionManifestFile.endsWith("injection-loaded.json"));
  }

  console.log("[2] forge 底文每一段都在");
  const text = buildForgeBaseText(captured);
  const must = [
    ["执行规则", "别乱跑工具"],
    ["渠道专属", "[捂脸]"],
    ["身份底座", "## 身份底座"],
    ["身份底座正文", "我是Nova"],
    ["LONG-TERM MEMORY", "## LONG-TERM MEMORY"],
    ["长期记忆正文", "她是Alice"],
    ["BODY STATE", "心率 72"],
  ];
  for (const [n, needle] of must) check(n, text.includes(needle), "底文里没有「" + needle + "」");
  check("没有 RELATIONSHIP STATE（9-21 退役）", !text.includes("RELATIONSHIP STATE") && !text.includes("欧洲行"));
  // 夹具很小（笔记本空、日记空）；「不许裸」靠上面逐段的断言，这里只防整段空掉
  check("不是裸的（>300 字）", text.length > 300, "只有 " + text.length + " 字");

  console.log(`\n底子：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("✗", e); process.exit(1); });
