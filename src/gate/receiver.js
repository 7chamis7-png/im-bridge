"use strict";

/**
 * 收信人 —— 共用层的「捞上来之后怎么算数」（2026-09-18，SPEC §5）
 *
 * 分界线（SPEC §1）：**插头只管从平台捞，游标归共用层。**
 * 插头自己推进游标的话，进程一崩，那几条就永远丢了 —— 平台那头已经认为
 * 「你收到了」，而我们这头什么都没留下。
 *
 * 这里管三件事，每件都是拿教训换的：
 *
 * 1. **消化完了才推进游标。** 一条真的走完（进了盒子、该落的落了）才算数。
 *    崩在半路 = 游标没动 = 下次重来。宁可重放一条，也不许静悄悄漏一条。
 *
 * 2. **一条处理不了，不许卡住整条腿。** 卡住的后果是她说的每一句话都进不来，
 *    而且她看不出为什么。所以：记进死信、游标照样推进、**大声报**。
 *    死信里留着原始记录，随时能补投——这跟「漏掉」是两回事。
 *
 * 3. **同一条不重复吃。** 平台重传、我们重放，都靠 `native_id` 去重
 *    （那是平台自己的消息 id）。去重在入闸里（它本来就认这个），这里只负责
 *    把原始记录原样交上去，不自作主张。
 */

const fs = require("fs");
const path = require("path");

/** 游标：一条腿一份，落盘。**路径由调用方给**（铁律 1）。 */
function makeCursorStore({ file }) {
  if (!String(file || "").trim()) throw new Error("游标要一个文件路径 —— 不许用默认值猜");
  return {
    /**
     * 游标可以是数字，也可以是**不透明字符串**（2026-09-18）。
     * TG 是 update_id（数字），老网关是 `get_updates_buf`（一串谁也不该解析的东西）。
     * 共用层只负责**原样存、原样取**，不解释它的含义。
     */
    read() {
      try {
        const v = JSON.parse(fs.readFileSync(file, "utf8")).cursor;
        return v === undefined || v === null ? 0 : v;
      } catch { return 0; }
    },
    // 先写临时文件再改名：写到一半断电，游标不会变成半截 JSON
    write(cursor) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ cursor, at: new Date().toISOString() }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
}

/** 死信：处理不了的那条原样躺在这儿，等人来看。**只追加，不删改。** */
function makeDeadLetter({ file }) {
  if (!String(file || "").trim()) throw new Error("死信要一个文件路径 —— 不许用默认值猜");
  return {
    put(entry) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", { encoding: "utf8", mode: 0o600 });
    },
    list() {
      try {
        return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      } catch { return []; }
    },
  };
}

/**
 * @param {object} o
 * @param {object} o.plugin      这条腿的插头，要有 poll()
 * @param {object} o.cursor      游标（makeCursorStore）
 * @param {object} o.deadLetter  死信（makeDeadLetter）
 * @param {function} o.handle    (raw, meta) => Promise —— 一条原始记录怎么消化。
 *   **抛错 = 这条没消化成**，收信人据此决定进死信；不抛就算成了。
 * @param {function} [o.log]
 */
function makeReceiver({ plugin, cursor, deadLetter, handle, enabled = () => true, log = () => {} }) {
  if (!plugin || typeof plugin.poll !== "function") {
    throw new Error("这条腿的插头不会自己捞消息（缺 poll）—— 收信人没法工作");
  }
  if (typeof handle !== "function") throw new Error("收信人要一个 handle（一条记录怎么消化）");

  let stopped = false;
  const stats = { got: 0, ok: 0, dead: 0, ticks: 0 };

  /**
   * 捞一批、逐条消化、**一条一条推进游标**。
   *
   * 逐条而不是整批：第 3 条挂了，前两条不该重放一遍（她会看到他把同一句话回两遍）。
   */
  async function tick({ timeoutSec = 25 } = {}) {
    stats.ticks += 1;
    const since = cursor.read();
    if (!enabled()) return { got: 0, ok: 0, dead: 0, cursor: since, paused: true };
    const { items } = await plugin.poll({ since, timeoutSec });
    let ok = 0, dead = 0;
    for (const item of items || []) {
      if (stopped || !enabled()) break;
      stats.got += 1;
      // 消化完这条之后游标该是什么 —— **插头自己说**（`item.cursor`）。
      // 只有它知道自己的游标长什么样：TG 是 update_id+1，老网关是一串不透明的 buf。
      // 没说才退回 TG 那套（update_id + 1），保持老插头不用改。
      const next = item.cursor !== undefined && item.cursor !== null
        ? item.cursor
        : Number(item.update_id) + 1;
      try {
        await handle(item.message ?? item, { channel: plugin.channel, nativeCursor: item.update_id });
        ok += 1; stats.ok += 1;
        cursor.write(next);                       // ← 消化完了才算数
      } catch (e) {
        // 处理不了：留原件、往前走、大声说。**卡住整条腿比漏一条更糟。**
        dead += 1; stats.dead += 1;
        deadLetter.put({
          channel: plugin.channel,
          cursor: item.update_id,
          error: String((e && e.message) || e),
          raw: item.message ?? item,
        });
        cursor.write(next);
        log(`[收信] ${plugin.channel} 有一条消化不了，已进死信、不卡后面的：${(e && e.message) || e}`);
      }
    }
    return { got: (items || []).length, ok, dead, cursor: cursor.read() };
  }

  return {
    tick,
    stats: () => ({ ...stats }),
    stop() { stopped = true; },
    /** 一直收，直到 stop()。出错就歇一下再来，别把平台打死。 */
    async run({ timeoutSec = 25, idleMs = 0, onError = null } = {}) {
      stopped = false;
      while (!stopped) {
        try {
          const result = await tick({ timeoutSec });
          if (result.paused) await new Promise((r) => setTimeout(r, 1000));
        } catch (e) {
          // 捞不上来（网断了、平台抽风）——这不是某一条的问题，游标一动不动，
          // 歇一下重来。**绝不把它当成「这批消息不存在」。**
          if (onError) onError(e); else log(`[收信] ${plugin.channel} 捞不上来：${(e && e.message) || e}`);
          await new Promise((r) => setTimeout(r, 2000));
        }
        if (idleMs) await new Promise((r) => setTimeout(r, idleMs));
      }
    },
  };
}

module.exports = { makeReceiver, makeCursorStore, makeDeadLetter };
