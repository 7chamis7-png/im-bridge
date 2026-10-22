"use strict";

const path = require("path");
const { planUndo, describePlan, applyUndo, verifyUndo } = require("./undo");
const { bareModel } = require("./model-fallback-alert");
const registry = require("../box/model-registry");
const { formatWhen } = require("../gate/commands");

/**
 * claude 盒子专属的命令（2026-09-18）—— **不属于桥**
 *
 * 桥自带的命令只有三条：`/new`（换舱）、`/status`（这座桥现在什么样）、`/help`。
 * 那三条对应的是桥自己的概念。
 *
 * 这个文件里的是**只有 claude 这个底座才有**的东西 —— 模型、压缩上下文、
 * 重读指令、切某条会话、批准工具调用。桥不认识「模型」是什么，
 * 也不该认识（换成 codex、grok，这些概念完全不同）。所以它们住在这儿，
 * 由宿主在装配时注册上去。换底座就换一份这个文件，桥一行不动。
 *
 * 2026-09-18 从老桥 34 条里挑出来的。扔掉的三条：
 *   /bind   老桥多工作区的概念，新桥一条会话一个盒子
 *   /star   给 GitHub 点星，跟桥没有半点关系
 *   /chunk  老网关微信的调参，那条腿快退休了
 *
 * ⚠️ 2026-09-18 晚又砍一轮 —— Alice：「所有的指令越简洁越好，不要那么多指令。
 *    有时候我就想查看一下当前模型、线程大小，一条指令就够了」。
 *    这个文件只剩 `/model`、`/stop`、`/undo` 三条：
 *      /compact  有损压缩，她从来没按过；要清爽直接 /new
 *      /reread   低频，真要重读跟他说一句就行
 *      /switch   要手输 threadId，不是给手机用的
 *      /yes /no /always  **死代码**：盒子收到工具许可请求一律自动放行
 *        （gate-box-claudecode.js 的 runtime.approval.requested），
 *        所以 lastApproval 永远是空，这三条按下去只会回「现在没有在等批准的事」。
 * 2026-09-18 又加一条 `/undo`：**退回安全层拒答之前**。
 * 它属于这儿而不是桥，因为 transcript 是 claude 的东西 —— 桥不认识也不该认识。
 * 起因是同一天Alice那边的真事：安全层 flag 掉一轮之后，那条拒答留在历史里，
 * 下一轮带着它一起送上去，于是**一拒再拒**；换线程、换模型都救不了，
 * 真正管用的是把那一轮从历史里拿掉。她要的原话：「直接回滚到模型拒答前一条」。
 *
 * 没接的一条：
 *   /checkin  调的是他主动冒泡的间隔 —— 那是**外面那个 check-in 进程**的事，
 *             不是桥的，也不是盒子的。该由它自己管。
 */

/**
 * @param {object} commands  桥的命令表（pipe.commands）
 * @param {object} o
 * @param {object} o.runtime        claude 运行时适配器
 * @param {string} o.workspaceRoot
 * @param {function} [o.threadId]   () => 当前会话号
 * @param {string}   [o.gateRoot]   桥的账本目录（/undo 要按它清队列、冷层、绑定）
 * @param {function} [o.pauseIntake]  () => Promise<{ok,why?}>  停捞 + 等在途归零
 * @param {function} [o.resumeIntake] () => void                 恢复接收
 */
/**
 * 这份命令表里的名字，**集中写在这一处**（Alice 10-21：跨厂商那条暂定 /engine，名字以后可能改 —— 改这里就行）。
 * /help 的菜单就是桥的命令注册表本身（src/gate/commands.js），同一份，不另抄。
 */
const COMMAND_NAMES = Object.freeze({
  model: "model",     // 同一家内换模型（热切）
  engine: "engine",   // 跨厂商换引擎 = 一次正规换舱
  usage: "usage",     // 现在这家引擎的订阅额度 / 余额
  stop: "stop",
  undo: "undo",
});

/**
 * 2026-10-21 S5：`/model` 的按钮不再写死（原来的 MODEL_CHOICES 三个 claude 名字），从 `$GATE_ROOT/models.json` 生成：
 *   /model  → 登记表里**当前引擎**下的条目
 *   /engine → 登记表里**别的引擎**的条目
 * callback_data 上限 64 字节：超了的条目不出按钮（还能手打）。
 */
function readRegistry(gateRoot) {
  const env = { ...process.env, ...(gateRoot ? { GATE_ROOT: gateRoot } : {}) };
  return registry.loadModelRegistry({ file: registry.modelsFile(env), env });
}

function buttonFor(cmd, m, { current = "" } = {}) {
  const data = `/${cmd} ${m.id}`;
  if (Buffer.byteLength(data, "utf8") > 64) return null;
  const money = m.billing === "api" ? (registry.billingAllowed(m, process.env).ok ? " 💰" : " 💰未开") : "";
  return { text: (m.id === current ? "✓ " : "") + (m.label || m.id) + money, callback_data: data };
}

const engineName = (e) => registry.ENGINE_LABEL[e] || e || "?";

/** /engine 的回执：新模型、窗口、垫了多少轮、降级了什么、第一轮全量重算。 */
function describeSwitch(rc, closing = "", r = null) {
  if (!rc) return `换了，但盒子没给回执（看 nova-box 日志）。${closing || ""}`;
  const L = [];
  L.push(`✅ 换好了：${engineName(rc.from && rc.from.engine)} → ${engineName(rc.engine)}`);
  L.push(`🤖 ${rc.label && rc.label !== rc.model ? `${rc.label}（${rc.model}）` : rc.model}`);
  L.push(`📦 窗口 ${Number(rc.window).toLocaleString()}${rc.verified ? "" : "（人填的，未从引擎核实）"}`);
  L.push(`🧵 新舱 ${String(rc.threadId || "").slice(0, 13) || "(没给号)"}`);
  const src = rc.source === "history" ? "全本" : "冷层";
  L.push(`📜 垫了最近 ${rc.turns} 轮（${rc.records} 条原话，料源 ${src}）${rc.base ? " + 底子" : ""}${rc.droppedTurns ? `，更旧的 ${rc.droppedTurns} 轮窗口装不下` : ""}`);
  if (Array.isArray(rc.degraded) && rc.degraded.length) L.push("⚠️ 降级：" + rc.degraded.join("；"));
  L.push("💸 新舱第一轮全量重算（换了家，缓存不通）");
  if (r && r.base && Array.isArray(r.base.sections)) {
    L.push(`底子 ${r.base.sections.length} 段 ${r.base.total} 字：` + r.base.sections.map((x) => `${x.name} ${x.chars}`).join(" · "));
  }
  if (closing) L.push(closing);
  return L.join("\n");
}

/**
 * /usage 的回执。**只照搬查到的数**：查不到就说查不到（附原因），不编。时间按她的时区（今天只给 HH:mm）。
 */
function describeUsage(u) {
  const head = `📊 额度 · ${engineName(u && u.engine)}${u && u.model ? ` · ${u.model}` : ""}`;
  if (!u || !u.ok) return `${head}\n查不到：${(u && u.why) || "引擎没回"}`;
  const L = [head];
  if (u.kind === "api") {
    L.push("💰 按量计费，没有订阅额度。");
    for (const b of u.balances || []) {
      const parts = [];
      if (b.granted !== null && b.granted !== undefined) parts.push(`赠送 ${b.granted}`);
      if (b.toppedUp !== null && b.toppedUp !== undefined) parts.push(`充值 ${b.toppedUp}`);
      L.push(`余额 ${b.total} ${b.currency}${parts.length ? `（${parts.join(" · ")}）` : ""}`);
    }
    if (!(u.balances || []).length) L.push("余额：接口回了，但没有币种明细。");
    if (u.available === false) L.push("⚠️ 接口说余额不够用了（is_available=false）");
    return L.join("\n");
  }
  for (const w of u.windows || []) {
    const used = w.usedPercent === null || w.usedPercent === undefined ? "?" : `${w.usedPercent}%`;
    L.push(`${/5 小时/.test(w.name) ? "⏱" : "📅"} ${w.name}：用了 ${used}${w.resetsAt ? `（${formatWhen(w.resetsAt)} 重置）` : "（重置时间没给）"}`);
  }
  if (u.plan) L.push(`档位：${u.plan}`);
  if (u.note) L.push(`（实时没读到，用的是 ${u.source}；${u.note}）`);
  return L.join("\n");
}

function registerClaudeCodeCommands(commands, { runtime, box = null, workspaceRoot, threadId = () => "",
  gateRoot = "", pauseIntake = null, resumeIntake = null }) {
  if (!commands || typeof commands.register !== "function") throw new Error("要桥的命令表");
  if (!runtime) throw new Error("要 claude 运行时");
  const ws = String(workspaceRoot || "");
  if (!ws) throw new Error("要 workspaceRoot —— 不许猜，撞了会把会话文件写乱");

  const registered = [];
  const add = (name, handler, desc) => { commands.register(name, handler, { desc }); registered.push(name); };

  /** 现在是哪家、请求的是哪个模型（盒子推上来的快照；老盒子没报 engine 就按登记表推）。 */
  function current(reg) {
    const d = typeof runtime.describe === "function" ? (runtime.describe() || {}) : {};
    const model = d.model || (reg && reg.ok ? reg.default : "") || "";
    const entry = reg && reg.ok ? registry.lookup(reg, model) : null;
    const engine = registry.normalizeEngine(d.engine) || (entry ? entry.engine : "");
    return { model, engine, entry, pinned: Boolean(d.pinned) };
  }

  /** 登记表 + 钱闸的共同前三道（/model /engine 都过）。不过就返回给她看的那句话。 */
  function gateChecks(reg, id) {
    if (!reg.exists) return `没有模型登记表（${reg.file || "$GATE_ROOT/models.json"}），不能换 —— 先放一份（examples/models/ 有示例）。`;
    if (!reg.ok) return `模型登记表读不了：${reg.errors[0] || "?"}`;
    const to = registry.lookup(reg, id);
    if (!to) return `登记表里没有「${id}」—— 不猜。能选：${reg.models.map((m) => m.id).join("、") || "（空）"}`;
    const money = registry.billingAllowed(to, process.env);
    if (!money.ok) return money.why;
    return null;
  }

  add(COMMAND_NAMES.model, async ({ rest }) => {
    const reg = readRegistry(gateRoot);
    const cur = current(reg);
    if (!rest) {
      // ⚠️ **报实际在跑的那个**（盒子从 transcript 读），不是配置里写的。
      // 配置是「请求的」，实际可能 fallback 成别的 —— 现网日志里就见过。
      const f = (box && typeof box.fullness === "function") ? box.fullness() : {};
      const actual = f && f.model;
      const wanted = cur.model || "(默认)";
      // 2026-09-23 Alice：「你不能给我弹快捷指令吗 我直接选」—— 按一下 = 她发了一句 `/model 名字`，直接换，不再二次确认。
      // 2026-10-21：按钮从登记表来，只列**当前引擎**下的；别家的在 /engine 里。
      const buttons = reg.ok
        ? reg.models.filter((m) => m.engine === cur.engine).map((m) => buttonFor(COMMAND_NAMES.model, m, { current: cur.model })).filter(Boolean)
        : [];
      const tail = !reg.exists ? `\n（没有模型登记表 ${reg.file || ""}，/model 换不了）`
        : `\n引擎：${engineName(cur.engine)}。换别家用 /${COMMAND_NAMES.engine}`;
      // 比的时候脱掉 `[1m]`：transcript 里是裸名，配置里带后缀 —— 不脱就每次都误报「没给到」（9-23 抓到）。
      if (actual && bareModel(actual) !== bareModel(wanted) && wanted !== "(默认)") {
        return { text: `**实际在跑：${actual}**（配置里请求的是 ${wanted}，没给到）${tail}`, buttons };
      }
      return { text: (actual ? `实际在跑：${actual}` : `还没跑过轮，读不到实际模型（配置请求的是 ${wanted}）`) + tail, buttons };
    }
    const id = rest.trim();
    const why = gateChecks(reg, id);
    if (why) return { ok: false, text: why };
    const to = registry.lookup(reg, id);
    if (cur.engine && to.engine !== cur.engine) {
      return { ok: false, text: `「${id}」是 ${engineName(to.engine)} 的，现在跑的是 ${engineName(cur.engine)}。`
        + `/model 只换同一家；跨厂商要换舱：/${COMMAND_NAMES.engine} ${id}` };
    }
    // 同一家：热切（setModel，下一轮生效）。盒子那头再按登记表验一遍（钱闸以盒子为准）。
    await runtime.setModelForWorkspace({ workspaceRoot: ws, model: id });
    return { text: `换成 ${to.label && to.label !== id ? `${to.label}（${id}）` : id} 了。下一轮生效。` };
  }, "看 / 换模型（同一家）");

  // ——— /engine：跨厂商换引擎（Alice 10-21：一次正规换舱）———
  // 等这一轮说完 → 收尾轮（跟 /new 一样）→ 新引擎开新舱，forge 用全本或冷层垫尾巴，人格包重新交。
  // 不 resume 旧舱（切回原来那家也是重建）。任何一步不成：留在原引擎，回执说清卡在哪。
  add(COMMAND_NAMES.engine, async ({ rest, say }) => {
    const reg = readRegistry(gateRoot);
    const cur = current(reg);
    const parts = String(rest || "").trim().split(/\s+/).filter(Boolean);
    const now = parts.length > 1 && ["now", "现在", "立刻"].includes(parts[parts.length - 1].toLowerCase());
    const id = now ? parts.slice(0, -1).join(" ") : parts.join(" ");
    if (!id) {
      const head = `现在：${engineName(cur.engine)} · ${cur.model || "(默认)"}`;
      if (!reg.exists) return { text: `${head}\n（没有模型登记表 ${reg.file || ""}，换不了引擎）` };
      if (!reg.ok) return { text: `${head}\n模型登记表读不了：${reg.errors[0] || "?"}` };
      const others = reg.models.filter((m) => m.engine !== cur.engine);
      const buttons = others.map((m) => buttonFor(COMMAND_NAMES.engine, m)).filter(Boolean);
      return { text: `${head}\n` + (others.length
        ? `换到别家 = 一次换舱（等这一轮说完、收尾、新舱第一轮全量重算）。点一个，或者 /${COMMAND_NAMES.engine} <模型> now 先叫停再换。`
        : "登记表里没有别家的模型。"), buttons };
    }
    if (cur.pinned) return { ok: false, text: "GATE_MODEL 钉死了模型，换不了引擎 —— 先把它从 env 里去掉（默认模型改由 models.json 的 default 给）。" };
    const why = gateChecks(reg, id);
    if (why) return { ok: false, text: why };
    const to = registry.lookup(reg, id);
    if (cur.engine && to.engine === cur.engine) {
      return { ok: false, text: `「${id}」跟现在一样是 ${engineName(to.engine)} 的 —— 同一家换模型用 /${COMMAND_NAMES.model} ${id}` };
    }
    if (!commands.rotate) return { ok: false, text: "这座桥没有换舱口，换不了引擎。" };
    // 先问盒子一句「能不能换」（窗口装不装得下等，盒子那头的闸）—— 别先跑了收尾轮才发现换不了
    try { await box.rotate({ reason: `换引擎到 ${id}（预检）`, engine: { model: id, dryRun: true } }); }
    catch (e) { return { ok: false, text: `❌ 没换：${(e && e.message) || e}\n还在原来的 ${cur.model || engineName(cur.engine)}。` }; }
    await say(`排上了：${now ? "先叫停这一轮，" : "等这一轮说完，"}他收个尾，再换到 ${to.label || id}（${engineName(to.engine)}）。这是一次换舱，好了发回执。`);
    if (now && typeof runtime.cancelTurn === "function") {
      try { await runtime.cancelTurn({ threadId: threadId(), turnId: "", workspaceRoot: ws }); } catch { /* 停不了就等它说完 */ }
    }
    let res;
    try { res = await commands.rotate({ reason: `换引擎到 ${id}`, extra: { engine: { model: id } } }); }
    catch (e) { return { ok: false, text: `❌ 没换成。${(e && e.message) || e}\n（收尾那轮已经跑过了，他还在原来的 ${cur.model || engineName(cur.engine)}。）` }; }
    return { text: describeSwitch(res && res.r && res.r.engineSwitch, res && res.closing, res && res.r) };
  }, "换引擎（跨厂商 = 换舱）");

  // ——— /usage：现在这家引擎的订阅额度（5 小时 / 每周，各用了百分之几、什么时候重置）；按量计费的给余额 ———
  add(COMMAND_NAMES.usage, async () => {
    if (typeof runtime.usage !== "function") return { ok: false, text: "这个底座查不了额度。" };
    let u;
    try { u = await runtime.usage(); }
    catch (e) { u = { ok: false, why: (e && e.message) || String(e) }; }
    if (u && !u.engine) u.engine = current(readRegistry(gateRoot)).engine;
    return { ok: Boolean(u && u.ok), text: describeUsage(u) };
  }, "看额度（订阅 5 小时 / 每周，或余额）");

  add(COMMAND_NAMES.stop, async () => {
    if (typeof runtime.cancelTurn !== "function") return { text: "这个底座停不了正在跑的那一轮。" };
    await runtime.cancelTurn({ threadId: threadId(), turnId: "", workspaceRoot: ws });
    // ⚠️ 说清楚「停住了」不等于「他没说过」：已经发出去的那几段收不回来。
    return { text: "叫停了。已经发出去的那几段收不回来，只是后面不再说了。" };
  }, "停掉正在跑的这一轮");

  // ——— 撤销一轮（Alice 2026-09-18 定的规格）———
  //
  // ⚠️ **撤的是「这一轮对后续的影响」，不是删个会话文件。** 她列的三块：
  //   1. 上下文与记忆（CLI 历史、主冷层、影子，以及由它们生成的摘要/交接包/长期记忆）
  //   2. 队列与派生文件（待处理、发送队列、重试、轮次绑定、生成的语音）
  //      —— 采集游标和编号**不倒退不复用**，留无正文的撤销标记防旧消息重进
  //   3. 外部动作与验收（已发的、已建的、已改的，分「已撤销/无法撤销/待处理」）
  // 真正干活的在 `undo.js`；这儿只管**先给影响范围、等她点头、停收、验收、恢复**。
  //
  // 上一次预览的计划放内存里：桥一重启就没了 —— 那种时候本来也该重新算一遍。
  let previewed = null;

  add(COMMAND_NAMES.undo, async ({ rest }) => {
    const arg = String(rest || "").trim().toLowerCase();
    const tid = String(threadId() || "");
    if (!tid) return { text: "现在没有在跑的会话，没什么可退的。" };
    if (!gateRoot) return { text: "装配时没给 gateRoot，撤不了（桥的账本在哪不许猜）。" };

    const execMode = ["ok", "确认", "好"].includes(arg) ? "undo"
      : ["purge", "彻底", "清"].includes(arg) ? "purge" : null;

    // —— 预览档：**只读**，给影响范围 ——
    if (!execMode) {
      const target = arg ? { kind: "before", nativeId: arg } : { kind: "last" };
      const plan = planUndo({ gateRoot, workspaceRoot: ws, threadId: tid, target });
      previewed = plan.ok ? { plan, target, at: Date.now() } : null;
      const tail = plan.ok
        ? "\n\n要真撤：`/undo ok`（留备份，后悔得回来）· `/undo 彻底`（连正文备份一起清，只留审计）"
        : "";
      return { ok: plan.ok, text: describePlan(plan) + tail };
    }

    // —— 执行档 ——
    if (!previewed) return { text: "先空按一次 `/undo` 看影响范围，再来确认。" };

    // 1. 停收 + 等在途归零（**防止删完又被写回来**）
    if (pauseIntake) {
      const paused = await pauseIntake();
      if (!paused.ok) return { ok: false, text: "没撤：" + paused.why + "（在途的没停干净，这时候动手会删完又写回来）" };
    }
    try {
      // 2. 重算一遍 —— 预览到现在可能又进来了消息。**对不上就不动**，让她重看。
      const fresh = planUndo({ gateRoot, workspaceRoot: ws, threadId: tid, target: previewed.target });
      if (!fresh.ok) return { ok: false, text: "没撤：" + fresh.why };
      const same = JSON.stringify(fresh.ids) === JSON.stringify(previewed.plan.ids);
      if (!same) {
        previewed = { plan: fresh, target: previewed.target, at: Date.now() };
        return { ok: false, text: "这中间又有新消息进来了，范围变了。重新看一遍：\n\n" + describePlan(fresh) };
      }

      // 3. 动手
      const r = applyUndo({ plan: fresh, mode: execMode });
      if (!r.ok) return { ok: false, text: "没撤：" + r.why };

      // 3.5 让 CLI 重认叶子（2026-09-21 修断链根因）：删了 transcript 行就必须重连，
      //     否则活着的 CLI 内存里还指着被删的叶子，他下一轮接上去就断链。
      let reloadNote = "";
      if (r.removed && r.removed.transcript > 0 && box && typeof box.reloadCli === "function") {
        try {
          const rl = await box.reloadCli({ workspaceRoot: ws });
          if (rl && rl.busy) reloadNote = "⚠️ 他正在说话，CLI 没能重连——他下一轮可能接到被删的行上，等他停了我再重连一次";
        } catch (e) { reloadNote = "⚠️ CLI 重连没成：" + ((e && e.message) || e) + "（他下一轮可能断链）"; }
      }

      // 4. 验收 —— 她的规格最后一句：检查一致再恢复接收
      const v = verifyUndo(fresh, { mode: execMode });

      const L = [];
      L.push(execMode === "purge" ? "🔥 彻底删除完成。" : "↩️ 撤销完成。");
      const moved = Object.entries(r.removed).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(" · ");
      L.push("动了：" + (moved || "（一处都没有）"));
      L.push(`撤销标记 ${r.tombstones} 条（无正文；采集游标没动，旧消息进不来）`);
      L.push(r.backup ? "备份：" + r.backup : "**没留正文备份**（这是彻底删除那一档）");
      L.push(v.clean ? "验收：干净，没有残留。" : "⚠️ 验收：还有残留 " + v.leftovers.join("、"));
      const undone = fresh.external.sent.filter((x) => /可撤回/.test(x.verdict));
      if (undone.length) L.push(`⚠️ 已经发出去的 ${undone.length} 条**还在她那头**（删历史不等于撤回），要撤你说一声。`);
      if (fresh.external.tools.length) {
        const names = [...new Set(fresh.external.tools.map((t) => t.name))].join("、");
        L.push(`⚠️ 他那轮调过的工具（${names}）动的是别人的库，**这儿没碰**，待处理。`);
      }
      if (fresh.derived.length) L.push(`⚠️ ${fresh.derived.length} 份摘要/交接包混着别轮内容，标成待重建，没删。`);
      if (reloadNote) L.push(reloadNote);
      previewed = null;
      return { text: L.join("\n") };
    } finally {
      // 5. 恢复接收 —— 不管成没成都要恢复，否则她那头就再也进不来了
      if (resumeIntake) { try { resumeIntake(); } catch { /* 恢复失败下一轮心跳看得见 */ } }
    }
  }, "撤销一轮（先给影响范围）");

  return registered;
}

// 中性名（设计稿 §2.5）：这包命令不只是 claude 的了。旧名留着当别名，main.js 的盒子登记表还在用。
module.exports = { registerClaudeCodeCommands, registerBoxCommands: registerClaudeCodeCommands, COMMAND_NAMES, describeSwitch, describeUsage };
