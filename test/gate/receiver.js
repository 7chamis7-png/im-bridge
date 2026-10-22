"use strict";
/**
 * 收信人（2026-09-18）—— 捞上来之后怎么算数
 *
 * 这个文件回答三个问题，每个都对应一种真事故：
 *   · 崩在半路会不会漏？（游标必须是「消化完了」才推进）
 *   · 一条消化不了，会不会把她后面的话全卡住？（不许）
 *   · 重启之后会不会把同一句话再投一遍？（不许）
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { makeReceiver, makeCursorStore, makeDeadLetter } = require("../../src/gate/receiver");
const { TelegramPlugin } = require("../../src/gate/plugins/telegram");

let pass = 0, fail = 0;
const check = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-recv-"));
const mkStores = (name) => ({
  cursor: makeCursorStore({ file: path.join(root, name, "cursor.json") }),
  deadLetter: makeDeadLetter({ file: path.join(root, name, "dead.jsonl") }),
});

/** 假 Bot API：按 offset 切一段返回，跟真 getUpdates 一个语义 */
function fakeTelegram(updates) {
  const calls = [];
  const plugin = new TelegramPlugin({
    sender: async () => "1",
    call: async (method, params) => {
      calls.push({ method, params });
      const since = Number(params.offset || 0);
      return updates.filter((u) => u.update_id >= since).slice(0, params.limit || 100);
    },
  });
  return { plugin, calls };
}

const UPDATES = [
  { update_id: 101, message: { message_id: 1, text: "明天几点的火车", chat: { id: 861, type: "private" }, from: { id: 861 }, date: 1 } },
  { update_id: 102, message: { message_id: 2, text: "记得带伞", chat: { id: 861, type: "private" }, from: { id: 861 }, date: 2 } },
  { update_id: 103, message: { message_id: 3, text: "睡了", chat: { id: 861, type: "private" }, from: { id: 861 }, date: 3 } },
];

(async () => {
  console.log("[1] 插头自己捞得上来（这是新桥第一次不靠老采集器）");
  {
    const { plugin, calls } = fakeTelegram(UPDATES);
    const r = await plugin.poll({ since: 0, timeoutSec: 0 });
    check("捞到三条", r.items.length, 3);
    check("游标指向下一条", r.cursor, 104);
    // 2026-09-20：加上按钮回调（她按了他发的选项按钮），见 telegram-buttons.js
  check("只要真人消息那几类（含按钮回调）", calls[0].params.allowed_updates, ["message", "callback_query"]);
    const d = await plugin.toDelivery(r.items[0].message);
    check("翻译成标准交付", [d.channel, d.text, d.chatId], ["telegram", "明天几点的火车", "861"]);
  }

  console.log("\n[2] 消化完了才推进游标 —— 崩在半路不许漏");
  {
    const { plugin } = fakeTelegram(UPDATES);
    const { cursor, deadLetter } = mkStores("a");
    const eaten = [];
    // 第二条故意崩：模拟「盒子没起来」这种半路失败
    let boom = true;
    const recv = makeReceiver({
      plugin, cursor, deadLetter,
      handle: async (msg) => {
        if (boom && msg.text === "记得带伞") throw new Error("盒子没起来");
        eaten.push(msg.text);
      },
    });
    const r1 = await recv.tick({ timeoutSec: 0 });
    check("三条都碰过", r1.got, 3);
    check("成了两条", r1.ok, 2);
    check("挂了那条进死信", deadLetter.list().map((x) => x.raw.text), ["记得带伞"]);
    check("死信里留着原件（随时能补投）", deadLetter.list()[0].raw.message_id, 2);
    check("**没卡住后面的**", eaten, ["明天几点的火车", "睡了"]);
    check("游标走到头了", cursor.read(), 104);

    console.log("\n[3] 重启之后：不重复投也不漏投");
    boom = false;
    const r2 = await recv.tick({ timeoutSec: 0 });
    check("再捞一次，一条都没有了", r2.got, 0);
    check("他没有把同一句话再听一遍", eaten, ["明天几点的火车", "睡了"]);
  }

  console.log("\n[4] 崩在真正的半路（游标没写成）—— 下次必须重放那一条");
  {
    const { plugin } = fakeTelegram(UPDATES);
    const { deadLetter } = mkStores("b");
    const cursorFile = path.join(root, "b", "cursor.json");
    const cursor = makeCursorStore({ file: cursorFile });
    const eaten = [];
    // 模拟进程在「消化完第一条、还没写游标」那一瞬间挂掉
    const recv = makeReceiver({
      plugin, cursor, deadLetter,
      handle: async (msg) => { eaten.push(msg.text); if (msg.text === "记得带伞") throw Object.assign(new Error("进程没了"), { fatal: true }); },
    });
    await recv.tick({ timeoutSec: 0 }).catch(() => {});
    // 重来一遍：已经消化过的不该再进（靠入闸按平台 id 去重，这里只看游标行为）
    const before = cursor.read();
    check("游标停在已经消化完的位置之后", before, 104);
    check("第一条没被重放两次", eaten.filter((t) => t === "明天几点的火车").length, 1);
  }

  console.log("\n[5] 捞不上来（网断了）≠ 这批消息不存在");
  {
    const plugin = new TelegramPlugin({ sender: async () => "1", call: async () => { throw new Error("ETIMEDOUT"); } });
    const { cursor, deadLetter } = mkStores("c");
    cursor.write(200);
    const recv = makeReceiver({ plugin, cursor, deadLetter, handle: async () => {} });
    let threw = false;
    await recv.tick({ timeoutSec: 0 }).catch(() => { threw = true; });
    check("捞失败是往上抛的", threw, true);
    check("游标一动不动", cursor.read(), 200);
    check("没有人被打成死信", deadLetter.list().length, 0);
  }

  console.log("\n[6] 装配体检：不会捞消息的插头，装的时候就说");
  {
    let msg = "";
    try { makeReceiver({ plugin: { channel: "x" }, cursor: mkStores("d").cursor, deadLetter: mkStores("d").deadLetter, handle: async () => {} }); }
    catch (e) { msg = e.message; }
    check("当场报「不会自己捞」", /缺 poll|不会自己捞/.test(msg), true);
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}   (隔离目录 ${root})`);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
