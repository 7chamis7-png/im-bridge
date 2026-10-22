"use strict";

/**
 * 模型登记表（设计稿 §5.2，2026-10-21）—— 每个人格一份 `$GATE_ROOT/models.json`。
 *
 * 取代写死在命令文件里的 MODEL_CHOICES：
 *   · /model 的按钮 = 登记表里**当前引擎**下的条目（同一家内热切）
 *   · /engine 的按钮 = 登记表里**别的引擎**的条目（跨厂商 = 一次正规换舱）
 *   · 查不到就拒绝，不猜引擎、不悄悄回落（原来 codex 见到不认识的名字就回落 GATE_MODEL）
 *   · 按量计费（billing:"api"）必须写 requiresAllow，对应的 env 显式开着才放行（钱闸 §5.5）
 *
 * 每次现读（文件很小）：改了 models.json 不用重启，下一次 /model /engine 就按新的来。
 * gate（命令）和 box（真正动手的那一头）各读一遍、各验一遍 —— 钱闸以 box 那次为准。
 *
 * 形状：
 *   { "v": 1, "default": "<id>", "models": [ { id, label?, engine, window, vision?, tools?, billing,
 *       requiresAllow?, secret?, baseUrl?, codexConfig?, verified?, note? } ] }
 */

const fs = require("fs");
const path = require("path");

/** 认得的引擎（§2.1 的 engine 字段）。 */
const ENGINES = ["claude-cli", "codex-appserver", "openai-chat"];

/** 老名字（GATE_ENGINE / forge-switch / persona-file 用的）→ 登记表里的名字。 */
const LEGACY = { claude: "claude-cli", codex: "codex-appserver", deepseek: "openai-chat" };

/** 登记表引擎名 → persona-file.js 认的名字（决定「这个引擎自己会读哪些人格文件」）。 */
const PERSONA_ENGINE = { "claude-cli": "claude", "codex-appserver": "codex", "openai-chat": "deepseek" };

/** 给她看的引擎名。 */
const ENGINE_LABEL = { "claude-cli": "Claude（CLI）", "codex-appserver": "codex", "openai-chat": "OpenAI 兼容 API" };

/** codex 那份 -c 覆盖只放这几个键（别让登记表变成任意改 codex 配置的口子）。 */
const CODEX_CONFIG_KEYS = new Set(["model_context_window", "model_auto_compact_token_limit"]);

const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ALLOW_NAME = /^[A-Z][A-Z0-9_]{2,63}$/;

function normalizeEngine(e) {
  const v = String(e || "").trim().toLowerCase();
  if (ENGINES.includes(v)) return v;
  return LEGACY[v] || "";
}

function modelsFile(env = process.env) {
  const explicit = String(env.GATE_MODELS_FILE || "").trim();
  if (explicit) return explicit;
  const root = String(env.GATE_ROOT || "").trim();
  return root ? path.join(root, "models.json") : "";
}

/** 一条登记项过一遍。返回 { entry } 或 { error }。 */
function checkEntry(raw, i) {
  const where = `models[${i}]`;
  if (!raw || typeof raw !== "object") return { error: `${where} 不是对象` };
  const id = String(raw.id || "").trim();
  if (!id) return { error: `${where} 没有 id` };
  const engine = normalizeEngine(raw.engine);
  if (!engine) return { error: `${id}：不认识的引擎「${raw.engine}」（只认 ${ENGINES.join(" / ")}）` };
  const window = Number(raw.window);
  if (!Number.isInteger(window) || window <= 0) return { error: `${id}：window 要是正整数（窗口多大由人填，拿不准就填引擎报的）` };
  const billing = String(raw.billing || "").trim();
  if (billing !== "subscription" && billing !== "api") return { error: `${id}：billing 只能是 subscription / api` };
  const requiresAllow = String(raw.requiresAllow || "").trim();
  if (billing === "api" && !ALLOW_NAME.test(requiresAllow)) {
    return { error: `${id}：按量计费的模型必须写 requiresAllow（一个 env 名，比如 DEEPSEEK_ALLOW_BILLING）—— 钱闸` };
  }
  const secret = String(raw.secret || "").trim();
  if (secret && !SECRET_NAME.test(secret)) return { error: `${id}：secret 只写名字（对应 ~/.secrets/<名字>.secret），不写路径` };
  if (engine === "openai-chat" && !secret) return { error: `${id}：openai-chat 要写 secret（钥匙在 ~/.secrets/<secret>.secret）` };
  let codexConfig = null;
  if (raw.codexConfig != null) {
    if (engine !== "codex-appserver" || typeof raw.codexConfig !== "object") return { error: `${id}：codexConfig 只给 codex-appserver 用` };
    codexConfig = {};
    for (const [k, v] of Object.entries(raw.codexConfig)) {
      if (!CODEX_CONFIG_KEYS.has(k)) return { error: `${id}：codexConfig 不认 ${k}（只认 ${[...CODEX_CONFIG_KEYS].join(" / ")}）` };
      if (!Number.isInteger(Number(v)) || Number(v) <= 0) return { error: `${id}：codexConfig.${k} 要是正整数` };
      codexConfig[k] = Number(v);
    }
  }
  const baseUrl = String(raw.baseUrl || "").trim();
  if (baseUrl && !/^https:\/\//.test(baseUrl)) return { error: `${id}：baseUrl 要 https://` };
  return { entry: {
    id, label: String(raw.label || id), engine, window,
    vision: raw.vision === true, tools: raw.tools === true,
    billing, requiresAllow: requiresAllow || "",
    ...(secret ? { secret } : {}), ...(baseUrl ? { baseUrl } : {}), ...(codexConfig ? { codexConfig } : {}),
    reasoningOpaque: String(raw.reasoningOpaque || ""),
    verified: raw.verified === true,
    note: String(raw.note || ""),
  } };
}

/**
 * 读登记表。
 * @returns {{ok:boolean, file:string, exists:boolean, models:object[], default:string, errors:string[]}}
 *   文件不在 → ok:false, exists:false（调用方：没有登记表就**不能换**，明说）
 *   有坏条目 → 坏的那条不进 models、写进 errors；整份读不了 → ok:false
 */
function loadModelRegistry({ file, env = process.env } = {}) {
  const f = file !== undefined ? file : modelsFile(env);
  const out = { ok: false, file: f, exists: false, models: [], default: "", errors: [] };
  if (!f) { out.errors.push("不知道登记表在哪（没有 GATE_ROOT / GATE_MODELS_FILE）"); return out; }
  let raw;
  try { raw = fs.readFileSync(f, "utf8"); }
  catch (e) {
    if (e.code !== "ENOENT") { out.exists = true; out.errors.push(`读不了 ${f}：${e.message}`); }
    else out.errors.push(`没有模型登记表 ${f}`);
    return out;
  }
  out.exists = true;
  let doc;
  try { doc = JSON.parse(raw); } catch (e) { out.errors.push(`${f} 不是合法 JSON：${e.message}`); return out; }
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.models)) { out.errors.push(`${f} 里要有 models 数组`); return out; }
  if (doc.v !== undefined && doc.v !== 1) { out.errors.push(`${f} 的 v=${doc.v} 不认识（只认 1），不猜`); return out; }
  const seen = new Set();
  doc.models.forEach((m, i) => {
    const r = checkEntry(m, i);
    if (r.error) { out.errors.push(r.error); return; }
    if (seen.has(r.entry.id)) { out.errors.push(`${r.entry.id} 登记了两次，后一条不要`); return; }
    seen.add(r.entry.id);
    out.models.push(r.entry);
  });
  const def = String(doc.default || "").trim();
  if (def && !seen.has(def)) out.errors.push(`default「${def}」不在登记表里，当没写`);
  out.default = def && seen.has(def) ? def : "";
  out.ok = true;
  return out;
}

/** 按 id 精确查（`[1m]` 后缀也是 id 的一部分：丢了窗口从 100 万掉到 20 万）。查不到 = null。 */
function lookup(reg, id) {
  const want = String(id || "").trim();
  if (!want || !reg || !Array.isArray(reg.models)) return null;
  return reg.models.find((m) => m.id === want) || null;
}

function truthy(v) { return ["1", "true", "on", "yes"].includes(String(v || "").trim().toLowerCase()); }

/** 钱闸。订阅类直接过；按量计费要 requiresAllow 那个 env 显式开着。 */
function billingAllowed(entry, env = process.env) {
  if (!entry) return { ok: false, why: "登记表里没有这个模型" };
  if (entry.billing !== "api") return { ok: true };
  if (!entry.requiresAllow) return { ok: false, why: `${entry.id} 按量计费却没写 requiresAllow，拒绝` };
  if (truthy(env[entry.requiresAllow])) return { ok: true };
  return { ok: false, why: `${entry.id} 按量计费（花真钱），要先显式开 ${entry.requiresAllow}=1 才能切 —— 别偷偷花钱` };
}

/**
 * 从 A 换到 B 会丢什么（§5.4，写进回执和换引擎流水的 degraded）。
 * tail：{turns, droppedTurns} 可选，窗口把尾巴截短了就写一句。
 */
function degradations(from, to, tail = null) {
  const out = [];
  if (!to) return out;
  if (from && from.vision && !to.vision) out.push("看不见图：历史和之后的图都换成「[图片]」");
  if (from && from.tools && !to.tools) out.push("没接工具：不挂 MCP，人格包后面加一句「这个模型没接工具」");
  if (from && to.window < from.window) out.push(`窗口变小 ${from.window.toLocaleString()} → ${to.window.toLocaleString()}`);
  if (tail && tail.droppedTurns > 0) out.push(`窗口装不下，最旧的 ${tail.droppedTurns} 轮没垫进去`);
  if (from && from.engine !== to.engine) out.push("思考块 / 加密 reasoning 带不过去（只认同一家）");
  if (!to.verified) out.push(`窗口 ${to.window.toLocaleString()} 是人填的，未从引擎核实`);
  return out;
}

module.exports = {
  ENGINES, LEGACY, PERSONA_ENGINE, ENGINE_LABEL, CODEX_CONFIG_KEYS,
  normalizeEngine, modelsFile, loadModelRegistry, lookup, billingAllowed, degradations, truthy,
};
