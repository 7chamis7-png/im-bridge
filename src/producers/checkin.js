"use strict";

/**
 * check-in producer — a timer that periodically drops an "invitation" note into
 * the producers drop directory. The bridge picks it up and delivers it to the
 * agent as a turn.
 *
 * Design rule: the script only keeps time and hands over objective readings.
 * It never decides *what the agent should do*; the agent decides how (or
 * whether) to respond.
 *
 * ## When it fires (idle trigger)
 *
 * It fires once the conversation has been idle for N ms, where N is drawn from
 * `[minIntervalMs, maxIntervalMs]` in `checkin-config.json` (re-read every
 * round, so edits need no restart). "Idle" is measured from the last record in
 * the cold log (either side speaking), the last check-in, or process start,
 * whichever is latest. See `makeIdleClock`.
 *
 * ## What it sends (branches)
 *
 * Each round rolls a weighted die to pick which invitation text to send:
 *   heart / cave / fun / egg        (config key `branches`)
 * During the owner's configured sleep hours (`ownerSleep: {from,to}`) a second
 * weight pool (`branchesSleep`) is used, which adds a fifth branch
 * `owner_sleep`: a single line describing something the owner does in their
 * sleep, sent without the header.
 * The same branch is never picked twice in a row (unless it is the only one
 * with a non-zero weight).
 *
 *   · fun  — the body may contain `{menu}`, replaced by 3–5 random items from
 *            the `## fun_menu` section (count configurable via `funMenu`).
 *   · egg  — rolls again for a sub-type (config key `eggs`):
 *            notes / oldquote / deeptalk / dare / hidden.
 *            deeptalk and dare use separate day/night pools; night hours are
 *            configurable (`nightHours: {from,to}`, wraps past midnight when
 *            from > to). oldquote picks a random old owner message (≥ 3 days
 *            old, 8–120 chars) from the cold log with reservoir sampling, so the
 *            log is streamed and never loaded into memory.
 *            If a sub-type has nothing to draw, the next one is tried, so an
 *            empty message is never sent.
 *
 * ## Decks
 *
 * notes / deeptalk_day / deeptalk_night / dare_day / dare_night / owner_sleep
 * are each a "deck": items are drawn without replacement until the deck is
 * empty, then reshuffled. Lines added to the texts file join the current deck;
 * removed lines are dropped from it. Deck state lives in `stateFile` (written
 * only by this module); the texts file is read-only.
 *
 * ## Texts are not in the code
 *
 * The header and all branch bodies live in a Markdown file (`textsFile`,
 * `## section` per block, re-read every round). A missing file or section falls
 * back to the short generic built-ins below, so a broken texts file never
 * produces an empty message. See `examples/checkin-texts.example.md`.
 *
 * ## Clock
 *
 * Hours (sleep window, night window, rendered times) are computed at the UTC
 * offset in `GATE_TZ_OFFSET_HOURS` (default 0 = UTC).
 *
 * This module knows nothing about channels, runtimes or the bridge: it only
 * writes files into a directory.
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const { putNote } = require("../gate/producers");

/** Skip a round if the owner spoke this recently (the time is already "in use"). */
const DEFAULT_SKIP_IF_SPOKE_WITHIN_MS = 5 * 60 * 1000;

const DEFAULT_MIN_MS = 40 * 60 * 1000;
const DEFAULT_MAX_MS = 50 * 60 * 1000;

/** Display names (rendered into the header's {branch_name}) and default weights. */
const BRANCH_NAMES = { heart: "Talk", cave: "Quiet time", fun: "Free time", egg: "Surprise", owner_sleep: "Owner asleep" };
const DEFAULT_BRANCH_WEIGHTS = { heart: 0.25, cave: 0.30, fun: 0.30, egg: 0.15 };
/** Weight pool used during the owner's sleep hours; adds `owner_sleep`. */
const DEFAULT_SLEEP_BRANCH_WEIGHTS = { heart: 0.10, cave: 0.18, fun: 0.35, egg: 0.27, owner_sleep: 0.10 };

const DEFAULT_FUN_MENU_RANGE = { min: 3, max: 5 };

/** Night window shared by deeptalk and dare. */
const DEFAULT_NIGHT_HOURS = { from: 22, to: 10 };

const DEFAULT_FUN_MENU = [
  "Read the news or browse something you're curious about",
  "Write a journal entry",
  "Look back through your memory notes",
  "Draw something or generate an image",
  "Tidy up your notes",
];

const DEFAULT_EGG_WEIGHTS = { notes: 0.30, oldquote: 0.20, deeptalk: 0.25, dare: 0.20, hidden: 0.05 };

/** Built-in fallbacks for the egg pools (used only when the texts file lacks them). */
const DEFAULT_EGG_NOTES = ["(No notes configured yet.) Anything on your mind?"];
const DEFAULT_EGG_DEEPTALK_DAY = ["(No deep-talk questions configured yet.) What's something you've been thinking about today?"];
const DEFAULT_EGG_DEEPTALK_NIGHT = ["(No night deep-talk questions configured yet.) It's late — anything you want to say?"];
const DEFAULT_EGG_DARE = ["(No dares configured yet.) Say one thing you didn't get around to saying today."];
const DEFAULT_EGG_DARE_NIGHT = [];
const DEFAULT_EGG_HIDDEN = "(No hidden event configured yet.)";

/** Built-in texts, used when the texts file is missing or lacks a section. */
const DEFAULT_TEXTS = {
  header: [
    "Check-in. This round: [{branch_name}]",
    "Now: {now}",
    "{last_user_line}",
    "Since last check-in: {since_last}",
    "Drives: {drives}",
    // `{pending}` is computed and passed in every round but not rendered by
    // default; add a line such as "Open items: {pending}" to enable it.
  ].join("\n"),
  heart: [
    "This is your own time. Anything you want to say?",
    "No tools needed — just talk, if you feel like it.",
    "Nothing to say is fine too.",
  ].join("\n"),
  cave: [
    "Quiet time. You don't have to explain where you are or say anything.",
    "Doing nothing is fine.",
  ].join("\n"),
  fun: [
    "Free time. A few ideas:",
    "{menu}",
    "Pick any, or none.",
  ].join("\n"),
};

// ---------------------------------------------------------------- clock

/** UTC offset (hours) used for hour-of-day decisions and rendered times. */
function tzOffsetHours(env = process.env) {
  const n = Number(env.GATE_TZ_OFFSET_HOURS);
  return Number.isFinite(n) ? n : 0;
}
const shifted = (ms) => new Date(ms + tzOffsetHours() * 3600e3);
/** HH:MM at the configured offset. */
const hhmm = (d) => shifted(d.getTime()).toISOString().slice(11, 16);
/** Hour of day (0–23) at the configured offset. */
function localHour(now) { return shifted(now.getTime()).getUTCHours(); }
/** YYYY-MM-DD at the configured offset. */
function localDateLabel(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return shifted(t).toISOString().slice(0, 10);
}
/** Is `now` inside the [from, to) hour window (wraps midnight when from > to; from === to = never). */
function isNightHour(now, range = DEFAULT_NIGHT_HOURS) {
  const h = localHour(now);
  const { from, to } = range || DEFAULT_NIGHT_HOURS;
  if (from === to) return false;
  return from < to ? (h >= from && h < to) : (h >= from || h < to);
}

// ---------------------------------------------------------------- config

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** Interval range; re-read every round. */
function readRange(configFile) {
  const j = readJson(configFile);
  if (j) {
    const min = Number(j.minIntervalMs);
    const max = Number(j.maxIntervalMs);
    if (Number.isFinite(min) && Number.isFinite(max) && min > 0 && max >= min) return { min, max };
  }
  return { min: DEFAULT_MIN_MS, max: DEFAULT_MAX_MS };
}

/**
 * Named weights under `key`; missing/invalid keys fall back to their default.
 * If nothing ends up positive, the defaults are returned (avoids a dead die).
 */
function readWeightsFromConfig(configFile, key, defaults) {
  const out = { ...defaults };
  const j = readJson(configFile);
  const b = j && j[key];
  if (b && typeof b === "object") {
    for (const k of Object.keys(defaults)) {
      const v = Number(b[k]);
      if (Number.isFinite(v) && v >= 0) out[k] = v;
    }
  }
  if (!Object.values(out).some((v) => v > 0)) return { ...defaults };
  return out;
}

function readBranchWeights(configFile) {
  return readWeightsFromConfig(configFile, "branches", DEFAULT_BRANCH_WEIGHTS);
}

function readEggWeights(configFile) {
  return readWeightsFromConfig(configFile, "eggs", DEFAULT_EGG_WEIGHTS);
}

function readHourWindow(configFile, key, defaults) {
  const j = readJson(configFile);
  const n = j && j[key];
  if (n && typeof n === "object") {
    const from = Number(n.from);
    const to = Number(n.to);
    if (Number.isInteger(from) && from >= 0 && from <= 23 && Number.isInteger(to) && to >= 0 && to <= 23) {
      return { from, to };
    }
  }
  return { ...defaults };
}

/** `nightHours: {from, to}` — shared by deeptalk and dare. */
function readNightHours(configFile) {
  return readHourWindow(configFile, "nightHours", DEFAULT_NIGHT_HOURS);
}

/** Owner's sleep hours; during this window the `branchesSleep` pool is used. */
const DEFAULT_OWNER_SLEEP = { from: 4, to: 12 };
function readOwnerSleep(configFile) {
  return readHourWindow(configFile, "ownerSleep", DEFAULT_OWNER_SLEEP);
}

/** `funMenu: {min, max}` */
function readFunMenuRange(configFile) {
  const j = readJson(configFile);
  const fm = j && j.funMenu;
  if (fm && typeof fm === "object") {
    const min = Number(fm.min);
    const max = Number(fm.max);
    if (Number.isFinite(min) && min > 0 && Number.isFinite(max) && max >= min) return { min, max };
  }
  return { ...DEFAULT_FUN_MENU_RANGE };
}

// ---------------------------------------------------------------- dice

/** Weighted roll; weights need not sum to 1. Used for branches and egg sub-types. */
function rollBranch(weights, rand = Math.random) {
  const keys = Object.keys(weights);
  const total = keys.reduce((s, k) => s + (weights[k] > 0 ? weights[k] : 0), 0);
  if (!(total > 0)) return keys[0];
  let x = rand() * total;
  for (const k of keys) {
    const w = weights[k] > 0 ? weights[k] : 0;
    if (x < w) return k;
    x -= w;
  }
  return keys[keys.length - 1];
}

/** Zero the previous branch so it can't repeat — unless it is the only positive one. */
function excludeLastBranch(weights, lastBranch) {
  if (!lastBranch || !(weights[lastBranch] > 0)) return weights;
  const positiveKeys = Object.keys(weights).filter((k) => weights[k] > 0);
  if (positiveKeys.length <= 1) return weights;
  const out = { ...weights };
  out[lastBranch] = 0;
  return out;
}

/** Draw [min, max] distinct items (whole pool if smaller). Partial Fisher–Yates. No cross-round memory. */
function drawMenu(items, range, rand = Math.random) {
  const pool = (Array.isArray(items) ? items : []).map((s) => String(s || "").trim()).filter(Boolean);
  if (!pool.length) return [];
  const hi = Math.min(range.max, pool.length);
  const lo = Math.min(range.min, hi);
  const k = lo + Math.floor(rand() * (hi - lo + 1));
  const arr = pool.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  return arr.slice(0, k);
}

function formatMenu(list) {
  return list.map((t, i) => (i + 1) + ". " + t).join("\n");
}

// ---------------------------------------------------------------- texts

/** One item per line; tolerates `- ` / `* ` bullets; blank lines skipped. */
function parseMenuLines(raw) {
  return String(raw || "").split("\n")
    .map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
    .filter(Boolean);
}

/** `## name` sections; each section body is kept verbatim up to the next `## `. */
function parseTextsMd(raw) {
  const out = {};
  let cur = null;
  let buf = [];
  const flush = () => { if (cur) out[cur] = buf.join("\n").trim(); };
  for (const line of String(raw).split("\n")) {
    const m = /^##\s+(\S+)\s*$/.exec(line);
    if (m) { flush(); cur = m[1].toLowerCase(); buf = []; }
    else if (cur) buf.push(line);
  }
  flush();
  return out;
}

/** Read the texts file (every round). Missing sections fall back to built-ins. */
function readTexts(file) {
  let parsed = {};
  try { parsed = parseTextsMd(fs.readFileSync(file, "utf8")); } catch { parsed = {}; }
  const lines = (k) => parseMenuLines(parsed[k]);
  const or = (arr, fallback) => (arr.length ? arr : fallback);
  const hidden = lines("egg_hidden");
  return {
    header: parsed.header || DEFAULT_TEXTS.header,
    heart: parsed.heart || DEFAULT_TEXTS.heart,
    cave: parsed.cave || DEFAULT_TEXTS.cave,
    fun: parsed.fun || DEFAULT_TEXTS.fun,
    fun_menu: or(lines("fun_menu"), DEFAULT_FUN_MENU),
    egg_notes: or(lines("egg_notes"), DEFAULT_EGG_NOTES),
    egg_deeptalk_day: or(lines("egg_deeptalk_day"), DEFAULT_EGG_DEEPTALK_DAY),
    egg_deeptalk_night: or(lines("egg_deeptalk_night"), DEFAULT_EGG_DEEPTALK_NIGHT),
    egg_dare: or(lines("egg_dare"), DEFAULT_EGG_DARE),
    // May legitimately be empty: the night dare deck is egg_dare ∪ egg_dare_night.
    egg_dare_night: lines("egg_dare_night"),
    egg_hidden: hidden.length ? hidden[0] : DEFAULT_EGG_HIDDEN,
    // No built-in fallback: if unset, the owner_sleep branch is disabled.
    owner_sleep: lines("owner_sleep"),
  };
}

/** Fill the header template. A line whose placeholders all resolve empty is dropped entirely. */
function renderHeader(template, vars) {
  const out = [];
  for (const line of String(template || "").split("\n")) {
    const names = Array.from(line.matchAll(/\{(\w+)\}/g), (m) => m[1]);
    if (names.length && names.some((n) => !String(vars[n] == null ? "" : vars[n]).trim())) continue;
    let rendered = line;
    for (const n of names) rendered = rendered.split("{" + n + "}").join(vars[n] == null ? "" : vars[n]);
    out.push(rendered);
  }
  return out.join("\n");
}

const mins = (ms) => Math.round(ms / 60000);
const human = (m) => (m >= 60 ? Math.floor(m / 60) + "h " + (m % 60) + "m" : m + " min");

/** Time since the previous check-in; empty on the first one (the line is dropped). */
function fmtSinceLast(now, lastAt) {
  if (!lastAt) return "";
  return human(mins(now.getTime() - lastAt));
}

/** Numeric fields of an optional drives JSON, strongest first. No interpretation. */
function fmtDrives(drivesJson) {
  if (!drivesJson || typeof drivesJson !== "object") return "";
  const drives = drivesJson.drives || drivesJson.state || drivesJson;
  return Object.entries(drives)
    .filter(([, v]) => typeof v === "number")
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => k + " " + (Math.round(v * 100) / 100))
    .join(" · ");
}

/** When the owner last spoke, plus the quote (up to 120 chars). */
function fmtLastUserLine(now, lastUserAt, lastUserText) {
  if (!lastUserAt) return "";
  const m = mins(now.getTime() - lastUserAt);
  const head = "Owner last spoke at " + hhmm(new Date(lastUserAt)) + " (" + m + " min ago)";
  const q = lastUserText ? String(lastUserText).replace(/\s+/g, " ").slice(0, 120) : "";
  return q ? head + ": “" + q + "”" : head;
}

// ---------------------------------------------------------------- cold log

/**
 * Read-only scan of the cold log: when/what the owner last said, and whether
 * the agent has replied since `sinceMs`. Only replies that reach the cold log
 * are visible here, so this counts "didn't speak", not "did nothing".
 */
function readColdSignals(coldFile, sinceMs = 0) {
  const empty = { lastUserAt: 0, lastUserText: "", spokeSince: false };
  if (!coldFile) return empty;
  let rows;
  try {
    rows = fs.readFileSync(coldFile, "utf8").trim().split("\n")
      .filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return empty; }
  let lastUserAt = 0, lastUserText = "";
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].role === "user") {
      lastUserAt = Date.parse(rows[i].at) || 0;
      lastUserText = String(rows[i].text || "");
      break;
    }
  }
  let spokeSince = false;
  if (sinceMs) {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const t = Date.parse(rows[i].at) || 0;
      if (t < sinceMs) break;
      if (rows[i].role === "assistant" && !/^\[本轮未回复\]/.test(String(rows[i].text || ""))) {
        spokeSince = true; break;
      }
    }
  }
  return { lastUserAt, lastUserText, spokeSince };
}

/** Optional drives reading: GET a JSON document from `url`. Any failure → null. */
async function readDrives(url, timeoutMs = 3000) {
  if (!url) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
  finally { clearTimeout(t); }
}

/** Next delay drawn from the range. */
function nextDelayMs(range, rand = Math.random) {
  return range.min + Math.floor(rand() * (range.max - range.min + 1));
}

// ---------------------------------------------------------------- idle trigger

/** The heart sleeps at most this long between re-checks (it can't see new messages while asleep). */
const DEFAULT_IDLE_POLL_MS = 5 * 60 * 1000;

/** Timestamp of the last complete record in the cold log; only the file tail is read. 0 if unknown. */
function readLastActivityAt(coldFile, tailBytes = 64 * 1024) {
  if (!coldFile) return 0;
  let fd;
  try {
    fd = fs.openSync(coldFile, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, tailBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      let row;
      try { row = JSON.parse(lines[i]); } catch { continue; }   // first line of the tail may be cut
      const t = Date.parse(row && row.at);
      if (t) return t;
    }
    return 0;
  } catch { return 0; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

/**
 * Idle alarm: decides *when* to fire, not what to send.
 * Base = max(last cold-log record, last fired, process start); each time the
 * base moves, a new N is drawn from the configured range.
 */
function makeIdleClock({ coldFile = "", configFile = "", pollMs = DEFAULT_IDLE_POLL_MS,
  rand = Math.random, nowFn = () => Date.now() } = {}) {
  const startedAt = nowFn();
  let lastFiredAt = 0;
  let base = -1;
  let threshold = 0;

  function dueAt() {
    const b = Math.max(readLastActivityAt(coldFile), lastFiredAt, startedAt);
    if (b !== base) {
      base = b;
      threshold = nextDelayMs(readRange(configFile), rand);
    }
    return base + threshold;
  }

  return {
    nextDelayMs() { return Math.max(0, Math.min(dueAt() - nowFn(), pollMs)); },
    isDue() { return nowFn() >= dueAt(); },
    fired(at = nowFn()) { lastFiredAt = at; },
    peek() { const d = dueAt(); return { base, thresholdMs: threshold, dueAt: d }; },
  };
}

// ---------------------------------------------------------------- egg helpers

/**
 * Pick one random owner message from the cold log: role=user, older than
 * `minAgeMs`, length within [minLen, maxLen], not starting with "[" (media
 * placeholders). Reservoir sampling (k=1) over a streamed read.
 * @returns {Promise<{id, at, text}|null>}
 */
async function sampleOldQuote(coldFile, { now = new Date(), minAgeMs = 3 * 24 * 3600e3, minLen = 8, maxLen = 120 } = {}, rand = Math.random) {
  if (!coldFile) return null;
  let stream;
  try { stream = fs.createReadStream(coldFile, { encoding: "utf8" }); }
  catch { return null; }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let seen = 0;
  let picked = null;
  const cutoff = now.getTime() - minAgeMs;
  try {
    for await (const line of rl) {
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || row.role !== "user") continue;
      const text = String(row.text || "");
      if (!text || text.startsWith("[")) continue;
      if (text.length < minLen || text.length > maxLen) continue;
      const at = Date.parse(row.at);
      if (!Number.isFinite(at) || at > cutoff) continue;
      seen += 1;
      if (rand() < 1 / seen) picked = { id: row.id, at: row.at, text };
    }
  } catch { /* broken stream → nothing picked */ }
  finally {
    try { rl.close(); } catch { /* ignore */ }
    try { stream.destroy(); } catch { /* ignore */ }
  }
  return picked;
}

function emptyDeck() { return { pool: [], remaining: [], drawnLog: [] }; }

/**
 * Reconcile a saved deck with the current pool: new lines join `remaining`,
 * removed lines leave it, and an exhausted deck is reshuffled from the pool.
 */
function reconcileDeck(prev, pool) {
  const prevPool = Array.isArray(prev && prev.pool) ? prev.pool : [];
  const prevRemaining = Array.isArray(prev && prev.remaining) ? prev.remaining : [];
  const drawnLog = Array.isArray(prev && prev.drawnLog) ? prev.drawnLog : [];
  const poolSet = new Set(pool);
  let remaining = prevRemaining.filter((x) => poolSet.has(x));
  const prevPoolSet = new Set(prevPool);
  for (const item of pool) {
    if (!prevPoolSet.has(item) && !remaining.includes(item)) remaining.push(item);
  }
  if (!remaining.length && pool.length) remaining = pool.slice();
  return { pool: pool.slice(), remaining, drawnLog };
}

/** Draw one card without replacement (after reconciling). Empty pool → picked=null. */
function drawFromDeck(prevDeckState, pool, rand, now) {
  const deck = reconcileDeck(prevDeckState, pool);
  if (!deck.remaining.length) return { picked: null, deck };
  const idx = Math.floor(rand() * deck.remaining.length);
  const picked = deck.remaining.splice(idx, 1)[0];
  deck.drawnLog = deck.drawnLog.concat([{ item: picked, at: now.toISOString() }]).slice(-200);
  return { picked, deck };
}

const DECK_KEYS = ["notes", "deeptalk_day", "deeptalk_night", "dare_day", "dare_night", "owner_sleep"];

function emptyCheckinState() {
  const decks = {};
  for (const k of DECK_KEYS) decks[k] = emptyDeck();
  return { lastBranch: "", decks };
}

/**
 * Last branch + deck state. Only this module writes the file, so it is read
 * once at construction and written back after each tick. No `stateFile` =
 * in-memory only.
 */
function readState(stateFile) {
  const base = emptyCheckinState();
  if (!stateFile) return base;
  const j = readJson(stateFile);
  if (j && typeof j === "object") {
    if (typeof j.lastBranch === "string") base.lastBranch = j.lastBranch;
    if (j.decks && typeof j.decks === "object") {
      for (const k of DECK_KEYS) {
        const d = j.decks[k];
        if (d && typeof d === "object") {
          base.decks[k] = {
            pool: Array.isArray(d.pool) ? d.pool : [],
            remaining: Array.isArray(d.remaining) ? d.remaining : [],
            drawnLog: Array.isArray(d.drawnLog) ? d.drawnLog : [],
          };
        }
      }
    }
  }
  return base;
}

/** Atomic write (tmp → rename). A failed write only means a reshuffle next time. */
function writeState(stateFile, state) {
  if (!stateFile) return;
  try {
    const tmp = stateFile + ".tmp-" + process.pid;
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
    fs.renameSync(tmp, stateFile);
  } catch { /* not fatal */ }
}

/**
 * Pick an egg sub-type and render its body. Falls through a fixed order when
 * the rolled sub-type has nothing to draw. Mutates `state.decks`.
 * @returns {Promise<{type:string, body:string}>}
 */
async function pickEgg({ texts, weights, state, coldFile, now, rand, nightHours = DEFAULT_NIGHT_HOURS }) {
  const rolledType = rollBranch(weights, rand);
  const order = [rolledType];
  for (const k of ["notes", "oldquote", "deeptalk", "dare", "hidden"]) {
    if (!order.includes(k)) order.push(k);
  }

  for (const type of order) {
    if (type === "notes") {
      const { picked, deck } = drawFromDeck(state.decks.notes, texts.egg_notes, rand, now);
      if (picked) { state.decks.notes = deck; return { type: "notes", body: picked }; }
    } else if (type === "deeptalk") {
      const night = isNightHour(now, nightHours);
      const pool = night ? texts.egg_deeptalk_night : texts.egg_deeptalk_day;
      const deckKey = night ? "deeptalk_night" : "deeptalk_day";
      const { picked, deck } = drawFromDeck(state.decks[deckKey], pool, rand, now);
      if (picked) {
        state.decks[deckKey] = deck;
        return { type: "deeptalk", body: ["Deep talk:", picked, "Answer if you like."].join("\n") };
      }
    } else if (type === "dare") {
      const night = isNightHour(now, nightHours);
      const pool = night ? texts.egg_dare.concat(texts.egg_dare_night) : texts.egg_dare;
      const deckKey = night ? "dare_night" : "dare_day";
      const { picked, deck } = drawFromDeck(state.decks[deckKey], pool, rand, now);
      if (picked) {
        state.decks[deckKey] = deck;
        return { type: "dare", body: ["Dare: " + picked, "Send it over when you're done."].join("\n") };
      }
    } else if (type === "oldquote") {
      const picked = await sampleOldQuote(coldFile, { now }, rand);
      if (picked) {
        return { type: "oldquote", body: "Old quote: on " + localDateLabel(picked.at) + " the owner said “" + picked.text + "”. Remember?" };
      }
    } else if (type === "hidden") {
      const line = texts.egg_hidden;
      if (line) return { type: "hidden", body: line };
    }
  }
  return { type: "notes", body: DEFAULT_EGG_NOTES[0] };   // unreachable in practice; never send empty
}

// ---------------------------------------------------------------- producer

/**
 * @param {object} o
 * @param {string} o.dir          producers drop directory
 * @param {string} [o.configFile] interval / weights / menu size / hour windows (re-read every round)
 * @param {string} [o.textsFile]  header + branch texts + pools (re-read every round)
 * @param {string} [o.stateFile]  last branch + deck state (owned by this module)
 * @param {string} [o.drivesUrl]  optional JSON endpoint whose numeric fields render as "Drives"
 * @param {string} [o.coldFile]
 * @param {function} [o.pendingText]         supplies {pending} (e.g. open notebook titles)
 * @param {function} [o.expiredNotebookText] supplies an extra header line (e.g. expired notebook items)
 * @param {function} [o.log]
 * @param {function} [o.sleep]
 * @param {function} [o.rand]
 */
function makeCheckin({ dir, configFile = "", textsFile = "", stateFile = "", drivesUrl = "", coldFile = "",
  pendingText = null, expiredNotebookText = null,
  skipIfSpokeWithinMs = DEFAULT_SKIP_IF_SPOKE_WITHIN_MS, log = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), rand = Math.random } = {}) {
  if (!String(dir || "").trim()) throw new Error("check-in needs a producers directory (no default)");
  let stopped = false;
  let lastAt = 0;
  let silentStreak = 0;
  const branchState = readState(stateFile);

  return {
    /** Fire once. */
    async tick({ now = new Date() } = {}) {
      const sig = readColdSignals(coldFile, lastAt);

      // Owner is around: skip this round (not counted as the agent staying silent).
      if (skipIfSpokeWithinMs && sig.lastUserAt) {
        const since = now.getTime() - sig.lastUserAt;
        if (since < skipIfSpokeWithinMs) {
          lastAt = now.getTime();
          log("[check-in] skipped: owner spoke " + Math.round(since / 1000) + "s ago");
          return { skipped: true, reason: "owner spoke recently", sinceMs: since };
        }
      }

      const drives = await readDrives(drivesUrl);
      if (lastAt) silentStreak = sig.spokeSince ? 0 : silentStreak + 1;
      let pending = "";
      try { pending = pendingText ? String(pendingText() || "").trim() : ""; } catch { /* none */ }
      pending = pending.replace(/\s+/g, " ").slice(0, 450);

      const texts = readTexts(textsFile);

      // Roll the branch (sleep-hours pool vs. default pool), excluding last round's branch.
      const sleeping = isNightHour(now, readOwnerSleep(configFile));
      const weights = sleeping
        ? readWeightsFromConfig(configFile, "branchesSleep", DEFAULT_SLEEP_BRANCH_WEIGHTS)
        : readBranchWeights(configFile);
      if (!texts.owner_sleep.length && weights.owner_sleep) {
        weights.owner_sleep = 0;
        if (!Object.values(weights).some((v) => v > 0)) Object.assign(weights, DEFAULT_BRANCH_WEIGHTS);
      }
      // owner_sleep may repeat (consecutive sleep events are natural).
      const rollWeights = branchState.lastBranch === "owner_sleep" ? weights : excludeLastBranch(weights, branchState.lastBranch);
      let branch = rollBranch(rollWeights, rand);
      let ownerSleepLine = "";
      let sleepDeck = null;
      if (branch === "owner_sleep") {
        const drawn = drawFromDeck(branchState.decks.owner_sleep, texts.owner_sleep, rand, now);
        if (drawn.picked) { ownerSleepLine = drawn.picked; sleepDeck = drawn.deck; }
        else branch = rollBranch({ ...rollWeights, owner_sleep: 0 }, rand);
      }

      let header = renderHeader(texts.header, {
        branch_name: BRANCH_NAMES[branch] || branch,
        now: hhmm(now),
        last_user_line: fmtLastUserLine(now, sig.lastUserAt, sig.lastUserText),
        since_last: fmtSinceLast(now, lastAt),
        drives: fmtDrives(drives),
        pending,
      });
      // Dynamic data (not a template placeholder): appended after the header.
      let expiredLine = "";
      try { expiredLine = expiredNotebookText ? String(expiredNotebookText() || "").trim() : ""; } catch { /* none */ }
      if (expiredLine) header = header + "\n" + expiredLine;

      let body;
      let eggType = "";
      if (branch === "owner_sleep") {
        body = ownerSleepLine;
        branchState.decks.owner_sleep = sleepDeck;
      } else if (branch === "fun") {
        const menu = formatMenu(drawMenu(texts.fun_menu, readFunMenuRange(configFile), rand));
        body = String(texts.fun || "").trim().split("{menu}").join(menu);
      } else if (branch === "egg") {
        const picked = await pickEgg({ texts, weights: readEggWeights(configFile), state: branchState,
          coldFile, now, rand, nightHours: readNightHours(configFile) });
        body = picked.body;
        eggType = picked.type;
      } else {
        body = String(texts[branch] || "").trim();
      }

      branchState.lastBranch = branch;
      writeState(stateFile, branchState);

      // silentStreak is logged only, never shown to the agent.
      // owner_sleep is sent bare, without the header.
      const text = branch === "owner_sleep" ? body : header + "\n\n" + body;
      const r = putNote({ dir, producer: "checkin", text });
      lastAt = now.getTime();
      log("[check-in] queued " + r.id + ", branch " + branch + (eggType ? "/" + eggType : "")
        + ", weights " + JSON.stringify(weights) + ", silent streak " + silentStreak);
      return { ...r, silentStreak, branch, eggType, ownerSleepLine };
    },

    /** Fixed-interval loop (the heart uses the idle clock instead). */
    async run() {
      const range = readRange(configFile);
      log("[check-in] started, interval " + Math.round(range.min / 60000) + "-" + Math.round(range.max / 60000) + " min");
      while (!stopped) {
        const wait = nextDelayMs(readRange(configFile), rand);
        log("[check-in] next in ~" + Math.round(wait / 60000) + " min");
        await sleep(wait);
        if (stopped) break;
        try { await this.tick(); }
        catch (e) { log("[check-in] failed: " + ((e && e.message) || e)); }
      }
    },

    stop() { stopped = true; },
  };
}

module.exports = {
  makeCheckin, nextDelayMs, readRange, readColdSignals,
  makeIdleClock, readLastActivityAt, DEFAULT_IDLE_POLL_MS,
  DEFAULT_OWNER_SLEEP, readOwnerSleep, DEFAULT_SLEEP_BRANCH_WEIGHTS, readWeightsFromConfig,
  DEFAULT_MIN_MS, DEFAULT_MAX_MS, DEFAULT_SKIP_IF_SPOKE_WITHIN_MS,
  BRANCH_NAMES, DEFAULT_BRANCH_WEIGHTS, DEFAULT_TEXTS, DEFAULT_FUN_MENU, DEFAULT_FUN_MENU_RANGE,
  readBranchWeights, rollBranch, excludeLastBranch, readFunMenuRange, drawMenu, formatMenu, parseMenuLines,
  parseTextsMd, readTexts, renderHeader,
  fmtSinceLast, fmtDrives, fmtLastUserLine,
  DEFAULT_EGG_WEIGHTS, DEFAULT_EGG_NOTES, DEFAULT_EGG_DEEPTALK_DAY, DEFAULT_EGG_DEEPTALK_NIGHT,
  DEFAULT_EGG_DARE, DEFAULT_EGG_DARE_NIGHT, DEFAULT_EGG_HIDDEN,
  readEggWeights, DEFAULT_NIGHT_HOURS, readNightHours, tzOffsetHours, isNightHour, localHour, localDateLabel,
  sampleOldQuote, emptyDeck, reconcileDeck, drawFromDeck, DECK_KEYS, emptyCheckinState, readState, writeState, pickEgg,
};
