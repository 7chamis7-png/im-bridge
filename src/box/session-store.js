"use strict";
// Session store — for each binding: which session it is attached to and which model it runs.
//
// On-disk format (sessions.json):
//    bindings[key].threadIdByWorkspaceRootByRuntime.<runtime>[workspaceRoot] = session id
//    bindings[key].runtimeParamsByWorkspaceRootByRuntime.<runtime>[workspaceRoot] = { model, modelProvider }
// Unknown fields are read and written back unchanged; changing the format
// would silently reattach to a session that does not exist.
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

  // —— session id ——
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
    // Clear to "" instead of deleting the key: simpler reads after rotation.
    return this.setThreadIdForWorkspace(bindingKey, workspaceRoot, "");
  }

  // —— model ——
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
    // Setting only model must not wipe modelProvider (used by /model hot switch).
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
