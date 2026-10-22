"use strict";
/**
 * 信封（2026-09-18）—— 统一消息格式
 *
 * 这个文件里有两条是**守卫**，不是普通用例：
 *   · 冷层形状只许有四个字段（铁律 4）—— 谁往冷层加字段，这里当场红
 *   · 日志里不许出现正文 —— 正文只有冷层一份
 */
const {
  SCHEMA_VERSION, KINDS, COLD_FIELDS,
  makeEnvelope, assertEnvelope, forLog, forCold, coldId,
} = require("../../src/gate/envelope");

let pass = 0, fail = 0;
const check = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};
const throws = (n, fn, re) => {
  try { fn(); check(n, "没抛错", "该抛错"); }
  catch (e) { check(n + "（" + String(e.message).slice(0, 22) + "…）", re.test(e.message), true); }
};

const her = () => makeEnvelope({
  trace_id: "tr-1",
  source: { kind: "user", platform: "telegram", chat_id: "1000000001", sender_id: "1000000001", native_id: "39924" },
  payload: { text: "明天几点的火车" },
  identity: "alice",
});

console.log("[1] 来路是字段，不是正文里的一行字");
const e = her();
check("平台在字段里", e.source.platform, "telegram");
check("chat_id 是裸的（不带渠道前缀）", e.source.chat_id, "1000000001");
check("正文一个字没被动过", e.payload.text, "明天几点的火车");
check("正文里没有 <channel> 那类标签", /<channel|chat_id=/.test(e.payload.text), false);

console.log("\n[2] 谁产生的要说清楚 —— user 以外都不是她说的话");
check("她说的", e.source.kind, "user");
const cron = makeEnvelope({
  trace_id: "tr-2", source: { kind: "system", producer: "晨笺" },
  payload: { text: "该问问她吃饭了没" },
});
check("晨笺也进同一条路", cron.source.kind, "system");
check("它没有平台（不从任何渠道来）", cron.source.platform, "");
check("谁推的原样带着（桥不认识这个值）", cron.source.producer, "晨笺");
check("桥只分三类", KINDS, ["user", "system", "box"]);
check("桥的代码里不许枚举具体工具", KINDS.some((k) => /diary|pulse|checkin/.test(k)), false);
// 换个没听说过的产生者，桥照样收 —— 「工具全可拆」的落点
const newbie = makeEnvelope({
  trace_id: "tr-2b", source: { kind: "system", producer: "某个还没写的东西" },
  payload: { text: "随便什么" },
});
check("新产生者不用改桥", newbie.source.producer, "某个还没写的东西");

console.log("\n[3] 一定错的当场挡");
// 用词必须跟入闸是同一套（2026-09-18 踩过：这边 ok、那边 accepted，一串起来就炸）
const { verifyInbound } = require("../../src/gate/verify");
check("验收用词跟入闸对得上", (() => {
  const { VERDICTS } = require("../../src/gate/envelope");
  return VERDICTS.includes(verifyInbound({ channel: "telegram", text: "x", media: [], processing: ["none"] }).verdict);
})(), true);
throws("没有 trace_id", () => makeEnvelope({ source: { kind: "user" }, payload: { text: "在吗" } }), /trace_id/);
throws("不认识的 kind", () => makeEnvelope({ trace_id: "t", source: { kind: "随便" }, payload: { text: "x" } }), /打哪来|谁产生的/);
throws("她发来的却没有 sender_id", () => makeEnvelope({
  trace_id: "t", source: { kind: "user", platform: "telegram", chat_id: "1" }, payload: { text: "在吗" },
}), /sender_id|认不出人/);
throws("空轮", () => makeEnvelope({ trace_id: "t", source: { kind: "system" }, payload: { text: "  " } }), /空轮/);
const broken = makeEnvelope({
  trace_id: "t3", source: { kind: "user", sender_id: "1000000001" },
  payload: { text: "" }, verdict: "no_content",
});
check("但验收没过的可以空（要照实告诉他）", broken.verdict, "no_content");

console.log("\n[4] 冷层：只有四样，一个字段都不许加（铁律 4 的守卫）");
const cold = forCold(e);
check("字段就这四个", Object.keys(cold).sort(), COLD_FIELDS.slice().sort());
check("四样是 id/role/at/text", COLD_FIELDS, ["id", "role", "at", "text"]);
check("没有 schema_version", "schema_version" in cold, false);
check("没有 trace_id / 渠道 / 验收结论", ["trace_id", "platform", "verdict", "seq"].some((k) => k in cold), false);
check("正文原样", cold.text, "明天几点的火车");

const withNote = makeEnvelope({
  trace_id: "tr-9", role: "assistant", source: { kind: "box" },
  payload: { text: "我看看" },
  cold: { write: true, text: "我看看" },
});
check("出站也是同一套", forCold(withNote).role, "assistant");
check("「没发出去」这类标记不进正文", /桥附注|undelivered/.test(forCold(withNote).text), false);

console.log("\n[5] 日志：带版本号，不带正文，只留指向冷层的 id");
const log = forLog(e, { delivery: "sent" });
check("带 schema_version", log.schema_version, SCHEMA_VERSION);
check("**没有正文**", "text" in log, false);
check("指得到冷层那条", log.cold_id, coldId(e));
check("冷层那条的 id 对得上", forCold(e).id, log.cold_id);
check("trace_id 在（一条 grep 看全程）", log.trace_id, "tr-1");
check("技术字段都在日志这边", [log.platform, log.identity, log.verdict], ["telegram", "alice", "accepted"]);
check("能挂额外的投递状态", log.delivery, "sent");

const noCold = makeEnvelope({
  trace_id: "tr-10", source: { kind: "system", producer: "内部" }, payload: { text: "内部通知" },
  cold: { write: false },
});
check("说了不进冷层的，日志里就没有指向", forLog(noCold).cold_id, null);

console.log("\n[6] 落点由路由给，工具和晨笺都指定不了");
check("刚造出来还没落点", e.target, null);
const routed = makeEnvelope({
  trace_id: "tr-11", role: "assistant", source: { kind: "box" },
  payload: { text: "七点二十" },
  target: { person: "alice", platform: "telegram", chat_id: "1000000001", policy: "reply_route" },
});
check("落点带着「按哪一档解析出来的」", routed.target.policy, "reply_route");

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
