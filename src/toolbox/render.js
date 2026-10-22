"use strict";

/**
 * 登记表 + 人格配置 → 这个人这一舱的 mcpServers（2026-10-21）。
 *
 * 人格配置：$GATE_ROOT/tools.json（GATE_TOOLS_CONFIG 可改路径）。形状：
 *   {
 *     "persona": "nova",
 *     "vars": { "STATE_DIR": "/root/.nova", ... },         // 他的目录；见 registry.js 用到的变量
 *     "secretsFiles": ["/root/.secrets/nova-tools.env"],    // 只写路径；KEY=VALUE 一行一个
 *     "exclude": ["browser"],                               // 不要哪几包
 *     "skipHeavy": false,                                   // true = 摘掉 heavy 的（codex 没有按需取件）
 *     "servers": { "notebook": { "alwaysLoad": true, "env": {...}, "enabled": false } }
 *   }
 *
 * 规矩：
 *   · 他自己的目录**只从他的配置来**；拼不出来就不挂，绝不回落到别人家（以前默认值全是 /root/.nova）
 *   · 号类（per-persona-account）钥匙没有 = 整条不挂 + 日志说清楚，不借别人的号
 *   · 专属记忆（persona-private-memory）配置里**显式**给了位置才挂
 *   · 远程的一律包成本地 stdio 代理（tools/_lib/mcp-http-proxy.js）：
 *     配置里不出现 headers，codex 也能用（它的 HTTP 连不住 + 不透传环境）
 *   · 只有 im_bridge 常驻（那条在 main.js）；这里出来的默认都按需取，人格配置可单独钉常驻
 *
 * 日志绝不打印钥匙的值，只打印名字。
 */

const fs = require("node:fs");
const path = require("node:path");
const { SERVERS, CODE_DEFAULTS, PERSONA_DEFAULTS } = require("./registry");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PROXY_SCRIPT = path.join(REPO_ROOT, "tools", "_lib", "mcp-http-proxy.js");
// 桥自己给的事实，人格配置改不了（改了就是指到别人的桥上）
const FIXED_VARS = new Set(["GATE_ROOT", "TOOL_SOCKET", "IM_BRIDGE_HOME"]);

/** KEY=VALUE 一行一个（兼容 `export ` 前缀、# 注释、成对引号）。 */
function parseEnvText(text) {
  const out = {};
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function readSecrets(files, log, single = {}) {
  const out = {};
  for (const f of files) {
    try {
      Object.assign(out, parseEnvText(fs.readFileSync(f, "utf8")));
    } catch (e) {
      log(`[tools] ⚠️ secrets 文件读不到：${f}（${String(e.code || e.message).split("\n")[0]}）—— 要这里钥匙的那几包会不挂`);
    }
  }
  // 一把钥匙一个文件（~/.secrets/<名字>.secret，init 生成的就是这种）：{ "钥匙名": "文件路径" }
  for (const [name, f] of Object.entries(single)) {
    try {
      const v = fs.readFileSync(f, "utf8").trim();
      if (v) out[name] = v;
    } catch (e) {
      log(`[tools] ⚠️ 钥匙文件读不到：${name} ← ${f}（${String(e.code || e.message).split("\n")[0]}）`);
    }
  }
  return out;
}

function readPersonaConfig(file, log) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (e) { if (e.code === "ENOENT") return null; throw new Error(`读不了 ${file}：${e.message}`); }
  let cfg;
  try { cfg = JSON.parse(raw); }
  catch (e) { throw new Error(`${file} 不是合法 JSON：${e.message}`); }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error(`${file} 顶层要是对象`);
  const vars = cfg.vars && typeof cfg.vars === "object" ? cfg.vars : {};
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v !== "string") throw new Error(`${file} vars.${k} 要是字符串`);
  }
  const secretsFiles = Array.isArray(cfg.secretsFiles) ? cfg.secretsFiles
    : (typeof cfg.secretsFiles === "string" && cfg.secretsFiles ? [cfg.secretsFiles] : []);
  const servers = cfg.servers && typeof cfg.servers === "object" ? cfg.servers : {};
  const secretFiles = cfg.secretFiles && typeof cfg.secretFiles === "object" && !Array.isArray(cfg.secretFiles) ? cfg.secretFiles : {};
  for (const name of Object.keys(servers)) {
    if (!SERVERS[name]) log(`[tools] ⚠️ ${file} 里 servers.${name} 不在登记表里，忽略（登记表在 src/toolbox/registry.js）`);
  }
  for (const name of cfg.exclude || []) {
    if (!SERVERS[name]) log(`[tools] ⚠️ ${file} 里 exclude 的 ${name} 不在登记表里`);
  }
  return {
    persona: typeof cfg.persona === "string" ? cfg.persona : "",
    vars,
    secretsFiles,
    secretFiles,
    exclude: new Set(Array.isArray(cfg.exclude) ? cfg.exclude : []),
    skipHeavy: cfg.skipHeavy === true,
    servers,
  };
}

const REF = /\$\{(secret:)?([A-Za-z_][A-Za-z0-9_]*)(\?)?\}/g;

/**
 * 把一个模板字符串填好。
 * 返回 { value } 或 { drop: true }（可选的没给）或 { missing: [名字] }（必需的没给）。
 */
function fill(tpl, vars, secrets) {
  const missing = [];
  let drop = false;
  const value = String(tpl).replace(REF, (_, isSecret, name, optional) => {
    const src = isSecret ? secrets : vars;
    const v = src[name];
    if (typeof v === "string" && v !== "") return v;
    if (optional) { drop = true; return ""; }
    missing.push(isSecret ? `secret:${name}` : name);
    return "";
  });
  if (missing.length) return { missing };
  if (drop) return { drop: true };
  return { value };
}

/** 变量之间可以互相引用（BROWSER_PROFILE = ${STATE_DIR}/…）。解到不动为止，环就报错。 */
function resolveVars(vars) {
  const out = { ...vars };
  for (let round = 0; round < 10; round++) {
    let changed = false;
    for (const [k, v] of Object.entries(out)) {
      if (!/\$\{/.test(v)) continue;
      const r = fill(v, out, {});
      if (r.value !== undefined && r.value !== v) { out[k] = r.value; changed = true; }
      else if (r.missing || r.drop) { delete out[k]; changed = true; }
    }
    if (!changed) break;
  }
  for (const [k, v] of Object.entries(out)) if (/\$\{/.test(v)) throw new Error(`变量 ${k} 解不开（互相引用成环？）：${v}`);
  return out;
}

/**
 * 主入口。没有人格配置文件 → 返回 null（调用方走老的 GATE_EXTRA_MCP）。
 *
 * @returns {{ persona, servers: object, omitted: Array<{name, why}>, configFile } | null}
 */
function renderToolServers({
  gateRoot,
  toolSocket,
  coldFile = "",
  workspace = "",
  configFile = "",
  nodePath = process.execPath,
  imBridgeHome = REPO_ROOT,
  env = process.env,
  log = () => {},
} = {}) {
  if (!gateRoot) throw new Error("renderToolServers 要 gateRoot");
  const file = configFile || path.join(gateRoot, "tools.json");
  const pc = readPersonaConfig(file, log);
  if (!pc) return null;

  const explicit = new Set(Object.keys(pc.vars).filter((k) => pc.vars[k] !== ""));
  for (const k of FIXED_VARS) {
    if (explicit.has(k)) { log(`[tools] ⚠️ ${file} 里的 ${k} 不认 —— 这个由桥自己定`); explicit.delete(k); }
  }
  const fixed = {
    GATE_ROOT: gateRoot,
    TOOL_SOCKET: toolSocket || path.join(gateRoot, "tools.sock"),
    IM_BRIDGE_HOME: imBridgeHome,
  };
  const given = {};
  for (const k of explicit) given[k] = pc.vars[k];
  const vars = resolveVars({
    NODE: nodePath,
    PERSONA: pc.persona,
    COLD_FILE: coldFile || path.join(gateRoot, "cold.jsonl"),
    ...(workspace ? { WORKSPACE: workspace } : {}),
    // 主人的名字跟着桥的 env 走（tools.json vars 里也能单独给）；都没给 = 不带，工具说明书照旧
    ...(String(env.GATE_OWNER_DISPLAY_NAME || "").trim() ? { OWNER_DISPLAY_NAME: String(env.GATE_OWNER_DISPLAY_NAME).trim() } : {}),
    ...CODE_DEFAULTS,
    // 他自己目录下的默认拼法 —— 只在给了 STATE_DIR 时才有意义；没给就解不开、自然不挂
    ...PERSONA_DEFAULTS,
    ...given,
    ...fixed,
  });
  const secrets = readSecrets(pc.secretsFiles, log, pc.secretFiles);
  const who = pc.persona || path.basename(gateRoot);

  const servers = {};
  const omitted = [];
  const skip = (name, why) => { omitted.push({ name, why }); log(`[tools] 不挂 ${name}：${why}`); };

  for (const [name, reg] of Object.entries(SERVERS)) {
    const ov = pc.servers[name] && typeof pc.servers[name] === "object" ? pc.servers[name] : {};
    if (ov.enabled === false || pc.exclude.has(name)) { skip(name, `${who} 的配置里关掉了`); continue; }
    if (reg.heavy && pc.skipHeavy && ov.enabled !== true) { skip(name, "说明书重（heavy），配置里 skipHeavy"); continue; }

    if (reg.category === "persona-private-memory") {
      const lack = (reg.requires || []).filter((k) => !explicit.has(k));
      if (lack.length) { skip(name, `专属记忆，${who} 的配置没给位置（${lack.join(", ")}）`); continue; }
    }
    if (reg.category === "per-persona-data" && !explicit.has("STATE_DIR")) {
      skip(name, `数据跟人走，${who} 的配置没给 STATE_DIR —— 不回落到别人的目录`); continue;
    }
    if (reg.category === "per-persona-account") {
      const key = reg.auth && reg.auth.secret;
      if (key && !(typeof secrets[key] === "string" && secrets[key])) {
        skip(name, `${who} 自己的号没有钥匙（${key}），不挂 —— 不借别人的号`); continue;
      }
    }

    let spec;
    const missing = [];
    const one = (tpl) => { const r = fill(tpl, vars, secrets); if (r.missing) missing.push(...r.missing); return r; };

    if (reg.kind === "stdio") {
      const cmd = one(ov.command || reg.command);
      const args = (Array.isArray(ov.args) ? ov.args : (reg.args || [])).map((a) => one(a));
      spec = { command: cmd.value, args: args.filter((r) => !r.drop).map((r) => r.value) };
    } else if (reg.kind === "remote") {
      const url = one(ov.url || reg.url);
      const env = { MCP_PROXY_NAME: name, MCP_PROXY_URL: url.value };
      if (reg.auth && reg.auth.secret) {
        const tok = one(`\${secret:${reg.auth.secret}}`);
        env.MCP_PROXY_TOKEN = tok.value;
        env.MCP_PROXY_AUTH = reg.auth.mode === "query" ? `query:${reg.auth.param || "token"}` : "bearer";
      }
      spec = { command: vars.NODE, args: [path.join(imBridgeHome, "tools", "_lib", "mcp-http-proxy.js")], env };
    } else {
      skip(name, `登记表里 kind=${reg.kind} 不认识`); continue;
    }

    const envTpl = { ...(reg.env || {}), ...(ov.env && typeof ov.env === "object" ? ov.env : {}) };
    const env = { ...(spec.env || {}) };
    for (const [k, tpl] of Object.entries(envTpl)) {
      const r = one(tpl);
      if (r.value !== undefined) env[k] = r.value;
    }
    if (missing.length) { skip(name, `缺 ${[...new Set(missing)].join(", ")}`); continue; }
    if (Object.keys(env).length) spec.env = env;
    if (ov.alwaysLoad === true) spec.alwaysLoad = true;
    servers[name] = spec;
    log(`[tools] 挂上 ${name}（${reg.category}${reg.kind === "remote" ? "，远程走本地代理" : ""}${spec.alwaysLoad ? "，常驻" : ""}）`);
  }

  for (const [k, v] of Object.entries(vars)) {
    if (/(^|_)(DIR|HOME)$/.test(k) && explicit.has(k) && !fs.existsSync(v)) {
      log(`[tools] ⚠️ ${who} 的 ${k}=${v} 不存在 —— 用到它的工具第一次写时才会发现`);
    }
  }
  return { persona: who, servers, omitted, configFile: file };
}

module.exports = { renderToolServers, parseEnvText, fill, resolveVars, PROXY_SCRIPT };
