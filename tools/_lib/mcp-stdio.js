'use strict';

/**
 * Shared MCP stdio shell for tool packages. One process per package, so a
 * broken package never affects the others.
 *
 * A tool looks like:
 *   { name, description, inputSchema, handler: async (args) => ({ text, data }) | string }
 *
 * Result text format: `text` + newline + JSON `data`. A thrown error becomes
 * isError:true with the error message.
 *
 * Logs go to stderr only: stdout is the protocol channel.
 */

function formatResult(result) {
  if (!result || typeof result !== 'object') return String(result ?? '');
  if (result.text && result.data !== undefined) return `${result.text}\n${JSON.stringify(result.data, null, 2)}`;
  if (result.text) return String(result.text);
  return JSON.stringify(result, null, 2);
}

/**
 * Public tool name / description hooks. Identity by default; kept as seams so a
 * package can strip a legacy prefix from what the agent sees.
 */
const PUBLIC = (n) => String(n);
const publicText = (t) => String(t || '');

function serve({ name, version = '1.0.0', tools, input = process.stdin, output = process.stdout }) {
  const log = (m) => { try { process.stderr.write(`[${name}] ${m}\n`); } catch { /* ignore */ } };
  const byName = new Map(tools.map((t) => [PUBLIC(t.name), t]));
  const write = (msg) => output.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

  async function handle(req) {
    if (req.method === 'initialize') {
      return write({ id: req.id, result: { protocolVersion: req.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} }, serverInfo: { name, version } } });
    }
    if (req.method === 'tools/list') {
      return write({ id: req.id, result: { tools: tools.map((t) => ({ name: PUBLIC(t.name), description: publicText(t.description),
        inputSchema: t.inputSchema || { type: 'object', properties: {} } })) } });
    }
    if (req.method === 'tools/call') {
      // normalize the incoming name the same way before lookup
      const tool = byName.get(PUBLIC(req.params?.name));
      if (!tool) {
        return write({ id: req.id, result: { isError: true, content: [{ type: 'text',
          text: `没有这个工具：${req.params?.name}；这一包有 ${[...byName.keys()].join(' / ')}` }] } });
      }
      const args = req.params?.arguments && typeof req.params.arguments === 'object' ? req.params.arguments : {};
      try {
        const result = await tool.handler(args);
        return write({ id: req.id, result: { content: [{ type: 'text', text: formatResult(result) }] } });
      } catch (e) {
        log(`${tool.name} 失败：${e?.message || e}`);
        return write({ id: req.id, result: { isError: true, content: [{ type: 'text', text: String(e?.message || e) }] } });
      }
    }
    if (req.method === 'ping') return write({ id: req.id, result: {} });
    if (req.id != null) return write({ id: req.id, error: { code: -32601, message: `不认识这个方法：${req.method}` } });
    return undefined; // notifications/* need no reply
  }

  let buf = '';
  input.setEncoding?.('utf8');
  input.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let req;
      try { req = JSON.parse(line); } catch { continue; }
      handle(req).catch((e) => {
        if (req.id != null) write({ id: req.id, error: { code: -32603, message: String(e?.message || e) } });
      });
    }
  });
  log(`装上 ${tools.length} 个工具：${tools.map((t) => PUBLIC(t.name)).join(' ')}`);
  return { log };
}

module.exports = { serve, formatResult, PUBLIC, publicText };
