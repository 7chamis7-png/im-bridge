'use strict';

// S5 换引擎时插头这一头（设计稿 §5.3 第 3-4 步）：盒子按新窗口挑好尾巴交过来（sdkOptions.rebuild），
// 插头开新舱把尾巴垫进去；strict = 版本闸 / 垫历史 / 回读任何一步不成就抛（盒子回原引擎），旧账不动。
// codex 用假 app-server（test/gate/lib/fake-codex-appserver.js），DeepSeek 用桩 fetch —— 不起真引擎、不花钱。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createCodexRuntime } = require('../../cli-host/codex-runtime');
const { createDeepseekRuntime } = require('../../cli-host/deepseek-runtime');

const FAKE = path.join(__dirname, '..', 'gate', 'lib', 'fake-codex-appserver.js');
fs.chmodSync(FAKE, 0o755);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) { const t = Date.now() + ms; while (Date.now() < t) { if (await fn()) return true; await sleep(20); } return false; }

const TAIL = [
  { role: 'user', text: '[10-21 21:00]  她#1' }, { role: 'assistant', text: '他#1' },
  { role: 'user', text: '[10-21 21:05]  她#2' }, { role: 'assistant', text: '他#2' },
];

function codexFixture(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-rebuild-'));
  const rolloutDir = path.join(dir, 'rollouts'); fs.mkdirSync(rolloutDir);
  const auth = path.join(dir, 'auth.json'); fs.writeFileSync(auth, JSON.stringify({ auth_mode: 'chatgpt' }));
  const threadFile = path.join(dir, 'state', 'codex-thread.json');
  fs.mkdirSync(path.dirname(threadFile), { recursive: true });
  fs.writeFileSync(threadFile, JSON.stringify({ schema: 'nova.codex-thread.v1', threadId: 'real-1' }));
  const rpcFile = path.join(dir, 'rpc.jsonl');
  const env = { ...process.env, FAKE_CODEX_LOG: rpcFile, FAKE_CODEX_KNOWN: 'real-1', FAKE_CODEX_ROLLOUT_DIR: rolloutDir,
    GATE_ROOT: '', GATE_COLD_FILE: '', ...extraEnv };
  const rpc = () => { try { return fs.readFileSync(rpcFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const make = (sdkOptions) => createCodexRuntime({ ingressPath: path.join(dir, 'state', 'ingress.json'), cwd: dir,
    threadFile, authFile: auth, codexPath: FAKE, home: dir, env, sdkOptions });
  const disk = () => JSON.parse(fs.readFileSync(threadFile, 'utf8'));
  return { dir, rpc, make, disk };
}

test('codex 换引擎重建：开新 thread、尾巴垫进去、rollout 回读一致；codex-thread.json 记旧号', async () => {
  const fx = codexFixture();
  const rt = fx.make({ model: 'gpt-5.6-sol', freshThread: 'tok-1', rebuild: { tail: TAIL, strict: true } });
  await rt.start();
  const st = rt.status();
  assert.equal(st.rebuilt.injected, 4);
  assert.equal(st.rebuilt.verified, true);
  assert.ok(st.sessionId.startsWith('thr-'));
  const inj = fx.rpc().filter((c) => c.method === 'thread/inject_items');
  assert.equal(inj.length, 1);
  assert.match(JSON.stringify(inj[0].params.items), /他#2/);
  assert.equal(fx.disk().previousThreadId, 'real-1');
  assert.equal(fx.disk().rotatedFor, 'tok-1');
  assert.equal(fx.rpc().filter((c) => c.method === 'thread/resume').length, 0, '不 resume 旧舱');
  await rt.close();
});

test('codex strict：版本不在白名单 → 抛，旧账一字不动', async () => {
  const fx = codexFixture({ FAKE_CODEX_VERSION: '0.170.0' });
  const before = fs.readFileSync(path.join(fx.dir, 'state', 'codex-thread.json'), 'utf8');
  const rt = fx.make({ model: 'gpt-5.6-sol', freshThread: 'tok-1', rebuild: { tail: TAIL, strict: true } });
  await assert.rejects(rt.start(), /版本闸没过[\s\S]*0\.170\.0/);
  assert.equal(fs.readFileSync(path.join(fx.dir, 'state', 'codex-thread.json'), 'utf8'), before);
  assert.equal(fx.rpc().filter((c) => c.method === 'thread/start').length, 0, '闸没过就不开 thread');
  await rt.close();
});

test('codex strict：inject 失败 → 抛，不落盘（下次还按旧 thread 续）', async () => {
  const fx = codexFixture({ FAKE_CODEX_INJECT_FAIL: '1' });
  const rt = fx.make({ model: 'gpt-5.6-sol', freshThread: 'tok-1', rebuild: { tail: TAIL, strict: true } });
  await assert.rejects(rt.start(), /垫历史没成/);
  assert.equal(fx.disk().threadId, 'real-1');
  assert.equal(fx.disk().rotatedFor, undefined);
  await rt.close();
});

test('codex 同一家热切：setModel 之后下一轮 turn/start 带新 model；别家名字拒绝', async () => {
  const fx = codexFixture();
  const rt = fx.make({ model: 'gpt-5.6-sol' });
  await rt.start();
  await assert.rejects(rt.setModel('claude-fable-5[1m]'), /\/engine/);
  await rt.setModel('gpt-5.6-luna');
  rt.enqueue({ uuid: 'u1', origin: {}, message: { type: 'user', message: { role: 'user', content: '在吗' } } });
  assert.ok(await until(() => fx.rpc().some((c) => c.method === 'turn/start')));
  assert.equal(fx.rpc().find((c) => c.method === 'turn/start').params.model, 'gpt-5.6-luna');
  assert.equal(rt.status().requestedModel, 'gpt-5.6-luna');
  await rt.close();
});

test('DeepSeek 换引擎：新开一本对话、尾巴当历史发出去；同一张单不换第二次；strict 没钥匙就拒', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-rebuild-ds-'));
  const threadFile = path.join(dir, 'deepseek-thread.json');
  fs.writeFileSync(threadFile, JSON.stringify({ schema: 'nova.deepseek-thread.v1', sessionId: 'ds-old', messages: [{ role: 'user', content: '老对话' }] }));
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return { ok: true, status: 200, async text() { return JSON.stringify({ model: 'deepseek-chat', choices: [{ message: { role: 'assistant', content: '嗯' } }] }); } };
  };
  const belt = { openai: () => [], note: () => '', call: async () => '', close: async () => {} };
  const mk = (sdkOptions, key = 'k') => createDeepseekRuntime({ ingressPath: path.join(dir, `ingress-${Math.random()}.json`), cwd: dir,
    env: {}, fetchImpl, threadFile, coldFile: '', toolBelt: belt, credentials: { apiKey: key, model: 'deepseek-chat' }, sdkOptions });
  const rt = mk({ freshThread: 'tok-1', rebuild: { tail: TAIL, strict: true } });
  await rt.start();
  assert.notEqual(rt.status().sessionId, 'ds-old');
  assert.equal(rt.status().rebuilt.injected, 4);
  rt.enqueue({ uuid: 'u1', origin: {}, message: { type: 'user', message: { role: 'user', content: '现在' } } });
  assert.ok(await until(() => calls.length === 1));
  const sent = calls[0].messages.map((m) => m.content).join('|');
  assert.match(sent, /她#1[\s\S]*他#2[\s\S]*现在/);
  assert.doesNotMatch(sent, /老对话/);
  await rt.setModel('deepseek-reasoner');
  await assert.rejects(rt.setModel('gpt-5.6-sol'), /\/engine/);
  await rt.close();
  const again = mk({ freshThread: 'tok-1', rebuild: { tail: [], strict: true } });
  await again.start();
  assert.equal(again.status().rebuilt, undefined, '同一张单：只续，不再换');
  await again.close();
  const noKey = mk({ freshThread: 'tok-2', rebuild: { tail: TAIL, strict: true } }, '');
  await assert.rejects(noKey.start(), /钥匙/);
  await noKey.close();
});

// 2026-10-22 Iris /new 也带底子（sdkOptions.forgeBase，盒子用 buildForgeBaseText 拼的那份）
function coldFixture(fx) {
  const coldFile = path.join(fx.dir, 'cold.jsonl');
  const t = Date.now();
  fs.writeFileSync(coldFile, [
    { id: 'a', role: 'user', at: new Date(t - 60000).toISOString(), text: '冷她' },
    { id: 'b', role: 'assistant', at: new Date(t - 59000).toISOString(), text: '冷他' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  return coldFile;
}
const BASE = 'WECHAT SESSION INSTRUCTIONS\nOPS\n\n## 身份底座（IB · x）\nIB-BODY\n\n## LONG-TERM MEMORY\nMEM\n\n（以上是你的底座与场景。下面紧接着的是…）';

test('codex /new 带底子：开发者指令里没有 IB（比如Nova切到 codex）→ 底子整份当第一条垫进去', async () => {
  const fx = codexFixture({ FORGE_ENABLED: 'true' });
  const coldFile = coldFixture(fx);
  const rt = createCodexRuntime({ ingressPath: path.join(fx.dir, 'state', 'ingress2.json'), cwd: fx.dir,
    threadFile: path.join(fx.dir, 'state', 'codex-thread.json'), authFile: path.join(fx.dir, 'auth.json'), codexPath: FAKE, home: fx.dir,
    env: { ...process.env, FAKE_CODEX_LOG: path.join(fx.dir, 'rpc.jsonl'), FAKE_CODEX_KNOWN: 'real-1', FAKE_CODEX_ROLLOUT_DIR: path.join(fx.dir, 'rollouts'),
      GATE_ROOT: '', GATE_COLD_FILE: coldFile, FORGE_ENABLED: 'true' },
    sdkOptions: { model: 'gpt-5.6-sol', freshThread: 'tok-b', forgeBase: BASE, systemPrompt: '人格' } });
  await rt.start();
  const inj = fx.rpc().filter((c) => c.method === 'thread/inject_items');
  assert.equal(inj.length, 1);
  const texts = inj[0].params.items.map((it) => it.content.map((b) => b.text).join(''));
  assert.equal(texts[0], BASE);
  assert.match(texts.slice(1).join('|'), /冷她\|冷他/);
  assert.equal(rt.status().forged.via, 'thread/inject_items');
  await rt.close();
});

test('codex /new 带底子：开发者指令里已有同一份 IB → 底子里那段拿掉；inject 失败 → 底子跟着文字垫底走', async () => {
  const fx = codexFixture({ FORGE_ENABLED: 'true', FAKE_CODEX_INJECT_FAIL: '1' });
  const coldFile = coldFixture(fx);
  const rt = createCodexRuntime({ ingressPath: path.join(fx.dir, 'state', 'ingress.json'), cwd: fx.dir,
    threadFile: path.join(fx.dir, 'state', 'codex-thread.json'), authFile: path.join(fx.dir, 'auth.json'), codexPath: FAKE, home: fx.dir,
    env: { ...process.env, FAKE_CODEX_LOG: path.join(fx.dir, 'rpc.jsonl'), FAKE_CODEX_KNOWN: 'real-1', FAKE_CODEX_ROLLOUT_DIR: path.join(fx.dir, 'rollouts'),
      GATE_ROOT: '', GATE_COLD_FILE: coldFile, FORGE_ENABLED: 'true', FAKE_CODEX_INJECT_FAIL: '1' },
    sdkOptions: { model: 'gpt-5.6-sol', freshThread: 'tok-c', forgeBase: BASE, systemPrompt: '人格\n\nIB-BODY' } });
  await rt.start();
  rt.enqueue({ uuid: 'u1', origin: {}, message: { type: 'user', message: { role: 'user', content: '她现在这句' } } });
  assert.ok(await until(() => fx.rpc().some((c) => c.method === 'turn/start')));
  const sent = JSON.stringify(fx.rpc().find((c) => c.method === 'turn/start').params);
  assert.match(sent, /LONG-TERM MEMORY[\s\S]*以上是你的底座[\s\S]*接上次[\s\S]*冷她[\s\S]*她现在这句/);
  assert.doesNotMatch(sent, /身份底座|IB-BODY/);
  assert.equal(rt.status().forged.omitted[0], '身份底座');
  await rt.close();
});

test('换引擎（rebuild）同时递了 forgeBase：只垫 rebuild 那份，不带第二份底子', async () => {
  const fx = codexFixture({ FORGE_ENABLED: 'true' });
  const rt = fx.make({ model: 'gpt-5.6-sol', freshThread: 'tok-d', forgeBase: 'EXTRA-BASE', rebuild: { tail: [{ role: 'user', text: 'REBUILD-BASE' }, ...TAIL], strict: true } });
  await rt.start();
  const inj = fx.rpc().filter((c) => c.method === 'thread/inject_items');
  assert.equal(inj.length, 1);
  assert.equal(inj[0].params.items.length, 5);
  assert.doesNotMatch(JSON.stringify(inj), /EXTRA-BASE/);
  await rt.close();
});
