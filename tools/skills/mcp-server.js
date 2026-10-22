#!/usr/bin/env node
'use strict';
// 技能包的 MCP 入口。技能目录从 SKILLS_DIRS 来（冒号分隔，人格配置渲染出来的；没有默认值）。
const { serve } = require('../_lib/mcp-stdio');
const { makeTools, splitDirs } = require('./tools');

if (!splitDirs(process.env.SKILLS_DIRS).length) {
  process.stderr.write('[skills] 没有 SKILLS_DIRS —— 不猜技能放在哪，停。\n');
  process.exit(1);
}
serve({ name: 'skills', tools: makeTools() });
