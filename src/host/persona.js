"use strict";

/**
 * Persona — the "what to inject" half of an agent.
 *
 * The bridge and host are persona-agnostic: they receive, queue and deliver.
 * Who the agent is, what it remembers and how it relates to the owner all live
 * in the persona that is injected at the start of each session.
 *
 *   persona (who)  +  box / runtime (which engine)  =  one agent
 *
 * The box decides HOW to inject (opening turn, resume, …); the persona only
 * answers WHAT to inject. The contract is a single shape:
 *
 *     { name: string, async opening(ctx): string }
 *
 * `ctx` is material supplied by the host:
 *     { reason: "fresh"|"rotate", userText, coldTail(n), handoff }
 * The persona decides ordering, quotas and labels.
 *
 * `opening()` is called again for every new session and reads its sources
 * fresh, so edits take effect on the next session without a restart.
 *
 * See examples/persona/ for a minimal directory persona.
 */

const fs = require("fs");
const path = require("path");

/**
 * A directory persona: concatenate the files in the directory, sorted by file
 * name (prefix names with numbers to control order). Add a file to add a
 * section; delete it to remove one. Live data (memory, diary, …) belongs in a
 * .js persona module instead (see loadPersona).
 *
 * @param {object} o
 * @param {string} o.dir
 * @param {string} [o.name]
 * @param {string[]} [o.exts] accepted extensions, default .md / .txt
 */
function makeFilePersona({ dir, name = "", exts = [".md", ".txt"] } = {}) {
  if (!String(dir || "").trim()) throw new Error("file persona requires a directory");
  return {
    name: name || path.basename(dir),
    async opening() {
      let files;
      try {
        files = fs.readdirSync(dir);
      } catch (e) {
        // A missing directory is a config error: say so instead of silently
        // starting an agent with no identity.
        throw new Error("persona directory unreadable: " + dir + " (" + ((e && e.code) || e) + ")");
      }
      const picked = files
        .filter((f) => exts.includes(path.extname(f).toLowerCase()))
        .sort();
      const parts = [];
      for (const f of picked) {
        const body = fs.readFileSync(path.join(dir, f), "utf8").trim();
        if (body) parts.push(body);
      }
      return parts.join("\n\n");
    },
  };
}

/** Validate a persona object; fail at wiring time, not at the first turn. */
function assertPersona(p) {
  if (!p || typeof p !== "object") throw new Error("persona is not an object");
  if (!String(p.name || "").trim()) throw new Error("persona has no name");
  if (typeof p.opening !== "function") throw new Error("persona must provide opening()");
  return p;
}

/**
 * Load a persona from config (GATE_PERSONA). Two forms:
 *
 *   a directory → files concatenated in name order (static)
 *   a .js file  → required; exports { name, opening } (or a factory / { persona })
 *
 * Empty spec = no persona. The pipeline still runs (useful for tests and
 * plumbing checks); the agent just starts without an injected identity.
 */
function loadPersona(spec, { name = "" } = {}) {
  const s = String(spec || "").trim();
  if (!s) return null;
  const abs = path.resolve(s);
  let st;
  try {
    st = fs.statSync(abs);
  } catch (e) {
    throw new Error("persona path does not exist: " + abs + " (" + ((e && e.code) || e) + ")");
  }
  if (st.isDirectory()) return assertPersona(makeFilePersona({ dir: abs, name }));
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const mod = require(abs);
  const p = typeof mod === "function" ? mod() : (mod.persona || mod);
  return assertPersona(p);
}

module.exports = { loadPersona, makeFilePersona, assertPersona };
