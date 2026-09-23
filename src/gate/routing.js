"use strict";

/**
 * Routing — where does this message go (SPEC §4).
 *
 * Delivery decisions belong to neither the model nor the tools. What the agent says is the
 * agent's business; where it goes is the bridge's. The tool-facing outbox therefore has no
 * "recipient" parameter.
 *
 * Five policies, evaluated in order, first match wins:
 *
 *   1. reply route      this turn answers an inbound message → reply where it came from
 *   2. explicit target  a destination given by a producer or an explicit request
 *   3. last active      proactive messages go to the owner's most recently active route
 *   4. preferred        if that route is dead → the preferred route (from config, never hard-coded)
 *   5. hold             nothing usable → hold the message, never guess
 *
 * Policy 5 matters most: a message waiting for someone to look at it is better than one
 * sent down an arbitrary channel (e.g. a question asked on Telegram answered on WeChat).
 */

/** Policy names. Every target carries the policy that produced it, for debugging. */
const POLICY = Object.freeze({
  REPLY: "reply_route",         // 1 reply route
  EXPLICIT: "explicit_target",  // 2 explicit target
  LAST_ACTIVE: "last_active",   // 3 last active
  PREFERRED: "preferred",       // 4 preferred
  HOLD: "hold",                 // 5 hold, don't guess
});

/**
 * @param {object} o
 * @param {object|null} [o.preferred] preferred target { platform, chat_id }, from config
 * @param {function} [o.isAlive] (route) => boolean, can this leg send right now (default: yes)
 * @param {function} [o.now]
 */
function makeRouter({ preferred = null, isAlive = () => true, now = () => Date.now(), file = "" } = {}) {
  /** Where the owner's most recent inbound came from */
  let lastActive = null;
  // The owner's latest address on each leg. Kept per channel so that a request like
  // "send it to me on WeChat" can name only the channel; the bridge looks up the chat_id
  // instead of making the model remember addresses.
  let byChannel = {};
  if (file) {
    try {
      const saved = JSON.parse(require("fs").readFileSync(file, "utf8"));
      lastActive = saved && saved.platform ? saved : (saved && saved.lastActive) || null;
      byChannel = (saved && saved.byChannel) || {};
    } catch (e) { if (e.code !== "ENOENT") throw e; }
  }

  return {
    /**
     * Record an inbound message.
     *
     * Only the owner's messages count, never the agent's. An agent reply on one channel says
     * nothing about where the owner is; counting outbound would route answers to the wrong
     * channel.
     */
    noteInbound(envelope) {
      const e = envelope || {};
      if (!e.source || e.source.kind !== "user") return null;
      const platform = String(e.source.platform || "").trim();
      const chat_id = String(e.source.chat_id || "").trim();
      if (!platform || !chat_id) return null;
      lastActive = { platform, chat_id, at: now() };
      byChannel[platform] = { platform, chat_id, at: now() };
      if (file) {
        const fs = require("fs");
        fs.mkdirSync(require("path").dirname(file), { recursive: true, mode: 0o700 });
        const tmp = file + ".tmp-" + process.pid;
        // new shape includes byChannel; the old shape (platform/chat_id only) is still readable
        fs.writeFileSync(tmp, JSON.stringify({ lastActive, byChannel }), { mode: 0o600 });
        fs.renameSync(tmp, file);
      }
      return lastActive;
    },

    lastActive: () => (lastActive ? { ...lastActive } : null),

    /** The owner's address on a given leg. Unknown → null, never a guess. */
    addressOn: (platform) => {
      const k = String(platform || "").trim().toLowerCase();
      const hit = byChannel[k];
      return hit ? { ...hit } : null;
    },

    /**
     * Resolve the destination for one message.
     *
     * @param {object} o
     * @param {object} [o.replyTo]  envelope of the inbound this turn answers (policy 1)
     * @param {object} [o.explicit] explicit target { platform, chat_id }
     * @param {string} [o.by]       who is asking (§0.2)
     * @returns {{ok:boolean, target?:object, policy:string, reason?:string}}
     */
    resolve({ replyTo = null, explicit = null, by = "" } = {}) {
      // 1 — reply route. The most robust policy: the origin is bound to the envelope at
      //     inbound time, so nothing injected later can displace it.
      if (replyTo && replyTo.source && replyTo.source.kind === "user") {
        const platform = String(replyTo.source.platform || "").trim();
        const chat_id = String(replyTo.source.chat_id || "").trim();
        if (platform && chat_id) {
          return { ok: true, policy: POLICY.REPLY, target: { platform, chat_id, policy: POLICY.REPLY } };
        }
      }

      // 2 — explicit target. The channel parameter exists so the owner can instruct the
      //     agent ("message me on X"). It is honoured, but the leg must still be alive;
      //     otherwise the message is held with a clear reason — never silently rerouted.
      //
      //     A channel without an address is accepted: the bridge looks up the address from
      //     that leg's latest inbound (addressOn) rather than having the model remember chat_ids.
      if (explicit) {
        const platform = String(explicit.platform || "").trim().toLowerCase();
        let chat_id = String(explicit.chat_id || "").trim();
        if (platform && !chat_id) {
          const known = byChannel[platform];
          if (known) chat_id = known.chat_id;
        }
        if (platform && chat_id) {
          const target = { platform, chat_id, policy: POLICY.EXPLICIT };
          if (!isAlive(target)) {
            return { ok: false, policy: POLICY.HOLD,
              reason: "指定的这条腿现在发不出去：" + platform };
          }
          return { ok: true, policy: POLICY.EXPLICIT, target };
        }
        if (platform) {
          return { ok: false, policy: POLICY.HOLD,
            reason: "指定了 " + platform + "，但桥还不知道 owner 在这条腿上的地址（这条腿还没有过入站）" };
        }
      }

      // 3 — proactive message → last active route (owner inbound only, see noteInbound)
      if (lastActive && isAlive(lastActive)) {
        return {
          ok: true, policy: POLICY.LAST_ACTIVE,
          target: { platform: lastActive.platform, chat_id: lastActive.chat_id, policy: POLICY.LAST_ACTIVE },
        };
      }

      // 4 — that route is dead (leg offline / no inbound yet) → preferred route from config
      if (preferred && preferred.platform && preferred.chat_id && isAlive(preferred)) {
        return {
          ok: true, policy: POLICY.PREFERRED,
          target: { platform: preferred.platform, chat_id: preferred.chat_id, policy: POLICY.PREFERRED },
        };
      }

      // 5 — nothing. Hold, don't guess.
      return {
        ok: false, policy: POLICY.HOLD,
        reason: lastActive || preferred ? "所有候选的腿都发不出去" : "还没有过任何入站，也没配首选落点",
      };
    },
  };
}

module.exports = { makeRouter, POLICY };
