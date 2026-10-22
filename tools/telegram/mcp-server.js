#!/usr/bin/env node
'use strict';
// TG 专用包的 MCP 入口。发送一律交给桥（GATE_TOOL_SOCKET，必须给；2026-10-21 起没有默认）。
const { serve } = require('../_lib/mcp-stdio');
const { makeTools } = require('./tools');

serve({ name: 'telegram', tools: makeTools() });
