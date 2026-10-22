"use strict";
/**
 * iMessage 这条腿的接线（2026-09-19 从老桥搬过来那次）
 *
 * 老桥（`adapters/channel/imessage/bridge.js`）是个彻头彻尾的老世界公民：
 * 靠老 runtime socket 说话、往老冷层记忆、读老配置。老桥一停它就废了
 * （实测：`~/.nova/claudecode-runtime.sock` 文件都不存在了）。
 *
 * 搬过来之后形状照电话那条腿：**入站走文件、出站走 socket**，
 * Spectrum 的连接归喂料进程独占（全机只有一条，两个实例会抢同一批入站）。
 *
 * ⚠️ 这份盯的还是**接线**：喂料进程写进收件箱的字段名，跟插头 `toDelivery`
 * 读的字段名，对不上**不会报错、只会静默变空**。9-18 五个 bug 里四个死在这儿。
 */
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const { IMessagePlugin } = require("../../src/gate/plugins/imessage");
const leg = require("../../src/gate/plugins/imessage").leg;

let pass = 0, fail = 0;
const check = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "im-wiring-"));
const HER = "+15550100001";

(async () => {
  console.log("[1] 喂料进程写进去的形状 ↔ 插头读出来的形状（对不上只会静默变空）");
  {
    const inboxDir = path.join(root, "inbox1");
    const p = new IMessagePlugin({ inboxDir, log: () => {} });
    // 这一段**必须跟 imessage-spectrum.js 里 inbox.receive({...}) 的字段一模一样**
    p.receive({ handle: HER, id: "msg-7", date: "2026-09-19T01:00:00.000Z",
      text: "在吗", accountId: "imessage" });

    const { items, cursor } = await p.poll({ since: 0 });
    check("捞到 1 条", items.length, 1);
    const d = p.toDelivery(items[0].message);
    check("正文没丢", d.text, "在吗");
    check("认人靠真实 handle", d.senderId, HER);
    check("回信地址也是它", d.chatId, HER);
    check("平台原生 id 带上了（去重靠它）", d.nativeId, "msg-7");
    check("时间是平台给的，不是落盘时间", d.receivedAt, "2026-09-19T01:00:00.000Z");
    check("渠道名由闸认定", d.channel, "imessage");
    check("游标推进了", cursor, 1);

    // ⚠️ 老桥写死 `from_is_alice="true"`，插头注释点名批评过。新世界认人归桥。
    check("交付里没有硬填的「她本人」标记", JSON.stringify(d).includes("from_is_alice"), false);
  }

  console.log("\n[2] 语音转写那条：标成转写，别让他以为她是打字的");
  {
    const inboxDir = path.join(root, "inbox2");
    const p = new IMessagePlugin({ inboxDir, log: () => {} });
    p.receive({ handle: HER, id: "m8", date: "2026-09-19T01:01:00.000Z",
      text: "【语音转写】今天辛苦了", accountId: "imessage", attachmentKind: "voice" });
    const { items } = await p.poll({ since: 0 });
    const d = p.toDelivery(items[0].message);
    check("正文带转写标记", d.text.startsWith("【语音转写】"), true);
    check("媒体那栏说得出是语音", d.media, [{ kind: "voice", ref: "" }]);
  }

  console.log("\n[3] 出站走 socket（Spectrum 的连接归喂料进程独占）");
  {
    const sockFile = path.join(root, "im.sock");
    const got = [];
    const server = net.createServer((sock) => {
      sock.on("data", (c) => {
        for (const line of c.toString("utf8").split("\n")) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          got.push(msg);
          sock.write(JSON.stringify({ ok: true, nativeId: null }) + "\n");
        }
      });
    });
    await new Promise((r) => server.listen(sockFile, r));

    const p = new IMessagePlugin({ inboxDir: path.join(root, "i3"), socketPath: sockFile, log: () => {} });
    check("阳性对照：配了 socket 就算在线", p.health().availability, "ready");
    const r = await p.send({ operationId: "op-1", chatId: HER, text: "在的 老婆", intent: "send_text" });
    check("发出去了", r.nativeId, null);
    check("递过去的目标没被改", got[0].chatId, HER);
    check("正文原样", got[0].text, "在的 老婆");

    // 默认拒绝：平台支持 ≠ 这条腿接了
    let err = "";
    try { await p.send({ operationId: "op-2", chatId: HER, text: "x", intent: "send_voice" }); }
    catch (e) { err = e.message; }
    check("没接的意图当场拒，不许发成一行字", /还没接/.test(err), true);

    await new Promise((r2) => server.close(r2));
  }

  console.log("\n[4] 喂料进程不在 → 当场说没发出去，不许装作发了");
  {
    const p = new IMessagePlugin({
      inboxDir: path.join(root, "i4"), socketPath: path.join(root, "根本没有.sock"),
      sendTimeoutMs: 1500, log: () => {},
    });
    let err = "";
    try { await p.send({ operationId: "op-3", chatId: HER, text: "喂", intent: "send_text" }); }
    catch (e) { err = e.message; }
    check("报的是「没在跑」，不是静默成功", /没在跑|连不上/.test(err), true);
  }

  console.log("\n[5] 没配 socket = 这条腿没插上（health 要跟 send 用同一个判据）");
  {
    const p = new IMessagePlugin({ inboxDir: path.join(root, "i5"), log: () => {} });
    check("没 socket → offline", p.health().availability, "offline");
    // 2026-09-18 TG 那个 bug：health 看 A、send 用 B，生产一律 offline 出闸全挡。
    let err = "";
    try { await p.send({ operationId: "o", chatId: HER, text: "x", intent: "send_text" }); }
    catch (e) { err = e.message; }
    check("send 也认同一件事（没配 socket 就发不了）", /没配 socket/.test(err), true);
  }

  console.log("\n[6] 插排：两样配置齐了才插上");
  {
    check("要的配置就这两样", leg.configKeys.map((k) => k[0]),
      ["GATE_IMESSAGE_INBOX_DIR", "GATE_IMESSAGE_SOCKET"]);
    const made = leg.make({ env: {
      GATE_IMESSAGE_INBOX_DIR: path.join(root, "i6"),
      GATE_IMESSAGE_SOCKET: path.join(root, "i6.sock"),
    }, log: () => {} });
    check("造出来就是 ready（不是 sender:null 那个老样子）", made.health().availability, "ready");
  }

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
