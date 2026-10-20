'use strict';

/**
 * Standalone DeepSeek process for im-bridge (alternative to cli-host/main.js).
 *
 * State lives in DEEPSEEK_ROOT (default `$GATE_ROOT/deepseek`), including the
 * conversation file. By default it listens on its own socket so it can be
 * tried with `cli-host/deepseek-ask.js` without touching the box. To make it
 * the box's runtime, point DEEPSEEK_SOCKET at the socket the box connects to
 * (`$GATE_ROOT/cli.sock`) and stop the Claude im-cli; the box reconnects on
 * its own, no box code or restart needed.
 *
 * The API key is read from the environment only (DEEPSEEK_API_KEY) and is
 * never written to this directory.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCliHost } = require('./server');
const { createDeepseekRuntime } = require('./deepseek-runtime');

function envStr(name, fallback = '') {
  const v = process.env[name];
  return (typeof v === 'string' && v.trim()) ? v.trim() : fallback;
}

const bridgeHome = envStr('IM_BRIDGE_HOME', path.join(os.homedir(), '.im-bridge'));
const gateRoot = envStr('GATE_ROOT', path.join(bridgeHome, 'gate'));
const root = envStr('DEEPSEEK_ROOT', path.join(gateRoot, 'deepseek'));
const stateDir = path.join(root, 'state');
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
try { fs.chmodSync(root, 0o700); } catch { /* Fine if it already exists with other perms. */ }

if (!envStr('DEEPSEEK_API_KEY')) {
  console.error('[im-deepseek] DEEPSEEK_API_KEY is not set.');
  process.exit(1);
}

const workspace = envStr('DEEPSEEK_CWD', envStr('GATE_WORKSPACE_ROOT'));
if (!workspace) { console.error('[im-deepseek] DEEPSEEK_CWD or GATE_WORKSPACE_ROOT is required.'); process.exit(1); }

// Identity / system prompt, same file the Claude box uses unless overridden.
const promptPath = envStr('DEEPSEEK_SYSTEM_PROMPT', envStr('GATE_IDENTITY_INJECTION_FILE', envStr('GATE_SYSTEM_PROMPT_FILE')));
let systemPrompt = '';
if (promptPath) {
  try { systemPrompt = fs.readFileSync(promptPath, 'utf8'); }
  catch (error) { console.error('[im-deepseek] cannot read system prompt (' + promptPath + '):', error.message); }
}

const coldFile = envStr('DEEPSEEK_COLD_FILE');
const socketPath = envStr('DEEPSEEK_SOCKET', path.join(root, 'deepseek.sock'));
const ingressPath = envStr('DEEPSEEK_INGRESS', path.join(stateDir, 'ingress.json'));

const host = createCliHost({
  socketPath,
  ingressPath,
  // No claude CLI is spawned; the path is a placeholder.
  claudePath: '/usr/bin/true',
  scope: envStr('DEEPSEEK_SCOPE', 'deepseek'),
  fallbackEnsure: () => ({
    workspaceRoot: workspace,
    ingressPath,
    sdkOptions: { systemPrompt },
  }),
  runtimeFactory(cfg) {
    const given = cfg.sdkOptions || {};
    return createDeepseekRuntime({
      ...cfg,
      cwd: cfg.cwd || workspace,
      coldFile,
      threadFile: path.join(stateDir, 'deepseek-thread.json'),
      sdkOptions: { ...given, systemPrompt: given.systemPrompt || systemPrompt },
    });
  },
});

let shuttingDown = false;
async function bye(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[im-deepseek] received ${sig}; stopping`);
  try { await host.shutdown(); }
  catch (error) { console.error('[im-deepseek] shutdown failed:', error.message); }
  process.exit(0);
}
process.on('SIGTERM', () => bye('SIGTERM'));
process.on('SIGINT', () => bye('SIGINT'));
process.on('unhandledRejection', (error) => {
  console.error('[im-deepseek] unhandled rejection (process remains alive):', error && error.message ? error.message : error);
});

host.listen()
  .then(() => console.log('[im-deepseek] listening on ' + socketPath + ' cwd=' + workspace))
  .catch((error) => { console.error('[im-deepseek] startup failed:', error); process.exit(1); });
