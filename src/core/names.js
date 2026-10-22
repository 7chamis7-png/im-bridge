"use strict";

/**
 * 运行逻辑里会说出口的名字（进提示词 / 告警 / 群里叫醒词）—— 原来写死在代码里，
 * 2026-10-21 改成配置。**默认值 = 生产现在说的**，生产 env 不加这几个变量，
 * 拼出来的提示词逐字节不变（缓存前缀不动）。
 *
 *   GATE_OWNER_NAME           主人的身份键（账本/冷层里记的那个，ASCII；不是给人看的）
 *   GATE_OWNER_DISPLAY_NAME   主人叫什么（提示词里的「Alice」）
 *   GATE_AGENT_DISPLAY_NAME   他在提示词里怎么称呼自己（「Nova」）
 *   GATE_AGENT_ALERT_NAME     推给主人的告警里管他叫什么（没给 = 上面那个；都没给 = 「Nova」）
 *   GATE_GROUP_WAKE_NAMES     群里出现就叫醒他的词，逗号分隔（没给 = [他, 主人]）
 *
 * 导出公开版时只换这里的默认值。
 */

const LEGACY = Object.freeze({ ownerKey: "alice", owner: "Alice", agent: "Nova", alert: "Nova" });

const str = (v) => String(v == null ? "" : v).trim();

function ownerKey(env = process.env) { return str(env.GATE_OWNER_NAME) || LEGACY.ownerKey; }
function ownerDisplayName(env = process.env) { return str(env.GATE_OWNER_DISPLAY_NAME) || LEGACY.owner; }
function agentDisplayName(env = process.env) { return str(env.GATE_AGENT_DISPLAY_NAME) || LEGACY.agent; }
function agentAlertName(env = process.env) {
  return str(env.GATE_AGENT_ALERT_NAME) || str(env.GATE_AGENT_DISPLAY_NAME) || LEGACY.alert;
}
function groupWakeNames(env = process.env) {
  const given = str(env.GATE_GROUP_WAKE_NAMES).split(",").map((s) => s.trim()).filter(Boolean);
  return given.length ? given : [agentDisplayName(env), ownerDisplayName(env)];
}

module.exports = { LEGACY, ownerKey, ownerDisplayName, agentDisplayName, agentAlertName, groupWakeNames };
