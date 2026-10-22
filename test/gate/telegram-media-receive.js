"use strict";

const { TelegramPlugin } = require("../../src/gate/plugins/telegram");

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (ok ? "OK  " : "FAIL ") + name
    + (ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

(async () => {
  console.log("[1] Telegram 媒体描述覆盖 document/video/audio");
  {
    const p = new TelegramPlugin({ token: "test-token" });
    const d = await p.toDelivery({
      message_id: 10,
      chat: { id: 1, type: "private" },
      from: { id: 2 },
      date: 1,
      document: { file_id: "doc-1", file_name: "notes.pdf" },
      video: { file_id: "vid-1", file_name: "clip.mp4" },
      audio: { file_id: "aud-1", file_name: "song.mp3" },
    });
    check("kind/ref/name", d.media.map((m) => [m.kind, m.ref, m.hintName]), [
      ["file", "doc-1", "notes.pdf"],
      ["video", "vid-1", "clip.mp4"],
      ["audio", "aud-1", "song.mp3"],
    ]);
  }

  console.log("[1b] 圆视频 video_note 和 GIF animation 也要收上来（漏了会静默丢媒体）");
  {
    const p = new TelegramPlugin({ token: "test-token" });
    const d = await p.toDelivery({
      message_id: 11,
      chat: { id: 1, type: "private" },
      from: { id: 2 },
      date: 1,
      video_note: { file_id: "vnote-1" },
    });
    check("video_note → video", d.media.map((m) => [m.kind, m.ref, m.hintName]),
      [["video", "vnote-1", "video-note.mp4"]]);

    const g = await p.toDelivery({
      message_id: 12,
      chat: { id: 1, type: "private" },
      from: { id: 2 },
      date: 1,
      animation: { file_id: "gif-1", file_name: "funny.mp4" },
    });
    check("animation → video", g.media.map((m) => [m.kind, m.ref, m.hintName]),
      [["video", "gif-1", "funny.mp4"]]);

    const noName = await p.toDelivery({
      message_id: 13,
      chat: { id: 1, type: "private" },
      from: { id: 2 },
      date: 1,
      animation: { file_id: "gif-2" },
    });
    check("animation 没文件名时有兜底", noName.media.map((m) => m.hintName), ["animation.mp4"]);
  }

  console.log("[1c] 在线判据 = 能不能发出去，不是「有没有塞替身」");
  {
    // 2026-09-18 玩具实例实测抓到的真洞：生产装配按设计只给 token（不给 sender），
    // health 却只认 sender → 一律 offline → 出闸 precheck 当场 blocked。
    // 盒子跑完了、冷层也写了，她那头什么都没收到。测试里人人塞 sender，所以一路全绿。
    check("只给 token（生产就是这么装的）→ ready",
      new TelegramPlugin({ token: "test-token" }).health().availability, "ready");
    check("只给 sender（测试替身）→ ready",
      new TelegramPlugin({ sender: async () => "m1" }).health().availability, "ready");
    check("两样都没有 → offline",
      new TelegramPlugin({}).health().availability, "offline");
  }

  console.log("\n[2] getFile + 官方文件下载可离线注入，并带大小/超时边界");
  {
    const calls = [];
    let asked = null;
    const p = new TelegramPlugin({
      token: "test-token",
      call: async (method, params) => {
        calls.push({ method, params });
        return { file_path: "photos/picture.jpg" };
      },
      mediaTimeoutMs: 100,
      mediaMaxBytes: 16,
      fetchBytes: async (url, options) => {
        asked = { url, options };
        return { bytes: Buffer.from("image-bytes") };
      },
    });
    const r = await p.fetchMedia({ kind: "image", ref: "photo-1" });
    check("getFile 参数", calls, [{ method: "getFile", params: { file_id: "photo-1" } }]);
    check("下载到了字节", r.bytes.toString(), "image-bytes");
    check("官方 URL 由 token + file_path 拼出", asked.url,
      "https://api.telegram.org/file/bottest-token/photos/picture.jpg");
    check("注入器拿到边界", [asked.options.timeoutMs, asked.options.maxBytes], [100, 16]);

    const tooLarge = new TelegramPlugin({
      token: "test-token", mediaMaxBytes: 4,
      call: async () => ({ file_path: "big.bin" }),
      fetchBytes: async () => Buffer.alloc(5),
    });
    check("超大文件拒收", (await tooLarge.fetchMedia({ kind: "file", ref: "big" })).failed, "media_too_large");

    const timed = new TelegramPlugin({
      token: "test-token", mediaTimeoutMs: 5,
      call: async () => ({ file_path: "slow.bin" }),
      fetchBytes: async () => new Promise((resolve) => setTimeout(() => resolve(Buffer.from("late")), 30)),
    });
    check("下载超时有稳定标记", (await timed.fetchMedia({ kind: "file", ref: "slow" })).failed, "download_timeout");
  }

  console.log("\n[3] 失败信息不泄漏 token 或下载 URL");
  {
    const secret = "123456:secret-token";
    const p = new TelegramPlugin({
      token: secret,
      call: async () => { throw new Error("request https://api.telegram.org/bot" + secret); },
    });
    const r = await p.fetchMedia({ kind: "image", ref: "gone" });
    check("失败代码稳定", r.failed, "file_lookup_failed");
    check("没有把 token 带进错误", JSON.stringify(r).includes(secret), false);
    check("没有把 URL 带进错误", JSON.stringify(r).includes("https://"), false);
  }

  console.log("\n[4] 旧宿主注入 transcribe 仍兼容且只标一次");
  {
    let count = 0;
    const p = new TelegramPlugin({
      transcribe: async () => { count += 1; return "旧转写"; },
      token: "test-token",
    });
    const d = await p.toDelivery({
      message_id: 11, chat: { id: 1, type: "private" }, from: { id: 2 }, date: 1,
      voice: { file_id: "voice-1" },
    });
    check("旧转写仍可用", [d.text, d.media[0].text, d.processing, count],
      ["旧转写", "旧转写", ["transcribed"], 1]);
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
