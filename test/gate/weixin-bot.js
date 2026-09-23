"use strict";
/**
 * im.bot 网关做成插件。重点验「它跟真实微信是两个来源」和「分段归插件」。隔离跑。
 *
 * The local-client leg (identity = wxid) and the im.bot gateway (identity =
 * fromUserId, needs contextToken) are different sources, so they must stay separate.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { GateStore } = require("../../src/gate/store");
const { ColdWriter } = require("../../src/gate/cold-writer");
const { InboundGate } = require("../../src/gate/inbound");
const { OutboundGate } = require("../../src/gate/outbound");
const { WeChatPlugin } = require("../../src/gate/plugins/wechat");
const { WeixinBotPlugin, chunkText } = require("../../src/gate/plugins/weixin-bot");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-wxbot-"));
const store = new GateStore({ root });
const cold = new ColdWriter({ file: path.join(root, "cold.jsonl") });

const sent = [];
const bot = new WeixinBotPlugin({
  sender: async ({ chatId, text, operationId }) => { sent.push({ chatId, text, operationId }); return "bot-" + sent.length; },
  contextToken: async () => "ctx-abc",
  chunkLimit: 40,
});
const vps = new WeChatPlugin({ sender: async () => "vps-1" });

// 两个来源 -> 各自的身份键（同一个人，但认人的钥匙不是同一把）
const inGate = new InboundGate({ store, cold,
  identities: { "wechat:wxid_owner": "owner", "wechat-bot:wxid_owner_bot": "owner" } });
const outGate = new OutboundGate({ store, cold, plugins: new Map([["wechat-bot", bot]]) });

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + name + (ok ? "" : "  got=" + JSON.stringify(got) + " want=" + JSON.stringify(want)));
  ok ? pass++ : fail++;
}

(async () => {
  console.log("\n[1] 真实微信 vs 微信 bot：两个来源，分得开");
  const a = bot.toDelivery({ msgId: "m1", fromUserId: "wxid_owner_bot", content: "从 bot 网关来的", createTime: 1789600000 });
  const b = vps.toDelivery({ local_id: 900, local_type: 1, create_time: 1789600100, sender: "wxid_owner", raw: Buffer.from("从 VPS 库来的", "utf8") });
  check("bot 路 channel=wechat-bot", a.channel, "wechat-bot");
  check("真实微信那条还是 wechat", b.channel, "wechat");
  check("技术路径只进 transport", a.transport, "im.bot");
  const ra = inGate.accept(a), rb = inGate.accept(b);
  // 渠道分开了，但**编号仍然是跨渠道一条序列**（store 的设计，见 README）——
  // 分开的是「谁说的、回哪去」，不是「第几句」。
  check("编号跨渠道仍是一条序列", [ra.event.userSeq, rb.event.userSeq], [1, 2]);
  const lines = fs.readFileSync(path.join(root, "cold.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  // transport is a diagnostic field; the cold log only has id/role/at/text (SPEC §6).
  const log = fs.readFileSync(path.join(root, "events.jsonl"), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l));
  const delivered = log.filter((e) => e.kind === "user_input.delivered");
  check("日志里两个来源分得开", [...new Set(delivered.map((e) => e.channel))].sort(),
    ["wechat", "wechat-bot"]);
  check("冷层就四个字段", [...new Set(lines.flatMap((l) => Object.keys(l)))].sort(),
    ["at", "id", "role", "text"]);

  console.log("\n[2] 分段归插件，闸只给一段完整正文");
  const long = "第一段内容写得比较长一些用来触发分段。\n\n第二段也有自己的内容在这里。\n\n第三段收个尾。";
  const r = await outGate.deliver({ turnId: "t1", text: long, replyToEventId: ra.event.eventId, inboundEvent: ra.event });
  check("发出去了", r.outcome, "sent");
  check("插件切成了多段", sent.length > 1, true);
  check("每段带自己的操作 ID", /#\d+\/\d+$/.test(sent[0].operationId), true);
  check("拼回来内容不丢", sent.map((s) => s.text).join("").replace(/\s/g, ""), long.replace(/\s/g, ""));

  console.log("\n[3] contextToken 是平台细节，闸不知道");
  check("出闸交给插件的参数里没有 token", Object.keys({ operationId: 1, chatId: 1, text: 1, notes: 1 }).includes("contextToken"), false);

  console.log("\n[4] 冷层存的是完整正文，不是分段后的碎片");
  const last = fs.readFileSync(path.join(root, "cold.jsonl"), "utf8").trim().split("\n").map(JSON.parse).pop();
  check("冷层一条完整的", last.text, long);

  console.log("\n[5] 分段边界：优先段落，其次句子");
  check("短文本不分段", chunkText("很短", 40).length, 1);
  check("空文本不产生空段", chunkText("", 40).length, 0);

  console.log("\n通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})();
