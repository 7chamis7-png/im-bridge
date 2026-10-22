'use strict';

/**
 * 单独的 DeepSeek 进程（pm2: nova-deepseek，10-03 试过一次，现在不在跑）。
 *
 * 2026-10-21 S5：Nova要用 DeepSeek 不用再起这个进程了 —— nova-cli 自己就能换到 openai-chat 插头（/engine）。
 * 这个入口留着给「单独起一只 DeepSeek 接现成盒子」那种试验用，默认插头 openai-chat，也能换芯。
 *
 * 钥匙：**只从 /root/.secrets/<名字>.secret 读**（名字 = DEEPSEEK_SECRET，默认 deepseek）。
 * 原来这里会去 nova-cli 进程的 environ 和 pm2 的存档文件里「借」钥匙 —— 删了：
 * 钥匙放哪由Alice定（/root/.secrets），别的进程的环境不是钥匙柜。
 */

const fs = require('node:fs');
const path = require('node:path');
const { createCliHost } = require('./server');
const { createEngineFactories, readSecret } = require('./engines');
const { readPersonaSpec, personaConfigPath } = require('../src/host/persona-file');

const { gateRoot } = require('../src/core/paths');

// 2026-10-22 数据隔离：这几样必须显式给，不再回落 ~/.nova-deepseek / ~/nova（= Nova的目录）
const need = (k, ...alts) => { for (const n of [k, ...alts]) { const v = String(process.env[n] || '').trim(); if (v) return v; }
  console.error(`[deepseek] 没设 ${[k, ...alts].join(' / ')} —— 不回落到别人的目录`); process.exit(2); };
const root = need('DEEPSEEK_ROOT');
const stateDir = path.join(root, 'state');
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
try { fs.chmodSync(root, 0o700); } catch { /* 已经在也没关系 */ }

// 起之前就验一下钥匙在不在（只验在不在，值不打印）
try { readSecret(process.env.DEEPSEEK_SECRET || 'deepseek'); }
catch (error) {
  console.error(`[nova-deepseek] ${error.message}。不猜，也不从别的进程借。`);
  process.exit(1);
}

const promptPath = need('DEEPSEEK_SYSTEM_PROMPT', 'GATE_SYSTEM_PROMPT_FILE');
let systemPrompt = '';
try { systemPrompt = fs.readFileSync(promptPath, 'utf8'); }
catch (error) { console.error('[nova-deepseek] 系统提示读不到：', error.message); }

const workspace = need('DEEPSEEK_CWD', 'GATE_WORKSPACE_ROOT');
const productionIngress = path.join(gateRoot(), 'state', 'im-bridge-ingress.json');

const factories = createEngineFactories({ env: process.env, stateDir, workspace, requireCodexHome: true });
const openai = factories['openai-chat'];
factories['openai-chat'] = (cfg) => {
  const given = cfg.sdkOptions || {};
  return openai({ ...cfg, sdkOptions: { ...given, systemPrompt: given.systemPrompt || systemPrompt } });
};

const host = createCliHost({
  // 人格文件由桥来交（见 src/host/persona-file.js）；deepseek-runtime 自己也会拼 cwd 里的 CLAUDE.md，
  // 所以登记的引擎名是 deepseek（双份检查按它算）。
  engine: 'deepseek',
  personaSpec: () => readPersonaSpec(personaConfigPath()),
  socketPath: process.env.DEEPSEEK_SOCKET || path.join(root, 'deepseek.sock'),
  ingressPath: path.join(stateDir, 'ingress.json'),
  claudePath: process.env.NOVA_CLI_PATH || '/usr/bin/claude',
  scope: 'deepseek',
  fallbackEnsure: () => ({
    workspaceRoot: workspace,
    ingressPath: productionIngress,
    sdkOptions: { systemPrompt },
  }),
  engines: factories,
});

let shuttingDown = false;
async function bye(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[nova-deepseek] 收到 ${sig}，正在停…`);
  try { await host.shutdown(); }
  catch (error) { console.error('[nova-deepseek] 停的时候出错：', error.message); }
  process.exit(0);
}
process.on('SIGTERM', () => bye('SIGTERM'));
process.on('SIGINT', () => bye('SIGINT'));
process.on('unhandledRejection', (error) => {
  console.error('[nova-deepseek] 未处理的 rejection（继续跑）：', error && error.message ? error.message : error);
});

host.listen()
  .then(() => console.log('[nova-deepseek] 起来了。听 ' + (process.env.DEEPSEEK_SOCKET || path.join(root, 'deepseek.sock'))))
  .catch((error) => { console.error('[nova-deepseek] 起不来：', error); process.exit(1); });
