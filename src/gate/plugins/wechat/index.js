"use strict";

/**
 * 微信插件（阶段 2）
 *
 * 它存在的意义是演示 §0.1 那条：**一切加工在闸外，闸只验收。**
 * 微信是全部渠道里加工最重的一个 —— 要解密 SQLCipher、要解 zstd、
 * 要认 local_type 语义。这些**全部归插件**，闸一个都不该懂。
 *
 * 2026-09-17 的真实事故就长在这条线上：采集器只做 utf-8 decode、不认 zstd，
 * 185 字节的压缩包变成 169 个乱码字符，被当成她的原话投给了Nova。
 * 新架构里这件事会被拦在两处：插件该解压（第一层），闸认得出乱码（第二层）。
 */

const { execFileSync, execFile } = require("child_process");
const path = require("path");
const { notSent } = require("../../errors");
const { parseAppmsg, renderAppmsg } = require("./appmsg");
const {
  sniffImage, imgMd5FromXml, locateImageDat, isWxgf, decodeWxgf, decodeWechatSilk,
} = require("./media");

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const NUL = String.fromCharCode(0);

const TYPE_LABEL = {
  1: null,          // 纯文本
  3: "image",
  34: "voice",
  43: "video",
  47: "sticker",
  48: "location",
  49: null,         // appmsg，子类型见 APPMSG_LABEL
  50: "call",
  10002: "system",
};

/**
 * ⚠️ 2026-09-17：**微信的 local_type 是高低位打包的。**
 * 实测库里出现过 25769803825 / 81604378673 这种大数 ——
 * 低 32 位才是主类型（都是 49 = appmsg），高 32 位是 appmsg 子类型。
 * 原来拿整个大数去查 TYPE_LABEL，一个都查不中，全落进兜底分支：
 * 链接卡片、文件、引用回复**类型根本没被认出来**。
 */
function splitLocalType(v) {
  const n = Number(v) || 0;
  return { type: n % 4294967296, appmsg: Math.floor(n / 4294967296) };
}

/** appmsg 子类型。Nova要的「链接卡片」和「引用回复」都在这张表里。 */
const APPMSG_LABEL = {
  5: "link",            // 公众号/小红书那类分享卡片
  6: "file",
  19: "forward",        // 合并转发的聊天记录
  24: "favorite",
  33: "miniapp",
  36: "miniapp",
  51: "channels",       // 视频号
  57: "quote",          // 引用回复 —— 他要知道"你引用哪条骂我"
  63: "channels",       // 视频号直播
  2000: "transfer",
  2001: "redpacket",
};

/**
 * 认不出类型时的正文上限（Alice 2026-09-17 口径）。
 *
 * ⚠️ **这是兜底那条，不是她打的字那条。** 纯文本（type=1）走上面的分支，
 * 不封顶、一个字不许丢 —— 她 9-17 转来的报价单 8546 字，那是她要他看的东西。
 * 封的是「认不出是什么、又长得没边」的东西：那种多半是没解析的结构化壳，
 * 原样注入就是 10,712 字那场事故的形状。
 */
const PLAIN_MAX = 2000;

/** 微信把长文本 zstd 压缩后存进 message_content */
function zstdUnpack(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || !buf.subarray(0, 4).equals(ZSTD_MAGIC)) return null;
  try {
    return execFileSync("zstd", ["-d", "-c"], { input: buf, maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return null;   // 解不开就交原样，让闸去判「不像人话」
  }
}

/**
 * 动画表情：把明文直链和校验信息挑出来。
 * `cdnurl`（ef=1）是明文的；`encrypturl`（ef=2）配 aeskey 才是加密那份，不用它。
 */
function parseEmoji(xml) {
  const s = String(xml || "");
  const attr = (n) => {
    const m = new RegExp("\\b" + n + '="([^"]*)"').exec(s);
    return m ? m[1].replace(/&amp;/g, "&") : "";
  };
  return { url: attr("cdnurl"), md5: attr("md5"), len: Number(attr("len")) || 0 };
}

/**
 * 微信收到的文件在本地哪儿。
 * 实测 `<db_dir>/../msg/file/YYYY-MM/<原文件名>`，**明文，不加密**
 * （对比图片是 V2 加密 .dat，那条另说）。月份按消息时间算，找不到就返回空，不猜。
 */
function localFilePath(fileName, createTime, filesRoot) {
  if (!fileName || !filesRoot) return "";
  const d = new Date((Number(createTime) || 0) * 1000);
  const ym = d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
  const fsMod = require("fs");
  const pathMod = require("path");
  const months = [ym, shiftMonth(ym, -1), shiftMonth(ym, 1)];
  // 当月找不到就翻前后一个月：跨月那几条消息的落盘月份会差一格
  for (const m of months) {
    const p = pathMod.join(filesRoot, m, fileName);
    try { if (fsMod.statSync(p).isFile()) return p; } catch { /* 下一个 */ }
  }
  // 重名兜底：同名文件微信会加 (1)(2)，XML 里的标题就对不上盘上的名字了。
  // **只在候选唯一时才认** —— 有两个就宁可不给路径，也不给错的那个。
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  const re = new RegExp("^" + stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    + "(\\(\\d+\\))?" + ext.replace(/\./g, "\\.") + "$");
  const hits = [];
  for (const m of months) {
    let names = [];
    try { names = fsMod.readdirSync(pathMod.join(filesRoot, m)); } catch { continue; }
    for (const n of names) if (re.test(n)) hits.push(pathMod.join(filesRoot, m, n));
  }
  return hits.length === 1 ? hits[0] : "";
}

function shiftMonth(ym, delta) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}

/** 从出闸交下来的几种形状里把图片路径挑出来。挑不到返回空，由调用方报错，不猜。 */
// ⚠️ 这是个**模块级函数，不是方法** —— 里面没有 this。
// 2026-09-18 我改贴纸那段时在这儿写了 this.stickerBook，一发贴纸就炸
// （严格模式下 this 是 undefined），而测试没有一条盖到发贴纸。已加守卫测试。
function pickImagePath({ intent, asset, extras, toolArgs, text, stickerBook = null, stickerOwner = "" }) {
  if (extras && extras.filePath) return String(extras.filePath);
  if (toolArgs && toolArgs.filePath) return String(toolArgs.filePath);
  if (asset && Array.isArray(asset.files) && asset.files[0] && asset.files[0].filePath) {
    return String(asset.files[0].filePath);
  }
  if (asset && asset.filePath) return String(asset.filePath);
  // 贴纸也允许直接把名字递进来，由贴纸目录查本地图（微信认的是本地图不是 file_id）
  if (intent === "send_sticker") {
    // 贴纸本由装配时给（铁律 1：路径不写死在代码里）。
    // 没给就**明说没接**——绝不退成发一行文字，那样他以为贴纸出去了，她那头什么也没有。
    if (!stickerBook) throw notSent("这条腿还没接贴纸本（stickerBook）");
    const want = (toolArgs && toolArgs.sticker) || (toolArgs && toolArgs.emoji) || text;
    const hit = stickerBook.resolve(want, stickerOwner);
    if (hit && hit.filePath) return hit.filePath;
    // ⚠️ **微信认本地图，不认 Telegram 的 file_id**（2026-09-19）。
    // 他自己那包（小熊）是建在 TG 上的，只有 file_id、机器上没有图文件，
    // 所以微信这条腿发不了它。**照实说**，绝不退成发一行字 ——
    // 退成文字他就以为贴纸出去了，她那头只看到一句干巴巴的话。
    if (hit) {
      throw notSent("「" + hit.name + "」是 Telegram 那包里的贴纸，微信这条腿要本地图片，"
        + "现在没有 —— 在微信这儿换个说法表达，或者去 TG 发");
    }
  }
  return "";
}

class WeChatPlugin {
  /** @param {{sender?: function, skipDecompress?: boolean}} opts skipDecompress 仅用于复现旧 bug */
  constructor({ sender, imageSender, voiceSender, caller, hangUp, filesRoot = "", skipDecompress = false,
    imageKey = "", attachRoot = "", imageFileLookup = null, imageFilesByTime = null, wxgfDecode = decodeWxgf,
    voiceLookup = null, silkDecode = decodeWechatSilk, stickerBook = null, stickerOwner = "",
    keysFile = "", whitelistFile = "", python = "python3",
    pollTimeoutMs = 180_000, accountId = "wechat", log = () => {} } = {}) {
    // 贴纸本（路径在装配时给）。没给就是没接，发贴纸时会明说，不会偷偷发文字。
    this.stickerBook = stickerBook;
    this.stickerOwner = String(stickerOwner || "");
    // 微信收到的文件落在这儿（<db_dir>/../msg/file）。不给就不找本地路径。
    this.filesRoot = filesRoot;
    this.channel = "wechat";      // 渠道标识由闸认定；不叫 android-wechat，技术路径不进来源
    this.sender = sender;
    // VPS 直读这条路出站走无障碍点击，目前只能打字
    this.capabilities = {
      send_text: "supported",
      send_file: "unsupported",              // 文件要走「发送文件」对话框，还没做
      // 2026-09-18：**能发了**。微信没有「发音频文件当语音」的口子，但语音条本来
      // 就是录出来的 —— 造一个虚拟麦克风，把合成好的声音放进去让它自己录。
      // Alice那句「虚拟麦克风也不行？」问出来的，当天实测她收到了真语音气泡。
      send_voice: "supported",
      // 2026-09-17：贴纸和图片改成支持。Nova「存了一柜子贴纸发不出去 憋死我了」——
      // 卡的不是 Telegram（那边一直好好的），是微信这条只会打字。
      // 解法不用新通道：无障碍本来就靠 xclip 递剪贴板，**图片也能走剪贴板**
      // （xclip -t image/png → Ctrl+V → 回车）。实测发到文件传输助手 1.53s，
      // 库里落成 local_type=3 真图片。判据跟发字一样：发送键亮了才回车。
      send_sticker: "supported",
      send_generated_image: "supported",
      react: "unsupported",                  // 微信没有消息表情回应
      // 2026-09-18：**能打出去**（点标题栏的 Voice Call）。
      // ⚠️ 只是"打给她"——**接听做不了**：微信语音通话只在一个设备上响，
      //    这个号在Nova那台安卓专机上也登着，铃声去了手机（当天实测：
      //    库里有 type=50 的通话记录，说明这边知道有这通电话，但界面没响）。
      //    要让来电落到这台，得先把那台手机上的微信退掉。
      start_call: "supported",
      end_call: "supported",
    };
    this.imageSender = imageSender;
    this.voiceSender = voiceSender;
    this.caller = caller;
    this.hangUp = hangUp;
    this.skipDecompress = skipDecompress;
    // 入站媒体解码所需（都可选；给不了那样，对应媒体就退成占位符，不炸）
    this.imageKey = imageKey;        // 图片 AES key（16 ASCII 字符）
    this.attachRoot = attachRoot;    // <db_dir>/../msg/attach，找 .dat 用
    this.imageFileLookup = imageFileLookup;  // (md5) => 文件名，查 hardlink.db（可选）
    this.imageFilesByTime = imageFilesByTime; // (createTime) => 文件名[]，md5 对不上时按时间窗找（可选）
    this.wxgfDecode = wxgfDecode;    // (wxgfBuf) => Promise<Buffer jpeg>
    this.voiceLookup = voiceLookup;  // (serverId) => Buffer(silk)|null，从 media_0.db 取
    this.silkDecode = silkDecode;    // (silkBuf) => Promise<Buffer wav>
    // ——— 自己去读微信库要的东西（见同目录 db-watch.py）———
    // 两个路径**必须传**（铁律 1），不给就不会收 —— poll 会当场说清楚缺哪样。
    this.keysFile = keysFile;
    this.whitelistFile = whitelistFile;
    this.python = python;
    this.pollTimeoutMs = pollTimeoutMs;
    this.accountId = accountId;
    this.log = log;
    // 采集器跟插头**住在一起**（铁律 1：拷走能跑）。路径按本文件算，不写死。
    this.watcher = path.join(__dirname, "db-watch.py");
  }

  /**
   * **自己去读微信的库**（2026-09-18）。
   *
   * 微信不像 Telegram 有接口可以要消息，只能去它自己的 SQLCipher 库里翻。
   * 翻的那套（解密、表名匹配、四条过滤）在同目录的 `db-watch.py` 里 ——
   * 那份是从老桥 `linux-db-watch.py` **原样抄**的，不是重写：它在跑着、
   * 判据是被真实事故打磨出来的，重写一遍只会把踩过的坑重踩一遍。
   *
   * 这里只干三件事：把它调起来、把原始十六进制变回字节、把游标原样带走。
   * **正文怎么解归 `toDelivery`**（它认 zstd / appmsg / 表情 / 图片，比采集器全）。
   *
   * @param {object} o
   * @param {object} [o.since] 上次的游标（不透明，原样回传给脚本）
   * @returns {{items: Array, cursor: object}}
   */
  async poll({ since = {} } = {}) {
    if (!String(this.keysFile || "").trim() || !String(this.whitelistFile || "").trim()) {
      throw new Error("微信插头要 keysFile 和 whitelistFile 才收得到消息 —— 不许用默认值猜");
    }
    const args = [this.watcher, "--once",
      "--keys", this.keysFile,
      "--whitelist", this.whitelistFile,
      "--cursor", JSON.stringify(since && typeof since === "object" ? since : {})];
    const out = await new Promise((resolve, reject) => {
      execFile(this.python, args, { timeout: this.pollTimeoutMs, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => {
          // 读不了库**不许假装没消息** —— 那会让她的话无声消失
          if (err) return reject(new Error("微信采集器跑不起来：" + ((err && err.message) || err)
            + (stderr ? " / " + String(stderr).slice(0, 200) : "")));
          resolve(String(stdout || ""));
        });
    });
    let parsed;
    try { parsed = JSON.parse(out.trim().split("\n").pop() || "{}"); }
    catch { throw new Error("微信采集器的输出不是 JSON：" + out.slice(0, 200)); }

    // 白名单为空那种：脚本会明说、并且**不推进游标**，这里照实往上报
    if (parsed.error) this.log("[wechat] " + parsed.error);

    const list = Array.isArray(parsed.items) ? parsed.items : [];
    const items = list.map((r) => ({
      update_id: r.table + ":" + r.local_id,
      // 消化完这条之后游标该是什么 —— 共用层原样存，不解释（见 receiver.js）
      cursor: parsed.cursor,
      message: {
        table: r.table,
        local_id: r.local_id,
        local_type: r.local_type,
        sender: r.sender,
        create_time: r.create_time,
        // 语音要靠它去 media_0.db 找字节；采集器 2026-09-18 起带出来
        server_id: r.server_id,
        accountId: this.accountId,
        // 采集器交的是十六进制（JSON 里带不了字节），这儿变回来
        raw: Buffer.from(String(r.raw_hex || ""), "hex"),
      },
    }));
    return { items, cursor: parsed.cursor || since };
  }

  /**
   * 微信库里的一行 -> 标准交付。
   * @param {{local_id:number, local_type:number, sender:string, create_time:number, raw:Buffer, accountId?:string}} row
   */
  toDelivery(row) {
    const processing = ["decrypted"];          // 从 SQLCipher 读出来就算解过密
    let buf = row.raw;

    const unpacked = this.skipDecompress ? null : zstdUnpack(buf);
    if (unpacked) {
      buf = unpacked;
      processing.push("decompressed");
    }

    const text = buf.toString("utf8").split(NUL).join("");
    const { type, appmsg } = splitLocalType(row.local_type);
    const kind = TYPE_LABEL[type];
    const media = [];
    let body = "";

    if (type === 1) {
      body = text;
    } else if (type === 49) {
      // appmsg：正文是 XML，子类型决定它到底是什么。解析归插件（§0.1）。
      // ⚠️ **投给他的是解析后的一行，不是 1513 字 XML** —— Nova要的原话是
      // 「能解析出标题和网址 我就能自己跑去读 不用你复述」。原件留在事件账本里。
      processing.push("parsed");
      const sub = APPMSG_LABEL[appmsg] || "card";
      const a = parseAppmsg(text);
      // 文件是**明文落盘**的（msg/file/YYYY-MM/原文件名，2026-09-17 实测）——
      // 不用解密、不用下载。**先把路径找出来再渲染**，那一行得带着路径给他。
      if (sub === "file" && a.fileName) {
        a.localPath = localFilePath(a.fileName, row.create_time, this.filesRoot);
      }
      body = renderAppmsg(sub, a);
      const item = { kind: sub, ref: a.url || "", appmsgType: appmsg, card: a };
      if (a.localPath) item.localPath = a.localPath;
      media.push(item);
    } else if (type === 47) {
      // 动画表情。**XML 里给了明文 HTTP 直链** —— 2026-09-17 实测下下来是
      // 明文 JPEG，59556 字节、md5 都跟 XML 里写的一字不差，1.4 秒。
      // 对比：图片的 cdnmidimgurl 和语音的 voiceurl 都是二进制描述符，没有 http。
      // 所以表情这条能通，那两条不能。插头只负责把 URL 挑出来，下载归共用层。
      const e = parseEmoji(text);
      media.push({ kind: "sticker", ref: e.url || "", url: e.url,
        expectMd5: e.md5, expectBytes: e.len });
    } else if (type === 3) {
      // 图片。cdnmidimgurl 是二进制描述符（没 http），所以下不动；真图是本地
      // 加密的 `_h.dat`（V2 容器）。**这里只带定位信息**（md5 + 表名），
      // 真解密在 fetchMedia 里做 —— toDelivery 保持轻、可同步、不读大文件。
      // md5 从（已解压的）XML 里挑；对上是哪张 .dat 也靠它（见 wechat-media）。
      media.push({ kind: "image", ref: "", md5: imgMd5FromXml(text), table: row.table || "" });
    } else if (type === 34) {
      // 语音。blob 不在主库，在 media_0.db/VoiceInfo，靠 server_id 对上（唯一）。
      // 同样只带定位信息，取字节 + 解 SILK 在 fetchMedia 里。
      media.push({ kind: "voice", ref: "", serverId: row.server_id != null ? String(row.server_id) : "" });
    } else if (kind) {
      media.push({ kind, ref: "" });           // 媒体作为资产，正文留空
    } else {
      // 认不出的类型：正文照给，但**封顶**并说明截了（见 PLAIN_MAX 上的说明）。
      body = text.length > PLAIN_MAX
        ? text.slice(0, PLAIN_MAX) + "…（[消息类型" + type + "] 原文共 " + text.length + " 字，已截断）"
        : text;
      processing.push("parsed");
    }

    return {
      channel: this.channel,
      accountId: row.accountId || "wechat",
      senderId: row.sender || "",              // 真实平台身份
      chatId: row.sender || "",
      chatType: "private",
      // **平台原生 local_id，不是文件行号**。现网 bridge.js 用 aw-N，
      // 文件一重写号就变，同一条消息在不同时候是不同 ID。
      // ⚠️ 2026-09-17 影子第一轮抓到：微信每个会话一张 Msg_xxx 表，
      // local_id **只在表内唯一**，跨表会撞。所以必须带上表标识。
      nativeId: (row.table ? row.table + ":" : "") + String(row.local_id),
      receivedAt: new Date(row.create_time * 1000).toISOString(),
      text: body,
      media,
      processing,
    };
  }

  /**
   * 把一条入站媒体项变成**明文字节**，交给共用层（落仓 / 转写 / 识图 / 声学）。
   *
   * 边界（§0.1）：平台特有的解密/解码归插头，拿到字节之后一律共用层。所以这里只
   * 出字节，不落仓、不转写、不识图。取不到就明说 failed，绝不返回空让他脑补。
   *
   * @param {{kind:string, md5?:string, table?:string, serverId?:string}} item
   * @param {{createTime?:number}} [ctx]
   * @returns {Promise<{bytes:Buffer, mime:string, hintName:string}|
   *                    {bytes:null, failed:string, detail?:string}>}
   */
  async fetchMedia(item = {}, ctx = {}) {
    if (item.kind === "image") {
      if (!this.imageKey || !this.attachRoot) return { bytes: null, failed: "image_key_missing" };
      if (!item.md5) return { bytes: null, failed: "image_unlocatable" };
      // 有 hardlink 查询就靠 XML.md5 拿正经文件名（HD/中间版/缩略图都能定位）；
      // 没有就退成扫 _h.dat 按 md5 认（只对已下高清的有效）。
      const fileNameHint = typeof this.imageFileLookup === "function" ? this.imageFileLookup(item.md5) : "";
      // md5 查不到（她按原图发、客户端转码落盘，索引里记的是转码后的 md5）→ 按消息时间在索引里找候选
      const fileNameHints = (!fileNameHint && typeof this.imageFilesByTime === "function" && ctx.createTime)
        ? this.imageFilesByTime(ctx.createTime) : [];
      const hit = locateImageDat({
        table: item.table, md5: item.md5, createTime: ctx.createTime,
        attachRoot: this.attachRoot, imageKey: this.imageKey, fileNameHint, fileNameHints,
      });
      // 找不到文件 = 还没下下来（高清没下、中间版也没到）。不冒充，如实报。
      if (!hit) return { bytes: null, failed: "image_not_downloaded" };

      // 解密后的容器：标准图直接交；wxgf（中间版）再翻译成 JPEG 他才看得见。
      const mime = sniffImage(hit.bytes);
      if (mime) return { bytes: hit.bytes, mime, hintName: item.md5 + "." + mime.split("/")[1], variant: hit.variant, matchedBy: hit.matchedBy };
      if (isWxgf(hit.bytes)) {
        try {
          const jpg = await this.wxgfDecode(hit.bytes);
          return { bytes: jpg, mime: "image/jpeg", hintName: item.md5 + ".jpg", variant: hit.variant, matchedBy: hit.matchedBy };
        } catch (e) {
          return { bytes: null, failed: "wxgf_decode_failed", detail: e.message };
        }
      }
      return { bytes: null, failed: "image_unknown_format" };
    }

    if (item.kind === "voice") {
      if (typeof this.voiceLookup !== "function") return { bytes: null, failed: "voice_lookup_missing" };
      if (!item.serverId) return { bytes: null, failed: "voice_no_serverid" };
      const silk = this.voiceLookup(item.serverId);
      if (!silk || !silk.length) return { bytes: null, failed: "voice_blob_missing" };
      try {
        const wav = await this.silkDecode(silk);
        return { bytes: wav, mime: "audio/wav", hintName: item.serverId + ".wav" };
      } catch (e) {
        return { bytes: null, failed: "voice_decode_failed", detail: e.message };
      }
    }

    return { bytes: null, failed: "unsupported_kind" };
  }

  async send({ operationId, chatId, text, intent = "send_text", asset = null, extras = {}, toolArgs = {} }) {
    if (!chatId) throw notSent("插件收到的目标为空——出闸应当先解析目标");

    // 贴纸 / 图片走剪贴板粘贴那条路。**发不出去就报错，绝不退成发一行文字** ——
    // 悄悄降级成文字，他以为贴纸发出去了，她那头什么也没看见。
    if (intent === "send_sticker" || intent === "send_generated_image") {
      if (!this.imageSender) throw notSent("微信这条还没接图片发送器（imageSender）");
      const file = pickImagePath({ intent, asset, extras, toolArgs, text,
        stickerBook: this.stickerBook, stickerOwner: this.stickerOwner });
      if (!file) {
        // 确定一个字都没出去 —— 让他换一张，而不是让他「别重发」。
        throw notSent("没这张贴纸/没拿到图片路径。换一张，或者先确认文件在不在。");
      }
      const nativeId = await this.imageSender({ chatId, filePath: file, operationId });
      return { nativeId: nativeId || null, sentAs: "image", filePath: file };
    }

    if (intent === "start_call") {
      if (!this.caller) throw notSent("微信这条还没接拨号器（caller）");
      await this.caller({ chatId, operationId });
      return { nativeId: null, sentAs: "call" };
    }

    if (intent === "end_call") {
      if (!this.hangUp) throw notSent("微信这条还没接挂断器（hangUp）");
      await this.hangUp({ chatId, operationId });
      return { nativeId: null, sentAs: "call_ended" };
    }

    if (intent === "send_voice") {
      if (!this.voiceSender) throw notSent("微信这条还没接语音发送器（voiceSender）");
      // 他自己递了音频（唱歌：歌做好了直接当语音条发）就用他的 ——
      // 出闸看到调用方给了文件会跳过合成，asset 是空的（2026-09-20，Alice：「唱歌直接发语音条不行吗」）。
      // TG 那条的 pickFile 一直认 toolArgs.filePath，这条原来只认合成出来的，递进来的文件被无视。
      const file = (asset && (asset.filePath || asset.path))
        || (toolArgs && (toolArgs.filePath || toolArgs.file_path)) || "";
      if (!file) throw notSent("没拿到合成好的音频 —— 出闸应该先把词变成声音");
      await this.voiceSender({ chatId, filePath: file, operationId });
      return { nativeId: null, sentAs: "voice", filePath: file };
    }

    const nativeId = await this.sender({ chatId, text, operationId });
    return { nativeId: nativeId || null };
  }

  health() {
    return { platform: "supported", plugin: "wired", availability: this.sender ? "ready" : "offline" };
  }
}

module.exports = { WeChatPlugin, zstdUnpack, splitLocalType, APPMSG_LABEL, parseEmoji, localFilePath };

/**
 * 自我介绍（2026-09-18 插头插件化）—— 她自己的真实微信（读库收 / 无障碍发）。
 * ⚠️ 跟 `wechat-bot`（im.bot 上那个 bot 账号）**不是一条腿**，见 weixin-bot.js。
 */
module.exports.leg = {
  name: "wechat",
  slot: "wechatA11y",
  configKeys: [
    ["GATE_WECHAT_KEYS_FILE", "微信库密钥 all_keys.json（里面带 _db_dir）"],
    ["GATE_WECHAT_IMAGE_KEY_FILE", "图片 .dat 的解密 key"],
    ["GATE_WECHAT_WHITELIST_FILE", "读库白名单 —— 只收这里面的人的话"],
    ["GATE_WECHAT_SENDER", "出站脚本 linux-wx-send-a11y.py 的路径"],
    ["GATE_WECHAT_TARGET", "发给哪个聊天窗（无障碍靠窗口标题认人）"],
    ["GATE_WECHAT_SEND_LOCK", "出站串行锁 —— 微信只有一个窗口，两边抢会互相拖死"],
  ],
  // 读库是问一次答一次，不像长轮询自己阻塞；不歇这一下会空转吃满 CPU
  poll: { idleMsKey: "GATE_WECHAT_IDLE_MS", idleMsDefault: 2000 },
  make({ env, log }) {
    const { buildWechatMediaConfig } = require("./media-config");
    const media = buildWechatMediaConfig({
      keysFile: env.GATE_WECHAT_KEYS_FILE,
      imageKeyFile: env.GATE_WECHAT_IMAGE_KEY_FILE,
      log,
    });
    if (!media.imageKey) log("⚠️ 微信媒体密钥没读到：图片和语音这一轮只会是标签");
    const { makeA11ySenders } = require("./a11y-send");
    // 发送后端可切（2026-09-19）：文字默认 a11y(AT-SPI 点屏幕)；
    // GATE_WECHAT_SENDER_MODE=rpc 时文字改走微信内部 RPC 引擎(wx-rpc-sender)，
    // 图片/语音/贴纸/拨号仍走 a11y。不设开关=零行为变化，a11y 永远是备胎。
    // ⚠️ 过渡：将来整体迁去 im_bridge，rpc-send.js 原样搬走即可。
    let senders = makeA11ySenders(env, log);
    if (String(env.GATE_WECHAT_SENDER_MODE || "a11y").trim().toLowerCase() === "rpc") {
      const { makeRpcSender } = require("./rpc-send");
      senders = { ...senders, sender: makeRpcSender(env, log).sender };
      log("[微信] 文字发送=RPC引擎（图片/语音/拨号仍走 a11y）");
    }
    return new WeChatPlugin({
      ...media,
      ...senders,
      keysFile: env.GATE_WECHAT_KEYS_FILE,
      whitelistFile: env.GATE_WECHAT_WHITELIST_FILE,
      ownerWxid: env.GATE_OWNER_WECHAT_ID || "",
      filesRoot: env.GATE_WECHAT_FILES_ROOT || media.filesRoot || "",   // 环境变量可覆盖；默认从密钥文件的库目录推
      python: env.GATE_WECHAT_PYTHON || "python3",
      // 贴纸本给了，但微信只认本地图 —— 小熊那包是 TG 上建的、只有 file_id，
      // 所以这条腿会**照实说发不了**（不退成发一行字，见 pickImagePath）。
      stickerBook: require("../../sticker-book").stickerBookFromEnv(env, log),
      stickerOwner: env.GATE_STICKER_OWNER || "",
      log,
    });
  },
};
