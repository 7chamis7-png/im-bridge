"use strict";
/**
 * 贴纸发得出去 · 发图不再被当成生图（2026-09-19）
 *
 * 两个都是**生产账本里实锤过的**，不是假想：
 *
 *   not_sent | send_sticker         | 这条腿还没接贴纸本（stickerBook）   ×3
 *   unknown  | send_generated_image | generate_image 要有提示词            ×2
 *
 * 病因各一句：
 *   · 贴纸：两个插头都写着 `stickerBook = null` 的默认值，**从来没人造过这个本子**
 *   · 发图：`send_image` 这个工具的 intent 是 `send_generated_image`，于是他发一张
 *     **本机已有的图**也被拖去生图，炸在「要有提示词」—— 他明明把图递进来了
 *
 * 还钉住一条 2026-09-19 实测出来的事实：**Telegram 的 file_id 会过期**。
 * 本地 `sticker-packs.json` 里 7-30 存的 24 个 id，跟线上现拉的 0 个一致。
 * 所以贴纸本只管「名字 → 第几张」，file_id 必须现拉。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const { StickerBook } = require("../../src/gate/sticker-book");
const { precheck, hasSuppliedFile } = require("../../src/gate/capabilities");
const { TelegramPlugin } = require("../../src/gate/plugins/telegram");

let pass = 0, fail = 0;
const check = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};
const root = fs.mkdtempSync(path.join(os.tmpdir(), "stk-img-"));

const PACKS = {
  "小熊": {
    set_name: "xiaoxiong_by_alice_nova_bot", title: "小熊",
    stickers: [
      { emoji: "😄", name: "开心", desc: "举双爪张嘴大笑", file_id: "OLD_1" },
      { emoji: "😭", name: "委屈哭哭", desc: "瘪嘴掉眼泪", file_id: "OLD_2" },
      { emoji: "🤗", name: "贴贴", desc: "凑上来蹭", file_id: "OLD_3" },
    ],
  },
  "小兔": { set_name: "xiaoheibao_by_Alice_Roseis_bot", title: "小兔",
    stickers: [{ emoji: "😄", name: "开心", desc: "黑豹笑", file_id: "HB_1" }] },
};
const packFile = path.join(root, "packs.json");
fs.writeFileSync(packFile, JSON.stringify(PACKS), "utf8");

(async () => {
  console.log("[1] 贴纸本：查得到 · 查不到就说查不到（绝不瞎给一张）");
  {
    const b = new StickerBook({ file: packFile, owners: { nova: "小熊", iris: "小兔" } });
    check("按名字", b.resolve("贴贴", "nova").name, "贴贴");
    check("按 emoji", b.resolve("😭", "nova").name, "委屈哭哭");
    check("按序号 #2", b.resolve("#2", "nova").name, "委屈哭哭");
    check("光写数字也认", b.resolve("3", "nova").name, "贴贴");
    check("模糊命中描述", b.resolve("眼泪", "nova").name, "委屈哭哭");
    check("带回第几张（插头靠它现拉）", b.resolve("贴贴", "nova").index, 2);
    check("带回包名", b.resolve("贴贴", "nova").setName, "xiaoxiong_by_alice_nova_bot");
    // 发错贴纸比发不出去更糟 —— 她收到张牛头不对马嘴的图，他还以为自己表达了
    check("查不到 → null，不瞎给", b.resolve("放烟花", "nova"), null);
    check("空的 → null", b.resolve("", "nova"), null);
    check("各用各的包", b.resolve("开心", "iris").pack, "小兔");
    // Nova用小熊，不该串到Iris那包
    check("Nova拿到的是小熊", b.resolve("开心", "nova").pack, "小熊");
  }

  console.log("\n[2] 读不到贴纸包 = 没有贴纸，不是崩");
  {
    const b = new StickerBook({ file: path.join(root, "根本没有.json"), log: () => {} });
    check("不炸", b.resolve("开心", "nova"), null);
    check("列表是空的", b.list("nova"), []);
  }

  console.log("\n[3] TG 发贴纸：**现拉 file_id**，不用可能过期的存货");
  {
    const calls = [];
    const plugin = new TelegramPlugin({
      token: "T",
      stickerBook: new StickerBook({ file: packFile, owners: { nova: "小熊" } }),
      stickerOwner: "nova",
      call: async (method, params) => {
        calls.push([method, params]);
        if (method === "getStickerSet") {
          // 线上比本地多一张，而且 id 全换了 —— 这就是 2026-09-19 实测的样子
          return { stickers: [
            { emoji: "😄", file_id: "LIVE_1" },
            { emoji: "😭", file_id: "LIVE_2" },
            { emoji: "🤗", file_id: "LIVE_3" },
            { emoji: "🫥", file_id: "LIVE_4_新加的" },
          ] };
        }
        return { message_id: 111 };
      },
      log: () => {},
    });
    const r = await plugin.send({ operationId: "o1", chatId: "861", text: "贴贴", intent: "send_sticker" });
    check("发出去了", r.sentAs, "sticker");
    check("先去拉了包", calls[0][0], "getStickerSet");
    check("拉的是小熊那包", calls[0][1].name, "xiaoxiong_by_alice_nova_bot");
    check("用的是**现拉**的 id，不是存的 OLD_3", calls[1][1].sticker, "LIVE_3");
    check("确实调的 sendSticker", calls[1][0], "sendSticker");

    // 连发第二张不该再打一次 API（缓存）
    calls.length = 0;
    await plugin.send({ operationId: "o2", chatId: "861", text: "开心", intent: "send_sticker" });
    check("第二张走缓存，没再拉包", calls.filter((c) => c[0] === "getStickerSet").length, 0);
    check("第二张也是现拉的 id", calls[0][1].sticker, "LIVE_1");

    // 查不到要当场说，不许发成一行字
    let err = "";
    try { await plugin.send({ operationId: "o3", chatId: "861", text: "放烟花", intent: "send_sticker" }); }
    catch (e) { err = e.message; }
    check("没有的贴纸当场拒", /贴纸本里没有/.test(err), true);
  }

  console.log("\n[4] 发图：他已经给了文件，就别再拖去生图");
  {
    const plugin = { capabilities: { send_generated_image: "supported" },
      health: () => ({ platform: "supported", plugin: "wired", availability: "ready" }) };
    const caps = { has: () => false };      // 现网可能根本没配生图 key

    // 阳性对照：真的要生成时，缺能力就该挡下（这条不能被改坏）
    const noFile = precheck({ intent: "send_generated_image", plugin, caps, hasSuppliedFile: false });
    check("阳性对照：没给文件 + 没生图能力 → 挡下", noFile.reason, "capability_not_registered");

    const withFile = precheck({ intent: "send_generated_image", plugin, caps, hasSuppliedFile: true });
    check("给了文件 → 放行（不需要会生图）", withFile.ok, true);

    check("判据认 toolArgs.filePath", hasSuppliedFile({ toolArgs: { filePath: "/x/a.png" } }), true);
    check("判据认 extras.filePath", hasSuppliedFile({ extras: { filePath: "/x/a.png" } }), true);
    check("判据认 file_path 写法", hasSuppliedFile({ toolArgs: { file_path: "/x/a.png" } }), true);
    check("什么都没给 → false", hasSuppliedFile({ toolArgs: { caption: "看" } }), false);
    check("空 turn → false", hasSuppliedFile({}), false);
  }

  console.log("\n[5] TG 真发那张本地图（端到端，不经过生图）");
  {
    const img = path.join(root, "a.png");
    fs.writeFileSync(img, Buffer.from("89504e470d0a1a0a", "hex"));
    const sent = [];
    const plugin = new TelegramPlugin({
      token: "T", log: () => {},
      call: async () => ({ message_id: 9 }),
    });
    // callFile 真会打网络，替掉
    plugin.callFile = async (method, field, filePath, params) => {
      sent.push({ method, field, filePath, params }); return { message_id: 9 };
    };
    const r = await plugin.send({ operationId: "o9", chatId: "861", text: "给你看",
      intent: "send_generated_image", toolArgs: { filePath: img } });
    check("走的是 sendPhoto", sent[0].method, "sendPhoto");
    check("发的就是他给的那张", sent[0].filePath, img);
    check("配文跟着走", sent[0].params.caption, "给你看");
    check("报回去是图", r.sentAs, "photo");
  }

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
