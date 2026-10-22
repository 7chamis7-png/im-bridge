'use strict';

// codex app-server 驱动（Iris的发动机）的测试。用假 app-server（fake-codex-appserver.js，stdio 桩），不起真 codex。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createCodexAppServer } = require('../../cli-host/codex-appserver');

const FAKE = path.join(__dirname, 'fake-codex-appserver.js');

function make(extraEnv = {}, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-as-'));
  const logFile = path.join(dir, 'frames.jsonl');
  const logs = [];
  const drv = createCodexAppServer({
    codexPath: FAKE, cwd: dir, home: dir, startTimeoutMs: 5000, turnTimeoutMs: 5000,
    env: { ...process.env, FAKE_LOG: logFile, ...extraEnv },
    log: (s) => logs.push(s), ...opts,
  });
  const frames = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const cleanup = async () => { await drv.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { drv, frames, logs, cleanup };
}

test('正常一轮：只收 final_answer，commentary 不混进去，给出用量', async () => {
  const t = make();
  try {
    const deltas = [];
    const r = await t.drv.runTurn('hi', { onDelta: (d) => deltas.push(d) });
    assert.equal(r.text, '你好呀');
    assert.deepEqual(deltas, ['你好', '呀']);
    assert.equal(r.usage.last.totalTokens, 42);   // S3c 起整个 tokenUsage 都留着，水位读 last 不读 total
    assert.match(t.drv.threadId, /^fake-thread-/);
    const turn = t.frames().find((f) => f.in && f.in.method === 'turn/start');
    assert.deepEqual(turn.in.params.input, [{ type: 'text', text: 'hi' }]);
  } finally { await t.cleanup(); }
});

test('resume 已有 thread：发 thread/resume 带 threadId 和 cwd，沿用旧 id，不再 thread/start', async () => {
  const t = make();
  try {
    assert.equal(await t.drv.resumeThread('old-thread-123'), true);
    assert.equal(t.drv.threadId, 'old-thread-123');
    assert.equal(t.drv.threadPath, '/fake/resumed.jsonl');
    const methods = t.frames().filter((f) => f.in && f.in.method).map((f) => f.in.method);
    assert.ok(methods.includes('thread/resume'));
    const resume = t.frames().find((f) => f.in && f.in.method === 'thread/resume');
    assert.equal(resume.in.params.threadId, 'old-thread-123');
    assert.ok(resume.in.params.cwd);
    // 续上之后这一轮发的是旧 thread
    await t.drv.runTurn('hi');
    const turn = t.frames().find((f) => f.in && f.in.method === 'turn/start');
    assert.equal(turn.in.params.threadId, 'old-thread-123');
  } finally { await t.cleanup(); }
});

test('resume 续不上：返回 false 不抛，回落到 ensure 起的新 thread', async () => {
  const t = make({ FAKE_RESUME: 'fail' });
  try {
    assert.equal(await t.drv.resumeThread('gone'), false);
    assert.ok(t.logs.some((s) => s.includes('续不上')));
    assert.equal(await t.drv.resumeThread(''), false);
    // S3c 起 ensure 不再预开空 thread；续不上之后第一轮才新开
    await t.drv.runTurn('hi');
    assert.match(t.drv.threadId, /^fake-thread-/);
  } finally { await t.cleanup(); }
});

test('审批请求回 approved，之后这一轮正常收尾', async () => {
  const t = make({ FAKE_TURN: 'approval' });
  try {
    const r = await t.drv.runTurn('跑个命令');
    assert.equal(r.text, '你好呀');   // 没回应的话假服务端不会继续，这里能拿到字就说明应答到了
    const reply = t.frames().find((f) => f.in && f.in.id === 900);
    assert.deepEqual(reply.in.result, { decision: 'approved' });
    assert.ok(t.logs.some((s) => s.includes('审批请求已放行')));
  } finally { await t.cleanup(); }
});

test('turn/failed：这一轮 reject 并带服务端错误信息，之后驱动还能跑下一轮', async () => {
  const t = make({ FAKE_TURN: 'failed' });
  try {
    await assert.rejects(t.drv.runTurn('x'), /模型炸了/);
    // activeTurn 已清，不会卡成「上一轮还没结束」
    await assert.rejects(t.drv.runTurn('y'), /模型炸了/);
  } finally { await t.cleanup(); }
});

test('断线重连：app-server 中途退出 → 当轮 reject；下一轮重新拉起新进程并重新 initialize', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-as-die-'));
  const logFile = path.join(dir, 'frames.jsonl');
  // 同一个 env 对象，第一轮让它死，第二轮改回正常（spawn 时才读 env）
  const env = { ...process.env, FAKE_LOG: logFile, FAKE_TURN: 'die' };
  const drv = createCodexAppServer({ codexPath: FAKE, cwd: dir, home: dir, startTimeoutMs: 5000, turnTimeoutMs: 5000, env, log: () => {} });
  try {
    await assert.rejects(drv.runTurn('第一轮'), /退出了 code=3/);
    assert.equal(drv.initialized, false);
    env.FAKE_TURN = 'ok';
    const r = await drv.runTurn('第二轮');
    assert.equal(r.text, '你好呀');
    const inits = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((f) => f.in && f.in.method === 'initialize');
    assert.equal(inits.length, 2);
    assert.notEqual(inits[0].pid, inits[1].pid);
  } finally { await drv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('没有 cwd 直接报错；close 之后不能再跑', async () => {
  assert.throws(() => createCodexAppServer({}), /cwd/);
  const t = make();
  await t.cleanup();
  await assert.rejects(t.drv.runTurn('x'), /已经关了/);
});
