"use strict";
// 掉档提醒（2026-09-21，9-21 审后补）：requested vs actual model 的 episode 状态机 +
// 额度用完那道独立闸 + 「请求的模型」现读 sessions.json（/model 热切不许被误判成掉档）。
// 假 notify，不真发 telegram；状态落临时目录，验重启不重推那条也在这儿测。
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  decide, bareModel, resolveRequestedModel, makeModelFallbackAlert,
} = require("../../src/host/model-fallback-alert");

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { if (ok) { pass++; console.log("  OK   " + n); } else { fail++; console.log("  FAIL " + n + "  " + extra); } };

function tmpDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

/** 照 session-store.js 文件头那份格式写一份 sessions.json。 */
function writeSessions(file, { bindingKey, workspaceRoot, model, runtimeId = "claudecode" }) {
  fs.writeFileSync(file, JSON.stringify({
    bindings: {
      [bindingKey]: {
        runtimeParamsByWorkspaceRootByRuntime: {
          [runtimeId]: { [workspaceRoot]: { model, modelProvider: "" } },
        },
      },
    },
  }, null, 2));
}

(() => {
  console.log("[0] bareModel 脱后缀");
  check("脱掉 [1m]", bareModel("claude-fable-5[1m]") === "claude-fable-5");
  check("没有后缀也照样过", bareModel("claude-opus-5") === "claude-opus-5");
  check("空值不炸", bareModel("") === "" && bareModel(undefined) === "");
})();

(() => {
  console.log("[1] decide 纯函数：fable→opus 只推一次");
  let s = { modelStatus: "normal", lastActual: "", sessionLimitAlerted: false };
  const requested = "claude-fable-5[1m]";
  let r = decide(s, { type: "model", actual: "claude-fable-5", requested, turnId: "t1" });
  check("请求即实际，正常轮不吭声", r.alert === null && r.state.modelStatus === "normal");
  s = r.state;

  r = decide(s, { type: "model", actual: "claude-opus-5", requested, turnId: "t2" });
  check("换了模型，第一次推 fallback_start", r.alert && r.alert.kind === "fallback_start");
  check("进 fallback 状态", r.state.modelStatus === "fallback");
  s = r.state;

  console.log("[2] 连续几轮都在 opus 上，不重复推");
  r = decide(s, { type: "model", actual: "claude-opus-5", requested, turnId: "t3" });
  check("同一段掉档，第二轮不推", r.alert === null);
  s = r.state;
  r = decide(s, { type: "model", actual: "claude-opus-5", requested, turnId: "t4" });
  check("第三轮也不推", r.alert === null);
  s = r.state;

  console.log("[3] 回到请求的模型，推一次「回来了」");
  r = decide(s, { type: "model", actual: "claude-fable-5", requested, turnId: "t5" });
  check("回来了，推 fallback_recovery", r.alert && r.alert.kind === "fallback_recovery");
  check("状态回到 normal", r.state.modelStatus === "normal");
  s = r.state;
  r = decide(s, { type: "model", actual: "claude-fable-5", requested, turnId: "t6" });
  check("之后正常轮不再吭声", r.alert === null);

  console.log("[4] 额度用完那道闸：跟模型比较是两回事");
  r = decide(s, { type: "session_limit", turnId: "t7", text: "You've hit your session limit" });
  check("第一次额度用完，推一次", r.alert && r.alert.kind === "session_limit");
  s = r.state;
  r = decide(s, { type: "session_limit", turnId: "t8", text: "You've hit your session limit" });
  check("没恢复之前不重复推", r.alert === null);
  s = r.state;
  r = decide(s, { type: "model", actual: "claude-fable-5", requested, turnId: "t9" });
  check("真答上来一次，额度闸复位（内部状态，不对外推）", r.state.sessionLimitAlerted === false);
})();

(() => {
  console.log("[5] resolveRequestedModel：sessions.json 优先，读不到退回 fallbackModel");
  const dir = tmpDir("sessions-");
  const sessionsFile = path.join(dir, "sessions.json");
  writeSessions(sessionsFile, { bindingKey: "b1", workspaceRoot: "/ws", model: "claude-opus-5[1m]" });

  check("sessions.json 里有就读它，不管 fallbackModel 是什么",
    resolveRequestedModel({ sessionsFile, bindingKey: "b1", workspaceRoot: "/ws", fallbackModel: "claude-fable-5[1m]" })
      === "claude-opus-5[1m]");
  check("bindingKey 对不上就退回 fallback",
    resolveRequestedModel({ sessionsFile, bindingKey: "别的", workspaceRoot: "/ws", fallbackModel: "claude-fable-5[1m]" })
      === "claude-fable-5[1m]");
  check("workspaceRoot 对不上也退回 fallback",
    resolveRequestedModel({ sessionsFile, bindingKey: "b1", workspaceRoot: "/别的", fallbackModel: "claude-fable-5[1m]" })
      === "claude-fable-5[1m]");
  check("文件压根不存在，退回 fallback、不抛",
    resolveRequestedModel({ sessionsFile: path.join(dir, "没有这个文件.json"), bindingKey: "b1", workspaceRoot: "/ws", fallbackModel: "claude-fable-5[1m]" })
      === "claude-fable-5[1m]");
  fs.writeFileSync(sessionsFile, "不是 json{{{");
  check("文件坏了（不是 JSON），退回 fallback、不抛",
    resolveRequestedModel({ sessionsFile, bindingKey: "b1", workspaceRoot: "/ws", fallbackModel: "claude-fable-5[1m]" })
      === "claude-fable-5[1m]");
  check("什么都没给，退回空字符串（decide 那头会安静跳过）",
    resolveRequestedModel({}) === "");
})();

(() => {
  console.log("[6] makeModelFallbackAlert：有状态的那层 + 假 notify（固定 fallbackModel，模拟老逻辑）");
  const dir = tmpDir("alert-");
  const stateFile = path.join(dir, "state.json");
  const sent = [];
  const requested = "claude-fable-5[1m]";
  const alerter = makeModelFallbackAlert({
    getSessionsFile: () => "", fallbackModel: requested, stateFile, notify: (t) => sent.push(t),
  });

  alerter.onModelObserved({ actual: "claude-fable-5", turnId: "a1" });
  check("正常 fable 轮，一条都没推", sent.length === 0);

  alerter.onModelObserved({ actual: "claude-opus-5", turnId: "a2" });
  check("掉档推了一条", sent.length === 1);
  check("消息里带了请求/实际模型", sent[0].includes("claude-fable-5[1m]") && sent[0].includes("claude-opus-5"));
  check("消息里带了 turn id", sent[0].includes("a2"));

  alerter.onModelObserved({ actual: "claude-opus-5", turnId: "a3" });
  alerter.onModelObserved({ actual: "claude-opus-5", turnId: "a4" });
  check("连续 opus 轮不重复推", sent.length === 1);

  alerter.onModelObserved({ actual: "claude-fable-5", turnId: "a5" });
  check("回到 fable 推了第二条", sent.length === 2);
  check("第二条是「回来了」", sent[1].includes("回到") || sent[1].includes("Fable") || sent[1].includes("回来"));

  console.log("[7] 合成回复、含 session limit 文案 → 单独一条提醒");
  alerter.onReplyObserved({ genuine: false, text: "You’ve hit your session limit for this session.", turnId: "a6" });
  check("额度用完推了一条", sent.length === 3);
  check("标了是 session limit 不是掉档", sent[2].includes("额度") && !sent[2].includes("掉档了"));

  console.log("[8] 普通合成回复（不是额度用完文案）不触发额度提醒");
  alerter.onReplyObserved({ genuine: false, text: "Fable 5's safeguards flagged this message", turnId: "a7" });
  check("不是 session limit 文案，不推", sent.length === 3);

  console.log("[9] 重启：状态从磁盘读回来，同一段掉档不会再推一遍");
  alerter.onModelObserved({ actual: "claude-opus-5", turnId: "a8" });
  check("新一段掉档，推了第 4 条", sent.length === 4);
  const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  check("落盘的状态是 fallback", raw.modelStatus === "fallback");

  const sent2 = [];
  const restarted = makeModelFallbackAlert({ getSessionsFile: () => "", fallbackModel: requested, stateFile, notify: (t) => sent2.push(t) });
  restarted.onModelObserved({ actual: "claude-opus-5", turnId: "a9" });
  check("重启后读到 fallback 状态，同一段不再推", sent2.length === 0);
  restarted.onModelObserved({ actual: "claude-fable-5", turnId: "a10" });
  check("重启后照样能推「回来了」", sent2.length === 1);
})();

(() => {
  console.log("[10] 请求模型现读 sessions.json：她主动切模型不该被当成掉档");
  const dir = tmpDir("live-model-");
  const sessionsFile = path.join(dir, "sessions.json");
  const stateFile = path.join(dir, "state.json");
  const bindingKey = "b1", workspaceRoot = "/root/nova";
  writeSessions(sessionsFile, { bindingKey, workspaceRoot, model: "claude-fable-5[1m]" });
  const sent = [];
  const alerter = makeModelFallbackAlert({
    getSessionsFile: () => sessionsFile, bindingKey, workspaceRoot,
    fallbackModel: "claude-fable-5[1m]", stateFile, notify: (t) => sent.push(t),
  });

  alerter.onModelObserved({ actual: "claude-fable-5", turnId: "b1" });
  check("请求 fable、答的也是 fable，不吭声", sent.length === 0);

  alerter.onModelObserved({ actual: "claude-opus-5", turnId: "b2" });
  check("没人切过模型，安全层/容量把他路由去了 opus —— 这是真掉档，推了", sent.length === 1);
  check("状态记成 fallback", alerter._state().modelStatus === "fallback");

  console.log("[10a] 她 /model 切到 opus（正好是当前 fallback 那个）：sessions.json 先变，onModelCommand 悄悄收，不推");
  writeSessions(sessionsFile, { bindingKey, workspaceRoot, model: "claude-opus-5[1m]" });
  alerter.onModelCommand({ toModel: "claude-opus-5[1m]" });
  check("onModelCommand 之后状态回到 normal", alerter._state().modelStatus === "normal");
  check("没有多推一条", sent.length === 1);

  console.log("[10b] /model 切到 opus 后，opus 答一轮 —— 请求的就是 opus 了，不该报");
  alerter.onModelObserved({ actual: "claude-opus-5", turnId: "b3" });
  check("opus 答 opus，正常轮，不推", sent.length === 1);
  check("状态还是 normal", alerter._state().modelStatus === "normal");

  console.log("[10c] 她又 /model 切回 fable（这会儿不在掉档段，onModelCommand 什么都不用做）");
  writeSessions(sessionsFile, { bindingKey, workspaceRoot, model: "claude-fable-5[1m]" });
  alerter.onModelCommand({ toModel: "claude-fable-5[1m]" });
  check("不在掉档段，onModelCommand 空手而归，状态没变", alerter._state().modelStatus === "normal");
  check("没有推消息", sent.length === 1);

  console.log("[10d] 切回 fable 之后，opus 又答了一轮 —— 这是新一段真掉档，要报");
  alerter.onModelObserved({ actual: "claude-opus-5", turnId: "b4" });
  check("请求变回 fable、答的是 opus，重新推了", sent.length === 2);
  check("消息里是「请求 fable → 实际 opus」这段新的", sent[1].includes("claude-fable-5[1m]") && sent[1].includes("claude-opus-5") && sent[1].includes("b4"));
  check("状态又进了 fallback", alerter._state().modelStatus === "fallback");
})();

(() => {
  console.log("[11] onModelCommand：不在掉档段时不动，切到的不是当前 actual 时也不动");
  const dir = tmpDir("cmd-");
  const stateFile = path.join(dir, "state.json");
  const sent = [];
  const alerter = makeModelFallbackAlert({ getSessionsFile: () => "", fallbackModel: "claude-fable-5[1m]", stateFile, notify: (t) => sent.push(t) });

  alerter.onModelCommand({ toModel: "claude-opus-5[1m]" });
  check("一开始就是 normal，命令不动它", alerter._state().modelStatus === "normal" && sent.length === 0);

  alerter.onModelObserved({ actual: "claude-opus-5", turnId: "c1" });
  check("掉档了", alerter._state().modelStatus === "fallback" && sent.length === 1);

  alerter.onModelCommand({ toModel: "claude-sonnet-4-5[1m]" });
  check("切到的不是当前 actual（opus），不悄悄收", alerter._state().modelStatus === "fallback");
})();

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
