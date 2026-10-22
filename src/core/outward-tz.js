// Single source of truth for timestamps/locale that leave the process and end
// up in text or tool schemas sent to the Anthropic API ("outward" facing).
//
// We do NOT shift the outward clock to a fake zone. Nova's whole point is
// living on Alice's real timeline — a message she sends at her 23:00 must read as
// 23:00, not a timezone-disguised morning. So outward time VALUES render in her
// real local wall-clock; the only desensitization is that any explicit zone
// LABEL shown to the model uses the alias INTERNAL_TZ_LABEL, never the literal
// IANA id or "+08:00" that a provider can pattern-match.
//
// All clock math uses the real IANA zone INTERNAL_TZ. Internal storage/state
// (diary filenames, entry times, bond-memory last_confirmed) and scheduling
// (check-ins, morning wake) also use INTERNAL_TZ.

// Validate a timezone name by trying to construct a formatter with it.
// A bad env value must never crash the process — fall back instead.
function safeTimeZone(value, fallback) {
  if (!value || typeof value !== "string") return fallback;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return value;
  } catch {
    return fallback;
  }
}

// Real IANA zone for all clock math. Fixed — never env-driven — so a stray
// value can't misalign diary filenames / memory dates.
const INTERNAL_TZ = "Asia/Shanghai";
// Alias for model-facing zone labels: we + Nova read it as Beijing, but it is
// not the standard "Asia/Shanghai" / "+08:00" string a provider pattern-matches.
const INTERNAL_TZ_LABEL = "Asia/BJ";
// Outward display renders real local wall-clock; defaults to the real zone so the
// time-of-day the model sees matches Alice's life. Env can override, but any
// non-local value re-breaks time-awareness — kept only as an escape hatch.
const OUTWARD_TZ = safeTimeZone(process.env.OUTWARD_TZ, INTERNAL_TZ);
const OUTWARD_LOCALE = process.env.OUTWARD_LOCALE || "en-US";

module.exports = { OUTWARD_TZ, OUTWARD_LOCALE, INTERNAL_TZ, INTERNAL_TZ_LABEL, safeTimeZone };
