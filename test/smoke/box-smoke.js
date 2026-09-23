'use strict';
// Smoke test: real CLI + real box (makeClaudeCodeBox) + adapter, isolated directory, haiku.
// Not part of `npm test` (it calls the real model). Usage: start a test im-cli host with
// AGENT_CLI_SOCKET pointing into an isolated directory, then
//   AGENT_CLI_SOCKET=... GATE_ROOT=... node test/smoke/box-smoke.js
// Never point it at a production socket/session.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { makeClaudeCodeBox } = require('../../src/host/gate-box-claudecode');
const { makeEnvelope } = require('../../src/gate/envelope');
const { createImBridgeRuntimeAdapter } = require('../../adapters/box-runtime');
if (!process.env.AGENT_CLI_SOCKET) { console.error('Start a test im-cli host first and set AGENT_CLI_SOCKET to its socket (never a production one).'); process.exit(2); }

const ROOT = process.env.SMOKE_ROOT || path.join(require('node:os').tmpdir(), 'imb-smoke');
fs.rmSync(ROOT, { recursive: true, force: true });
const ws = path.join(ROOT, 'ws');
const state = path.join(ROOT, 'state');
fs.mkdirSync(ws, { recursive: true }); fs.mkdirSync(state, { recursive: true });
fs.writeFileSync(path.join(ws, 'CLAUDE.md'), '# 项目说明\n本项目的暗号是：蓝鲸。有人问暗号就回答蓝鲸。\n');
const sp = path.join(ROOT, 'system.md');
fs.writeFileSync(sp, '你的名字叫阿七。回答一律用中文，简短。\n');
// 32x32 red PNG
const png = path.join(ROOT, 'red.png');
execFileSync('python3', ['-c', `
import zlib,struct
def ch(t,d): return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
raw=b''.join(b'\\x00'+b'\\xff\\x00\\x00'*32 for _ in range(32))
open('${png}','wb').write(b'\\x89PNG\\r\\n\\x1a\\n'+ch(b'IHDR',struct.pack('>IIBBBBB',32,32,8,2,0,0,0))+ch(b'IDAT',zlib.compress(raw))+ch(b'IEND',b''))`]);

const pingCfg = path.join(ROOT, 'ping-mcp.json');
fs.writeFileSync(pingCfg, JSON.stringify({ mcpServers: { ping: { command: process.execPath, args: [path.join(__dirname, 'ping-mcp.js')] } } }));
const bindingKey = 'smoke:binding';
const cfg = () => ({
  stateDir: state, sessionsFile: path.join(state, 'sessions.json'),
  conversationSourceFile: path.join(ROOT, 'cold.jsonl'), sessionHandoffStateFile: path.join(state, 'handoff.json'),
  enableSessionHandoff: false, disableOpeningPack: true, claudeCommand: 'claude',
  claudeModel: 'claude-haiku-4-5-20251001', claudeConfigDir: '',
  claudeExtraArgs: ['--system-prompt-file', sp, '--fallback-model', 'claude-sonnet-4-5', '--mcp-config', pingCfg],
  claudePermissionMode: 'acceptEdits', claudeDisableVerbose: false,
});
process.env.GATE_CLAUDE_PARTIAL = 'on';

function build() {
  const runtime = createImBridgeRuntimeAdapter(cfg());
  const box = makeClaudeCodeBox({ runtime, bindingKey, workspaceRoot: ws, model: 'claude-haiku-4-5-20251001',
    log: (m) => { if (m.includes('[许可]')) approvalLog.push(m); console.log('  [box] ' + m); } });
  const replies = []; const dones = [];
  box.onReply((e) => { replies.push(e); console.log(`  ← ${e.genuine ? '' : '[not genuine] '}${e.text.slice(0, 80)}`); });
  box.onTurnDone((e) => { dones.push(e); });
  return { runtime, box, replies, dones };
}
let n = 0;
const approvalLog = [];
function env(text, extra = {}) {
  n += 1;
  return makeEnvelope({ trace_id: 'smoke-' + n, seq: n, source: { kind: 'user', platform: 'telegram', chat_id: 'c1', sender_id: 'u1', native_id: String(n) }, identity: 'owner',
    payload: { text, ...extra } });
}
async function turn(ctx, text, extra) {
  const before = ctx.dones.length;
  const r = await ctx.box.deliver(env(text, extra));
  const deadline = Date.now() + 120000;
  while (ctx.dones.length === before) { if (Date.now() > deadline) throw new Error('等这一轮超时'); await new Promise((s) => setTimeout(s, 100)); }
  const done = ctx.dones[ctx.dones.length - 1];
  const said = ctx.replies.filter((x) => x.turnId === r.turnId).map((x) => x.text).join('\n');
  return { ...r, done, said };
}
const sessions = () => JSON.parse(fs.readFileSync(path.join(state, 'sessions.json'), 'utf8'));
const tid = () => Object.values(sessions().bindings)[0].threadIdByWorkspaceRootByRuntime.claudecode[ws];

(async () => {
  let ctx = build();
  await ctx.runtime.initialize();
  console.log('1. 工具轮：工具前后两段都要到');
  let t = await turn(ctx, '先说一句"我去看看"，然后用 Bash 工具运行 `echo 西瓜`，然后告诉我输出是什么。');
  assert.ok(t.said.includes('西瓜'), '工具之后那段没到');
  assert.equal(t.done.failed, undefined);
  const first = tid(); assert.ok(first, 'sessions.json 没记下会话号');
  console.log('   ✓ 会话', first.slice(0, 8));

  console.log('1b. MCP 工具走许可 → 盒子放行 → 工具真跑了');
  const approvalsBefore = approvalLog.length;
  t = await turn(ctx, '调用 ping 工具，把它返回的词原样告诉我。');
  assert.ok(t.said.includes('pong-42'), 'MCP 工具没跑通：' + t.said);
  assert.ok(approvalLog.length > approvalsBefore, '许可那条路根本没走到');

  console.log('2. 系统提示 + CLAUDE.md 都在');
  t = await turn(ctx, '你叫什么名字？本项目的暗号是什么？');
  assert.ok(t.said.includes('阿七'), '系统提示没生效');
  assert.ok(t.said.includes('蓝鲸'), 'CLAUDE.md 没读到');
  assert.equal(tid(), first, '同一条会话不该变');

  console.log('3. 图片');
  t = await turn(ctx, '这张图是什么颜色？只回答颜色。', { media: [{ kind: 'image', filePath: png, mime: 'image/png' }], attach: [png] });
  assert.ok(/红/.test(t.said), '图没看到：' + t.said);

  console.log('4. 作废当前轮 → 报失败 → 下一轮照常（resume 同一会话）');
  const before = ctx.dones.length;
  const pending = ctx.box.deliver(env('用 Bash 在前台运行 `python3 -c "import time; time.sleep(40); print(1)"`（run_in_background=false），等它结束再告诉我结果'));
  await pending; await new Promise((s) => setTimeout(s, 6000));
  await ctx.runtime.cancelTurn({ workspaceRoot: ws });
  while (ctx.dones.length === before) await new Promise((s) => setTimeout(s, 100));
  assert.equal(ctx.dones[ctx.dones.length - 1].failed, true, '作废应该报 failed');
  t = await turn(ctx, '我第一句让你运行的命令输出了什么水果？');
  assert.ok(t.said.includes('西瓜'), '作废后 resume 丢了记忆');
  assert.equal(tid(), first);

  console.log('5. 盒子重启（新适配实例）→ 从 sessions.json 接回同一会话');
  await ctx.runtime.close();
  ctx = build(); await ctx.runtime.initialize();
  t = await turn(ctx, '我第一句让你运行的命令输出了什么水果？');
  assert.ok(t.said.includes('西瓜'), '重启后没接上');
  assert.equal(tid(), first);

  console.log('6. 换舱 → 新会话、不记得');
  await ctx.box.rotate({ reason: 'smoke' });
  t = await turn(ctx, '你记得我让你运行过什么命令吗？没有就说"不记得"。');
  assert.notEqual(tid(), first, '换舱后会话号没变');

  const ingress = JSON.parse(fs.readFileSync(path.join(state, 'im-bridge-ingress.json'), 'utf8'));
  console.log('   ingress:', ingress.records.map((r) => r.state).join(','));
  await ctx.runtime.close();
  console.log('\n全部通过 ✓');
  process.exit(0);
})().catch((e) => { console.error('\n✗ 失败：', e.message); process.exit(1); });
