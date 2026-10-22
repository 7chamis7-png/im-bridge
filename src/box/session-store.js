// 会话存储 —— 「这条绑定现在接哪一条会话、跑哪个模型」，就这两件事。
//
// 2026-09-20 重写。老的那份是原作者的（src/adapters/runtime/codex/session-store.js，415 行），
// 里面 codex 的双份键、模型目录、审批白名单我们一个都不用，还拖着 model-catalog /
// approval-command 两个要扔的文件。这份只留新桥真正调的 6 个方法。
//
// ⚠️ **磁盘格式一个字节都没改**（sessions.json 照旧）：
//    bindings[key].threadIdByWorkspaceRootByRuntime.claudecode[workspaceRoot] = 会话号
//    bindings[key].runtimeParamsByWorkspaceRootByRuntime.claudecode[workspaceRoot] = { model, modelProvider }
//    不认识的字段（origin / requestId / inboxIds / 顶层那几个）原样读进来原样写回去 ——
//    格式一变就等于把他接回一条不存在的会话。
const fs = require("fs");
const path = require("path");

const str = (v) => (typeof v === "string" ? v.trim() : "");

class SessionStore {
  constructor({ filePath, runtimeId = "claudecode" }) {
    this.filePath = filePath;
    this.runtimeId = str(runtimeId) || "default";
    this.state = { bindings: {} };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (parsed && typeof parsed === "object") {
        this.state = { ...parsed, bindings: parsed.bindings || {} };
      }
    } catch {
      this.state = { bindings: {} };
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  getBinding(bindingKey) {
    return this.state.bindings[bindingKey] || null;
  }

  listBindings() {
    return Object.entries(this.state.bindings || {}).map(([bindingKey, binding]) => ({
      bindingKey,
      ...(binding || {}),
    }));
  }

  updateBinding(bindingKey, nextBinding) {
    this.state.bindings[bindingKey] = {
      ...(this.state.bindings[bindingKey] || {}),
      ...(nextBinding || {}),
    };
    this.save();
    return this.state.bindings[bindingKey];
  }

  // —— 会话号 ——
  getThreadIdForWorkspace(bindingKey, workspaceRoot) {
    const ws = str(workspaceRoot);
    if (!ws) return "";
    const map = this.getBinding(bindingKey)?.threadIdByWorkspaceRootByRuntime?.[this.runtimeId] || {};
    return str(map[ws]);
  }

  setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, extra = {}) {
    const ws = str(workspaceRoot);
    if (!ws) return this.getBinding(bindingKey);
    const current = this.getBinding(bindingKey) || {};
    return this.updateBinding(bindingKey, {
      ...extra,
      activeWorkspaceRoot: ws,
      threadIdByWorkspaceRootByRuntime: {
        ...(current.threadIdByWorkspaceRootByRuntime || {}),
        [this.runtimeId]: {
          ...(current.threadIdByWorkspaceRootByRuntime?.[this.runtimeId] || {}),
          [ws]: str(threadId),
        },
      },
    });
  }

  clearThreadIdForWorkspace(bindingKey, workspaceRoot) {
    // 清成空串而不是删键：换舱后下一轮照样从这儿读，少一个「键在不在」的分支。
    return this.setThreadIdForWorkspace(bindingKey, workspaceRoot, "");
  }

  // —— 模型 ——
  getRuntimeParamsForWorkspace(bindingKey, workspaceRoot) {
    const ws = str(workspaceRoot);
    if (!ws) return { model: "", modelProvider: "" };
    const entry = this.getBinding(bindingKey)?.runtimeParamsByWorkspaceRootByRuntime?.[this.runtimeId]?.[ws] || {};
    return { model: str(entry.model), modelProvider: str(entry.modelProvider) };
  }

  setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, params = {}) {
    const ws = str(workspaceRoot);
    if (!ws) return this.getBinding(bindingKey);
    const current = this.getBinding(bindingKey) || {};
    const byRuntime = current.runtimeParamsByWorkspaceRootByRuntime || {};
    const previous = byRuntime[this.runtimeId]?.[ws] || {};
    // 只给 model 就别把 modelProvider 抹了（/model 热切换走的就是这条）
    const next = {
      ...previous,
      model: "model" in params ? str(params.model) : str(previous.model),
      modelProvider: "modelProvider" in params ? str(params.modelProvider) : str(previous.modelProvider),
    };
    return this.updateBinding(bindingKey, {
      runtimeParamsByWorkspaceRootByRuntime: {
        ...byRuntime,
        [this.runtimeId]: { ...(byRuntime[this.runtimeId] || {}), [ws]: next },
      },
    });
  }

  setActiveWorkspaceRoot(bindingKey, workspaceRoot) {
    const ws = str(workspaceRoot);
    if (!ws) return this.getBinding(bindingKey);
    return this.updateBinding(bindingKey, { activeWorkspaceRoot: ws });
  }

  getActiveWorkspaceRoot(bindingKey) {
    return str(this.getBinding(bindingKey)?.activeWorkspaceRoot);
  }
}

module.exports = { SessionStore };
