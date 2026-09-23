'use strict';

/**
 * Tools that deliver something to the user must go through the bridge,
 * never directly to a platform.
 *
 * The bridge (im-gate) opens a tool socket (unix socket). It picks the channel
 * from the current turn, runs the outbound gate, and records the cold log and
 * outbound ledger. A tool that posts to Telegram/WeChat directly would have to
 * guess the channel and would leave no record.
 *
 * Tool names the bridge accepts (the `name` in src/gate/tools/*.js):
 *   reply · react · send_file · send_image · send_sticker · send_voice · call · hang_up
 * Request shape (same as the im_bridge MCP shell): { id, tool, text, channel?, args }, one connection per call.
 *
 * GATE_TOOL_SOCKET defaults to $IM_BRIDGE_HOME/gate/tools.sock; tests always pass a fake socket.
 */

const net = require('node:net');
const { homePath } = require('../../src/core/paths');

const DEFAULT_SOCKET = homePath('gate', 'tools.sock');

function askGate({ tool, text = '', channel = '', args = {} },
  { socket = process.env.GATE_TOOL_SOCKET || DEFAULT_SOCKET, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const conn = net.createConnection(socket);
    let buf = '';
    let done = false;
    const finish = (res) => { if (done) return; done = true; clearTimeout(timer); try { conn.end(); } catch { /* already closed */ } resolve(res); };
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
