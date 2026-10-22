"use strict";

/**
 * ⚠️ 2026-09-18 从 `src/gate/` 搬出来的。**它不属于桥。**
 * 桥只说「我要一个能把音频变成字的东西」，谁提供不管（docs/SPEC.md 铁律 1）。
 * 这个文件干的事是「在这台机器上，用现网那几个服务凑齐桥要的能力」——
 * 那是**用桥的人**的活。桥拷到别的机器，这个文件不跟着走，换一份新的就行。
 */

/**
 * 第 1 层：把现网四样现成实现注册成**共用能力**（2026-09-17 Alice「那我们现在改」）
 *
 * 在此之前它们是**每条渠道各自调一遍**的：转写和识图只有 TG / iMessage 接了，
 * 微信那条一直缺 —— 不是微信特殊，是没有第 1 层，谁接谁有，没人给微信接。
 * 注册进来之后就是**新插头自动就有**，接 QQ、接前端都不用再碰这四样。
 *
 * 这里只做一件事：**把各自不同的调用形状收成统一形状**。实现一行不改、一行不搬。
 *
 *   transcribe({ filePath })        -> { text }
 *   vision({ filePaths })           -> { text, items, errors }
 *   synthesize_voice({ text })      -> { filePath, mimeType, bytes }
 *   generate_image({ prompt })      -> { files: [{ filePath }] }
 *   file_store                      -> FileStore 实例（put / verify）
 *   fetch_bytes({ url, expectMd5 })  -> { bytes }  插头只给 URL，下载归共用层
 *
 * ⚠️ 统一形状是**给插头用的**，不是给闸用的。闸从头到尾不调这四样（§0.1 加工在闸外）。
 */

const path = require("path");

/**
 * @param {object} deps 现网已有的服务实例/配置，从 app.js 传进来。全部可选 ——
 *   **给不了的那样就不注册**，preflight 会点名缺哪一样，而不是运行时才炸。
 */
function buildSharedCapabilities({ config = {}, runtimeAdapter = null, imageGeneration = null, ttsService = null, fileStoreRoot = "" } = {}) {
  const out = {};

  // ——— 文件仓 ———
  // 转写和识图都吃文件路径，这一层保证「那个路径真有东西、类型是嗅出来的」。
  // 插头只管从平台拿字节，不用管存哪儿、叫什么、去不去重。
  {
    const { FileStore } = require("../gate/file-store");
    const fsRoot = fileStoreRoot || path.join(require("../core/paths").personaStateDir(), "gate-files");
    const store = new FileStore({ root: fsRoot });
    out.file_store = async (args = {}) => {
      if (args.verify) return store.verify(args.verify);
      return store.put(args);
    };
    out.file_store.store = store;     // 插头要直接用实例时（同步 put）也拿得到
  }

  // ——— 取字节：HTTP 下载 ———
  // 插头只给 URL，**下载这件事归共用层**（Alice 2026-09-17：能在公用层做的全部在公用层做）。
  // 超时、大小上限、完整性校验都在这儿做一份，接 QQ 接前端不用再写。
  out.fetch_bytes = async ({ url, headers = {}, expectMd5 = "", expectBytes = 0, timeoutMs = 30000, maxBytes = 64 * 1024 * 1024 } = {}) => {
    if (!/^https?:\/\//i.test(String(url || ""))) throw new Error("fetch_bytes 要一个 http(s) 地址");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let buf;
    try {
      const res = await fetch(url, { headers, signal: ctl.signal, redirect: "follow" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      buf = Buffer.from(await res.arrayBuffer());
    } finally { clearTimeout(timer); }
    if (buf.length > maxBytes) throw new Error(`下下来 ${buf.length} 字节，超过上限 ${maxBytes}`);
    if (!buf.length) throw new Error("下下来是空的");
    // 消息 XML 里本来就写着 len 和 md5 —— 白送的完整性校验，不用白不用
    if (expectBytes && buf.length !== Number(expectBytes)) {
      throw new Error(`大小对不上：拿到 ${buf.length}，消息里说是 ${expectBytes}`);
    }
    if (expectMd5) {
      const got = require("crypto").createHash("md5").update(buf).digest("hex");
      if (got !== String(expectMd5).toLowerCase()) throw new Error(`md5 对不上：拿到 ${got}，消息里说是 ${expectMd5}`);
    }
    return { bytes: buf, size: buf.length };
  };

  // ——— 转写：语音转文字 ———
  // 现网 transcribeAudioFile(filePath, options) 直接返回字符串（拿不到就是 ""）。
  // 内部自己走 whisper-1，失败再退本地 small.pt —— 那层兜底原样保留，这里不插手。
  // 2026-10-21：能力开关。GATE_TRANSCRIBE=off / GATE_ACOUSTIC=off = 不注册 —— 媒体那条线会明说
  // 「没接转写」，而不是每条语音都去撞一个没配的接口再报失败。不写 = 开（生产今天的样子）。
  const capOff = (k) => String(process.env[k] || "").trim().toLowerCase() === "off";
  if (!capOff("GATE_TRANSCRIBE")) try {
    const { transcribeAudioFile } = require("../services/transcription-service");
    out.transcribe = async ({ filePath } = {}) => {
      if (!filePath) throw new Error("transcribe 要一个音频文件路径");
      const text = await transcribeAudioFile(filePath, {});
      return { text: String(text || "") };
    };
  } catch (e) { /* 服务不在就不注册，preflight 会点名 */ }

  // ——— 声学（north-ear）：听「怎么说的」 ———
  // 转写只给「说了什么」，声学层给音高/呻吟感/气声这些**没被字面记下来的**东西。
  // 现网 analyzeAcoustics(filePath) 尽力而为、任何失败返回空串，绝不影响转写主链。
  // 跟转写一样吃 WAV，所以微信 SILK 那条也自动就有（插头已把语音解成 WAV）。
  if (!capOff("GATE_ACOUSTIC")) try {
    const { analyzeAcoustics } = require("../services/acoustic-service");
    out.acoustic = async ({ filePath } = {}) => {
      if (!filePath) return { text: "" };
      return { text: String((await analyzeAcoustics(filePath)) || "") };
    };
  } catch (e) { /* 声学层是增量信息，缺了也不拦转写；preflight 会点名 */ }

  // ——— 识图：**不注册**（2026-09-19，Alice「识图本来Nova也没有在用 走的是自己的识图」）———
  //
  // 图片的主路是「他自己看」：`media-pipeline` 的 PLAN 里 image/sticker 都是 `look`，
  // 原图当附件直接递给他（`nativeImageInput`），**不转述、不花钱**。
  // 这是Alice 2026-09-17 点出来的规矩，代码里也写着。
  //
  // 老的 `services/vision-context.js`（234 行）只是「运行时吃不下图」时的兜底 ——
  // 而它其实是**死代码**：2026-09-19 核过，`NOVA_VISION_*` 五个配置项
  // （base url / key / model / mode / provider）**生产里一个都没配**，
  // 真走到那条路第一行就抛 "vision API base URL and model are required"。
  //
  // 所以这一能力不注册。`media-pipeline` 早就备好了没有它的话怎么说：
  //   `if (!this.caps.has("vision")) → "[图片]（这个运行时看不了图，识图也没接上）"`
  // —— **明说没看成，不返回空**，这比硬接一个从来没通过的 API 诚实。
  // 真要给他配识图，是新写一个（独立包，像 nova-notebook），不是把这 234 行搬进新家。

  // ——— 语音合成 ———
  // voiceId **故意不接受调用方指定**：音色在 ~/.nova/voice-config.json 里，
  // 是Alice亲选的那个；凭记忆填的都是早就失效的旧 ID（他的提示词里也这么写着）。
  if (ttsService && typeof ttsService.generate === "function") {
    out.synthesize_voice = async ({ text, fileName } = {}) => {
      if (!String(text || "").trim()) throw new Error("synthesize_voice 要有词");
      const r = await ttsService.generate({ text, fileName });
      return { filePath: r.filePath, bytes: r.bytes, voiceId: r.voiceId, mimeType: "audio/mpeg" };
    };
  }

  // ——— 生图 ———
  if (imageGeneration && typeof imageGeneration.generate === "function") {
    out.generate_image = async ({ prompt, ...rest } = {}) => {
      if (!String(prompt || "").trim()) throw new Error("generate_image 要有提示词");
      // send:false —— **生成归第 1 层，发送归插头**。这里绝不自己发出去。
      const r = await imageGeneration.generate({ prompt, ...rest, send: false });
      return { files: r.files || [] };
    };
  }

  return out;
}

module.exports = { buildSharedCapabilities };
