"use strict";
// 2026-09-20：TG 的选项按钮和「回复某一条」接通 —— 工具口递 extras、TG 腿收按钮回调。
const assert = require("assert");
const { makeToolSocket } = require("../../src/gate/tool-socket");
const { TelegramPlugin } = require("../../src/gate/plugins/telegram");

(async () => {
  let n = 0;
  const ok = (m) => { n += 1; console.log("  OK  " + m); };

  // ——— 工具口：按这一轮的渠道分类专属参数 ———
  const sent = [];
  let channel = "telegram";
  const tools = new Map([["reply", { name: "reply", intent: "send_text" }], ["react", { name: "react", intent: "react" }]]);
  const sock = makeToolSocket({ file: "/tmp/unused.sock", tools,
    outbound: { deliver: async (t) => { sent.push(t); return { outcome: "sent", channel }; } },
    binding: { lookup: () => ({ eventId: "ev", channel, chatId: "c" }) },
    activeTurn: () => ({ threadId: "th", turnId: "tu" }) });
  const kb = [{ text: "火锅", callback_data: "火锅" }, { text: "烧烤", callback_data: "烧烤" }];

  let r = await sock.handle({ id: "1", tool: "reply", text: "吃啥", args: { inline_keyboard: kb, reply_to_message_id: 42 } });
  assert.deepStrictEqual(sent[0].extras, { inline_keyboard: kb, reply_to_message_id: 42 });
  assert.deepStrictEqual(r.unsupportedExtras, []);
  ok("TG 轮：按钮和 reply_to 进了 extras");

  channel = "wechat";
  r = await sock.handle({ id: "2", tool: "reply", text: "吃啥", args: { inline_keyboard: kb } });
  assert.deepStrictEqual(sent[1].extras, {});
  assert.strictEqual(sent[1].text, "吃啥");
  assert.strictEqual(r.unsupportedExtras.length, 1);
  assert.strictEqual(r.unsupportedExtras[0].name, "inline_keyboard");
  ok("微信轮：字照发，按钮明说没出去");

  channel = "telegram";
  await sock.handle({ id: "3", tool: "react", args: { emoji: "❤️" } });
  assert.strictEqual(sent[2].toolArgs.emoji, "❤️");
  ok("react 的 toolArgs 照旧整份给（没被分类挪走）");

  // ——— TG 腿：收按钮回调 ———
  const calls = [];
  const tg = new TelegramPlugin({ call: async (method, params) => {
    calls.push([method, params]);
    if (method === "getUpdates") {
      return [
        { update_id: 10, message: { message_id: 7, from: { id: 1 }, chat: { id: 1, type: "private" }, date: 1, text: "嗨" } },
        { update_id: 11, callback_query: { id: "cbA", data: "火锅", from: { id: 1, first_name: "Alice" },
          message: { message_id: 99, chat: { id: 1, type: "private" }, from: { id: 555, is_bot: true } } } },
        { update_id: 12, callback_query: { id: "cbB", data: "火锅", from: { id: 1 },
          message: { message_id: 99, chat: { id: 1, type: "private" } } } },
      ];
    }
    if (method === "sendMessage") return { message_id: 100 };
    return true;
  } });
  const polled = await tg.poll({ since: 10 });
  assert.strictEqual(polled.cursor, 13);
  assert.strictEqual(polled.items.length, 3);
  const press = polled.items[1].message;
  assert.strictEqual(press.text, "（点了按钮）火锅");
  assert.notStrictEqual(polled.items[1].message.message_id, polled.items[2].message.message_id);
  assert.ok(calls.some(([m, p]) => m === "answerCallbackQuery" && p.callback_query_id === "cbA"));
  assert.ok(calls.find(([m]) => m === "getUpdates")[1].allowed_updates.includes("callback_query"));
  ok("按钮回调变成她的一句话，先应答不让转圈，同一排按两次不撞号");

  const d = await tg.toDelivery(press);
  assert.ok(JSON.stringify(d).includes("（点了按钮）火锅") && JSON.stringify(d).includes("99-btn-cbA"));
  ok("按钮消息能正常变成交付（正文、编号都在）");

  // ——— TG 腿：发的时候真带上按钮和 reply_to ———
  await tg.send({ operationId: "o", chatId: "1", text: "吃啥", intent: "send_text",
    extras: { inline_keyboard: kb, reply_to_message_id: 42 } });
  const sm = calls.filter(([m]) => m === "sendMessage").pop()[1];
  assert.deepStrictEqual(sm.reply_markup, { inline_keyboard: [[kb[0]], [kb[1]]] });
  assert.strictEqual(sm.reply_to_message_id, 42);
  ok("发出去的 sendMessage 带着按钮和 reply_to");

  // ——— 2026-09-23：命令按钮（/model 弹的那排）——
  const tg2 = new TelegramPlugin({ call: async (method) => method === "getUpdates"
    ? [{ update_id: 20, callback_query: { id: "cbM", data: "/model claude-fable-5[1m]", from: { id: 1 },
        message: { message_id: 200, chat: { id: 1, type: "private" } } } }] : true });
  const cmdPress = (await tg2.poll({ since: 20 })).items[0].message;
  assert.strictEqual(cmdPress.text, "/model claude-fable-5[1m]");
  ok("命令按钮原样交出斜杠命令（不加「点了按钮」前缀，不然命令层认不出）");

  console.log(`\n通过 ${n} / 失败 0`);
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
