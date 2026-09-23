"use strict";
/**
 * 阶段 1 冒烟：只验一件事 —— 消息进得来、编号对、冷层只有一个写手。
 * 隔离跑。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { GateStore } = require("../../src/gate/store");
const { ColdWriter } = require("../../src/gate/cold-writer");
const { InboundGate } = require("../../src/gate/inbound");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-smoke-"));
const coldFile = path.join(root, "cold.jsonl");
const IDENTITIES = { "imessage:+15550001111": "owner", "telegram:10001": "owner" };

// 模拟「插件漏了解压」交上来的二进制：替换字符 + 控制字符混排
const REPL = String.fromCharCode(0xfffd);
const GARBLE = "(" + REPL + "/" + REPL + " " + String.fromCharCode(5) + "2" + REPL
  + String.fromCharCode(1) + "&*" + REPL + ":I" + REPL + String.fromCharCode(7) + "$HX" + REPL + "j";

function newGate() {
  const store = new GateStore({ root });
  const cold = new ColdWriter({ file: coldFile });
  return { store, cold, gate: new InboundGate({ store, cold, identities: IDENTITIES }) };
}

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + name + (ok ? "" : "  got=" + JSON.stringify(got) + " want=" + JSON.stringify(want)));
  ok ? pass++ : fail++;
}

let g = newGate();

console.log("\n[1] 正常消息进闸，拿到 #1");
let r = g.gate.accept({ channel: "imessage", accountId: "im1", senderId: "+15550001111",
  nativeId: "n1", text: "到家了", processing: ["none"] });
check("被接受", r.accepted, true);
check("编号 = 1", r.event.userSeq, 1);
check("注入文本带 #1", /^#1\n/.test(r.injected), true);

console.log("\n[2] 跨渠道共用同一条序列 (A29)");
r = g.gate.accept({ channel: "telegram", accountId: "tg", senderId: "10001",
  nativeId: "t1", text: "在 TG 说的", processing: ["none"] });
check("TG 拿到 #2 而不是 #1", r.event.userSeq, 2);

console.log("\n[3] 同一事件重传，沿用原号不吃第二个号");
r = g.gate.accept({ channel: "imessage", accountId: "im1", senderId: "+15550001111",
  nativeId: "n1", text: "到家了", processing: ["none"] });
check("识别为重复", r.duplicate, true);
check("号还是 1", r.event.userSeq, 1);
check("最大号仍是 2", g.store.maxSeq("owner"), 2);

console.log("\n[4] 乱码不冒充 owner 的话");
r = g.gate.accept({ channel: "imessage", accountId: "im1", senderId: "+15550001111",
  nativeId: "n2", text: GARBLE, processing: ["decrypted"] });
check("判为 undecoded", r.event.verdict, "undecoded");
check("仍然登记并编号 (不丢)", r.event.userSeq, 3);
check("注入文本不含乱码原文", r.injected.includes(GARBLE), false);

console.log("\n[5] 未知身份不投递 (白名单那个洞的结构解法)");
r = g.gate.accept({ channel: "imessage", accountId: "im1", senderId: "+15550009999",
  nativeId: "n3", text: "我是陌生人", processing: ["none"] });
check("拒绝投递", r.accepted, false);
check("不占号", r.event.userSeq, null);
check("最大号没被推进", g.store.maxSeq("owner"), 3);

console.log("\n[6] 图片只存 [图片] (0.4)");
r = g.gate.accept({ channel: "imessage", accountId: "im1", senderId: "+15550001111",
  nativeId: "n4", text: "", media: [{ kind: "image", ref: "/x/a.jpg" }], processing: ["none"] });
check("被接受", r.accepted, true);
const coldLines = fs.readFileSync(coldFile, "utf8").trim().split("\n").map(JSON.parse);
check("冷层里是 [图片]", coldLines[coldLines.length - 1].text, "[图片]");
check("冷层里没有文件路径", fs.readFileSync(coldFile, "utf8").includes("/x/a.jpg"), false);

console.log("\n[7] 重启后编号不清零 (A29 的另一半)");
g = newGate();
r = g.gate.accept({ channel: "imessage", accountId: "im1", senderId: "+15550001111",
  nativeId: "n5", text: "重启之后", processing: ["none"] });
check("接着编 #5 而不是 #1", r.event.userSeq, 5);

console.log("\n[8] 冷层去重：同一 recordId 只落一次");
const before = g.cold.count();
g.cold.write({ recordId: "cold-dup-test", role: "user", ev: { channel: "imessage", text: "x" } });
g.cold.write({ recordId: "cold-dup-test", role: "user", ev: { channel: "imessage", text: "x" } });
check("只增加一条", g.cold.count() - before, 1);

console.log("\n通过 " + pass + " / 失败 " + fail + "   (隔离目录 " + root + ")");
process.exit(fail ? 1 : 0);
