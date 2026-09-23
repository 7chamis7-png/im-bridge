"use strict";

/**
 * Single source of truth for the owner's timezone and locale.
 *
 * Timestamps shown to the model are rendered in the owner's real local
 * wall-clock time (a message sent at 23:00 local must read as 23:00), so the
 * agent's sense of time matches the owner's day.
 *
 *   GATE_TZ              IANA zone for all clock math, scheduling and
 *                        date-named files (default "UTC")
 *   GATE_TZ_LABEL        label shown to the model for that zone
 *                        (default: same as GATE_TZ)
 *   GATE_OUTWARD_TZ      zone used when rendering times into model-facing
 *                        text (default: GATE_TZ)
 *   GATE_OUTWARD_LOCALE  locale for those renderings (default "en-US")
 *
 * A bad zone name never crashes the process — it falls back instead.
 */

function safeTimeZone(value, fallback) {
  if (!value || typeof value !== "string") return fallback;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return value;
  } catch {
    return fallback;
  }
}

const INTERNAL_TZ = safeTimeZone(process.env.GATE_TZ, "UTC");
const INTERNAL_TZ_LABEL = String(process.env.GATE_TZ_LABEL || "").trim() || INTERNAL_TZ;
const OUTWARD_TZ = safeTimeZone(process.env.GATE_OUTWARD_TZ || process.env.OUTWARD_TZ, INTERNAL_TZ);
const OUTWARD_LOCALE = process.env.GATE_OUTWARD_LOCALE || process.env.OUTWARD_LOCALE || "en-US";

module.exports = { OUTWARD_TZ, OUTWARD_LOCALE, INTERNAL_TZ, INTERNAL_TZ_LABEL, safeTimeZone };
