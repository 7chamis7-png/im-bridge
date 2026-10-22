'use strict';

/**
 * 要发东西给她？**交给桥发，工具自己绝不直连平台。**
 *
 * 桥（nova-gate）开着一个工具口（unix socket），它按这一轮的来路选渠道、走出闸、
 * 记冷层和出站账本。工具自己直连 TG/微信发 = 渠道靠猜 + 冷层记不到 + 一换舱就失忆
 * （老 nova_tools 的毛病，新桥就是为治这个才写的）。
 *
 * 桥认的工具名（src/gate/tools/*.js 里的 name）：
 *   reply · react · send_file · send_image · send_sticker · send_voice · call · hang_up
 * 形状跟 im_bridge 那包壳一模一样：{ id, tool, text, channel?, args }，一次一连。
 *
 * GATE_TOOL_SOCKET **必须给**（2026-10-21 起没有默认值）：原来默认 /root/.nova-gate/tools.sock，
 * 别人接进来忘了配就会从Nova的桥发出去。没给 = 这次调用直接报错。测试一律给假 socket。
 */

const net = require('node:net');

// 2026-10-21 去掉默认值（见上）。名字留着给老引用，值是空的。
const DEFAULT_SOCKET = '';

function askGate({ tool, text = '', channel = '', args = {} },
  { socket = process.env.GATE_TOOL_SOCKET || DEFAULT_SOCKET, timeoutMs = 120_000 } = {}) {
  if (!socket) {
    return Promise.resolve({ ok: false, error: '没配 GATE_TOOL_SOCKET：不知道该交给哪座桥发（不再默认Nova那座）' });
  }
  return new Promise((resolve) => {
    const conn = net.createConnection(socket);
    let buf = '';
    let done = false;
    const finish = (res) => { if (done) return; done = true; clearTimeout(timer); try { conn.end(); } catch { /* 已断 */ } resolve(res); };
    const timer = setTimeout(() => finish({ ok: false, error: `桥没回（等了 ${Math.round(timeoutMs / 1000)} 秒）` }), timeoutMs);
    conn.on('connect', () => conn.write(JSON.stringify({
      id: `pkg-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      tool, text: String(text ?? ''), ...(channel ? { channel: String(channel) } : {}), args,
    }) + '\n'));
    conn.on('data', (c) => {
      buf += c.toString('utf8');
      const i = buf.indexOf('\n');
      if (i < 0) return;
      try { finish(JSON.parse(buf.slice(0, i))); }
      catch (e) { finish({ ok: false, error: `桥回的不是 JSON：${e.message}` }); }
    });
    conn.on('error', (e) => finish({ ok: false, error: `连不上桥：${e.message}` }));
  });
}

module.exports = { askGate, DEFAULT_SOCKET };
