"use strict";
// Expired-notebook line in the check-in header: expiredNotebookLine() + optional
// listExpired() on the notebook module. Uses a stub module in a temp dir.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { expiredNotebookLine, makeCheckinBeat } = require("../../src/heart/beats/checkin");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "checkin-expiry-"));

// Stub store: entries {title, expires:"YYYY-MM-DD"}; listExpired returns past-due ones.
const storeModule = path.join(tmp, "stub-store.js");
fs.writeFileSync(storeModule, `
const fs = require("fs");
const read = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; } };
exports.list = ({ file }) => read(file);
exports.listExpired = ({ file }) => {
  const today = new Date().toISOString().slice(0, 10);
  return read(file).filter((e) => e.expires && e.expires < today);
};
`);
const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => {
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : "  " + extra));
  ok ? pass++ : fail++;
};

console.log("[1] nothing expired → empty string");
{
  const nbFile = path.join(tmp, "none-expired.json");
  fs.writeFileSync(nbFile, JSON.stringify([{ title: "not yet", expires: future }]));
  const line = expiredNotebookLine({ moduleId: storeModule, file: nbFile });
  check("empty", line === "", line);
}

console.log("[2] expired items → one line, at most 4 titles");
{
  const nbFile = path.join(tmp, "expired.json");
  fs.writeFileSync(nbFile, JSON.stringify(Array.from({ length: 5 }, (_, i) => ({ title: "item" + i, expires: "2020-01-01" }))));
  const line = expiredNotebookLine({ moduleId: storeModule, file: nbFile });
  check("count prefix", line.startsWith("5 notebook item(s) expired: "), line);
  check("question suffix", line.endsWith("— extend or close?"), line);
  const titleCount = (line.match(/“item\d”/g) || []).length;
  check("at most 4 titles", titleCount === 4, String(titleCount));
}

console.log("[3] missing module / no listExpired → empty, no throw");
{
  const l1 = expiredNotebookLine({ moduleId: "/nonexistent/store", file: "x" });
  check("missing module", l1 === "", l1);
  const fake = path.join(tmp, "fake-store.js");
  fs.writeFileSync(fake, "module.exports = { list: () => [] };\n");
  const l2 = expiredNotebookLine({ moduleId: fake, file: "x" });
  check("no listExpired", l2 === "", l2);
  const l3 = expiredNotebookLine({ moduleId: "", file: "x" });
  check("not configured", l3 === "", l3);
}

async function main() {
  console.log("[4] wired through makeCheckinBeat: the line appears in the header");
  {
    const nbFile = path.join(tmp, "beat.json");
    fs.writeFileSync(nbFile, JSON.stringify([{ title: "overdue", expires: "2020-01-01" }]));
    const dir = fs.mkdtempSync(path.join(tmp, "producers-"));
    const beat = makeCheckinBeat({
      dir, configFile: path.join(tmp, "nope-cfg.json"), textsFile: path.join(tmp, "nope-texts.md"),
      coldFile: path.join(tmp, "nope-cold.jsonl"), notebookModule: storeModule, notebookFile: nbFile,
      clock: { nextDelayMs: () => 0, isDue: () => true, fired() {}, peek: () => ({}) },
    });
    assert.strictEqual(beat.name, "check-in");
    await beat.tick();
    const f = fs.readdirSync(dir)[0];
    const text = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).text;
    check("line present", text.includes("1 notebook item(s) expired: “overdue”"), text);
    check("line is in the header (before the body)", text.indexOf("notebook item(s) expired") < text.indexOf("\n\n"), text);
  }

  console.log(`\npass ${pass} / fail ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
