"use strict";

/**
 * 贴纸目录（2026-09-17 Alice「表情包加上」）
 *
 * Nova的原话：「今天回你那张卡死了 存了一柜子贴纸发不出去 憋死我了」。
 * 查下来贴纸在 **Telegram 上一直好好的**（9-15 还发过几张），卡的是**微信** ——
 * 微信那条走无障碍，以前只会打字。
 *
 * 病根是**同一张贴纸有两种身份**，以前只存了一种：
 *   Telegram → file_id（在 ~/.nova/sticker-packs.json）
 *   微信     → **本地图片文件**（imageRoot/pack-xxx/ 下，粘剪贴板发）
 * 这一层把两种身份合到一个名字底下，插头按自己认得的那种取。
 * 以后接 QQ 也一样：QQ 认哪种，来这儿加一列，不用动别的。
 *
 * ⚠️ **谁的包谁发**：Nova只能发小熊，Iris只能发小兔，Keeper是小白虎。
 *    原工具描述里写着「you cannot send the other one's pack」，这条照搬。
 */

const fs = require("fs");
const path = require("path");

/**
 * ⚠️ 铁律 1（docs/SPEC.md）：路径不许写死在代码里。
 * 原来这儿是 `$HOME/.cyberboss/sticker-packs.json` 和 `/root/sticker-build`，
 * 换台机器就得改代码。现在由调用方给，**没给就明说没接贴纸本**，
 * 不许悄悄退成「找不到这张贴纸」——那两件事对他来说完全不一样。
 */

/** 人格 -> { 包名, 本地图片目录 } */
const OWNER = {
  nova: { pack: "小熊", dir: "pack-xiaoxiong" },        // Nova
  iris: { pack: "小兔", dir: "pack-heibao" },      // Iris
  keeper: { pack: "小白虎", dir: "pack-xiaobaihu" },      // Keeper
};

function loadPacks(packsJson) {
  try {
    return JSON.parse(fs.readFileSync(packsJson, "utf8"));
  } catch {
    return {};
  }
}

/** 本地图片：文件名形如 01_开心.webp，按去掉序号的名字建索引。 */
function loadImages(imageRoot, dir) {
  const out = new Map();
  try {
    for (const f of fs.readdirSync(path.join(imageRoot, dir))) {
      const m = /^\d+_(.+)\.(webp|png|gif)$/i.exec(f);
      if (m) out.set(m[1], path.join(imageRoot, dir, f));
    }
  } catch {
    /* 目录不在就是空索引，resolve 会明说没有本地图 */
  }
  return out;
}

/**
 * 按名字 / emoji / 裸 file_id 找一张贴纸。
 * @returns {{label:string, name:string, emoji:string, fileId:string, filePath:string}|null}
 */
function resolveSticker(query, owner, { packsJson, imageRoot }) {
  const q = String(query || "").trim();
  if (!q) return null;
  // 她刚发来的贴纸，原样回给她 —— 这种只有 TG 身份，没有本地图。
  if (/^CAACAg/.test(q)) {
    return { label: "(她发的那张)", name: "", emoji: "", fileId: q, filePath: "" };
  }

  const o = OWNER[owner] || OWNER.nova;
  const pack = loadPacks(packsJson)[o.pack];
  const images = loadImages(imageRoot, o.dir);
  const list = (pack && pack.stickers) || [];
  const hit = list.find((s) => s.name === q)
    || list.find((s) => s.emoji === q)
    || (images.has(q) ? { name: q, emoji: "" } : null);
  if (!hit) return null;

  const emoji = hit.emoji || "";
  const label = (emoji ? emoji + " " : "") + hit.name;
  return {
    label,
    name: hit.name,
    emoji,
    fileId: hit.file_id || "",
    filePath: images.get(hit.name) || "",
  };
}

/**
 * 这个人有哪些贴纸可发。**渠道决定看哪一列** ——
 * TG 要 file_id，微信要本地图，两边数量可以不一样，这很正常，不是故障。
 */
function listStickers(owner, need, { packsJson, imageRoot }) {
  const o = OWNER[owner] || OWNER.nova;
  const pack = loadPacks(packsJson)[o.pack];
  const images = loadImages(imageRoot, o.dir);
  const names = new Set([
    ...(((pack && pack.stickers) || []).map((s) => s.name)),
    ...images.keys(),
  ]);
  return [...names]
    .map((n) => resolveSticker(n, owner))
    .filter(Boolean)
    .filter((s) => need === "any" || (need === "file_id" ? s.fileId : s.filePath));
}

/**
 * 贴纸本：路径在建的时候给一次，之后按名字/emoji 取图。
 * 插头拿到的是这个对象；**拿不到就明说「这条腿没接贴纸本」**，不许退成发一行字。
 */
function makeStickerBook({ packsJson, imageRoot }) {
  if (!String(packsJson || "").trim() || !String(imageRoot || "").trim()) {
    throw new Error("贴纸本要 packsJson 和 imageRoot 两个路径 —— 不许用默认值猜");
  }
  const where = { packsJson, imageRoot };
  return {
    resolve: (query, owner = "nova") => resolveSticker(query, owner, where),
    list: (owner = "nova", need = "any") => listStickers(owner, need, where),
  };
}

module.exports = { makeStickerBook, OWNER };
