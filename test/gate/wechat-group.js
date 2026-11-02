"use strict";
// 2026-10-29 微信群：插头交出群事实 + 出站按 chatId 找窗口
const assert = require("assert");
const { WeChatPlugin } = require("../../src/gate/plugins/wechat/index.js");
const { makeA11ySenders } = require("../../src/gate/plugins/wechat/a11y-send.js");
let ok = 0, bad = 0;
const t = (name, fn) => { try { fn(); ok++; console.log("  OK  ", name); } catch (e) { bad++; console.log("  FAIL", name, e.message); } };

const senders = makeA11ySenders({ GATE_WECHAT_TARGET: "Alice-wx" });
let resolver = null;
const p = new WeChatPlugin({ defaultTarget: "Alice-wx", selfNames: ["Nova"], botIds: ["wxid_iris"],
  setTargetResolver: (fn) => { resolver = fn; senders.setTargetResolver(fn); } });
const raw = (s) => Buffer.from(s, "utf8");

t("私聊照旧", () => {
  const d = p.toDelivery({ local_id: 1, local_type: 1, sender: "wxid_alice", chat: "wxid_alice", create_time: 1, raw: raw("早") });
  assert.equal(d.chatType, "private"); assert.equal(d.chatId, "wxid_alice"); assert.equal(d.text, "早");
});
t("群：chatId=群，senderId=发言人，剥前缀", () => {
  const d = p.toDelivery({ local_id: 2, local_type: 1, sender: "wxid_aunt", chat: "123@chatroom", chat_name: "家庭群",
    is_group: true, from_name: "二姨", create_time: 1, raw: raw("wxid_aunt:\n吃了吗") });
  assert.equal(d.chatType, "group"); assert.equal(d.chatId, "123@chatroom"); assert.equal(d.senderId, "wxid_aunt");
  assert.equal(d.senderName, "二姨"); assert.equal(d.text, "吃了吗"); assert.equal(d.addressing.mentionsMe, false);
  assert.equal(d.addressing.senderIsBot, false);
});
t("群：@他 认得出", () => {
  const d = p.toDelivery({ local_id: 3, local_type: 1, sender: "wxid_alice", chat: "123@chatroom", is_group: true,
    from_name: "Alice", create_time: 1, raw: raw("wxid_alice:\n@Nova 出来") });
  assert.equal(d.addressing.mentionsMe, true);
});
t("群：Iris算 bot", () => {
  const d = p.toDelivery({ local_id: 4, local_type: 1, sender: "wxid_iris", chat: "123@chatroom", is_group: true,
    create_time: 1, raw: raw("wxid_iris:\n嗨") });
  assert.equal(d.addressing.senderIsBot, true);
});
t("出站：私聊 → 她的窗口", () => assert.equal(resolver("wxid_alice"), "Alice-wx"));
t("出站：群 → 群名（入站记下的）", () => assert.equal(resolver("123@chatroom"), "家庭群"));
t("出站：没见过的群 → 拒发", () => assert.throws(() => resolver("999@chatroom"), /没敢发/));
t("GATE_WECHAT_GROUP_TITLES 预配", () => {
  const q = new WeChatPlugin({ defaultTarget: "X", groupTitles: { "9@chatroom": "预配群" } });
  assert.equal(q.targetFor("9@chatroom"), "预配群");
});
console.log(`\n通过 ${ok} / 失败 ${bad}`);
process.exit(bad ? 1 : 0);
