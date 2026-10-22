"use strict";

/**
 * 路由 —— 这句话发到哪去（2026-09-18，Alice定的五档，见 docs/SPEC.md §4）
 *
 * **投递决策不归模型，也不归工具。** 他说什么是他的事，发到哪是桥的事。
 * 所以桥给出去的那个投递口上**根本没有「发给谁」这个参数** —— 想指定也指定不了。
 *
 * 五档，按顺序往下走，命中即停：
 *
 *   1. 有原路      这一轮是回她某条入站的 → 原路返回
 *   2. 有显式落点  只有桥外面的产生者（晨笺那种）可以给；**工具不行**
 *   3. 主动消息    走「最近活跃路」
 *   4. 那条失效了  走「首选路」（**配置里写，不是代码里写死**）
 *   5. 都没有      **暂存，不猜**
 *
 * 第 5 档是整套里最要紧的一条：宁可让这句话躺着等人来看，也不许随便挑一条腿发出去。
 * 「猜一个」的后果她见过 —— 8-29 她在 TG 说话，他的回答跑去了微信。
 */

/** 五档的名字。落点上会带着「是按哪一档解析出来的」，出了事一眼知道该查谁。 */
const POLICY = Object.freeze({
  REPLY: "reply_route",         // 1 原路
  EXPLICIT: "explicit_target",  // 2 产生者指定
  LAST_ACTIVE: "last_active",   // 3 最近活跃
  PREFERRED: "preferred",       // 4 首选
  HOLD: "hold",                 // 5 暂存不猜
});

/**
 * @param {object} o
 * @param {object|null} [o.preferred] 首选落点 { platform, chat_id }，**从配置来**
 * @param {function} [o.isAlive] (route) => boolean，这条腿现在还能发吗；不给就一律当能发
 * @param {function} [o.now]
 */
function makeRouter({ preferred = null, isAlive = () => true, now = () => Date.now(), file = "" } = {}) {
  /** 最近一条**她的**入站是从哪来的 */
  let lastActive = null;
  // 她在**每条腿**上的最近地址。
  // 为什么要按渠道各记一份：她说「你发我微信」时，他只说得出渠道、说不出 chat_id
  // —— 地址不该让模型记，该由桥查（2026-09-18）。
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
     * 记一条入站。
     *
     * ⚠️ **只算她说话，不算他说话。** 他在微信上回了一句，不代表她人在微信那头；
     * 按他的出站算「最近活跃」，就会出现「她在 TG 问、他往微信答」——
     * 8-29 那次投错渠道就是这个形状。
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
        // 新形状带 byChannel；旧文件（只有 platform/chat_id）读得回来，见上面
        fs.writeFileSync(tmp, JSON.stringify({ lastActive, byChannel }), { mode: 0o600 });
        fs.renameSync(tmp, file);
      }
      return lastActive;
    },

    lastActive: () => (lastActive ? { ...lastActive } : null),

    /** 她在某条腿上的地址（她说「发我微信」时，桥替他查）。查不到给 null，不猜。 */
    addressOn: (platform) => {
      const k = String(platform || "").trim().toLowerCase();
      const hit = byChannel[k];
      return hit ? { ...hit } : null;
    },

    /**
     * 定这一句话的落点。
     *
     * @param {object} o
     * @param {object} [o.replyTo]  这一轮在回的那条入站的信封（有就是第 1 档）
     * @param {object} [o.explicit] 产生者指定的落点 { platform, chat_id }
     * @param {string} [o.by]       谁在要落点：**"tool" 一律忽略 explicit**（§0.2）
     * @returns {{ok:boolean, target?:object, policy:string, reason?:string}}
     */
    resolve({ replyTo = null, explicit = null, by = "" } = {}) {
      // 1 —— 有原路。**最结实的一档**：来路是入站那一刻绑死在信封上的，
      //      前面贴多少状态条、注入多少东西都顶不掉它。
      if (replyTo && replyTo.source && replyTo.source.kind === "user") {
        const platform = String(replyTo.source.platform || "").trim();
        const chat_id = String(replyTo.source.chat_id || "").trim();
        if (platform && chat_id) {
          return { ok: true, policy: POLICY.REPLY, target: { platform, chat_id, policy: POLICY.REPLY } };
        }
      }

      // 2 —— 显式指定的落点。
      //
      // ⚠️ 2026-09-18 Alice推翻了原来那条「工具给的一律扔掉」。留渠道参数**不是**
      //    为了让他自己挑渠道，是为了**她能指令他**：「你往哪哪给我发条消息」。
      //    所以听他的 —— 但只是"听"：腿在不在照样过闸，不行就暂存并说清楚，
      //    **绝不静默改投别的渠道**（今天出的事是"发错了没人说"，不是"他选了渠道"）。
      //
      //    只给渠道、没给地址也认：地址由桥按那条腿的最近入站查（addressOn），
      //    不该让模型去记 chat_id。
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
            reason: "指定了 " + platform + "，但桥还不知道她在这条腿上的地址（这条腿还没有过入站）" };
        }
      }

      // 3 —— 主动消息走最近活跃路（只按她的入站算，见 noteInbound）
      if (lastActive && isAlive(lastActive)) {
        return {
          ok: true, policy: POLICY.LAST_ACTIVE,
          target: { platform: lastActive.platform, chat_id: lastActive.chat_id, policy: POLICY.LAST_ACTIVE },
        };
      }

      // 4 —— 那条失效了（腿掉线、还没有过入站）→ 首选路，配置给的
      if (preferred && preferred.platform && preferred.chat_id && isAlive(preferred)) {
        return {
          ok: true, policy: POLICY.PREFERRED,
          target: { platform: preferred.platform, chat_id: preferred.chat_id, policy: POLICY.PREFERRED },
        };
      }

      // 5 —— 都没有。**暂存，不猜。**
      return {
        ok: false, policy: POLICY.HOLD,
        reason: lastActive || preferred ? "所有候选的腿都发不出去" : "还没有过任何入站，也没配首选落点",
      };
    },
  };
}

module.exports = { makeRouter, POLICY };
