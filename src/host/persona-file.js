"use strict";

/**
 * 人格文件由桥来交（2026-10-21，第 3 步「桥是本体，模型只是引擎」）。
 *
 * 以前：Nova的人格在 /root/nova/CLAUDE.md，是 Claude CLI **自己**从工作目录读进去的，
 * 桥不经手；Iris的在 AGENTS.md，codex 自己读。换一家引擎，人格就没了。
 * 现在：人格文件写在人格配置里（$GATE_ROOT/tools.json 的 `personaFile`），
 * **启动引擎那一刻**由 cli-host 读出来，拼进系统提示交给引擎：
 *   · claude   → sdkOptions.systemPrompt（跟 nova-system-prompt.md 同一条路，排在宣言后面）
 *   · codex    → developerInstructions（thread/start）
 *   · deepseek → system 消息
 *
 * 桥**只读不写**：文件内容归他本人维护。每次起引擎现读，改了下次起引擎（换舱 / 重启 cli）生效。
 *
 * ## 两份人格（工作目录里还躺着引擎自读的 CLAUDE.md / AGENTS.md）
 *
 * 选的做法：**内容一样就拒绝重复注入，内容不一样就照注入 + 大声告警。**
 *   · 一样（切换那天 cp 了没 mv）：引擎自己会读那份，桥再交一份 = 一个人读两遍自己，
 *     白占一两万 token、缓存前缀也跟着变 → 桥不交，告警叫人把那份移走。
 *   · 不一样：桥**不敢**替他删任何一份。工作目录里冒出来的 CLAUDE.md 可能是个
 *     几行的新文件（比如他照老习惯「写进 CLAUDE.md」），要是因此跳过人格文件，
 *     他就从 28KB 的自己缩成几行 —— 这比多读一份严重得多。宁可多，不可少。
 *
 * ## 找不到人格文件：绝不起空壳
 *
 *   1. 引擎自己会读工作目录里的旧文件（claude 的 CLAUDE.md、codex 的 AGENTS.md）→
 *      桥不交，让引擎读旧的，**大声告警**（= 切换之前的老样子）
 *   2. 工作目录里有旧文件但这个引擎不读（比如 codex 碰上 CLAUDE.md）→ 桥读旧的交进去，告警
 *   3. 都没有 → 抛 PersonaMissingError，cli-host 拒绝起引擎
 *
 * 人格配置里根本没写 `personaFile` = 老样子（引擎自己读），这里不插手。
 */

const fs = require("node:fs");
const path = require("node:path");

/**
 * 每家引擎**自己**会从工作目录读的人格文件。加一家引擎 = 在这儿登记一行。
 * ⚠️ 写错的代价不对称：把「不读」写成「读」，碰上同内容时桥会跳过注入 → 少一份人格。
 *    不确定就别登记（顶多多读一份）。
 */
const ENGINE_AUTO_READ = {
  claude: ["CLAUDE.md", "CLAUDE.local.md", path.join(".claude", "CLAUDE.md")],
  codex: ["AGENTS.override.md", "AGENTS.md"],
  // 不是引擎自己读的，是咱们的 deepseek-runtime.js buildSystem() 照 claude 的习惯拼的
  deepseek: ["CLAUDE.md"],
};

/** 切换前的旧人格文件名。人格文件找不到时按这个顺序找退路。 */
const LEGACY_NAMES = ["CLAUDE.md", "AGENTS.md"];

class PersonaMissingError extends Error {
  constructor(message) { super(message); this.name = "PersonaMissingError"; this.personaMissing = true; }
}

/** 人格配置文件默认在哪 —— 跟 main.js readConfig 的 toolsConfigFile 同一个口径。 */
function personaConfigPath(env = process.env) {
  if (String(env.GATE_TOOLS_CONFIG || "").trim()) return env.GATE_TOOLS_CONFIG.trim();
  if (String(env.GATE_ROOT || "").trim()) return path.join(env.GATE_ROOT.trim(), "tools.json");
  return "";
}

/**
 * 从人格配置里读出「人格文件是哪个」。
 * @returns {null | { persona, personaFile, configFile, error? }}
 *   null = 没有人格配置文件（老样子）。配置坏了不抛，带 error 回去 —— 交给 resolvePersona 走退路。
 */
function readPersonaSpec(configFile) {
  if (!configFile) return null;
  let raw;
  try { raw = fs.readFileSync(configFile, "utf8"); }
  catch (e) {
    if (e.code === "ENOENT") return null;
    return { persona: "", personaFile: "", configFile, error: `读不了 ${configFile}：${e.code || e.message}` };
  }
  let cfg;
  try { cfg = JSON.parse(raw); }
  catch (e) { return { persona: "", personaFile: "", configFile, error: `${configFile} 不是合法 JSON：${e.message}` }; }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    return { persona: "", personaFile: "", configFile, error: `${configFile} 顶层要是对象` };
  }
  const pf = cfg.personaFile;
  if (pf !== undefined && typeof pf !== "string") {
    return { persona: String(cfg.persona || ""), personaFile: "", configFile, error: `${configFile} 的 personaFile 要是字符串` };
  }
  // forge（换舱垫历史）按人开关（2026-10-21）：跟 personaFile 放在一起。只认 true / false，别的值当没写（回落 FORGE_ENABLED）
  const forge = typeof cfg.forge === "boolean" ? cfg.forge : undefined;
  const forgeError = cfg.forge !== undefined && typeof cfg.forge !== "boolean" ? `${configFile} 的 forge 要是 true / false` : undefined;
  return { persona: typeof cfg.persona === "string" ? cfg.persona : "", personaFile: (pf || "").trim(), configFile,
    ...(forge !== undefined ? { forge } : {}), ...(forgeError ? { forgeError } : {}) };
}

function readNonEmpty(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { error: "不是文件" };
    const text = fs.readFileSync(file, "utf8");
    if (!text.trim()) return { error: "是空的" };
    return { text };
  } catch (e) { return { error: e.code || e.message }; }
}

function existing(workspaceRoot, names) {
  const out = [];
  if (!workspaceRoot) return out;
  for (const n of names) {
    const f = path.join(workspaceRoot, n);
    const r = readNonEmpty(f);
    if (r.text !== undefined) out.push({ name: n, file: f, text: r.text });
  }
  return out;
}

const same = (a, b) => String(a).replace(/\r\n/g, "\n").trim() === String(b).replace(/\r\n/g, "\n").trim();

/**
 * 决定这一次起引擎要不要交人格、交哪份。**只读**，不碰任何文件。
 *
 * @param {object} o
 * @param {object|null} o.spec  readPersonaSpec 的产物
 * @param {string} o.workspaceRoot  引擎的工作目录
 * @param {string} o.engine  claude / codex / deepseek（不认识 = 当它什么都不自己读）
 * @returns {{ mode, text, source, engineFiles: string[], warnings: string[] }}
 *   mode:
 *     unconfigured       人格配置没写 personaFile，老样子
 *     bridge             桥交人格文件（正常态）
 *     skip-identical     工作目录有同内容的引擎自读文件，桥不重复交
 *     bridge+engine-dup  两份内容不同，桥照交 + 告警
 *     engine-legacy      人格文件找不到，退回引擎自己读旧文件
 *     bridge-legacy      人格文件找不到，桥读旧文件交进去
 * @throws {PersonaMissingError} 哪儿都找不到人格 —— 绝不起空壳
 */
function resolvePersona({ spec, workspaceRoot, engine = "" } = {}) {
  const warnings = [];
  const who = (spec && spec.persona) || "这个人";
  const known = Object.prototype.hasOwnProperty.call(ENGINE_AUTO_READ, engine);
  const engineReads = known ? ENGINE_AUTO_READ[engine] : [];
  if (!known) warnings.push(`不认识引擎「${engine || "(空)"}」—— 当它不自己读任何人格文件`);
  const engineFound = existing(workspaceRoot, engineReads);
  const engineFiles = engineFound.map((f) => f.file);

  if (!spec || (!spec.personaFile && !spec.error)) {
    if (!engineFound.length) {
      warnings.push(`⚠️ 人格配置没写 personaFile，工作目录 ${workspaceRoot || "(空)"} 里也没有 ${engine} 自己会读的人格文件 —— `
        + `这一舱没有人格文件（测试/空桥可以，真人不行）。`);
    }
    return { mode: "unconfigured", text: "", source: engineFiles[0] || "", engineFiles, warnings };
  }

  let personaPath = "";
  let got = { error: spec.error || "" };
  if (!spec.error) {
    personaPath = path.isAbsolute(spec.personaFile)
      ? spec.personaFile : path.resolve(workspaceRoot || ".", spec.personaFile);
    got = readNonEmpty(personaPath);
  }

  if (got.text !== undefined) {
    if (!engineFound.length) return { mode: "bridge", text: got.text, source: personaPath, engineFiles, warnings };
    const twin = engineFound.find((f) => same(f.text, got.text));
    if (twin) {
      warnings.push(`⚠️ 双份人格：${twin.file} 跟人格文件 ${personaPath} 内容一样，${engine} 会自己读它 —— `
        + `桥这次不重复注入。把 ${twin.name} 移走（改名/删掉），下次起引擎就由桥来交。`);
      return { mode: "skip-identical", text: "", source: twin.file, engineFiles, warnings };
    }
    warnings.push(`⚠️⚠️ 双份人格：${who} 的人格文件是 ${personaPath}，但工作目录里还有 `
      + engineFound.map((f) => `${f.file}（${f.text.length} 字）`).join("、")
      + `，${engine} 会自己读，而且内容跟人格文件不一样。桥照样交人格文件（宁可多读一份，不可少一份），`
      + `他这一舱会同时看到两份。请人工合并后把工作目录里那份移走。`);
    return { mode: "bridge+engine-dup", text: got.text, source: personaPath, engineFiles, warnings };
  }

  // ——— 人格文件读不到：退路 ———
  const why = spec.error ? spec.error : `${personaPath}（${got.error}）`;
  if (engineFound.length) {
    warnings.push(`⚠️⚠️⚠️ ${who} 的人格文件读不到：${why}。退回让 ${engine} 自己读 ${engineFiles.join("、")}（旧样子）。`
      + `切换没做完，或者文件被挪走了 —— 赶紧查。`);
    return { mode: "engine-legacy", text: "", source: engineFiles[0], engineFiles, warnings };
  }
  const legacy = existing(workspaceRoot, LEGACY_NAMES);
  if (legacy.length) {
    warnings.push(`⚠️⚠️⚠️ ${who} 的人格文件读不到：${why}。桥退回去读旧的 ${legacy[0].file} 交给 ${engine}。赶紧查。`);
    return { mode: "bridge-legacy", text: legacy[0].text, source: legacy[0].file, engineFiles, warnings };
  }
  throw new PersonaMissingError(`${who} 的人格文件读不到：${why}；工作目录 ${workspaceRoot || "(空)"} 里也没有 `
    + `${LEGACY_NAMES.join(" / ")} —— 拒绝起一个没有人格的空壳。查人格配置 ${spec.configFile || ""} 的 personaFile。`);
}

/** 把人格接在原有系统提示（宣言）后面。任一边空就只留另一边。 */
function composeSystemPrompt(base, personaText) {
  const parts = [base, personaText].map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean);
  return parts.join("\n\n");
}

/**
 * codex 的 developerInstructions = 盒子给的（宣言 + 人格文件）+ IB 身份底座，两样都要。
 * 一段已经包含另一段（老路子把底座原样递回来）就不重复。
 */
function joinInstructions(given, base) {
  const g = typeof given === "string" ? given.trim() : "";
  const b = typeof base === "string" ? base.trim() : "";
  if (!g) return b;
  if (!b || g.includes(b)) return g;
  return composeSystemPrompt(g, b);
}

module.exports = {
  ENGINE_AUTO_READ, LEGACY_NAMES, PersonaMissingError,
  personaConfigPath, readPersonaSpec, resolvePersona, composeSystemPrompt, joinInstructions,
};
