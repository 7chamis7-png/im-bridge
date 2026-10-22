"use strict";

/**
 * 面板：角色名单 + 各自的 env + 「这个角色自己的目录」。
 *
 * 数据隔离（2026-10-22 那次泄露之后的铁律）：每个角色的路径**只从它自己的 env 文件来**，
 * 这里没有任何写死的 / 默认的回落路径。env 读不到 = 那个角色报错，不猜。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { L } = require("./i18n");

/** 角色自己的「数据目录」类配置：值本身就是目录。 */
const DIR_KEYS = ["GATE_ROOT", "NOVA_STATE_DIR", "GATE_MEMORY_DIR", "GATE_WORKSPACE_ROOT"];
/** 值是文件：它所在的目录也算这个角色声明过的地盘。 */
const FILE_KEYS = ["GATE_IDENTITY_INJECTION_FILE", "GATE_COLD_FILE", "NOVA_NOTEBOOK_FILE"];

function homeDir(env = process.env) {
  return String(env.HOME || "").trim() || os.homedir();
}

/**
 * 名单：PANEL_CHARACTERS="alpha:/a/alpha-env.sh,beta:/b/beta-env.sh"；
 * 不给就扫 ~/.*-gate/*-env.sh（id = 文件名去掉 -env.sh）。
 * @returns {{id:string, envFile:string}[]}
 */
function listCharacters(env = process.env) {
  const raw = String(env.PANEL_CHARACTERS || "").trim();
  if (raw) {
    return raw.split(",").map((s) => s.trim()).filter(Boolean).map((item) => {
      const i = item.indexOf(":");
      return i > 0 ? { id: item.slice(0, i).trim(), envFile: item.slice(i + 1).trim() } : { id: item, envFile: "" };
    }).filter((c) => /^[a-z0-9][a-z0-9_-]*$/i.test(c.id));
  }
  const home = homeDir(env);
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(home, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory() || !/^\.[^.].*-gate$/.test(d.name)) continue;
    let files = [];
    try { files = fs.readdirSync(path.join(home, d.name)); } catch { continue; }
    for (const f of files.sort()) {
      const m = /^([a-z0-9][a-z0-9_-]*)-env\.sh$/i.exec(f);
      if (m) out.push({ id: m[1], envFile: path.join(home, d.name, f) });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 在干净的 bash 里 source env 文件读回来（照抄 scripts/doctor.js 的 loadEnvFile；
 * 额外：cwd 设成 /，不让面板自己的工作目录混进 PWD）。
 */
function loadEnvFile(file, baseEnv = process.env) {
  if (!file) throw new Error(L("没给 env 文件路径"));
  if (!fs.existsSync(file)) throw new Error(L("env 文件不存在：{0}", file));
  const out = execFileSync("bash", ["-c", 'set -a; . "$1" >/dev/null 2>&1; env -0', "panel", file], {
    env: { HOME: homeDir(baseEnv), PATH: baseEnv.PATH || "/usr/bin:/bin" },
    cwd: "/", encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const env = {};
  for (const kv of out.split("\0")) {
    const i = kv.indexOf("=");
    if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
  }
  delete env.PWD; delete env.OLDPWD; delete env._; delete env.SHLVL;
  return env;
}

/**
 * 这个角色在 env 里声明过的目录。HOME 本身、/ 、HOME 的祖先一律不算（否则什么都「在自己目录下」）。
 * strong = 目录类配置（DIR_KEYS）直接声明的；false = 从文件路径推出来的所在目录。
 * @returns {{dir:string, key:string, strong:boolean}[]}
 */
function ownRoots(env) {
  const home = path.resolve(homeDir(env));
  const roots = [];
  const add = (dir, key, strong) => {
    if (!dir || !path.isAbsolute(dir)) return;
    const d = path.resolve(dir);
    if (d === "/" || d === home || isUnder(home, d)) return;
    const had = roots.find((r) => r.dir === d);
    if (had) had.strong = had.strong || strong; else roots.push({ dir: d, key, strong });
  };
  for (const k of DIR_KEYS) add(String(env[k] || "").trim(), k, true);
  for (const k of FILE_KEYS) {
    const v = String(env[k] || "").trim();
    if (v) add(path.dirname(v), k, false);
  }
  return roots;
}

/** child 在 parent 之下（按路径段比，/home/x/.alpha 不包含 /home/x/.alpha-gate）。 */
function isUnder(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * 判一条来源路径：在不在本角色地盘、有没有落进别的角色地盘。
 * @param {string} p
 * @param {{dir,key}[]} mine
 * @param {{id:string, roots:{dir,key}[]}[]} others
 * @returns {{path:string, own:boolean, ownKey:string, foreign:string[], cross:boolean}}
 */
function classifyPath(p, mine, others = []) {
  const abs = p && path.isAbsolute(p) ? path.resolve(p) : String(p || "");
  const hit = mine.find((r) => isUnder(abs, r.dir));
  const foreign = [];
  // 落进别的角色声明过的目录 = 跨角色，哪怕本角色 env 里也写了这个目录（那正是抄错配置的样子）。
  // 别人「由文件推出来的目录」（strong=false）如果落在我自己的目录类配置之下，不算它的 ——
  // 否则 B 的 env 抄错一个指向 A 的文件，A 自己的东西反倒被标成 B 的。
  const mineStrong = mine.filter((m) => m.strong !== false);
  for (const o of others) {
    const theirs = o.roots.filter((r) => r.strong !== false || !mineStrong.some((m) => isUnder(r.dir, m.dir)));
    if (theirs.some((r) => isUnder(abs, r.dir))) foreign.push(o.id);
  }
  return { path: abs, own: !!hit, ownKey: hit ? hit.key : "", foreign, cross: !hit || foreign.length > 0 };
}

/**
 * 读名单 + 每个角色的 env。单个角色读失败只记在它自己身上。
 * @returns {{id, envFile, env?, error?, roots, displayName}[]}
 */
function loadAll(env = process.env) {
  // 2026-10-22：面板上的名字。GATE_AGENT_DISPLAY_NAME 会进他的提示词，不能为了面板去改它，
  // 所以面板自己认 PANEL_NAMES="alpha:晨星,beta:暮雨"，优先于它。
  const names = {};
  for (const item of String(env.PANEL_NAMES || "").split(",")) {
    const i = item.indexOf(":");
    if (i > 0) names[item.slice(0, i).trim()] = item.slice(i + 1).trim();
  }
  return listCharacters(env).map((c) => {
    try {
      const e = loadEnvFile(c.envFile, env);
      return { ...c, env: e, roots: ownRoots(e), displayName: names[c.id] || String(e.GATE_AGENT_DISPLAY_NAME || "").trim() || c.id };
    } catch (err) {
      return { ...c, error: String((err && err.message) || err).split("\n")[0], roots: [], displayName: names[c.id] || c.id };
    }
  });
}

module.exports = { listCharacters, loadEnvFile, ownRoots, classifyPath, isUnder, loadAll, DIR_KEYS, FILE_KEYS };
