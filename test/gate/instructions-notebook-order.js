"use strict";
// The "## PENDING PROMISES" section is rendered by an optional external notebook
// module (AGENT_NOTEBOOK_MODULE / config.notebookModule) and passed through
// verbatim. This test uses a stub module written to a temp dir.
// Checks: ① empty notebook → no empty header ② content passed through in order
// ③ notebookFile is forwarded ④ no module configured → no section, no crash.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildOpeningTurnText } = require("../../src/box/instructions");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "instructions-nb-"));
const NOTEBOOK_MODULE = path.join(tmp, "notebook-stub.js");
fs.writeFileSync(NOTEBOOK_MODULE, `
const fs = require("fs");
exports.render = ({ file } = {}) => {
  const items = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!items.length) return "";
  return items.map((it) => "### " + it.board + "\\n- " + it.title).join("\\n\\n");
};
`);

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => {
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : "  " + extra));
  ok ? pass++ : fail++;
};

console.log("[1] empty notebook → no PENDING PROMISES section");
{
  const nbFile = path.join(tmp, "empty.json");
  fs.writeFileSync(nbFile, "[]");
  const text = buildOpeningTurnText({ notebookModule: NOTEBOOK_MODULE, notebookFile: nbFile }, "hello");
  check("no header", !text.includes("## PENDING PROMISES"), text);
}

console.log("[2] notebook output is passed through verbatim, in order");
{
  const nbFile = path.join(tmp, "full.json");
  fs.writeFileSync(nbFile, JSON.stringify([
    { board: "pinned", title: "pinned entry" },
    { board: "now", title: "current entry" },
    { board: "intent", title: "intent entry" },
  ]));
  const text = buildOpeningTurnText({ notebookModule: NOTEBOOK_MODULE, notebookFile: nbFile }, "hello");
  check("section present", text.includes("## PENDING PROMISES"), text);
  const section = text.split("## PENDING PROMISES")[1].split("\n\n## ")[0];
  const a = section.indexOf("pinned entry"), b = section.indexOf("current entry"), c = section.indexOf("intent entry");
  check("order preserved", a >= 0 && a < b && b < c, section);
  check("user message last", text.trim().endsWith("hello"), text);
}

console.log("[3] no module configured → no section, no crash");
{
  const saved = process.env.AGENT_NOTEBOOK_MODULE;
  delete process.env.AGENT_NOTEBOOK_MODULE;
  const text = buildOpeningTurnText({}, "hello");
  check("no header", !text.includes("## PENDING PROMISES"), text);
  if (saved !== undefined) process.env.AGENT_NOTEBOOK_MODULE = saved;
}

console.log("[4] module that fails to load → section empty, no crash");
{
  const text = buildOpeningTurnText({ notebookModule: path.join(tmp, "missing.js") }, "hello");
  check("no header", !text.includes("## PENDING PROMISES"), text);
}

console.log(`\npassed ${pass} / failed ${fail}`);
process.exit(fail ? 1 : 0);
