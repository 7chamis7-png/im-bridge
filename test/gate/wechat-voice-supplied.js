"use strict";
// 2026-09-20：他自己递音频（唱歌）→ 微信也要当语音条发。
// 出闸看到调用方给了文件就跳过合成，asset 是空的；原来这条只认 asset，递进来的文件被无视。
const assert = require("assert");
const { WeChatPlugin } = require("../../src/gate/plugins/wechat");

(async () => {
  const played = [];
  const wx = new WeChatPlugin({ sender: async () => "x", voiceSender: async (o) => { played.push(o.filePath); } });

  await wx.send({ operationId: "a", chatId: "c", text: "歌词", intent: "send_voice", asset: null, toolArgs: { filePath: "/tmp/song.mp3" } });
  assert.deepStrictEqual(played, ["/tmp/song.mp3"], "递进来的音频要被发出去");

  await wx.send({ operationId: "b", chatId: "c", text: "合成的", intent: "send_voice", asset: { filePath: "/tmp/tts.mp3" }, toolArgs: { filePath: "/tmp/other.mp3" } });
  assert.strictEqual(played[1], "/tmp/tts.mp3", "有合成结果时照旧用合成的");

  await assert.rejects(wx.send({ operationId: "c", chatId: "c", text: "空", intent: "send_voice", asset: null, toolArgs: {} }),
    /没拿到合成好的音频/, "两样都没有就明说没发，不发成文字");

  console.log("wechat-voice-supplied: 3/3 通过");
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
