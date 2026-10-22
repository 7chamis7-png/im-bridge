'use strict';

/**
 * nova-cli 的进程入口（pm2 跑这个）。
 *
 * 这个文件要**尽量少改** —— 它一重启就打断他，整件拆分的意义就在于
 * 让「天天要改的东西」（盒子、插头、路由）和「他本人」分到两个进程里。
 * 有新需求先问一句：能不能放到 nova-box 那头去？能就别写在这儿。
 */

const path = require('node:path');
const { createCliHost } = require('./server');
const { createEngineFactories } = require('./engines');
const { readPersonaSpec, personaConfigPath } = require('../src/host/persona-file');

// 桥状态目录。nova-env.sh 里它叫 GATE_ROOT（不是 GATE_STATE_DIR —— 写这个文件时我猜错过一次）。
const stateDir = process.env.GATE_ROOT || process.env.NOVA_STATE_DIR || '';
if (!stateDir) {
  console.error('[nova-cli] 没有 GATE_ROOT，不猜默认位置。先 source nova-env.sh。');
  process.exit(1);
}

const host = createCliHost({
  // socket 跟 box.sock / tools.sock 一起住 GATE_ROOT 根下
  socketPath: process.env.NOVA_CLI_SOCKET || path.join(stateDir, 'cli.sock'),
  // ⚠️ 台账在 GATE_ROOT/**state**/ 底下，不在根下。这只是兜底：
  //    正常情况下盒子 ensure 时会把真实路径传过来。
  ingressPath: process.env.NOVA_CLI_INGRESS || path.join(stateDir, 'state', 'im-bridge-ingress.json'),
  claudePath: process.env.NOVA_CLI_PATH || '/usr/bin/claude',
  scope: process.env.NOVA_CLI_SCOPE || 'box',
  stopGraceMs: Number(process.env.NOVA_CLI_STOP_GRACE_MS || 3000),
  // 2026-10-21 人格文件由桥来交：人格配置（$GATE_ROOT/tools.json）里的 personaFile，起 CLI 时现读，
  // 拼在 nova-system-prompt.md（宣言）后面进系统提示。没写 personaFile = 老样子，CLI 自己读 CLAUDE.md。
  engine: 'claude',
  personaSpec: () => readPersonaSpec(personaConfigPath()),
  // 2026-10-21 S5 单宿主换芯：默认 claude，/engine 换舱时盒子会要 codex / openai-chat，宿主进程不重启。
  // Nova起 codex 必须有他自己的 CODEX_HOME（不能跟Iris共用 /root/.codex）。
  engines: createEngineFactories({
    env: process.env,
    stateDir: path.join(stateDir, 'state'),
    workspace: process.env.GATE_WORKSPACE_ROOT || '',
    requireCodexHome: true,
    identityInjectionFile: '',
  }),
});

let shuttingDown = false;
async function bye(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[nova-cli] 收到 ${sig}，正在停 CLI…`);
  try { await host.shutdown(); }
  catch (e) { console.error('[nova-cli] 停的时候出错：', e.message); }
  process.exit(0);
}
process.on('SIGTERM', () => bye('SIGTERM'));
process.on('SIGINT', () => bye('SIGINT'));

// 事件回调里的意外不该带崩整个宿主 —— 他住在这儿。
process.on('unhandledRejection', (e) => {
  console.error('[nova-cli] 未处理的 rejection（继续跑）：', e && e.message ? e.message : e);
});

host.listen()
  .then(() => console.log('[nova-cli] 起来了 —— 盒子现在可以随便重启了'))
  .catch((e) => { console.error('[nova-cli] 起不来：', e); process.exit(1); });
