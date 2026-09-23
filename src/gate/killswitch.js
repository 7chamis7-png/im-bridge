"use strict";

/**
 * One-file kill switch.
 *
 * Fallback is deliberately NOT "auto-resend via another path on failure": an
 * outbound call can time out after the platform already delivered, and an
 * automatic retry at that point sends the message twice. An unknown result is
 * not the same as "not sent".
 *
 * Instead the bridge is gated by a flag file:
 *   file exists  -> the bridge handles traffic
 *   file removed -> the bridge stops taking over (next turn, no restart)
 *
 * Fail-safe: anything we can't read clearly (fs errors, permissions, moved
 * directory) counts as "off".
 */

const fs = require("fs");

/** No hard-coded default path: the caller must supply the flag file. */
function requireFlagFile(v) {
  const s = String(v || "").trim();
  if (!s) throw new Error("KillSwitch 要一个开关文件路径（flagFile）—— 不许用默认值猜");
  return s;
}
const DEFAULT_TTL_MS = 1000;      // stat at most once per TTL, not on every message

class KillSwitch {
  constructor({ flagFile, ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
    flagFile = requireFlagFile(flagFile);
    this.flagFile = flagFile;
    this.ttlMs = ttlMs;
    this.now = now;
    this._cachedAt = -Infinity;
    this._cached = false;
    this._lastLogged = null;
  }

  /** Whether the bridge should handle traffic now. Unreadable -> false. */
  enabled() {
    const t = this.now();
    if (t - this._cachedAt < this.ttlMs) return this._cached;
    let on = false;
    try { on = fs.statSync(this.flagFile).isFile(); } catch { on = false; }
    this._cachedAt = t;
    this._cached = on;
    return on;
  }

  /** Returns a log line only when the state changes, to avoid log spam. */
  transition() {
    const on = this.enabled();
    if (this._lastLogged === on) return null;
    this._lastLogged = on;
    return on ? "bridge enabled (" + this.flagFile + " exists)"
              : "bridge disabled (" + this.flagFile + " missing)";
  }
}

module.exports = { KillSwitch };
