"use strict";
/**
 * 入站唯一入口：toDelivery（定位） → hydrate（取字节+加工） → 入闸。
 *
 * This file doesn't test decoding (see wechat-media.js); it checks that both ends are really
 * connected, and what the gate and the cold layer each receive once they are.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MediaPipeline } = require("../../src/gate/media-pipeline");
const { FileStore } = require("../../src/gate/file-store");
const { Capabilities } = require("../../src/gate/capabilities");
const { GateStore } = require("../../src/gate/store");
const { ColdWriter } = require("../../src/gate/cold-writer");
const { InboundGate } = require("../../src/gate/inbound");
const { makeIntake } = require("../../src/gate/wire");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-intake-"));
let pass = 0, fail = 0;
const check = (n, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(g)} want=${JSON.stringify(w)}`));
  ok ? pass++ : fail++;
};

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64)]);
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(64)]);

/**
 * A fake plugin shaped like the real WeChat plugin: toDelivery only carries locators, bytes
 * come from fetchMedia (toDelivery stays light, synchronous, no large reads).
 */
function fakePlugin({ fetch, channel = "wechat" } = {}) {
  return {
    channel,
    toDelivery(raw) {
      return {
        channel, accountId: "acct", senderId: "owner", chatId: "owner", chatType: "private",
        nativeId: raw.id, receivedAt: new Date(1758000000 * 1000).toISOString(),
        text: raw.text || "", media: raw.media || [], processing: ["decrypted"],
      };
    },
    ...(fetch ? { fetchMedia: fetch } : {}),
  };
}

function mk({ native = true, transcribe = null, fetchBytes = null } = {}) {
  const caps = new Capabilities();
  if (transcribe) caps.register("transcribe", transcribe);
  if (fetchBytes) caps.register("fetch_bytes", fetchBytes);
  const dir = fs.mkdtempSync(path.join(root, "g-"));
  const store = new GateStore({ root: dir });
  const cold = new ColdWriter({ file: path.join(dir, "cold.jsonl") });
  const inbound = new InboundGate({ store, cold, identities: { "wechat:owner": "owner", "telegram:owner": "owner" } });
  const media = new MediaPipeline({
    caps, fileStore: new FileStore({ root: path.join(dir, "files") }), nativeImageInput: native,
  });
  return { inbound, media, cold, coldFile: path.join(dir, "cold.jsonl") };
}

const coldLines = (f) => fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);

(async () => {
  console.log("\n[1] 微信图片：定位 → fetchMedia 取字节 → 递原图给 agent 自己看");
  {
    const g = mk();
    let asked = null;
    const plugin = fakePlugin({
      fetch: async (item, ctx) => { asked = { item, ctx }; return { bytes: PNG, mime: "image/png", hintName: "a.png" }; },
    });
    const intake = makeIntake({ inbound: g.inbound, media: g.media, pluginFor: () => plugin });
    const r = await intake({ channel: "wechat", raw: { id: "w1", media: [{ kind: "image", md5: "abc", table: "Msg_x" }] } });

    check("闸收下了", r.accepted, true);
    check("fetchMedia 真被调了（这就是以前断掉的那一针）", asked !== null, true);
    check("插头拿到了定位信息", asked.item.md5, "abc");
    check("共用层把「这条是什么时候的」给了插头", asked.ctx.createTime, 1758000000);
    check("加工到 native（原图递给 agent，不花钱识图）", r.event.media[0].processed, "native");
    check("落仓了，路径可查", fs.existsSync(r.event.media[0].filePath), true);
    check("要递上去的原图在 attach 里", r.event.media[0].attach.length, 1);
    check("投给 agent 的不再是光秃秃的标签", r.injected.includes("[图片]"), true);
    check("冷层仍然只存 [图片]（§0.4：存路径会把旧图带回上下文）",
      coldLines(g.coldFile)[0].text, "[图片]");
  }

  console.log("\n[2] 微信语音：SILK→WAV→转写，字得进冷层（否则一换舱就把 owner 的话忘干净）");
  {
    const g = mk({ transcribe: async () => ({ text: "我到家了" }) });
    const plugin = fakePlugin({ fetch: async () => ({ bytes: WAV, mime: "audio/wav", hintName: "v.wav" }) });
    const intake = makeIntake({ inbound: g.inbound, media: g.media, pluginFor: () => plugin });
    const r = await intake({ channel: "wechat", raw: { id: "w2", media: [{ kind: "voice", serverId: "42" }] } });

    check("转写跑了", r.event.media[0].processed, "transcribe");
    check("投给 agent 的是 owner 说的话", r.injected.includes("我到家了"), true);
    check("冷层存的也是那句话，不是 [voice]", coldLines(g.coldFile)[0].text, "[语音] 我到家了");
  }

  console.log("\n[3] 取不到就明说 —— 空白比明说危险");
  {
    const g = mk();
    const plugin = fakePlugin({ fetch: async () => ({ bytes: null, failed: "image_not_downloaded" }) });
    const intake = makeIntake({ inbound: g.inbound, media: g.media, pluginFor: () => plugin });
    const r = await intake({ channel: "wechat", raw: { id: "w3", media: [{ kind: "image", md5: "zzz" }] } });

    check("失败记在媒体项上", r.event.media[0].failed, "image_not_downloaded");
    check("投给 agent 的说清楚了取不到", r.injected.includes("取不到 —— image_not_downloaded"), true);
    check("没假装成一张正常的图", r.event.media[0].processed, undefined);
  }

  console.log("\n[4] fetchMedia 抛异常也不许吞 —— 一件媒体失败不能拖垮一轮");
  {
    const g = mk();
    const plugin = fakePlugin({ fetch: async () => { throw new Error("sqlcipher 没了"); } });
    const intake = makeIntake({ inbound: g.inbound, media: g.media, pluginFor: () => plugin });
    const r = await intake({ channel: "wechat", raw: { id: "w4", media: [{ kind: "image", md5: "q" }] } });
    check("整轮没炸", r.accepted, true);
    check("原因带出来了", r.event.media[0].failed, "fetch_threw");
    check("细节也带出来了", r.injected.includes("sqlcipher 没了"), true);
  }

  console.log("\n[5] unsupported_kind 不是失败 —— 插头不管这类，还有别的路子");
  {
    const g = mk({ fetchBytes: async () => ({ bytes: PNG }) });
    // the real WeChat plugin returns unsupported_kind for stickers; stickers have a plain URL, downloaded by the shared layer
    const plugin = fakePlugin({ fetch: async () => ({ bytes: null, failed: "unsupported_kind" }) });
    const intake = makeIntake({ inbound: g.inbound, media: g.media, pluginFor: () => plugin });
    const r = await intake({ channel: "wechat", raw: { id: "w5",
      media: [{ kind: "sticker", url: "https://x/y.jpg", expectMd5: "", expectBytes: 0 }] } });

    check("没被当成失败", r.event.media[0].failed, undefined);
    check("退到直链下载这条路，走通了", r.event.media[0].processed, "native");
  }

  console.log("\n[6] 微信文件：明文落盘，路径已经在正文里 —— 别复制进仓、别把路径弄丢");
  {
    const g = mk();
    const real = path.join(root, "读后感.txt");
    fs.writeFileSync(real, "owner 写的东西");
    const plugin = fakePlugin({ fetch: async () => ({ bytes: null, failed: "unsupported_kind" }) });
    const intake = makeIntake({ inbound: g.inbound, media: g.media, pluginFor: () => plugin });
    const r = await intake({ channel: "wechat", raw: { id: "w6",
      text: "[文件] 读后感.txt\n" + real, media: [{ kind: "file", localPath: real }] } });

    check("没被搬进文件仓（多一份不多一点信息）", r.event.media[0].processed, undefined);
    check("路径还在正文里，agent 照样读得到", r.injected.includes(real), true);
  }

  console.log("\n[7] 插头没有 fetchMedia（TG/iMessage 现在就是）—— 不炸，文本照走");
  {
    const g = mk();
    const plugin = fakePlugin({ channel: "telegram" });
    const intake = makeIntake({ inbound: g.inbound, media: g.media, pluginFor: () => plugin });
    const r = await intake({ channel: "telegram", raw: { id: "t1", text: "在吗" } });
    check("普通文本一切照旧", r.injected.includes("在吗"), true);

    const r2 = await intake({ channel: "telegram", raw: { id: "t2", media: [{ kind: "image", ref: "file_id_123" }] },
      extraMedia: [] });
    check("只有 file_id 取不到字节时不编，退回标签", r2.injected.includes("[图片]"), true);
  }

  console.log("\n[8] extraMedia：采集器额外知道的附件并进来一起加工");
  {
    const g = mk();
    const real = path.join(root, "owner 拍的.png");
    fs.writeFileSync(real, PNG);
    const plugin = fakePlugin({ channel: "telegram" });
    const intake = makeIntake({ inbound: g.inbound, media: g.media, pluginFor: () => plugin });
    const r = await intake({ channel: "telegram", raw: { id: "t3", text: "" },
      extraMedia: [{ kind: "image", localPath: real }] });
    check("采集器给的附件也过了流水线", r.event.media[0].processed, "native");
  }

  console.log("\n[9] 没有媒体流水线（给不了就退成只走文本，不炸）");
  {
    const g = mk();
    const intake = makeIntake({ inbound: g.inbound, media: null, pluginFor: () => fakePlugin({}) });
    const r = await intake({ channel: "wechat", raw: { id: "w9", media: [{ kind: "image", md5: "m" }] } });
    check("照样进闸", r.accepted, true);
    check("退回标签，不是空白", r.injected.includes("[图片]"), true);
  }

  console.log("\n[10] 认不出的渠道直接报错，不静默丢");
  {
    const g = mk();
    const intake = makeIntake({ inbound: g.inbound, media: g.media, pluginFor: () => null });
    let msg = "";
    try { await intake({ channel: "qq", raw: { id: "x" } }); } catch (e) { msg = e.message; }
    check("点名是哪个渠道", msg.includes("qq"), true);
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}   (隔离目录 ${root})`);
  process.exit(fail ? 1 : 0);
})();
