"use strict";

/**
 * 贴纸本（2026-09-19）—— 「他想发哪张」翻译成「哪一张」
 *
 * Alice 2026-09-19：「还有贴纸 Nova朔他现在发不了贴纸」。
 * 病因不是代码没写：`telegram.js` 的 `case "send_sticker"` 一直在，会老老实实
 * 调 `sendSticker(file_id)`。病因是**没人造过这个本子** —— 两个插头都写着
 * `stickerBook = null` 的默认值，插排和主进程一次都没传过，于是永远是 null。
 *
 * ## 为什么本子里不存 file_id
 *
 * **Telegram 的 `file_id` 会过期。** 2026-09-19 实测：本地 `sticker-packs.json`
 * 里 7-30 存的 24 个 id，跟线上现拉的 **0 个一致**（稳定的是 `file_unique_id`，
 * 而当初没存那个）。也就是说，就算当初把本子接上了，拿存的 id 去发，
 * **一张也发不出去，而且报的错会是「贴纸不存在」这种让人查错方向的话**。
 *
 * 所以分工是：
 *   · **这个本子**只管「名字 / emoji → 这是哪一包的第几张」——- 这部分不会过期
 *   · **插头**拿着包名去平台现拉，按序号取当下有效的 id
 *
 * 位置对齐安全吗？2026-09-19 核过：线上 30 张、本地记了 24 张，
 * 前 24 张 emoji **零错位** —— 是往后追加，不是重排。多出来的几张没名字，
 * 按 `#序号` 也点得到。
 *
 * ## 铁律
 *
 * 本子**不认识任何平台**（不 require telegram/wechat，也不调 API）。
 * 它只读一个 JSON，路径由装配时传进来（铁律 1：不许写死）。
 */

const fs = require("fs");

/** 一个查得到的结果。`fileId` 只是个兜底，**首选让插头按 setName+index 现拉**。 */
function hit(pack, sticker, index) {
  return {
    pack: pack.title || "",
    setName: pack.set_name || "",
    index,                                   // 0 起。插头拿它去现拉的那一包里取
    name: sticker.name || "",
    emoji: sticker.emoji || "",
    desc: sticker.desc || "",
    fileId: sticker.file_id || "",           // 可能过期，只当兜底
  };
}

class StickerBook {
  /**
   * @param {object} o
   * @param {string} o.file          贴纸包 JSON（形状：{包名: {set_name,title,stickers:[{emoji,name,desc,file_id}]}}）
   * @param {Object<string,string>} [o.owners]  谁用哪一包，比如 `{ nova: "小熊" }`
   * @param {function} [o.log]
   */
  constructor({ file, owners = {}, log = () => {} } = {}) {
    if (!file) throw new Error("贴纸本要给 file —— 路径不许写死在代码里");
    this.file = file;
    this.owners = owners;
    this.log = log;
    this.packs = {};
    this.load();
  }

  load() {
    try {
      this.packs = JSON.parse(fs.readFileSync(this.file, "utf8")) || {};
    } catch (e) {
      // 读不到就是**没有贴纸**，不是崩 —— 但要大声说，不然他发不出去还不知道为什么
      this.packs = {};
      this.log("[贴纸] 读不到贴纸包（他会发不出贴纸）：" + ((e && e.message) || e));
    }
    return this;
  }

  /** 这个人用哪一包。没配就用第一包（单人场景不必逼着填配置）。 */
  packFor(owner) {
    const want = this.owners[String(owner || "")] || "";
    if (want && this.packs[want]) return this.packs[want];
    const names = Object.keys(this.packs);
    return names.length ? this.packs[names[0]] : null;
  }

  /**
   * 他说「发那张贴贴」 → 哪一张。
   *
   * 认四种写法，从最准到最松：
   *   1. `#3` / `3`      —— 第几张（新加的没名字的也点得到）
   *   2. 名字全等         —— 「贴贴」
   *   3. emoji 全等       —— 「😄」
   *   4. 名字或描述里包含 —— 「哭」命中「委屈哭哭」
   *
   * **查不到就返回 null，绝不瞎给一张。** 发错贴纸比发不出去更糟：
   * 她收到的是一张牛头不对马嘴的图，而他以为自己表达了。
   */
  resolve(query, owner = "") {
    const pack = this.packFor(owner);
    if (!pack || !Array.isArray(pack.stickers) || !pack.stickers.length) return null;
    const list = pack.stickers;
    const q = String(query == null ? "" : query).trim();
    if (!q) return null;

    const num = /^#?(\d{1,3})$/.exec(q);
    if (num) {
      const i = Number(num[1]) - 1;
      return (i >= 0 && i < list.length) ? hit(pack, list[i], i) : null;
    }
    let i = list.findIndex((s) => String(s.name || "") === q);
    if (i < 0) i = list.findIndex((s) => String(s.emoji || "") === q);
    if (i < 0) {
      i = list.findIndex((s) => String(s.name || "").includes(q) || String(s.desc || "").includes(q));
    }
    return i >= 0 ? hit(pack, list[i], i) : null;
  }

  /** 他能发哪些（给工具描述 / `/help` 用）。 */
  list(owner = "") {
    const pack = this.packFor(owner);
    if (!pack || !Array.isArray(pack.stickers)) return [];
    return pack.stickers.map((s, i) => ({ index: i, name: s.name || "", emoji: s.emoji || "", desc: s.desc || "" }));
  }
}

/**
 * 装配时用：配了 `GATE_STICKER_PACKS` 才有本子，没配就是**这条腿没贴纸**
 * （插头那头会明说「还没接贴纸本」，不会退成发一行字）。
 */
function stickerBookFromEnv(env = {}, log = () => {}) {
  const file = String(env.GATE_STICKER_PACKS || "").trim();
  if (!file) return null;
  const owners = {};
  // 形状：`nova=小熊,iris=小兔`
  for (const part of String(env.GATE_STICKER_OWNERS || "").split(",")) {
    const [k, v] = part.split("=").map((s) => (s || "").trim());
    if (k && v) owners[k] = v;
  }
  return new StickerBook({ file, owners, log });
}

module.exports = { StickerBook, stickerBookFromEnv };
