"use strict";
const { INTERNAL_TZ } = require("../core/outward-tz");

/**
 * 命令 —— 她发的哪些话是「让桥干活」而不是「跟他说话」（2026-09-18）
 *
 * 只有**注册过的**命令才拦下来。别的一律原样当正文送进盒子。
 * 这条是死规矩：她发一句 `/想你了`、`/滚`、`/抱抱`，绝不能因为开头有个斜杠
 * 就被桥吞掉 —— 那种消失最难查，她会以为他不理她。
 *
 * ⚠️ 桥**自带的命令只有跟五条口对应的那几个**（换舱、看水位、看账）。
 * 别的命令由宿主注册，桥不认识它们叫什么（铁律 2/3：桥里不出现工具名）。
 * 把某个命令删掉，桥照跑。
 *
 * 命令**不送进盒子**，也**不进对话冷层** —— 她让桥换个舱，那不是跟他说的话。
 * 但要进日志：谁在什么时候让桥干了什么，得查得到。
 */

/** `/new`、`/model opus` → { name, args }。不是命令形状就返回 null。 */
function parse(text) {
  const t = String(text || "").trim();
  if (!t.startsWith("/")) return null;
  const m = /^\/([A-Za-z][A-Za-z0-9_-]*)\s*([\s\S]*)$/.exec(t);
  if (!m) return null;
  return { name: m[1].toLowerCase(), rest: m[2].trim() };
}

/** ISO → 她看的时间（内部时区）。今天只给 HH:mm，不是今天带上月-日 —— 旧到跨天就该扎眼。 */
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
 * @param {object} o.box       盒子（换舱、看水位从这儿来）
 * @param {function} [o.stats] () => 统计
 * @param {function} [o.undelivered] () => 没送到的账
 * @param {function} [o.held]  () => 暂存的那些
 * @param {function} [o.beforeRotate] 换舱之前先做的事（送一轮收尾进去，等他做完）。
 *                                    宿主注入 —— **桥不认识「收尾」是什么**，它只知道
 *                                    换舱之前要先 await 一个宿主给的钩子。
 * @param {function} [o.lastSeen] () => { [channel]: { in?, out? } } 每条腿最后一次真收 / 真发（ISO）
 * @param {function} [o.backlog]  () => { stuck, rejected, dead, check } 待处理总台的数（pending.js）
 */
function makeCommands({ box, stats = null, undelivered = null, held = null, beforeRotate = null, lastSeen = null,
  backlog = null } = {}) {
  const table = new Map();

  /**
   * 换舱的完整流程（收尾轮 → 盒子换舱）。/new 用它；宿主注册的命令（/engine：跨厂商 = 一次正规换舱）也用它。
   * extra 原样递给盒子（桥不认识里面是什么，比如 { engine: { model } }）。
   * ⚠️ 收尾失败**不许挡住换舱**：她让换就得换得成，收尾是加分项不是闸。
   */
  async function rotateWithClosing({ reason = "", extra = {} } = {}) {
    let closing = "";
    if (typeof beforeRotate === "function") {
      const t0 = Date.now();
      try {
        const res = await beforeRotate({ reason });
        const secs = Math.round((Date.now() - t0) / 1000);
        if (res && res.state === "completed") closing = `（他收了尾，用时 ${secs} 秒）`;
        else closing = `（⚠️ 收尾那轮没跑成${res && res.reason ? "：" + String(res.reason).slice(0, 60) : ""} —— 笔记本 / 她最近 可能没更新，照样换了）`;
      } catch (e) {
        closing = `（⚠️ 收尾没跑成：${(e && e.message) || e}，照样换了）`;
      }
    }
    const r = await box.rotate({ reason, ...(extra && typeof extra === "object" ? extra : {}) });
    return { r, closing };
  }

  function register(name, handler, { desc = "" } = {}) {
    const key = String(name || "").trim().toLowerCase().replace(/^\//, "");
    if (!key) throw new Error("命令要有名字");
    if (typeof handler !== "function") throw new Error("命令要有处理函数：" + key);
    table.set(key, { handler, desc });
    return key;
  }

  // —— 桥自带的：**只有桥自己的概念**。别的一律归宿主注册。——
  //
  // 2026-09-18 整合。老桥有 12 条，逐条过了一遍，判准是「这是桥自己的事吗」：
  //   /new                          是 —— 换舱，对应盒子第 4 条口 → 留
  //   /status                       是 —— 这座桥现在什么样 → 留（把水位、欠账、暂存合成一条）
  //   /help                         是 → 留
  //   /model /compact /reread       **不是** —— 模型、压缩、重读指令都是某种底座特有的，
  //                                 桥不认识「模型」这个概念 → 归宿主注册
  //   /yes /no /always              **不是** —— 那是 CLI 的权限问答，盒子内部的事 → 归宿主
  //   /stop                         **不是**（暂时）—— 中断一轮，五条口里没有，见下面那条注释
  //   /bind                         **删** —— 老桥多工作区的概念，新桥一条会话一个盒子
  //   /star                         **删** —— 给 GitHub 点星，跟桥没有半点关系
  //
  // ⚠️ `/stop`（他跑飞了叫停他）现在没人管：盒子五条口里没有「停」。
  //    要么加第六条口，要么宿主自己接 —— 这个得Alice定，别自作主张加接口。
  if (box && typeof box.rotate === "function") {
    register("new", async ({ rest }) => {
      const reason = rest || "她让换的";
      // 关舱前先让他自己收个尾（2026-09-19 Alice拍板）：笔记本、她这一舱说过的要求、
      // 对她近况的判断 —— 这三样是他**自己写**才带得走的，旧舱一关就没了。
      const { r, closing } = await rotateWithClosing({ reason });
      // 底子点名单（2026-09-21）：少一段她当场看见
      let roll = "";
      if (r && r.base && Array.isArray(r.base.sections)) {
        roll = `\n底子 ${r.base.sections.length} 段 ${r.base.total} 字：` + r.base.sections.map((x) => `${x.name} ${x.chars}`).join(" · ");
        // 这一舱带的 IB 注入版本（2026-09-21）：短指纹够她对；没有就明说
        roll += r.base.injection ? `\n注入 ${r.base.injection.sha256.slice(0, 12)}（${r.base.injection.bytes} 字节，${r.base.injection.mtime.slice(0, 10)} 的）` : "\n注入 无";
      }
      return { text: `换好了。新舱 ${r.threadId || "(没给号)"}。${closing}${roll}` };
    }, { desc: "开个新舱" });
  }

  // 一条 /status 顶掉原来的 /full + /undelivered + /held + /stats ——
  // 她要的是「一眼看清现在怎么样」，不是四条命令各看一角。
  // 格式照老桥的风格（一行一项、emoji 领头，她看惯了），但值全是实测的。
  // 老桥那份有两处正好是反面教材：`model` 报的是配置值（配置没设就显示 default，
  // 等于什么也没说），`context` 因为没配窗口只能提示去设环境变量。
  // 前者我们改成读 transcript 拿真模型；后者照抄它的诚实做法 —— 告诉她怎么配。
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
    // 2026-10-22（N10）：卡住 / 拒收待重投 / 死信 / 待核对 —— 以前这几样 /status 一个字都不报，
    // 生产死信里躺了她 4 句话两个礼拜没人知道。有一条不是 0 就提示去 /pending。
    let b = null;
    try { b = backlog && backlog(); } catch { b = null; }
    if (b) {
      const any = (b.stuck || 0) + (b.rejected || 0) + (b.dead || 0) + (b.check || 0);
      lines.push(`🧯 卡住 ${b.stuck || 0} · 拒收待重投 ${b.rejected || 0} · 死信 ${b.dead || 0} · 待核对 ${b.check || 0}`
        + (any ? "（发 /pending 看）" : ""));
    }
    const h = held && held();
    if (h) lines.push(`⏸️ 暂存 ${h.length} 条${h.length ? "（当时找不到落点）" : ""}`);
    const st = stats && stats();
    if (st) lines.push(`📊 进来 ${st.in}（挡下 ${st.blocked}）· 发出 ${st.out} · 沉默 ${st.silent}`);
    // 每条腿最后一次真收 / 真发（2026-09-21 Alice要的）：哪条腿哑了一眼看出来，
    // 不靠「进程 online」—— 进程活着但 poll 卡死的腿，在这儿就是一个越来越旧的时间。
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
    /** [{name, desc}]，注册顺序。TG 菜单从这里生成（telegram-menu.js），跟 /help 同一份。 */
    list: () => [...table.entries()].map(([name, v]) => ({ name, desc: v.desc || "" })),
    /** 换舱（含收尾轮）。没有盒子换舱口时是 null。 */
    rotate: box && typeof box.rotate === "function" ? rotateWithClosing : null,

    /**
     * 这句话是不是一条**桥认识的**命令。
     * @returns {{name:string, rest:string}|null} —— null = 当普通话处理
     */
    match(text) {
      const p = parse(text);
      if (!p) return null;
      return table.has(p.name) ? p : null;      // 没注册过的斜杠开头，**当正文**
    },

    /** 执行。返回给她看的一句话。 */
    /**
     * ctx（可选）：{ say(text) } —— 命令要先回一句再慢慢干（/engine 要等这一轮说完、收尾、起新引擎）时用。
     * 回执还是 handler 的返回值；say 只是先垫一句「排上了」。
     */
    async run({ name, rest = "" }, ctx = {}) {
      const entry = table.get(String(name || "").toLowerCase());
      if (!entry) return { ok: false, text: `没有这条命令：/${name}` };
      try {
        const say = typeof ctx.say === "function" ? ctx.say : async () => {};
        const r = await entry.handler({ rest, say });
        return { ok: true, ...(r || {}) };
      } catch (e) {
        // 命令炸了要如实说，**不许伪装成成功** —— 她按了没反应最难查。
        return { ok: false, text: `/${name} 没执行成功：${(e && e.message) || e}` };
      }
    },
  };
}

module.exports = { makeCommands, parse, formatWhen };
