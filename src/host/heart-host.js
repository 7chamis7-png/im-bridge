"use strict";

/**
 * heart process (im-heart): assembles paths, sets up the beats, runs them.
 * No policy lives here — timing and content decisions are inside each beat
 * (`src/heart/beats/`).
 *
 * Beats:
 *   · check-in  always on (idle-triggered invitation notes)
 *   · reminder  only when GATE_REMINDER_QUEUE_FILE is set
 *
 * Manual firing:
 *   node src/host/heart-host.js --once reminder
 *   node src/host/heart-host.js --once check-in --dir /tmp/checkin-test   # drop into a temp dir
 */

const fs = require("fs");
const path = require("path");
const { makeHeart } = require("../heart/heart");
const { makeCheckinBeat } = require("../heart/beats/checkin");
const { makeReminderBeat } = require("../heart/beats/reminder");
const { bridgeHome, homePath } = require("../core/paths");

function log(line) {
  console.log(new Date().toISOString().slice(11, 19) + " | " + line);
}

function readArgs(argv) {
  const out = { once: "", dir: "" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--once") { out.once = argv[i + 1] || "*"; i += 1; }
    else if (argv[i] === "--dir") { out.dir = argv[i + 1] || ""; i += 1; }
  }
  return out;
}

function buildHeart({ env = process.env, dirOverride = "" } = {}) {
  const root = env.GATE_ROOT || homePath("gate");
  // Directory for check-in config / texts / state (defaults to IM_BRIDGE_HOME).
  const stateDir = env.AGENT_STATE_DIR || bridgeHome(env);
  const dir = dirOverride || env.GATE_PRODUCERS_DIR || path.join(root, "producers");

  const beats = [
    makeCheckinBeat({
      dir,
      configFile: env.GATE_CHECKIN_CONFIG_FILE || path.join(stateDir, "checkin-config.json"),
      textsFile: env.GATE_CHECKIN_TEXTS_FILE || path.join(stateDir, "checkin-texts.md"),
      stateFile: env.GATE_CHECKIN_STATE_FILE || path.join(stateDir, "checkin-state.json"),
      coldFile: env.GATE_COLD_FILE || path.join(root, "cold.jsonl"),
      notebookModule: env.AGENT_NOTEBOOK_MODULE || "",
      notebookFile: env.AGENT_NOTEBOOK_FILE || "",
      drivesUrl: env.GATE_CHECKIN_DRIVES_URL || "",
      log,
    }),
  ];
  if (String(env.GATE_REMINDER_QUEUE_FILE || "").trim()) {
    beats.push(makeReminderBeat({
      dir,
      queueFile: env.GATE_REMINDER_QUEUE_FILE,
      firedFile: env.GATE_REMINDER_FIRED_FILE || path.join(root, "heart-fired.json"),
      staleAfterMs: Number(env.GATE_REMINDER_STALE_MS || 0) || undefined,
      log,
    }));
  }

  return { heart: makeHeart({ beats, log }), root, dir, beatNames: beats.map((b) => b.name) };
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const { heart, root, dir, beatNames } = buildHeart({ dirOverride: args.dir });

  if (args.once) {
    const names = args.once === "*" ? beatNames : [args.once];
    for (const n of names) log(n + " → " + JSON.stringify(await heart.tickOnce(n)));
    return;
  }

  log("producers dir: " + dir);
  // Per-beat stats for operators (not shown to the agent).
  const beatFile = process.env.GATE_HEART_FILE || path.join(root, "heart.json");
  const beatTimer = setInterval(() => {
    try {
      fs.writeFileSync(beatFile, JSON.stringify({ at: new Date().toISOString(), books: heart.books() }, null, 1));
    } catch (e) { log("cannot write heart file: " + e.message); }
  }, 30_000);

  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      log("received " + sig + ", stopping");
      clearInterval(beatTimer);
      heart.stop();
      process.exit(0);
    });
  }
  await heart.run();
}

if (require.main === module) {
  main().catch((e) => {
    log("failed to start: " + ((e && e.stack) || e));
    process.exit(1);
  });
}

module.exports = { buildHeart };
