'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { createIngress } = require('../../runtime/ingress');

function fixture(t, io) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'im-bridge-ingress-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'inbox.json');
  return { directory, filePath, ingress: createIngress({ filePath, io }) };
}

const message = (uuid = 'a', scope = 'session-a') => ({
  uuid, scope, payload: {
    uuid, message: { uuid, text: '她的原话' },
    origin: { channel: 'telegram', threadId: 'thread-a', recipient: 'person-a' },
  },
});
const disk = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8')).records;

test('A-2：没有 CLI 也持久入队，重开保留完整消息与归属', (t) => {
  const { ingress, filePath } = fixture(t);
  const input = message();
  ingress.accept(input);
  input.payload.origin.threadId = 'changed';
  ingress.get('a').payload.message.text = 'changed';
  ingress.list()[0].payload.origin.recipient = 'changed';
  ingress.close();
  const reopened = createIngress({ filePath });
  assert.deepEqual(reopened.get('a'), { ...message(), state: 'pending', error: null });
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test('三态顺序：started 完整落盘后才调用 write；写完不冒充 completed', async (t) => {
  const { ingress, filePath } = fixture(t);
  ingress.accept(message());
  assert.equal(ingress.begin('a'), true);
  assert.equal(disk(filePath)[0].state, 'dispatching');
  await ingress.submit('a', (payload) => {
    assert.equal(disk(filePath)[0].state, 'started');
    assert.deepEqual(payload, message().payload);
    payload.origin.threadId = 'cannot mutate stored record';
  });
  assert.equal(ingress.get('a').state, 'started');
  assert.equal(ingress.get('a').payload.origin.threadId, 'thread-a');
  ingress.complete('a');
  assert.equal(disk(filePath)[0].state, 'completed');
  assert.equal(ingress.begin('a'), false);
});

test('未越过写出边界的中断可重放；越过后只能 uncertain', async (t) => {
  const { ingress } = fixture(t);
  ingress.accept(message());
  ingress.begin('a');
  assert.equal(ingress.interrupted('a').state, 'pending');
  assert.equal(ingress.begin('a'), true);
  await ingress.submit('a', () => {});
  assert.equal(ingress.interrupted('a').state, 'uncertain');
  assert.equal(ingress.begin('a'), false);
  assert.equal(ingress.list('pending').length, 0);
});

test('uncertain 保留供对账，重复 accept 不拒收、不重发，迟到成功可完成', async (t) => {
  const { ingress, filePath } = fixture(t);
  ingress.accept(message());
  ingress.begin('a');
  await assert.rejects(ingress.submit('a', () => { throw new Error('管道断开'); }), /不能自动重放/);
  assert.match(ingress.get('a').error, /管道断开/);
  assert.equal(ingress.accept(message()).state, 'uncertain');
  assert.equal(ingress.begin('a'), false);
  ingress.close();
  const reopened = createIngress({ filePath });
  assert.equal(reopened.get('a').state, 'uncertain');
  assert.equal(reopened.complete('a').state, 'completed');
  assert.equal(reopened.complete('a').state, 'completed');
  reopened.close();
  assert.equal(createIngress({ filePath }).get('a').state, 'completed');
});

test('同会话等待 result，其他会话可独立认领；uncertain 释放会话占位', async (t) => {
  const { ingress } = fixture(t);
  for (const input of [message('a'), message('b'), message('c', 'session-b')]) ingress.accept(input);
  assert.equal(ingress.begin('a'), true);
  assert.equal(ingress.begin('a'), false);
  assert.equal(ingress.begin('b'), false);
  assert.equal(ingress.begin('c'), true);
  await ingress.submit('a', () => {});
  assert.equal(ingress.begin('b'), false);
  ingress.interrupted('a');
  assert.equal(ingress.begin('b'), true);
  assert.deepEqual(ingress.list('dispatching', 'session-a').map((row) => row.uuid), ['b']);
});

test('晚到写出错误不能覆盖已经收到的成功结果或释放下一轮', async (t) => {
  const { ingress } = fixture(t);
  ingress.accept(message('a'));
  ingress.accept(message('b'));
  ingress.begin('a');
  let rejectWrite;
  const submitted = ingress.submit('a', () => new Promise((resolve, reject) => { rejectWrite = reject; }));
  ingress.complete('a');
  ingress.begin('b');
  rejectWrite(new Error('迟到的写出错误'));
  await assert.rejects(submitted, /迟到的写出错误/);
  assert.equal(ingress.get('a').state, 'completed');
  assert.equal(ingress.get('b').state, 'dispatching');
  assert.equal(ingress.complete('a', { failed: true }).state, 'completed');
});

test('失败结果按旧规则留 uncertain，后续成功结果仍可对账完成', async (t) => {
  const { ingress } = fixture(t);
  ingress.accept(message());
  ingress.begin('a');
  await ingress.submit('a', () => {});
  assert.equal(ingress.complete('a', { failed: true, reason: '工具结果失败' }).state, 'uncertain');
  assert.equal(ingress.get('a').error, '工具结果失败');
  assert.equal(ingress.complete('a').state, 'completed');
});

test('异步写出拒绝即使不是 Error 也留 uncertain；关闭后的拒绝由恢复对账', async (t) => {
  const { ingress, filePath } = fixture(t);
  ingress.accept(message());
  ingress.begin('a');
  await assert.rejects(ingress.submit('a', () => Promise.reject(null)), /不能自动重放/);
  assert.equal(ingress.get('a').state, 'uncertain');
  ingress.accept(message('b'));
  ingress.begin('b');
  let rejectWrite;
  const submitted = ingress.submit('b', () => new Promise((resolve, reject) => { rejectWrite = reject; }));
  ingress.close();
  rejectWrite(new Error('关闭后才报错'));
  await assert.rejects(submitted, /关闭后才报错/);
  const recovered = createIngress({ filePath });
  assert.equal(recovered.get('a').state, 'uncertain');
  assert.equal(recovered.get('b').state, 'uncertain');
});

test('重复入队幂等，冲突不能覆盖；不完整或有损 JSON 不偷偷保存', (t) => {
  const { ingress } = fixture(t);
  const first = ingress.accept(message());
  assert.deepEqual(ingress.accept(message()), first);
  assert.throws(() => ingress.accept(message('a', 'other')), /不能覆盖/);
  assert.throws(() => ingress.accept({ ...message(), payload: { text: 'different' } }), /不能覆盖/);
  assert.throws(() => ingress.accept({ ...message('b'), scope: '' }), /需要 UUID/);
  assert.throws(() => ingress.accept({ ...message('b'), payload: { text: undefined } }), /无法完整保存/);
  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => ingress.accept({ ...message('b'), payload: cycle }), /无法完整保存/);
  assert.equal(ingress.list().length, 1);
});

test('状态守卫拒绝越级提交、提前完成和重发，不调用 write', async (t) => {
  const { ingress } = fixture(t);
  ingress.accept(message());
  let writes = 0;
  const write = () => { writes += 1; };
  await assert.rejects(ingress.submit('a', write), /不在 dispatching/);
  assert.throws(() => ingress.complete('a'), /尚未提交/);
  assert.throws(() => ingress.begin('missing'), /找不到/);
  ingress.begin('a');
  await assert.rejects(ingress.submit('a', null), /写出函数/);
  await ingress.submit('a', write);
  await assert.rejects(ingress.submit('a', write), /不能提交或自动重放/);
  ingress.interrupted('a');
  await assert.rejects(ingress.submit('a', write), /不能提交或自动重放/);
  ingress.complete('a');
  await assert.rejects(ingress.submit('a', write), /不能提交或自动重放/);
  assert.equal(writes, 1);
});

test('关闭不伪造结果，尚未完成的 started 在重开后成为 uncertain', async (t) => {
  const { ingress, filePath } = fixture(t);
  ingress.accept(message());
  ingress.begin('a');
  await ingress.submit('a', () => {});
  ingress.close();
  assert.throws(() => ingress.accept(message('b')), /已关闭/);
  await assert.rejects(ingress.submit('a', () => assert.fail('不应写出')), /已关闭/);
  assert.throws(() => ingress.complete('a'), /已关闭/);
  const reopened = createIngress({ filePath });
  assert.equal(reopened.get('a').state, 'uncertain');
});

test('路径必须显式提供；损坏文件保留并报错，不当空队列覆盖', (t) => {
  assert.throws(() => createIngress(), /绝对路径/);
  assert.throws(() => createIngress({ filePath: 'relative.json' }), /绝对路径/);
  const { ingress, filePath } = fixture(t);
  ingress.close();
  for (const invalid of ['{"version":', JSON.stringify({ version: 99, records: [] }),
    JSON.stringify({ version: 1, records: [{ ...message(), state: 'typo' }] }),
    JSON.stringify({ version: 1, records: Array(2).fill({ ...message(), state: 'pending' }) })]) {
    fs.writeFileSync(filePath, invalid);
    assert.throws(() => createIngress({ filePath }), /已保留原文件/);
    assert.equal(fs.readFileSync(filePath, 'utf8'), invalid);
  }
});

test('崩溃时序：真实子进程中断，不运行 close 或错误收尾', async (t) => {
  for (const phase of ['dispatching', 'started-before-write', 'started-after-write', 'completed']) {
    await t.test(phase, async (t) => {
      const { ingress, filePath, directory } = fixture(t);
      ingress.close();
      const effects = path.join(directory, 'effects.txt');
      const child = spawnSync(process.execPath, ['-e', `
        const fs = require('node:fs');
        const { createIngress } = require(process.argv[1]);
        const [filePath, phase, effects, input] = process.argv.slice(2);
        const io = Object.create(fs);
        io.fsyncSync = (fd) => {
          fs.fsyncSync(fd);
          if (phase === 'started-before-write' && fs.fstatSync(fd).isDirectory() &&
              JSON.parse(fs.readFileSync(filePath, 'utf8')).records[0]?.state === 'started') {
            process.exit(72);
          }
        };
        const ingress = createIngress({ filePath, io });
        ingress.accept(JSON.parse(input));
        ingress.begin('a');
        if (phase === 'dispatching') process.exit(72);
        ingress.submit('a', () => {
          fs.appendFileSync(effects, 'written\\n');
          if (phase === 'completed') ingress.complete('a');
          process.exit(72);
        }).catch((error) => { console.error(error); process.exit(1); });
      `, require.resolve('../../runtime/ingress'), filePath, phase, effects, JSON.stringify(message())],
      { encoding: 'utf8', timeout: 10000 });
      assert.equal(child.status, 72, child.stderr);
      assert.equal(child.error, undefined);
      const expected = phase === 'dispatching' ? 'pending' : phase === 'completed' ? 'completed' : 'uncertain';
      const recovered = createIngress({ filePath });
      assert.equal(recovered.get('a').state, expected);
      assert.equal(disk(filePath)[0].state, expected);
      assert.equal(recovered.list('pending').length, expected === 'pending' ? 1 : 0);
      assert.equal(fs.existsSync(effects), ['started-after-write', 'completed'].includes(phase));
      assert.deepEqual(recovered.get('a').payload, message().payload);
      recovered.close();
      const again = createIngress({ filePath });
      assert.equal(again.get('a').state, expected);
      // 只有写出前崩溃的消息能被重新认领并实际写出一次。
      assert.equal(again.begin('a'), expected === 'pending');
      if (expected === 'pending') {
        let replays = 0;
        await again.submit('a', (payload) => {
          assert.deepEqual(payload, message().payload);
          replays += 1;
        });
        assert.equal(replays, 1);
        assert.equal(again.begin('a'), false);
      }
    });
  }
});

test('落盘各步失败都拦住写出；替换后失败必须按 uncertain 恢复', async (t) => {
  for (const stage of ['write', 'file-sync', 'rename', 'directory-sync']) {
    await t.test(stage, async (t) => {
      let armed = false;
      const io = Object.create(fs);
      const fail = () => { throw new Error(`模拟磁盘错误 ${stage}`); };
      io.writeFileSync = (...args) => armed && stage === 'write' ? fail() : fs.writeFileSync(...args);
      io.renameSync = (...args) => armed && stage === 'rename' ? fail() : fs.renameSync(...args);
      io.fsyncSync = (fd) => {
        const directory = fs.fstatSync(fd).isDirectory();
        if (armed && ((stage === 'file-sync' && !directory) || (stage === 'directory-sync' && directory))) fail();
        fs.fsyncSync(fd);
      };
      const { ingress, filePath } = fixture(t, io);
      ingress.accept(message());
      ingress.begin('a');
      armed = true;
      let writes = 0;
      await assert.rejects(ingress.submit('a', () => { writes += 1; }), /已停止写出/);
      assert.equal(writes, 0);
      armed = false;
      assert.throws(() => ingress.interrupted('a'), /重新打开存储/);
      await assert.rejects(ingress.submit('a', () => { writes += 1; }), /重新打开存储/);
      ingress.close();
      const recovered = createIngress({ filePath });
      const expected = stage === 'directory-sync' ? 'uncertain' : 'pending';
      assert.equal(recovered.get('a').state, expected);
      assert.equal(writes, 0);
    });
  }
});

test('未替换的残留临时文件不是已提交证据；恢复只读正式快照', (t) => {
  const { ingress, filePath } = fixture(t);
  ingress.accept(message());
  ingress.begin('a');
  ingress.close();
  fs.writeFileSync(`${filePath}.tmp`, '{"incomplete":');
  assert.equal(createIngress({ filePath }).get('a').state, 'pending');
});
