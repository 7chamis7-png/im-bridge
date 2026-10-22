"use strict";
/**
 * 投递口（2026-09-18）—— 桥对外唯一的那个口
 *
 * 三条守卫：
 *   · 这个口上**没有「发给谁」这个参数**（铁律 2 / §0.2）
 *   · 桥不认识调用者叫什么（工具名改了、删了，桥一行不用动）
 *   · 给不了的专属参数**必须明说并留痕**，不许悄悄丢
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { makeOutlet } = require("../../src/gate/outlet");
const { GateStore } = require("../../src/gate/store");
const { ColdWriter } = require("../../src/gate/cold-writer");
const { OutboundGate } = require("../../src/gate/outbound");
const { makeRouter } = require("../../src/gate/routing");
const { makeEnvelope } = require("../../src/gate/envelope");

let pass = 0, fail = 0;
const check = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-outlet-"));
const HER = "1000000001";

function build(dir, channel = "telegram") {
  const store = new GateStore({ root: path.join(root, dir) });
  const cold = new ColdWriter({ file: path.join(root, dir, "cold.jsonl") });
  const got = [];
  const plugin = {
    channel,
    capabilities: { send_text: "supported", send_sticker: "supported", send_generated_image: "supported", send_voice: "supported", send_file: "supported", react: "supported" },
    health: () => ({ platform: "supported", plugin: "wired", availability: "ready" }),
    send: async (a) => { got.push(a); return { nativeId: "n1" }; },
  };
  const plugins = new Map([[channel, plugin]]);
  const outbound = new OutboundGate({ store, cold, plugins });
  const inbound = makeEnvelope({
    trace_id: "tr-in", source: { kind: "user", platform: channel, chat_id: HER, sender_id: HER },
    payload: { text: "在吗" }, identity: "alice",
  });
  const router = makeRouter({ preferred: { platform: channel, chat_id: HER } });
  router.noteInbound(inbound);
  const outlet = makeOutlet({
    outbound, router, plugins,
    currentTurn: () => ({ turnId: "t1", inbound }),
  });
  return { outlet, got, coldFile: path.join(root, dir, "cold.jsonl"), storeRoot: path.join(root, dir) };
}

(async () => {
  console.log("[1] 口子上根本没有「发给谁」这个参数");
  {
    const { outlet, got } = build("a");
    const r = await outlet.deliver({ intent: "send_text", text: "七点二十" });
    check("发出去了", r.outcome, "sent");
    check("落点是路由定的", got[0].chatId, HER);
    check("走的是原路那一档", r.policy, "reply_route");
  }

  console.log("\n[2] 调用方硬塞落点 —— 丢掉，但留一笔「他试过」");
  {
    const { outlet, got } = build("b");
    const r = await outlet.deliver({
      intent: "send_text", text: "发去别处",
      args: { chat_id: "别人", channel: "wechat", to: "谁谁谁" },
      by: "tool",
    });
    check("还是发回她那儿", got[0].chatId, HER);
    check("不是发去「别人」", got[0].chatId === "别人", false);
    check("留了一笔他试过指定渠道", r.notes.some((n) => n.type === "routing_arg_ignored"), true);
  }

  console.log("\n[3] 桥不认识调用者叫什么名字");
  {
    const { outlet } = build("c");
    const a = await outlet.deliver({ intent: "send_text", text: "一", by: "nova_telegram_reply" });
    const b = await outlet.deliver({ intent: "send_text", text: "二", by: "随便什么还没起名的工具" });
    check("旧名字能发", a.outcome, "sent");
    check("没听说过的名字一样能发", b.outcome, "sent");
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "src", "gate", "outlet.js"), "utf8");
    check("投递口代码里没有任何工具名", /cyberboss_/.test(src), false);
  }

  console.log("\n[4] 给不了的专属参数：正文照发，但必须明说 + 留痕");
  {
    const { outlet, got, coldFile, storeRoot } = build("d", "wechat");   // 微信给不了 TG 的按钮
    const r = await outlet.deliver({
      intent: "send_text", text: "今晚吃啥",
      args: { inline_keyboard: [{ text: "火锅", callback_data: "h" }] },
    });
    check("正文照样发出去", r.outcome, "sent");
    check("按钮没混进微信的发送参数", Object.keys(got[0].extras || {}), []);
    check("**明说按钮没出去**", r.unsupportedExtras.map((n) => n.name), ["inline_keyboard"]);
    check("说得出哪条腿才有", r.unsupportedExtras[0].honoredBy.includes("telegram"), true);
    const last = fs.readFileSync(coldFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).pop();
    // 2026-09-18：留痕在**日志**，不在冷层正文 —— 冷层只存他真说的那句（SPEC §6）。
    check("冷层正文干净", last.text, "今晚吃啥");
    const log = fs.readFileSync(path.join(storeRoot, "events.jsonl"), "utf8")
      .trim().split("\n").map((l) => JSON.parse(l));
    const hit = log.find((e) => (e.notes || []).some((n) => n.type === "extra_unsupported"));
    check("日志记下了这件事（换舱后还查得到）", Boolean(hit), true);
    check("日志指得回冷层那一条", hit && hit.coldId, last.id);
    check("说成人话给调用方", /给不了/.test(outlet.describe(r)), true);
  }

  console.log("\n[5] 同一个调用换到认得它的腿上 —— 参数就真交给插头了");
  {
    const { outlet, got } = build("e", "telegram");
    const r = await outlet.deliver({
      intent: "send_text", text: "今晚吃啥",
      args: { inline_keyboard: [{ text: "火锅", callback_data: "h" }] },
    });
    check("交到插头手里了", Object.keys(got[0].extras), ["inline_keyboard"]);
    check("没有「给不了」的报告", r.unsupportedExtras.length, 0);
  }

  console.log("\n[6] 没有落点时：告诉调用方没发出去，不许让他以为发了");
  {
    const store = new GateStore({ root: path.join(root, "f") });
    const cold = new ColdWriter({ file: path.join(root, "f", "cold.jsonl") });
    const plugins = new Map();
    const outlet = makeOutlet({
      outbound: new OutboundGate({ store, cold, plugins }),
      router: makeRouter(),                    // 没入站、没首选
      plugins,
      currentTurn: () => ({ turnId: "t9", inbound: null }),
    });
    const r = await outlet.deliver({ intent: "send_text", text: "有人吗" });
    check("明确 blocked", r.outcome, "blocked");
    check("说得出原因", /没有过任何入站/.test(r.reason), true);
    check("人话里说的是「没发出去」", /没发出去/.test(outlet.describe(r)), true);
  }

  console.log("\n[7] 没有正文 ≠ 他选择不说 —— 贴纸/图/语音本来就没有正文");
  {
    // 2026-09-18 她问「但他要选发哪个贴纸呀」问出来的洞：
    // 出闸第一行把空正文一律判成沉默，贴纸根本走不到插头，
    // 冷层还记了一条「本轮未回复」——他以为发了，她那头什么也没有。
    for (const intent of ["send_sticker", "send_generated_image", "send_voice", "send_file", "react"]) {
      const { outlet, got } = build("g-" + intent, "telegram");
      // 让插头认这个意图
      const r = await outlet.deliver({ intent, text: "", args: { sticker: "笑哭", filePath: "/tmp/x", message_id: 9 } });
      const reached = got.length > 0;
      check(`${intent}：空正文没被当成沉默`, r.outcome !== "silent", true);
      check(`${intent}：真走到插头了（或明确说不了）`, reached || r.outcome === "blocked", true);
    }
    // 但发文字没正文，仍然是沉默 —— 这条不能改坏
    const { outlet: o2 } = build("g-text", "telegram");
    const rt = await o2.deliver({ intent: "send_text", text: "   " });
    check("发文字没正文 → 还是沉默（§0.3 不许动）", rt.outcome, "silent");
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}   (隔离目录 ${root})`);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
