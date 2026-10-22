'use strict';

// S2b 插头吐通用事件（设计稿 §2.1）：不再拼假 Claude 帧。盯住：
//   · codex 的工具 item（commandExecution / mcpToolCall）、reasoning 接出来成 tool.call / tool.result / reasoning
//   · 用量由插头算好 context；没有的项填 null 不填 0
//   · Claude 插头在宿主里翻（claudeToNeutral），IMB_CLAUDE_EVENTS=frames 回滚成原帧
//   · 每条都带 v / engine / turn，盒子按 turn 认归属

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { codexItemToNeutral, codexUsageEvent, openaiUsageEvent } = require('../../cli-host/neutral');
const { createCodexRuntime } = require('../../cli-host/codex-runtime');
const { createEngineFactories } = require('../../cli-host/engines');
const { decode } = require('../../runtime/decode');

const FAKE = path.join(__dirname, '..', 'gate', 'lib', 'fake-codex-appserver.js');
fs.chmodSync(FAKE, 0o755);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) { const t = Date.now() + ms; while (Date.now() < t) { if (await fn()) return true; await sleep(20); } return false; }

test('codex item → 通用事件：命令 / MCP（失败）/ reasoning；别的 item 不翻', () => {
  const cmd = codexItemToNeutral({ type: 'commandExecution', id: 'x1', command: 'ls', cwd: '/w', status: 'completed', aggregatedOutput: 'a\n', exitCode: 0 });
  assert.deepEqual(cmd.map((e) => e.kind), ['tool.call', 'tool.result']);
  assert.equal(cmd[0].name, 'shell'); assert.equal(cmd[0].args.command, 'ls');
  assert.equal(cmd[1].callId, 'x1'); assert.equal(cmd[1].isError, false); assert.equal(cmd[1].text, 'a\n');
  const bad = codexItemToNeutral({ type: 'commandExecution', id: 'x3', command: 'false', status: 'completed', exitCode: 1 });
  assert.equal(bad[1].isError, true, '退出码非 0 = 失败');
  const mcp = codexItemToNeutral({ type: 'mcpToolCall', id: 'x2', server: 'im_bridge', tool: 'reply', status: 'failed', arguments: { text: 'hi' }, error: { message: '渠道不在' } });
  assert.equal(mcp[0].name, 'mcp__im_bridge__reply'); assert.equal(mcp[0].server, 'im_bridge');
  assert.equal(mcp[1].isError, true); assert.equal(mcp[1].text, '渠道不在');
  const ok = codexItemToNeutral({ type: 'mcpToolCall', id: 'x4', server: 's', tool: 't', status: 'completed', arguments: {}, result: { content: [{ type: 'text', text: '好' }] } });
  assert.equal(ok[1].text, '好');
  const r = codexItemToNeutral({ type: 'reasoning', id: 'r1', summary: ['想'], content: [] });
  assert.equal(r[0].kind, 'reasoning'); assert.equal(r[0].opaque.engine, 'codex'); assert.deepEqual(r[0].opaque.summary, ['想']);
  assert.deepEqual(codexItemToNeutral({ type: 'agentMessage', id: 'm' }), []);
  assert.deepEqual(codexItemToNeutral({ type: 'userMessage', id: 'u' }), []);
});

test('用量：插头算好 context；没有的项填 null（不是 0）；只有累计数不报', () => {
  const c = codexUsageEvent({ last: { inputTokens: 55924, cachedInputTokens: 11264, outputTokens: 188 }, total: { inputTokens: 791233 } }, 'gpt-5.6-sol');
  assert.equal(c.context, 56112); assert.equal(c.cacheRead, 11264); assert.equal(c.cacheWrite, null); assert.equal(c.input, 44660);
  assert.equal(codexUsageEvent({ total: { inputTokens: 1 } }), null);
  const o = openaiUsageEvent({ prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 60 }, 'deepseek-chat');
  assert.equal(o.context, 105); assert.equal(o.input, 40); assert.equal(o.cacheRead, 60); assert.equal(o.cacheWrite, null);
  assert.equal(openaiUsageEvent({ prompt_tokens: 10, completion_tokens: 1 }).cacheRead, null, '没给命中数 = 不知道');
});

test('codex 插头：一轮吐出 reasoning → 工具对 → 边写边念 → usage → 正文 → turn.end，全是 imb.event.v1、带 turn', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neutral-codex-'));
  const auth = path.join(dir, 'auth.json'); fs.writeFileSync(auth, JSON.stringify({ auth_mode: 'chatgpt' }));
  const seen = [];
  const rt = createCodexRuntime({ ingressPath: path.join(dir, 'state', 'ingress.json'), cwd: dir, authFile: auth, codexPath: FAKE, home: dir,
    env: { ...process.env, GATE_ROOT: '', GATE_COLD_FILE: '' }, sdkOptions: { model: 'gpt-5.6-sol' },
    onEvent: async (p) => { seen.push(p); } });
  await rt.start();
  rt.enqueue({ uuid: 'u1', origin: { turnId: 't1' }, message: { type: 'user', message: { role: 'user', content: 'TOOL 看看' } } });
  assert.ok(await until(() => seen.some((p) => p.event.kind === 'turn.end')));
  const evs = seen.map((p) => p.event);
  assert.ok(evs.every((e) => e.v === 'imb.event.v1' && e.engine === 'codex-appserver' && e.turn === 'u1' && !e.raw), JSON.stringify(evs[0]));
  assert.ok(seen.every((p) => p.bindings[0].uuid === 'u1'));
  const kinds = evs.map((e) => e.kind + (e.end ? ':end' : ''));
  assert.deepEqual(kinds, ['reasoning', 'tool.call', 'tool.result', 'tool.call', 'tool.result', 'text.delta', 'text.delta:end', 'usage', 'text', 'turn.end']);
  assert.equal(evs[3].name, 'mcp__im_bridge__reply'); assert.equal(evs[4].isError, true);
  assert.equal(evs[8].text, '嗯。'); assert.equal(evs[8].generatedBy, 'model');
  assert.equal(evs[9].status, 'ok');
  await rt.close();
});

test('Claude 插头：宿主里把真 SDK 帧翻成通用事件（turn = 台账号）；IMB_CLAUDE_EVENTS=frames 回滚成原帧', async () => {
  const frames = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'real', 'sdk-frames-2.1.292-tool-turn.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  const run = async (env) => {
    const got = [];
    let wrapped;
    const f = createEngineFactories({ env, stateDir: os.tmpdir(), overrides: { claude: (cfg) => { wrapped = cfg.onEvent; return {}; } } });
    f['claude-cli']({ onEvent: async (p) => { got.push(p); }, sdkOptions: { freshThread: 'x', codexConfig: {} } });
    const bindings = [{ uuid: 'u9', origin: {} }];
    for (const fr of frames) for (const event of decode(fr)) await wrapped({ event, bindings });
    return got;
  };
  const neutralOut = await run({});
  const kinds = new Set(neutralOut.map((p) => p.event.kind));
  for (const k of ['tool.call', 'tool.result', 'text', 'turn.end', 'usage']) assert.ok(kinds.has(k), `${k} 没翻出来：${[...kinds]}`);
  assert.ok(neutralOut.every((p) => p.event.v === 'imb.event.v1' && p.event.engine === 'claude-cli' && p.event.turn === 'u9' && !p.event.raw));
  const legacy = await run({ IMB_CLAUDE_EVENTS: 'frames' });
  assert.ok(legacy.length && legacy.every((p) => p.event.raw), '回滚档送的是原帧');
});
