"use strict";

/**
 * Where im-bridge keeps its data by default.
 *
 * Everything that used to be a hard-coded absolute path resolves under this
 * directory unless a more specific environment variable overrides it.
 *
 *   IM_BRIDGE_HOME   default: ~/.im-bridge
 */

const os = require("os");
const path = require("path");

function bridgeHome(env = process.env) {
  const v = String(env.IM_BRIDGE_HOME || "").trim();
  return v ? path.resolve(v) : path.join(os.homedir(), ".im-bridge");
}

/** `bridgeHome()/<...parts>` */
function homePath(...parts) {
  return path.join(bridgeHome(), ...parts);
}

module.exports = { bridgeHome, homePath };
