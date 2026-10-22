"use strict";

/**
 * 公共能力注册表（设计稿 §7.1）
 *
 * **每样能力只有一份实现，所有已接入渠道共同调用。**
 * 这是整座桥最值钱的部分 —— 以后再接任何前端，转写、识图、语音合成、
 * 图片生成都**自动就有**，不用从零开始。新渠道要写的只有「平台怎么收发」。
 *
 * 两条边界：
 *  - 能力是**闸外**的加工（§0.1）。插件从这里取服务，闸本身不调。
 *  - 生成和发送是两个步骤（§7.1）：**先问插件能不能交付，再决定要不要开始昂贵生成。**
 *    别白花钱合成完语音，才发现目标平台发不出去。
 */

/** 平台能力的三个维度分开记（§7.3）—— 混在一起就分不清「不支持」和「没接线」 */
const SUPPORT = { SUPPORTED: "supported", UNSUPPORTED: "unsupported", UNKNOWN: "unknown" };
const WIRED = { WIRED: "wired", NOT_WIRED: "not_wired" };
const AVAIL = { READY: "ready", OFFLINE: "offline", DEGRADED: "degraded" };

class Capabilities {
  constructor() {
    this.impls = new Map();
  }

  /** 注册一份实现。同名重复注册直接报错 —— 「只有一份」是硬要求，不是建议。 */
  register(name, impl) {
    if (this.impls.has(name)) throw new Error("公共能力 " + name + " 已注册，不允许第二份实现");
    if (typeof impl !== "function") throw new Error("公共能力 " + name + " 的实现必须是函数");
    this.impls.set(name, impl);
    return this;
  }

  has(name) { return this.impls.has(name); }

  async call(name, args) {
    const impl = this.impls.get(name);
    if (!impl) throw new Error("公共能力未注册: " + name);
    return impl(args);
  }

  list() { return [...this.impls.keys()].sort(); }
}

/**
 * 一次出站意图能不能落地。**在昂贵生成之前调用。**
 * @returns {{ok:boolean, reason?:string, detail?:object}}
 */
function precheck({ intent, plugin, caps, hasSuppliedFile = false }) {
  if (!plugin) return { ok: false, reason: "plugin_not_wired" };

  const decl = (plugin.capabilities && plugin.capabilities[intent]) || SUPPORT.UNKNOWN;
  if (decl === SUPPORT.UNSUPPORTED) {
    return { ok: false, reason: "platform_unsupported", detail: { intent, channel: plugin.channel } };
  }
  if (decl === SUPPORT.UNKNOWN) {
    return { ok: false, reason: "platform_support_unknown", detail: { intent, channel: plugin.channel } };
  }

  const h = typeof plugin.health === "function" ? plugin.health() : {};
  if (h.plugin === WIRED.NOT_WIRED) return { ok: false, reason: "plugin_not_wired" };
  if (h.availability === AVAIL.OFFLINE) return { ok: false, reason: "channel_offline" };

  // 这个意图需要哪份公共能力？没注册就明说缺哪一份，不静默降级成发文字。
  // ⚠️ **连能力仓本身都没有，也算没注册**（2026-09-18 修）：原来写的是
  // `caps && !caps.has(need)` —— 没传 caps 时整条检查被短路跳过，预检放行，
  // 然后出闸真要去生成时才在 `this.caps.call` 上炸成 capability_failed。
  // §7.1 要的是「先问能不能交付，再决定要不要开始昂贵生成」，
  // 那就必须在这儿挡下，而不是发到一半才发现。
  // ⚠️ **他已经把文件递进来了，就不需要那份"现造一个"的能力**（2026-09-19）。
  // 病历：`send_image` 这个工具的 intent 是 `send_generated_image`，于是他发一张
  // **本机已有的图**（比如自己画笔画完的）也被当成"生成一张图"，
  // 一路走到生图能力上、炸在「generate_image 要有提示词」。
  // 生产账本里两条 `outbound.unknown / generate_image 要有提示词` 就是这么来的。
  // 意图说的是「给她一张图」，**来源可以是他给的路径，也可以是现生成的**。
  const need = hasSuppliedFile ? null : INTENT_NEEDS[intent];
  if (need && (!caps || !caps.has(need))) {
    return { ok: false, reason: "capability_not_registered", detail: { intent, need } };
  }
  return { ok: true };
}

/**
 * 这一轮是不是**已经带着文件**来的。
 *
 * 带了就别再去"生成"一份 —— 那既浪费钱，又会在他明明给了图的时候
 * 报「要有提示词」这种指错方向的错。
 */
function hasSuppliedFile(turn) {
  const t = turn || {};
  const pick = (o) => o && (o.filePath || o.file_path || o.path);
  return Boolean(pick(t.toolArgs) || pick(t.extras));
}

/** 意图 -> 需要的公共能力。没列的意图不需要公共能力（例如纯文本）。 */
const INTENT_NEEDS = {
  send_voice: "synthesize_voice",
  send_generated_image: "generate_image",
};

module.exports = { Capabilities, precheck, SUPPORT, WIRED, AVAIL, INTENT_NEEDS, hasSuppliedFile };
