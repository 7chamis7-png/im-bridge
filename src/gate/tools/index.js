"use strict";

/**
 * 工具插件加载器（2026-09-18）
 *
 * 扫目录、把每个 .js 当一个工具收进来。**桥不枚举工具名**（铁律 2/3）：
 * 加一个工具就是加一个文件，这里和核心都一行不用改。
 *
 * 坏插件不许拖垮整包：单个文件 require 炸了就跳过它、大声说，其余照常加载。
 * 这跟「白名单为空 = 一条都不放行」是两回事 —— 那是安全边界，这是加载容错。
 */

const fs = require("fs");
const path = require("path");

/** 一个插件至少要说清楚：叫什么、干什么、怎么干（intent 或 handler 二选一）。 */
function validate(mod, file) {
  const name = String((mod && mod.name) || "").trim();
  if (!name) return "没有 name";
  if (!/^[a-z][a-z0-9_]*$/.test(name)) return "name 只能是小写字母数字下划线：" + name;
  if (!String((mod && mod.description) || "").trim()) return "没有 description（他看不懂什么时候该用）";
  const hasIntent = Boolean(mod.intent);
  const hasHandler = typeof mod.handler === "function";
  if (!hasIntent && !hasHandler) return "既没有 intent 也没有 handler，不知道要干嘛";
  if (hasIntent && hasHandler) return "intent 和 handler 只能有一个：投递归出闸，别自己发";
  // 工具名是意图不是地址 —— 挡住 telegram_reply 这类名字重新长出来
  for (const w of ["telegram", "wechat", "weixin", "imessage", "qq"]) {
    if (name.includes(w)) return "工具名里不许带渠道（" + w + "）—— 名字是意图，地址走 channel 参数";
  }
  return "";
}

/**
 * @param {object} [o]
 * @param {string} [o.dir] 插件目录，默认就是本目录
 * @param {function} [o.log]
 * @returns {{byName: Map<string, object>, list: object[], errors: object[]}}
 */
function loadTools({ dir = __dirname, log = () => {} } = {}) {
  const byName = new Map();
  const errors = [];
  let files = [];
  try {
    // index.js 是加载器本身，mcp-server.js 是那层壳 —— 都不是工具
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
