"use strict";
/**
 * Media pipeline: plugins only hand in bytes, the shared layer does the rest.
 * Most important: images are passed as originals for the model to look at;
 * captioning is only a fallback for runtimes that cannot take images.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MediaPipeline, PLAN } = require("../../src/gate/media-pipeline");
const { FileStore } = require("../../src/gate/file-store");
const { Capabilities } = require("../../src/gate/capabilities");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-mp-"));
let pass = 0, fail = 0;
const check = (n, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(g)} want=${JSON.stringify(w)}`));
  ok ? pass++ : fail++;
};

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64)]);
const AMR = Buffer.concat([Buffer.from([0x02, 0x23, 0x21, 0x41]), Buffer.alloc(64)]);

function mk({ native = true, withVision = true, withTranscribe = true } = {}) {
  const caps = new Capabilities();
  if (withVision) caps.register("vision", async () => ({ text: "一只狼在笑" }));
  if (withTranscribe) caps.register("transcribe", async () => ({ text: "你吃饭了没" }));
  const store = new FileStore({ root: fs.mkdtempSync(path.join(root, "s-")) });
  return new MediaPipeline({ caps, fileStore: store, nativeImageInput: native });
}

(async () => {
  console.log("\n[1] 图片：模型自己会看 —— 递原图，不调识图、不花钱");
  const a = await mk().ingest({ kind: "image", bytes: PNG, channel: "wechat" });
  check("processed=native", a.processed, "native");
  check("给了要递上去的附件", Array.isArray(a.attach) && a.attach.length === 1, true);
  check("正文只是个标记，不是转述", a.text, "[图片]");
  check("文件真落仓了", fs.existsSync(a.filePath), true);

  console.log("\n[2] 运行时吃不下图 —— 这才退成识图");
  const b = await mk({ native: false }).ingest({ kind: "image", bytes: PNG, channel: "wechat" });
  check("processed=caption", b.processed, "caption");
  check("出的是文字说明", b.text, "[图片] 一只狼在笑");
  check("没有附件可递", b.attach, undefined);

  console.log("\n[3] 吃不下图、识图又没接 —— 说清楚，不返回空");
  const c = await mk({ native: false, withVision: false }).ingest({ kind: "image", bytes: PNG, channel: "tg" });
  check("明说看不了", /看不了图/.test(c.text), true);
  check("标出缺哪一样", c.failed, "capability_missing");
  check("文件照样存着（以后补看得回来）", fs.existsSync(c.filePath), true);

  console.log("\n[4] 语音：音频模型吃不下，转写是唯一的路");
  const d = await mk().ingest({ kind: "voice", bytes: AMR, channel: "wechat" });
  check("processed=transcribe", d.processed, "transcribe");
  check("正文带稿", d.text, "[语音] 你吃饭了没");
  check("嗅出 amr（微信语音）", d.mime, "audio/amr");

  console.log("\n[5] 转写没接 / 转不出字 —— 都不能装作没这条语音");
  const e = await mk({ withTranscribe: false }).ingest({ kind: "voice", bytes: AMR, channel: "wechat" });
  check("明说转写没接上", /转写没接上/.test(e.text), true);
  const caps2 = new Capabilities();
  caps2.register("transcribe", async () => ({ text: "   " }));
  const f = await new MediaPipeline({ caps: caps2, fileStore: new FileStore({ root: fs.mkdtempSync(path.join(root, "s2-")) }) })
    .ingest({ kind: "voice", bytes: AMR, channel: "wechat" });
  check("转不出字也要说一声", /没转出字/.test(f.text), true);
  check("标成 empty 不是成功", f.failed, "empty");

  console.log("\n[5b] 声学层：语音转写后拼上「怎么说的」，是增量、绝不拖累转写");
  {
    const caps3 = new Capabilities();
    caps3.register("transcribe", async () => ({ text: "你吃饭了没" }));
    caps3.register("acoustic", async () => ({ text: "[声学 2s/1段] 段1 320Hz↑ 呻吟感0.8 气声0.6·撒娇" }));
    const store3 = new FileStore({ root: fs.mkdtempSync(path.join(root, "s3-")) });
    const g5 = await new MediaPipeline({ caps: caps3, fileStore: store3 }).ingest({ kind: "voice", bytes: AMR, channel: "wechat" });
    check("说了什么在第一行", g5.text.split("\n")[0], "[语音] 你吃饭了没");
    check("怎么说的拼在第二行", /呻吟感0\.8/.test(g5.text.split("\n")[1] || ""), true);
    check("声学结果也单独留字段", /呻吟感/.test(g5.acoustic || ""), true);
    // acoustic failure: transcript unaffected, no acoustic line
    const caps4 = new Capabilities();
    caps4.register("transcribe", async () => ({ text: "你吃饭了没" }));
    caps4.register("acoustic", async () => { throw new Error("analyzer 挂了"); });
    const store4 = new FileStore({ root: fs.mkdtempSync(path.join(root, "s4-")) });
    const g6 = await new MediaPipeline({ caps: caps4, fileStore: store4 }).ingest({ kind: "voice", bytes: AMR, channel: "wechat" });
    check("声学挂了转写照常成功", g6.processed, "transcribe");
    check("声学挂了正文只剩转写", g6.text, "[语音] 你吃饭了没");
    check("声学挂了 acoustic 字段为空", g6.acoustic, "");
  }

  console.log("\n[6] 文件：不加工，但描述里得有名字和大小");
  const g = await mk().ingest({ kind: "file", bytes: Buffer.alloc(85196, 1), channel: "wechat", hintName: "读后感.txt" });
  check("processed=none", g.processed, "none");
  check("带文件名和大小", /读后感\.txt 83KB/.test(g.text), true);

  console.log("\n[7] 连字节都没拿到 —— 这是上游断了，必须说出来");
  const h = await mk().ingest({ kind: "image", srcPath: "/nope/not-here.png", channel: "wechat" });
  check("标成 store 失败", h.failed, "store");
  check("正文说清没拿到", /文件没拿到/.test(h.text), true);
  check("正文永远不是空串", h.text.length > 0, true);

  console.log("\n[8] 认不出的类型当附件，不猜");
  const i = await mk().ingest({ kind: "红包", bytes: Buffer.alloc(100, 7), channel: "wechat" });
  check("不炸", i.failed, "");
  check("描述里带原类型名", /红包/.test(i.text), true);

  console.log("\n[9] 计划表：插头只说这是什么，怎么加工不归它管");
  check("图片和表情同一条路", [PLAN.image, PLAN.sticker], ["look", "look"]);
  check("语音走转写", PLAN.voice, "transcribe");
  check("视频先抽帧", PLAN.video, "frames");
  check("链接/引用不加工（appmsg 已经解析过了）", [PLAN.link, PLAN.quote], ["none", "none"]);

  console.log("\n[10] 插头只给 URL：下载归共用层，带 md5/大小校验");
  {
    const { Capabilities } = require("../../src/gate/capabilities");
    const caps = new Capabilities();
    let asked = null;
    caps.register("fetch_bytes", async (a) => {
      asked = a;
      if (a.expectMd5 && a.expectMd5 !== "good") throw new Error("md5 对不上：拿到 x，消息里说是 " + a.expectMd5);
      return { bytes: PNG, size: PNG.length };
    });
    const mp = new MediaPipeline({ caps, fileStore: new FileStore({ root: fs.mkdtempSync(path.join(root, "u-")) }) });

    const ok = await mp.ingest({ kind: "sticker", url: "http://x/y.jpg", expectMd5: "good", expectBytes: 68, channel: "wechat" });
    check("下下来就当普通媒体走", ok.processed, "native");
    check("校验信息原样递给共用层", [asked.expectMd5, asked.expectBytes], ["good", 68]);
    check("文件真落仓", fs.existsSync(ok.filePath), true);

    const bad = await mp.ingest({ kind: "sticker", url: "http://x/y.jpg", expectMd5: "bad", channel: "wechat" });
    check("md5 对不上就拒收", bad.failed, "fetch");
    check("说清楚是下载失败，不是 owner 没发", /下载失败/.test(bad.text), true);
    check("坏的不落仓", bad.filePath, "");

    const noCap = new MediaPipeline({ caps: new Capabilities(), fileStore: new FileStore({ root: fs.mkdtempSync(path.join(root, "n-")) }) });
    const nc = await noCap.ingest({ kind: "sticker", url: "http://x/y.jpg", channel: "wechat" });
    check("下载能力没注册也说人话", nc.failed, "capability_missing");
  }

  console.log("\n[11] 微信动画表情：XML 里就有明文直链");
  {
    const { parseEmoji } = require("../../src/gate/plugins/wechat");
    const XML = `<msg><emoji md5="2a952eea0187d5c29d5637dd5355b261" len="59556" `
      + `cdnurl="http://vweixinf.tc.qq.com/110/20401/stodownload?m=2a95&amp;ef=1" `
      + `encrypturl="http://vweixinf.tc.qq.com/110/20402/stodownload?m=fe62&amp;ef=2" `
      + `aeskey="77ecc91864e2433cb1aca0ede7862e2b" /></msg>`;
    const e = parseEmoji(XML);
    check("取的是明文那份 cdnurl(ef=1)，不是 encrypturl", /ef=1/.test(e.url), true);
    check("&amp; 解回 &（不然链接是坏的）", e.url.includes("&ef=1"), true);
    check("带上 md5 当校验", e.md5, "2a952eea0187d5c29d5637dd5355b261");
    check("带上 len 当校验", e.len, 59556);
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}   (隔离目录 ${root})`);
  process.exit(fail ? 1 : 0);
})();
