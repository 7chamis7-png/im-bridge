#!/usr/bin/env node
'use strict';

/**
 * 知乎发文的子进程入口。
 *
 * 为什么走子进程（老的也是）：不把 Playwright 和一个有头 Chromium 拖进 MCP 进程；
 * 卡死了父进程到点直接 SIGKILL，MCP 进程本身不受牵连。
 *
 * 用法：echo '{"title":"…","content":"…","topics":["原创小说"],"publish":false}' | node zhihu-post.js
 * 结果：stdout **最后一行**是一个 JSON（父进程只认最后一行）。
 */

const { loadConfig } = require('../lib/config');
const { runZhihuPost } = require('../lib/zhihu-flow');

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

(async () => {
  const args = await readStdin();
  const config = loadConfig();
  let chromium;
  try {
    ({ chromium } = require(config.playwrightModule));
  } catch (e) {
    return out({ ok: false, error: `加载不了 Playwright（${config.playwrightModule}）：${e.message}` });
  }
  out(await runZhihuPost(args, { chromium, profile: config.zhihuProfile }));
})().catch((e) => out({ ok: false, error: String((e && e.message) || e) }));
