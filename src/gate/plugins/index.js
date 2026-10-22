"use strict";

/**
 * 插头加载器（2026-09-18）—— **加一条腿不用拆桥**
 *
 * Alice：「加 qq 为什么要改核心代码」。原来每加一条腿，`src/host/main.js` 要动四处：
 * `new` 一个、读它那几个配置、传进 buildGate、挂上主循环。那就是拆主板焊插孔。
 *
 * 现在插头自带三样：**叫什么、要哪些配置、怎么造出来**，核心只管扫目录。
 * 加 QQ = 写一个 `qq.js`、把它要的配置填上，`main.js` 一个字不动。
 *
 * ## 一个插头长什么样
 *
 * ```js
 * // src/gate/plugins/qq.js
 * class QQPlugin { … }                       // 怎么收、怎么发，只有它自己知道
 * module.exports = { QQPlugin };
 * module.exports.leg = {
 *   name: "qq",                              // 渠道名。**一个渠道一个名字**
 *   slot: "qq",                              // 装进 buildGate 的哪一格（默认同 name）
 *   configKeys: [["GATE_QQ_TOKEN", "QQ 机器人的 token"]],   // 缺了要当场说清楚
 *   poll: { idleMs: 2000 },                  // 这条腿怎么捞：不给就按长轮询走
 *   make({ env, log }) { return new QQPlugin({ token: env.GATE_QQ_TOKEN, log }); },
 * };
 * ```
 *
 * ## 插上 / 取下（Alice 2026-09-18：「不用了就取下来 用就插上」）
 *
 * **没有名单，没有开关清单。** 判据只有一条：
 *
 *   目录里有这个插头 **且** 它要的配置填齐了 → 自动接上
 *
 * - 想接 QQ：放一个 `qq.js`，把它要的几个配置填上 —— 完事
 * - 不想要了：删掉文件，或者把配置清掉，或者写 `GATE_LEG_QQ=off`
 *
 * 配置填齐**本身就是**那个明确的决定（token 不会自己长出来），所以不需要再来
 * 一份名单说"我要接哪几条" —— 那是同一件事写两遍，还会漏。
 *
 * 另一条规矩：**要哪些配置由插头自己说**，核心不认识那些变量名
 * （铁律 1：不许猜，缺了当场点名）。
 */

const fs = require("fs");
const path = require("path");

/** 扫目录，把每个带 `leg` 的插头收进来。坏的不拖垮其余。 */
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
    if (!leg) continue;                       // 没自我介绍的当它不是插头（比如共用的解码模块）

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
 * 把「目录里有 + 配置齐了」的腿都装出来。
 *
 * @returns {{legs: object[], idle: object[], errors: object[]}}
 *   legs  = [{ name, slot, plugin, poll }]   真接上的
 *   idle  = [{ name, lacks }]                 在目录里、但没插上（缺配置 / 被关掉 / 造不出来）
 */
function loadLegs({ env = process.env, log = () => {}, dir = __dirname } = {}) {
  const { byName, errors } = discoverLegs({ dir, log });
  const legs = [];
  const idle = [];

  for (const [name, leg] of byName) {
    // 显式取下：不删文件也能关掉
    const off = String(env["GATE_LEG_" + name.toUpperCase().replace(/-/g, "_")] || "")
      .trim().toLowerCase();
    if (off === "off" || off === "0" || off === "false") {
      idle.push({ name, lacks: [], why: "配置里关掉了" });
      continue;
    }

    const lacks = (leg.configKeys || []).filter(([k]) => !String(env[k] || "").trim());
    if (lacks.length) {
      // 一个都没填 = 根本没打算接这条腿，安静跳过；填了一半 = 多半是忘了，要吵
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
