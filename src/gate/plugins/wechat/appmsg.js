"use strict";

/**
 * WeChat appmsg parsing (link cards, quoted replies, files, transfers, ...).
 *
 * All of these are appmsg (low 32 bits of local_type = 49), differing by
 * subtype. Rendering them as one short line (title + URL, quoted text, file
 * path) keeps raw XML out of the agent's context. Per SPEC §0.1 parsing
 * belongs to the plugin; the gate never sees XML.
 */

/** Minimal extractor: content of the first matching tag. appmsg is flat enough; no XML library. */
function tag(xml, name) {
  const m = new RegExp("<" + name + ">([\\s\\S]*?)</" + name + ">").exec(xml);
  return m ? unescapeXml(stripCdata(m[1])).trim() : "";
}

/**
 * Strip a CDATA wrapper. title/des in appmsg are often wrapped in CDATA;
 * without this the wrapper leaks into the rendered text.
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
    .replace(/&amp;/g, "&");   // decode amp last, or &amp;lt; would become <
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
  // quoted reply: the quoted message is inside <refermsg>
  const refer = /<refermsg>([\s\S]*?)<\/refermsg>/.exec(s);
  if (refer) {
    out.quote = {
      text: tag(refer[1], "content"),
      from: tag(refer[1], "displayname") || tag(refer[1], "chatusr"),
    };
  }
  // file: the title is the file name
  if (out.type === 6) {
    out.fileName = out.title;
    out.fileSize = Number(tag(s, "totallen")) || 0;
  }
  return out;
}

/**
 * Source labels. Every card must be clearly marked as not typed by the sender:
 * cards contain third-party content (forwarded chats, product pages) that
 * could otherwise be mistaken for the sender's own words.
 */
const HEAD = {
  link: "【链接】", miniapp: "【小程序】", forward: "【聊天记录】",
  file: "【文件】", quote: "【引用】", favorite: "【收藏】",
  transfer: "【转账】", redpacket: "【红包】", channels: "【视频号】",
};

/**
 * Cards are capped at 600 chars.
 *
 * Forwarded-chat XML can be >10k chars with only a few hundred chars of actual
 * text (avatars, hashes, timestamps, tags). Injecting it raw wastes context and
 * can trip upstream safety filters.
 *
 * The cap applies to cards only; plain text (local_type=1) is never truncated.
 */
const APPMSG_MAX = 600;

/** Truncate and say so, so the reader never mistakes it for the full text. */
function clip(text, limit) {
  const t = String(text || "").trim();
  if (t.length <= limit) return t;
  return t.slice(0, limit) + "…（原文共 " + t.length + " 字，已截断）";
}

/**
 * One line for the agent instead of raw XML. The original stays in the event ledger.
 */
function renderAppmsg(kind, a) {
  if (kind === "quote" && a.quote) {
    const who = a.quote.from ? a.quote.from + "：" : "";
    return clip("【引用】" + who + a.quote.text + "\n" + (a.title || ""), APPMSG_MAX);
  }
  if (kind === "file") {
    const kb = a.fileSize ? " (" + Math.round(a.fileSize / 1024) + "KB)" : "";
    const head = "【文件】" + (a.fileName || a.title) + kb;
    // Always include the local path: the file is stored unencrypted and the agent
    // can read it directly with its own tools.
    if (a.localPath) return head + "\n" + a.localPath + "\n（明文在盘上，直接读）";
    return head + "\n（本地没找到这个文件，可能还没下载完）";
  }
  // When capping, only the description is shortened. Title and URL are kept
  // intact so the agent can open the link itself.
  const head = HEAD[kind] || "【卡片】";
  const keep = [head + (a.title || "(无标题)")];
  if (a.url) keep.push(a.url);
  const fixed = keep.join("\n");
  const des = a.des ? a.des.split("\n").join(" · ") : "";
  if (!des) return fixed;
  const room = APPMSG_MAX - fixed.length - 1;
  if (room <= 0) return fixed + "\n（描述共 " + des.length + " 字，已全部略去）";
  const body = clip(des, room);
  // URL is always kept
  return a.url ? keep[0] + "\n" + body + "\n" + a.url : fixed + "\n" + body;
}

module.exports = { parseAppmsg, renderAppmsg, unescapeXml, clip, stripCdata, APPMSG_MAX, HEAD };
