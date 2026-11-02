"use strict";
/**
 * 连发两张照片，桥必须给出两张**不同**的图（2026-10-23 真实故障）。
 *
 * 隔一秒连发两张，账本里两条事件（cdnthumblength 分别 10102 / 10515），
 * 两条的 filePath 却一字不差（同一个 `…/<md5>.jpg`，153996 字节）
 * —— 他看见同一张两遍，她第二张照片等于丢了。
 *
 * 病根不在解密、不在文件仓（文件仓按内容哈希命名，同名就是同内容，它是**证人**不是凶手），
 * 在 locateImageDat 的「时间窗候选」那条路：两条消息 md5 在 hardlink.db 里都查不到
 * （她按原图发，客户端转码落盘，索引记的是转码后 md5），于是都退到按 create_time
 * ±120 秒找候选 —— 两条隔 1 秒，候选表完全同序，谁都取第一个。
 *
 * 修法：用 XML 的 `cdnthumblength` 认人（= 盘上 `<base>_t.dat` 解密后的长度，精确相等）。

 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { locateImageDat, thumbLengthFromXml, imgMd5FromXml } = require("../../src/gate/plugins/wechat/media");
const { WeChatPlugin } = require("../../src/gate/plugins/wechat");
const { MediaPipeline } = require("../../src/gate/media-pipeline");
const { FileStore } = require("../../src/gate/file-store");
const { Capabilities } = require("../../src/gate/capabilities");

let pass = 0, fail = 0;
function check(name, got, want) {
  const okk = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (okk ? "OK  " : "FAIL") + " " + name + (okk ? "" : "  got=" + JSON.stringify(got) + " want=" + JSON.stringify(want)));
  okk ? pass++ : fail++;
}
const ok = (name, cond) => check(name, Boolean(cond), true);

// ——— 造一个 V2 图片 .dat（跟 decryptDatV2 反着来，这样测的是真解密不是假数据）———
const KEY = "0123456789abcdef";
function makeDat(plain) {
  const aeslen = Math.min(1024, plain.length);
  const ctLen = Math.ceil(aeslen / 16) * 16;
  const head = Buffer.alloc(ctLen);
  plain.copy(head, 0, 0, aeslen);
  const c = crypto.createCipheriv("aes-128-ecb", Buffer.from(KEY, "utf8"), null);
  c.setAutoPadding(false);
  const enc = Buffer.concat([c.update(head), c.final()]);
  const tail = Buffer.from(plain.subarray(aeslen));
  for (let i = 0; i < tail.length; i++) tail[i] ^= 0x5f;
  const hdr = Buffer.alloc(15);
  Buffer.from([0x07, 0x08, 0x56, 0x32, 0x00, 0x00]).copy(hdr, 0);
  hdr.writeUInt32LE(aeslen, 6);
  hdr.writeUInt32LE(tail.length, 10);
  return Buffer.concat([hdr, enc, tail]);
}
/** 造一张"图"：JPEG 头 + 填充，内容由 seed 决定（两张必不同） */
function fakeJpeg(bytes, seed) {
  const b = Buffer.alloc(bytes, seed);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(b, 0);
  return b;
}

const TABLE = "Msg_" + "a".repeat(32);
const TALKER = TABLE.replace(/^Msg_/, "");
const CREATE_A = 1792672481;             // 两条隔 1 秒
const CREATE_B = 1792672482;
const YM = "2026-10";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-burst-"));
const attachRoot = path.join(root, "attach");
const imgDir = path.join(attachRoot, TALKER, YM, "Img");
fs.mkdirSync(imgDir, { recursive: true });

// 两张不同的照片，各自一份中间版 .dat + 一份缩略图 _t.dat
const BASE_A = "0".repeat(31) + "a";
const BASE_B = "0".repeat(31) + "b";
const midA = fakeJpeg(153996, 0x11), thumbA = fakeJpeg(10102, 0x12);
const midB = fakeJpeg(110522, 0x21), thumbB = fakeJpeg(10515, 0x22);
fs.writeFileSync(path.join(imgDir, BASE_A + ".dat"), makeDat(midA));
fs.writeFileSync(path.join(imgDir, BASE_A + "_t.dat"), makeDat(thumbA));
fs.writeFileSync(path.join(imgDir, BASE_B + ".dat"), makeDat(midB));
fs.writeFileSync(path.join(imgDir, BASE_B + "_t.dat"), makeDat(thumbB));

// hardlink.db 按 md5 查不到（这正是真实故障的前提），时间窗候选表两条消息完全同序
const HINTS = [BASE_A + ".dat", BASE_B + ".dat"];
const md5 = (b) => crypto.createHash("md5").update(b).digest("hex");

console.log("[1] XML 里挑 cdnthumblength");
const XML_A = '<msg><img cdnthumblength="10102" cdnthumbheight="210" length="39354" '
  + 'md5="' + "1".repeat(32) + '" hevc_mid_size="39354"/></msg>';
const XML_B = '<msg><img cdnthumblength="10515" cdnthumbheight="210" length="31969" '
  + 'md5="' + "2".repeat(32) + '" hevc_mid_size="31969"/></msg>';
check("挑出第一条的缩略图长度", thumbLengthFromXml(XML_A), 10102);
check("挑出第二条的缩略图长度", thumbLengthFromXml(XML_B), 10515);
check("没这个属性就返回 0（判不了，不猜）", thumbLengthFromXml('<msg><img md5="x"/></msg>'), 0);
check("别把 cdnthumbheight 当成 length", thumbLengthFromXml('<msg><img cdnthumbheight="210"/></msg>'), 0);

console.log("\n[2] 病根复现：不给缩略图长度，两条候选同序 → 认成同一张");
{
  const a = locateImageDat({ table: TABLE, md5: "1".repeat(32), createTime: CREATE_A,
    attachRoot, imageKey: KEY, fileNameHints: HINTS });
  const b = locateImageDat({ table: TABLE, md5: "2".repeat(32), createTime: CREATE_B,
    attachRoot, imageKey: KEY, fileNameHints: HINTS });
  ok("两条都定位到了（老代码不报错，这才是坑）", a && b);
  check("老路子两条取到同一个文件 —— 这就是她丢照片的那一步", a.datPath === b.datPath, true);
  check("老路子的落点是 matchedBy=time", [a.matchedBy, b.matchedBy], ["time", "time"]);
}

console.log("\n[3] 修好之后：给了 cdnthumblength → 各认各的");
let hitA, hitB;
{
  hitA = locateImageDat({ table: TABLE, md5: "1".repeat(32), createTime: CREATE_A,
    attachRoot, imageKey: KEY, fileNameHints: HINTS, thumbLength: 10102 });
  hitB = locateImageDat({ table: TABLE, md5: "2".repeat(32), createTime: CREATE_B,
    attachRoot, imageKey: KEY, fileNameHints: HINTS, thumbLength: 10515 });
  ok("两条都定位到了", hitA && hitB);
  check("第一条认到 073afb（时间最近那个）", path.basename(hitA.datPath), BASE_A + ".dat");
  check("第二条认到 536464（候选表里的第二个，老代码永远取不到）", path.basename(hitB.datPath), BASE_B + ".dat");
  check("两个文件不是同一个", hitA.datPath === hitB.datPath, false);
  check("字节也真不一样", md5(hitA.bytes) === md5(hitB.bytes), false);
  check("解出来的就是那两张图本身", [md5(hitA.bytes), md5(hitB.bytes)], [md5(midA), md5(midB)]);
  check("落点标成 thumb（认人靠的是缩略图长度，不是时间）", [hitA.matchedBy, hitB.matchedBy], ["thumb", "thumb"]);
}

console.log("\n[4] 候选顺序反过来也认得对（不靠「第几个」）");
{
  const a = locateImageDat({ table: TABLE, md5: "x", createTime: CREATE_A, attachRoot, imageKey: KEY,
    fileNameHints: [BASE_B + ".dat", BASE_A + ".dat"], thumbLength: 10102 });
  check("候选倒序，第一条还是认到 073afb", path.basename(a.datPath), BASE_A + ".dat");
}

console.log("\n[5] 缩略图长度一个都对不上 → 如实报空，不拿别人的图顶上");
{
  const a = locateImageDat({ table: TABLE, md5: "x", createTime: CREATE_A, attachRoot, imageKey: KEY,
    fileNameHints: HINTS, thumbLength: 999999 });
  check("两个候选都被否 → null（下游报 image_not_downloaded 并重试）", a, null);
}

console.log("\n[6] 缩略图不在盘上 → 判不了，退回老的「时间最近」（不新增失败）");
{
  const dir2 = path.join(root, "attach2", TALKER, YM, "Img");
  fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(path.join(dir2, BASE_A + ".dat"), makeDat(midA));   // 只有中间版，没 _t
  const a = locateImageDat({ table: TABLE, md5: "x", createTime: CREATE_A,
    attachRoot: path.join(root, "attach2"), imageKey: KEY, fileNameHints: HINTS, thumbLength: 10102 });
  ok("缩略图缺位时照旧能定位", a && path.basename(a.datPath) === BASE_A + ".dat");
  check("标成 time（说清这次是判不了退回来的）", a && a.matchedBy, "time");
}

console.log("\n[7] 走完插头 + 流水线：两条交付落成两个不同文件");
(async () => {
  const plugin = new WeChatPlugin({
    imageKey: KEY, attachRoot,
    imageFileLookup: () => "",                       // hardlink 查不到（真实前提）
    imageFilesByTime: () => HINTS.slice(),           // 两条消息拿到同一张候选表
  });
  const caps = new Capabilities();
  const fileStore = new FileStore({ root: path.join(root, "files") });
  const pipe = new MediaPipeline({ caps, fileStore, nativeImageInput: true, retryDelaysMs: [] });

  const mk = (xml, at) => ({
    channel: "wechat", receivedAt: new Date(at * 1000).toISOString(),
    media: [{ kind: "image", ref: "", md5: imgMd5FromXml(xml), table: TABLE, thumbLength: thumbLengthFromXml(xml) }],
  });
  const dA = await pipe.hydrate(mk(XML_A, CREATE_A), plugin);
  const dB = await pipe.hydrate(mk(XML_B, CREATE_B), plugin);
  const mA = dA.media[0], mB = dB.media[0];

  check("第一条没报失败", mA.failed || "", "");
  check("第二条没报失败", mB.failed || "", "");
  check("两条的 filePath 不一样（账本里那两行就是在这儿变成同一个的）", mA.filePath === mB.filePath, false);
  check("两条的 byteLength 各自对（153996 / 110522）", [mA.byteLength, mB.byteLength], [153996, 110522]);
  ok("落盘内容 = 那两张图本身",
    md5(fs.readFileSync(mA.filePath)) === md5(midA) && md5(fs.readFileSync(mB.filePath)) === md5(midB));
  check("两条都当原图递给他（processed=native）", [mA.processed, mB.processed], ["native", "native"]);

  // ——— 语音：同一个病会不会也发生在语音上 ———
  // 不会。语音靠 server_id 认（64 位、全局唯一、一条消息一个），压根没有"按时间猜"这条路。
  console.log("\n[8] 语音不同根：server_id 唯一，两条连发各取各的 blob");
  const blobs = { "111": Buffer.from("02232153494c4b5f5633" + "aa".repeat(40), "hex"),
                  "222": Buffer.from("02232153494c4b5f5633" + "bb".repeat(40), "hex") };
  const vplug = new WeChatPlugin({
    voiceLookup: (sid) => blobs[String(sid)] || null,
    silkDecode: async (silk) => Buffer.concat([Buffer.from("RIFF"), silk]),  // 只验接线，不跑 pilk
  });
  const v1 = await vplug.fetchMedia({ kind: "voice", serverId: "111" });
  const v2 = await vplug.fetchMedia({ kind: "voice", serverId: "222" });
  check("两条语音字节不同", md5(v1.bytes) === md5(v2.bytes), false);
  check("取不到就明说 voice_blob_missing（不拿上一条顶上）",
    (await vplug.fetchMedia({ kind: "voice", serverId: "333" })).failed, "voice_blob_missing");

  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 清不掉不算失败 */ }
  console.log("\n通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})();
