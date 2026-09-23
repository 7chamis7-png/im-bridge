'use strict';

/**
 * Telegram-only tool package: ways of speaking that only Telegram supports.
 *
 *   · generic layer  = the bridge's reply / send_image / send_voice ... (every channel)
 *   · specific layer = this package: option buttons, reply-to-a-message. Prefixed tg_.
 *
 * Delivery still goes through the bridge (askGate -> reply) with channel-specific
 * extras, so the cold log and ledger stay complete and the channel follows the
 * turn. If this turn is not on Telegram, the bridge sends the text and reports
 * the dropped extras; that is passed back to the agent verbatim.
 *
 * When the user taps a button, the Telegram leg turns the callback into a user
 * message "（点了按钮）<option>" for the agent.
 */

const { askGate: defaultAskGate } = require('../_lib/gate');

/** Telegram callback_data is limited to 64 bytes (UTF-8 bytes, not characters). */
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
    throw new Error(`没发出去：${(res && (res.error || res.reason)) || '桥没给原因'}。对方什么也没收到。`);
  }
  const lost = Array.isArray(res.unsupportedExtras) ? res.unsupportedExtras : [];
  if (lost.length) {
    return { text: `字发出去了，但${what}没出去 —— 这一轮在 ${res.channel || '别的渠道'}，只有 Telegram 带得了。`
      + '对方只看到这句话，要选项就直接在字里列出来。', data: res };
  }
  return { text: '发出去了。', data: res };
}

function makeTools({ askGate = defaultAskGate } = {}) {
  const buttons = {
    name: 'tg_buttons',
    description: 'Telegram only: say something to the user with tappable option buttons under it — '
      + 'for when you want the user to pick one. When the user taps one you get it back as a user message: '
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
    description: 'Telegram only: reply to one specific message from the user, so your answer shows quoted under it — '
      + 'for when the user sent several things and you are answering an earlier one. '
      + "Use the message_id from the user's message tag. On other channels the text still goes out, unquoted.",
    inputSchema: {
      type: 'object',
      required: ['text', 'message_id'],
      properties: {
        text: { type: 'string', description: 'What you say, verbatim.' },
        message_id: { type: 'string', description: "The user's message id (message_id in the message tag)." },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const text = String(args.text || '').trim();
      if (!text) throw new Error('要给 text');
      const id = String(args.message_id ?? '').trim();
      // digits only: button-press ids like "99-btn-xxx" are not real Telegram message ids
      if (!/^\d+$/.test(id)) throw new Error(`message_id 要是那条消息的数字编号，「${id}」不是`);
      return explain(await askGate({ tool: 'reply', text, args: { reply_to_message_id: Number(id) } }), '引用');
    },
  };

  return [buttons, replyTo];
}

module.exports = { makeTools, clipBytes };
