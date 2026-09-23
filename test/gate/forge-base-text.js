"use strict";
/**
 * The session base text must never be silently empty.
 *
 * An unreadable path means "that section is skipped" with no error, so this
 * test goes through the real wiring (buildBox → config → buildForgeBaseText)
 * and checks every section is present.
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
  fs.writeFileSync(path.join(mem, "memory.md"), "# Long-term memory\n\n## About the owner\nThe owner likes tea.\n");
  fs.writeFileSync(path.join(mem, "agent-state.txt"), "energy: high");
  fs.writeFileSync(path.join(mem, "operations.md"), "## Operating rules\nDo not run tools needlessly. Address {{USER_NAME}}.\n");
  fs.mkdirSync(path.join(mem, "channels"));
  fs.writeFileSync(path.join(mem, "channels", "wechat.md"), "## WeChat only\n[emoji-rule]\n");
  fs.writeFileSync(path.join(dir, "injection.txt"), "I am the agent. First-person continuity.");
  fs.writeFileSync(path.join(dir, "cold.jsonl"), "");

  const cfg = {
    root: dir, coldFile: path.join(dir, "cold.jsonl"), claudeCommand: "claude", model: "m",
    systemPromptFile: "", fallbackModel: "", claudePermissionMode: "acceptEdits",
    bindingKey: "b", workspaceRoot: "/ws", ownerName: "owner",
    memoryDir: mem, identityInjectionFile: path.join(dir, "injection.txt"),
  };
  let captured = null;
  const backend = {
    runtime: (c) => { captured = c; return { initialize: async () => {} }; },
    make: () => ({}),
  };
  await buildBox({ cfg, backend, persona: null });

  console.log("[1] box config carries every base-context path");
  for (const k of ["memoryFile", "agentStateFile",
    "operationsFile", "channelsDir", "identityInjectionFile", "diaryDir"]) {
    check(k, typeof captured[k] === "string" && captured[k].length > 0);
  }

  console.log("[1.5] roll-call matches what was actually assembled");
  {
    const d = describeForgeBase(captured);
    check("total = assembled length", d.total === buildForgeBaseText(captured).length);
    // notebook and diary are empty in this fixture → at least 4 sections
    check("at least 4 sections", d.sections.length >= 4, "only " + d.sections.map((x) => x.name).join("/"));
    const want = require("crypto").createHash("sha256").update(fs.readFileSync(path.join(dir, "injection.txt"))).digest("hex");
    check("identity fingerprint = file sha256", d.injection && d.injection.sha256 === want && d.injection.bytes > 0);
    check("manifest path in config", typeof captured.injectionManifestFile === "string" && captured.injectionManifestFile.endsWith("injection-loaded.json"));
  }

  console.log("[2] every base section is present");
  const text = buildForgeBaseText(captured);
  const must = [
    ["operations", "Do not run tools needlessly"],
    ["template placeholder rendered", "Address owner."],
    ["channel-specific", "[emoji-rule]"],
    ["IDENTITY header", "## IDENTITY"],
    ["IDENTITY body", "I am the agent"],
    ["LONG-TERM MEMORY", "## LONG-TERM MEMORY"],
    ["memory body", "The owner likes tea"],
    ["AGENT STATE", "energy: high"],
  ];
  for (const [n, needle] of must) check(n, text.includes(needle), "missing: " + needle);
  check("not empty (>300 chars)", text.length > 300, "only " + text.length + " chars");

  console.log(`\nbase text: ${pass} passed / ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("✗", e); process.exit(1); });
