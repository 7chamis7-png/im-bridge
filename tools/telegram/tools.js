'use strict';

/**
 * TG 专用包（2026-09-20）—— 只有 Telegram 才有的说话方式。
 *
 * Alice：「那是不是可以直接做一个tg专用mcp包」「也就是现在的媒体分 通用层和专用层」。
 *   · 通用层 = 桥的 reply / send_image / send_voice …（哪条渠道都有）
 *   · 专用层 = 这一包：选项按钮、回复某一条。名字带 tg_，一看就知道只在 TG 管用
 *
 * **还是交给桥发**（askGate → reply），只是多带渠道专属参数：冷层、账本照记，
 * 渠道照旧跟着这一轮的来路。这一轮不在 TG → 桥会把字照发、明说按钮没出去，
 * 这里把那句话原样转告他，不假装成功。
 *
 * 她按了按钮：桥的 TG 腿收回调，变成她说的一句「（点了按钮）选项」送回给他。
 */

const { askGate: defaultAskGate } = require('../_lib/gate');

/** Telegram 的 callback_data 上限 64 字节（按字节算，中文一个字 3 字节）。 */
function clipBytes(s, max = 64) {
  let out = '';
  for (const ch of String(s)) {
    if (Buffer.byteLength(out + ch, 'utf8') > max) break;
    out += ch;
  }
  return out;
}

function explain(res, what) {
  if (!res || !res.ok) {
    throw new Error(`没发出去：${(res && (res.error || res.reason)) || '桥没给原因'}。她那边什么也没收到。`);
  }
  const lost = Array.isArray(res.unsupportedExtras) ? res.unsupportedExtras : [];
  if (lost.length) {
    return { text: `字发出去了，但${what}没出去 —— 这一轮在 ${res.channel || '别的渠道'}，只有 Telegram 带得了。`
      + '她看到的只是这句话，要选项就直接在字里列出来。', data: res };
  }
  return { text: '发出去了。', data: res };
}

function makeTools({ askGate = defaultAskGate } = {}) {
  const buttons = {
    name: 'tg_buttons',
    description: 'Telegram only: say something to her with tappable option buttons under it — '
      + 'for when you want her to pick (吃火锅还是烧烤). When she taps one you get it back as her message: '
      + '"（点了按钮）<option>". Keep options short. On other channels the text still goes out but the buttons '
      + "can't, and you'll be told.",
    inputSchema: {
      type: 'object',
      required: ['text', 'options'],
      properties: {
        text: { type: 'string', description: 'What you say above the buttons, verbatim.' },
        options: { type: 'array', items: { type: 'string' }, description: '2 to 8 short options, one button each.' },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const text = String(args.text || '').trim();
      if (!text) throw new Error('要给 text（按钮上面那句话）');
      const opts = [...new Set((Array.isArray(args.options) ? args.options : [])
        .map((o) => String(o ?? '').trim()).filter(Boolean))];
      if (opts.length < 2 || opts.length > 8) throw new Error(`选项要 2～8 个（去重去空之后是 ${opts.length} 个）`);
      const keys = opts.map((o) => clipBytes(o));
      if (new Set(keys).size !== keys.length) throw new Error('有两个选项太长、截短后撞成一样了 —— 写短一点，让每个开头就不一样');
      const inline_keyboard = opts.map((o, i) => ({ text: o, callback_data: keys[i] }));
      return explain(await askGate({ tool: 'reply', text, args: { inline_keyboard } }), '按钮');
    },
  };

  const replyTo = {
    name: 'tg_reply_to',
    description: 'Telegram only: reply to one specific message of hers, so your answer shows quoted under it — '
      + 'for when she sent several things and you are answering an earlier one. '
      + 'Use the message_id from her message tag. On other channels the text still goes out, unquoted.',
    inputSchema: {
      type: 'object',
      required: ['text', 'message_id'],
      properties: {
        text: { type: 'string', description: 'What you say, verbatim.' },
        message_id: { type: 'string', description: "Her message's id (message_id in her message tag)." },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const text = String(args.text || '').trim();
      if (!text) throw new Error('要给 text');
      const id = String(args.message_id ?? '').trim();
      // 只认纯数字：按钮点击那种「99-btn-xxx」不是 TG 的真消息号，回不了
      if (!/^\d+$/.test(id)) throw new Error(`message_id 要是她那条消息的数字编号，「${id}」不是`);
      return explain(await askGate({ tool: 'reply', text, args: { reply_to_message_id: Number(id) } }), '引用');
    },
  };

  return [buttons, replyTo];
}

module.exports = { makeTools, clipBytes };
