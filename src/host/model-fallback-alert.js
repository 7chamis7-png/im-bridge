"use strict";

/**
 * 掉档提醒 —— Nova被 Claude Code 悄悄换成别的模型时，推一条给Alice（2026-09-21）
 *
 * **这个文件不属于桥**（住在 `src/host/`）。桥（`src/gate/`）不认识 telegram token、
 * 不认识「掉档」是什么意思 —— 它只看得到「这一轮谁答的」；说不说、说给谁，是宿主的事
 * （跟 `watch.js` 那条「说什么、说给谁，宿主决定」同一条规矩）。
 *
 * ## 老桥怎么干的
 *
 * `fable-guard`（现在停了，记忆 `project-fable-guard`）是个独立 pm2 进程，
 * 每 30 秒轮一次 transcript 文件，倒着找最后一条带 model 的 assistant 消息、
 * 跟目标模型比。新桥不用再起一个进程去猜 —— 盒子本来就会在每轮结束时推一份
 * `state`（含实测模型，见 `gate-box-claudecode.js` 的 `readActualFacts`：
 * 只认 transcript 里 message.model，跳过 `<synthetic>` 那种壳）。这个文件挂在
 * 桥已有的 `box.onTurnDone` / `box.onReply` 上，一轮结束顺手看一眼，不用轮询。
 *
 * ## 两种「不对」，两条独立的闸
 *
 * 1. **掉档**：这一轮真答上来了，但答的模型不是请求的那个
 *   （`GATE_MODEL`，比如 `claude-fable-5[1m]`）——多半是容量满了被路由到 Opus，
 *   或者安全层拒答之后 Claude Code 自动切到 fallback 模型重答了一次。
 *   两种原因**从这层看不出区别**（Claude Code 不吐理由字段，`box-runtime.js`
 *   那行 `fallback=` 也是写死的 true，帮不上忙——2026-09-21 这条提醒本身
 *   就是照实说「看不出来」，不瞎猜）。
 * 2. **额度用完**：这一轮压根没有真实模型答话，CLI 自己造了一条
 *   `<synthetic>` 消息（`session limit` 那种）。这跟「换了个模型答」是两回事——
 *   没有模型可比，所以单独一条闸，判据是那条合成消息的文字。
 *
 * ## 防刷屏
 *
 * 「掉档」是一段（episode）不是一个点：进 fallback 只推一次，之后连续几轮都在
 * fallback 模型上**不重复推**，回到请求的模型才推一次「回来了」。状态落一份小
 * json（`GATE_ROOT` 底下），桥重启不会把这段当新的又推一遍。
 *
 * ## 绝不挡这一轮
 *
 * `notify` 失败只记日志，`onModelObserved` / `onReplyObserved` 内部整个包在
 * try/catch 里（挂到 `box.onTurnDone` 上的回调如果抛，box-remote 会当这条没处理完、
 * 不划账、下次重连还补一遍——这跟「掉档提醒」这种锦上添花的功能完全不该沾边）。
 *
 * ## 「请求的模型」不是一个写死的值（2026-09-21 审出来的）
 *
 * 一开始这儿直接拿 `GATE_MODEL` 当「请求的模型」——但她会用 TG `/model` 热切模型
 * （`gate-commands-claudecode.js:74` → `runtime.setModelForWorkspace` →
 * `SessionStore.setRuntimeParamsForWorkspace`，写进 `sessions.json`，**不改
 * `GATE_MODEL`、也不用重启**）。`runtime.describe().model` 报的只是启动时那份配置，
 * 不随 `/model` 变。原来的写法会把她自己手动切到 Opus 当成「掉档」，每一轮都报。
 *
 * 改成动态读：每次比对都从 `sessions.json`（路径来自盒子快照 `describe().sessionsFile`）
 * 里当前 `bindingKey` + `workspaceRoot` 的 runtime params 现读一次，读不到
 * （文件没有 / 没这一条 / 解析失败）才退回 `GATE_MODEL`。读文件失败**不许挡轮**——
 * 拿不到就当「不知道请求的是谁」，`decide()` 自己会安静跳过，不瞎报。
 *
 * 另外一种情况：她正处在掉档段里，手动 `/model` 切到的正好是当前实际在用的那个
 * fallback 模型——这不是「回来了」，是她自己认下了这个模型，**不该推一条恢复提醒**
 * （那条提醒暗示的是「他自己跳回来了」，跟她的主动选择是两件事）。这种切换靠
 * `onModelCommand` 悄悄把 episode 收回 `normal`，不经过 `notify`。
 */

const fs = require("fs");
const path = require("path");
const { agentAlertName } = require("../core/names");

/** 额度用完那条合成消息的文字判据。大小写不敏感，撇号用 `.` 兜住直引号/弯引号两种写法。 */
const SESSION_LIMIT_RE = /you.?ve\s+hit\s+your\s+session\s+limit/i;

/**
 * 模型名对齐：去掉上下文窗口后缀。
 *
 * `GATE_MODEL` / `GATE_FALLBACK_MODEL` 那种配置带 `[1m]` 后缀，但 transcript
 * 里 `message.model` 读出来的是不带后缀的裸名（`claude-fable-5`）。不脱这层后缀，
 * 每一轮都会被判成「掉档」——这是这份文件唯一需要知道的 claude 特有知识。
 */
function bareModel(m) {
  return String(m || "").trim().replace(/\[[^\]]*\]$/, "");
}

/**
 * 「请求的模型」现读一次 —— 不用 `SessionStore` 那个类（它的构造函数会
 * `mkdirSync`，这儿只想读一眼，连目录都不该碰，更别说建）。磁盘格式照抄
 * `session-store.js` 文件头那段注释：
 *   `bindings[key].runtimeParamsByWorkspaceRootByRuntime.<runtimeId>[workspaceRoot].model`
 *
 * 读不到（文件不存在 / 没这一条 / 解析失败）就退回 `fallbackModel`（`GATE_MODEL`）。
 * **不抛**——这不该挡住这一轮的判断，宁可比不出来，不许把读文件失败变成故障。
 *
 * @param {object} o
 * @param {string} o.sessionsFile
 * @param {string} o.bindingKey
 * @param {string} o.workspaceRoot
 * @param {string} [o.runtimeId]      跟 `SessionStore` 默认值一致
 * @param {string} [o.fallbackModel]  读不到时退回的（一般是 `GATE_MODEL`）
 * @returns {string}
 */
function resolveRequestedModel({ sessionsFile, bindingKey, workspaceRoot, runtimeId = "claudecode", fallbackModel = "" } = {}) {
  try {
    if (sessionsFile && bindingKey && workspaceRoot) {
      const raw = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
      const m = raw && raw.bindings && raw.bindings[bindingKey]
        && raw.bindings[bindingKey].runtimeParamsByWorkspaceRootByRuntime
        && raw.bindings[bindingKey].runtimeParamsByWorkspaceRootByRuntime[runtimeId]
        && raw.bindings[bindingKey].runtimeParamsByWorkspaceRootByRuntime[runtimeId][workspaceRoot]
        && raw.bindings[bindingKey].runtimeParamsByWorkspaceRootByRuntime[runtimeId][workspaceRoot].model;
      if (typeof m === "string" && m.trim()) return m.trim();
    }
  } catch { /* 读不到就退回配置那份，见上面的函数说明 */ }
  return String(fallbackModel || "").trim();
}

/**
 * 纯归约：喂一个观测，吐新状态 + 要不要推、推什么。**不碰 fs / 网络**，
 * 好测（测试直接喂状态、喂观测，断言吐出来的东西，不用起进程）。
 *
 * @param {{modelStatus:"normal"|"fallback", lastActual:string, sessionLimitAlerted:boolean}} state
 * @param {object} obs  `{type:"model", actual, requested, turnId, at}` 或
 *                       `{type:"session_limit", turnId, text, at}`
 * @returns {{state:object, alert:null|object}}
 */
function decide(state, obs) {
  const s = {
    modelStatus: state.modelStatus === "fallback" ? "fallback" : "normal",
    lastActual: String(state.lastActual || ""),
    sessionLimitAlerted: !!state.sessionLimitAlerted,
  };

  if (obs && obs.type === "model") {
    const reqN = bareModel(obs.requested);
    const actN = bareModel(obs.actual);
    // 看不出请求的是谁、或这一轮压根没读到实测模型 —— 不吭声，别瞎比
    if (!reqN || !actN) return { state: s, alert: null };

    // 真答上来了，说明额度用完那道闸这会儿显然是过的 —— 复位，下次再卡住会重新推
    s.sessionLimitAlerted = false;

    if (actN === reqN) {
      if (s.modelStatus === "fallback") {
        const prevActual = s.lastActual;
        s.modelStatus = "normal";
        s.lastActual = "";
        return { state: s, alert: { kind: "fallback_recovery", actual: obs.actual,
          requested: obs.requested, prevActual, turnId: obs.turnId, at: obs.at } };
      }
      return { state: s, alert: null };                 // 一直在请求的模型上，没什么可说的
    }

    // 答的不是请求的那个模型
    if (s.modelStatus !== "fallback") {
      s.modelStatus = "fallback";
      s.lastActual = obs.actual;
      return { state: s, alert: { kind: "fallback_start", actual: obs.actual,
        requested: obs.requested, turnId: obs.turnId, at: obs.at } };
    }
    s.lastActual = obs.actual;                           // 还在掉档段里（哪怕换了个 fallback 型号），沉默
    return { state: s, alert: null };
  }

  if (obs && obs.type === "session_limit") {
    if (s.sessionLimitAlerted) return { state: s, alert: null };
    s.sessionLimitAlerted = true;
    return { state: s, alert: { kind: "session_limit", turnId: obs.turnId, text: obs.text, at: obs.at } };
  }

  return { state: s, alert: null };
}

/** 北京时间戳，跟桥其余日志一个格式（`main.js` 顶上那个 `defaultLog`）。 */
function beijingStamp(atMs) {
  const d = new Date((Number(atMs) || Date.now()) + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 19).replace("T", " ") + " 京时";
}

/** 把 alert 变成给Alice看的中文。 */
function composeAlertText(alert) {
  const stamp = beijingStamp(alert.at);
  const turnLine = alert.turnId ? "\nturn " + alert.turnId : "";
  if (alert.kind === "fallback_start") {
    return "⚠️ " + agentAlertName() + "掉档了\n" + stamp
      + "\n请求 " + (alert.requested || "?") + " → 实际 " + (alert.actual || "?")
      + "\n原因：不确定（容量高峰 / 安全层拦截都有可能，Claude Code 没给理由字段）"
      + turnLine;
  }
  if (alert.kind === "fallback_recovery") {
    return "✅ " + agentAlertName() + "回到 " + (alert.requested || "请求的模型") + " 了\n" + stamp
      + "\n" + (alert.prevActual || "?") + " → " + (alert.actual || "?")
      + turnLine;
  }
  if (alert.kind === "session_limit") {
    return "🈳 " + agentAlertName() + "这一轮额度用完了\n" + stamp
      + "\n（session limit，不是模型掉档，是账号额度到顶——回滚/换模型都治不了，得等额度或换账号）"
      + turnLine;
  }
  return "";
}

function loadState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      modelStatus: raw.modelStatus === "fallback" ? "fallback" : "normal",
      lastActual: String(raw.lastActual || ""),
      sessionLimitAlerted: !!raw.sessionLimitAlerted,
    };
  } catch { return { modelStatus: "normal", lastActual: "", sessionLimitAlerted: false }; }
}

function saveState(file, state, log) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({
      schema: "im-bridge.model-fallback-alert.v1",
      ...state,
      updatedAt: new Date().toISOString(),
    }, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    // 存不了就下次再存 —— 这不该拖累这一轮（见文件头「绝不挡这一轮」）
    log("[掉档提醒] 状态存不下去（下次再试）：" + ((e && e.message) || e));
  }
}

/**
 * 挂一个掉档提醒器。**只推不动**（跟 `watch.js` 同一条规矩：决定权在人，
 * 这东西只会说话）。
 *
 * @param {object} o
 * @param {function} [o.getSessionsFile]  () => sessions.json 的路径（来自盒子快照
 *   `runtime.describe().sessionsFile`）。不给 / 读不到就整个退化成只认 `fallbackModel`。
 * @param {string} [o.bindingKey]      `GATE_BINDING_KEY`
 * @param {string} [o.workspaceRoot]   `GATE_WORKSPACE_ROOT`
 * @param {string} [o.runtimeId]       跟 `SessionStore` 默认值一致（"claudecode"）
 * @param {string} [o.fallbackModel]   sessions.json 里读不到时退回的（`GATE_MODEL`）
 * @param {string} o.stateFile         episode 状态落哪 —— 重启不重新推靠它
 * @param {function} o.notify          (text) => any。说给谁是宿主的事，这里不认识 telegram
 * @param {function} [o.log]
 */
function makeModelFallbackAlert({ getSessionsFile = () => "", bindingKey = "", workspaceRoot = "",
  runtimeId = "claudecode", fallbackModel = "", stateFile, notify, log = () => {} } = {}) {
  if (!String(stateFile || "").trim()) throw new Error("掉档提醒要一份落盘文件，不然桥一重启就把同一段掉档再推一遍");
  if (typeof notify !== "function") throw new Error("掉档提醒要一个 notify（说给谁是宿主的事）");

  let state = loadState(stateFile);

  function currentRequested() {
    let sessionsFile = "";
    try { sessionsFile = (typeof getSessionsFile === "function" ? getSessionsFile() : getSessionsFile) || ""; }
    catch { sessionsFile = ""; }
    return resolveRequestedModel({ sessionsFile, bindingKey, workspaceRoot, runtimeId, fallbackModel });
  }

  function fire(alert) {
    saveState(stateFile, state, log);
    try { notify(composeAlertText(alert)); }
    catch (e) { log("[掉档提醒] 推送失败（不挡这一轮）：" + ((e && e.message) || e)); }
  }

  return {
    /** 一段合成回复。只关心「像不像额度用完」——真判定归 `decide`。 */
    onReplyObserved({ genuine, text, turnId, at } = {}) {
      try {
        if (genuine !== false) return;
        if (!SESSION_LIMIT_RE.test(String(text || ""))) return;
        const r = decide(state, { type: "session_limit", turnId, text, at });
        state = r.state;
        if (r.alert) fire(r.alert); else saveState(stateFile, state, log);
      } catch (e) { log("[掉档提醒] onReplyObserved 出错（不挡这一轮）：" + ((e && e.message) || e)); }
    },
    /** 这一轮真答上来了，报一下实测模型。请求的模型现读一次（见文件头「不是一个写死的值」）。 */
    onModelObserved({ actual, turnId, at } = {}) {
      try {
        const requested = currentRequested();
        const r = decide(state, { type: "model", actual, requested, turnId, at });
        state = r.state;
        if (r.alert) fire(r.alert); else saveState(stateFile, state, log);
      } catch (e) { log("[掉档提醒] onModelObserved 出错（不挡这一轮）：" + ((e && e.message) || e)); }
    },
    /**
     * `/model` 命令切换（跟盒子的实测轮次无关，是她自己动的手）。
     *
     * 只处理一种情况：正处于掉档段、她切到的正好是当前实际在用的那个 fallback
     * 模型——这是「她认下了」，不是「他自己跳回来了」，**悄悄收状态，不 notify**。
     * 其余情况（不在掉档段 / 切到的不是当前 actual）不动 —— 该报还是靠下一轮
     * `onModelObserved` 的正常比对（`sessions.json` 已经先一步被 `/model` 写过了）。
     */
    onModelCommand({ toModel } = {}) {
      try {
        const toN = bareModel(toModel);
        if (!toN) return;
        if (state.modelStatus === "fallback" && bareModel(state.lastActual) === toN) {
          state = { modelStatus: "normal", lastActual: "", sessionLimitAlerted: state.sessionLimitAlerted };
          saveState(stateFile, state, log);
        }
      } catch (e) { log("[掉档提醒] onModelCommand 出错（不挡这次切换）：" + ((e && e.message) || e)); }
    },
    /** 测试 / 体检用：看一眼现在的状态。 */
    _state: () => ({ ...state }),
  };
}

module.exports = {
  bareModel, decide, composeAlertText, beijingStamp, resolveRequestedModel,
  makeModelFallbackAlert, SESSION_LIMIT_RE,
};
