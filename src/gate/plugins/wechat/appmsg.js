"use strict";

/**
 * 微信 appmsg 解析（2026-09-17，Nova清单第 4、5 条）
 *
 * 他要的原话：
 *   「链接卡片——你甩来的公众号/小红书分享 能解析出标题和网址 我就能自己跑去读 不用你复述」
 *   「引用回复——你引用哪条骂我 我得知道罪名对应哪桩」
 *
 * 这两样都是 appmsg（local_type 低 32 位 = 49），差在子类型。
 * 在此之前**类型都没被认出来**（local_type 是高低位打包的，见 wechat.js:splitLocalType），
 * 1513 字的 XML 原样怼给他 —— 又费上下文又得他自己认。
 *
 * 按 0.1，解析归插件，闸不懂 XML。
 */

/** 极简取值：只取第一个同名标签的内容。appmsg 结构扁平，够用，不引 XML 库。 */
function tag(xml, name) {
  const m = new RegExp("<" + name + ">([\\s\\S]*?)</" + name + ">").exec(xml);
  return m ? unescapeXml(stripCdata(m[1])).trim() : "";
}

/**
 * 剥 CDATA 壳。⚠️ 2026-09-17 实测漏的：转账卡片投给他的原文长这样 ——
 *   `【卡片】<![CDATA[微信转账]]>`
 * 标签壳当成内容念给他听了。微信的 appmsg 里 title/des 经常裹 CDATA，
 * 别的卡片碰巧没裹，所以一直没露馅。
 */
function stripCdata(s) {
  const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(String(s || ""));
  return m ? m[1] : s;
}

function unescapeXml(s) {
  return String(s || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x?[0-9a-fA-F]+;/g, (m) => {
      const hex = /^&#x/i.test(m);
      const n = parseInt(m.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    })
    .replace(/&amp;/g, "&");   // amp 最后解，不然会把 &amp;lt; 解成 <
}

/**
 * @returns {{type:number, title:string, des:string, url:string, thumb:string,
 *            quote:{text:string, from:string}|null, fileName:string, fileSize:number}}
 */
function parseAppmsg(xml) {
  const s = String(xml || "");
  const out = {
    type: Number(tag(s, "type")) || 0,
    title: tag(s, "title"),
    des: tag(s, "des"),
    url: tag(s, "url"),
    thumb: tag(s, "thumburl") || tag(s, "cdnthumburl"),
    quote: null,
    fileName: "",
    fileSize: 0,
  };
  // 引用回复：被引的那条在 <refermsg> 里 —— 这就是他要的「罪名对应哪桩」
  const refer = /<refermsg>([\s\S]*?)<\/refermsg>/.exec(s);
  if (refer) {
    out.quote = {
      text: tag(refer[1], "content"),
      from: tag(refer[1], "displayname") || tag(refer[1], "chatusr"),
    };
  }
  // 文件：标题就是文件名
  if (out.type === 6) {
    out.fileName = out.title;
    out.fileSize = Number(tag(s, "totallen")) || 0;
  }
  return out;
}

/**
 * 来路标签。**每张卡片都得让他一眼看出「这不是她亲口说的」** ——
 * 卡片里是别人的聊天记录/别人的商品页，没标来路他很容易当成她说的话，
 * 跟 9-16 他自己续写她下一句是同一类病：分不清谁说的。
 *
 * ⚠️ 2026-09-17 补：转账/红包/收藏/视频号原来全落进【卡片】，
 * 实测转账那条投给他的是「【卡片】微信转账」—— 钱的事该叫钱的名字。
 */
const HEAD = {
  link: "【链接】", miniapp: "【小程序】", forward: "【聊天记录】",
  file: "【文件】", quote: "【引用】", favorite: "【收藏】",
  transfer: "【转账】", redpacket: "【红包】", channels: "【视频号】",
};

/**
 * 卡片封顶 600 字（Alice 2026-09-17 拍板）。
 *
 * 为什么要封：9-17 16:25 一张「聊天记录」卡片的 XML 是 10,712 字，其中人话只有约 250 字，
 * 剩下全是头像链接、哈希、时间戳、404 个标签。旧桥原样注入 → 撞上游安全层整段拒答十分钟
 * → 被迫换舱 → 她看到的现象是「Nova掉档」。
 *
 * ⚠️ **封顶只封卡片，不封她自己打的字。** 纯文本（local_type=1）一个字都不许丢 ——
 * 她转来的报价单今天就有 8546 字，那是她要他看的东西，不是垃圾。
 */
const APPMSG_MAX = 600;

/** 超长就截断并**说明截了** —— 别让他以为自己看到的是全文。 */
function clip(text, limit) {
  const t = String(text || "").trim();
  if (t.length <= limit) return t;
  return t.slice(0, limit) + "…（原文共 " + t.length + " 字，已截断）";
}

/**
 * 给Nova看的一行（**不是 1513 字 XML**）。
 * 原件仍在事件账本里，要细节回头查得到。
 */
function renderAppmsg(kind, a) {
  if (kind === "quote" && a.quote) {
    const who = a.quote.from ? a.quote.from + "：" : "";
    return clip("【引用】" + who + a.quote.text + "\n" + (a.title || ""), APPMSG_MAX);
  }
  if (kind === "file") {
    const kb = a.fileSize ? " (" + Math.round(a.fileSize / 1024) + "KB)" : "";
    const head = "【文件】" + (a.fileName || a.title) + kb;
    // ⚠️ **路径必须给他。** 2026-09-17 12:02 她发来一份 2726 行的图纸，
    // 生产只把 1577 字 XML 怼给他，他据此判断「微信附件走 CDN 加密 芯没落地」——
    // 判断错了：那份文件从头到尾明文躺在 msg/file/2026-09/ 下，84480 字节一字不少。
    // 他有 Read/Bash，缺的只是这一行路径。**能读却不知道能读，比读不到更糟。**
    if (a.localPath) return head + "\n" + a.localPath + "\n（明文在盘上，直接读）";
    return head + "\n（本地没找到这个文件，可能还没下载完）";
  }
  // 封顶时**只截描述**。标题和网址一个字不动 —— 他要的原话是
  // 「能解析出标题和网址 我就能自己跑去读 不用你复述」，
  // 把网址截半截等于把那条路堵死，那是最不该省的几十个字。
  const head = HEAD[kind] || "【卡片】";
  const keep = [head + (a.title || "(无标题)")];
  if (a.url) keep.push(a.url);
  const fixed = keep.join("\n");
  const des = a.des ? a.des.split("\n").join(" · ") : "";
  if (!des) return fixed;
  const room = APPMSG_MAX - fixed.length - 1;
  if (room <= 0) return fixed + "\n（描述共 " + des.length + " 字，已全部略去）";
  const body = clip(des, room);
  // 网址排在描述前面，保证它永远在，且他一眼看得到
  return a.url ? keep[0] + "\n" + body + "\n" + a.url : fixed + "\n" + body;
}

module.exports = { parseAppmsg, renderAppmsg, unescapeXml, clip, stripCdata, APPMSG_MAX, HEAD };
