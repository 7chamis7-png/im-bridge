'use strict';
// 用真 codex app-server（隔离 CODEX_HOME）跑一遍 codex 重建插头：forge 尾巴 → inject → rollout 回读 → 问一轮看他认不认
const fs = require('fs'); const path = require('path');
const R = '/root/im-bridge-next';
const { createCodexAppServer } = require(R + '/cli-host/codex-appserver');
const { rebuildCodexThread } = require(R + '/cli-host/rebuild-codex');
const forge = require(R + '/scripts/forge');
const noTurn = process.argv.includes('--no-turn');
(async () => {
  const cold = '/tmp/s0/data/cold-rebuild.jsonl';
  const now = Date.now();
  const rows = [
    { id: 'cold-a-user', role: 'user', at: new Date(now - 300000).toISOString(), text: '今天的暗号你来定' },
    { id: 'cold-b-assistant', role: 'assistant', at: new Date(now - 290000).toISOString(), text: '那就定 RIVER-6031-MAPLE，我记着' },
    { id: 'cold-c-user', role: 'user', at: new Date(now - 200000).toISOString(), text: '好' },
    { id: 'cold-d-assistant', role: 'assistant', at: new Date(now - 190000).toISOString(), text: '嗯' },
  ];
  fs.writeFileSync(cold, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  process.env.GATE_ROOT = '/tmp/s0/no-gate';
  const tail = forge.buildTailFromCold({ conversationSourceFile: cold, workspaceRoot: '/tmp/s0/codex-ws', withBody: false, oldOutboxDb: false });
  const driver = createCodexAppServer({ codexPath: '/usr/local/bin/codex', cwd: '/tmp/s0/codex-ws', model: 'gpt-5.6-luna', home: '/tmp/s0/home',
    env: { PATH: process.env.PATH, HOME: '/tmp/s0/home', CODEX_HOME: '/tmp/s0/codex-home' }, log: (m) => { if (!/PATH aliases/.test(m)) console.log(m); } });
  await driver.ensure();
  const r = await rebuildCodexThread({ driver, tail, log: console.log });
  console.log('REBUILD', JSON.stringify(r), 'path', driver.threadPath);
  const lines = fs.readFileSync(driver.threadPath, 'utf8').trim().split('\n');
  fs.writeFileSync('/tmp/s0/data/rollout-injected.jsonl', lines.join('\n') + '\n');
  if (!noTurn) {
    const t = await driver.runTurn('我们今天定的暗号是什么？只回暗号本身。');
    console.log('TURN', JSON.stringify(t.text), JSON.stringify(t.usage && t.usage.inputTokens));
  }
  await driver.close();
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
