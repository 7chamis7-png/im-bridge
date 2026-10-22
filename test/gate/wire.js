"use strict";
/** 装配：默认关着、微信那一格每轮问一次主备、preflight 只报告不改。 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { makeFakeBox } = require("../../src/gate/box");
const { buildGate } = require("../../src/gate/wire");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-wire-"));
const gateFlag = path.join(root, ".gate-enabled");
let pass = 0, fail = 0;
const check = (n, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(g)} want=${JSON.stringify(w)}`));
  ok ? pass++ : fail++;
};
const mkPlugin = (channel, transport, caps) => ({
  channel, transport,
  capabilities: caps,
  health: () => ({ platform: "supported", plugin: "wired", availability: "ready" }),
  send: async () => ({ nativeId: "n" }),
});
const ALL = { send_text: "supported", send_file: "supported", send_voice: "supported",
              send_sticker: "supported", send_generated_image: "supported", react: "supported" , start_call: "supported", end_call: "supported" };
const TEXT_ONLY = { send_text: "supported", send_file: "unsupported", send_voice: "unsupported",
                    send_sticker: "unsupported", send_generated_image: "unsupported", react: "unsupported",
                    start_call: "unsupported", end_call: "unsupported" };

function build() {
  return buildGate({ box: makeFakeBox(),
    root: path.join(root, "store"),
    coldFile: path.join(root, "cold.jsonl"),
    plugins: {
      telegram: mkPlugin("telegram", "botapi", ALL),
      imessage: mkPlugin("imessage", "photon", ALL),
      wechatA11y: mkPlugin("wechat", "a11y", TEXT_ONLY),
      wechatImbot: mkPlugin("wechat-bot", "imbot", ALL),
    },
    capabilities: { synthesize_voice: async () => ({}), generate_image: async () => ({}) },
    identities: { "wechat:wxid_alice": "alice", "wechat-bot:wxid_alice": "alice" },
    files: { gateEnabled: gateFlag },
  });
}

// 装配必须显式表态要不要盒子（2026-09-18）
try {
  const { buildGate: bg } = require("../../src/gate/wire");
  bg({ root: "/tmp/x", coldFile: "/tmp/x/c.jsonl" });
  console.log("  FAIL 忘了传 box 居然装配成功了");
} catch (e) {
  console.log("  " + (/要 box/.test(e.message) ? "OK  " : "FAIL") + " 忘了传 box → 装配当场报（不许默默空着）");
}

console.log("\n[1] 装上默认是关着的 —— 不会自己接管");
let g = build();
check("enabled=false", g.enabled(), false);

console.log("\n[2] 放开关文件才接管；删掉就回老路");
fs.writeFileSync(gateFlag, "");
check("放了文件 = 开", build().enabled(), true);
fs.unlinkSync(gateFlag);
check("删了文件 = 关", build().enabled(), false);

console.log("\n[3] 真实微信和微信 bot 各占一格（2026-09-18 Alice拆开，没有选择器）");
g = build();
check("wechat = 她自己的微信（a11y 直读库）", g.outbound.plugins.get("wechat").transport, "a11y");
check("wechat-bot = im.bot 上那个 bot 账号", g.outbound.plugins.get("wechat-bot").transport, "imbot");
check("两格是两个插头，不互相顶掉",
  g.outbound.plugins.get("wechat") === g.outbound.plugins.get("wechat-bot"), false);
check("没接的渠道就是没有", g.outbound.plugins.has("qq"), false);

console.log("\n[4] 同一句话，两个渠道能力不同，闸给的答案也不同");
(async () => {
  const turn = { turnId: "t1", replyToEventId: "e1",
    inboundEvent: { eventId: "e1", channel: "wechat", chatId: "wxid_alice", accountId: "wx" } };
  g = build();   // 她的真实微信：无障碍只会打字
  // 不走工具名（那张表已删，见 SPEC 铁律 2）——直接按意图问出闸。
  const r1 = await g.outbound.deliver({ ...turn, text: "看这张", intent: "send_generated_image" });
  check("真实微信发图 → blocked", r1.outcome, "blocked");
  check("原因是平台不支持", r1.reason, "platform_unsupported");

  // 换的是**渠道**，不是同一个渠道底下的技术路径
  const botTurn = { turnId: "t2", replyToEventId: "e2",
    inboundEvent: { eventId: "e2", channel: "wechat-bot", chatId: "wxid_alice", accountId: "wx" } };
  const g2 = build();
  const r2 = await g2.outbound.deliver({ ...botTurn, text: "看这张", intent: "send_generated_image" });
  check("微信 bot 发图 → sent", r2.outcome, "sent");
  check("回的是 bot 那条渠道，不冒充真实微信", r2.channel, "wechat-bot");

  console.log("\n[5] preflight：只报告，不改也不启用");
  const g3 = build();
  const pre = g3.preflight();
  check("点名了缺的共用能力", pre.缺的共用能力.sort(), ["acoustic", "file_store", "transcribe"]);
  check("四个插头都列出来了", pre.插头.length, 4);
  check("没有漏表态的", pre.插头.every((r) => !r.漏表态 || r.漏表态.length === 0), true);
  check("报告开关状态", pre.开关, "关（走老路）");
  check("报告接了哪几条腿", pre.接了几条腿.sort(), ["imessage", "telegram", "wechat", "wechat-bot"]);
  check("切换清单六项都在", pre.切换清单.length, 6);
  check("跑完 preflight 依然没被启用", g3.enabled(), false);

  // ==== 2026-09-18：装配必须一次装到「腿能自己活着」 ====
  // 以前 buildGate 只装到 intake 为止，scripts/gate-box-live.js 自己手搓了一套
  // pipeline/router/undelivered —— 两套装配并存、各自漂移，正是冷层那个 bug 的病根。
  // 这一节盯的就是「**装配出来的那条路**真能跑」，不是「零件各自能跑」。
  console.log("\n[6] 装配出来的桥真能跑一轮（她说一句 → 他回一句）");
  {
    const sent = [];
    const HER = "1000000001";
    const tgPlugin = {
      channel: "telegram", transport: "botapi", capabilities: ALL,
      health: () => ({ platform: "supported", plugin: "wired", availability: "ready" }),
      send: async ({ chatId, text }) => { sent.push({ chatId, text }); return { nativeId: "m" + sent.length }; },
      toDelivery: async (raw) => ({
        channel: "telegram", senderId: String(raw.from.id), chatId: String(raw.chat.id),
        chatType: "private", nativeId: String(raw.message_id), text: raw.text,
        receivedAt: new Date().toISOString(), media: [],
      }),
      // 这条腿会自己捞：第一次给一条，之后空手 —— 够验「捞 → 主循环 → 发回去」整条。
      poll: async ({ since }) => (since > 100 ? { items: [] } : { items: [{
        update_id: 100,
        message: { message_id: 2, text: "腿自己捞上来的",
          chat: { id: Number(HER), type: "private" }, from: { id: Number(HER) } },
      }] }),
    };
    const g6 = buildGate({
      box: makeFakeBox({ answer: () => "想你了" }),
      root: path.join(root, "live"),
      coldFile: path.join(root, "live-cold.jsonl"),
      plugins: { telegram: tgPlugin },
      identities: { ["telegram:" + HER]: "alice" },
      files: { gateEnabled: path.join(root, "live", ".gate-enabled") },
      preferredRoute: { platform: "telegram", chat_id: HER },
    });
    check("装配给出了主循环", Boolean(g6.pipe), true);
    check("装配给出了投递口", typeof g6.outlet.deliver, "function");
    check("出闸拿到了「发不出去的账」", Boolean(g6.undelivered), true);

    const r = await g6.pipe.ingest({ channel: "telegram", raw: {
      message_id: 1, text: "在吗", chat: { id: Number(HER), type: "private" }, from: { id: Number(HER) },
    } });
    check("她这一轮被接住了", r.accepted, true);
    await new Promise((res) => setTimeout(res, 20));
    check("他回的话真发出去了", sent.map((x) => x.text), ["想你了"]);
    check("发回的是她那条来路", sent[0].chatId, HER);

    const rows = fs.readFileSync(path.join(root, "live-cold.jsonl"), "utf8")
      .trim().split("\n").map((l) => JSON.parse(l));
    check("一来一回都落了冷层", rows.map((x) => x.role), ["user", "assistant"]);
    check("冷层还是只有四个字段", [...new Set(rows.flatMap((x) => Object.keys(x)))].sort(),
      ["at", "id", "role", "text"]);

    // ==== 腿自己活着：捞 → 主循环 → 盒子 → 出闸 → 发回去，中间不用人手喂 ====
    // 游标和死信的路径由装配从 root 推出来（调用方给的是 root，代码里没有写死路径）。
    const leg = g6.attach({ channel: "telegram" });
    check("挂得上自己捞消息的腿", typeof leg.run, "function");
    await leg.tick({ timeoutSec: 1 });
    await new Promise((res) => setTimeout(res, 20));
    check("腿自己捞上来那条也走完了整条路", sent.map((x) => x.text), ["想你了", "想你了"]);
    const cur = JSON.parse(fs.readFileSync(path.join(root, "live", "cursor-telegram.json"), "utf8"));
    check("消化完了才推游标", cur.cursor, 101);
    await leg.tick({ timeoutSec: 1 });
    check("游标推过去了就不再捞第二遍", sent.length, 2);
  }

  // 影子那种只读的桥（显式 box=null）不该有主循环
  {
    const shadow = buildGate({
      box: null, root: path.join(root, "ro"), coldFile: path.join(root, "ro-cold.jsonl"),
      plugins: { telegram: mkPlugin("telegram", "botapi", ALL) },
      files: { gateEnabled: path.join(root, "ro", ".gate-enabled") },
    });
    check("只读的桥没有主循环", shadow.pipe, null);
    let msg = "";
    try { shadow.attach({ channel: "telegram" }); } catch (e) { msg = e.message; }
    check("只读的桥挂腿会当场报", /没有盒子/.test(msg), true);
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}   (隔离目录 ${root})`);
  process.exit(fail ? 1 : 0);
})();
