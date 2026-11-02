"use strict";
/**
 * 微信「收发文件」（文档类：pdf/word/zip/txt…）2026-10-23。
 *
 * 入站（收）：type 6 appmsg 文件 → toDelivery 带定位 → hydrate 走 fetchMedia 取字节
 *   → 落进桥的文件仓 → media item 带 filePath/fileName/mime/byteLength。
 * 出站（发）：send_file 从 unsupported 变 supported；这里**只验意图分发+拿路径+报错**，
 *   **绝不真发**（不碰微信窗口、不碰剪贴板）。真机发一张由 Keeper 挑时机做。
 *
 * 真实微信库那段：有真文件就拿真文件验（字节/大小/sha 对得上），没有就 SKIP，绝不假通过。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { WeChatPlugin } = require("../../src/gate/plugins/wechat");
const { MediaPipeline } = require("../../src/gate/media-pipeline");
const { FileStore } = require("../../src/gate/file-store");
const { normalizeModelInput } = require("../../src/gate/model-input");
const { makeA11ySenders } = require("../../src/gate/plugins/wechat/a11y-send");

let pass = 0, fail = 0, skip = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + name + (ok ? "" : "  got=" + JSON.stringify(got) + " want=" + JSON.stringify(want)));
  ok ? pass++ : fail++;
}
function ok(name, cond) { check(name, Boolean(cond), true); }

const FILE_LT = 6 * 4294967296 + 49;      // appmsg 文件：低 32 位 = 49，高 32 位 = 6
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const fileXml = (name, len) =>
  `<msg><appmsg><title>${name}</title><type>6</type><appattach><totallen>${len}</totallen></appattach></appmsg></msg>`;

const noopCaps = { has: () => false, call: async () => ({}) };

// ───────────────────────────── 入站（合成，永远跑）─────────────────────────────
(async () => {
  console.log("[入站·合成] 盘上真有文件 → 落仓 + 结构化字段");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wxfile-in-"));
  fs.mkdirSync(path.join(root, "2026-09"), { recursive: true });
  const body = Buffer.from("%PDF-1.4\n假装这是一份 PDF 报价单\n".repeat(20), "utf8");
  const diskPath = path.join(root, "2026-09", "报价单.pdf");
  fs.writeFileSync(diskPath, body);

  const plug = new WeChatPlugin({ filesRoot: root });
  const ts = Math.floor(Date.UTC(2026, 8, 20, 10, 0, 0) / 1000);
  const d = plug.toDelivery({ table: "Msg_x", local_id: 1, local_type: FILE_LT,
    create_time: ts, raw: Buffer.from(fileXml("报价单.pdf", body.length), "utf8"), sender: "wxid_x" });

  check("toDelivery 认成 file", d.media[0].kind, "file");
  check("带文件名", d.media[0].fileName, "报价单.pdf");
  check("带定位路径（微信库里那份明文）", d.media[0].localPath, diskPath);
  check("打了 store 开关（要求落仓）", d.media[0].store, true);
  ok("正文仍带来路标注【文件】", d.text.startsWith("【文件】报价单.pdf"));

  // fetchMedia 单独验：从明文读字节
  const fm = await plug.fetchMedia(d.media[0], { createTime: ts });
  ok("fetchMedia 出字节", fm.bytes && fm.bytes.length === body.length);
  check("字节一字不差", sha256(fm.bytes), sha256(body));
  check("hintName 是原文件名", fm.hintName, "报价单.pdf");

  // 走完整 hydrate：落进文件仓
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wxfile-store-"));
  const pipe = new MediaPipeline({ caps: noopCaps, fileStore: new FileStore({ root: storeRoot }), nativeImageInput: true });
  await pipe.hydrate(d, plug);
  const it = d.media[0];
  ok("落仓后 filePath 指向桥文件仓且真存在", it.filePath && it.filePath.startsWith(storeRoot) && fs.existsSync(it.filePath));
  check("byteLength 对得上", it.byteLength, body.length);
  check("仓里那份内容一字不差", sha256(fs.readFileSync(it.filePath)), sha256(body));
  ok("mime 从内容嗅出来（PDF）", it.mime === "application/pdf");
  ok("media 行不空", String(it.text || "").length > 0);

  // 给Nova的入参：附件用的是**仓里那份**（不是微信库那份）
  const envelope = { verdict: "ok", payload: { text: d.text, media: d.media } };
  const mi = normalizeModelInput(envelope);
  ok("附件带上了仓里的文件", mi.attachments.includes(it.filePath));
  ok("没把微信库那份只读路径当附件漏出去", !mi.attachments.includes(diskPath));

  console.log("\n[入站·合成] 盘上没有这个文件 → 不落仓、照旧只留标注（行为不变）");
  const d2 = plug.toDelivery({ table: "Msg_x", local_id: 2, local_type: FILE_LT,
    create_time: ts, raw: Buffer.from(fileXml("根本没有.pdf", 1), "utf8"), sender: "wxid_x" });
  check("没找到就不给路径", d2.media[0].localPath, undefined);
  check("没找到就不打 store 开关", d2.media[0].store, undefined);

  console.log("\n[入站·合成] 超大文件按 stat 先挡，不整个读进内存");
  const bigPlug = new WeChatPlugin({ filesRoot: root, fileMaxBytes: 10 });
  const big = bigPlug.toDelivery({ table: "Msg_x", local_id: 3, local_type: FILE_LT,
    create_time: ts, raw: Buffer.from(fileXml("报价单.pdf", body.length), "utf8"), sender: "wxid_x" });
  const fmBig = await bigPlug.fetchMedia(big.media[0], { createTime: ts });
  check("超限明说 file_too_large", fmBig.failed, "file_too_large");

  // ───────────────────────── 入站（真实微信库，拿得到才跑）─────────────────────
  console.log("\n[入站·真实库] 拿真文件验（没有就 SKIP）");
  const KEYS = "/root/wxkey/all_keys.json";
  let realFilesRoot = "";
  try {
    const kdata = JSON.parse(fs.readFileSync(KEYS, "utf8"));
    realFilesRoot = path.join(kdata._db_dir, "..", "msg", "file");
  } catch { /* 没钥匙文件 */ }
  let realHit = null;
  if (realFilesRoot && fs.existsSync(realFilesRoot)) {
    // 扫出盘上真有的一个文件，连同它所在的 YYYY-MM
    for (const ym of fs.readdirSync(realFilesRoot)) {
      const dir = path.join(realFilesRoot, ym);
      if (!/^\d{4}-\d{2}$/.test(ym)) continue;
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      const nm = names.find((n) => { try { return fs.statSync(path.join(dir, n)).isFile(); } catch { return false; } });
      if (nm) { realHit = { ym, name: nm, full: path.join(dir, nm) }; break; }
    }
  }
  if (!realHit) {
    console.log("  SKIP: 盘上没有真实微信文件可验（msg/file/YYYY-MM/ 为空）");
    skip++;
  } else {
    const realBytes = fs.readFileSync(realHit.full);
    const [y, mo] = realHit.ym.split("-").map(Number);
    const realTs = Math.floor(Date.UTC(y, mo - 1, 15, 12, 0, 0) / 1000);
    const rp = new WeChatPlugin({ filesRoot: realFilesRoot });
    const rd = rp.toDelivery({ table: "Msg_real", local_id: 1, local_type: FILE_LT,
      create_time: realTs, raw: Buffer.from(fileXml(realHit.name, realBytes.length), "utf8"), sender: "wxid_real" });
    console.log("  真文件：" + realHit.ym + "/" + realHit.name + "  " + realBytes.length + " 字节");
    check("真文件定位对上", rd.media[0].localPath, realHit.full);
    const rfm = await rp.fetchMedia(rd.media[0], { createTime: realTs });
    ok("真文件 fetchMedia 出字节", rfm.bytes && rfm.bytes.length === realBytes.length);
    check("真文件字节 sha256 一致", sha256(rfm.bytes), sha256(realBytes));
    const rStoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wxfile-real-"));
    const rpipe = new MediaPipeline({ caps: noopCaps, fileStore: new FileStore({ root: rStoreRoot }), nativeImageInput: true });
    await rpipe.hydrate(rd, rp);
    check("真文件 byteLength 对上", rd.media[0].byteLength, realBytes.length);
    check("真文件仓里那份 sha256 一致", sha256(fs.readFileSync(rd.media[0].filePath)), sha256(realBytes));
  }

  // ───────────────────────────── 出站（离线，绝不真发）────────────────────────
  console.log("\n[出站] send_file 意图分发（stub 发送器，不碰微信/剪贴板）");
  check("capability 现在是 supported", new WeChatPlugin({}).capabilities.send_file, "supported");

  const calls = [];
  const sendPlug = new WeChatPlugin({ sender: async () => "x", fileSender: async (a) => { calls.push(a); return null; } });
  const r = await sendPlug.send({ operationId: "op1", chatId: "wxid_her",
    intent: "send_file", toolArgs: { filePath: "/root/out/合同.pdf" } });
  check("走到发文件分支", r.sentAs, "file");
  check("把路径交给了发送器", r.filePath, "/root/out/合同.pdf");
  check("发送器收到 chatId", calls[0] && calls[0].chatId, "wxid_her");
  check("发送器收到 filePath", calls[0] && calls[0].filePath, "/root/out/合同.pdf");

  // 也认 asset.filePath（他自己造好文件直接递进来，跟发语音同一套）
  const calls2 = [];
  const sp2 = new WeChatPlugin({ sender: async () => "x", fileSender: async (a) => { calls2.push(a); return null; } });
  await sp2.send({ operationId: "op2", chatId: "wxid_her", intent: "send_file", asset: { filePath: "/root/a.zip" } });
  check("asset.filePath 也认", calls2[0] && calls2[0].filePath, "/root/a.zip");

  let threw = "";
  try { await sendPlug.send({ operationId: "op3", chatId: "wxid_her", intent: "send_file", toolArgs: {} }); }
  catch (e) { threw = e.message; }
  ok("没给路径就抛 notSent（绝不退成发一行字）", /路径/.test(threw));

  let threw2 = "";
  const noSender = new WeChatPlugin({ sender: async () => "x" });   // 没接 fileSender
  try { await noSender.send({ operationId: "op4", chatId: "wxid_her", intent: "send_file", toolArgs: { filePath: "/x" } }); }
  catch (e) { threw2 = e.message; }
  ok("没接发送器就抛 notSent", /fileSender|还没接/.test(threw2));

  console.log("\n[出站] a11y 发送器装配出 fileSender（走同一把发送锁的 run()）");
  const senders = makeA11ySenders({ GATE_WECHAT_SENDER: "/x.py", GATE_WECHAT_TARGET: "她",
    GATE_WECHAT_SEND_LOCK: "/tmp/x.lock" }, () => {});
  ok("makeA11ySenders 给出 fileSender", typeof senders.fileSender === "function");

  console.log(`\n微信收发文件：通过 ${pass}，失败 ${fail}，跳过 ${skip}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
