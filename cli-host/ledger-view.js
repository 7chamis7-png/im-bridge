'use strict';

/**
 * Read-only view of the ingress ledger, used by the box.
 *
 * Why not createIngress(): runtime/ingress.js assumes exactly one live owner per file.
 * The CLI host is that owner; a second instance in the box would split the ledger.
 *
 * So this only reads the file - no ownership, no caching. It is safe because ingress writes
 * via ".tmp -> fsync -> rename", and rename is atomic on one filesystem: a reader always sees
 * a complete snapshot.
 *
 * Returned shapes match ingress.get()/list() exactly.
 */

const fs = require('node:fs');

function readRecords(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return [];   // CLI never started yet: empty ledger, not an error
    throw e;
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) {
    // Should be impossible (rename is atomic); report clearly if it happens.
    throw new Error(`台账 ${filePath} 读出来不是完整 JSON：${e.message}`);
  }
  return Array.isArray(parsed?.records) ? parsed.records : [];
}

function createLedgerView({ filePath }) {
  if (!filePath) throw new Error('要给台账路径。');
  return {
    get(uuid) {
      return readRecords(filePath).find((r) => r.uuid === uuid);
    },
    list(state, scope) {
      return readRecords(filePath).filter((row) =>
        (state === undefined || row.state === state) &&
        (scope === undefined || row.scope === scope));
    },
  };
}

module.exports = { createLedgerView, readRecords };
