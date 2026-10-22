"use strict";

/**
 * 盒子 —— 跑 CLI 的那个东西（2026-09-18，Alice定的五条口）
 *
 * **桥不认识 claude，也不认识 codex、grok。** 它只认这五条：
 *
 *   1. deliver(信封)     送一轮进去
 *   2. onReply(fn)       把他的话拿出来
 *   3. onTurnDone(fn)    这一轮说完了
 *   4. rotate(理由)      开个新舱
 *   5. fullness()        现在多满了
 *
 * 那些**只有某一种底座才有的脏活**（claude 的 resume 保温度、forge 把冷层原话
 * 塞回会话文件、安全层掉档、上下文裁剪；codex 的 rollout-seed 版本锁）
 * **全部关在盒子里面**，一条都不许漏到桥上。Iris那个盒子装的是它自己的脏活，
 * 桥这头看到的一模一样 —— 这就是「换底座不动桥」的全部含义。
 *
 * ⚠️ 接口**照 claude 的需要定**，codex 和 grok 能接多少接多少。
 *    不为了通用而通用：硬做成「什么都能接」的抽象，只会在桥里塞一堆 if。
 *
 * 真实现住在桥外面（`src/host/`），因为那是**用桥的人**的事。这个文件只有三样：
 * 契约、装配时的体检、和一个不起进程的假盒子（测试用）。
 */

/** 五条口的方法名。装配时照着点名，少一条当场说。 */
const BOX_CONTRACT = Object.freeze({
  deliver: "送一轮进去",
  onReply: "把他的话拿出来",
  onTurnDone: "这一轮说完了",
  rotate: "开个新舱",
  fullness: "现在多满了",
});

/**
 * 装配体检：这个盒子五条口齐不齐。
 *
 * **在接线那一刻就报，不要等她说话的时候才炸。** 9-17 的教训：
 * 装配「成功」、测试全绿、开关一开却整条吞掉——因为没人在装配时点过名。
 *
 * @param {object} box
 * @returns {object} box 本身（方便 `const b = assertBox(...)` 这么写）
 */
function assertBox(box) {
  if (!box || typeof box !== "object") throw new Error("盒子没给（桥没有盒子就没法把话送进去）");
  const missing = Object.keys(BOX_CONTRACT).filter((k) => typeof box[k] !== "function");
  if (missing.length) {
    throw new Error("盒子缺这几条口：" + missing.map((k) => `${k}（${BOX_CONTRACT[k]}）`).join("、"));
  }
  return box;
}

/**
 * 送进盒子的那一轮 —— **就是一个信封**（envelope.js）。
 * 校验直接用信封那一份，**不在这儿另写一份**：两套判据迟早各自往下漂，
 * 而漂的那天谁也不知道到底以哪份为准。
 */
const { assertEnvelope } = require("./envelope");
const assertTurnIn = assertEnvelope;

/**
 * 假盒子：不起进程、不花钱、同步回答。
 *
 * 它存在的理由是**让一整轮对话在两秒内跑完**：现在想验一遍桥，必须真把 claude
 * 起起来、真等他想、真烧一次额度。有了假盒子，插头 → 闸 → 盒子 → 出闸 → 插头
 * 这一整条可以在测试里端到端跑，而且想跑几遍跑几遍。
 *
 * @param {object} [o]
 * @param {function} [o.answer]  (envelope) => string | string[] | null
 *        他这一轮说什么。返回 null / "" = **他选择不说**（§0.3 的沉默，不是故障）。
 *        返回数组 = 分几段说（每段一次 onReply）。
 * @param {number} [o.fullnessRatio] 水位，默认 0.1
 * @param {function} [o.now]
 */
function makeFakeBox({ answer = () => "嗯", fullnessRatio = 0.1, now = () => Date.now() } = {}) {
  const replyHandlers = [];
  const doneHandlers = [];
  let threadId = "fake-thread-1";
  let turnSeq = 0;
  let rotations = 0;
  /** 进来过的每一轮，测试拿它对账 */
  const seen = [];

  return {
    /** 送一轮进去。**同步算完再回**，但仍然返回 Promise，跟真盒子一个形状。 */
    async deliver(envelope) {
      assertTurnIn(envelope);
      seen.push(envelope);
      const turnId = `fake-turn-${++turnSeq}`;
      const out = answer(envelope);
      const chunks = out == null ? [] : (Array.isArray(out) ? out : [String(out)]).filter((c) => String(c).trim());
      for (const text of chunks) {
        for (const fn of replyHandlers) fn({ turnId, threadId, text, trace_id: envelope.trace_id, at: now() });
      }
      // 一轮说完了 —— **一条都没说也要发这个**，否则出闸永远等不到「他不说」这个结论。
      for (const fn of doneHandlers) {
        fn({ turnId, threadId, trace_id: envelope.trace_id, silent: chunks.length === 0, at: now() });
      }
      return { turnId, threadId };
    },
    onReply(fn) { replyHandlers.push(fn); return () => replyHandlers.splice(replyHandlers.indexOf(fn), 1); },
    onTurnDone(fn) { doneHandlers.push(fn); return () => doneHandlers.splice(doneHandlers.indexOf(fn), 1); },
    async rotate({ reason = "" } = {}) {
      rotations += 1;
      threadId = `fake-thread-${rotations + 1}`;
      return { threadId, reason };
    },
    fullness() { return { ratio: fullnessRatio, used: Math.round(fullnessRatio * 1000), limit: 1000, model: "(假盒子)", threadId }; },

    // —— 下面这些只有假盒子有，给测试对账用 ——
    _seen: seen,
    _rotations: () => rotations,
    _threadId: () => threadId,
  };
}

module.exports = { BOX_CONTRACT, assertBox, assertTurnIn, makeFakeBox };
