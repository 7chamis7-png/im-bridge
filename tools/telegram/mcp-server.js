#!/usr/bin/env node
'use strict';
// MCP entry point for the Telegram-only tool package. Delivery always goes through the bridge
// (GATE_TOOL_SOCKET, default $IM_BRIDGE_HOME/gate/tools.sock).
const { serve } = require('../_lib/mcp-stdio');
const { makeTools } = require('./tools');

serve({ name: 'telegram', tools: makeTools() });
