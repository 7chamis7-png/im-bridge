"use strict";

/**
 * 微信媒体解码配置（2026-09-17 夜从 shadow.js 抽出来）
 *
 * 图片/语音要能真解出来，微信插头得拿到四样：
 *   imageKey         图片 .dat 的解密 key
 *   attachRoot       附件根目录（语音 silk 在这下面）
 *   imageFileLookup  XML.md5 -> 盘上文件名（查 hardlink.db，微信自己的媒体索引）
 *   voiceLookup      语音行 -> silk 字节（查 media_0.db）
 *
 * 抽出来的理由：影子和生产必须用**同一份**配置。少给一样，`fetchMedia` 会如实报
 * `image_key_missing` / `voice_lookup_missing` —— 不炸，但那条腿就只剩一个标签，
 * 而两边各写一份的话，迟早只有一边跟着改。
 *
 * ⚠️ 读不到密钥/目录**不抛**，退成 `{}`（只解文本）。密钥文件不在、微信没登、
 * 换机器了都会走到这条，桥不能因此起不来。
 */

const fs = require("fs");
const path = require("path");
const { makeVoiceLookup, makeImageFileLookup, makeImageFilesByTime } = require("./media");

// ⚠️ 铁律 1：路径不写死。原来默认 /root/wxkey/*，换台机器就得改代码。

/**
 * @param {object} [o]
 * @param {string} o.keysFile      all_keys.json（含 _db_dir 和各库 enc_key）**必给**
 * @param {string} o.imageKeyFile  image_key.txt **必给**
 * @param {function} [o.log]         读不到时说一声；不给就沉默降级
 * @returns {object} 直接展开进 WeChatPlugin 构造器；读不到时是空对象
 */
function buildWechatMediaConfig({ keysFile, imageKeyFile, log = null } = {}) {
  if (!String(keysFile || "").trim() || !String(imageKeyFile || "").trim()) {
    throw new Error("微信媒体配置要 keysFile 和 imageKeyFile 两个路径 —— 不许用默认值猜");
  }
  try {
    const kdata = JSON.parse(fs.readFileSync(keysFile, "utf8"));
    const dbDir = kdata._db_dir;
    const imageKey = fs.readFileSync(imageKeyFile, "utf8").trim();
    const hlRel = "hardlink/hardlink.db";

    // 2026-10-22 查实：media_0.db 不是「少数语音还没同步到」，是微信 10-20 那次
    // "修复"把活跃库换成了 media_1.db——media_0.db 从那天起就是个 0 字节空文件，
    // all_keys.json 里也没了它的 enc_key。原来写死 "message/media_0.db"，
    // 查的是一具空壳，查几次都是空的，昨晚那个「等一等再查」的重试属于查错了
    // 地方，等多久都没用。db-watch.py 那边（message_N.db）早就是动态找库名，
    // 这儿一直没跟上。现在照 all_keys.json 里**实际存在**的 message/media_*.db
    // 键名找，新的（序号大）优先试，万一正好卡在换库那一刻、字节还留在旧库里，
    // 退回去再试一次旧的——不是靠猜文件名，是靠钥匙文件里写了什么就信什么。
    const mediaRels = Object.keys(kdata)
      .filter((k) => /^message\/media_\d+\.db$/.test(k))
      .sort((a, b) => Number(b.match(/_(\d+)\.db$/)[1]) - Number(a.match(/_(\d+)\.db$/)[1]));
    if (!mediaRels.length) mediaRels.push("message/media_0.db"); // 老格式兜底：钥匙文件里压根没分库

    const voiceLookups = mediaRels.map((rel) => makeVoiceLookup({
      mediaDb: path.join(dbDir, rel),
      key: (kdata[rel] || {}).enc_key || "",
    }));

    return {
      imageKey,
      attachRoot: path.join(dbDir, "..", "msg", "attach"),
      // 收到的文件明文落在 <db_dir>/../msg/file/YYYY-MM/<原文件名>。
      // 2026-09-21：以前只从 GATE_WECHAT_FILES_ROOT 读，9-18 切桥没搬这个变量 → 一直是空 → 每个文件都报「本地没找到」
      //（00:24 她发的 memory.md 4 秒就落盘了，插头压根没去找）。跟 attachRoot 一样从库目录推，不靠环境变量。
      filesRoot: path.join(dbDir, "..", "msg", "file"),
      imageFileLookup: makeImageFileLookup({
        hardlinkDb: path.join(dbDir, hlRel),
        key: (kdata[hlRel] || {}).enc_key || "",
      }),
      // md5 对不上（原图/HEVC 中间版转码后 md5 变了）时按时间窗找候选，2026-09-21
      imageFilesByTime: makeImageFilesByTime({
        hardlinkDb: path.join(dbDir, hlRel),
        key: (kdata[hlRel] || {}).enc_key || "",
      }),
      voiceLookup: (serverId) => {
        for (const lookup of voiceLookups) {
          const r = lookup(serverId);
          if (r && r.length) return r;
        }
        return null;
      },
    };
  } catch (e) {
    if (log) log("微信媒体密钥读不到，退成只解文本（图/语音只剩标签）: " + ((e && e.message) || e));
    return {};
  }
}

module.exports = { buildWechatMediaConfig };
