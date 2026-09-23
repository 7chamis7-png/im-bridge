'use strict';

/**
 * Process entry for im-cli (the long-running Claude Code CLI host).
 *
 * Keep this file small and stable: restarting it interrupts the agent's session. The whole
 * point of the split is to keep frequently-changed code (box, plugins, routing) in other
 * processes. If a new feature can live in im-box, put it there.
 */

const path = require('node:path');
const { createCliHost } = require('./server');

// Bridge state directory (same GATE_ROOT the other processes use).
const stateDir = process.env.GATE_ROOT || process.env.AGENT_STATE_DIR || '';
if (!stateDir) {
  console.error('[im-cli] GATE_ROOT is not set; refusing to guess a default location.');
  process.exit(1);
}

const host = createCliHost({
  // The socket lives in GATE_ROOT next to box.sock / tools.sock.
  socketPath: process.env.AGENT_CLI_SOCKET || path.join(stateDir, 'cli.sock'),
  // The ledger lives under GATE_ROOT/state/. This is only a fallback:
  // normally the box passes the real path on `ensure`.
  ingressPath: process.env.AGENT_CLI_INGRESS || path.join(stateDir, 'state', 'im-bridge-ingress.json'),
  claudePath: process.env.AGENT_CLI_PATH || '/usr/bin/claude',
  scope: process.env.AGENT_CLI_SCOPE || 'box',
  stopGraceMs: Number(process.env.AGENT_CLI_STOP_GRACE_MS || 3000),
});

let shuttingDown = false;
async function bye(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[im-cli] got ${sig}, stopping CLI...`);
  try { await host.shutdown(); }
  catch (e) { console.error('[im-cli] error while stopping:', e.message); }
  process.exit(0);
}
process.on('SIGTERM', () => bye('SIGTERM'));
process.on('SIGINT', () => bye('SIGINT'));

// An unexpected error in an event callback must not take the host (and the session) down.
process.on('unhandledRejection', (e) => {
  console.error('[im-cli] unhandled rejection (continuing):', e && e.message ? e.message : e);
});

host.listen()
  .then(() => console.log('[im-cli] listening - the box can now be restarted freely'))
  .catch((e) => { console.error('[im-cli] failed to start:', e); process.exit(1); });
