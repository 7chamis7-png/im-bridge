"use strict";
const { INTERNAL_TZ } = require("../core/outward-tz");

/**
 * Commands — which owner messages are "work for the bridge" rather than "talk to the agent".
 *
 * Only registered commands are intercepted. Anything else is passed to the box verbatim:
 * a message like `/miss-you` must never be swallowed just because it starts with a slash —
 * that kind of disappearance is the hardest to debug.
 *
 * The bridge only ships commands that map to its own box interface (rotate session, status,
 * help). Everything else is registered by the host; the bridge doesn't know their names.
 *
 * Commands are not sent to the box and not written to the cold layer (they aren't
 * conversation), but they are logged.
 */

/** `/new`, `/model opus` → { name, rest }. Returns null if not command-shaped. */
function parse(text) {
  const t = String(text || "").trim();
  if (!t.startsWith("/")) return null;
  const m = /^\/([A-Za-z][A-Za-z0-9_-]*)\s*([\s\S]*)$/.exec(t);
  if (!m) return null;
  return { name: m[1].toLowerCase(), rest: m[2].trim() };
}

/** ISO → display time (internal tz). Today: HH:mm; otherwise M-D HH:mm so stale values stand out. */
function formatWhen(iso, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "?";
  const day = (x) => new Intl.DateTimeFormat("en-CA", { timeZone: INTERNAL_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(x);
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: INTERNAL_TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  if (day(d) === day(now)) return hm;
  const [, m, dd] = day(d).split("-");
  return `${Number(m)}-${Number(dd)} ${hm}`;
}

/**
 * @param {object} o
 * @param {object} o.box       the box (session rotation, context fullness)
 * @param {function} [o.stats] () => counters
 * @param {function} [o.undelivered] () => undelivered ledger
 * @param {function} [o.held]  () => held messages
 * @param {function} [o.beforeRotate] host hook awaited before rotating (e.g. a closing turn).
 *                                    The bridge doesn't know what it does.
 * @param {function} [o.lastSeen] () => { [channel]: { in?, out? } } last real receive / send per leg (ISO)
 */
function makeCommands({ box, stats = null, undelivered = null, held = null, beforeRotate = null, lastSeen = null } = {}) {
  const table = new Map();

  function register(name, handler, { desc = "" } = {}) {
    const key = String(name || "").trim().toLowerCase().replace(/^\//, "");
    if (!key) throw new Error("命令要有名字");
    if (typeof handler !== "function") throw new Error("命令要有处理函数：" + key);
    table.set(key, { handler, desc });
    return key;
  }

  // Built-in commands cover only bridge concepts: /new (rotate session), /status, /help.
  // Model selection, compaction, permission prompts etc. are backend-specific and are
  // registered by the host.
  if (box && typeof box.rotate === "function") {
    register("new", async ({ rest }) => {
      const reason = rest || "owner 手动换舱";
      // Give the agent a closing turn before rotating, so it can persist whatever it wants to
      // carry into the next session. A failed closing turn must never block the rotation.
      let closing = "";
      if (typeof beforeRotate === "function") {
        const t0 = Date.now();
        try {
          const res = await beforeRotate({ reason });
          const secs = Math.round((Date.now() - t0) / 1000);
          if (res && res.state === "completed") closing = `（agent 收了尾，用时 ${secs} 秒）`;
          else closing = `（⚠️ 收尾那轮没跑成${res && res.reason ? "：" + String(res.reason).slice(0, 60) : ""} —— 收尾内容可能没更新，照样换了）`;
        } catch (e) {
          closing = `（⚠️ 收尾没跑成：${(e && e.message) || e}，照样换了）`;
        }
      }
      const r = await box.rotate({ reason });
      // Report which base sections the new session was assembled from, so a missing one is visible.
      let roll = "";
      if (r && r.base && Array.isArray(r.base.sections)) {
        roll = `\n底子 ${r.base.sections.length} 段 ${r.base.total} 字：` + r.base.sections.map((x) => `${x.name} ${x.chars}`).join(" · ");
        // Fingerprint of the injection file loaded into this session (or "none").
        roll += r.base.injection ? `\n注入 ${r.base.injection.sha256.slice(0, 12)}（${r.base.injection.bytes} 字节，${r.base.injection.mtime.slice(0, 10)} 的）` : "\n注入 无";
      }
      return { text: `换好了。新舱 ${r.threadId || "(没给号)"}。${closing}${roll}` };
    }, { desc: "开个新舱" });
  }

  // One /status line-per-item overview. Values are measured, not configured: the model is
  // read from the transcript; when no context limit is configured, say how to configure it.
  register("status", async () => {
    const lines = [];
    if (box && typeof box.fullness === "function") {
      const f = box.fullness() || {};
      if (f.threadId) lines.push(`🧵 会话 ${String(f.threadId).slice(0, 8)}…`);
      lines.push(f.model ? `🤖 模型 ${f.model}（实际在跑的）` : "🤖 模型 还没跑过轮，读不到");
      if (f.ratio != null && f.limit) {
        lines.push(`📦 上下文 ${Number(f.used).toLocaleString()} / ${Number(f.limit).toLocaleString()}（${(f.ratio * 100).toFixed(1)}%）`);
      } else {
        lines.push(`📦 上下文 ${Number(f.used || 0).toLocaleString()} token`);
        lines.push("   （上限没配，所以不报百分比 —— 配 GATE_BOX_CONTEXT_LIMIT 就有）");
      }
    }
    const u = undelivered && undelivered();
    if (u) {
      const sum = u.summary();
      lines.push(sum.total
        ? `📬 没送到 ${sum.total} 条：可以重来 ${sum["可以重来"]}、等人核对 ${sum["等人核对"]}`
        : "📬 没送到 0 条");
    }
    const h = held && held();
    if (h) lines.push(`⏸️ 暂存 ${h.length} 条${h.length ? "（当时找不到落点）" : ""}`);
    const st = stats && stats();
    if (st) lines.push(`📊 进来 ${st.in}（挡下 ${st.blocked}）· 发出 ${st.out} · 沉默 ${st.silent}`);
    // Last real receive/send per leg: a leg whose process is alive but whose poll is stuck
    // shows up as an ever-older timestamp.
    const seen = lastSeen && lastSeen();
    if (seen && Object.keys(seen).length) {
      const chs = Object.keys(seen).sort();
      const fmt = (iso) => (iso ? formatWhen(iso) : "—");
      lines.push("👂 最后收到 " + chs.map((c) => `${c} ${fmt(seen[c].in)}`).join(" · "));
      lines.push("📤 最后发出 " + chs.map((c) => `${c} ${fmt(seen[c].out)}`).join(" · "));
    }
    return { text: lines.join("\n") || "这座桥还没有账。" };
  }, { desc: "这座桥现在什么样" });

  register("help", async () => ({
    text: "💡 能用的命令：\n" + [...table.entries()]
      .map(([k, v]) => `  /${k}${" ".repeat(Math.max(1, 10 - k.length))}${v.desc || ""}`).join("\n"),
  }), { desc: "有哪些命令" });

  return {
    register,
    names: () => [...table.keys()],

    /**
     * Is this text a command the bridge knows?
     * @returns {{name:string, rest:string}|null} — null = treat as normal text
     */
    match(text) {
      const p = parse(text);
      if (!p) return null;
      return table.has(p.name) ? p : null;      // unregistered slash text is treated as body
    },

    /** Run. Returns the text shown to the owner. */
    async run({ name, rest = "" }) {
      const entry = table.get(String(name || "").toLowerCase());
      if (!entry) return { ok: false, text: `没有这条命令：/${name}` };
      try {
        const r = await entry.handler({ rest });
        return { ok: true, ...(r || {}) };
      } catch (e) {
        // Report failures honestly; never pretend success.
        return { ok: false, text: `/${name} 没执行成功：${(e && e.message) || e}` };
      }
    },
  };
}

module.exports = { makeCommands, parse };
