#!/usr/bin/env node
'use strict';

// Only stdin/stdout + caller-supplied temporary files. No SDK, model, network or real CLI.
const fs = require('node:fs');
const readline = require('node:readline');
const script = JSON.parse(fs.readFileSync(process.env.IM_BRIDGE_FAKE_SCRIPT, 'utf8'));
let turn = 0;
let lastUuid;
let initialized = false;
let ended = false;
if (script.ignoreStop) setInterval(() => {}, 1000);
function emit(frame) { process.stdout.write(JSON.stringify(frame) + '\n'); }
function trace(value) { fs.appendFileSync(script.tracePath, JSON.stringify(value) + '\n'); }
function substitute(value, uuid) {
  if (typeof value === 'string') return value.replaceAll('$UUID', uuid).replaceAll('$SESSION', 'fake-session');
  if (Array.isArray(value)) return value.map((item) => substitute(item, uuid));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, uuid)]));
  return value;
}
function init() {
  if (!initialized && script.init) { initialized = true; emit(script.init); }
}
function finish() {
  if (ended || script.ignoreStop) return;
  ended = true;
  for (const frame of script.tail ?? []) emit(substitute(frame, lastUuid));
  process.stdout.write('', () => process.exit(script.exitCode ?? 0));
}
trace({ type: 'spawn', pid: process.pid, args: process.argv.slice(2) });
process.on('SIGTERM', finish);
const lines = readline.createInterface({ input: process.stdin });
lines.on('close', finish);
lines.on('line', (line) => {
  const value = JSON.parse(line);
  if (value.type === 'control_request') {
    trace(value);
    const subtype = value.request.subtype;
    const response = subtype === 'initialize' ? { commands: [], models: [], account: {} } : {};
    emit({ type: 'control_response', response: {
      request_id: value.request_id,
      subtype: subtype === 'set_model' && script.rejectModel ? 'error' : 'success',
      ...(subtype === 'set_model' && script.rejectModel ? { error: '假 CLI 拒绝换模型' } : { response }),
    } });
    if (subtype === 'initialize' && !script.initOnUser) init();
  } else if (value.type === 'user') {
    lastUuid = value.uuid;
    const snapshot = JSON.parse(fs.readFileSync(script.ingressPath, 'utf8'));
    trace({ type: 'received', message: value, rows: snapshot.records });
    init();
    for (const frame of script.turns[turn++] ?? []) emit(substitute(frame, value.uuid));
    if (script.exitAfterTurn) finish();
  }
});
