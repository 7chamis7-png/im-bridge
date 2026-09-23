"use strict";
// check-in {pending} supply chain: titles come only from the optional notebook module
// (AGENT_NOTEBOOK_MODULE). A stub module in a temp dir stands in for a real notebook.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { notebookTitles, makeCheckinBeat } = require("../../src/heart/beats/checkin");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heart-nb-"));
const nbFile = path.join(tmp, "notebook.json");

// Minimal notebook store: list({file}) reads a JSON array of entries.
const storeModule = path.join(tmp, "stub-store.js");
fs.writeFileSync(storeModule, `
const fs = require("fs");
exports.KIND_ORDER = { promise: 0, thread: 1 };
exports.list = ({ file }) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; } };
`);

// 1. empty notebook → no titles
assert.deepStrictEqual(notebookTitles({ moduleId: storeModule, file: nbFile }), []);
// 2. module that can't be loaded → no throw, empty
assert.deepStrictEqual(notebookTitles({ moduleId: "/nonexistent/store", file: nbFile }), []);
// 3. no module configured → feature off
assert.deepStrictEqual(notebookTitles({ moduleId: "", file: nbFile }), []);

// 4. titles only (no other fields), "watching" marker, promise sorted before thread
fs.writeFileSync(nbFile, JSON.stringify([
  { title: "thread item", kind: "thread", state: "watching", last: "should not appear" },
  { title: "promise item", kind: "promise", last: "should not appear either" },
]));
const titles = notebookTitles({ moduleId: storeModule, file: nbFile });
assert.deepStrictEqual(titles, ["promise item", "thread item (watching)"], "promise before thread");
assert.ok(!titles.join("").includes("should not appear"), "only titles");

// 5. the beat builds with the module configured
const beat = makeCheckinBeat({
  dir: tmp, configFile: path.join(tmp, "nope.json"), coldFile: path.join(tmp, "cold.jsonl"),
  notebookModule: storeModule, notebookFile: nbFile,
});
assert.strictEqual(beat.name, "check-in");

// 6. {pending} reaches the header when the template references it
(async () => {
  const texts = path.join(tmp, "texts.md");
  fs.writeFileSync(texts, "## header\nH\nOpen items: {pending}\n");
  const dir = fs.mkdtempSync(path.join(tmp, "out-"));
  const b = makeCheckinBeat({
    dir, configFile: path.join(tmp, "nope.json"), textsFile: texts, coldFile: path.join(tmp, "cold.jsonl"),
    notebookModule: storeModule, notebookFile: nbFile, rand: () => 0.01,
    clock: { nextDelayMs: () => 0, isDue: () => true, fired() {}, peek: () => ({}) },
  });
  await b.tick();
  const text = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), "utf8")).text;
  assert.ok(text.includes("Open items: “promise item”, “thread item (watching)”"), text);

  // 7. emptied notebook → the line disappears
  fs.writeFileSync(nbFile, "[]");
  assert.deepStrictEqual(notebookTitles({ moduleId: storeModule, file: nbFile }), []);

  console.log("heart-checkin-notebook: ok");
})().catch((e) => { console.error(e); process.exit(1); });
