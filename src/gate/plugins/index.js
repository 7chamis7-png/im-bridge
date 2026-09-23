"use strict";

/**
 * Plugin loader: adding a channel ("leg") never requires touching the core.
 *
 * Each plugin module describes itself: its name, the config keys it needs,
 * and how to construct it. The core only scans this directory.
 *
 * ```js
 * // src/gate/plugins/qq.js
 * class QQPlugin { … }                       // receive/send details live here only
 * module.exports = { QQPlugin };
 * module.exports.leg = {
 *   name: "qq",                              // channel name, one per channel
 *   slot: "qq",                              // buildGate slot (defaults to name)
 *   configKeys: [["GATE_QQ_TOKEN", "QQ bot token"]],   // reported by name when missing
 *   poll: { idleMs: 2000 },                  // omit for long-polling legs
 *   make({ env, log }) { return new QQPlugin({ token: env.GATE_QQ_TOKEN, log }); },
 * };
 * ```
 *
 * Enable/disable rule (no allow-list):
 *   plugin file present AND all its configKeys set  ->  attached automatically
 *
 * To disable: delete the file, clear its config, or set `GATE_LEG_<NAME>=off`.
 * The core never knows plugin-specific variable names; missing keys are
 * reported explicitly instead of guessed.
 */

const fs = require("fs");
const path = require("path");

/** Scan the directory and collect every module exporting `leg`. A broken one never blocks the rest. */
function discoverLegs({ dir = __dirname, log = () => {} } = {}) {
  const byName = new Map();
  const errors = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return { byName, errors: [{ file: dir, why: "读不到插头目录：" + e.message }] };
  }

  for (const ent of entries) {
    const isDir = ent.isDirectory();
    const file = isDir ? path.join(dir, ent.name, "index.js") : path.join(dir, ent.name);
    if (!isDir && (!ent.name.endsWith(".js") || ent.name === "index.js")) continue;
    if (isDir && !fs.existsSync(file)) continue;

    let mod = null;
    try { mod = require(file); }
    catch (e) {
      errors.push({ file: ent.name, why: "require 炸了：" + ((e && e.message) || e) });
      log("[插头] 装不上 " + ent.name + "：" + ((e && e.message) || e));
      continue;
    }
    const leg = mod && mod.leg;
    if (!leg) continue;                       // modules without `leg` are helpers, not plugins

    const why = validateLeg(leg);
    if (why) {
      errors.push({ file: ent.name, why });
      log("[插头] 装不上 " + ent.name + "：" + why);
      continue;
    }
    if (byName.has(leg.name)) {
      errors.push({ file: ent.name, why: "渠道名撞车：" + leg.name });
      continue;
    }
    byName.set(leg.name, { ...leg, file: ent.name });
  }
  return { byName, errors };
}

function validateLeg(leg) {
  const name = String((leg && leg.name) || "").trim();
  if (!name) return "没有 name";
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return "渠道名只能是小写字母数字连字符：" + name;
  if (typeof leg.make !== "function") return "没有 make()，桥不知道怎么造它";
  if (leg.configKeys && !Array.isArray(leg.configKeys)) return "configKeys 要是数组";
  return "";
}

/**
 * Build every leg that is present and fully configured.
 *
 * @returns {{legs: object[], idle: object[], errors: object[]}}
 *   legs  = [{ name, slot, plugin, poll }]   attached
 *   idle  = [{ name, lacks }]                 present but not attached (missing config / disabled / failed to build)
 */
function loadLegs({ env = process.env, log = () => {}, dir = __dirname } = {}) {
  const { byName, errors } = discoverLegs({ dir, log });
  const legs = [];
  const idle = [];

  for (const [name, leg] of byName) {
    // explicit off switch, without deleting the file
    const off = String(env["GATE_LEG_" + name.toUpperCase().replace(/-/g, "_")] || "")
      .trim().toLowerCase();
    if (off === "off" || off === "0" || off === "false") {
      idle.push({ name, lacks: [], why: "配置里关掉了" });
      continue;
    }

    const lacks = (leg.configKeys || []).filter(([k]) => !String(env[k] || "").trim());
    if (lacks.length) {
      // nothing set = leg not wanted, skip quietly; partially set = probably a mistake, warn
      const filled = (leg.configKeys || []).length - lacks.length;
      idle.push({ name, lacks, why: filled ? "配置只填了一半" : "没配置" });
      if (filled) log("[插头] " + name + " 配置只填了一半，缺：" + lacks.map(([k]) => k).join(" "));
      continue;
    }

    let plugin = null;
    try { plugin = leg.make({ env, log }); }
    catch (e) {
      idle.push({ name, lacks: [], why: "造不出来：" + ((e && e.message) || e) });
      log("[插头] " + name + " 造不出来：" + ((e && e.message) || e));
      continue;
    }
    legs.push({ name, slot: leg.slot || name, plugin, poll: leg.poll || null });
  }

  return { legs, idle, available: [...byName.keys()], errors };
}

module.exports = { loadLegs, discoverLegs, validateLeg };
