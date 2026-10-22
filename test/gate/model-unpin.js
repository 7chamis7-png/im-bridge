"use strict";
// 2026-09-23 Alice：「模型没有钉住哪里吧」—— 钉着。GATE_MODEL 有值时 /model 一律被拒，
// 按钮点了也白点。解钉后 sessions.json 说了算：这里盯住「解钉时 describe 报的是存的那个」
// （/model 选单的 ✓ 靠它），以及「钉着时 setModel 如实拒绝，不报假成功」。
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
  const WS = "/root/nova";
  fs.writeFileSync(sessionsFile, JSON.stringify({ bindings: { "k": {
    activeWorkspaceRoot: WS,
    threadIdByWorkspaceRootByRuntime: { claudecode: { [WS]: "t1" } },
    runtimeParamsByWorkspaceRootByRuntime: { claudecode: { [WS]: { model: "claude-opus-5-5[1m]", modelProvider: "" } } },
  } } }));

  const free = createImBridgeRuntimeAdapter({ sessionsFile, stateDir: dir, claudeModel: "" });
  assert.strictEqual(free.describe().model, "claude-opus-5-5[1m]");
  ok("没钉：describe 报 sessions.json 里存的那个（不是空）");

  const r = await free.setModelForWorkspace({ workspaceRoot: WS, model: "claude-fable-5[1m]" });
  assert.strictEqual(r.model, "claude-fable-5[1m]");
  assert.strictEqual(free.describe().model, "claude-fable-5[1m]");
  const disk = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
  assert.strictEqual(disk.bindings.k.runtimeParamsByWorkspaceRootByRuntime.claudecode[WS].model, "claude-fable-5[1m]");
  ok("没钉：/model 换完，存盘和 describe 都跟着变");

  const pinned = createImBridgeRuntimeAdapter({ sessionsFile, stateDir: dir, claudeModel: "claude-opus-5-5[1m]" });
  await assert.rejects(pinned.setModelForWorkspace({ workspaceRoot: WS, model: "claude-fable-5[1m]" }), /钉死/);
  ok("钉着：/model 如实拒绝，不报假成功");

  console.log(`\n通过 ${n} / 失败 0`);
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
