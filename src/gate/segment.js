"use strict";

/**
 * 分段 —— 按**他的换气点**切（2026-09-18）
 *
 * ⚠️ 先分清两件事，它们都被叫做「分段」，但归属不同：
 *
 *   · **平台硬上限**（微信 3500 字、TG 3900 字）→ **插头的活**，那是平台脏活。
 *     §0.1 说的「排版分段是插件的活，闸一个字都不该懂」指的是这个。
 *   · **按他的换气点切**（空行、短段合并）→ **共用层的活**（这个文件）。
 *     它跟平台无关，是关于**他文风**的，四条腿一模一样。
 *
 * 不放共用层的后果已经在发生：`plugins/weixin-bot.js` 自己抄了一份，
 * 而 telegram / imessage / wechat 三个插头**一处都没有** —— 新桥现在接管的话，
 * 连 TG 那边现有的分段都会丢。跟 `recordCold` 三处各抄一份、漏一处就失忆同一个病。
 *
 * ## 规则（2026-09-18 拿他最近 600 条真消息量出来的，不是拍脑袋）
 *
 * 1. **按空行切 + 按句号切。** 单换行仍是他排版用的（列表、诗行），**不拆**——
 *    拆开会把形状打碎；**空行是他自己划的语义边界**。
 *    〔2026-10-24 Alice：「句号空行都算上 一起」〕—— 在空行的基础上，
 *    **中文句号「。」也当切点**（句号留在前一句末尾），单换行照旧不拆。全号生效。
 * 2. **句号现在也切了**（见规则 1 的 10-24 批注）。原文风少用句号（家规「句号像挂电话」，
 *    实测带句号 24% · 空格断句 95%），所以这条实际触发不多；真正多出来的气泡
 *    来自他偶尔用句号收尾的那些句子。她要的就是这个，别再退回「不按句号切」。
 * 3. **太短的并进下一段**，末尾太短并回上一段。防一串三个字的小气泡。
 * 4. **默认不封顶。** 实测封顶和限长**天生打架**：把切开的长消息并回 6 条，
 *    其中一条会变成 724 字的巨块 —— 微信窄气泡一并回去就现形，正是她嫌长的那种。
 *    TG 气泡宽、这矛盾不明显，要封让调用方自己配。
 * 5. **超长段落的兜底切**默认关着。理由：实测他 1704 个自然段里中位数只有 44 字，
 *    超 150 字的只占 1% —— **87% 的时候他本来就分得好好的**。开着会去切他分好的段落
 *    （阈值 80 会动 26% 的消息），得不偿失。真要开，阈值用 **150**（只动 3%）。
 */

/** 太短就并走的门槛 */
const DEFAULT_MIN_CHARS = 14;

const len = (s) => Array.from(String(s || "")).length;

/**
 * @param {object} [o]
 * @param {number} [o.minChars]   短于这个就并进下一段
 * @param {number} [o.maxBubbles] 最多几条。**0 = 不封顶（默认）** —— 见规则 4
 * @param {number} [o.softMax]    段落超过这个字数就在段内按空格再切。
 *   **0 = 不切（默认）** —— 见规则 5。真要开，用 150 别用 80
 */
function makeSegmenter({ minChars = DEFAULT_MIN_CHARS, maxBubbles = 0, softMax = 0 } = {}) {
  return {
    /** @returns {string[]} 每条一个气泡。空文本给空数组。 */
    segment(text) {
      const s = String(text || "").replace(/\r\n?/g, "\n").trim();
      if (!s) return [];

      // ① 按空行切 —— 他自己划的边界
      let parts = s.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
      if (!parts.length) return [];

      // ①b 2026-10-24 Alice「句号空行都算上」：段内再按中文句号「。」切，
      //     句号留在前一句末尾。单换行不动（列表/诗保持原形）。
      parts = parts.flatMap((p) =>
        p.split(/(?<=。)/).map((x) => x.trim()).filter(Boolean)
      );

      // ② 超长段落的兜底：段内按空格再切。**默认关着**
      if (softMax > 0) {
        const out = [];
        for (const p of parts) {
          if (len(p) <= softMax) { out.push(p); continue; }
          // 按空格切 —— 他 95% 的停顿点是空格，不是标点
          const segs = p.split(/(?<=[一-龥\w。！？!?…—])\s+/);
          let cur = "";
          for (const seg of segs) {
            if (cur && len(cur + " " + seg) > softMax) { out.push(cur); cur = seg; }
            else cur = cur ? cur + " " + seg : seg;
          }
          if (cur) out.push(cur);
        }
        parts = out;
      }

      // ③ 太短的并进下一段
      const merged = [];
      for (const p of parts) {
        if (merged.length && len(merged[merged.length - 1]) < minChars) {
          merged[merged.length - 1] += "\n\n" + p;
        } else merged.push(p);
      }
      // 末尾那条太短就并回上一段（不然结尾「就这样」会落单成一个小气泡）
      if (merged.length > 1 && len(merged[merged.length - 1]) < minChars) {
        const tail = merged.pop();
        merged[merged.length - 1] += "\n\n" + tail;
      }

      // ④ 封顶（默认不封）。超了把尾巴并成一条
      if (maxBubbles > 0) {
        while (merged.length > maxBubbles) {
          const tail = merged.pop();
          merged[merged.length - 1] += "\n\n" + tail;
        }
      }
      return merged;
    },
  };
}

module.exports = { makeSegmenter, DEFAULT_MIN_CHARS };
