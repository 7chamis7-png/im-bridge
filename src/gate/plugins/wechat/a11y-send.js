"use strict";

/**
 * WeChat outbound via accessibility (AT-SPI) UI automation.
 *
 * WeChat-specific work (clicking the window, clipboard, window lock) lives in
 * the plugin directory; the core knows nothing about it.
 *
 * Pitfalls:
 * 1. stdout must be redirected to a file, not a pipe: xclip forks a background
 *    process that holds the selection and the pipe, so waiting for pipe close hangs.
 * 2. Must be async: a synchronous exec would block the other legs while sending.
 * 3. Only one process may touch the WeChat window at a time (screenshots /
 *    xdotool / accessibility queries interfere). If the lock can't be acquired,
 *    fail (the outbound gate records it as undelivered) rather than racing.
 */

const { execFile } = require("child_process");
const path = require("path");

function makeA11ySenders(env, log = () => {}) {
  const script = env.GATE_WECHAT_SENDER;
  const target = env.GATE_WECHAT_TARGET;
  const lock = env.GATE_WECHAT_SEND_LOCK;
  const sendLog = env.GATE_WECHAT_SEND_LOG || "";
  const python = env.GATE_WECHAT_PYTHON || "python3";

  const run = (extraArgs, arg, killSec, timeoutMs) => new Promise((resolve, reject) => {
    const tail = sendLog ? ` >> ${JSON.stringify(sendLog)} 2>&1` : " >/dev/null 2>&1";
    const guard = `exec 9>${JSON.stringify(lock)}; `
      + `flock -w 60 9 || { echo "timed out waiting for the WeChat send lock" >&2; exit 1; }; `;
    const cmd = guard
      + `timeout -k 5 ${killSec} ${JSON.stringify(python)} -u ${JSON.stringify(script)} `
      + `${extraArgs} "$1"${tail}`;
    execFile("/bin/sh", ["-c", cmd, "sh", arg],
      { timeout: timeoutMs, env: { ...process.env, LINUX_WX_TARGET: target } },
      (err) => {
        // throw on failure so the outbound gate records it as undelivered
        if (err) return reject(new Error("WeChat a11y send failed: " + ((err && err.message) || err)));
        resolve(null);   // this path yields no platform message id (channel limitation)
      });
  });

  const voiceScript = path.join(__dirname, "wx-voice-send.py");
  const callScript = path.join(__dirname, "wx-call.py");

  /** Shared by dial / hang-up: hold the window lock and throw on failure. */
  const runCall = async (args, what, done) => {
    const t0 = Date.now();
    await new Promise((resolve, reject) => {
      const cmd = `exec 9>${JSON.stringify(lock)}; `
        + `flock -w 60 9 || { echo "timed out waiting for the WeChat lock" >&2; exit 1; }; `
        + `python3 -u ${JSON.stringify(callScript)} ${args.join(" ")}`;
      execFile("/bin/sh", ["-c", cmd],
        { timeout: 60_000,
          env: { ...process.env, LINUX_WX_TARGET: target,
                 DISPLAY: process.env.DISPLAY || env.GATE_WECHAT_DISPLAY || ":0",
                 XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || "/run/user/0" } },
        (err, _so, se) => (err
          ? reject(new Error("WeChat " + what + " failed: " + String(se || err.message).trim().slice(0, 200)))
          : resolve()));
    });
    log("[wechat] " + done + " in " + ((Date.now() - t0) / 1000).toFixed(2) + "s");
    return null;
  };

  return {
    /**
     * Send a voice message by letting WeChat record from a virtual microphone
     * (see wx-voice-send.py). The Linux client can't send an audio file as a voice
     * message, so: start recording -> play synthesized audio into the fake mic -> send.
     */
    voiceSender: async ({ filePath }) => {
      const t0 = Date.now();
      // paplay needs wav; TTS output is usually mp3
      const src = String(filePath || "");
      if (!src) throw new Error("WeChat voice: no audio file");
      // No length limit is applied: audio length was not the cause of client
      // instability (a real loopback sound card is used instead of a null sink).
      const wav = src + ".gate.wav";
      await new Promise((resolve, reject) => {
        execFile("ffmpeg", ["-loglevel", "error", "-y", "-i", src,
          "-ar", "44100", "-ac", "1", wav],
          { timeout: 60_000 },
          (err) => (err ? reject(new Error("audio to wav conversion failed: " + err.message)) : resolve()));
      });
      // 1. Hold the lock so text sends can't click the window mid-recording.
      // 2. Cool down after sending while still holding the lock: WeChat keeps
      //    compressing/uploading in the background and touching the UI then can crash it.
      const cool = Number(env.GATE_WECHAT_VOICE_COOLDOWN_MS || 12000);
      await new Promise((resolve, reject) => {
        const cmd = `exec 9>${JSON.stringify(lock)}; `
          + `flock -w 90 9 || { echo "timed out waiting for the WeChat send lock" >&2; exit 1; }; `
          + `python3 -u ${JSON.stringify(voiceScript)} "$1" || exit $?; `
          + `sleep ${Math.max(0, Math.round(cool / 1000))}`;   // cool down, lock still held
        execFile("/bin/sh", ["-c", cmd, "sh", wav],
          { timeout: 120_000 + cool,
            env: { ...process.env, LINUX_WX_TARGET: target,
                   LINUX_WX_OWNER_WXID: env.GATE_OWNER_WECHAT_ID || "",
                   LINUX_WX_KEYS: env.GATE_WECHAT_KEYS_FILE || "",
                   // the bridge usually runs without a DISPLAY; provide one
                   DISPLAY: process.env.DISPLAY || env.GATE_WECHAT_DISPLAY || ":0",
                   XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || "/run/user/0",
                   PULSE_SINK: env.GATE_WECHAT_MIC_SINK || "agent_mic_sink" } },
          (err, _so, se) => (err
            ? reject(new Error("WeChat voice send failed: " + String(se || err.message).trim().slice(0, 200)))
            : resolve()));
      });
      log("[wechat] voice sent in " + ((Date.now() - t0) / 1000).toFixed(2) + "s");
      return null;
    },

    /** Start a call (outgoing only). */
    caller: () => runCall([], "dial", "call placed"),

    /**
     * Hang up. The call UI is a separate window (`Voice Call`) with its own origin;
     * its button offsets are stored in wx-spots.json under `call_window`.
     * The script only reports success once the window has actually closed.
     */
    hangUp: () => runCall(["--hangup"], "hang-up", "call ended"),

    sender: async ({ text }) => {
      const t0 = Date.now();
      await run("", String(text), 30, 45_000);
      log("[wechat] text sent in " + ((Date.now() - t0) / 1000).toFixed(2) + "s");
      return null;
    },
    imageSender: async ({ filePath }) => {
      const t0 = Date.now();
      await run("--image", String(filePath), 45, 60_000);
      log("[wechat] image sent in " + ((Date.now() - t0) / 1000).toFixed(2) + "s");
      return null;
    },
  };
}

module.exports = { makeA11ySenders };
