'use strict';
// S0·CC：合成的工具对 + 图片块写进 transcript，--resume 后他认不认；顺手抓真实 SDK 帧做夹具。
// 隔离：CLAUDE_CONFIG_DIR=/tmp/s0/cc-config，cwd=/tmp/s0/cc-ws；凭据只走环境变量里的 access token（不拷 refresh token）。
// 用法：node cc-synth.js <variant: minimal|full> [--no-turn]
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const variant = process.argv[2] || 'minimal';
const noTurn = process.argv.includes('--no-turn');
const CFG = '/tmp/s0/cc-config';
const WS = '/tmp/s0/cc-ws';
fs.mkdirSync(WS, { recursive: true });
const slug = WS.replace(/[/.]/g, '-');
const dir = path.join(CFG, 'projects', slug);
fs.mkdirSync(dir, { recursive: true });
const sid = crypto.randomUUID();
const version = '2.1.292';
const ts = (i) => new Date(Date.now() - (60 - i) * 1000).toISOString();
const png = fs.readFileSync('/tmp/s0/data/red.png').toString('base64');
const TOOL_ID = 'toolu_01S0Synth' + crypto.randomBytes(6).toString('hex');

const rows = [];
let parent = null;
function push(type, message, extra = {}) {
  const row = { parentUuid: parent, isSidechain: false, type, message, uuid: crypto.randomUUID(), timestamp: ts(rows.length),
    userType: 'external', cwd: WS, sessionId: sid, version, ...extra };
  parent = row.uuid; rows.push(row); return row;
}
const asst = (content) => ({ model: 'claude-haiku-4-5-20251001', id: 'msg_synth_' + crypto.randomBytes(12).toString('hex'), type: 'message', role: 'assistant',
  content, stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });

push('user', { role: 'user', content: '我们做个小测试，你先跑个命令。' });
const a1 = push('assistant', { ...asst([{ type: 'tool_use', id: TOOL_ID, name: variant === 'ghost' ? 'mcp__ghost__lookup' : 'Bash', input: variant === 'ghost' ? { q: 'canary' } : { command: 'echo CANARY-TOOL-8812', description: 'echo canary' } }]), stop_reason: 'tool_use' });
push('user', { role: 'user', content: [{ tool_use_id: TOOL_ID, type: 'tool_result', content: 'CANARY-TOOL-8812', is_error: false }] },
  variant === 'full' ? { toolUseResult: { stdout: 'CANARY-TOOL-8812', stderr: '', interrupted: false, isImage: false }, sourceToolAssistantUUID: a1.uuid } : {});
push('assistant', asst([{ type: 'text', text: '命令跑完了。' }]));
push('user', { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }, { type: 'text', text: '这张图先放着，别评论。' }] });
push('assistant', asst([{ type: 'text', text: '好，图收到了。' }]));
const file = path.join(dir, sid + '.jsonl');
fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log('synth', variant, sid, rows.length, 'rows');
if (noTurn) process.exit(0);

const creds = JSON.parse(fs.readFileSync('/root/.claude/.credentials.json', 'utf8')).claudeAiOauth;
const env = { PATH: process.env.PATH, HOME: '/tmp/s0/home', CLAUDE_CONFIG_DIR: CFG, CLAUDE_CODE_OAUTH_TOKEN: creds.accessToken,
  DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };

(async () => {
  const { query } = await import('/root/im-bridge-next/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
  const frames = [];
  const q = query({ prompt: (variant === 'ghost' ? '' : '先用 Bash 跑一次 `echo S0-LIVE-OK`。跑完以后') + '回答三行，不要别的：第一行：更早那次工具调用输出的校验串；第二行：那张图片的主色（一个中文词）；第三行：那个校验串最早是出现在工具输出里还是出现在我打的消息里（只写「工具」或「消息」）。',
    options: { cwd: WS, env, resume: sid, model: 'haiku', pathToClaudeCodeExecutable: '/usr/local/bin/claude', allowedTools: ['Bash'],
      permissionMode: 'default', canUseTool: async (_n, input) => ({ behavior: 'allow', updatedInput: input }), settingSources: [] } });
  for await (const f of q) {
    frames.push(f);
    if (f.type === 'system' && f.subtype === 'init' && f.apiKeySource !== 'none') {
      console.error('apiKeySource=' + f.apiKeySource + ' —— 不是订阅，立刻停'); try { await q.interrupt(); } catch {} process.exit(2);
    }
  }
  fs.writeFileSync(`/tmp/s0/data/cc-frames-${variant}.jsonl`, frames.map((f) => JSON.stringify(f)).join('\n') + '\n');
  const result = frames.find((f) => f.type === 'result');
  console.log('frames', frames.length, frames.map((f) => f.type + (f.subtype ? ':' + f.subtype : '')).join(' '));
  console.log('RESULT', JSON.stringify({ subtype: result && result.subtype, is_error: result && result.is_error, text: result && result.result, session: result && result.session_id }));
  const after = fs.readFileSync(path.join(dir, (result && result.session_id || sid) + '.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  console.log('transcript after: rows', after.length, 'firstSynthKept', after.some((r) => r.uuid === rows[0].uuid), 'chainParentOfFirstNew',
    (after.find((r) => r.type === 'user' && typeof r.message?.content === 'string' && r.message.content.startsWith('先用 Bash')) || {}).parentUuid === rows[rows.length - 1].uuid);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
