#!/usr/bin/env node
'use strict';

/**
 * codex 起 MCP 子进程用的小跳板（2026-10-21）。
 *
 * 为什么：codex **不透传环境**给 MCP 子进程（8-02 花园那次的真因），而 `-c mcp_servers.X.env.K=V`
 * 会把钥匙写进 app-server 的命令行（ps 谁都看得见）。所以：
 *   · codex-appserver 把这一包的 env 打成 base64 JSON 放进 app-server 自己的环境（IMB_MCP_<包>）
 *   · `-c mcp_servers.X.env_vars=["IMB_MCP_<包>"]` 让 codex 只透传这一个变量
 *   · codex 起的是这个跳板：解出 env，跟自己的环境合起来，exec 真正那个包
 *
 * 用法：node codex-mcp-launch.js <变量名> <命令> [参数...]
 * stdio 直通；真包退出码原样带出；收到信号转给它。
 */

const { spawn } = require('node:child_process');

const [varName, command, ...args] = process.argv.slice(2);
if (!varName || !command) {
  process.stderr.write('[codex-mcp-launch] 用法：codex-mcp-launch.js <变量名> <命令> [参数...]\n');
  process.exit(2);
}

let extra = {};
const raw = process.env[varName];
if (raw) {
  try { extra = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) || {}; }
  catch (e) { process.stderr.write(`[codex-mcp-launch] ${varName} 解不开：${e.message}\n`); process.exit(2); }
}
const env = { ...process.env, ...extra };
delete env[varName];

const child = spawn(command, args, { env, stdio: 'inherit' });
child.on('error', (e) => { process.stderr.write(`[codex-mcp-launch] 起不来 ${command}：${e.message}\n`); process.exit(127); });
child.on('exit', (code, signal) => {
  if (signal) { process.kill(process.pid, signal); return; }
  process.exit(code ?? 0);
});
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => { try { child.kill(sig); } catch { /* 已经停了 */ } });
}
