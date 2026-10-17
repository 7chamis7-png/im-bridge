'use strict';

/**
 * Standalone persistent Codex process for im-bridge.
 *
 * 家在 CODEX_ROOT（默认 GATE_ROOT）。threadId 落在那儿的 state/。
 * 要接盒子时，CODEX_SOCKET（默认 GATE_BOX_SOCKET）指到盒子在听的那只 sock。
 * 不起 claude —— claudePath 给 /usr/bin/true 占位；底座是 codex app-server。
 *
 * 钥匙：codex 走 ~/.codex/auth.json（ChatGPT 订阅），不从 env 借 key。
 * 钱的硬闸在 codex-runtime.js 的 assertSubscription：auth_mode 不是 chatgpt 就当场停。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCliHost } = require('./server');
const { createCodexRuntime } = require('./codex-runtime');

function envStr(name, fallback = '') {
  const v = process.env[name];
  return (typeof v === 'string' && v.trim()) ? v.trim() : fallback;
}

const home = envStr('CODEX_HOME_DIR', os.homedir());
const bridgeHome = envStr('IM_BRIDGE_HOME', path.join(home, '.im-bridge'));
const gateRoot = envStr('GATE_ROOT', path.join(bridgeHome, 'gate'));
const root = envStr('CODEX_ROOT', gateRoot);
const stateDir = path.join(root, 'state');
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

// 这是 cli-host 那一层：盒子来连「我」。监听 cli.sock（跟 box-runtime 连的 ROSE_CLI_SOCKET/$GATE_ROOT/cli.sock 对齐），
// 不是 box.sock（那是盒子监听、gate 去连的）。
const socketPath = envStr('CODEX_SOCKET', envStr('ROSE_CLI_SOCKET', path.join(gateRoot, 'cli.sock')));

const workspace = envStr('GATE_WORKSPACE_ROOT', envStr('CODEX_CWD'));
if (!workspace) { console.error('[im-codex] GATE_WORKSPACE_ROOT or CODEX_CWD is required.'); process.exit(1); }

const authFile = envStr('CODEX_AUTH_FILE', path.join(home, '.codex', 'auth.json'));
const codexPath = envStr('CODEX_COMMAND', envStr('GATE_CODEX_COMMAND', 'codex'));

// 身份底座：喂给 codex 当 developerInstructions。
const injectionFile = envStr('GATE_IDENTITY_INJECTION_FILE', envStr('GATE_SYSTEM_PROMPT_FILE'));
let systemPrompt = '';
if (injectionFile) {
  try { systemPrompt = fs.readFileSync(injectionFile, 'utf8'); }
  catch (error) { console.error('[im-codex] cannot read identity/system prompt (' + injectionFile + '):', error.message); }
}

// 生产台账（盒子跟插头共用的那本）；没配就用自己 state 里的。
const ingressPath = envStr('CODEX_INGRESS', path.join(stateDir, 'ingress.json'));

const host = createCliHost({
  socketPath,
  ingressPath,
  claudePath: '/usr/bin/true',
  scope: envStr('CODEX_SCOPE', 'codex'),
  fallbackEnsure: () => ({
    workspaceRoot: workspace,
    ingressPath,
    sdkOptions: { systemPrompt },
  }),
  runtimeFactory(cfg) {
    const given = cfg.sdkOptions || {};
    return createCodexRuntime({
      ...cfg,
      cwd: cfg.cwd || workspace,
      threadFile: envStr('CODEX_THREAD_FILE', path.join(stateDir, 'codex-thread.json')),
      authFile, codexPath, home,
      sdkOptions: { ...given, systemPrompt: given.systemPrompt || systemPrompt },
    });
  },
});

let shuttingDown = false;
async function bye(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[im-codex] received ${sig}; stopping`);
  try { await host.shutdown(); }
  catch (error) { console.error('[im-codex] shutdown failed:', error.message); }
  process.exit(0);
}
process.on('SIGTERM', () => bye('SIGTERM'));
process.on('SIGINT', () => bye('SIGINT'));
process.on('unhandledRejection', (error) => {
  console.error('[im-codex] unhandled rejection (process remains alive):', error && error.message ? error.message : error);
});

host.listen()
  .then(() => console.log('[im-codex] listening on ' + socketPath + ' cwd=' + workspace))
  .catch((error) => { console.error('[im-codex] startup failed:', error); process.exit(1); });
