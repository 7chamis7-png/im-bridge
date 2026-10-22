#!/usr/bin/env node
'use strict';

/**
 * 他的本子们（2026-09-20）—— 日记 / 老冷层原话 / 关系栏 / 小黑屋 / 纸条 / 自己的状态。
 *
 * 从老 nova_tools 里搬出来的 10 个工具，纯本地读写文件：**不连桥、不连网、不认识渠道**，
 * 这一包里没有任何东西要发给她。数据跟老代码是同一批文件、同一个格式，新旧可以随时互换。
 *
 * 用法：node /root/im-bridge/tools/notebooks/mcp-server.js
 *   NOVA_STATE_DIR   必须给（2026-10-21 起没有默认；Nova = /root/.nova）
 *   SELF_LIFE_NOTES_DIR   默认 <家>/notes
 *   MEMORY_SOURCES_FILE   原话搜索读哪份（没给 = 原话搜索报错；Nova = /root/.nova-gate/cold.jsonl）
 *   （详见 config.js；不需要任何密钥）
 */

const { serve } = require('../_lib/mcp-stdio');
const { loadConfig } = require('./config');
const { createTools } = require('./tools');

let cfg;
try { cfg = loadConfig(); }
catch (e) { process.stderr.write(`[notebooks] 起不来：${e.message}\n`); process.exit(78); }
const { log } = serve({ name: 'notebooks', tools: createTools(cfg) });
log(`家目录 ${cfg.stateDir} · 纸条 ${cfg.notesDir}`);
