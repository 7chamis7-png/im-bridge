"use strict";

/**
 * 媒体流水线（2026-09-17 Alice：「能在公用层做的 全部在公用层做」）
 *
 * 这一层的边界写死一句话：
 *   **插头只负责「从这个平台拿到字节」，拿到之后的一切都归这儿。**
 *
 * 所以插头不用知道：图片要识图、语音要转写、视频要抽帧再识图、
 * 文件多大算大、认不出类型怎么办、加工失败了怎么跟他说。
 * 接 QQ、接前端、接任何新渠道，这些**一行都不用再写**。
 *
 * 进来：一个文件（字节或路径）+ 平台说它是什么
 * 出去：**他能读的一段话** + 结构化结果 + `attach`（要原样递给他看的文件）
 *
 * ⚠️ 加工失败**不装作没事**。识图挂了就说「这是张图，但没看成」，
 *    不能返回空让他以为她发了个寂寞 —— 空白比明说危险，他会自己脑补
 *    （跟入闸 no_content 那条同一个道理）。
 */

const path = require("path");
const { execFileSync } = require("child_process");

/**
 * 平台说的类型 -> 该怎么加工。认不出的一律当附件，不猜。
 *
 * ⚠️ **图片默认不"识图"** —— Alice 2026-09-17 点出来的：Claude 自己就会看图。
 * 现网 `vision-context.js` 早就是这么干的：运行时吃图（`nativeImageInput`）时
 * `route: "native"`，**原图直接当附件递给他，他自己看**；
 * 调识图服务出文字说明（`caption`）只是**运行时吃不下图时的兜底**。
 * 我第一版把兜底当成了主路 —— 那样又花钱、又把他能看见的东西降级成一句转述。
 */
const PLAN = {
  image: "look",        // 能递原图就递原图；递不了才退成识图
  sticker: "look",
  voice: "transcribe",  // 音频他吃不下，转写是唯一的路
  audio: "transcribe",
  video: "frames",      // 抽一帧，然后同样按 look 处理
  file: "none",
  link: "none",
  quote: "none",
};

/** 给他看的中文标签。describe 和 hydrate 共用一份 —— 别抄第二遍。 */
const LABEL = { file: "文件", link: "链接", quote: "引用", image: "图片",
  sticker: "表情", voice: "语音", audio: "语音", video: "视频" };

// 2026-10-21 查实：微信采集器读到消息行，比语音/图片本体同步进本地库快，
// 中间有 10~13 秒的时间差（Nova报的「voice_blob_missing」连中两次，翻 6 周
// 事件记录数出来的：590 条语音里失败 6 条，全部卡在采集器读到消息后 10~13 秒
// 这个窗口——不是坏了，是偶尔没等到）。这两个 failed 码专指「东西本来会有，
// 只是还没到」，等一下大概率就有；别的 failed 码（解码失败、key 缺失……）
// 等不来，不在这个重试名单里。
const TRANSIENT_FAILS = new Set(["voice_blob_missing", "image_not_downloaded"]);
const RETRY_DELAYS_MS = [3000, 5000]; // 两次重试，累计等 8 秒，比 10~13 秒的典型延迟窄，但省得真卡死的消息也白等太久
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 视频抽一帧。ffmpeg 是现成的（本机 /usr/bin/ffmpeg）。 */
function grabFrame(videoPath, outPath) {
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", videoPath, "-frames:v", "1", outPath],
    { timeout: 30000, stdio: ["ignore", "ignore", "pipe"] });
  return outPath;
}

class MediaPipeline {
  /**
   * @param {object} o
   * @param {import("./capabilities").Capabilities} o.caps 共用能力注册表
   * @param {object} o.fileStore FileStore 实例
   * @param {boolean} o.nativeImageInput 这个运行时吃不吃图。
   *   **这是运行时的事，不是渠道的事** —— 所以判断放共用层，插头一个字都不用管。
   *   现网从 `runtimeAdapter.getTurnCapabilities({model}).nativeImageInput` 拿。
   * @param {number[]} [o.retryDelaysMs] `hydrate()` 里对 TRANSIENT_FAILS 的重试
   *   间隔，默认 RETRY_DELAYS_MS。只给测试用来把 3s/5s 的真实延迟换成几毫秒。
   */
  constructor({ caps, fileStore, nativeImageInput = true, retryDelaysMs = RETRY_DELAYS_MS }) {
    this.caps = caps;
    this.fileStore = fileStore;
    this.nativeImageInput = Boolean(nativeImageInput);
    this.retryDelaysMs = retryDelaysMs;
  }

  /**
   * 插头把一件媒体交进来。
   *
   * @param {object} o
   * @param {string} o.kind     平台说这是什么（image/voice/video/file/sticker/link…）
   * @param {Buffer} [o.bytes]  字节（插头从平台拿到的）
   * @param {string} [o.srcPath] 或者一个已经在盘上的路径（微信的文件就是明文落盘的）
   * @param {string} [o.channel] 只用来分目录
   * @param {string} [o.hintName] 原文件名，只记录
   * @returns {Promise<{text:string, kind:string, filePath:string, mime:string,
   *                    bytes:number, processed:string, failed:string}>}
   */
  async ingest({ kind = "file", bytes, srcPath, url = "", expectMd5 = "", expectBytes = 0,
                 channel = "unknown", hintName = "" }) {
    // —— 0. 插头只给了 URL 的话，共用层负责下载（带 md5/大小校验）。——
    if (!bytes && !srcPath && url) {
      if (!this.caps.has("fetch_bytes")) {
        return { text: `[${kind}：只有个链接，下载能力没注册]`, kind, filePath: "", mime: "",
          bytes: 0, processed: "none", failed: "capability_missing" };
      }
      try {
        const r = await this.caps.call("fetch_bytes", { url, expectMd5, expectBytes });
        bytes = r.bytes;
      } catch (e) {
        return { text: `[${kind}：下载失败 —— ${e.message}]`, kind, filePath: "", mime: "",
          bytes: 0, processed: "none", failed: "fetch" };
      }
    }

    // —— 1. 先落仓。类型从内容嗅，路径保证存在，同内容自动去重。——
    let stored;
    try {
      stored = this.fileStore.put({ bytes, srcPath, channel, hintName });
    } catch (e) {
      // 连字节都没拿到 —— 这不是加工失败，是上游就断了，必须说出来
      return {
        text: `[${kind}：文件没拿到 —— ${e.message}]`,
        kind, filePath: "", mime: "", bytes: 0, processed: "none", failed: "store",
      };
    }

    const base = {
      kind, filePath: stored.filePath, mime: stored.mime, bytes: stored.bytes,
      deduped: stored.deduped, hintName,
    };

    // —— 2. 按计划加工。共用能力没注册就说清楚缺哪一样，不静默降级。——
    const plan = PLAN[kind] || "none";
    if (plan === "none") return { ...base, text: this.describe(base), processed: "none", failed: "" };

    try {
      if (plan === "transcribe") {
        if (!this.caps.has("transcribe")) {
          return { ...base, text: `[语音：转写没接上，音频已存在 ${path.basename(stored.filePath)}]`,
            processed: "none", failed: "capability_missing" };
        }
        const r = await this.caps.call("transcribe", { filePath: stored.filePath });
        const t = String((r && r.text) || "").trim();
        // 声学层（north-ear）：听「怎么说的」。**增量信息，绝不拖累转写主链** ——
        // 没注册 / 出错 / 空结果都当没有，转写照常返回。撩人的语气不在字面里。
        let acoustic = "";
        if (this.caps.has("acoustic")) {
          try {
            const a = await this.caps.call("acoustic", { filePath: stored.filePath });
            acoustic = String((a && a.text) || "").trim();
          } catch { /* 声学挂了不影响「说了什么」 */ }
        }
        const head = t ? `[语音] ${t}` : "[语音：一段听不清的，没转出字]";
        // 转不出字不等于没这条语音 —— 说清楚，别返回空
        return { ...base, text: acoustic ? `${head}\n${acoustic}` : head,
          transcript: t, acoustic, processed: "transcribe", failed: t ? "" : "empty" };
      }

      if (plan === "look" || plan === "frames") {
        let look = stored.filePath;
        if (plan === "frames") {
          const frame = stored.filePath + ".frame.png";
          try {
            grabFrame(stored.filePath, frame);
            look = frame;
          } catch (e) {
            return { ...base, text: "[视频：抽帧失败，没看成]", processed: "none", failed: "frames" };
          }
        }
        const head = kind === "sticker" ? "[表情]" : kind === "video" ? "[视频]" : "[图片]";

        // —— 主路：他自己会看。原图当附件递上去，**不转述、不花钱**。——
        if (this.nativeImageInput) {
          return { ...base, text: head, attach: [look],
            processed: "native", failed: "" };
        }

        // —— 兜底：这个运行时吃不下图，才退成识图出一句文字说明。——
        if (!this.caps.has("vision")) {
          return { ...base, text: head + "（这个运行时看不了图，识图也没接上）",
            processed: "none", failed: "capability_missing" };
        }
        const r = await this.caps.call("vision", { filePaths: [look] });
        const t = String((r && r.text) || "").trim();
        return { ...base, text: t ? `${head} ${t}` : `${head}：没看出内容`,
          description: t, processed: "caption", failed: t ? "" : "empty" };
      }
    } catch (e) {
      // 加工炸了，文件还在。说出来，别让他以为她什么都没发
      return { ...base, text: `${this.describe(base)}（加工失败：${e.message}）`,
        processed: "none", failed: "error" };
    }

    return { ...base, text: this.describe(base), processed: "none", failed: "" };
  }

  /**
   * 把一条**交付**里的媒体从「定位信息」变成「他能读的东西」。
   *
   * 这就是 2026-09-17 之前缺的那一针：插头的 `toDelivery` 只带定位（微信图片带 md5+表名、
   * 语音带 server_id），真字节在 `fetchMedia` 里。以前没人把这两头接上，
   * 于是解密解得再对，投到他眼前还是光秃秃一个 `[图片]` —— 流水线整条空转。
   *
   *   toDelivery（定位） → **hydrate**（fetchMedia 取字节 → ingest 加工） → 入闸
   *
   * 边界没变：**取字节归插头**（平台特有的解密/解码），**拿到字节之后全归这儿**。
   * 原地改 `delivery.media` 的每一项，然后把 delivery 原样交回去 —— 入闸拿到的
   * 已经是人话，闸依旧不懂 SQLCipher、不懂 SILK。
   *
   * @param {object} delivery 插头交付的那条（会被就地补字段）
   * @param {object} plugin   交付它的插头（可能没有 fetchMedia，那就只走 url/路径）
   */
  async hydrate(delivery, plugin) {
    const items = Array.isArray(delivery && delivery.media) ? delivery.media : [];
    if (!items.length) return delivery;
    const channel = (delivery && delivery.channel) || "unknown";
    // 插头取字节常要知道「这条是什么时候的」（微信按月分目录找 .dat）。
    // 这不是渠道知识，是交付自带的事实，共用层给得起。
    const createTime = Math.floor(Date.parse((delivery && delivery.receivedAt) || "") / 1000) || 0;

    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      if (item.text) continue;                     // 插头已经给过话了，不覆盖
      const kind = item.kind || "file";
      const label = LABEL[kind] || kind;

      // 盘上已是明文、又没什么可加工的（文件/链接/引用）—— 路径/网址已经在正文里给他了。
      // 再复制进文件仓只多一份存货，不多一点信息。跳过。
      // （Alice 9-17：文件"解析不了"其实是**能读却没告诉他路径**，路径别弄丢。）
      if ((PLAN[kind] || "none") === "none" && (item.localPath || item.ref)) continue;

      let src = null;
      let hintName = item.hintName || "";

      // —— 1. 插头能取字节就让它取（微信图片的 AES+wxgf、语音的 SILK 都在插头里）——
      if (plugin && typeof plugin.fetchMedia === "function") {
        let r;
        let attempt = 0;
        for (;;) {
          try { r = await plugin.fetchMedia(item, { createTime }); }
          catch (e) { r = { bytes: null, failed: "fetch_threw", detail: e.message }; }
          const transient = r && !r.bytes && TRANSIENT_FAILS.has(r.failed) && attempt < this.retryDelaysMs.length;
          if (!transient) break;
          await sleep(this.retryDelaysMs[attempt]);
          attempt += 1;
        }
        if (attempt > 0 && r && r.bytes && r.bytes.length) {
          item.retried = attempt; // 只记成功时重试了几次；查问题时能看出这条是不是撞了同步延迟
        }
        if (r && r.bytes && r.bytes.length) {
          src = { bytes: r.bytes };
          hintName = r.hintName || hintName;
          if (r.variant) item.variant = r.variant;
        } else if (r && r.failed && r.failed !== "unsupported_kind") {
          // 取不到就明说。**空白比明说危险**——跟入闸 no_content 同一条道理。
          // unsupported_kind 例外：那只是「这个插头不管这类」，下面还有别的路子。
          item.failed = r.failed;
          item.text = "[" + label + "：取不到 —— " + r.failed
            + (r.detail ? "（" + r.detail + "）" : "") + "]";
          continue;
        }
      }

      // —— 2. 插头只给了明文直链（微信动画表情）→ 下载归共用层 ——
      if (!src && item.url) {
        src = { url: item.url, expectMd5: item.expectMd5 || "", expectBytes: item.expectBytes || 0 };
      }
      // —— 3. 盘上已有明文文件（微信的文件是明文落盘的）——
      if (!src && item.localPath) src = { srcPath: item.localPath };
      // 真没有可取的路子（纯引用、只有个 file_id 还没接下载）——保持原样，不编。
      if (!src) continue;

      const out = await this.ingest({ kind, channel, hintName, ...src });
      item.text = out.text;
      item.filePath = out.filePath || "";
      item.mime = out.mime || "";
      item.byteLength = out.bytes || 0;
      item.processed = out.processed;
      if (out.failed) item.failed = out.failed;
      if (out.transcript) item.transcript = out.transcript;
      if (out.acoustic) item.acoustic = out.acoustic;
      if (out.description) item.description = out.description;
      if (out.attach) item.attach = out.attach;
    }
    return delivery;
  }

  /** 没加工（或加工不了）时给他看的一行。**永远不是空串。** */
  describe({ kind, mime, bytes, hintName, filePath }) {
    const name = hintName || path.basename(filePath || "");
    const kb = bytes ? ` ${Math.round(bytes / 1024)}KB` : "";
    const label = LABEL[kind] || kind;
    return `[${label}${name ? " " + name : ""}${kb}${mime ? " " + mime : ""}]`;
  }
}

module.exports = { MediaPipeline, PLAN, LABEL };
