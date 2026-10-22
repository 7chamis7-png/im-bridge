"use strict";

/**
 * 能力面：三层（2026-09-17 Alice「要分哪些是共用的、哪些是只有这个插头才能用的」）
 *
 * 原来只分了两层（公共能力 / 平台支不支持这个意图），漏了第三层，
 * 而漏的地方正好会**静默丢东西**：他在微信轮里给了 `inline_keyboard`，
 * 出闸的 `send()` 签名里压根没这个参数，连报都不报 —— 跟「不许静默丢」直接冲突。
 *
 * ┌─ 第 1 层 **共用能力**（闸外，每样只有一份，所有渠道共用）
 * │    转写 / 识图 / 语音合成 / 图片生成 / **文件仓** —— 新接一个渠道自动就有
 * ├─ 第 2 层 **通用意图**（每个插头都必须表态支不支持）
 * │    发文字 / 发图 / 发文件 / 发语音 / 发贴纸 / 点表情
 * └─ 第 3 层 **插头专属**（只有某个平台有的花样）
 *      TG 的按钮、回复某一条、Markdown；iMessage 的语音气泡；微信什么都没有
 *
 * 判决规则：**第 3 层的东西在不支持的渠道上，必须明说"这个渠道给不了"，不许假装没发生。**
 */

/** 第 1 层：共用能力。左边是能力名，右边是没它就办不成的意图。 */
const SHARED_CAPABILITIES = {
  synthesize_voice: ["send_voice"],
  generate_image: ["send_generated_image"],
  transcribe: [],        // 入站侧用（语音转文字）
  acoustic: [],          // 入站侧用（听语气 north-ear，拼在转写后面）
  // ⚠️ `vision`（识图）2026-09-19 **从这张表上撤了**。Alice：「识图本来Nova
  //    也没有在用 走的是自己的识图」。图片的主路是他自己看原图
  //    （media-pipeline 的 PLAN：image/sticker = "look"），识图只是运行时
  //    吃不下图时的兜底，而那条兜底是死的 —— NOVA_VISION_* 五个配置项
  //    生产里一个都没配，真走到那儿第一行就抛。
  //    留在这张表上的后果是：`missingShared()` 永远报缺一样，面板天天挂个假红。
  //    真要接识图是新写一个独立包，那时再加回来。
  // 2026-09-17 Alice一句「那文件呢」补的第五样：转写和识图都吃文件路径，
  // 得有人保证那个文件真在、叫什么、是什么类型。插头只管从平台拿字节。
  file_store: [],
};

/** 第 2 层：通用意图。每个插头都要在 capabilities 里对这些表态。 */
const COMMON_INTENTS = [
  "send_text", "send_file", "send_voice", "send_sticker", "send_generated_image", "react",
  // 2026-09-18：打电话。**只有「发起」和「挂断」** —— 接听那半跟平台的多端策略
  // 有关（铃声去哪台设备不归桥管），所以不在这张表上。
  "start_call", "end_call",
];

/**
 * 第 3 层：插头专属参数。键是参数名，值是**认它的渠道**。
 * 不在列表里的渠道收到这个参数 → 报 `extra_unsupported`，不静默丢。
 */
const PLUGIN_EXTRAS = {
  inline_keyboard: ["telegram"],            // 选项按钮：只有 Bot API 有
  reply_to_message_id: ["telegram"],        // 回复某一条：微信/iMessage 没有这个概念
  parse_mode: ["telegram"],                 // Markdown 渲染
  emoji: ["telegram"],                      // 气泡角上的表情回应
  message_id: ["telegram"],                 // 点哪一条 / 回哪一条：不给就默认她本轮那条
};

/**
 * 把工具参数按三层分类。
 * @returns {{content:object, extras:object, unsupported:Array<{name:string,channel:string,honoredBy:string[]}>}}
 */
function classifyArgs({ args = {}, channel }) {
  const content = {};
  const extras = {};
  const unsupported = [];
  for (const [k, v] of Object.entries(args)) {
    const honoredBy = PLUGIN_EXTRAS[k];
    if (!honoredBy) { content[k] = v; continue; }
    if (v === undefined || v === null || (Array.isArray(v) && !v.length)) continue;
    if (honoredBy.includes(channel)) extras[k] = v;
    else unsupported.push({ name: k, channel, honoredBy });
  }
  return { content, extras, unsupported };
}

/**
 * 一个插头的能力自检：通用意图有没有表态干净、专属参数认哪些。
 * 用来在接线时把「没接线」和「平台真不支持」分开（§7.3）。
 */
function describePlugin(plugin) {
  const caps = (plugin && plugin.capabilities) || {};
  const channel = plugin && plugin.channel;
  const missing = COMMON_INTENTS.filter((i) => !caps[i]);
  return {
    channel,
    supported: COMMON_INTENTS.filter((i) => caps[i] === "supported"),
    unsupported: COMMON_INTENTS.filter((i) => caps[i] === "unsupported"),
    undeclared: missing,                      // 没表态 = 不知道，闸会按 unknown 挡
    extras: Object.entries(PLUGIN_EXTRAS).filter(([, ch]) => ch.includes(channel)).map(([k]) => k),
  };
}

/** 哪些共用能力还没注册 —— 接线前照这张表点名，别等运行时才发现缺。 */
function missingShared(caps) {
  return Object.keys(SHARED_CAPABILITIES).filter((n) => !(caps && caps.has(n)));
}

module.exports = { SHARED_CAPABILITIES, COMMON_INTENTS, PLUGIN_EXTRAS, classifyArgs, describePlugin, missingShared };
