"use strict";

/**
 * 影子跑：拿真实微信流量喂新闸，只看结果，不参与任何生产行为。
 *
 * 目的（Alice 2026-09-17 04:25）：**用真实流量验证新桥**。
 * 今晚 96 项测试全是我自己造的样本，而当晚那条 zstd 证明现实会给出想不到的输入
 * —— 设计稿写完 14 分钟就被打脸。
 *
 * 严格边界：
 *  - **只读**微信库，与生产采集器 linux-db-watch.py 并行，互不干扰（轮询更慢，10s）
 *  - **不发送、不注入、不写生产冷层、不碰Nova**
 *  - 全部状态写在隔离目录 /root/.nova-gate/shadow/
 *
 * ⚠️ **Telegram 绝不能碰 getUpdates** —— 它只允许一个消费者，影子去拉就会把消息
 * 从生产 listener 嘴里抢走。所以走旁路：只读 listener 自己的收件箱
 * /root/.nova/telegram-handoff.db（WAL 模式，支持并发只读）。
 *
 * 两条渠道**共用同一个编号域**，这样顺便验证 A29（跨渠道一条序列）。
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { GateStore } = require("./store");
const { ColdWriter } = require("./cold-writer");
const { InboundGate } = require("./inbound");
const { WeChatPlugin } = require("./plugins/wechat/index");
const { TelegramPlugin } = require("./plugins/telegram");
const { Capabilities } = require("./capabilities");
const { FileStore } = require("./file-store");
const { MediaPipeline } = require("./media-pipeline");
const { makeIntake } = require("./wire");
const { DatabaseSync } = require("node:sqlite");

// 影子是**用桥的人**，路径归它给（桥自己不许写死，见 docs/SPEC.md 铁律 1）。
const { homePath, gateRoot, personaStateDir } = require("../core/paths");
const KEYS = process.env.GATE_SHADOW_KEYS || homePath("wxkey", "all_keys.json");
const IMAGE_KEY = process.env.GATE_SHADOW_IMAGE_KEY || homePath("wxkey", "image_key.txt");
const REL = "message/message_0.db";
const ROOT = path.join(gateRoot(), "shadow");
const CURSOR = path.join(ROOT, "cursor.json");
const LOG = path.join(ROOT, "shadow.log");
const POLL_MS = 10000;

fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });

function log(msg) {
  const t = new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
  const line = t + " 京时 | " + msg;
  console.log(line);
  try { fs.appendFileSync(LOG, line + "\n", { mode: 0o600 }); } catch { /* 日志写不了也不该拖垮影子 */ }
}

function sqlcipher(db, key, sql) {
  const script = 'PRAGMA key = "x\'' + key + '\'";\nPRAGMA cipher_compatibility = 4;\n.headers off\n.mode list\n.separator |\n' + sql + "\n";
  const out = execFileSync("sqlcipher", ["-batch", db], { input: script, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\n").filter((l) => l && l !== "ok");
}

function readCursor() {
  try { return JSON.parse(fs.readFileSync(CURSOR, "utf8")); } catch { return {}; }
}
function saveCursor(c) {
  const tmp = CURSOR + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CURSOR);
}

const store = new GateStore({ root: ROOT });
const cold = new ColdWriter({ file: path.join(ROOT, "cold.jsonl") });
// 影子也把媒体解码配置接上：图片 key / attach 目录 / 语音查询。影子只读——
// 解密取字节不等于发送，验的是「新架构在真数据上解得对」。给不了的那样自动降级。
const { buildWechatMediaConfig } = require("./plugins/wechat/media-config");
const mediaCfg = buildWechatMediaConfig({ keysFile: KEYS, imageKeyFile: IMAGE_KEY, log });
const plugin = new WeChatPlugin(mediaCfg);                 // 无 sender：影子不发送
const tgPlugin = new TelegramPlugin({});                   // 同上
const gate = new InboundGate({
  store, cold,
  identities: {
    // ⚠️ 2026-09-17 修：原来写的是昵称 "Alice-wx"，而驱动又把每一行都硬标成这个
    // 昵称，等于谁说的都算她说的。改成**平台真实身份**（wxid），昵称可改可重名，
    // 不配当身份。她的 wxid 已用正例核过：md5(wxid_example0001) 正好是
    // 你俩会话表 Msg_53eb360e3ef5c33f588bb679ff181899 的表名摘要。
    "wechat:wxid_example0001": "alice",
    "telegram:1000000001": "alice",                        // 她的 TG 私聊
  },                                                       // 只认她；别人一律 unknown 不投递
});

// ==== 媒体流水线：影子也走，而且走的是**跟生产同一个入口** ====
// 9-17 之前影子自己 toDelivery + accept，媒体那一段两边都没接 —— 影子验过的
// 不代表生产走的那条。现在两边都走 makeIntake，影子验的就是真交付。
//
// ⚠️ 转写/识图/声学**默认不注册**。影子是只读观察，whisper 是要花钱的外部调用，
// 不能因为她发了条语音就自动烧钱。要验真语音那条腿，显式开：
//     GATE_SHADOW_TRANSCRIBE=1 pm2 restart gate-shadow --update-env
// 不开的时候语音会如实说「转写没接上，音频已存在 xxx.wav」—— 那正是要看的：
// 解密+落仓这两步对不对，跟转写通不通是两件事。
const caps = new Capabilities();
{
  const store2 = new FileStore({ root: path.join(ROOT, "files") });
  const fileStore = async (args = {}) => (args.verify ? store2.verify(args.verify) : store2.put(args));
  fileStore.store = store2;
  caps.register("file_store", fileStore);
  try {
    const { buildSharedCapabilities } = require("../host/gate-capabilities");
    const auto = buildSharedCapabilities({ fileStoreRoot: path.join(ROOT, "files") });
    if (auto.fetch_bytes) caps.register("fetch_bytes", auto.fetch_bytes);   // 表情包直链要下载
    if (process.env.GATE_SHADOW_TRANSCRIBE === "1") {
      if (auto.transcribe) caps.register("transcribe", auto.transcribe);
      if (auto.acoustic) caps.register("acoustic", auto.acoustic);
      log("⚠️ 影子已开启真实转写/声学（会调外部服务）");
    }
  } catch (e) { log("共用能力装不上（影子退成只落仓）: " + e.message); }
}
const mediaPipeline = new MediaPipeline({
  caps,
  fileStore: caps.impls.get("file_store").store,
  nativeImageInput: true,     // Nova自己看得了图 —— 主路是递原图，不是花钱识图
});

/** 影子的入站唯一入口。跟 buildGate 里那条是同一个函数。 */
const intake = makeIntake({
  inbound: gate,
  media: mediaPipeline,
  pluginFor: (ch) => (ch === "wechat" ? plugin : ch === "telegram" ? tgPlugin : null),
});

// ⚠️ 2026-09-17：原来 no_content 没有独立计数，而闸对它照样返回 accepted:true，
// 于是 1633 条空正文全被记成「已接受」，统计表一片绿。**验收未过的必须单独可见。**
/**
 * 本机微信账号（与 linux-db-watch.py:self_wxid 同法）。
 * 微信库里**一个会话一张表，收发两方躺在同一张表里**，靠 real_sender_id 区分——
 * 数据库没有「入站/出站」之分。读库这条路必须自己判方向，否则Nova自己说的话
 * 会被当成她的入站再喂回给他（2026-09-17 影子第一夜：812 条里 620 条是他自己的）。
 */
function selfWxid(dbDir) {
  return path.basename(path.dirname(dbDir)).replace(/_de[0-9a-f]+$/, "");
}

const stats = { polls: 0, seen: 0, accepted: 0, undecoded: 0, noContent: 0, blocked: 0,
                selfEcho: 0, dup: 0, errors: 0, mediaOk: 0, mediaFailed: 0,
                byChannel: { wechat: 0, telegram: 0 } };
const TG_DB = path.join(personaStateDir(), "telegram-handoff.db");

/**
 * 收件箱里一条 payload -> Bot API 风格的 message。
 *
 * ⚠️ 2026-09-17 修：原来取 `origin.inner`，**收件箱 payload 里压根没有这个字段**，
 * 于是 1633 条 TG 全是空正文（verdict=no_content），而闸对 no_content 照样放行，
 * 真切生产就是每条到Nova那儿都一片空白。正文实际在顶层 `payload.text`，
 * 外面套着 listener 加的 <channel …> 壳和一段给他的提示语。
 */
const CHANNEL_RE = /<channel\b([^>]*)>\n?([\s\S]*?)\n?<\/channel>/;

function parseEnvelope(payloadText) {
  const m = CHANNEL_RE.exec(String(payloadText || ""));
  if (!m) return null;                       // 壳都没有就别猜，交回 null 让调用方记一笔
  const attrs = {};
  for (const a of m[1].matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = a[2];
  return { attrs, body: m[2] };
}

/** Telegram：只读 listener 的收件箱，**绝不调 getUpdates**（单消费者，会抢生产的消息） */
async function tickTelegram() {
  let db;
  try {
    db = new DatabaseSync(TG_DB, { readOnly: true });
  } catch (e) { stats.errors += 1; log("TG 库打不开: " + e.message); return; }
  try {
    const cursor = readCursor();
    const last = Number(cursor.__tg_rowid || 0);
    const rows = db.prepare(
      "SELECT rowid, payload FROM messages WHERE rowid > ? ORDER BY rowid LIMIT 200").all(last);
    let maxRow = last;
    for (const r of rows) {
      maxRow = Math.max(maxRow, Number(r.rowid));
      let payload, o;
      try { payload = JSON.parse(r.payload); o = payload.origin; } catch { continue; }
      if (!o || o.channel !== "telegram" || !o.messageId) continue;
      if (o.chatType !== "private") continue;            // 群聊这轮不看：没有真实 sender id

      const env = parseEnvelope(payload.text);
      if (!env) { stats.errors += 1; log("TG 收件箱 rowid=" + r.rowid + " 没有 <channel> 壳，跳过不猜"); continue; }

      // 附件：壳的属性里带 attachment_type / attachment_path。
      // 幽灵入站的破绽之一就是 path 指向不存在的文件（见记忆 project-forged-inbound-signature），
      // 影子只记一笔、不拦——她的方针是症状留可见。
      const media = [];
      let body = env.body;
      if (env.attrs.attachment_path) {
        const ap = env.attrs.attachment_path;
        media.push({ kind: env.attrs.attachment_type || "file", ref: ap });
        if (body.trim() === ap.trim()) body = "";        // 正文就是文件路径时，那不是她的话
        if (!fs.existsSync(ap)) log("⚠️ TG msg=" + o.messageId + " 附件文件不存在: " + ap);
      }

      stats.seen += 1;
      try {
        const res = await intake({
          channel: "telegram",
          raw: {
            message_id: o.messageId,
            text: body,
            chat: { id: o.chatId, type: "private" },
            from: { id: o.chatId },                      // 私聊里 chatId 就是对方 user id
            date: Math.floor(new Date(o.ts || Date.now()).getTime() / 1000),
            botAccountId: "tg-shadow",
          },
          extraMedia: media,                             // 壳属性里的附件，并进来一起加工
        });
        if (res.duplicate) stats.dup += 1;
        else if (!res.accepted) stats.blocked += 1;
        else if (res.event.verdict === "undecoded") {
          stats.undecoded += 1;
          log("UNDECODED telegram message_id=" + o.messageId);
        } else if (res.event.verdict === "no_content") {
          stats.noContent += 1;
          log("NO_CONTENT telegram msg=" + o.messageId + " " + JSON.stringify(res.event.verifyReasons));
        } else {
          stats.accepted += 1; stats.byChannel.telegram += 1;
          log("#" + res.event.userSeq + " telegram msg=" + o.messageId + " "
            + (res.event.text || "").length + "字" + mediaNote(res.event));
        }
      } catch (e) { stats.errors += 1; log("TG 处理 " + o.messageId + " 出错: " + e.message); }
    }
    if (maxRow > last) { const c = readCursor(); c.__tg_rowid = maxRow; saveCursor(c); }
  } catch (e) { stats.errors += 1; log("TG 轮询出错: " + e.message); }
  finally { try { db.close(); } catch { /* 关不掉也不该拖垮影子 */ } }
}

async function tick() {
  stats.polls += 1;
  let data, db, key;
  try {
    data = JSON.parse(fs.readFileSync(KEYS, "utf8"));
    db = path.join(data._db_dir, REL);
    key = data[REL].enc_key;
  } catch (e) { stats.errors += 1; log("读密钥失败: " + e.message); return; }

  const cursor = readCursor();
  const me = selfWxid(data._db_dir);
  let tables, idToUser;
  try {
    tables = sqlcipher(db, key, "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%';");
    idToUser = new Map();
    for (const row of sqlcipher(db, key, "SELECT rowid, user_name FROM Name2Id;")) {
      const p = row.split("|");
      if (p.length >= 2) idToUser.set(Number(p[0]), p[1]);
    }
  } catch (e) { stats.errors += 1; log("列表失败: " + e.message); return; }
  if (!idToUser.size) { stats.errors += 1; log("Name2Id 读空——宁可这一轮不收，也不猜发送者"); return; }

  for (const t of tables) {
    if (!/^Msg_[0-9a-f]{32}$/.test(t)) continue;
    const last = Number(cursor[t] || 0);
    let rows;
    try {
      rows = sqlcipher(db, key,
        "SELECT local_id, local_type, real_sender_id, create_time, hex(ifnull(message_content,'')), server_id FROM " + t +
        " WHERE local_id > " + last + " ORDER BY local_id LIMIT 200;");
    } catch (e) { stats.errors += 1; continue; }

    let maxId = last;
    for (const line of rows) {
      const p = line.split("|");
      if (p.length < 5) continue;
      const localId = Number(p[0]);
      maxId = Math.max(maxId, localId);

      // ==== 方向判定（读库这条路必须自己做）====
      // real_sender_id 原来查出来就丢了，每行硬写 "Alice-wx"。现在按它解析真实
      // wxid：本机自己发出去的**根本不是入站事件**，在进闸之前就丢，不占编号、
      // 不进冷层。别人的话交给闸按 unknown 挡（那是身份问题，要留痕）。
      const senderWxid = idToUser.get(Number(p[2])) || "";
      if (!senderWxid) { stats.errors += 1; log("发送者解析不出 local_id=" + localId + " real_sender_id=" + p[2]); continue; }
      if (senderWxid === me) { stats.selfEcho += 1; continue; }

      stats.seen += 1;
      try {
        const r = await intake({
          channel: "wechat",
          raw: {
            table: t, local_id: localId, local_type: Number(p[1]), create_time: Number(p[3]),
            raw: Buffer.from(p[4], "hex"), server_id: p[5] || "", sender: senderWxid, accountId: "wx-shadow",
          },
        });
        if (r.duplicate) stats.dup += 1;
        else if (!r.accepted) stats.blocked += 1;
        else if (r.event.verdict === "undecoded") {
          stats.undecoded += 1;
          log("UNDECODED local_id=" + localId + " type=" + p[1] + " processing=" + JSON.stringify(r.event.processing));
        } else if (r.event.verdict === "no_content") {
          stats.noContent += 1;
          log("NO_CONTENT wechat local_id=" + localId + " type=" + p[1] + " " + JSON.stringify(r.event.verifyReasons));
        } else {
          stats.accepted += 1; stats.byChannel.wechat += 1;
          log("#" + r.event.userSeq + " wechat local_id=" + localId + " type=" + p[1] + " "
            + (r.event.text || "").length + "字" + mediaNote(r.event));
        }
      } catch (e) { stats.errors += 1; log("处理 local_id=" + localId + " 出错: " + e.message); }
    }
    if (maxId > last) { cursor[t] = maxId; saveCursor(cursor); }
  }
}

/** 媒体加工到哪一步了 —— 影子最该盯的就是这一列（以前根本看不见）。 */
function mediaNote(ev) {
  const items = Array.isArray(ev.media) ? ev.media : [];
  if (!items.length) return "";
  return " 媒体[" + items.map((m) => {
    const k = (m && m.kind) || "?";
    if (m && m.failed) { stats.mediaFailed += 1; return k + ":✗" + m.failed; }
    if (m && m.processed) { stats.mediaOk += 1; return k + ":" + m.processed + "/" + (m.byteLength || 0) + "B"; }
    return k + ":未取";
  }).join(" ") + "]";
}

async function tickAll() { await tick(); await tickTelegram(); }

log("影子启动。只读微信库 + TG 收件箱旁路，不发送、不注入、不写生产冷层。存储在 " + ROOT);
tickAll();
setInterval(tickAll, POLL_MS);
setInterval(() => log("统计 " + JSON.stringify(stats)), 30 * 60 * 1000);
process.on("SIGTERM", () => { log("收到 SIGTERM，统计 " + JSON.stringify(stats)); process.exit(0); });
