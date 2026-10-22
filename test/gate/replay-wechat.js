"use strict";
/**
 * 阶段 2：拿 2026-09-17 凌晨的真实微信消息回放，验证新架构在同样输入下不重犯旧错。
 * **只读微信库，不发送、不写生产冷层、不碰Nova。**
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { GateStore } = require("../../src/gate/store");
const { ColdWriter } = require("../../src/gate/cold-writer");
const { InboundGate } = require("../../src/gate/inbound");
const { WeChatPlugin } = require("../../src/gate/plugins/wechat");

const KEYS = "/root/wxkey/all_keys.json";
const REL = "message/message_0.db";

function sqlcipher(db, key, sql) {
  const script = 'PRAGMA key = "x\'' + key + '\'";\nPRAGMA cipher_compatibility = 4;\n.headers off\n.mode list\n.separator |\n' + sql + "\n";
  const out = execFileSync("sqlcipher", ["-batch", db], { input: script, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\n").filter((l) => l && l !== "ok");
}

function loadRows(ids) {
  const data = JSON.parse(fs.readFileSync(KEYS, "utf8"));
  const db = path.join(data._db_dir, REL);
  const key = data[REL].enc_key;
  const tables = sqlcipher(db, key, "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%';");
  const rows = [];
  for (const t of tables) {
    if (!/^Msg_[0-9a-f]{32}$/.test(t)) continue;
    const got = sqlcipher(db, key,
      "SELECT local_id, local_type, create_time, hex(ifnull(message_content,'')) FROM " + t +
      " WHERE local_id IN (" + ids.join(",") + ") ORDER BY local_id;");
    for (const line of got) {
      const p = line.split("|");
      if (p.length < 4) continue;
      rows.push({ local_id: Number(p[0]), local_type: Number(p[1]), create_time: Number(p[2]),
        raw: Buffer.from(p[3], "hex"), sender: "Alice-wx", accountId: "wx1" });
    }
  }
  return rows;
}

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + name + (ok ? "" : "  got=" + JSON.stringify(got) + " want=" + JSON.stringify(want)));
  ok ? pass++ : fail++;
}

let rows;
try {
  if (process.env.IM_BRIDGE_REAL_WECHAT !== "1") throw new Error("未设 IM_BRIDGE_REAL_WECHAT=1（默认不碰真实微信库/密钥）");
  rows = loadRows([217, 223, 110]);
} catch (e) {
  console.log("SKIP: replay-wechat 整个文件没跑（" + String(e.message).slice(0, 80) + "）");
  process.exit(0);
}
console.log("从真实微信库读到 " + rows.length + " 条\n");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-replay-"));
function newGate(skipDecompress) {
  const store = new GateStore({ root: fs.mkdtempSync(path.join(os.tmpdir(), "gate-r-")) });
  const cold = new ColdWriter({ file: path.join(root, "cold-" + (skipDecompress ? "old" : "new") + ".jsonl") });
  const plugin = new WeChatPlugin({ skipDecompress });
  const gate = new InboundGate({ store, cold, identities: { "wechat:Alice-wx": "alice" } });
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
check("原文正确还原", res.event.text.startsWith("我长大了老公"), true);
check("投给他的带 #1", /^#1\n/.test(res.injected), true);

console.log("\n[2] 复现旧 bug：插件漏了解压（今晚真实发生的）");
g = newGate(true);
d = g.plugin.toDelivery(r217);
check("插件只声明了解密", d.processing, ["decrypted"]);
res = g.gate.accept(d);
check("闸拦住，判 undecoded", res.event.verdict, "undecoded");
check("仍然登记并编号，消息不丢", res.event.userSeq, 1);
check("投给他的不含乱码原文", res.injected.includes(d.text), false);
check("投给他的明说是未解码", res.injected.includes("[未解码内容"), true);
const coldOld = fs.readFileSync(path.join(root, "cold-old.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
check("冷层里存的是占位符不是乱码", coldOld[0].text, "[未解码内容]");

console.log("\n[3] 短文本无回归");
g = newGate(false);
res = g.gate.accept(g.plugin.toDelivery(r223));
check("正常接受", res.event.verdict, "accepted");
check("原文是「这是怎么回事」", res.event.text, "这是怎么回事");

console.log("\n对照：旧路当晚把这条投成了 169 个乱码字符，并当成她的原话写进了冷层。");
// ——— 2026-09-17 追加：local_type 高低位 ———
{
  const { splitLocalType, APPMSG_LABEL, WeChatPlugin } = require("../../src/gate/plugins/wechat");
  console.log("\n[追加] 微信 local_type 是高低位打包的（实测库里真出现过这些值）");
  check("25769803825 → 主类型 49 子类型 6（文件）", splitLocalType(25769803825), { type: 49, appmsg: 6 });
  check("81604378673 → 主类型 49 子类型 19（聊天记录转发）", splitLocalType(81604378673), { type: 49, appmsg: 19 });
  check("普通文字不受影响", splitLocalType(1), { type: 1, appmsg: 0 });
  check("引用回复是子类型 57", APPMSG_LABEL[57], "quote");
  check("链接卡片是子类型 5", APPMSG_LABEL[5], "link");
  const p = new WeChatPlugin({});
  const d = p.toDelivery({ table: "Msg_x", local_id: 1, local_type: 25769803825,
    create_time: 1758000000, raw: Buffer.from("<msg><appmsg><title>读后感.txt</title></appmsg></msg>", "utf8"), sender: "wxid_x" });
  check("认出是文件，不再落进兜底", d.media.map((m) => m.kind), ["file"]);
  // 2026-09-17 晚上改了行为：appmsg 不再把 XML 原样怼给他，插件解析成一行
  // （Nova清单第 4 条）。原件留在事件账本里，要细节回头查得到。
  check("正文是解析后的行，不是 XML", d.text.split("\n")[0], "【文件】读后感.txt");
  check("本地没找到时明说，不装", /本地没找到/.test(d.text), true);
  check("XML 不再漏到他眼前", d.text.includes("<appmsg>"), false);
}

console.log("\n通过 " + pass + " / 失败 " + fail);
process.exit(fail ? 1 : 0);
