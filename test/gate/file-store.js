"use strict";
/**
 * 文件仓：类型从内容嗅、同内容自动去重、存在性是可查的事实。
 * 最后一条专门为幽灵入站做的 —— 9-17 影子抓到 attachment_path 指向不存在的文件。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { FileStore, sniff } = require("../../src/gate/file-store");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-fs-"));
const store = new FileStore({ root: path.join(root, "files") });
let pass = 0, fail = 0;
const check = (n, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(g)} want=${JSON.stringify(w)}`));
  ok ? pass++ : fail++;
};
const B = (...b) => Buffer.from(b);
const pad = (head, n = 64) => Buffer.concat([head, Buffer.alloc(n)]);

console.log("\n[1] 类型从内容嗅，不看扩展名");
check("jpeg", sniff(pad(B(0xff, 0xd8, 0xff))).mime, "image/jpeg");
check("png", sniff(pad(B(0x89, 0x50, 0x4e, 0x47))).mime, "image/png");
check("zstd（微信长文本那个）", sniff(pad(B(0x28, 0xb5, 0x2f, 0xfd))).mime, "application/zstd");
check("amr（微信语音）", sniff(pad(B(0x02, 0x23, 0x21, 0x41))).mime, "audio/amr");
check("m4a（iMessage 语音气泡）",
  sniff(Buffer.concat([B(0,0,0,0x20), Buffer.from("ftypM4A ", "latin1"), Buffer.alloc(32)])).mime, "audio/mp4");
check("webp 要看 RIFF 第 8 字节起",
  sniff(Buffer.concat([Buffer.from("RIFF", "latin1"), B(0,0,0,0), Buffer.from("WEBP", "latin1"), Buffer.alloc(16)])).mime, "image/webp");
check("认不出就老实说 octet-stream", sniff(pad(B(0x11, 0x22, 0x33))).mime, "application/octet-stream");

console.log("\n[2] 扩展名骗人时以内容为准");
const r1 = store.put({ bytes: pad(B(0x89, 0x50, 0x4e, 0x47)), channel: "telegram", hintName: "其实是png.jpg" });
check("嗅成 png 不是 jpg", r1.mime, "image/png");
check("落盘名用嗅出来的扩展名", r1.fileId.endsWith(".png"), true);
check("原名只记录不进路径", r1.filePath.includes("其实是png"), false);

console.log("\n[3] 同内容存第二遍自动去重");
const r2 = store.put({ bytes: pad(B(0x89, 0x50, 0x4e, 0x47)), channel: "telegram" });
check("同一个 fileId", r2.fileId, r1.fileId);
check("标了 deduped", r2.deduped, true);
check("第一次不是 deduped", r1.deduped, false);

console.log("\n[4] 拿回来的路径保证存在");
check("文件真在", fs.existsSync(r1.filePath), true);
check("verify 说 ok", store.verify(r1.filePath).ok, true);
check("verify 也报类型", store.verify(r1.filePath).mime, "image/png");

console.log("\n[5] 存在性是可查的事实 —— 幽灵入站就卡在这儿");
const ghost = store.verify("/root/.nova/inbox/telegram/photo_39793.jpg");
check("幽灵那条附件：文件不存在", ghost.ok, false);
check("说得出原因", ghost.reason, "文件不存在");

console.log("\n[6] 不收的东西明确报错，不悄悄收下");
for (const [name, args, word] of [
  ["空文件", { bytes: Buffer.alloc(0) }, "空文件不收"],
  ["源文件不存在", { srcPath: "/nope/xyz.png" }, "源文件不存在"],
  ["啥也没给", {}, "要么给 bytes"],
]) {
  let msg = "";
  try { store.put(args); } catch (e) { msg = e.message; }
  check(`${name} 报错且说人话`, msg.includes(word), true);
}
let big = "";
try { new FileStore({ root: path.join(root, "f2"), maxBytes: 10 }).put({ bytes: pad(B(0xff,0xd8,0xff)) }); }
catch (e) { big = e.message; }
check("超大小上限报错", /超过上限/.test(big), true);

console.log("\n[7] 不同渠道分开放，但同内容仍各自只存一份");
const t = store.put({ bytes: pad(B(0xff, 0xd8, 0xff)), channel: "telegram" });
const w = store.put({ bytes: pad(B(0xff, 0xd8, 0xff)), channel: "wechat" });
check("fileId 相同（内容一样）", t.fileId, w.fileId);
check("路径按渠道分开", t.filePath !== w.filePath, true);

console.log(`\n通过 ${pass} / 失败 ${fail}   (隔离目录 ${root})`);
process.exit(fail ? 1 : 0);
