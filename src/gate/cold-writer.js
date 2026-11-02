"use strict";

/**
 * 唯一冷层写手（设计稿 v1.5 §0.1 / §6）
 *
 * **这是整个系统里唯一一处写冷层的地方。** 插件在结构上拿不到冷层 ——
 * 不是「记得调用」，而是没有这个入口。
 *
 * 现网的反面教材：imessage/bridge.js:50 和 android-wechat/bridge.js:39 各抄了一份
 * recordCold，telegram 走 app.js 第三条路。2026-09-16 新建微信通道时漏抄那一段，
 * 冷层双向 0 条，是Alice问「到底有没有落冷层」才挖出来的。
 *
 * 规则：
 * - **一条记录只有四个字段**（铁律 4，见 docs/SPEC.md §6）：`id` / `role` / `at` / `text`。
 *   哪四个不在这儿定义 —— 从 `envelope.js` 的 `COLD_FIELDS` 取，全桥一份。
 *   2026-09-18 之前这里写 12 个字段（channel/senderId/identity/verdict/turnId…），
 *   而 `envelope.forCold()`（正确的那份）零调用 —— 测试绿是因为它测的是没人走的那条路。
 *   技术字段一律去日志（`store.appendEvent`），靠 `coldId` 串回来。
 *   理由：forge 把冷层原话当真实轮塞回他的会话，混进技术字段就得先剥一遍，
 *   剥不干净他上下文里就会冒出 `verdict: ""` 这种噪音。
 * - 跟**处理事实**走，不按渠道豁免，不拿发送成功当记忆条件。
 * - 图片只存 `[图片]`（§0.4）—— 意思已经保存在他的回复里；存路径会让旧收件箱
 *   路径被再次扫描、把图带回活动上下文。
 * - 验收未通过的正文**不得充当用户原话**，落库时降级成占位符，原文留在事件账本里。
 * - 冷层是**按文件顺序**读的，所以只追加、不回插。
 */

const fs = require("fs");
const path = require("path");

const { COLD_FIELDS } = require("./envelope");

class ColdWriter {
  constructor({ file } = {}) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.seen = this.#loadIds();
  }

  #loadIds() {
    const s = new Set();
    let raw;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      return s;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.id) s.add(o.id);
      } catch { /* 跳过坏行，不让一行坏数据挡住整个索引 */ }
    }
    return s;
  }

  /** 正文落库前的降级：解不出来的不许冒充她的话 */
  static bodyForCold(ev) {
    if (ev.verdict === "undecoded") return "[未解码内容]";
    const media = Array.isArray(ev.media) ? ev.media : [];
    if (!ev.text && media.length) {
      return media.map(ColdWriter.coldMediaLine).join(" ");
    }
    return ev.text || "";
  }

  /**
   * 一件媒体在**冷层**里的样子。跟投给他的那一行不是一回事，差别是故意的：
   *
   * - **看的东西（图/表情/视频）只存标签**（§0.4）。意思已经保存在他的回复里；
   *   存路径会让旧收件箱路径被再次扫描、把图带回活动上下文。
   * - **听的东西存转写的字**。§0.4 那条的理由是「路径会被重新扫描」，转写没有路径，
   *   它就是她说的话本身。只存 `[voice]` 等于一换舱就把她说过的话忘干净
   *   —— 那不是保护，那是失忆。（2026-09-17 接媒体流水线时补的）
   */
  static coldMediaLine(m) {
    const kind = (m && m.kind) || "media";
    if (kind === "voice" || kind === "audio") {
      const t = String((m && m.transcript) || "").trim();
      if (t) return "[语音] " + t;
    }
    return kind === "image" ? "[图片]" : "[" + kind + "]";
  }

  /**
   * 唯一入口。同一 recordId 重复写只落一次（写成功但确认丢失时可安全重试）。
   * @returns {{written: boolean, id: string}}
   */
  write({ recordId, role, ev, text }) {
    if (this.seen.has(recordId)) return { written: false, id: recordId };
    const rec = {
      id: recordId,
      role,
      at: (ev && ev.receivedAt) || new Date().toISOString(),
      text: text != null ? text : ColdWriter.bodyForCold(ev || {}),
    };
    // 铁律 4 是结构上挡住的，不是靠记得住。多一个字段当场炸，不等测试。
    ColdWriter.assertShape(rec);
    fs.appendFileSync(this.file, JSON.stringify(rec) + "\n", { encoding: "utf8", mode: 0o600 });
    this.seen.add(recordId);
    return { written: true, id: recordId };
  }

  /** 冷层记录体检：字段不多不少，就 `COLD_FIELDS` 那四个。 */
  static assertShape(rec) {
    const got = Object.keys(rec).sort();
    const want = COLD_FIELDS.slice().sort();
    if (got.length !== want.length || got.some((k, i) => k !== want[i])) {
      throw new Error(
        "冷层记录只许有 " + want.join(" / ") + "，拿到的是 " + got.join(" / ")
        + " —— 技术字段去日志（见 SPEC §6）",
      );
    }
    return rec;
  }

  count() {
    return this.seen.size;
  }
}


/**
 * 群聊单独落冷层（2026-10-29 Alice：「群聊落单独的冷层吧」）。
 *
 * 主冷层（cold.jsonl）只收她和他的私聊 —— forge 拿它垫暖尾巴、IB 拿它挖、面板翻的也是它。
 * 群里别人的话（亲戚、Iris）不该混进去：换舱时会被当成「她和他的真实对话」塞回他的会话。
 * 所以按聊天分流：群 → `<主冷层目录>/cold-groups/<渠道>/<群id>.jsonl`，一个群一个文件，
 * 格式跟主冷层一模一样（四个字段），写手规矩一样（只追加、去重、铁律 4）。
 *
 * 认群：入站看事件的 chatType；出站看这一轮发往哪个聊天（turn.inboundEvent 的 channel/chatId）
 * —— 微信群 id 以 `@chatroom` 结尾，TG 群 id 是负数。认不出的一律当私聊（落主冷层，跟以前一样）。
 */
function isGroupChat(chat) {
  if (!chat) return false;
  if (chat.chatType) return chat.chatType !== "private";
  const id = String(chat.chatId || chat.chat_id || "");
  const ch = String(chat.channel || chat.platform || "");
  if (ch === "wechat") return id.endsWith("@chatroom");
  if (ch === "telegram") return id.startsWith("-");
  return false;
}

class RoutedColdWriter {
  constructor({ file, groupsDir = "" } = {}) {
    this.main = new ColdWriter({ file });
    this.file = file;
    this.groupsDir = groupsDir || path.join(path.dirname(file), "cold-groups");
    this.groups = new Map();
  }
  /** 群冷层文件路径（面板/排查用）。 */
  groupFile(channel, chatId) {
    const safe = (x) => String(x || "").replace(/[^A-Za-z0-9@._-]/g, "_");
    return path.join(this.groupsDir, safe(channel), safe(chatId) + ".jsonl");
  }
  #writerFor(chat) {
    if (!isGroupChat(chat)) return this.main;
    const f = this.groupFile(chat.channel || chat.platform, chat.chatId || chat.chat_id);
    if (!this.groups.has(f)) this.groups.set(f, new ColdWriter({ file: f }));
    return this.groups.get(f);
  }
  /** 跟 ColdWriter.write 一样，多一个 `chat`（出站给）；入站从 ev 自己认。 */
  write({ recordId, role, ev, text, chat }) {
    const w = this.#writerFor(chat || ev);
    return w.write({ recordId, role, ev, text });
  }
}

module.exports = { RoutedColdWriter, isGroupChat, ColdWriter };
