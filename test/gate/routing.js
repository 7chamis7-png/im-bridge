"use strict";
/**
 * Routing, five policies:
 *   1 reply route  — reply on the channel the message came from
 *   3 last active  — proactive messages go where the owner currently is
 *   5 hold         — better to wait than to pick an arbitrary leg
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
  payload: { text }, identity: "owner",
});
const fromHim = (platform, chat_id) => makeEnvelope({
  trace_id: "tr-out", role: "assistant", source: { kind: "box", platform, chat_id },
  payload: { text: "嗯" },
});

console.log("[1] 有原路就原路 —— 前面贴多少东西都顶不掉");
{
  const r = makeRouter({ preferred: { platform: "telegram", chat_id: "861" } });
  r.noteInbound(fromHer("wechat", "wxid_x"));          // last active is WeChat
  const out = r.resolve({ replyTo: fromHer("telegram", "861") });
  check("回的是 TG 那条，就发 TG（不看最近活跃）", out.target.platform, "telegram");
  check("落点带着档位", out.policy, POLICY.REPLY);
}

console.log("\n[2] 显式指定落点 —— 听，但要过闸");
{
  // the channel parameter lets the owner instruct the agent ("message me on X")
  const r = makeRouter();
  r.noteInbound(fromHer("telegram", "861"));
  r.noteInbound(fromHer("wechat", "wxid_owner"));
  r.noteInbound(fromHer("telegram", "861"));           // owner 最后在 TG

  const byTool = r.resolve({ explicit: { platform: "wechat", chat_id: "wxid_owner" }, by: "tool" });
  check("工具说发微信 → 听 agent 的", byTool.target.platform, "wechat");
  check("档位是显式", byTool.policy, POLICY.EXPLICIT);

  // only the channel is given; the bridge looks up the owner's address on that leg
  const onlyChannel = r.resolve({ explicit: { platform: "wechat" }, by: "tool" });
  check("只给渠道不给地址 → 桥查出来", onlyChannel.target.chat_id, "wxid_owner");
  check("查出来的也算显式", onlyChannel.policy, POLICY.EXPLICIT);

  // nothing specified: last active
  check("不指定 → 最近活跃", r.resolve({}).target.platform, "telegram");

  // leg never seen → hold with a reason; never silently reroute
  const unknown = r.resolve({ explicit: { platform: "qq" }, by: "tool" });
  check("没见过的腿 → 不猜、不改投", unknown.ok, false);
  check("而且说得出为什么", /还不知道 owner 在这条腿上的地址/.test(unknown.reason), true);

  // requested leg offline → hold as well
  const dead = makeRouter({ isAlive: (t) => t.platform !== "wechat" });
  dead.noteInbound(fromHer("telegram", "861"));
  dead.noteInbound(fromHer("wechat", "wxid_owner"));
  const r2 = dead.resolve({ explicit: { platform: "wechat" }, by: "tool" });
  check("指定的腿发不出去 → 暂存", r2.ok, false);
  check("理由点名那条腿", /wechat/.test(r2.reason), true);

  const bySystem = r.resolve({ explicit: { platform: "wechat", chat_id: "wxid_x" }, by: "checkin" });
  check("桥外面的产生者照样能指定", bySystem.target.platform, "wechat");
}

console.log("\n[3] 最近活跃只算 owner 的入站");
{
  const r = makeRouter();
  r.noteInbound(fromHer("telegram", "861"));
  r.noteInbound(fromHim("wechat", "wxid_x"));          // the agent replied on WeChat
  const out = r.resolve({});
  check("agent 在微信说话不改变落点", out.target.platform, "telegram");
  check("owner 转去微信说话，落点才跟着走", (() => {
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
