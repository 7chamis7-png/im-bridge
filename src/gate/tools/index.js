"use strict";

/**
 * Tool plugin loader.
 *
 * Scans this directory and loads each .js file as one tool. The bridge never
 * enumerates tool names: adding a tool means adding a file.
 *
 * A broken plugin never takes down the whole set: if one file fails to load
 * it is skipped and reported, the rest load normally (load tolerance, not a
 * security boundary).
 */

const fs = require("fs");
const path = require("path");

/** A plugin must declare its name, description and either an intent or a handler. */
function validate(mod, file) {
  const name = String((mod && mod.name) || "").trim();
  if (!name) return "没有 name";
  if (!/^[a-z][a-z0-9_]*$/.test(name)) return "name 只能是小写字母数字下划线：" + name;
  if (!String((mod && mod.description) || "").trim()) return "没有 description（agent 无法判断何时使用）";
  const hasIntent = Boolean(mod.intent);
  const hasHandler = typeof mod.handler === "function";
  if (!hasIntent && !hasHandler) return "既没有 intent 也没有 handler，不知道要干嘛";
  if (hasIntent && hasHandler) return "intent 和 handler 只能有一个：投递归出闸，别自己发";
  // tool names are intents, not addresses: reject channel names like telegram_reply
  for (const w of ["telegram", "wechat", "weixin", "imessage", "qq"]) {
    if (name.includes(w)) return "工具名里不许带渠道（" + w + "）—— 名字是意图，地址走 channel 参数";
  }
  return "";
}

/**
 * @param {object} [o]
 * @param {string} [o.dir] plugin directory (defaults to this one)
 * @param {function} [o.log]
 * @returns {{byName: Map<string, object>, list: object[], errors: object[]}}
 */
function loadTools({ dir = __dirname, log = () => {} } = {}) {
  const byName = new Map();
  const errors = [];
  let files = [];
  try {
    // index.js is the loader and mcp-server.js the MCP shell; neither is a tool
    const NOT_PLUGINS = new Set(["index.js", "mcp-server.js"]);
    files = fs.readdirSync(dir)
      .filter((f) => f.endsWith(".js") && !NOT_PLUGINS.has(f))
      .sort();
  } catch (e) {
    return { byName, list: [], errors: [{ file: dir, why: "读不到插件目录：" + e.message }] };
  }

  for (const f of files) {
    const full = path.join(dir, f);
    let mod = null;
    try {
      delete require.cache[require.resolve(full)];
      mod = require(full);
    } catch (e) {
      errors.push({ file: f, why: "require 炸了：" + ((e && e.message) || e) });
      log("[工具] 装不上 " + f + "：" + ((e && e.message) || e));
      continue;
    }
    if (mod && mod.enabled === false) continue;
    const why = validate(mod, f);
    if (why) {
      errors.push({ file: f, why });
      log("[工具] 装不上 " + f + "：" + why);
      continue;
    }
    if (byName.has(mod.name)) {
      errors.push({ file: f, why: "工具名撞车：" + mod.name });
      log("[工具] 装不上 " + f + "：名字撞车 " + mod.name);
      continue;
    }
    byName.set(mod.name, { ...mod, file: f });
  }

  return { byName, list: [...byName.values()], errors };
}

module.exports = { loadTools, validate };
