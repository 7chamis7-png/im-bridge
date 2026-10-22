#!/usr/bin/env node
'use strict';

/**
 * 「日常」这一包的 MCP 入口（2026-09-20）：nova_browse + nova_reminder_create。
 *
 * 替掉老 `node /root/cyberboss/bin/cyberboss.js tool-mcp-server` 里的这两个。
 * 不 require 任何 /root/cyberboss 的东西；配置全走 env（见 config.js），每次调用现读。
 *
 * ⚠️ 老的那个进程启动时会自己 dotenv 读 /root/cyberboss/.env；这一包**不读任何 .env**，
 * 要的变量由接线的人从盒子的环境里带进来（nova-env.sh 已经 source 了那份 .env）。
 * 都没带也能跑：路径有生产默认值，账号/收件人会退到「accounts/ 里唯一那个」，结果相同。
 */

const { serve } = require('../_lib/mcp-stdio');
const { loadConfig } = require('./config');
const { createTools } = require('./tools');

serve({ name: 'daily', tools: createTools(() => loadConfig(process.env)) });
