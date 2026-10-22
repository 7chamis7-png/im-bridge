'use strict';

/**
 * Iris的引擎宿主（pm2: iris-cli）。默认插头是 codex app-server。
 *
 * 2026-10-21 S5：单宿主换芯（cli-host/engines.js）。默认 codex；/engine 换舱时盒子要 claude-cli / openai-chat，
 * 宿主进程不重启，停旧插头起新插头。原来这个入口只绑 codex 一根插头。
 *
 * 家在 CODEX_ROOT（默认 GATE_ROOT）。threadId 落在那儿的 state/。
 * 要接盒子时，CODEX_SOCKET（默认 GATE_BOX_SOCKET）指到盒子在听的那只 sock。
 *
 * 钥匙：codex 走 $CODEX_HOME/auth.json（ChatGPT 订阅；没设 CODEX_HOME = /root/.codex，今天的样子），不从 env 借 key。
 * 钱的硬闸在 codex-runtime.js 的 assertSubscription：auth_mode 不是 chatgpt 就当场停。
 */

const fs = require('node:fs');
const path = require('node:path');
const { createCliHost } = require('./server');
const { createEngineFactories } = require('./engines');
const { readPersonaSpec, personaConfigPath } = require('../src/host/persona-file');

function envStr(name, fallback = '') {
  const v = process.env[name];
  return (typeof v === 'string' && v.trim()) ? v.trim() : fallback;
}

const gateRoot = envStr('GATE_ROOT');
if (!gateRoot) { console.error('[codex-host] 没有 GATE_ROOT，不猜默认位置。先 source 这个人格的 env 文件。'); process.exit(1); }
const root = envStr('CODEX_ROOT', gateRoot);
const stateDir = path.join(root, 'state');
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

// 这是 cli-host 那一层：盒子来连「我」。监听 cli.sock（跟 box-runtime 连的 NOVA_CLI_SOCKET/$GATE_ROOT/cli.sock 对齐），
// 不是 box.sock（那是盒子监听、gate 去连的）。
const socketPath = envStr('CODEX_SOCKET', envStr('NOVA_CLI_SOCKET', path.join(gateRoot, 'cli.sock')));

const workspace = envStr('GATE_WORKSPACE_ROOT', envStr('CODEX_CWD'));
if (!workspace) { console.error('[iris-codex] 没有工作目录（GATE_WORKSPACE_ROOT / CODEX_CWD）。不猜，停。'); process.exit(1); }

// 生产台账（盒子跟插头共用的那本）；没配就用自己 state 里的。
const ingressPath = envStr('CODEX_INGRESS', path.join(stateDir, 'ingress.json'));

const host = createCliHost({
  socketPath,
  ingressPath,
  // 换到 claude 插头时要真的 claude（盒子 ensure 也会带 claudePath 过来）
  claudePath: envStr('NOVA_CLI_PATH', '/usr/bin/claude'),
  scope: 'codex',
  // 2026-10-21 人格文件由桥来交：人格配置里的 personaFile（Iris.md）在 server.js 里拼进
  // sdkOptions.systemPrompt；codex 自己会读工作目录的 AGENTS.md，双份检查按**当时那根插头**算。
  engine: 'codex',
  personaSpec: () => readPersonaSpec(personaConfigPath()),
  fallbackEnsure: () => ({
    workspaceRoot: workspace,
    ingressPath,
    sdkOptions: {},
  }),
  engines: createEngineFactories({
    env: process.env,
    stateDir,
    workspace,
    // Iris今天就在 /root/.codex 上，不强制（迁移步骤见设计稿 §9 / 报告）
    requireCodexHome: false,
    // 身份底座：喂给 codex 当 developerInstructions（每次起插头现读）
    identityInjectionFile: envStr('GATE_IDENTITY_INJECTION_FILE'),
  }),
});

let shuttingDown = false;
async function bye(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[iris-codex] 收到 ${sig}，正在停…`);
  try { await host.shutdown(); }
  catch (error) { console.error('[iris-codex] 停的时候出错：', error.message); }
  process.exit(0);
}
process.on('SIGTERM', () => bye('SIGTERM'));
process.on('SIGINT', () => bye('SIGINT'));
process.on('unhandledRejection', (error) => {
  console.error('[iris-codex] 未处理的 rejection（继续跑）：', error && error.message ? error.message : error);
});

host.listen()
  .then(() => console.log('[iris-codex] 起来了。听 ' + socketPath + '  cwd=' + workspace))
  .catch((error) => { console.error('[iris-codex] 起不来：', error); process.exit(1); });
