"use strict";

/**
 * 换舱时选模型（2026-10-22）：面板只决定「发哪几条命令」，真正干活的还是桥的命令表，跟 TG 里发一模一样。
 *
 *   TG /model <id>  = 同一家引擎内**热切**（runtime.setModelForWorkspace，下一轮生效）—— **不换舱**；
 *                     跨引擎的 id 它直接拒，让你用 /engine。
 *   TG /engine <id> = 跨厂商换引擎 = **一次完整换舱**（等这一轮说完 → 收尾轮 → 新引擎新舱，尾巴重垫、人格重交）。
 *
 * 所以：
 *   不换模型            → ["/new …"]
 *   同一家换个模型      → ["/new …", "/model <id>"]：先换舱、再热切。顺序的原因：
 *                          /new 的收尾轮还跑在**旧舱 + 旧模型**上（缓存还热，不为一个收尾轮全量重算旧舱）；
 *                          /model 只改「下一轮用哪个模型」，下一轮正好是新舱的第一轮。
 *                          两条在桥里占同一个串行位置连着跑，中间插不进别的话。
 *   换到别家的模型      → ["/engine <id>"]：它自己就包含换舱，**不再叠 /new**（叠了会多一次收尾、多开一个空舱）。
 *
 * 模型清单 = 这个人的登记表（models.json，modelsFile 跟 TG /model 读的同一份）。
 */

const registry = require("../box/model-registry");
const { boxEngine } = require("../box/forge-switch");
const { L, zh } = require("./i18n");
/** why 给页面看（跟着语言走），whyZh 进审计账（永远中文）。 */
const no = (s, ...args) => ({ ok: false, why: L(s, ...args), whyZh: zh(s, ...args) });

/** 读这个人的登记表 + 判出「现在在用哪个」。 */
function modelChoices(ch, { requested = "" } = {}) {
  const env = ch.env || {};
  const reg = registry.loadModelRegistry({ file: registry.modelsFile(env), env });
  const pinned = String(env.GATE_MODEL || "").trim();
  const current = pinned || String(requested || "").trim() || (reg.ok ? reg.default : "");
  const entry = reg.ok ? registry.lookup(reg, current) : null;
  const engine = (entry && entry.engine) || registry.normalizeEngine(boxEngine({ env, model: current }));
  return { reg, current, currentEntry: entry, engine, pinned,
    models: reg.ok ? reg.models.map((m) => ({ ...m, sameEngine: m.engine === engine, isCurrent: m.id === current,
      money: registry.billingAllowed(m, env) })) : [] };
}

/**
 * @param {object} c   modelChoices 的结果
 * @param {string} pick  她选的 id（"" = 不换）
 * @returns {{ok:true, kind, texts:string[], to?:object} | {ok:false, why}}
 */
function planRotate(c, pick, { reason = "在面板上按的" } = {}) {
  const id = String(pick || "").trim();
  const nw = "/new " + reason;
  if (!id || id === c.current) return { ok: true, kind: "new", texts: [nw] };
  if (!c.reg.ok) return no("模型登记表读不了，只能不换模型：{0}", (c.reg.errors && c.reg.errors[0]) || "");
  const to = registry.lookup(c.reg, id);
  if (!to) return no("登记表里没有「{0}」—— 不猜", id);
  if (c.pinned) return no("env 里 GATE_MODEL 钉死了 {0}，换不了模型（先把它去掉，默认模型改由 models.json 的 default 给）", c.pinned);
  if (to.engine === c.engine) return { ok: true, kind: "new+model", texts: [nw, "/model " + to.id], to };
  return { ok: true, kind: "engine", texts: ["/engine " + to.id], to };
}

module.exports = { modelChoices, planRotate };
