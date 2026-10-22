"use strict";
/**
 * 2026-09-17 影子第一夜三个洞的回归测试。
 *
 * 三个洞全长在**驱动层**（shadow.js），闸和插件当时是干净的 —— 96 项测试一条没红，
 * 因为没有一项覆盖这三种形态。这个文件补的就是那个空白：
 *
 *  1. 读微信库没有「入站/出站」之分，收发躺在同一张表里，靠 real_sender_id 区分。
 *     驱动每行硬写 "Alice-wx"，812 条里 620 条是Nova自己说的话被当成她的入站。
 *  2. TG 驱动取 origin.inner —— 这个字段不存在，1633 条全空。
 *  3. 空事件（no_content）闸照样放行、照样投递，注入文本是「原文：」后面一片空白。
 *
 * 隔离跑，不碰生产冷层，不碰Nova。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { GateStore } = require("../../src/gate/store");
const { ColdWriter } = require("../../src/gate/cold-writer");
const { InboundGate } = require("../../src/gate/inbound");
const { WeChatPlugin } = require("../../src/gate/plugins/wechat");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-dir-"));
const ALICE = "wxid_example0001";      // 她（正例核过：md5 == 你俩会话表的表名摘要）
const ME = "wxid_6wovscflqr3712";         // 本机，即Nova自己发出去的
const OTHER = "wxid_zola7b8bqm5n22";      // 另一个联系人
const IDENTITIES = { ["wechat:" + ALICE]: "alice", "telegram:1000000001": "alice" };

function newGate(tag) {
  const store = new GateStore({ root: path.join(root, tag) });
  const cold = new ColdWriter({ file: path.join(root, tag, "cold.jsonl") });
  return new InboundGate({ store, cold, identities: IDENTITIES });
}

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + name + (ok ? "" : "  got=" + JSON.stringify(got) + " want=" + JSON.stringify(want)));
  ok ? pass++ : fail++;
}

// ---- 驱动里那两段判断，拎出来单测 ----
function selfWxid(dbDir) {
  return path.basename(path.dirname(dbDir)).replace(/_de[0-9a-f]+$/, "");
}
const CHANNEL_RE = /<channel\b([^>]*)>\n?([\s\S]*?)\n?<\/channel>/;
function parseEnvelope(payloadText) {
  const m = CHANNEL_RE.exec(String(payloadText || ""));
  if (!m) return null;
  const attrs = {};
  for (const a of m[1].matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = a[2];
  return { attrs, body: m[2] };
}

console.log("\n[1] 本机账号推导（与 linux-db-watch.py:self_wxid 同法）");
check("带 _de 后缀", selfWxid("/root/xwechat_files/wxid_6wovscflqr3712_de0d/db_storage"), ME);
check("无后缀也不炸", selfWxid("/root/xwechat_files/wxid_abc/db_storage"), "wxid_abc");

console.log("\n[2] 方向判定：同一张表里三个人，只有她算入站");
const plugin = new WeChatPlugin({});
const g2 = newGate("dir");
const TABLE = "Msg_53eb360e3ef5c33f588bb679ff181899";
let delivered = 0, selfEcho = 0, blocked = 0;
const rows = [
  { id: 1, sender: ALICE, text: "你吃饭了没" },
  { id: 2, sender: ME, text: "吃了 你呢" },          // Nova自己发的：根本不该进闸
  { id: 3, sender: ALICE, text: "刚吃完" },
  { id: 4, sender: OTHER, text: "在吗" },            // 别人：进闸但按 unknown 挡
  { id: 5, sender: ME, text: "在的" },
];
for (const r of rows) {
  if (r.sender === selfWxid("/root/xwechat_files/" + ME + "_de0d/db_storage")) { selfEcho++; continue; }
  const d = plugin.toDelivery({ table: TABLE, local_id: r.id, local_type: 1,
    create_time: 1758000000 + r.id, raw: Buffer.from(r.text, "utf8"), sender: r.sender, accountId: "wx" });
  const res = g2.accept(d);
  if (!res.accepted) blocked++; else delivered++;
}
check("投给他的只有她那 2 条", delivered, 2);
check("本机自己发的 2 条在进闸前就丢了", selfEcho, 2);
check("别人那 1 条被闸按 unknown 挡下", blocked, 1);

console.log("\n[3] 硬写昵称当发送者 = 谁说的都算她说的（复现旧 bug）");
const g3 = newGate("hardcode");
let wrong = 0;
for (const r of rows) {
  const d = plugin.toDelivery({ table: TABLE, local_id: r.id, local_type: 1,
    create_time: 1758000000 + r.id, raw: Buffer.from(r.text, "utf8"), sender: ALICE, accountId: "wx" });
  if (g3.accept(d).accepted) wrong++;
}
check("硬写发送者时 5 条全被当成她的（这就是旧行为）", wrong, 5);

console.log("\n[4] TG 剥壳：正文在 payload.text 的 <channel> 壳里，不在 origin.inner");
const P_TEXT = '<channel source="telegram" chat_id="1000000001" chat_type="private" message_id="39831" ts="2026-09-16T17:30:25.000Z">\n我忙着呢 别勾引我\n</channel>\n\n（只回答这条真实入站，不续写、不补全。）';
const e4 = parseEnvelope(P_TEXT);
check("剥出正文", e4.body, "我忙着呢 别勾引我");
check("剥出 message_id", e4.attrs.message_id, "39831");
check("旧写法 origin.inner 确实不存在", JSON.parse('{"origin":{"channel":"telegram","chatId":"1","chatType":"private","messageId":"1","ts":"x"}}').origin.inner, undefined);
check("没有壳时返回 null，不瞎猜", parseEnvelope("裸文本"), null);

console.log("\n[5] TG 带附件：正文就是文件路径时，不当成她的话");
const P_IMG = '<channel source="telegram" chat_id="1000000001" chat_type="private" message_id="39846" ts="2026-09-17T03:42:26.000Z" attachment_type="image" attachment_path="/root/.nova/inbox/telegram/photo_39846.jpg">\n/root/.nova/inbox/telegram/photo_39846.jpg\n</channel>';
const e5 = parseEnvelope(P_IMG);
check("拿到附件类型", e5.attrs.attachment_type, "image");
check("拿到附件路径", e5.attrs.attachment_path, "/root/.nova/inbox/telegram/photo_39846.jpg");
check("正文==路径，应清空", e5.body.trim() === e5.attrs.attachment_path.trim(), true);

console.log("\n[6] 空事件不得以空白面目投给他");
const g6 = newGate("empty");
const r6 = g6.accept({ channel: "telegram", accountId: "tg", senderId: "1000000001",
  nativeId: "1", text: "", media: [], processing: ["none"] });
check("判成 no_content", r6.event.verdict, "no_content");
check("注入文本里不是一片空白", /\[空事件/.test(r6.injected), true);
check("明说别当成她说了什么", /不要当成她说了什么/.test(r6.injected), true);

console.log("\n[7] 有内容但发不出去，必须留痕，不得伪装成沉默（§0.3）");
const { OutboundGate } = require("../../src/gate/outbound");
(async () => {
  const r7 = path.join(root, "ob");
  const st = new GateStore({ root: r7 });
  const cw = new ColdWriter({ file: path.join(r7, "cold.jsonl") });
  const og = new OutboundGate({ store: st, cold: cw,
    plugins: new Map([["telegram", { capabilities: { send_text: "supported" }, health: () => ({ platform: "supported", plugin: "wired", availability: "ready" }), send: async () => ({ nativeId: "1" }) }]]) });
  const ev = { eventId: "e1", channel: "telegram", chatId: "1", accountId: "a" };
  const blocked = await og.deliver({ turnId: "tb", replyToEventId: "e1", inboundEvent: ev,
    text: "这段话发不出去", intent: "send_hologram" });
  check("outcome=blocked", blocked.outcome, "blocked");
  const rows = fs.readFileSync(path.join(r7, "cold.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  check("发不出去的正文照样落冷层（不然他自己都不记得说过）", rows.length, 1);
  // 2026-09-18：标记搬去日志，冷层正文只有他真说的那句。
  check("冷层正文干净", rows[0].text, "这段话发不出去");
  check("冷层就四个字段", Object.keys(rows[0]).sort(), ["at", "id", "role", "text"]);
  const log7 = fs.readFileSync(path.join(r7, "events.jsonl"), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l));
  const b7 = log7.find((e) => (e.notes || []).some((n) => n.type === "undelivered"));
  check("日志里带 undelivered 标记", Boolean(b7), true);
  check("日志指得回冷层那一条", b7 && b7.coldId, rows[0].id);

  const silent = await og.deliver({ turnId: "ts", replyToEventId: "e1", inboundEvent: ev, text: "" });
  check("空正文仍是 silent，不是 blocked", silent.outcome, "silent");

  console.log("\n通过 " + pass + " / 失败 " + fail + "   (隔离目录 " + root + ")");
  process.exit(fail ? 1 : 0);
})();
