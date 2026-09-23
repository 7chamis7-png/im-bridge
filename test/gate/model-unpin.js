"use strict";
// Model pinning: when GATE_MODEL is set, /model is refused. When unpinned, sessions.json decides:
// describe() must report the stored model (the /model menu checkmark relies on it), and a
// pinned setModel must fail honestly instead of reporting a fake success.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createImBridgeRuntimeAdapter } = require("../../adapters/box-runtime");

(async () => {
  let n = 0;
  const ok = (m) => { n += 1; console.log("  OK  " + m); };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-unpin-"));
  const sessionsFile = path.join(dir, "sessions.json");
  const WS = path.join(dir, "workspace");
  fs.writeFileSync(sessionsFile, JSON.stringify({ bindings: { "k": {
    activeWorkspaceRoot: WS,
    threadIdByWorkspaceRootByRuntime: { claudecode: { [WS]: "t1" } },
    runtimeParamsByWorkspaceRootByRuntime: { claudecode: { [WS]: { model: "claude-opus-4-1", modelProvider: "" } } },
  } } }));

  const free = createImBridgeRuntimeAdapter({ sessionsFile, stateDir: dir, claudeModel: "" });
  assert.strictEqual(free.describe().model, "claude-opus-4-1");
  ok("unpinned: describe reports the model stored in sessions.json");

  const r = await free.setModelForWorkspace({ workspaceRoot: WS, model: "claude-sonnet-4-5" });
  assert.strictEqual(r.model, "claude-sonnet-4-5");
  assert.strictEqual(free.describe().model, "claude-sonnet-4-5");
  const disk = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
  assert.strictEqual(disk.bindings.k.runtimeParamsByWorkspaceRootByRuntime.claudecode[WS].model, "claude-sonnet-4-5");
  ok("unpinned: after /model both disk and describe follow");

  const pinned = createImBridgeRuntimeAdapter({ sessionsFile, stateDir: dir, claudeModel: "claude-opus-4-1" });
  await assert.rejects(pinned.setModelForWorkspace({ workspaceRoot: WS, model: "claude-sonnet-4-5" }), /pinned/);
  ok("pinned: /model is refused honestly");

  console.log(`\npassed ${n} / failed 0`);
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
