"use strict";

/**
 * 面板：卡住的消息 —— 跟 TG 里 /pending 看的是**同一张表**。
 *
 * 口径一律交给 src/gate/pending.js 的 makePendingDesk（哪些轮算卡住、死信怎么去重、
 * handled-dead-letters.jsonl 里处理过的怎么减掉、短编号怎么算），这里只喂给它只读的账本：
 *   $GATE_ROOT/turns.json                 轮次账本（unknown / rejected）
 *   $GATE_ROOT/undelivered.jsonl          没送到的账（待核对）
 *   $GATE_ROOT/dead-<渠道>.jsonl          死信
 *   $GATE_ROOT/handled-dead-letters.jsonl 处理过的死信（pending.js 自己读）
 *
 * 只读：只调 desk.list() / desk.counts()，retry / drop 一律不碰；队列给的是只读壳，
 * 万一有人调 retry / drop 直接抛错。不用 TurnStore（它构造时会 mkdir）。
 * 正文只留前 20 字（跟 /pending 一样），原件 / 全文不往下传。
 */

const fs = require("fs");
const path = require("path");
const { makePendingDesk } = require("../gate/pending");
const { makeUndelivered } = require("../gate/undelivered");
const { makeDeadLetter } = require("../gate/receiver");
const { L } = require("./i18n");

/** gate/pending.js 给的状态说明是中文原句：认得的过 L，认不得的原样。 */
const LABELS = new Set(["卡住了（不知道他收没收）", "拒收（旧账，不会自动重投）", "没发出去", "不知道发没发", "发了一半", "进了死信"]);
function labelL(s) {
  const t = String(s || "");
  if (LABELS.has(t)) return L(t);
  let m = /^拒收 (.+) 次，停了等你$/.exec(t);
  if (m) return L("拒收 {0} 次，停了等你", m[1]);
  m = /^拒收，(.*)自动重投（第 (.+) 次）$/.exec(t);
  if (m) return L("拒收，{0}自动重投（第 {1} 次）", m[1], m[2]);
  return t;
}

/** 跟 pending.js 的 short 同一个规矩：压空白、截 n 字加省略号。 */
const short = (s, n = 20) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};

function readOnlyQueue(file) {
  let rows = {};
  let exists = true;
  try { rows = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {
    if (e.code === "ENOENT") exists = false;
    else throw new Error(L("轮次账本读不了：{0}", String(e.message || e).split("\n")[0]));
  }
  if (!rows || typeof rows !== "object" || Array.isArray(rows)) throw new Error(L("轮次账本结构不对"));
  const no = () => { throw new Error(L("面板只读")); };
  return { exists, queue: { store: { list: () => Object.values(rows).filter((r) => r && r.state), get: (id) => rows[id] || null }, retry: no, drop: no } };
}

/**
 * @param {string} root  这个角色的 GATE_ROOT
 * @returns {{ok, error?, exists, counts:{stuck,rejected,dead,check}, total, items:{code,kind,state,at,label,reason,preview,channel,who}[]}}
 */
function readPending(root) {
  const empty = { stuck: 0, rejected: 0, dead: 0, check: 0 };
  if (!root) return { ok: false, error: L("没有 GATE_ROOT"), counts: empty, total: 0, items: [] };
  try {
    const { queue, exists } = readOnlyQueue(path.join(root, "turns.json"));
    const undeliveredFile = path.join(root, "undelivered.jsonl");
    const desk = makePendingDesk({
      queue,
      undelivered: () => makeUndelivered({ file: undeliveredFile }),
      inboundStore: { root },
      deadLetters: () => {
        const out = new Map();
        let names = [];
        try { names = fs.readdirSync(root); } catch { /* 没目录就没有死信 */ }
        for (const f of names.sort()) {
          const m = /^dead-(.+)\.jsonl$/.exec(f);
          if (m) out.set(m[1], makeDeadLetter({ file: path.join(root, f) }));
        }
        return out;
      },
    });
    const items = desk.list().map((it) => ({
      code: it.code, kind: it.kind, state: it.state, at: Date.parse(it.at || "") || 0,
      label: labelL(it.label), reason: short(it.reason, 60), preview: short(it.text),
      channel: it.channel || (it.entry && it.entry.channel) || "", system: !!it.system,
      who: it.kind === "turn" ? (it.system ? L("系统") : L("她→他")) : it.kind === "undelivered" ? L("他→她") : L("死信"),
    }));
    const counts = desk.counts();
    return { ok: true, exists: exists || fs.existsSync(undeliveredFile) || items.length > 0, counts, total: items.length, items };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).split("\n")[0], counts: empty, total: 0, items: [] };
  }
}

module.exports = { readPending };
