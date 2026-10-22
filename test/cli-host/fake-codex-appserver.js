#!/usr/bin/env node
'use strict';
// 假的 `codex app-server`（只给测试用）：换行分隔 JSON-RPC over stdio。
// 行为由环境变量控制：FAKE_LOG=收到的每条消息追加到这个文件（带 pid）；
// FAKE_TURN=ok|failed|approval|die；FAKE_RESUME=ok|fail。
const fs = require('node:fs');
const log = process.env.FAKE_LOG;
const turnMode = process.env.FAKE_TURN || 'ok';
const resumeMode = process.env.FAKE_RESUME || 'ok';
const rec = (o) => { if (log) fs.appendFileSync(log, JSON.stringify({ pid: process.pid, ...o }) + '\n'); };
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
const note = (method, params) => send({ method, params });
let threadSeq = 0;
let buf = '';

function finishTurn() {
  note('item/started', { item: { type: 'agentMessage', id: 'c1', phase: 'commentary' } });
  note('item/agentMessage/delta', { itemId: 'c1', delta: '想一想' });
  note('item/started', { item: { type: 'agentMessage', id: 'f1', phase: 'final_answer' } });
  note('item/agentMessage/delta', { itemId: 'f1', delta: '你好' });
  note('item/agentMessage/delta', { itemId: 'f1', delta: '呀' });
  note('thread/tokenUsage/updated', { tokenUsage: { last: { totalTokens: 42 }, total: { totalTokens: 790000 } } });
  note('turn/completed', {});
}

function onMsg(m) {
  rec({ in: m });
  if (m.id != null && m.method === undefined) {   // 客户端对我们的服务端请求的应答
    if (m.id === 900) finishTurn();
    return;
  }
  switch (m.method) {
    case 'initialize': return send({ id: m.id, result: { codexHome: '/fake' } });
    case 'initialized': return undefined;
    case 'thread/start': threadSeq += 1; return send({ id: m.id, result: { thread: { id: `fake-thread-${process.pid}-${threadSeq}`, path: '/fake/rollout.jsonl' } } });
    case 'thread/resume':
      if (resumeMode === 'fail') return send({ id: m.id, error: { message: 'no rollout found' } });
      return send({ id: m.id, result: { thread: { id: m.params.threadId, path: '/fake/resumed.jsonl' } } });
    case 'turn/start':
      send({ id: m.id, result: { turn: { id: 't1' } } });
      if (turnMode === 'die') process.exit(3);
      if (turnMode === 'failed') return note('turn/failed', { error: { message: '模型炸了' } });
      if (turnMode === 'approval') return send({ id: 900, method: 'item/commandExecution/requestApproval', params: { command: 'ls' } });
      return finishTurn();
    case 'turn/interrupt': return send({ id: m.id, result: {} });
    default: return m.id != null ? send({ id: m.id, result: {} }) : undefined;
  }
}
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (l) onMsg(JSON.parse(l)); }
});
process.stdin.on('end', () => process.exit(0));
