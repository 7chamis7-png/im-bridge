"use strict";
/**
 * buildWechatMediaConfig 的媒体库分片选择。
 *
 * 2026-10-22 真实事故：微信 10-20 那次"修复"把活跃库从 media_0.db 换成了
 * media_1.db（message_0.db 同理换成 message_1.db），media_0.db 从那天起是个
 * 0 字节空壳，all_keys.json 里也没了它的 key。代码原来写死 "message/media_0.db"，
 * 查的是空壳——voiceLookup 每次都返回 null，查几次都一样。Nova报的「语音连中
 * 两次取不到」真因在这儿，不是采集器同步慢那点时间差能解释的。
 *
 * 这个测试不碰真实微信库（sqlcipher 换成一个假的，放在临时 PATH 最前面），
 * 只验证**选对库名**这一件事：钥匙文件里有哪个 message/media_N.db 的 key，
 * 就查哪个；序号大的（新的）优先；老格式钥匙文件（没分片）照样能跑。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-mc-"));
let pass = 0, fail = 0;
const check = (n, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(g)} want=${JSON.stringify(w)}`));
  ok ? pass++ : fail++;
};

// 假 sqlcipher：不解密、不认 key，只认「调它的时候指向哪个 db 文件」。
// 只有文件名命中 HAS_DATA_DB 时，才把 PAYLOAD 写到脚本里 writefile() 要求的路径；
// 查错库（比如空壳 media_0.db）就什么也不写，模拟「这库里确实没有」。
const PAYLOAD = "fake-silk-bytes";
const fakeBinDir = fs.mkdtempSync(path.join(root, "bin-"));
const fakeSqlcipherPath = path.join(fakeBinDir, "sqlcipher");
function writeFakeSqlcipher(matchSuffix) {
  // matchSuffix 是真正的字符串后缀（比如 "media_1.db"），这里按长度逐字符比较，
  // 不构造正则——省得在「模板字符串里拼正则字面量」这层再叠一次转义，上次就是
  // 这步把反斜杠拼重了，弄出一条怎么都匹配不上的规则。
  fs.writeFileSync(fakeSqlcipherPath, [
    "#!/usr/bin/env node",
    'const fs = require("fs");',
    "const dbPath = process.argv[process.argv.length - 1];",
    'const script = fs.readFileSync(0, "utf8");',
    "const m = script.match(/writefile\\('([^']+)'/);",
    "if (!m) process.exit(0);",
    "const out = m[1];",
    `if (dbPath.endsWith(${JSON.stringify(matchSuffix)})) fs.writeFileSync(out, ${JSON.stringify(PAYLOAD)});`,
    "process.exit(0);",
    "",
  ].join("\n"));
  fs.chmodSync(fakeSqlcipherPath, 0o755);
}
writeFakeSqlcipher("media_1.db");
process.env.PATH = fakeBinDir + path.delimiter + process.env.PATH;

const { buildWechatMediaConfig } = require("../../src/gate/plugins/wechat/media-config");

function mkDbDir(name) {
  const dbDir = path.join(root, name, "db_storage");
  fs.mkdirSync(path.join(dbDir, "message"), { recursive: true });
  fs.mkdirSync(path.join(dbDir, "hardlink"), { recursive: true });
  // media_1.db 内容不重要（假 sqlcipher 不读它），media_0.db 留成真正的 0 字节，照实况。
  fs.writeFileSync(path.join(dbDir, "message", "media_1.db"), Buffer.alloc(16));
  fs.writeFileSync(path.join(dbDir, "message", "media_0.db"), Buffer.alloc(0));
  fs.writeFileSync(path.join(dbDir, "hardlink", "hardlink.db"), Buffer.alloc(16));
  return dbDir;
}
function mkKeysFile(dbDir, mediaKeys) {
  const p = path.join(root, "keys-" + Math.random().toString(36).slice(2) + ".json");
  fs.writeFileSync(p, JSON.stringify({ _db_dir: dbDir, "hardlink/hardlink.db": { enc_key: "ab".repeat(16) }, ...mediaKeys }));
  return p;
}
const imageKeyFile = path.join(root, "image_key.txt");
fs.writeFileSync(imageKeyFile, "0123456789abcdef");

(async () => {
  console.log("\n[1] 钥匙文件只认 media_1.db（10-20 之后的真实现状）：voiceLookup 查 media_1.db，不是写死的 media_0.db");
  {
    const dbDir = mkDbDir("acct1");
    const keysFile = mkKeysFile(dbDir, { "message/media_1.db": { enc_key: "cd".repeat(16) } });
    const cfg = buildWechatMediaConfig({ keysFile, imageKeyFile });
    const got = cfg.voiceLookup("12345");
    check("查到了 media_1.db 里的字节，不是空壳 media_0.db", got && got.toString(), PAYLOAD);
  }

  console.log("\n[2] 新旧两个 key 都在（换库过渡期）：序号大的先试");
  {
    const dbDir = mkDbDir("acct2");
    const keysFile = mkKeysFile(dbDir, {
      "message/media_1.db": { enc_key: "cd".repeat(16) },
      "message/media_0.db": { enc_key: "ef".repeat(16) },
    });
    const cfg = buildWechatMediaConfig({ keysFile, imageKeyFile });
    const got = cfg.voiceLookup("12345");
    check("两个都在时，先查新的那个就拿到了", got && got.toString(), PAYLOAD);
  }

  console.log("\n[3] 老格式钥匙文件（从没分过片，只有 media_0.db）：退回老路子，不炸");
  {
    const dbDir = path.join(root, "acct3", "db_storage");
    fs.mkdirSync(path.join(dbDir, "message"), { recursive: true });
    fs.mkdirSync(path.join(dbDir, "hardlink"), { recursive: true });
    // 这账号的「唯一」媒体库就叫 media_0.db，还真有数据——用假 sqlcipher 认旧名也能查到。
    fs.writeFileSync(path.join(dbDir, "message", "media_0.db"), Buffer.alloc(16));
    fs.writeFileSync(path.join(dbDir, "hardlink", "hardlink.db"), Buffer.alloc(16));
    // 重写假 sqlcipher：这次认 media_0.db
    writeFakeSqlcipher("media_0.db");
    const keysFile = mkKeysFile(dbDir, { "message/media_0.db": { enc_key: "11".repeat(16) } });
    const cfg = buildWechatMediaConfig({ keysFile, imageKeyFile });
    const got = cfg.voiceLookup("12345");
    check("只有老库名时照样查得到，不会因为没分片就放弃", got && got.toString(), PAYLOAD);
  }

  console.log("\n[4] 哪个库都没有这条语音：如实返回空，不编", "");
  {
    const dbDir = mkDbDir("acct4");
    writeFakeSqlcipher("不存在的后缀，永远不命中"); // 永远不写出任何东西
    const keysFile = mkKeysFile(dbDir, { "message/media_1.db": { enc_key: "cd".repeat(16) } });
    const cfg = buildWechatMediaConfig({ keysFile, imageKeyFile });
    check("真没有就是 null，不是伪造的字节", cfg.voiceLookup("99999"), null);
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}   (隔离目录 ${root})`);
  process.exit(fail ? 1 : 0);
})();
