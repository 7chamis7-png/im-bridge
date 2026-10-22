"use strict";

/**
 * 一键回退开关（2026-09-17 Alice问「要不要做个兜底」）
 *
 * **兜底不做成「发失败了自动换老路重发」** —— 当天出站实发验证撞见的正是那个形态：
 * 消息 1 秒就真发出去了，调用方挂到超时报了 `outbound.unknown`。
 * 自动重发在那一刻就是**发两遍**。结果不明 ≠ 没发出去，这条闸里本来就写着。
 *
 * 所以兜底做成**一个文件开关**，跟现网 `.a11y-enabled` 同款：
 *   有文件 → 走新桥        删掉文件 → 下一轮回老路
 * **不用改代码、不用重启、不打断Nova。**「坏了多久能退回来」= 一条 rm，下一轮生效。
 *
 * 判据只有一条：**读不到就当关着**（fail-safe）。文件系统抽风、权限变了、
 * 目录被挪走 —— 任何看不清的情况都回老路，不赌。
 */

const fs = require("fs");

/**
 * ⚠️ 铁律 1（docs/SPEC.md）：**代码里不许有写死的路径。**
 * 这里原来默认 "/root/.nova/.gate-enabled" —— 换台机器就得改代码，拷走跑不起来。
 * 现在必须由调用方给；没给就当场说清楚缺哪一样，不许猜一个。
 */
function requireFlagFile(v) {
  const s = String(v || "").trim();
  if (!s) throw new Error("KillSwitch 要一个开关文件路径（flagFile）—— 不许用默认值猜");
  return s;
}
const DEFAULT_TTL_MS = 1000;      // 每轮 stat 一次就够，别每条消息都打文件系统

class KillSwitch {
  constructor({ flagFile, ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
    flagFile = requireFlagFile(flagFile);
    this.flagFile = flagFile;
    this.ttlMs = ttlMs;
    this.now = now;
    this._cachedAt = -Infinity;
    this._cached = false;
    this._lastLogged = null;
  }

  /** 新桥现在该不该接管。读不到一律 false。 */
  enabled() {
    const t = this.now();
    if (t - this._cachedAt < this.ttlMs) return this._cached;
    let on = false;
    try { on = fs.statSync(this.flagFile).isFile(); } catch { on = false; }
    this._cachedAt = t;
    this._cached = on;
    return on;
  }

  /** 状态变了才返回一行给日志，不然每轮刷屏。 */
  transition() {
    const on = this.enabled();
    if (this._lastLogged === on) return null;
    this._lastLogged = on;
    return on ? "新桥已接管（" + this.flagFile + " 存在）"
              : "新桥已停用，走老路（" + this.flagFile + " 不存在）";
  }
}

module.exports = { KillSwitch };
