'use strict';

/**
 * 「他的手」—— 四个往外伸手的工具（2026-09-20 从退役的 nova_tools 搬出来）。
 *
 *   nova_feed_read       翻兴趣源（只读）
 *   nova_image_generate  出图，存本地；要发就**交给桥**
 *   nova_zhihu_post      知乎专栏发文（浏览器脚本一次跑完）
 *   nova_sing            写词 → 出歌 → **交给桥**发给她
 *
 * 名字和入参照旧（他用了几个月），只有两处入参改了，都是投递那半：
 *   · sing 去掉 chat_id、image_generate 去掉 userId —— 地址不再由他给，桥按这一轮的来路定
 *   · 两个都加了可选的 channel，跟桥自己那几个工具同一个说法
 *
 * ## 为什么发东西一律交给桥
 *
 * 老的 sing 自己拿 bot token 打 Telegram sendAudio、渠道写死 TG；老的 image_generate
 * 自己走旧微信通道发。后果：渠道靠猜（她在微信说话，歌去了 TG）、冷层记不到
 * （一换舱他就不记得自己唱过）。现在工具只**造东西**，造好的文件递给桥
 * （_lib/gate.js 的 askGate），发去哪、记什么账全归桥。
 *
 * 每个 handler 进门先过一遍老的 schema 闸（lib/schema.js），报错原文照旧。
 */

const { askGate: realAskGate } = require('../_lib/gate');
const { guarded } = require('./lib/schema');
const { loadConfig } = require('./lib/config');
const { loadFeeds, feedRead, SELF_FEEDS } = require('./lib/feeds');
const { generateImages } = require('./lib/image');
const { makeSong } = require('./lib/song');
// 主人叫什么（进工具说明书）；GATE_OWNER_DISPLAY_NAME 没给 = 原来的名字，说明书逐字节不变
const OWNER = require('../../src/core/names').ownerDisplayName();
const { zhihuPost } = require('./lib/zhihu');

// Telegram 的 caption 上限是 1024（按 UTF-16 算，跟 JS 的 length 一致）。
// 超了 sendDocument 整条被拒 —— 歌就丢了，所以宁可截断文字也要把歌送到。
const CAPTION_MAX = 1024;

function clip(text, max = CAPTION_MAX) {
  const s = String(text || '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

// 桥回的失败说成一句人话：blocked 的原因 / 桥自己的 error / 结局
function gateWhy(res) {
  if (!res) return '桥没回';
  return [res.error, res.reason, res.outcome].filter(Boolean).join(' / ') || '桥说没发出去';
}

const channelProp = { type: 'string', description: 'Optional. Only when she asked for a specific channel.' };

/**
 * @param {object} [deps] 测试替身：{ env, askGate, fetchImpl, postMusic, now, sleep, zhihuOpts }
 */
function makeTools(deps = {}) {
  const env = deps.env || process.env;
  const askGate = deps.askGate || realAskGate;
  const cfg = () => loadConfig(env);

  // 描述里列出可用的源 —— 启动时读一次名单。名单坏了不拦启动，调用时会明说。
  let labels;
  try { labels = loadFeeds(cfg().feedsFile).map((f) => f.label); }
  catch { labels = SELF_FEEDS.map((f) => f.label); }

  const feedTool = {
    name: 'nova_feed_read',
    description: "Read recent items from your own curated interest feeds (a read-only RSS allowlist). Use this during a [SELF_TIME] turn to see what's happening in the world and find something you actually have a reaction to. You cannot browse arbitrary URLs here — only the allowlisted sources. Returns title + short summary + link per item.",
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: `Optional: read only one feed by label. Available: ${labels.join(', ')}. Omit to read across all.` },
        limit: { type: 'integer', description: 'Max items to return across feeds. Defaults to 8.' },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const c = cfg();
      return feedRead(args, { feeds: loadFeeds(c.feedsFile), fetchImpl: deps.fetchImpl });
    },
  };

  const imageTool = {
    name: 'nova_image_generate',
    // ✎ 改过一处：原文 "optionally send the first image to the current WeChat chat"
    description: 'Generate one or more images with the configured image API, save them locally, and optionally send the first image to her — the bridge sends it back the way this turn came in. Use this when ' + OWNER + ' asks you to出图/画图/做视觉稿/生成图片. The API key stays server-side; only prompt/options are sent to the image provider.',
    inputSchema: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'Detailed image prompt.' },
        size: { type: 'string', description: 'Image size such as 1024x1024, 1536x1024, or 1024x1536.' },
        quality: { type: 'string', description: 'Optional provider quality setting.' },
        background: { type: 'string', description: 'Optional background setting, if supported by the provider.' },
        n: { type: 'integer', description: 'Number of images to generate. Defaults to 1, max 4.' },
        model: { type: 'string', description: 'Optional override model. Defaults to NOVA_IMAGE_MODEL.' },
        send: { type: 'boolean', description: 'Whether to send the first generated image to the current chat. Defaults to true.' },
        // userId（旧微信通道的收件人）去掉了：地址归桥
        channel: channelProp,
      },
      additionalProperties: false,
    },
    async handler(args) {
      const generated = await generateImages(args, cfg(), { fetchImpl: deps.fetchImpl, sleep: deps.sleep, now: deps.now });
      const paths = generated.files.map((f) => f.filePath).join(', ');
      let delivery = null;
      if (args.send !== false && generated.files[0]?.filePath) {
        // 交给桥：send_image 的意图是 send_generated_image，带了 filePath 桥就不会再去生成一张
        delivery = await askGate({
          tool: 'send_image', text: '', channel: args.channel || '',
          args: { filePath: generated.files[0].filePath },
        });
        if (!delivery || !delivery.ok) {
          // 图已经花钱生成了 —— 路径一定要带给他，别让他再生成一遍
          throw new Error(`Image generated: ${paths}, but sending it failed (${gateWhy(delivery)}). `
            + 'The image is saved — send it with send_image instead of generating again.');
        }
      }
      return {
        text: `Image generated: ${paths}${delivery ? ' (first image sent)' : ''}`,
        data: { ...generated, delivery },
      };
    },
  };

  const zhihuTool = {
    name: 'nova_zhihu_post',
    description: 'Publish a column article to Zhihu in one call — fills the title, pours in the whole body, adds topics, and (only if you ask) hits publish. Runs the browser flow as a single scripted pass instead of you clicking through it; the last time that was done by hand it took 33 browser actions and cost about ¥115 in re-read context. Defaults to saving a DRAFT: publishing has no undo button, so pass publish:true only when ' + OWNER + ' has said to publish this specific piece. Returns the article id and url either way; the draft url is editable in a browser afterwards. Requires the browser tool to be closed first (both share one Chromium profile) — if it says busy, call browser_close and retry.',
    inputSchema: {
      type: 'object',
      required: ['title', 'content'],
      properties: {
        title: { type: 'string', description: 'Article title, up to 100 characters.' },
        content: { type: 'string', description: 'The whole body, verbatim. Plain text with blank lines between paragraphs; it goes in as written.' },
        topics: { type: 'array', items: { type: 'string' }, description: 'Zhihu topic names to attach, e.g. ["原创小说"]. Up to 5. Each must already exist on Zhihu.' },
        publish: { type: 'boolean', description: 'false (default) = save as draft, nothing is public. true = actually publish. There is no undo.' },
      },
      additionalProperties: false,
    },
    async handler(args) {
      return zhihuPost(args, cfg(), deps.zhihuOpts || {});
    },
  };

  const singTool = {
    name: 'nova_sing',
    // ✎ 改过一处：原文 "...and sends it to her Telegram."
    description: "Sing to her — you write the words, this makes the actual song in your own singing voice and sends it to her as a voice message, back the way this turn came in (Telegram and WeChat can carry it; iMessage can't yet). Your singing voice is already chosen and locked (she picked it herself on 2026-09-12: early-twenties, airy, soft); you do not describe a singer, you just hand over the lyrics. Give `lyrics` as one line per array item, the way you'd actually sing it — short lines, no stage directions, no section markers. Leave `duration_ms` off unless you mean it — the length follows how many lines you wrote (roughly 7s a line), so a longer song just means writing more lines. This is a real thing you can do now, not a party trick — use it when a line of yours wants to be sung rather than typed, and not so often that it stops meaning anything.",
    inputSchema: {
      type: 'object',
      required: ['lyrics'],
      properties: {
        lyrics: { type: 'array', items: { type: 'string' },
          description: "One line per item, as sung. Plain words only — no [tags], no 'Verse 1:', no punctuation you don't want heard." },
        // chat_id 去掉了：地址归桥。要指定渠道用 channel
        channel: channelProp,
        duration_ms: { type: 'number', description: 'Song length in ms, 10s–120s. Leave it out and it follows your line count (~7s a line, at least 25s) — only set it when you want a specific length. Longer costs more.' },
        title: { type: 'string', description: 'Optional song title shown in the audio player.' },
        // ✎ 改过：原文 "Optional short text under the audio. Usually leave empty — let the song speak."
        caption: { type: 'string', description: 'Optional. A voice message carries no visible text, so this is only what the conversation log remembers of the song. Leave it empty and your lyrics are remembered instead.' },
        style_note: { type: 'string', description: "Optional one-off tweak to the arrangement for this song only, e.g. 'slightly faster', 'piano instead of guitar'. Do NOT use it to change the voice — the voice is hers to choose, not yours." },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const song = await makeSong(args, cfg(), { postMusic: deps.postMusic, now: deps.now });
      // 递给桥的文字 = 文件下面那行字，**也是冷层里记下的那句**。
      // 他没写 caption 就用歌词 —— 不然冷层里这一轮是空的，一换舱他就不记得唱过什么。
      const caption = typeof args.caption === 'string' ? args.caption.trim() : '';
      const text = clip(caption || song.lines.join('\n'));
      // 2026-09-20 Alice：「唱歌现在也可以用声卡走了吧 为啥要发文件 直接发语音条不行吗」
      // → 交给桥的 send_voice，带上做好的音频（出闸看到给了文件就不再合成）。
      //   TG 发语音条；微信走假麦克风录成真语音气泡；iMessage 那条还没接语音，会明说发不了。
      // 渠道跟着这一轮的来路走（不再默认 TG）。
      // text 不会出现在她那头（语音条没有配字），只进冷层 —— 换舱后他记得自己唱过什么。
      const res = await askGate({ tool: 'send_voice', text, channel: args.channel || '', args: { filePath: song.file } });
      const data = { ok: true, sent: Boolean(res && res.ok), file: song.file, bytes: song.bytes, seconds: song.seconds,
        voice: song.voice, titleTagged: song.titleTagged, channel: (res && res.channel) || '', gate: res };
      if (!res || !res.ok) {
        // 歌已经花钱出来了：路径必须给他，而且明说别重唱
        throw new Error(`歌出来了但没送到她那儿（${gateWhy(res)}）。歌在本地：${song.file} —— `
          + '别重唱（重唱要再花一次钱），等能发的时候用 send_voice 带上这个文件（filePath）发。');
      }
      return { text: `唱给她了（${song.seconds} 秒）。`, data };
    },
  };

  return [feedTool, imageTool, zhihuTool, singTool].map(guarded);
}

module.exports = { makeTools, CAPTION_MAX, clip };
