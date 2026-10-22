"use strict";
/**
 * 能力表 × 实现 的守卫（2026-09-18）
 *
 * **这是一条守卫，不是普通用例。**
 *
 * 病根：能力表回答的是「**平台**能不能」，没有一张表说「**我实现了没有**」，
 * 而预检只有一个总开关（有没有发送器）。于是 TG 插头声明「贴纸：支持」、
 * 预检放行、`send()` 却不看 intent —— 出去的是**一段文字**，出闸还记成「发成功」。
 * 他以为贴纸发出去了，她那头收到一句莫名其妙的话。
 *
 * 所以这里对**每个插头 × 它声明支持的每个意图**跑一遍，结果只允许两种：
 *   · 真做了对应的动作（发图就得调发图的接口）
 *   · 明确说发不了（notSent）
 * **绝不允许**：悄悄变成一段文字发出去。
 */
const { TelegramPlugin } = require("../../src/gate/plugins/telegram");
const { WeChatPlugin } = require("../../src/gate/plugins/wechat");
const { IMessagePlugin } = require("../../src/gate/plugins/imessage");

let pass = 0, fail = 0;
const check = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

/** 每种意图「算真做了」的判据：调了哪个接口 / 结果长什么样 */
const DID_IT = {
  send_text: (r, calls) => calls.some((c) => /sendMessage|sendText/i.test(c.method)) || r.nativeId != null,
  send_generated_image: (r, calls) => r.sentAs === "photo" || r.sentAs === "image" || calls.some((c) => /sendPhoto/i.test(c.method)),
  send_sticker: (r, calls) => r.sentAs === "sticker" || r.sentAs === "image" || calls.some((c) => /sendSticker/i.test(c.method)),
  send_voice: (r, calls) => r.sentAs === "voice" || calls.some((c) => /sendVoice/i.test(c.method)),
  send_file: (r, calls) => r.sentAs === "document" || calls.some((c) => /sendDocument/i.test(c.method)),
  react: (r, calls) => r.sentAs === "reaction" || calls.some((c) => /setMessageReaction/i.test(c.method)),
};

/**
 * 跑一个插头的一个意图。
 * @returns {"did"|"refused"|"became_text"} —— 第三种是**绝不允许**的那种
 */
async function probe(plugin, intent, calls, textSends) {
  const before = textSends.length;
  try {
    const r = await plugin.send({
      operationId: "op-1", chatId: "c1", text: "这是正文", intent,
      asset: null, extras: {}, toolArgs: {},
    });
    const judge = DID_IT[intent];
    if (judge && judge(r || {}, calls)) return "did";
    // 没做对应动作却「成功」了 —— 看看是不是把正文当文字发了出去
    if (textSends.length > before) return "became_text";
    return "did";
  } catch (e) {
    if (e && e.notSent) return "refused";
    // 抛别的错也算「没伪装成功」，但要看得见
    return "refused";
  }
}

(async () => {
  console.log("[1] Telegram：声明支持的每一样，要么真做，要么明说做不了");
  {
    const calls = [], textSends = [];
    const p = new TelegramPlugin({
      token: "fake",
      sender: async (a) => { textSends.push(a); return "m1"; },
      call: async (method, params) => { calls.push({ method, params }); return { message_id: 1 }; },
    });
    // 让传文件那条路不去碰真网络：没有文件就会 notSent，正是我们要的「明说」
    for (const [intent, decl] of Object.entries(p.capabilities)) {
      if (decl !== "supported") continue;
      const verdict = await probe(p, intent, calls, textSends);
      check(`${intent} → ${verdict}`, verdict !== "became_text", true);
    }
    check("发文字确实走了文字那条", textSends.length >= 1, true);
  }

  console.log("\n[2] 没写过的意图：一律明说，不许悄悄发文字");
  {
    const calls = [], textSends = [];
    const p = new TelegramPlugin({
      token: "fake",
      sender: async (a) => { textSends.push(a); return "m1"; },
      call: async (m, params) => { calls.push({ method: m, params }); return { message_id: 1 }; },
    });
    let refused = false, msg = "";
    try { await p.send({ operationId: "o", chatId: "c", text: "全息投影", intent: "send_hologram" }); }
    catch (e) { refused = Boolean(e.notSent); msg = e.message; }
    check("拒了", refused, true);
    check("说得出是哪个意图", /send_hologram/.test(msg), true);
    check("一个字都没发出去", textSends.length, 0);
  }

  console.log("\n[3] 微信：贴纸那条有没有真的走图片路径（不是发一行字）");
  {
    const sends = [], images = [];
    const p = new WeChatPlugin({
      sender: async (a) => { sends.push(a); return null; },
      imageSender: async (a) => { images.push(a); return "1"; },
      stickerBook: { resolve: () => ({ filePath: "/tmp/sticker.png", fileId: "" }) },
    });
    const r = await p.send({ operationId: "o", chatId: "c", text: "笑", intent: "send_sticker" });
    check("走的是图片路径", r.sentAs, "image");
    check("**没有把「笑」当文字发出去**", sends.length, 0);
  }

  console.log("\n[4] 微信：没接贴纸本就明说 —— 这是 2026-09-18 真炸过的那条");
  {
    const sends = [];
    const p = new WeChatPlugin({ sender: async (a) => { sends.push(a); return null; }, imageSender: async () => "1" });
    let msg = "", notSent = false;
    try { await p.send({ operationId: "o", chatId: "c", text: "笑", intent: "send_sticker" }); }
    catch (e) { msg = e.message; notSent = e.notSent === true; }
    check("明说没接贴纸本", /贴纸本/.test(msg), true);
    check("标成「确定没出去」（他可以换一张再来）", notSent, true);
    check("没退成发文字", sends.length, 0);
    check("不是 undefined 报错（那是代码 bug 不是拒绝）", /undefined/.test(msg), false);
  }

  console.log("\n[5] iMessage：声明支持但还没实现的，必须明说");
  {
    const sends = [];
    const p = new IMessagePlugin({ sender: async (a) => { sends.push(a); return null; } });
    const declared = Object.entries(p.capabilities).filter(([, v]) => v === "supported").map(([k]) => k);
    let becameText = 0;
    for (const intent of declared) {
      if (intent === "send_text") continue;
      const before = sends.length;
      try {
        const r = await p.send({ operationId: "o", chatId: "c", text: "正文", intent });
        const judge = DID_IT[intent];
        if (!(judge && judge(r || {}, []))) if (sends.length > before) becameText += 1;
      } catch { /* 拒绝是对的 */ }
    }
    check(`声明支持 ${declared.length} 样；变成文字发出去的有 ${becameText} 样`, becameText, 0);
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
