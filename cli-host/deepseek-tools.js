'use strict';

/**
 * DeepSeek 这一块能用的工具。
 *
 * 桥和盒子不动。它们本来就会把 MCP 清单递进 sdkOptions.mcpServers，
 * Claude 那一块还会自己读工作目录的 .mcp.json。这里两份都认。
 * 盒子没来得及递清单时，读 DEEPSEEK_MCP_FILE（桥写的那份）。
 *
 * Read / Edit / Write / Bash 是 Claude 自己的，不在 MCP 里。
 * 提示词让他用这四个，所以这一块也有。调用前的许可由运行时去问盒子。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const START_MS = 15_000;
const CALL_MS = 120_000;
const RESULT_CHARS = 16_000;

function clip(text, max = RESULT_CHARS) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…（后面还有 ${s.length - max} 字，截掉了）`;
}

function readMcpFile(file) {
  if (!file) return {};
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    const servers = json && json.mcpServers;
    return servers && typeof servers === 'object' ? servers : {};
  } catch {
    return {};
  }
}

function collectServers({ cwd = '', sdkServers = null, mcpFile = '' } = {}) {
  const servers = {};
  if (cwd) Object.assign(servers, readMcpFile(path.join(cwd, '.mcp.json')));
  if (mcpFile) Object.assign(servers, readMcpFile(mcpFile));
  if (sdkServers && typeof sdkServers === 'object') Object.assign(servers, sdkServers);
  return servers;
}

function publicName(server, name) {
  const raw = `mcp__${server}__${name}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  return raw.length <= 64 ? raw : raw.slice(0, 64);
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超过 ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function takeFrames(buffer) {
  const frames = [];
  let buf = buffer;
  while (buf.length) {
    if (/^content-length:/i.test(buf)) {
      const sep = buf.indexOf('\r\n\r\n');
      if (sep < 0) break;
      const match = buf.slice(0, sep).match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        const nl = buf.indexOf('\n');
        if (nl < 0) break;
        buf = buf.slice(nl + 1);
        continue;
      }
      const start = sep + 4;
      const len = Number(match[1]);
      if (buf.length < start + len) break;
      frames.push(buf.slice(start, start + len));
      buf = buf.slice(start + len);
      continue;
    }
    const nl = buf.indexOf('\n');
    if (nl < 0) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) frames.push(line);
  }
  return { frames, buf };
}

function toolText(result) {
  if (!result || typeof result !== 'object') return clip(result);
  const blocks = Array.isArray(result.content) ? result.content : [];
  const text = blocks.map((block) => (typeof block?.text === 'string' ? block.text : '')).filter(Boolean).join('\n');
  const body = text || (result.isError ? '工具没做成。' : '');
  return clip(result.isError && body ? `没做成：${body}` : (body || '（工具没有返回文字）'));
}

function parseRpcBody(raw, contentType) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (String(contentType || '').includes('text/event-stream') || text.startsWith('event:') || text.startsWith('data:')) {
    const data = text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter((line) => line && line !== '[DONE]');
    const last = data[data.length - 1];
    if (!last) return null;
    return JSON.parse(last);
  }
  return JSON.parse(text);
}

class StdioMcp {
  constructor(name, spec, spawnImpl = spawn) {
    this.name = name;
    this.spec = spec;
    this.spawnImpl = spawnImpl;
    this.child = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
  }

  start() {
    const spec = this.spec;
    const env = { ...process.env, ...(spec.env && typeof spec.env === 'object' ? spec.env : {}) };
    const child = this.spawnImpl(spec.command, Array.isArray(spec.args) ? spec.args.map(String) : [], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.ingest(chunk));
    child.stderr.on('data', (chunk) => {
      const line = String(chunk).trim().split('\n')[0];
      if (line) console.error(`[nova-deepseek/mcp] ${this.name}: ${line.slice(0, 180)}`);
    });
    child.on('error', (error) => this.failAll(error));
    child.on('close', () => this.failAll(new Error(`${this.name} 退出了`)));
  }

  ingest(chunk) {
    this.buf += chunk;
    const taken = takeFrames(this.buf);
    this.buf = taken.buf;
    for (const frame of taken.frames) {
      let msg;
      try { msg = JSON.parse(frame); } catch { continue; }
      if (msg.id == null) continue;
      const waiter = this.pending.get(msg.id);
      if (!waiter) continue;
      this.pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.error) waiter.reject(new Error(msg.error.message || 'MCP 错误'));
      else waiter.resolve(msg.result);
    }
  }

  failAll(error) {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  request(method, params, ms) {
    if (!this.child || !this.child.stdin.writable) return Promise.reject(new Error(`${this.name} 没在跑`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name} ${method} 超过 ${ms}ms`));
      }, ms);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method, params) {
    if (!this.child || !this.child.stdin.writable) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async list() {
    this.start();
    await withTimeout(
      this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'nova-deepseek', version: '1' },
      }, START_MS),
      START_MS,
      `${this.name} 握手`,
    );
    this.notify('notifications/initialized', {});
    const result = await this.request('tools/list', {}, START_MS);
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async call(name, args) {
    const result = await this.request('tools/call', { name, arguments: args || {} }, CALL_MS);
    return toolText(result);
  }

  close() {
    try { this.child?.kill('SIGTERM'); } catch { /* 已经停了 */ }
  }
}

class HttpMcp {
  constructor(name, spec, fetchImpl) {
    this.name = name;
    this.spec = spec;
    this.fetchImpl = fetchImpl;
    this.session = '';
    this.nextId = 1;
  }

  async rpc(method, params, ms) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.spec.headers && typeof this.spec.headers === 'object' ? this.spec.headers : {}),
    };
    if (this.session) headers['mcp-session-id'] = this.session;
    const id = method.startsWith('notifications/') ? undefined : this.nextId++;
    const body = { jsonrpc: '2.0', method, params };
    if (id != null) body.id = id;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      const response = await this.fetchImpl(this.spec.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const sid = response.headers?.get?.('mcp-session-id');
      if (sid) this.session = sid;
      const raw = await response.text();
      if (!response.ok) throw new Error(`${this.name} HTTP ${response.status}`);
      if (id == null) return null;
      const msg = parseRpcBody(raw, response.headers?.get?.('content-type'));
      if (!msg) throw new Error(`${this.name} 没有回包`);
      if (msg.error) throw new Error(msg.error.message || 'MCP 错误');
      return msg.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async list() {
    await this.rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'nova-deepseek', version: '1' },
    }, START_MS);
    await this.rpc('notifications/initialized', {}, START_MS).catch(() => {});
    const result = await this.rpc('tools/list', {}, START_MS);
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async call(name, args) {
    const result = await this.rpc('tools/call', { name, arguments: args || {} }, CALL_MS);
    return toolText(result);
  }

  close() {}
}

function resolvePath(cwd, file) {
  const raw = String(file || '').trim();
  if (!raw) throw new Error('没有路径。');
  return path.resolve(cwd || process.cwd(), raw);
}

function localTools(cwd) {
  return [
    {
      name: 'Read',
      description: '读取一个文件的文字。路径可以是绝对路径，或相对工作目录。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      call(args) {
        const file = resolvePath(cwd, args.path);
        const stat = fs.statSync(file);
        if (stat.size > 200_000) return `文件太大（${stat.size} 字节），没整篇读。`;
        return clip(fs.readFileSync(file, 'utf8'));
      },
    },
    {
      name: 'Write',
      description: '把整个文件写成给定内容。目录不存在会先建。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
      call(args) {
        const file = resolvePath(cwd, args.path);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, String(args.content ?? ''));
        return `写好了 ${file}`;
      },
    },
    {
      name: 'Edit',
      description: '把文件里唯一的一段原文换成新的。原文必须完整出现一次。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
      call(args) {
        const file = resolvePath(cwd, args.path);
        const old = String(args.old_string ?? '');
        if (!old) throw new Error('old_string 是空的。');
        const text = fs.readFileSync(file, 'utf8');
        const at = text.indexOf(old);
        if (at < 0) throw new Error('原文不在文件里。');
        if (text.indexOf(old, at + old.length) >= 0) throw new Error('原文出现了不止一次，没改。');
        fs.writeFileSync(file, text.slice(0, at) + String(args.new_string ?? '') + text.slice(at + old.length));
        return `改好了 ${file}`;
      },
    },
    {
      name: 'Bash',
      description: '在工作目录里跑一条命令。能用 Read、Edit、Write 就别用这个。',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
      call(args) {
        const command = String(args.command || '').trim();
        if (!command) throw new Error('没有命令。');
        return new Promise((resolve) => {
          let out = '';
          const child = spawn('bash', ['-lc', command], { cwd: cwd || process.cwd() });
          const take = (buf) => {
            if (out.length < RESULT_CHARS) out += buf.toString('utf8');
          };
          const timer = setTimeout(() => {
            try { child.kill('SIGTERM'); } catch { /* 已经停了 */ }
          }, CALL_MS);
          child.stdout.on('data', take);
          child.stderr.on('data', take);
          child.on('error', (error) => { clearTimeout(timer); resolve(`没跑起来：${error.message}`); });
          child.on('close', (code) => {
            clearTimeout(timer);
            resolve(clip(out.trim() || `（命令结束，退出码 ${code}）`));
          });
        });
      },
    },
  ];
}

function toOpenAI(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: clip(tool.description || tool.name, 500),
      parameters: tool.parameters || { type: 'object', properties: {} },
    },
  };
}

async function createToolBelt({
  cwd = '',
  sdkServers = null,
  mcpFile = '',
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
} = {}) {
  const byName = new Map();
  for (const tool of localTools(cwd)) byName.set(tool.name, tool);
  const clients = [];
  const failures = [];
  const servers = collectServers({ cwd, sdkServers, mcpFile });
  await Promise.all(Object.entries(servers).map(async ([name, spec]) => {
    if (!spec || typeof spec !== 'object') return;
    const client = spec.command
      ? new StdioMcp(name, spec, spawnImpl)
      : (spec.url ? new HttpMcp(name, spec, fetchImpl) : null);
    if (!client) {
      failures.push(`${name}：没有命令也没有地址`);
      return;
    }
    try {
      const tools = await client.list();
      clients.push(client);
      for (const tool of tools) {
        if (!tool || !tool.name) continue;
        const exposed = publicName(name, tool.name);
        byName.set(exposed, {
          name: exposed,
          description: tool.description || tool.name,
          parameters: tool.inputSchema || { type: 'object', properties: {} },
          call: (args) => client.call(tool.name, args),
        });
      }
    } catch (error) {
      try { client.close(); } catch { /* 起了一半 */ }
      failures.push(`${name}：${error.message || error}`);
    }
  }));

  return {
    openai() {
      return [...byName.values()].map(toOpenAI);
    },
    note() {
      return failures.length ? `这些工具包没连上，不要假装用过：${failures.join('；')}` : '';
    },
    async call(name, args) {
      const tool = byName.get(name);
      if (!tool) throw new Error(`没有这个工具：${name}`);
      return clip(await tool.call(args || {}));
    },
    async close() {
      for (const client of clients) {
        try { client.close(); } catch { /* 已经停了 */ }
      }
    },
  };
}

module.exports = {
  createToolBelt,
  collectServers,
  publicName,
  takeFrames,
  toolText,
};
