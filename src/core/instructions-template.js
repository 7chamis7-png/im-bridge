"use strict";

/**
 * Minimal placeholder substitution for instruction files.
 *
 *   {{USER_NAME}}     config.userName     (default "owner")
 *   {{USER_PRONOUN}}  config.userPronoun  (default "they")
 */
function renderInstructionTemplate(template, config = {}) {
  const userName = String(config?.userName || "").trim() || "owner";
  const pronoun = String(config?.userPronoun || "").trim() || "they";
  return String(template || "")
    .replaceAll("{{USER_NAME}}", userName)
    .replaceAll("{{USER_PRONOUN}}", pronoun);
}

module.exports = { renderInstructionTemplate };
