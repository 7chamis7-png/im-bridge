"use strict";

/**
 * Turn a gate envelope into the small input shape understood by a runtime.
 *
 * Media processing happens before the envelope is made, so its useful text
 * and attachment information lives on each payload.media item.  Keeping this
 * translation here means every box gets the same boundary semantics and the
 * envelope (and therefore the cold layer) stays unchanged.
 */

const MEDIA_LABELS = Object.freeze({
  image: "图片",
  sticker: "表情",
  voice: "语音",
  audio: "语音",
  video: "视频",
  file: "文件",
  link: "链接",
  quote: "引用",
});

// Claude's attachment input accepts files that can be presented to it.  Raw
// audio is deliberately excluded: the media pipeline turns audio into text,
// and passing the source file to this CLI does not make it playable.
const PATH_ATTACHMENT_KINDS = new Set(["image", "sticker", "file"]);

function asText(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function mediaLine(media) {
  if (!media || typeof media !== "object") return "[媒体：无法读取]";
  const rendered = asText(media.text).trim();
  if (rendered) return rendered;
  const kind = asText(media.kind).trim().toLowerCase();
  return "[" + (MEDIA_LABELS[kind] || kind || "媒体") + "]";
}

function explicitAttachments(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (!item || typeof item !== "object") return [];
    return [item.path || item.filePath || item.localPath || ""];
  });
}

function isProcessedVideo(media) {
  const processed = asText(media && media.processed).trim().toLowerCase();
  if (["native", "frame", "frames"].includes(processed)) return true;
  const values = explicitAttachments(media && media.attach);
  return values.some((value) => /(^|[._-])frame([._-]|$)/i.test(asText(value))
    || /(^|[\\/])frame([._-]|$)/i.test(asText(value)));
}

function pathAttachment(media) {
  if (!media || typeof media !== "object") return "";
  const kind = asText(media.kind).trim().toLowerCase();
  if (kind === "voice" || kind === "audio") return "";
  if (kind === "video") return "";
  if (!PATH_ATTACHMENT_KINDS.has(kind)) return "";
  return [media.filePath, media.path, media.localPath]
    .map(asText)
    .find((candidate) => candidate.trim()) || "";
}

function placeholder(envelope) {
  const id = asText(envelope && envelope.trace_id).trim() || "未知事件";
  if (envelope && envelope.verdict === "undecoded") {
    return "[未解码内容：插件交付的正文无法读取，原件已留在事件账本 " + id + "]";
  }
  return "[空事件：既无正文也无媒体，多半是上游取值出错。不要当成 owner 说了什么，"
    + "更不要猜 owner 想说什么。账本 " + id + "]";
}

/**
 * @param {object} envelope gate envelope
 * @returns {{text:string, attachments:string[]}}
 */
function normalizeModelInput(envelope = {}) {
  // A failed verdict owns the rendered input.  In particular, never expose
  // payload.text or media.text from an undecoded event to the model.
  if (envelope.verdict === "undecoded" || envelope.verdict === "no_content") {
    return { text: placeholder(envelope), attachments: [] };
  }

  const payload = envelope.payload && typeof envelope.payload === "object"
    ? envelope.payload : {};
  const text = asText(payload.text);
  const media = Array.isArray(payload.media) ? payload.media : [];
  // Legacy Telegram hosts may put the same transcription in payload.text and
  // media.text. Keep the content once while still preserving distinct media
  // renderings alongside ordinary user text.
  const mediaLines = media.map(mediaLine).filter((line) => line !== text);
  const renderedText = text
    ? (mediaLines.length ? text + "\n" + mediaLines.join("\n") : text)
    : mediaLines.join("\n");

  const attachments = [];
  const seen = new Set();
  const add = (candidate) => {
    const value = asText(candidate).trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    attachments.push(value);
  };
  for (const item of media) {
    if (!item || typeof item !== "object") continue;
    const kind = asText(item.kind).trim().toLowerCase();
    // Audio is represented by its transcription. Raw audio is unsupported by
    // the CLI even when an upstream item happens to carry `attach`.
    if (kind === "voice" || kind === "audio") continue;
    const preferred = (kind === "video" && !isProcessedVideo(item)
      ? [] : explicitAttachments(item.attach)).filter((candidate) => asText(candidate).trim());
    if (preferred.length) preferred.forEach(add);
    else add(pathAttachment(item));
  }

  return { text: renderedText, attachments };
}

// The longer name documents the boundary for boxes that do not use the
// Claude host implementation.
const normalizeRuntimeInput = normalizeModelInput;

module.exports = {
  normalizeModelInput,
  normalizeRuntimeInput,
  mediaLine,
};
