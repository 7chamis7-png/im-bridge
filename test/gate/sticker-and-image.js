"use strict";
/**
 * Stickers can be sent; sending an existing image is not treated as image generation.
 *
 *   - Stickers: the sticker book must actually be wired into the plugins.
 *   - Images: `send_image` has intent `send_generated_image`; when the agent passes
 *     an existing local file it must be sent as is, not routed to generation
 *     (which fails with "prompt required").
 *
 * Also pins down that Telegram file_ids go stale: the sticker book only maps
 * name -> index, and the file_id is fetched live.
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
  "wolf": {
    set_name: "wolf_pack_by_example_bot", title: "wolf",
    stickers: [
      { emoji: "😄", name: "开心", desc: "举双爪张嘴大笑", file_id: "OLD_1" },
      { emoji: "😭", name: "委屈哭哭", desc: "瘪嘴掉眼泪", file_id: "OLD_2" },
      { emoji: "🤗", name: "贴贴", desc: "凑上来蹭", file_id: "OLD_3" },
    ],
  },
  "panther": { set_name: "panther_pack_by_example_bot", title: "panther",
    stickers: [{ emoji: "😄", name: "开心", desc: "笑", file_id: "HB_1" }] },
};
const packFile = path.join(root, "packs.json");
fs.writeFileSync(packFile, JSON.stringify(PACKS), "utf8");

(async () => {
  console.log("[1] 贴纸本：查得到 · 查不到就说查不到（绝不瞎给一张）");
  {
    const b = new StickerBook({ file: packFile, owners: { agent: "wolf", other: "panther" } });
    check("按名字", b.resolve("贴贴", "agent").name, "贴贴");
    check("按 emoji", b.resolve("😭", "agent").name, "委屈哭哭");
    check("按序号 #2", b.resolve("#2", "agent").name, "委屈哭哭");
    check("光写数字也认", b.resolve("3", "agent").name, "贴贴");
    check("模糊命中描述", b.resolve("眼泪", "agent").name, "委屈哭哭");
    check("带回第几张（插头靠它现拉）", b.resolve("贴贴", "agent").index, 2);
    check("带回包名", b.resolve("贴贴", "agent").setName, "wolf_pack_by_example_bot");
    // sending the wrong sticker is worse than sending none
    check("查不到 → null，不瞎给", b.resolve("放烟花", "agent"), null);
    check("空的 → null", b.resolve("", "agent"), null);
    check("各用各的包", b.resolve("开心", "other").pack, "panther");
    // each identity uses its own pack
    check("agent 拿到的是自己那包", b.resolve("开心", "agent").pack, "wolf");
  }

  console.log("\n[2] 读不到贴纸包 = 没有贴纸，不是崩");
  {
    const b = new StickerBook({ file: path.join(root, "根本没有.json"), log: () => {} });
    check("不炸", b.resolve("开心", "agent"), null);
    check("列表是空的", b.list("agent"), []);
  }

  console.log("\n[3] TG 发贴纸：**现拉 file_id**，不用可能过期的存货");
  {
    const calls = [];
    const plugin = new TelegramPlugin({
      token: "T",
      stickerBook: new StickerBook({ file: packFile, owners: { agent: "wolf" } }),
      stickerOwner: "agent",
      call: async (method, params) => {
        calls.push([method, params]);
        if (method === "getStickerSet") {
          // the live pack has one more sticker and all ids changed
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
    check("拉的是配置的那包", calls[0][1].name, "wolf_pack_by_example_bot");
    check("用的是**现拉**的 id，不是存的 OLD_3", calls[1][1].sticker, "LIVE_3");
    check("确实调的 sendSticker", calls[1][0], "sendSticker");

    // a second sticker must not refetch the pack (cached)
    calls.length = 0;
    await plugin.send({ operationId: "o2", chatId: "861", text: "开心", intent: "send_sticker" });
    check("第二张走缓存，没再拉包", calls.filter((c) => c[0] === "getStickerSet").length, 0);
    check("第二张也是现拉的 id", calls[0][1].sticker, "LIVE_1");

    // unknown sticker must fail explicitly, not be sent as text
    let err = "";
    try { await plugin.send({ operationId: "o3", chatId: "861", text: "放烟花", intent: "send_sticker" }); }
    catch (e) { err = e.message; }
    check("没有的贴纸当场拒", /贴纸本里没有/.test(err), true);
  }

  console.log("\n[4] 发图：agent 已经给了文件，就别再拖去生图");
  {
    const plugin = { capabilities: { send_generated_image: "supported" },
      health: () => ({ platform: "supported", plugin: "wired", availability: "ready" }) };
    const caps = { has: () => false };      // 现网可能根本没配生图 key

    // positive control: real generation without the capability must be blocked
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
    // callFile would hit the network; stub it
    plugin.callFile = async (method, field, filePath, params) => {
      sent.push({ method, field, filePath, params }); return { message_id: 9 };
    };
    const r = await plugin.send({ operationId: "o9", chatId: "861", text: "给你看",
      intent: "send_generated_image", toolArgs: { filePath: img } });
    check("走的是 sendPhoto", sent[0].method, "sendPhoto");
    check("发的就是 agent 给的那张", sent[0].filePath, img);
    check("配文跟着走", sent[0].params.caption, "给你看");
    check("报回去是图", r.sentAs, "photo");
  }

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
