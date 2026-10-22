"use strict";

const { normalizeModelInput } = require("../../src/gate/model-input");

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (ok ? "OK  " : "FAIL ") + name
    + (ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

const env = (payload, extra = {}) => ({
  trace_id: "trace-model-input",
  verdict: "accepted",
  payload,
  ...extra,
});

console.log("[1] 只有转写媒体：渲染文字进入 runtime，原始音频不作为附件");
check("voice text", normalizeModelInput(env({
  text: "",
  media: [{ kind: "voice", text: "[语音] 你吃饭了没", filePath: "/tmp/raw.amr" }],
})), { text: "[语音] 你吃饭了没", attachments: [] });

console.log("\n[2] 图片：保留媒体标记，优先显式 attach");
check("image attachment", normalizeModelInput(env({
  text: "",
  media: [{ kind: "image", text: "[图片]", filePath: "/tmp/original.png", attach: ["/tmp/original.png"] }],
})), { text: "[图片]", attachments: ["/tmp/original.png"] });

console.log("\n[3] 正文和媒体都不能丢，重复路径只递一次");
check("text plus media", normalizeModelInput(env({
  text: "看看这个",
  media: [
    { kind: "image", text: "[图片]", path: "/tmp/a.png" },
    { kind: "image", text: "[图片]", localPath: "/tmp/a.png" },
  ],
})), { text: "看看这个\n[图片]\n[图片]", attachments: ["/tmp/a.png"] });

console.log("\n[4] 视频：显式 frame attach 胜过原视频路径");
check("video frame", normalizeModelInput(env({
  text: "",
  media: [{ kind: "video", text: "[视频]", processed: "native",
    filePath: "/tmp/video.mp4", attach: ["/tmp/video.frame.png"] }],
})), { text: "[视频]", attachments: ["/tmp/video.frame.png"] });

check("raw audio attach is rejected", normalizeModelInput(env({
  text: "",
  media: [{ kind: "audio", text: "[语音] 听到了", attach: ["/tmp/raw.mp3"] }],
})), { text: "[语音] 听到了", attachments: [] });
check("raw video path is rejected", normalizeModelInput(env({
  text: "",
  media: [{ kind: "video", text: "[视频]", filePath: "/tmp/raw.mp4" }],
})), { text: "[视频]", attachments: [] });

console.log("\n[5] 坏媒体与验收失败：安全占位，不泄漏原始正文");
check("malformed media", normalizeModelInput(env({ text: "", media: [null, {}] })), {
  text: "[媒体：无法读取]\n[媒体]", attachments: [],
});
check("undecoded placeholder", normalizeModelInput(env({
  text: "\u0000\u0001raw undecoded bytes",
  media: [{ kind: "image", text: "raw undecoded media", filePath: "/tmp/raw" }],
}, { verdict: "undecoded" })), {
  text: "[未解码内容：插件交付的正文无法读取，原件已留在事件账本 trace-model-input]",
  attachments: [],
});
check("no_content placeholder", normalizeModelInput(env({
  text: "should not reach model", media: [{ kind: "voice", text: "secret" }],
}, { verdict: "no_content" })), {
  text: "[空事件：既无正文也无媒体，多半是上游取值出错。不要当成她说了什么，更不要猜她想说什么。账本 trace-model-input]",
  attachments: [],
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
