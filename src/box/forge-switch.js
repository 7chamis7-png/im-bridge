"use strict";

/**
 * forge（换舱时把最近的真实对话垫回新舱）的开关 —— 桥上的共享能力，**按人开**（2026-10-21 Alice）。
 *
 *   1. 人格配置 $GATE_ROOT/tools.json 里的 `"forge": true | false`（跟 personaFile 放一起）—— 写了就听它的
 *   2. 没写 → 认旧开关 FORGE_ENABLED=true（兼容：今天Nova的 nova-env.sh 就是这么开的）
 *   3. 都没有 → 关
 *
 * 开关不认识引擎：怎么垫由各家的重建插头管（claude：scripts/forge.js 合成 transcript 再 resume；
 * codex：cli-host/rebuild-codex.js 新开 thread + thread/inject_items）。料是同一份（scripts/forge.js selectTail：
 * 冷层或全本投影，过对账才用全本）。
 * 每次现读：改了 tools.json 不用重启，下次换舱就按新的来。
 */

const { personaConfigPath, readPersonaSpec } = require("../host/persona-file");

function forgeSwitch({ env = process.env, configFile, log = () => {} } = {}) {
  const file = configFile !== undefined ? configFile : personaConfigPath(env);
  const spec = readPersonaSpec(file);
  if (spec && spec.forgeError) log(`[forge] ${spec.forgeError}，当没写`);
  if (spec && !spec.error && typeof spec.forge === "boolean") {
    return { on: spec.forge, from: `${file} forge=${spec.forge}` };
  }
  const legacy = String(env.FORGE_ENABLED || "") === "true";
  return { on: legacy, from: legacy ? "FORGE_ENABLED=true（兼容旧开关）" : "默认关" };
}

/**
 * 盒子这头该用哪家的重建插头。盒子里只有 claude 那半（合成 transcript），codex 那半在 cli 宿主里（rebuild-codex.js）——
 * Iris的盒子也是同一份 box-runtime，**绝不能**给他合成一份 claude transcript、更不能为他跑 claude 金丝雀。
 *   GATE_ENGINE 显式写了就听它的（claude / codex / deepseek）；
 *   没写：模型名是 gpt- / oN 开头的当 codex（Iris GATE_MODEL=gpt-5.6-sol），其余当 claude（Nova今天 GATE_MODEL 是空的）。
 * TODO(S5)：让 cli 宿主在 attach 时报自己是哪家引擎，盒子直接用它，不再靠这个推断。
 */
function boxEngine({ env = process.env, model = "" } = {}) {
  const e = String(env.GATE_ENGINE || "").trim().toLowerCase();
  if (e) return e;
  const m = String(model || env.GATE_MODEL || "").trim();
  return /^(gpt-|o\d)/i.test(m) ? "codex" : "claude";
}

module.exports = { forgeSwitch, boxEngine };
