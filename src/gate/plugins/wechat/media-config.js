"use strict";

/**
 * WeChat media decoding config.
 *
 * To decode images/voice the plugin needs:
 *   imageKey         decryption key for image .dat files
 *   attachRoot       attachment root directory
 *   imageFileLookup  XML md5 -> file name (hardlink.db, WeChat's media index)
 *   voiceLookup      voice row -> silk bytes (media_0.db)
 *
 * Shared by the shadow runner and production so both use the same config.
 * Missing pieces make `fetchMedia` report `image_key_missing` /
 * `voice_lookup_missing` instead of crashing.
 *
 * Unreadable keys/dirs do not throw; they degrade to `{}` (text only), so the
 * bridge still starts when WeChat is logged out or keys are missing.
 */

const fs = require("fs");
const path = require("path");
const { makeVoiceLookup, makeImageFileLookup, makeImageFilesByTime } = require("./media");

// No default paths: both key files must be configured explicitly.

/**
 * @param {object} [o]
 * @param {string} o.keysFile      all_keys.json (with _db_dir and per-DB enc_key), required
 * @param {string} o.imageKeyFile  image key file, required
 * @param {function} [o.log]         reports degradation; silent if omitted
 * @returns {object} spread into the WeChatPlugin constructor; {} when unreadable
 */
function buildWechatMediaConfig({ keysFile, imageKeyFile, log = null } = {}) {
  if (!String(keysFile || "").trim() || !String(imageKeyFile || "").trim()) {
    throw new Error("微信媒体配置要 keysFile 和 imageKeyFile 两个路径 —— 不许用默认值猜");
  }
  try {
    const kdata = JSON.parse(fs.readFileSync(keysFile, "utf8"));
    const dbDir = kdata._db_dir;
    const imageKey = fs.readFileSync(imageKeyFile, "utf8").trim();
    const mediaRel = "message/media_0.db";
    const hlRel = "hardlink/hardlink.db";
    return {
      imageKey,
      attachRoot: path.join(dbDir, "..", "msg", "attach"),
      // Received files are stored unencrypted in <db_dir>/../msg/file/YYYY-MM/<name>.
      // Derived from the DB dir like attachRoot, so no extra env var is required.
      filesRoot: path.join(dbDir, "..", "msg", "file"),
      imageFileLookup: makeImageFileLookup({
        hardlinkDb: path.join(dbDir, hlRel),
        key: (kdata[hlRel] || {}).enc_key || "",
      }),
      // time-window fallback when the md5 doesn't match (client re-encoded the image)
      imageFilesByTime: makeImageFilesByTime({
        hardlinkDb: path.join(dbDir, hlRel),
        key: (kdata[hlRel] || {}).enc_key || "",
      }),
      voiceLookup: makeVoiceLookup({
        mediaDb: path.join(dbDir, mediaRel),
        key: (kdata[mediaRel] || {}).enc_key || "",
      }),
    };
  } catch (e) {
    if (log) log("WeChat media keys unreadable, text only (images/voice become placeholders): " + ((e && e.message) || e));
    return {};
  }
}

module.exports = { buildWechatMediaConfig };
