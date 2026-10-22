"use strict";
/**
 * 阶段 3 判决：接第三条渠道，src/gate/ 的核心文件一行都不用改。
 * 三条渠道同时进闸，共用一条编号序列（A29）。隔离跑。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { GateStore } = require("../../src/gate/store");
const { ColdWriter } = require("../../src/gate/cold-writer");
const { InboundGate } = require("../../src/gate/inbound");
const { OutboundGate } = require("../../src/gate/outbound");
const { IMessagePlugin } = require("../../src/gate/plugins/imessage");
const { WeChatPlugin } = require("../../src/gate/plugins/wechat");
const { TelegramPlugin } = require("../../src/gate/plugins/telegram");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-3ch-"));
const store = new GateStore({ root });
const cold = new ColdWriter({ file: path.join(root, "cold.jsonl") });

const sent = [];
const mk = (ch) => async ({ chatId, text, operationId }) => { sent.push({ ch, chatId, text, operationId }); return ch + "-" + sent.length; };

const im = new IMessagePlugin({ sender: mk("imessage") });
const wx = new WeChatPlugin({ sender: mk("wechat") });
const tg = new TelegramPlugin({
  sender: mk("telegram"),
  transcribe: async () => "这是语音转出来的文字",   // 转写在闸外，插件自己调
});

const IDENT = {
  "imessage:+15550100001": "alice",
  "wechat:Alice-wx": "alice",
  "telegram:1000000001": "alice",
};
const inGate = new InboundGate({ store, cold, identities: IDENT });
const outGate = new OutboundGate({ store, cold, plugins: new Map([["imessage", im], ["wechat", wx], ["telegram", tg]]) });

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + name + (ok ? "" : "  got=" + JSON.stringify(got) + " want=" + JSON.stringify(want)));
  ok ? pass++ : fail++;
}

(async () => {
  console.log("\n[1] 三条渠道依次进闸，共用一条序列 (A29)");
  const a = inGate.accept(im.toDelivery({ id: 1, handle: "+15550100001", text: "iMessage 说的", date: "2026-09-17T20:00:00Z" }));
  check("iMessage -> #1", a.event.userSeq, 1);

  const b = inGate.accept(wx.toDelivery({ local_id: 500, local_type: 1, create_time: 1789600000,
    sender: "Alice-wx", raw: Buffer.from("微信说的", "utf8") }));
  check("微信 -> #2（不是 #1）", b.event.userSeq, 2);

  const c = inGate.accept(await tg.toDelivery({ message_id: 40001, text: "TG 说的",
    chat: { id: 1000000001, type: "private" }, from: { id: 1000000001 }, date: 1789600100 }));
  check("Telegram -> #3", c.event.userSeq, 3);
  check("三条渠道标识各自正确", [a.event.channel, b.event.channel, c.event.channel], ["imessage", "wechat", "telegram"]);

  console.log("\n[2] Telegram 特有的东西，核心一无所知也能跑");
  const g = await tg.toDelivery({ message_id: 40002, chat: { id: -100123, type: "supergroup" },
    from: { id: 1000000001 }, date: 1789600200, text: "群里说的" });
  check("群聊被识别", g.chatType, "group");
  const v = await tg.toDelivery({ message_id: 40003, chat: { id: 1000000001, type: "private" },
    from: { id: 1000000001 }, date: 1789600300, voice: { file_id: "AwAC123" } });
  check("语音在闸外转写完才交付", v.processing, ["transcribed"]);
  check("交付的是文字不是 file_id", v.text, "这是语音转出来的文字");
  check("原始语音仍作为媒体保留", v.media[0].kind, "voice");
  const vr = inGate.accept(v);
  check("闸接受转写后的文本", vr.event.verdict, "accepted");

  console.log("\n[3] 出闸按来源回信，三条路各回各的");
  for (const [name, ev] of [["imessage", a.event], ["wechat", b.event], ["telegram", c.event]]) {
    const r = await outGate.deliver({ turnId: "t-" + name, text: "回 " + name, replyToEventId: ev.eventId, inboundEvent: ev });
    check(name + " 回到原路", [r.outcome, r.channel], ["sent", name]);
  }
  check("三条都真的发出去了", sent.map((s) => s.ch), ["imessage", "wechat", "telegram"]);

  console.log("\n[4] 冷层：一个写手，三条渠道");
  const lines = fs.readFileSync(path.join(root, "cold.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  // 2026-09-18：渠道和编号是技术字段，归日志；冷层只有 id/role/at/text（SPEC §6）。
  check("冷层就四个字段", [...new Set(lines.flatMap((l) => Object.keys(l)))].sort(),
    ["at", "id", "role", "text"]);
  const log = fs.readFileSync(path.join(root, "events.jsonl"), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l));
  const delivered = log.filter((e) => e.kind === "user_input.delivered");
  check("三条渠道都落了冷层", [...new Set(delivered.map((e) => e.channel))].sort(), ["imessage", "telegram", "wechat"]);
  check("编号连续 1..4", delivered.map((e) => e.userSeq), [1, 2, 3, 4]);
  check("每条都指得回冷层", delivered.every((e) => lines.some((l) => l.id === e.coldId)), true);

  console.log("\n通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})();
