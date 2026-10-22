'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { extractTurnInput } = require('../../cli-host/codex-runtime');

test('converts Claude-style base64 images to Codex localImage items', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-image-'));
  try {
    const input = extractTurnInput({ message: { content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from('jpeg-bytes').toString('base64') } },
      { type: 'text', text: 'look at this' },
    ] } }, dir);
    assert.equal(input.length, 2);
    assert.equal(input[0].type, 'localImage');
    assert.equal(path.dirname(input[0].path), dir);
    assert.deepEqual(fs.readFileSync(input[0].path), Buffer.from('jpeg-bytes'));
    assert.deepEqual(input[1], { type: 'text', text: 'look at this' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('keeps text compatibility and ignores unsupported image media', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-image-'));
  try {
    assert.deepEqual(extractTurnInput({ message: { content: ' hello ' } }, dir), [
      { type: 'text', text: 'hello' },
    ]);
    assert.deepEqual(extractTurnInput({ message: { content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: 'PHN2Zz4=' } },
    ] } }, dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
