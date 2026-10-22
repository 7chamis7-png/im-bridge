'use strict';

/**
 * Nova的盒子（pm2: nova-box）—— 他住的那个进程的入口。
 *
 * 2026-09-20 搬家：桥/盒子/心跳/心脏全部从 /root/cyberboss 搬进 im-bridge（`../src/`），
 * 这儿不再 require 任何 cyberboss 的东西。Alice：「拿掉 拿掉懂吗 我要我的桥干干净净的都是我的东西」。
 *
 * 这个文件只干一件事：把 BOXES.claudecode 的 runtime 工厂换成 im_bridge 的运行时
 * （官方 SDK），其余（socket、记账本、人格、forge）还是盒子自己那套。
 */

const main = require('../src/host/main');
const { createImBridgeRuntimeAdapter } = require('../adapters/box-runtime');

main.BOXES.claudecode = {
  ...main.BOXES.claudecode,
  runtime: (cfg) => createImBridgeRuntimeAdapter(cfg),
};
console.log('[im-bridge] 盒子的 CLI 层走 im_bridge 新运行时（官方 SDK）');

require('../src/host/box-host').main()
  .catch((e) => { console.error('[盒子] 起不来：', e); process.exit(1); });
