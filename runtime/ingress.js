'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Standalone durable queue: no processes, no polling, no SDK.
 * Assumes exactly one live owner per filePath.
 * `io` exists only for fault injection; production uses node:fs.
 */
function createIngress({ filePath, io = fs } = {}) {
  if (!nonempty(filePath) || !path.isAbsolute(filePath)) {
    throw new Error('可靠投递需要配置独立存储文件的绝对路径，不能猜默认位置。');
  }
  let rows = new Map();
  let closed = false;
  let broken = false;

  function writable() {
    if (closed) throw new Error('可靠投递已关闭，请重新打开存储后再操作。');
    if (broken) throw new Error('可靠投递落盘失败，已停止写出；请重新打开存储核对状态。');
  }

  function persist(next) {
    writable();
    try {
      const directory = path.dirname(filePath);
      io.mkdirSync(directory, { recursive: true });
      const fd = io.openSync(`${filePath}.tmp`, 'w', 0o600);
      try {
        io.writeFileSync(fd, JSON.stringify({ version: 1, records: [...next.values()] }) + '\n');
        io.fsyncSync(fd);
      } finally {
        io.closeSync(fd);
      }
      io.renameSync(`${filePath}.tmp`, filePath);
      // Both the file contents and the renamed directory entry must be durable before crossing the side-effect boundary.
      const directoryFd = io.openSync(directory, 'r');
      try {
        io.fsyncSync(directoryFd);
      } finally {
        io.closeSync(directoryFd);
      }
      rows = next;
    } catch (cause) {
      // A failure after rename may already have changed the disk; stop using the stale in-memory state.
      broken = true;
      throw new Error(`可靠投递无法保存到 ${filePath}，已停止写出：${cause.message}`, { cause });
    }
  }

  function record(uuid) {
    const row = rows.get(uuid);
    if (!row) throw new Error(`找不到入站消息 ${uuid}，不能凭空改变投递状态。`);
    return row;
  }

  function change(uuid, state, error = null) {
    const next = new Map(rows);
    next.set(uuid, { ...record(uuid), state, error });
    persist(next);
    return get(uuid);
  }

  function get(uuid) {
    return structuredClone(rows.get(uuid));
  }

  function list(state, scope) {
    return [...rows.values()]
      .filter((row) => (state === undefined || row.state === state) &&
        (scope === undefined || row.scope === scope))
      .map((row) => structuredClone(row));
  }

  function accept({ uuid, scope, payload }) {
    writable();
    if (!nonempty(uuid) || !nonempty(scope) || payload == null) {
      throw new Error('入站消息需要 UUID、会话 scope 和完整 payload，缺少信息不能持久入队。');
    }
    let copy;
    try {
      copy = JSON.parse(JSON.stringify(payload));
      if (!isDeepStrictEqual(payload, copy)) throw new Error('包含 JSON 无法原样保存的值');
    } catch (cause) {
      throw new Error(`入站消息 ${uuid} 无法完整保存：${cause.message}`, { cause });
    }
    const previous = rows.get(uuid);
    if (previous) {
      if (previous.scope !== scope || !isDeepStrictEqual(previous.payload, copy)) {
        throw new Error(`入站 UUID ${uuid} 已有不同消息或会话，不能覆盖。`);
      }
      // `uncertain` is not a reason to reject; a duplicate accept just returns the existing row.
      return get(uuid);
    }
    const next = new Map(rows);
    next.set(uuid, { uuid, scope, payload: copy, state: 'pending', error: null });
    // runtime-rules A-2: persist even with no live process; never start the CLI from here.
    persist(next);
    return get(uuid);
  }

  function begin(uuid) {
    writable();
    const row = record(uuid);
    if (row.state !== 'pending') return false;
    if ([...rows.values()].some((other) => other.scope === row.scope &&
      (other.state === 'dispatching' || other.state === 'started'))) return false;
    change(uuid, 'dispatching');
    return true;
  }

  async function submit(uuid, write) {
    writable();
    if (typeof write !== 'function') throw new Error('提交消息需要提供写出函数。');
    if (record(uuid).state !== 'dispatching') {
      throw new Error(`消息 ${uuid} 不在 dispatching 状态，不能提交或自动重放。`);
    }
    // runtime-rules A-1/A-2: persist before crossing the side-effect boundary.
    // `started` means "possibly submitted", not an SDK ack; no await may be inserted around it.
    const started = change(uuid, 'started');
    try {
      await write(started.payload);
      // runtime-rules A-1: write() returning is not a result; stay `started` until the real result.
      return get(uuid);
    } catch (cause) {
      if (!closed && !broken && record(uuid).state === 'started') {
        change(uuid, 'uncertain', `写出时出错，可能已经提交，需人工对账：${cause?.message ?? String(cause)}`);
      }
      // A late result may already have completed the row; never downgrade `completed` because write() rejected later.
      throw new Error(`消息 ${uuid} 写出报错，不能自动重放；请核对保存的状态：${cause?.message ?? String(cause)}`, { cause });
    }
  }

  function interrupted(uuid, reason = '运行中断') {
    writable();
    const row = record(uuid);
    // runtime-rules A-2: only `dispatching` (definitely not submitted) is replayable.
    if (row.state === 'dispatching') return change(uuid, 'pending', `${reason}；尚未提交，可重放。`);
    if (row.state === 'started') return change(uuid, 'uncertain', `${reason}；可能已提交，需人工对账。`);
    return get(uuid);
  }

  function complete(uuid, { failed = false, reason = '收到失败结果，需人工对账。' } = {}) {
    writable();
    const row = record(uuid);
    if (row.state === 'completed') return get(uuid);
    if (row.state !== 'started' && row.state !== 'uncertain') {
      throw new Error(`消息 ${uuid} 尚未提交，不能标成已收到结果。`);
    }
    // runtime-rules A-1: driven only by real results. A late success may complete an `uncertain` row.
    // A failed result stays `uncertain` (never claimed as success).
    return change(uuid, failed ? 'uncertain' : 'completed', failed ? reason : null);
  }

  let saved;
  try {
    saved = io.readFileSync(filePath, 'utf8');
  } catch (cause) {
    if (cause.code !== 'ENOENT') {
      throw new Error(`无法读取可靠投递存储 ${filePath}：${cause.message}`, { cause });
    }
  }
  if (saved !== undefined) {
    try {
      const snapshot = JSON.parse(saved);
      const states = ['pending', 'dispatching', 'started', 'uncertain', 'completed'];
      if (snapshot.version !== 1 || !Array.isArray(snapshot.records)) throw new Error('不支持的存储格式');
      for (const row of snapshot.records) {
        if (!row || !nonempty(row.uuid) || !nonempty(row.scope) || row.payload == null ||
          !states.includes(row.state) || rows.has(row.uuid)) throw new Error('记录缺失、重复或状态无效');
        rows.set(row.uuid, row);
      }
    } catch (cause) {
      throw new Error(`可靠投递存储 ${filePath} 无法恢复，已保留原文件，请先核对：${cause.message}`, { cause });
    }
  }

  // runtime-rules A-2: recovery is persisted too, so repeated restarts never turn `uncertain` into `pending`.
  const recovered = new Map(rows);
  for (const [uuid, row] of recovered) {
    if (row.state === 'dispatching') {
      recovered.set(uuid, { ...row, state: 'pending', error: '上次在写出前中断，可安全重放。' });
    } else if (row.state === 'started') {
      recovered.set(uuid, { ...row, state: 'uncertain', error: '上次可能已提交，禁止自动重放，需人工对账。' });
    }
  }
  if (saved === undefined || [...rows.values()].some((row) =>
    row.state === 'dispatching' || row.state === 'started')) persist(recovered);

  return { accept, begin, submit, interrupted, complete, get, list, close() { closed = true; } };
}

module.exports = { createIngress };
