'use strict';

/**
 * Process entry for im-box: the box that owns the agent session.
 *
 * It swaps the claudecode runtime factory for the im-bridge runtime adapter (official
 * Agent SDK via the im-cli host). Everything else (sockets, ledger, persona) is the box's own.
 */

const main = require('../src/host/main');
const { createImBridgeRuntimeAdapter } = require('../adapters/box-runtime');

main.BOXES.claudecode = {
  ...main.BOXES.claudecode,
  runtime: (cfg) => createImBridgeRuntimeAdapter(cfg),
};
console.log('[im-bridge] box CLI layer: im-bridge runtime (official SDK)');

require('../src/host/box-host').main()
  .catch((e) => { console.error('[im-box] failed to start:', e); process.exit(1); });
