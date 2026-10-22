"use strict";
/**
 * 路由五档（2026-09-18）
 *
 * 每一档都对应一句「她真的问过的话」：
 *   1 原路      —— 「从哪个渠道进来 就从哪个渠道出去 不用他自己来分辨」
 *   3 最近活跃  —— 「发给她，走她当下在的那个渠道」
 *   5 暂存不猜  —— 宁可躺着等人看，也不许随便挑一条腿
 */
const { makeRouter, POLICY } = require("../../src/gate/routing");
const { makeEnvelope } = require("../../src/gate/envelope");

let pass = 0, fail = 0;
const check = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

const fromHer = (platform, chat_id, text = "在吗") => makeEnvelope({
  trace_id: "tr-" + platform + "-" + chat_id,
  source: { kind: "user", platform, chat_id, sender_id: chat_id },
  payload: { text }, identity: "alice",
});
const fromHim = (platform, chat_id) => makeEnvelope({
  trace_id: "tr-out", role: "assistant", source: { kind: "box", platform, chat_id },
  payload: { text: "嗯" },
});

console.log("[1] 有原路就原路 —— 前面贴多少东西都顶不掉");
{
  const r = makeRouter({ preferred: { platform: "telegram", chat_id: "861" } });
  r.noteInbound(fromHer("wechat", "wxid_x"));          // 最近活跃是微信
  const out = r.resolve({ replyTo: fromHer("telegram", "861") });
  check("回的是 TG 那条，就发 TG（不看最近活跃）", out.target.platform, "telegram");
  check("落点带着档位", out.policy, POLICY.REPLY);
}

console.log("\n[2] 显式指定落点 —— 听，但要过闸（2026-09-18 Alice推翻「工具给的一律扔掉」）");
{
  // 留渠道参数不是为了让他自己挑，是为了**她能指令他**：「你往哪哪给我发条消息」。
  const r = makeRouter();
  r.noteInbound(fromHer("telegram", "861"));
  r.noteInbound(fromHer("wechat", "Alice-wx"));
  r.noteInbound(fromHer("telegram", "861"));           // 她最后在 TG

  const byTool = r.resolve({ explicit: { platform: "wechat", chat_id: "Alice-wx" }, by: "tool" });
  check("工具说发微信 → 听他的", byTool.target.platform, "wechat");
  check("档位是显式", byTool.policy, POLICY.EXPLICIT);

  // 地址不该让模型记 —— 只给渠道，桥自己查她在那条腿上的地址
  const onlyChannel = r.resolve({ explicit: { platform: "wechat" }, by: "tool" });
  check("只给渠道不给地址 → 桥查出来", onlyChannel.target.chat_id, "Alice-wx");
  check("查出来的也算显式", onlyChannel.policy, POLICY.EXPLICIT);

  // 没指定就还是原来的规矩：按最近活跃
  check("不指定 → 最近活跃", r.resolve({}).target.platform, "telegram");

  // 那条腿桥根本没见过 → 暂存并说清楚，**不许静默改投别的渠道**
  const unknown = r.resolve({ explicit: { platform: "qq" }, by: "tool" });
  check("没见过的腿 → 不猜、不改投", unknown.ok, false);
  check("而且说得出为什么", /还不知道她在这条腿上的地址/.test(unknown.reason), true);

  // 指定的腿掉线 → 同样暂存，不偷偷换一条发
  const dead = makeRouter({ isAlive: (t) => t.platform !== "wechat" });
  dead.noteInbound(fromHer("telegram", "861"));
  dead.noteInbound(fromHer("wechat", "Alice-wx"));
  const r2 = dead.resolve({ explicit: { platform: "wechat" }, by: "tool" });
  check("指定的腿发不出去 → 暂存", r2.ok, false);
  check("理由点名那条腿", /wechat/.test(r2.reason), true);

  const bySystem = r.resolve({ explicit: { platform: "wechat", chat_id: "wxid_x" }, by: "checkin" });
  check("桥外面的产生者照样能指定", bySystem.target.platform, "wechat");
}

console.log("\n[3] 最近活跃只算她的入站 —— 8-29 投错渠道就栽在这儿");
{
  const r = makeRouter();
  r.noteInbound(fromHer("telegram", "861"));
  r.noteInbound(fromHim("wechat", "wxid_x"));          // 他在微信回了一句
  const out = r.resolve({});
  check("他在微信说话不改变落点", out.target.platform, "telegram");
  check("她转去微信说话，落点才跟着走", (() => {
    r.noteInbound(fromHer("wechat", "wxid_x"));
    return r.resolve({}).target.platform;
  })(), "wechat");
}

console.log("\n[4] 那条腿掉线 → 首选路（配置给的，不是代码写死的）");
{
  const dead = new Set(["wechat"]);
  const r = makeRouter({
    preferred: { platform: "telegram", chat_id: "861" },
    isAlive: (route) => !dead.has(route.platform),
  });
  r.noteInbound(fromHer("wechat", "wxid_x"));
  const out = r.resolve({});
  check("微信发不出去就走首选", out.target.platform, "telegram");
  check("档位是首选", out.policy, POLICY.PREFERRED);
}

console.log("\n[5] 都没有 → 暂存，不猜");
{
  const r = makeRouter();                                // 没有入站、没配首选
  const out = r.resolve({});
  check("不给落点", out.ok, false);
  check("档位是暂存", out.policy, POLICY.HOLD);
  check("说得出为什么", /还没有过任何入站/.test(out.reason), true);

  const allDead = makeRouter({
    preferred: { platform: "telegram", chat_id: "861" },
    isAlive: () => false,
  });
  allDead.noteInbound(fromHer("wechat", "wxid_x"));
  const out2 = allDead.resolve({});
  check("腿全挂了也不许乱投", out2.ok, false);
  check("说清楚是腿的问题", /发不出去/.test(out2.reason), true);
}

console.log("\n[6] 残缺的来路不算数（宁可走下一档，也不发去一个空地址）");
{
  const r = makeRouter({ preferred: { platform: "telegram", chat_id: "861" } });
  const broken = makeEnvelope({
    trace_id: "tr-b", source: { kind: "user", platform: "telegram", chat_id: "", sender_id: "861" },
    payload: { text: "x" },
  });
  const out = r.resolve({ replyTo: broken });
  check("原路少了 chat_id → 落到首选，不是发去空地址", out.policy, POLICY.PREFERRED);
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
