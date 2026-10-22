'use strict';

/**
 * 工具包共用的 MCP 壳（2026-09-20）。每一包一个进程，坏一个不牵连别的。
 *
 * 一个工具长这样：
 *   { name, description, inputSchema, handler: async (args) => ({ text, data }) | string }
 *
 * 回给他的文字格式**照老 nova_tools 的**（`text` + 换行 + JSON 的 `data`），
 * 他读了几个月，别换个壳就换个说法。抛错 = isError:true + 错误原文。
 *
 * 日志只能走 stderr —— stdout 是协议通道，写一个字就把它搞坏。
 */

function formatResult(result) {
  if (!result || typeof result !== 'object') return String(result ?? '');
  if (result.text && result.data !== undefined) return `${result.text}\n${JSON.stringify(result.data, null, 2)}`;
  if (result.text) return String(result.text);
  return JSON.stringify(result, null, 2);
}

/**
 * 他看到的名字去掉老项目的 `cyberboss_` 前缀（2026-09-20，Alice：「为啥工具不改名字？」）。
 * 包名本身就是命名空间（mcp__daily__browse），前缀只是退役项目留下的尾巴。
 * **只改名字和说明**：工具返回的内容一个字不动（日记/记录里可能就有他写的这些词）。
 * 内部和测试照旧用老名字 —— 对照老实现的黄金测试靠它。
 */
const PUBLIC = (n) => String(n).replace(/^cyberboss_/, '');
const publicText = (t) => String(t || '').replace(/\bcyberboss_(?!tools\b)([a-z_]+)/g, '$1');

function serve({ name, version = '1.0.0', tools, input = process.stdin, output = process.stdout }) {
  const log = (m) => { try { process.stderr.write(`[${name}] ${m}\n`); } catch { /* 无所谓 */ } };
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
      // 老名字也认（改名当舱里他还可能照旧叫）：进来一律去前缀再查
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
    return undefined; // notifications/* 不用回
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
