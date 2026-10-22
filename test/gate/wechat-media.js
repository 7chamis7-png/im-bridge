"use strict";
/**
 * 微信媒体解码：拿 2026-09-17 的真实微信库/文件验证。
 * **只读，不发送、不写生产冷层、不碰Nova。** 读不到真数据就跳过（退出码 0）。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const {
  decryptDatV2, isDatV2, sniffImage, imgMd5FromXml, locateImageDat, makeImageFilesByTime,
  isWxgf, decodeWxgf, makeImageFileLookup,
  decodeWechatSilk, isWechatSilk, makeVoiceLookup,
} = require("../../src/gate/plugins/wechat/media");
const { WeChatPlugin } = require("../../src/gate/plugins/wechat");

const KEYS = "/root/wxkey/all_keys.json";
const IMG_KEY_FILE = "/root/wxkey/image_key.txt";

let pass = 0, fail = 0, skip = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + name + (ok ? "" : "  got=" + JSON.stringify(got) + " want=" + JSON.stringify(want)));
  ok ? pass++ : fail++;
}
function ok(name, cond) { check(name, Boolean(cond), true); }

function sqlc(db, key, sql) {
  const script = 'PRAGMA key = "x\'' + key + '\'";\nPRAGMA cipher_compatibility = 4;\n.headers off\n.mode list\n.separator |\n' + sql + "\n";
  return execFileSync("sqlcipher", ["-batch", db], { input: script, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n").filter((l) => l && l !== "ok");
}

// ——— 纯函数：不碰盘也能测的那几样 ———
console.log("[纯函数] 签名/嗅探/XML md5");
ok("V2 签名认得出", isDatV2(Buffer.from([0x07, 0x08, 0x56, 0x32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
ok("非 V2 不认", !isDatV2(Buffer.from([0xff, 0xd8, 0xff, 0xe0])));
check("嗅出 PNG", sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])), "image/png");
check("嗅出 JPEG", sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])), "image/jpeg");
check("wxgf 私有格式不当图（返回空）", sniffImage(Buffer.from([0x77, 0x78, 0x67, 0x66])), "");
check("从 XML 挑 md5", imgMd5FromXml('<img md5="ec3120c6dbfff716a0db69434193e9a6"/>'), "ec3120c6dbfff716a0db69434193e9a6");
check("没 md5 返回空", imgMd5FromXml("<img/>"), "");
ok("SILK 头认得出（带 0x02 前导）", isWechatSilk(Buffer.from("02232153494c4b5f56330f00", "hex")));
ok("SILK 头认得出（不带前导）", isWechatSilk(Buffer.from("232153494c4b5f56330f0000", "hex")));
ok("wxgf magic 认得出", isWxgf(Buffer.from("7778676613000205", "hex")));
ok("非 wxgf 不认", !isWxgf(Buffer.from([0xff, 0xd8, 0xff, 0xe0])));

// key 长度校验
let threw = false;
try { decryptDatV2(Buffer.from([0x07, 0x08, 0x56, 0x32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), "short"); }
catch { threw = true; }
ok("key 不是 16 字节直接报错", threw);

// ——— 降级：插头没配 key 时不炸，明说 failed ———
(async () => {
  console.log("\n[降级] 没配 key/查询时明说缺哪样，不抛异常");
  const bare = new WeChatPlugin({});
  check("图片没 key", (await bare.fetchMedia({ kind: "image", md5: "x", table: "Msg_x" })).failed, "image_key_missing");
  check("语音没查询", (await bare.fetchMedia({ kind: "voice", serverId: "1" })).failed, "voice_lookup_missing");
  check("未知类型", (await bare.fetchMedia({ kind: "video" })).failed, "unsupported_kind");

  // ——— 真数据：读不到就跳过 ———
  let data, imageKey, dbDir;
  try {
    if (process.env.IM_BRIDGE_REAL_WECHAT !== "1") throw new Error("未设 IM_BRIDGE_REAL_WECHAT=1（默认不碰真实微信库/密钥）");
    data = JSON.parse(fs.readFileSync(KEYS, "utf8"));
    imageKey = fs.readFileSync(IMG_KEY_FILE, "utf8").trim();
    dbDir = data._db_dir;
    if (!dbDir || imageKey.length !== 16) throw new Error("密钥不全");
  } catch (e) {
    console.log("\nSKIP: wechat-media 真数据部分（" + String(e.message).slice(0, 80) + "）");
    console.log("\n通过 " + pass + " / 失败 " + fail + " / 跳过（真数据段未跑）");
    process.exit(fail ? 1 : 0);
  }

  const attachRoot = path.join(dbDir, "..", "msg", "attach");

  // 2026-10-22：微信 10-20 换过活跃库（message_0.db/media_0.db → _1），钥匙文件
  // 里哪个库的 key 还在就是哪个活着。这俩测试原来写死 _0，查真实库时会一声不响
  // 地全跳过（库是空的、key 也没有）——跟生产当时踩的坑是同一个洞，这里也得
  // 跟着挑活的查，不然这段测试测的是一具空壳，一直绿得毫无意义。
  function pickActiveRel(prefix) {
    const rels = Object.keys(data)
      .filter((k) => new RegExp("^message/" + prefix + "_\\d+\\.db$").test(k))
      .sort((a, b) => Number(b.match(/_(\d+)\.db$/)[1]) - Number(a.match(/_(\d+)\.db$/)[1]));
    return rels[0] || "message/" + prefix + "_0.db";
  }

  // —— 收文件：filesRoot 从库目录推，不靠环境变量（2026-09-21，00:24 她发的 memory.md 那单）——
  console.log("\n[收文件] filesRoot 从密钥文件推出来 + 按月份找到明文文件");
  {
    const { buildWechatMediaConfig } = require("../../src/gate/plugins/wechat/media-config");
    const { localFilePath } = require("../../src/gate/plugins/wechat/index");
    const cfg = buildWechatMediaConfig({ keysFile: KEYS, imageKeyFile: IMG_KEY_FILE });
    ok("media 配置带 filesRoot（…/msg/file）", /msg[\/\\]file$/.test(cfg.filesRoot || ""));
    check("filesRoot 空 → 不找、返回空（不猜）", localFilePath("memory.md", 1789921485, ""), "");
    const real = path.join(cfg.filesRoot, "2026-09", "memory.md");
    if (fs.existsSync(real)) {
      check("按消息时间的月份找到真文件", localFilePath("memory.md", 1789921485, cfg.filesRoot), real);
    } else { console.log("  跳过真文件：那份 memory.md 已不在盘上"); skip++; }
  }

  // —— 图片：找真图片消息，走 hardlink 定位 + fetchMedia（含 wxgf→jpg）——
  console.log("\n[真图片] hardlink 定位 + 解密 + wxgf→jpg + fetchMedia");
  const msgRel = pickActiveRel("message");
  const msgDb = path.join(dbDir, msgRel);
  const msgKey = (data[msgRel] || {}).enc_key;
  const hlDb = path.join(dbDir, "hardlink/hardlink.db");
  const hlKey = (data["hardlink/hardlink.db"] || {}).enc_key;
  const imageFileLookup = makeImageFileLookup({ hardlinkDb: hlDb, key: hlKey });
  let imgHit = null;   // { t, md5, createTime, fileName }
  try {
    const tables = sqlc(msgDb, msgKey, "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%';");
    for (const t of tables) {
      if (!/^Msg_[0-9a-f]{32}$/.test(t)) continue;
      const rows = sqlc(msgDb, msgKey,
        "SELECT local_id, create_time, hex(ifnull(message_content,'')) FROM " + t + " WHERE local_type=3 ORDER BY local_id DESC LIMIT 12;");
      for (const line of rows) {
        const p = line.split("|");
        if (p.length < 3) continue;
        let raw = Buffer.from(p[2], "hex");
        if (raw.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))) {
          raw = execFileSync("zstd", ["-d", "-c"], { input: raw, maxBuffer: 16 * 1024 * 1024 });
        }
        const md5 = imgMd5FromXml(raw.toString("utf8"));
        if (!md5) continue;
        const fileName = imageFileLookup(md5);
        const hit = locateImageDat({ table: t, md5, createTime: Number(p[1]), attachRoot, imageKey, fileNameHint: fileName });
        if (hit) { imgHit = { t, md5, createTime: Number(p[1]), fileName }; break; }
      }
      if (imgHit) break;
    }
  } catch (e) { console.log("  (读图片消息出错：" + e.message + ")"); }

  if (imgHit) {
    ok("hardlink 按 XML.md5 查到文件名", /\.dat$/.test(imgHit.fileName || ""));
    const plugin = new WeChatPlugin({ imageKey, attachRoot, imageFileLookup });
    const r = await plugin.fetchMedia({ kind: "image", md5: imgHit.md5, table: imgHit.t }, { createTime: imgHit.createTime });
    ok("fetchMedia 出图片字节", r.bytes && r.bytes.length > 0);
    check("fetchMedia 出的是标准图（jpeg/png…）", /^image\//.test(r.mime || ""), true);
    check("落地字节头是真图 magic（不是 wxgf/乱码）", /^image\//.test(sniffImage(r.bytes)), true);
    console.log("  （命中变体：" + r.variant + "，" + r.mime + "，" + r.bytes.length + " 字节）");
  } else {
    console.log("  跳过：库里没有图片消息可测"); skip++;
  }

  // hardlink 查不到 md5 → 空串；定位不到文件 → null（都不冒充）
  check("hardlink 查不到就返回空", imageFileLookup("f".repeat(32)), "");
  check("定位不到文件时给 null", locateImageDat({ table: "Msg_" + "0".repeat(32), md5: "f".repeat(32), createTime: 1758000000, attachRoot, imageKey, fileNameHint: "nonexistent.dat" }), null);

  // —— md5 对不上时的时间窗兜底（2026-09-21，9-20 19:37 她按原图发的那张）——
  console.log("\n[时间窗兜底] hardlink 按 XML.md5 查不到 → 按 create_time 找候选 → 只认会话目录下真存在的");
  const imageFilesByTime = makeImageFilesByTime({ hardlinkDb: hlDb, key: hlKey });
  check("候选全不存在 → null（不冒充）", locateImageDat({ table: "Msg_" + "0".repeat(32), md5: "f".repeat(32), createTime: 1758000000, attachRoot, imageKey, fileNameHints: ["nope1.dat", "nope2_h.dat"] }), null);
  check("没时间就没候选", imageFilesByTime(0).length, 0);
  {
    // 真案例：XML md5 15f8… 在 hardlink 里查不到；同一分钟落盘的 6e45….dat 是转码后的中间版
    const realT = "Msg_53eb360e3ef5c33f588bb679ff181899", realMd5 = "15f8b4d1065b39e4224babe05c685e39", realTime = 1789904258;
    const realFile = path.join(attachRoot, realT.replace(/^Msg_/, ""), "2026-09", "Img", "6e450a72eb1f46e13d3c8f559ba78f4d.dat");
    if (fs.existsSync(realFile) && imageFileLookup(realMd5) === "") {
      const cands = imageFilesByTime(realTime);
      ok("时间窗候选里有那张转码版", cands.some((n) => n.startsWith("6e450a72eb1f46e13d3c8f559ba78f4d")));
      const plugin2 = new WeChatPlugin({ imageKey, attachRoot, imageFileLookup, imageFilesByTime });
      const r2 = await plugin2.fetchMedia({ kind: "image", md5: realMd5, table: realT }, { createTime: realTime });
      ok("fetchMedia 这回出图了（之前报 image_not_downloaded）", r2.bytes && r2.bytes.length > 0);
      check("标成按时间对上的", r2.matchedBy, "time");
      const plugin3 = new WeChatPlugin({ imageKey, attachRoot, imageFileLookup });   // 没接时间窗 → 行为跟以前一样
      check("不接时间窗仍然如实报没下载", (await plugin3.fetchMedia({ kind: "image", md5: realMd5, table: realT }, { createTime: realTime })).failed, "image_not_downloaded");
    } else {
      console.log("  跳过真案例：那张图已不在盘上（或索引已能按 md5 查到）"); skip++;
    }
  }

  // —— 语音：media_N.db 取 blob → SILK → WAV ——（库名跟着钥匙文件挑活的，见上面 pickActiveRel）
  const mediaRel = pickActiveRel("media");
  console.log("\n[真语音] " + mediaRel + " 取 blob + SILK 解码 + fetchMedia");
  const mediaDb = path.join(dbDir, mediaRel);
  const mediaKey = (data[mediaRel] || {}).enc_key;
  let serverId = "";
  try {
    const rows = sqlc(mediaDb, mediaKey, "SELECT svr_id FROM VoiceInfo LIMIT 1;");
    serverId = (rows[0] || "").trim();
  } catch (e) { console.log("  (读 VoiceInfo 出错：" + e.message + ")"); }

  if (serverId) {
    const voiceLookup = makeVoiceLookup({ mediaDb, key: mediaKey });
    const silk = voiceLookup(serverId);
    ok("按 server_id 取到 SILK blob", silk && silk.length > 0);
    ok("取到的是微信 SILK v3", silk && isWechatSilk(silk));
    try {
      const wav = await decodeWechatSilk(silk);
      ok("SILK 解成 WAV", wav && wav.length > 0);
      check("是 RIFF/WAV 头", wav.subarray(0, 4).toString("latin1"), "RIFF");
      const plugin = new WeChatPlugin({ voiceLookup });
      const r = await plugin.fetchMedia({ kind: "voice", serverId });
      ok("fetchMedia 出语音 WAV 字节", r.bytes && r.bytes.length > 0);
      check("fetchMedia 语音 mime", r.mime, "audio/wav");
    } catch (e) {
      // ⚠️ 分清两件事：外部工具没装 = 环境问题，可以跳过；
      // **脚本本身找不到 = 代码错（路径算错了），必须红。**
      // 2026-09-18 就栽过：插头搬家后脚本路径错了，这里吞成「跳过」，测试一片绿。
      if (/No such file or directory|can't open file/.test(String(e.message))) {
        console.log("  FAIL 解码脚本找不到（路径算错了，不是环境问题）：" + e.message); fail++;
      } else {
        console.log("  跳过 SILK 解码（pilk/ffmpeg 不可用？）：" + e.message); skip++;
      }
    }
  } else {
    console.log("  跳过：VoiceInfo 里没有语音样本"); skip++;
  }

  console.log("\n通过 " + pass + " / 失败 " + fail + (skip ? " / 跳过 " + skip + " 段（真数据不全）" : ""));
  process.exit(fail ? 1 : 0);
})();
