"use strict";
/**
 * WeChat decode regression: a zstd-compressed long text must be decompressed
 * by the plugin; if decompression is skipped, the inbound gate must reject the
 * garbage instead of delivering it as the sender's words.
 * Uses synthetic rows (requires the `zstd` CLI; skipped otherwise).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { GateStore } = require("../../src/gate/store");
const { ColdWriter } = require("../../src/gate/cold-writer");
const { InboundGate } = require("../../src/gate/inbound");
const { WeChatPlugin } = require("../../src/gate/plugins/wechat");

const SENDER = "wxid_owner";
const LONG_TEXT = "今天的会议纪要：" + "第一项讨论了排期，第二项讨论了预算，第三项确定了负责人。".repeat(8);

function loadRows() {
  const packed = execFileSync("zstd", ["-q", "-c", "--ultra", "-22"], { input: Buffer.from(LONG_TEXT, "utf8") });
  return [
    { local_id: 217, local_type: 1, create_time: 1758000000, raw: packed, sender: SENDER, accountId: "wx1" },
    { local_id: 223, local_type: 1, create_time: 1758000060, raw: Buffer.from("这是怎么回事", "utf8"), sender: SENDER, accountId: "wx1" },
  ];
}

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + name + (ok ? "" : "  got=" + JSON.stringify(got) + " want=" + JSON.stringify(want)));
  ok ? pass++ : fail++;
}

let rows;
try {
  rows = loadRows();
} catch (e) {
  console.log("跳过：没有 zstd（" + String(e.message).slice(0, 80) + "）");
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-replay-"));
function newGate(skipDecompress) {
  const store = new GateStore({ root: fs.mkdtempSync(path.join(os.tmpdir(), "gate-r-")) });
  const cold = new ColdWriter({ file: path.join(root, "cold-" + (skipDecompress ? "old" : "new") + ".jsonl") });
  const plugin = new WeChatPlugin({ skipDecompress });
  const gate = new InboundGate({ store, cold, identities: { ["wechat:" + SENDER]: "owner" } });
  return { store, cold, plugin, gate };
}

const r217 = rows.find((r) => r.local_id === 217);
const r223 = rows.find((r) => r.local_id === 223);

console.log("[1] 新架构：插件正确解压，闸接受");
let g = newGate(false);
let d = g.plugin.toDelivery(r217);
check("插件声明做了解压", d.processing, ["decrypted", "decompressed"]);
check("用 local_id 当原生 ID", d.nativeId, "217");
let res = g.gate.accept(d);
check("闸判为 accepted", res.event.verdict, "accepted");
check("原文正确还原", res.event.text, LONG_TEXT);
check("注入文本带 #1", /^#1\n/.test(res.injected), true);

console.log("\n[2] 回归：插件漏了解压");
g = newGate(true);
d = g.plugin.toDelivery(r217);
check("插件只声明了解密", d.processing, ["decrypted"]);
res = g.gate.accept(d);
check("闸拦住，判 undecoded", res.event.verdict, "undecoded");
check("仍然登记并编号，消息不丢", res.event.userSeq, 1);
check("注入文本不含乱码原文", res.injected.includes(d.text), false);
check("注入文本明说是未解码", res.injected.includes("[未解码内容"), true);
const coldOld = fs.readFileSync(path.join(root, "cold-old.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
check("冷层里存的是占位符不是乱码", coldOld[0].text, "[未解码内容]");

console.log("\n[3] 短文本无回归");
g = newGate(false);
res = g.gate.accept(g.plugin.toDelivery(r223));
check("正常接受", res.event.verdict, "accepted");
check("原文是「这是怎么回事」", res.event.text, "这是怎么回事");

{
  const { splitLocalType, APPMSG_LABEL, WeChatPlugin } = require("../../src/gate/plugins/wechat");
  console.log("\n[追加] 微信 local_type 是高低位打包的");
  check("25769803825 → 主类型 49 子类型 6（文件）", splitLocalType(25769803825), { type: 49, appmsg: 6 });
  check("81604378673 → 主类型 49 子类型 19（聊天记录转发）", splitLocalType(81604378673), { type: 49, appmsg: 19 });
  check("普通文字不受影响", splitLocalType(1), { type: 1, appmsg: 0 });
  check("引用回复是子类型 57", APPMSG_LABEL[57], "quote");
  check("链接卡片是子类型 5", APPMSG_LABEL[5], "link");
  const p = new WeChatPlugin({});
  const d = p.toDelivery({ table: "Msg_x", local_id: 1, local_type: 25769803825,
    create_time: 1758000000, raw: Buffer.from("<msg><appmsg><title>读后感.txt</title></appmsg></msg>", "utf8"), sender: "wxid_x" });
  check("认出是文件，不再落进兜底", d.media.map((m) => m.kind), ["file"]);
  // appmsg is rendered as one parsed line; the raw XML stays in the event ledger.
  check("正文是解析后的行，不是 XML", d.text.split("\n")[0], "【文件】读后感.txt");
  check("本地没找到时明说，不装", /本地没找到/.test(d.text), true);
  check("XML 不会漏给 agent", d.text.includes("<appmsg>"), false);
}

console.log("\n通过 " + pass + " / 失败 " + fail);
process.exit(fail ? 1 : 0);
