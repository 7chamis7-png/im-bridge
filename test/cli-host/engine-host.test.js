'use strict';

// S5 单宿主换芯（设计稿 §5.1）：一个人格只有一个引擎宿主，ensure(want) 比 want.engine，
// 不一样就停旧插头、起新插头，宿主进程不重启；人格包按新插头交；凭据只从 /root/.secrets 读。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createCliHost } = require('../../cli-host/server');
const { createEngineFactories, readSecret } = require('../../cli-host/engines');
const { createCodexRuntime } = require('../../cli-host/codex-runtime');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'engine-host-'));

/** 假插头：记下谁被起、谁被关、拿到的 sdkOptions。 */
function fakePlug(name, log, { failStart = false } = {}) {
  return (cfg) => {
    const me = { name, cfg, closed: false };
    log.push(me);
    return {
      start: async () => { if (failStart) throw new Error(`${name} 起不来`); },
      stop: async () => {}, close: async () => { me.closed = true; },
      enqueue: () => ({}), get: () => null, list: () => [],
      status: () => ({ running: true, sessionId: `${name}-sid` }),
      setModel: async () => {}, done: new Promise(() => {}),
    };
  };
}

function makeHost(dir, engines, extra = {}) {
  return createCliHost({
    socketPath: path.join(dir, 'cli.sock'), ingressPath: path.join(dir, 'ingress.json'),
    claudePath: process.execPath, engine: 'claude', engines, ...extra,
  });
}

test('换芯：want.engine 不一样就停旧插头起新插头，同一个宿主；一样就复用', async () => {
  const dir = tmp(); const log = [];
  const host = makeHost(dir, { 'claude-cli': fakePlug('claude', log), 'codex-appserver': fakePlug('codex', log) });
  const ws = path.join(dir, 'ws');
  const a = await host._internals.ensure({ workspaceRoot: ws, model: 'claude-fable-5[1m]' });
  assert.equal(a.reused, false);
  assert.equal(log.length, 1); assert.equal(log[0].name, 'claude');
  assert.equal(a.status.engine, 'claude-cli', '没带 engine = 默认那家');
  const b = await host._internals.ensure({ workspaceRoot: ws, model: 'claude-fable-5[1m]', engine: 'claude-cli' });
  assert.equal(b.reused, true);
  const c = await host._internals.ensure({ workspaceRoot: ws, model: 'gpt-5.6-sol', engine: 'codex-appserver' });
  assert.equal(c.reused, false);
  assert.equal(log.length, 2); assert.equal(log[1].name, 'codex');
  assert.equal(log[0].closed, true, '旧插头关了');
  assert.equal(c.status.engine, 'codex-appserver');
  assert.equal(host._internals.live.engine, 'codex-appserver');
  // 老名字也认（GATE_ENGINE / forge-switch 那套）
  const d = await host._internals.ensure({ workspaceRoot: ws, model: 'gpt-5.6-sol', engine: 'codex' });
  assert.equal(d.reused, true);
  await host.shutdown();
});

test('人格包按新插头交：换到 codex 时双份检查按 codex 算（AGENTS.md），人格拼进 systemPrompt', async () => {
  const dir = tmp(); const log = [];
  const ws = path.join(dir, 'ws'); fs.mkdirSync(ws);
  const personaFile = path.join(dir, '他.md'); fs.writeFileSync(personaFile, '我是他');
  fs.writeFileSync(path.join(ws, 'AGENTS.md'), '旧的 AGENTS');
  const host = makeHost(dir, { 'claude-cli': fakePlug('claude', log), 'codex-appserver': fakePlug('codex', log) },
    { personaSpec: () => ({ persona: 'him', personaFile, configFile: path.join(dir, 'tools.json') }) });
  const a = await host._internals.ensure({ workspaceRoot: ws, sdkOptions: { systemPrompt: '宣言' } });
  assert.equal(a.persona.mode, 'bridge', 'claude 不读 AGENTS.md → 只有桥交的');
  const b = await host._internals.ensure({ workspaceRoot: ws, engine: 'codex-appserver', sdkOptions: { systemPrompt: '宣言' } });
  assert.equal(b.persona.mode, 'bridge+engine-dup', 'codex 自己会读 AGENTS.md → 双份告警');
  assert.match(log[1].cfg.sdkOptions.systemPrompt, /宣言[\s\S]*我是他/);
  await host.shutdown();
});

test('没有这根插头：停旧的之前就拒绝；新插头起不来：不留半死的 live，换回去照常', async () => {
  const dir = tmp(); const log = [];
  const host = makeHost(dir, { 'claude-cli': fakePlug('claude', log), 'openai-chat': fakePlug('ds', log, { failStart: true }) });
  const ws = path.join(dir, 'ws');
  await host._internals.ensure({ workspaceRoot: ws });
  await assert.rejects(host._internals.ensure({ workspaceRoot: ws, engine: 'grok' }), /没有 grok 插头/);
  assert.equal(log[0].closed, false, '正在跑的 claude 没被关');
  await assert.rejects(host._internals.ensure({ workspaceRoot: ws, engine: 'openai-chat' }), /ds 起不来/);
  assert.equal(host._internals.live, null, '起不来的插头不挂在 live 上');
  assert.equal(log[1].closed, true, '起不来的那根也关掉了');
  const back = await host._internals.ensure({ workspaceRoot: ws, engine: 'claude-cli' });
  assert.equal(back.reused, false); assert.equal(back.status.engine, 'claude-cli');
  await host.shutdown();
});

test('钥匙只从 secrets 目录读：名字不合法 / 文件不在 / 空 → 拒；env 里的 DEEPSEEK_API_KEY 不认', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'deepseek.secret'), 'sk-test-123\n');
  fs.writeFileSync(path.join(dir, 'empty.secret'), '  \n');
  assert.equal(readSecret('deepseek', { dir }), 'sk-test-123');
  assert.throws(() => readSecret('../deepseek', { dir }), /不合法/);
  assert.throws(() => readSecret('nope', { dir }), /没有钥匙文件/);
  assert.throws(() => readSecret('empty', { dir }), /是空的/);
  const seen = [];
  const f = createEngineFactories({ env: { DEEPSEEK_API_KEY: 'env-key-should-not-be-used' }, stateDir: dir, secretsDir: dir,
    overrides: { deepseek: (cfg) => { seen.push(cfg); return {}; } } });
  f['openai-chat']({ cwd: dir, sdkOptions: { model: 'deepseek-chat', engineCreds: { secret: 'deepseek', baseUrl: 'https://api.deepseek.com' } } });
  assert.equal(seen[0].credentials.apiKey, 'sk-test-123');
  assert.equal(seen[0].credentials.model, 'deepseek-chat');
  assert.throws(() => f['openai-chat']({ cwd: dir, sdkOptions: { engineCreds: { secret: 'nope' } } }), /没有钥匙文件/);
});

test('deepseek-main.js 不再去别的进程的环境 / pm2 存档里借钥匙', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'cli-host', 'deepseek-main.js'), 'utf8');
  assert.doesNotMatch(src, /\/proc\//);
  assert.doesNotMatch(src, /dump\.pm2/);
  assert.match(src, /readSecret/);
});

test('codex：要求自己的 CODEX_HOME 时没设就拒；设了 → auth.json 和 app-server 的 CODEX_HOME 都指过去', () => {
  const dir = tmp();
  const seen = [];
  const strict = createEngineFactories({ env: {}, stateDir: dir, requireCodexHome: true, overrides: { codex: (c) => { seen.push(c); return {}; } } });
  assert.throws(() => strict['codex-appserver']({ cwd: dir, sdkOptions: {} }), /CODEX_HOME/);
  const home = path.join(dir, 'codex-home'); fs.mkdirSync(home);
  const ok = createEngineFactories({ env: { CODEX_HOME: home }, stateDir: dir, requireCodexHome: true, overrides: { codex: (c) => { seen.push(c); return {}; } } });
  ok['codex-appserver']({ cwd: dir, sdkOptions: {} });
  assert.equal(seen[0].authFile, path.join(home, 'auth.json'));
  assert.equal(seen[0].codexHome, home);
  assert.equal(seen[0].threadFile, path.join(dir, 'codex-thread.json'));

  // 插头本身：auth.json 从 CODEX_HOME 读、app-server 的环境里带 CODEX_HOME
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt' }));
  const drv = [];
  createCodexRuntime({ ingressPath: path.join(dir, 'state', 'ingress.json'), cwd: dir, codexHome: home, env: {},
    driverFactory: (o) => { drv.push(o); return {}; } });
  assert.equal(drv[0].env.CODEX_HOME, home);
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk' }));
  assert.throws(() => createCodexRuntime({ ingressPath: path.join(dir, 'state', 'ingress2.json'), cwd: dir, codexHome: home, env: {},
    driverFactory: () => ({}) }), /按量计费/);
});

test('codex 插头不再悄悄回落：别家的模型名当场拒绝起来；登记表给的 codexConfig 压在 env 上面', () => {
  const dir = tmp();
  const auth = path.join(dir, 'auth.json'); fs.writeFileSync(auth, JSON.stringify({ auth_mode: 'chatgpt' }));
  const mk = (sdkOptions, env = {}) => {
    const drv = [];
    createCodexRuntime({ ingressPath: path.join(dir, `i-${Math.random()}.json`), cwd: dir, authFile: auth, env, sdkOptions,
      driverFactory: (o) => { drv.push(o); return {}; } });
    return drv[0];
  };
  assert.throws(() => mk({ model: 'claude-fable-5[1m]' }, { GATE_MODEL: 'gpt-5.6-sol' }), /不回落/);
  assert.equal(mk({}, { GATE_MODEL: 'gpt-5.6-sol' }).model, 'gpt-5.6-sol', '没给才用默认');
  const d = mk({ model: 'gpt-5.6-sol', codexConfig: { model_context_window: 872000 } }, { CODEX_MODEL_CONTEXT_WINDOW: '272000' });
  assert.deepEqual(d.configOverrides, ['model_context_window=872000']);
});
