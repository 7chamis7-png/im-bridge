'use strict';

/**
 * Standalone persistent Codex process for im-bridge.
 *
 * State lives in CODEX_ROOT (default GATE_ROOT); the thread id is persisted
 * under its state/ directory. It listens on the socket the box connects to
 * (CODEX_SOCKET, default AGENT_CLI_SOCKET or `$GATE_ROOT/cli.sock`).
 * No claude CLI is spawned (claudePath is a `/usr/bin/true` placeholder); the
 * engine is `codex app-server`.
 *
 * Credentials: Codex uses `~/.codex/auth.json` (ChatGPT subscription); no API
 * key is taken from the environment. The billing guard is assertSubscription in
 * codex-runtime.js: anything other than auth_mode=chatgpt stops immediately.
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

// This is the cli-host layer: the box connects to us. Listen on cli.sock (the
// same AGENT_CLI_SOCKET / $GATE_ROOT/cli.sock that adapters/box-runtime.js
// connects to), not box.sock (which the box listens on and the gate connects to).
const socketPath = envStr('CODEX_SOCKET', envStr('AGENT_CLI_SOCKET', path.join(gateRoot, 'cli.sock')));

const workspace = envStr('GATE_WORKSPACE_ROOT', envStr('CODEX_CWD'));
if (!workspace) { console.error('[im-codex] GATE_WORKSPACE_ROOT or CODEX_CWD is required.'); process.exit(1); }

const authFile = envStr('CODEX_AUTH_FILE', path.join(home, '.codex', 'auth.json'));
const codexPath = envStr('CODEX_COMMAND', envStr('GATE_CODEX_COMMAND', 'codex'));

// Identity / system prompt, passed to Codex as developerInstructions.
const injectionFile = envStr('GATE_IDENTITY_INJECTION_FILE', envStr('GATE_SYSTEM_PROMPT_FILE'));
let systemPrompt = '';
if (injectionFile) {
  try { systemPrompt = fs.readFileSync(injectionFile, 'utf8'); }
  catch (error) { console.error('[im-codex] cannot read identity/system prompt (' + injectionFile + '):', error.message); }
}

// Ingress ledger; defaults to one in this process's own state directory.
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
