#!/usr/bin/env node
'use strict';
// Minimal stdio MCP server: one `ping` tool returning pong-42. Used by the smoke test to exercise tool permission.
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion,
    capabilities: { tools: {} }, serverInfo: { name: 'ping', version: '1' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'ping',
    description: 'Returns a secret word', inputSchema: { type: 'object', properties: {} } }] } });
  else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'pong-42' }] } });
  else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
});
