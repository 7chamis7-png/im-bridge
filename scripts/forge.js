"use strict";
// forge：换 session 时把"最近冷层原话"当真实轮接进新 jsonl 再 resume，让Nova"还在场"而非"读卷宗"。
// 安全纪律：任何闸不过 → {ok:false}，调用方回落今天的冷层注入，并发窗口 [系统] 提示。绝不静默。
// 默认关：仅 FORGE_ENABLED=true 且 forge-state.json 钉过的 CC 版本与当前一致时才生效。
// 验证：`node scripts/forge.js validate` 在 scratch session 上跑金丝雀，过了就钉当前 CC 版本。CC 升级后须重跑。
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execSync } = require("child_process");
const crypto = require("crypto");
const { ConversationRecoveryService } = require("../src/services/conversation-recovery-service");
const { getPendingHandoff, getPendingTailRecords } = require("../src/services/session-handoff-state");
const { OUTWARD_TZ, OUTWARD_LOCALE } = require("../src/core/outward-tz");

const { homePath, personaStateDir } = require("../src/core/paths");
const { ownerDisplayName, agentDisplayName, agentAlertName } = require("../src/core/names");

const STATE_FILE = process.env.FORGE_STATE_FILE
  || path.join(personaStateDir(), "forge-state.json");

const uuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

function claudeVersion() {
  try { return execSync("claude --version").toString().trim().split(" ")[0]; }
  catch { return "unknown"; }
}
function projectDirFor(workspace) {
  return path.join(os.homedir(), ".claude", "projects", String(workspace).replace(/\//g, "-"));
}
function latestJsonlIn(dir) {
  try {
    const fs2 = require("fs");
    const files = fs2.readdirSync(dir).filter(f => f.endsWith(".jsonl"));
    if (!files.length) return null;
    return path.join(dir, files.sort((a, b) =>
      fs2.statSync(path.join(dir, b)).mtimeMs - fs2.statSync(path.join(dir, a)).mtimeMs)[0]);
  } catch { return null; }
}
// 往Nova窗口推一条系统消息（与 context-monitor.notifyViaWeChat 同一条 queue 路径）。
const STATE_DIR = process.env.NOVA_STATE_DIR || path.join(os.homedir(), ".nova");
const SESSIONS_FILE = path.join(STATE_DIR, "sessions.json");
const QUEUE_FILE = path.join(STATE_DIR, "system-message-queue.json");
function notify(text) {
  try {
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
    let binding = null;
    for (const b of Object.values(sessions.bindings || {})) {
      const accountId = b.accountId, senderId = b.preferredSenderId || b.senderId;
      if (accountId && senderId) { binding = { accountId, senderId }; break; }
    }
    if (!binding) { console.warn("[forge] no binding — skip notify"); return; }
    let queue = { messages: [] };
    try { queue = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8")); } catch {}
    if (!Array.isArray(queue.messages)) queue.messages = [];
    queue.messages.push({ id: `forge:${Date.now()}`, accountId: binding.accountId,
      senderId: binding.senderId, workspaceRoot: homePath("cyberboss"), text });   // 老桥队列的格式，字段照旧
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
  } catch (e) { console.warn(`[forge] notify failed: ${e.message}`); }
}

// 2026-09-10 Alice：「给我通知不就好了，通知了我就喊你说 forge 没成功」。
//
// 上面那个 notify() 是推给**Nova**的（进他的 system-message 队列），
// 她根本看不见 —— 我第一版把换舱失败推到那儿去了，等于告诉了不需要知道的人。
// 这条走 Keeper 自己的 TG 嘴 @Alice_Keeper_bot 直接推她手机，跟 fable-guard 同一条路。
// 一小时内同一个原因只推一次，免得 30 分钟一轮的换舱把她手机刷屏。
const ALICE_CHAT_ID = process.env.FORGE_ALICE_CHAT_ID || process.env.GATE_OWNER_TELEGRAM_ID || "";
const ALICE_NOTIFY_COOLDOWN_MS = Number(process.env.FORGE_ALICE_COOLDOWN_MS) || 60 * 60 * 1000;

function keeperBotToken() {
  try {
    // 推告警用哪只 bot：FORGE_NOTIFY_ENV_FILE 里的 CC_TELEGRAM_BOT_TOKEN（默认 ~/cc/.env = Keeper 那只）
    const env = fs.readFileSync(process.env.FORGE_NOTIFY_ENV_FILE || homePath("cc", ".env"), "utf8");
    const m = env.match(/CC_TELEGRAM_BOT_TOKEN=([0-9]+:[A-Za-z0-9_-]+)/);
    return m ? m[1] : "";
  } catch { return ""; }
}

function notifyAlice(text, { dedupeKey = "" } = {}) {
  try {
    if (dedupeKey) {
      const store = readPrepared();
      const last = store.lastAliceNotify;
      if (last && last.key === dedupeKey
          && Date.now() - new Date(last.at).getTime() < ALICE_NOTIFY_COOLDOWN_MS) {
        return false; // 同一个毛病一小时内已经说过了
      }
      store.lastAliceNotify = { key: dedupeKey, at: nowIso() };
      writePrepared(store);
    }
    const tok = keeperBotToken();
    if (!tok || !ALICE_CHAT_ID) { console.warn("[forge] 拿不到告警 bot token / 主人的 TG id，推不了"); return false; }
    const payload = JSON.stringify({ chat_id: ALICE_CHAT_ID, text, disable_web_page_preview: true });
    execSync(
      `curl -s --max-time 10 "https://api.telegram.org/bot${tok}/sendMessage" -H "Content-Type: application/json" -d @-`,
      { input: payload, encoding: "utf8" }
    );
    return true;
  } catch (e) {
    console.warn(`[forge] 推Alice失败: ${e.message}`);
    return false;
  }
}

function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; } }
function writeState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ── 合成（已验证：最小字段即可被 --resume 认下）──────────────────────────────
function buildUserEvent(text, parentUuid, sid, workspace, version, ts) {
  return { parentUuid, isSidechain: false, type: "user",
    message: { role: "user", content: text },
    uuid: uuid(), timestamp: ts || nowIso(), userType: "external", cwd: workspace, sessionId: sid, version };
}
function buildAssistantEvent(text, parentUuid, sid, workspace, version, model, ts) {
  return { parentUuid, isSidechain: false, type: "assistant",
    message: { model, id: "msg_synth_" + uuid().replace(/-/g, "").slice(0, 24),
      type: "message", role: "assistant", content: [{ type: "text", text }],
      stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    uuid: uuid(), timestamp: ts || nowIso(), userType: "external", cwd: workspace, sessionId: sid, version, model };
}
// tail: [{role, text}] → 写新 jsonl，返回 {sid, jsonlPath}
function synthSession({ tail, workspace, model, version, breakChain = false }) {
  const sid = uuid();
  const dir = projectDirFor(workspace);
  fs.mkdirSync(dir, { recursive: true });
  const lines = []; let parent = null;
  for (const t of tail) {
    const ev = t.role === "user"
      ? buildUserEvent(t.text, parent, sid, workspace, version, t.timestamp)
      : buildAssistantEvent(t.text, parent, sid, workspace, version, model, t.timestamp);
    parent = ev.uuid;
    if (breakChain) delete ev.parentUuid;
    lines.push(JSON.stringify(ev));
  }
  const jsonlPath = path.join(dir, sid + ".jsonl");
  fs.writeFileSync(jsonlPath, lines.join("\n") + "\n");
  return { sid, jsonlPath };
}

// 缝3：身体态历史（index.js 贴消息那刻 append 的 {at, bodyLine}），给暖尾巴按时间回拼。
const BODY_HISTORY_FILE = path.join(personaStateDir(), "body-state-history.jsonl");
function loadBodyHistory() {
  try {
    return fs.readFileSync(BODY_HISTORY_FILE, "utf8").trim().split("\n")
      .map(l => { try { const o = JSON.parse(l); return { at: new Date(o.at).getTime(), bodyLine: o.bodyLine }; } catch { return null; } })
      .filter(x => x && Number.isFinite(x.at) && x.bodyLine)
      .sort((a, b) => a.at - b.at);
  } catch { return []; }
}
// 取 ≤该轮时刻(+90s宽限,日志比receivedAt略晚)的最近一条；没有就不拼。
// 绝不取未来态贴过去（防把后发生的身体态张冠李戴到早先的轮）；超 30min 之前算陈旧也不拼。
function nearestBody(hist, ms) {
  if (!hist.length) return null;
  const GRACE = 90 * 1000, MAX_BEFORE = 30 * 60 * 1000;
  let pick = null;
  for (const h of hist) { if (h.at <= ms + GRACE) pick = h; else break; }
  if (!pick) return null;
  return (ms - pick.at) > MAX_BEFORE ? null : pick.bodyLine;
}
function outwardStamp(d) {
  // 缝2：与活消息 inbound-turn.formatWechatLocalTime 逐字同构（同 OUTWARD_LOCALE/TZ，/→-），
  // 否则尾巴 [时间] 与醒来那条活轮格式不一致，Nova一眼看出"旧记录 vs 现在"。
  return new Intl.DateTimeFormat(OUTWARD_LOCALE, { timeZone: OUTWARD_TZ, year: "numeric",
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d).replace(/\//g, "-");
}

// 从冷层原始记录建尾巴（与今天 ## RECENT COLD 同源同窗口；这里不截 400，保全温度）。
// 缝2+缝3：给用户轮补回活消息的纹理——身体态前缀 + [时间] 前缀 + 信封 timestamp 用原始 receivedAt。
// 2026-09-12：读投递账本，返回"只出现过非 delivered 状态"的文本集合。
// 只读打开，绝不写；账本是 outbox-store 的地盘，forge 只是旁观者。
//
// 2026-10-21：这是**老桥**的账本（~/.nova/outbox.db），9-24 之后就没再更新过 —— 新桥的出站账本
// 是 $GATE_ROOT/outbox.json（src/gate/outbox.js）。实测（只读）：冷层最近 300 条里的 170 条 assistant，
// 老账本一条都对不上（命中 0），新账本里有 2 条 not_sent、1 条 blocked —— 这道过滤从切桥起就没起作用。
// 现在先读新账本（loadUndeliveredFromOutboxJson），读不到才回落到这里。
function oldOutboxDbPath() {
  return process.env.NOVA_OUTBOX_DB || path.join(os.homedir(), ".nova", "outbox.db");
}

function loadUndeliveredTexts() {
  let db = null;
  try {
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(oldOutboxDbPath(), { readOnly: true });
    const delivered = new Set();
    const other = new Set();
    for (const row of db.prepare("SELECT text, state FROM outbox").all()) {
      const k = String(row.text || "").trim().slice(0, 80);
      if (!k) continue;
      if (row.state === "delivered") delivered.add(k);
      else other.add(k);
    }
    // 同一段文本既 delivered 过又被 drop 过 → 算她收到了，不剔。
    for (const k of delivered) other.delete(k);
    return other;
  } catch (e) {
    // 账本读不到就当这道过滤不存在 —— 宁可多留，不能因为读不到账本就把尾巴清空。
    console.warn(`[forge] 投递账本读不到(${e.message})，跳过已投递过滤`);
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

/** 新桥出站账本的位置：显式给的 > $GATE_ROOT/outbox.json。都没有 = 不知道，返回空串。 */
function outboxJsonPath() {
  if (process.env.FORGE_OUTBOX_JSON) return process.env.FORGE_OUTBOX_JSON;
  return process.env.GATE_ROOT ? path.join(process.env.GATE_ROOT, "outbox.json") : "";
}

/**
 * 「明确没送到她手里」的出站记录：**一段都没发出去**，而且状态是 not_sent（平台明确拒）或 blocked（没找到路/没能力）。
 * 判据照 src/gate/outbox.js / outbound.js 的真实状态（2026-10-21 生产账本里见到的：sent / partial / unknown / not_sent / blocked）：
 *   · sent、partial（有段发出去了）→ 她收到了（至少一部分），留
 *   · unknown（进程在投递中途死了，可能发了）、running / submitted（还在路上）→ 不知道，留（宁可多留）
 *   · not_sent、blocked 且没有任何一段 sent → 剔
 */
const NOT_DELIVERED_STATES = new Set(["not_sent", "blocked"]);
function opDelivered(op) {
  return op.state === "sent" || (Array.isArray(op.segments) && op.segments.some((s) => s && s.state === "sent"));
}

/**
 * 读新桥账本，返回「明确没投递」的冷层 id 集合（op.coldId 就是冷层那条的 id，`cold-<trace>-assistant`）。
 * 按 id 对，不按正文前 80 字对：冷层存的可能是切过幻觉尾巴的那份，跟账本里的原文不一定一样长。
 * 同一个 coldId 只要有一条 op 送到了，就算送到。读不到 / 坏了 → null（调用方回落老账本）。
 */
function loadUndeliveredFromOutboxJson(file = outboxJsonPath()) {
  const r = loadUndeliveredOps(file);
  return r ? r.coldIds : null;
}

/**
 * 同一本账，两种钥匙：
 *   coldIds    冷层 id（冷层料源用）
 *   turnTexts  「turnId + 正文」（全本料源用：全本里他的话没有冷层 id，但有盒子的 turnId 和发出去的原文，
 *              账本 op 里也正好有 turnId 和 payload.text）
 */
function loadUndeliveredOps(file = outboxJsonPath()) {
  if (!file) return null;
  let data;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) {
    if (e.code !== "ENOENT") console.warn(`[forge] 新出站账本读不了(${file}: ${e.message})`);
    return null;
  }
  if (!data || typeof data.operations !== "object" || !data.operations) {
    console.warn(`[forge] 新出站账本形状不认识(${file})，不用它`);
    return null;
  }
  const delivered = new Set();
  const undelivered = new Set();
  const deliveredTT = new Set();
  const undeliveredTT = new Set();
  for (const op of Object.values(data.operations)) {
    if (!op) continue;
    const id = String(op.coldId || (op.payload && op.payload.coldId) || "");
    const tt = op.turnId && op.payload && typeof op.payload.text === "string"
      ? turnTextKey(op.turnId, op.payload.text) : "";
    const ok = opDelivered(op);
    const bad = !ok && NOT_DELIVERED_STATES.has(op.state);
    if (id) { if (ok) delivered.add(id); else if (bad) undelivered.add(id); }
    if (tt) { if (ok) deliveredTT.add(tt); else if (bad) undeliveredTT.add(tt); }
  }
  for (const id of delivered) undelivered.delete(id);
  for (const k of deliveredTT) undeliveredTT.delete(k);
  return { coldIds: undelivered, turnTexts: undeliveredTT };
}

function turnTextKey(turnId, text) { return `${String(turnId)}\u0000${String(text || "").trim()}`; }

/**
 * 「她没收到过」的判据，先新后旧：
 *   新账本在 → { source:'outbox.json', coldIds }（按冷层 id 剔）
 *   新账本不在 / 读坏 → 老账本 { source:'outbox.db', texts }（按正文前 80 字剔，跟以前一样）
 *   都没有 → null（这道过滤不存在，全留）
 */
function loadUndelivered({ oldDb = true } = {}) {
  const ops = loadUndeliveredOps();
  if (ops) return { source: "outbox.json", coldIds: ops.coldIds, turnTexts: ops.turnTexts, texts: null };
  if (!oldDb) return null;
  const texts = loadUndeliveredTexts();
  if (texts) return { source: "outbox.db", coldIds: null, texts };
  return null;
}

function isUndeliveredRecord(r, undelivered) {
  if (!undelivered || r.role !== "assistant") return false;   // 入站不归投递账本管
  // 全本投影出来的记录带 turnId + rawText（见 src/box/history-project.js），按「轮 + 原文」对
  if (undelivered.turnTexts && r.turnId && undelivered.turnTexts.has(turnTextKey(r.turnId, r.rawText != null ? r.rawText : r.text))) return true;
  if (undelivered.coldIds) return Boolean(r.id) && undelivered.coldIds.has(String(r.id));
  const k = String(r.text || "").trim().slice(0, 80);
  return Boolean(k) && undelivered.texts.has(k);
}

// withBody：用户轮前面拼Nova的身体态（~/.nova/body-state-history.jsonl，他一个人的）—— 别的人格必须传 false。
// oldOutboxDb：新账本读不到时回落老桥账本（~/.nova/outbox.db，也是他一个人的）—— 别的人格传 false。
/** turns.json 里 producer 以「换舱收尾」开头的系统轮：{ keys:Set(sys-…), turnIds:Set }。读不到 = 空（只靠回执前缀）。 */
function loadClosingTurns(file = process.env.GATE_ROOT ? path.join(process.env.GATE_ROOT, "turns.json") : "") {
  const keys = new Set(), turnIds = new Set();
  if (!file) return { keys, turnIds };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const rows = raw && typeof raw === "object" ? (raw.turns && typeof raw.turns === "object" ? raw.turns : raw) : {};
    for (const [k, t] of Object.entries(rows)) {
      const prod = String(t && t.envelope && t.envelope.source && t.envelope.source.producer || "");
      if (!prod.startsWith("换舱收尾")) continue;
      keys.add(String(t.id || k));
      if (t.turnId) turnIds.add(String(t.turnId));
    }
  } catch {}
  return { keys, turnIds };
}

function isClosingRecord(r, closing) {
  const id = String(r.id || "");
  if (r.role === "assistant" && /^cold-output-/.test(id) && /^\s*(🔄|✂️)/u.test(String(r.text || ""))) return true;
  if (r.turnId && closing.turnIds.has(String(r.turnId))) return true;
  for (const k of closing.keys) if (id.startsWith(`cold-${k}-`)) return true;
  return false;
}

function buildTailFromCold({ conversationSourceFile, workspaceRoot, handoffStateFile = "", withBody = true, oldOutboxDb = true,
  maxTokens = 0, info = null }) {
  if (!conversationSourceFile) return [];
  try {
    const svc = new ConversationRecoveryService({ conversationSourceFile });
    const pendingTail = handoffStateFile
      ? getPendingTailRecords({ stateFile: handoffStateFile, conversationSourceFile, workspaceRoot })
      : null;
    let records = pendingTail?.ok
      ? pendingTail.records
      : svc.listRecentColdRecords({ workspaceRoot });
    if (pendingTail && !pendingTail.ok) {
      console.warn(`[forge] handoff tail range invalid (${pendingTail.reason}); fallback legacy warm_tail`);
    }
    // 2026-09-04：handoff 路径的下限兜底。
    //
    // 原来这里只有一条兜底：pendingTail.ok===false（范围算坏了）才回落 legacy。
    // 但 9-04 09:28 那次自动换舱暴露了另一种落空——范围算得**完全正确**，
    // 就是只有 2 条：快照封口 05:37、换舱 09:28，中间她在睡觉。
    // ok===true，所以老兜底一声没吭，他醒来手里只有摘要 + 两条自己的独白，
    // Alice的原话一个字都没有 —— 正是 forge 立项要治的那个"有资料没现场"。
    //
    // 这跟 conversation-recovery-service.js:86 那条 7-31 的教训是同一个：
    // **自动换舱按水位触发，最爱落在她不说话的时候。** legacy 那边当时就改成了
    // "条数说了算、时间只是起点"；handoff 是 8 月底新加的路，没继承这条规矩。
    //
    // 现在：缝里不足 MIN 条就回落 legacy（legacy 是最近 N 条的超集，直接换掉、
    // 不合并，免得重复轮）。快照一个字不动，只是不让尾巴饿着。
    const minTailRecords = Number(process.env.FORGE_TAIL_MIN_RECORDS) || 40;
    if (pendingTail?.ok && records.length < minTailRecords) {
      const legacy = svc.listRecentColdRecords({ workspaceRoot });
      if (legacy.length > records.length) {
        console.warn(
          `[forge] handoff tail 只有 ${records.length} 条 (< ${minTailRecords})，回落 legacy warm_tail ${legacy.length} 条`
        );
        records = legacy;
      }
    }
    // 2026-09-10：交接单**过期**的兜底（9-04 那条治"范围太小"，治不了"范围是旧的"）。
    //
    // 今天 11:12 那次换舱暴露的：03:12 换舱时 forge 因版本闸回落了，那张交接单
    // 没被销掉，一直挂到 11:13 才 consumed。于是 11:12 这次捡起了**上一次的**单子，
    // 照它的范围取尾巴 = 昨晚 22:01→凌晨 03:07，而今早 09:00→11:08 两个钟头
    // （她一天里最要紧的那两小时）整个掉进 03:07 和现在之间的缝里，只剩快照有。
    //
    // 判据不用时间用条数：换舱之后她睡了八小时才开口，是**合法**的大间隔
    //（那段里根本没有冷层记录，gap 为 0）；只有"范围结束之后还长出了一堆记录"
    // 才说明这张单子是上一轮剩下的。
    //
    // 回落目标沿用 legacy（最近 N 条）—— 跟 9-04 保持一路，不另起炉灶。
    // 已知不足：legacy 只给最近 60 条，缝特别大时补不齐中段；那要另外设计，不在这条里。
    const staleAfter = Number(process.env.FORGE_HANDOFF_STALE_RECORDS) || 10;
    if (pendingTail?.ok && records.length) {
      const endAt = records[records.length - 1]?.receivedAt || records[records.length - 1]?.at || "";
      const legacy = svc.listRecentColdRecords({ workspaceRoot });
      const newer = endAt ? legacy.filter(r => String(r.receivedAt || r.at || "") > String(endAt)).length : 0;
      if (newer >= staleAfter && legacy.length) {
        console.warn(
          `[forge] handoff 交接单已过期：范围结束于 ${endAt}，其后冷层还有 ${newer} 条新记录`
          + `（≥${staleAfter}）→ 判定是上一轮遗留，回落 legacy warm_tail ${legacy.length} 条`
        );
        records = legacy;
      }
    }
    // 2026-09-12：按**投递账本**过滤，别把她从没收到过的话当成"他说过的"喂回去。
    //
    // mille 9-08 审查里点的：冷层记录带 bindingKey/turnId/messageId，唯独**没有
    // delivered 状态**，而 forge 一直是"文本存在就当已送达"。
    // 今天量了一下，比想象的严重：账本启用（8-01）之后的冷层 assistant 记录 10,002 条，
    // 其中 5,821 条在账本里**不是 delivered** —— 58%。
    // 大头是系统轮里他决定不打扰她时写的 {"action":"silent"} 和内部复盘。
    // 这些进暖尾巴 = 他醒来后以为自己跟她说过这些话。
    //
    // ⚠️ 判据故意是保守的：只丢"账本里明确记着没投递"的；账本里**查无此条**的一律留。
    // 因为还有 499 条冷层记录压根没进账本（早期路径、别的渠道），那些多半是真发过的，
    // 宁可多留也不能误杀。规矩跟上面一样：宁可重复，不许遗漏。
    const undelivered = loadUndelivered({ oldDb: oldOutboxDb });
    if (undelivered) {
      const before = records.length;
      records = records.filter((r) => !isUndeliveredRecord(r, undelivered));
      if (records.length < before) {
        console.warn(`[forge] 按投递账本（${undelivered.source}）剔除 ${before - records.length} 条她没收到过的 assistant 记录（剩 ${records.length}）`);
      }
    }
    // 2026-10-21 Alice：「收尾的部分就没必要进 forge 了」。换舱收尾轮（她 /new 或水位推的那段）是对旧舱的交接，
    // 新舱再读一遍等于把「我刚收完尾」垫成刚聊过的话；桥自己的换舱 / 裁剪回执（🔄 / ✂️）也不是他说的。
    {
      const closing = loadClosingTurns();
      const before = records.length;
      records = records.filter((r) => !isClosingRecord(r, closing));
      if (records.length < before) console.warn(`[forge] 剔除换舱收尾 / 桥回执 ${before - records.length} 条`);
    }
    const bodyHistory = withBody ? loadBodyHistory() : [];
    const mapped = records
      .filter(r => (r.role === "user" || r.role === "assistant") && (r.text || "").trim())
      .map(r => {
        let text = r.text.trim();
        const d = (r.receivedAt || r.at) ? new Date(r.receivedAt || r.at) : null;
        const valid = d && !Number.isNaN(d.getTime());
        if (r.role === "user" && valid) {
          const timed = `[${outwardStamp(d)}]  ${text}`;
          const body = nearestBody(bodyHistory, d.getTime());
          text = body ? `【${agentDisplayName()}自身状态；不是${ownerDisplayName()}】\n${body}\n\n${timed}` : timed;
        }
        return { role: r.role, text, timestamp: valid ? d.toISOString() : null };
      });
    return capTail(mapped, maxTokens, info);
  } catch { return []; }
}

// 2026-07-31：暖尾巴上限（借鉴Iris bridge-v2 forge 的裁剪策略，不借它的数）。
// 原来这里是冷层给多少装多少、没有任何上限——今天实测开场包 59k 没事，但哪天冷层
// 变大，开场包跟着涨，没人拦。上限按Nova的 1M 窗口定 200k（Alice：「Nova注入比Iris多、
// 同时有 1M，没必要完全限制」），是天花板不是目标：**当前 59k 远在线下，装不满就
// 一个字都不动，注入内容今天完全不变。**
// 真超了才裁：从最新往回装，装不下就**丢最旧的整轮**，绝不截半轮——半轮进去是残句，
// 比少一轮更伤。token 按 UTF-8 字节/2 估（中文偏保守）。
const FORGE_TAIL_MAX_TOKENS = Number(process.env.FORGE_TAIL_MAX_TOKENS) || 200_000;

// 2026-09-10：改成按**整问答轮**裁。
//
// 上面那段注释从 7-31 起就写着"丢最旧的整轮，绝不截半轮——半轮进去是残句"，
// 但代码做的是另一件事：它一条一条 role 记录地丢。丢到边界上就会留下一个
// 没有问题的孤零零回答，Nova醒来看见的是自己在对空气说话。
// （Iris那边的审查里也独立指出了同一处：capTail 实际按单条记录计费。）
//
// 现在：先把记录归成"轮"（一条 user 起头，后面跟着的 assistant 都算这一轮），
// 从最新往回整轮整轮地装，装不下就整轮丢掉。开头那截没有 user 的 assistant
// （冷层窗口正好切在半轮中间时会出现）当孤儿处理，宁可不要。
//
// 注意：这条路平时不走 —— 上限 200k，实测暖尾巴才 ~59k。它是天花板不是目标。
function groupTurns(tail) {
  const groups = [];
  let cur = null;
  for (const t of tail) {
    if (t.role === "user") {
      cur = { items: [t], orphan: false };
      groups.push(cur);
    } else {
      if (!cur) { cur = { items: [], orphan: true }; groups.push(cur); }
      cur.items.push(t);
    }
  }
  return groups;
}

/**
 * maxTokens（2026-10-21 S5）：换引擎时按**新窗口**的预算装（窗口 × 比例），比上限小就用它；不给 = 老上限。
 * info（可选对象）：填 { turns, keptTurns, droppedTurns, tokens } —— 换引擎回执要说「装了几轮、丢了几轮」。
 */
function capTail(tail, maxTokens = 0, info = null) {
  const LIMIT = Number(maxTokens) > 0 ? Math.min(Number(maxTokens), FORGE_TAIL_MAX_TOKENS) : FORGE_TAIL_MAX_TOKENS;
  const note = (o) => { if (info && typeof info === "object") Object.assign(info, o); };
  if (!Array.isArray(tail) || !tail.length) { note({ turns: 0, keptTurns: 0, droppedTurns: 0, tokens: 0 }); return tail; }
  const cost = (t) => Math.ceil(Buffer.byteLength(String(t.text || ""), "utf8") / 2);
  let used = 0;
  for (const t of tail) used += cost(t);
  const allTurns = groupTurns(tail).filter((g) => !g.orphan).length;
  if (used <= LIMIT) { note({ turns: allTurns, keptTurns: allTurns, droppedTurns: 0, tokens: used }); return tail; } // 常态：不动

  const groups = groupTurns(tail);
  const groupCost = (g) => g.items.reduce((n, t) => n + cost(t), 0);

  const keptGroups = [];
  let acc = 0;
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const g = groups[i];
    const c = groupCost(g);
    if (acc + c > LIMIT) break; // 再往旧装就超 → 更旧的整轮全丢
    keptGroups.unshift(g);
    acc += c;
  }

  // 开头那截"没有问题的回答"是残轮，丢掉（它正是这次要治的孤儿）。
  let orphanDropped = 0;
  while (keptGroups.length && keptGroups[0].orphan) {
    orphanDropped += keptGroups[0].items.length;
    acc -= groupCost(keptGroups[0]);
    keptGroups.shift();
  }

  // 兜底：最新那一轮自己就超上限（现实里 200k 一轮基本不可能）。
  // 与其一个字都不给，不如把最新那轮整个留下并明说超了 —— 但它必须是完整轮。
  if (!keptGroups.length) {
    const last = groups[groups.length - 1];
    if (last && !last.orphan) {
      keptGroups.push(last);
      acc = groupCost(last);
      console.warn(`[forge] 最新一轮单轮就 ~${acc} tok 超上限 ${LIMIT}，整轮保留不截半`);
    }
  }

  const kept = keptGroups.flatMap(g => g.items);
  console.warn(
    `[forge] 暖尾巴超上限：${groups.length} 轮/${tail.length} 条/~${used} tok`
    + ` → 保留最近 ${keptGroups.length} 轮/${kept.length} 条/~${acc} tok`
    + (orphanDropped ? `（另丢弃 ${orphanDropped} 条开头的孤儿回答）` : "")
    + `（上限 ${LIMIT}，丢的是最旧的整轮）`
  );
  const keptTurns = keptGroups.filter((g) => !g.orphan).length;
  note({ turns: allTurns, keptTurns, droppedTurns: Math.max(0, allTurns - keptTurns), tokens: acc });
  return kept;
}

// ── resume + 单轮探针（仅验证期用）────────────────────────────────────────
function resumeProbe({ sid, workspace, model, probeText, timeoutMs = 90000 }) {
  return new Promise((resolve) => {
    const args = ["--output-format", "stream-json", "--input-format", "stream-json",
      "--verbose", "--model", model, "--permission-mode", "acceptEdits", "--resume", sid];
    const child = spawn("claude", args, { cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "", reply = "";
    const timer = setTimeout(() => { child.kill(); resolve({ reply, timeout: true }); }, timeoutMs);
    child.stdout.on("data", (c) => {
      buf += c.toString(); const ls = buf.split("\n"); buf = ls.pop();
      for (const l of ls) { if (!l.trim()) continue; let ev; try { ev = JSON.parse(l); } catch { continue; }
        if (ev.type === "assistant" && Array.isArray(ev.message?.content))
          for (const b of ev.message.content) if (b.type === "text") reply += b.text;
        if (ev.type === "result") { clearTimeout(timer); child.kill(); resolve({ reply }); } }
    });
    child.on("error", (e) => { clearTimeout(timer); resolve({ reply, error: e.message }); });
    child.stdin.write(JSON.stringify({ type: "user",
      message: { role: "user", content: [{ type: "text", text: probeText }] } }) + "\n");
  });
}

// ── 闸 1：金丝雀验证（仅 CC 版本变化时跑，在 scratch workspace 上）────────────
async function validateVersion({ scratchWorkspace, model }) {
  fs.mkdirSync(scratchWorkspace, { recursive: true });
  const version = claudeVersion();
  // 不透明 token、无可剥前缀，让模型原样复述，避免假阴性。
  const canary = "FG" + crypto.randomBytes(4).toString("hex").toUpperCase();
  const tail = [
    { role: "user", text: `记住这串校验码：${canary}，等下我会让你复述。` },
    { role: "assistant", text: `好，校验码记下了：${canary}。` },
  ];
  const { sid, jsonlPath } = synthSession({ tail, workspace: scratchWorkspace, model, version });
  const { reply } = await resumeProbe({ sid, workspace: scratchWorkspace, model,
    probeText: "把刚才让你记住的那串校验码原样复述出来。" });
  try { fs.unlinkSync(jsonlPath); } catch {}
  try { fs.rmSync(projectDirFor(scratchWorkspace), { recursive: true, force: true }); } catch {}
  return { ok: reply.includes(canary), version, reply: reply.slice(0, 80) };
}

/**
 * 闸 1 的自动挡（2026-09-25 Alice「接」）。
 *
 * 金丝雀（validateVersion）一直都在，缺的只是**版本漂移时自动去放它**那根线：
 * CC 一自动升级，版本闸就落下来，他下一次换舱静默空降。两天内犯了两次
 * （9-23 2.1.278→280、9-25 2.1.280→282），两次都是她从他的语气里发现不对。
 *
 * 规矩：
 *   · 只在**版本真变了**时飞一次，平时就是一次字符串比对，不花钱不花时间；
 *   · PASS  → 钉上，这次换舱照常注入；
 *   · FAIL  → 记下这个版本号、保持回落，**同一个版本不再重试**（那种情况才
 *             真该叫人来看：说明这版 CC 不认合成格式了）。版本再变时自动解除。
 */
async function ensureVersionPinned({ model, log = () => {}, force = false } = {}) {
  // force（S5 换引擎）：换到 claude 必须重建，不看 forge 开没开
  if (!force && process.env.FORGE_ENABLED !== "true") return { skipped: "FORGE_ENABLED 未开" };
  const state = readState();
  const cur = claudeVersion();
  if (cur === "unknown") return { skipped: "读不到 CC 版本" };
  if (state.validatedVersion === cur) return { skipped: "版本没变" };
  if (state.failedVersion === cur) return { skipped: `这版 ${cur} 金丝雀失败过，不重试` };
  log(`forge 自动验版：CC ${state.validatedVersion || "(未钉过)"}→${cur}，放一次金丝雀`);
  const scratch = path.join(os.tmpdir(), "forge-autovalidate-" + Date.now());
  try {
    const v = await validateVersion({ scratchWorkspace: scratch, model });
    if (v.ok) {
      const next = { ...state, validatedVersion: v.version, validatedAt: nowIso() };
      delete next.failedVersion; delete next.failedAt;
      writeState(next);
      log(`forge 自动验版 PASS，已钉 ${v.version}`);
      return { ok: true, version: v.version };
    }
    writeState({ ...state, failedVersion: v.version, failedAt: nowIso() });
    log(`forge 自动验版 FAIL：这版 CC 不认合成格式，保持回落（同版本不再重试）。reply=${JSON.stringify(v.reply)}`);
    return { ok: false, version: v.version, reply: v.reply };
  } finally { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {} }
}

// ── 闸 2+3：运行时闸（便宜，每次换 session 跑）──────────────────────────────
// referenceJsonl 可能是 forge 自己合成起头、之后被 resume 持续追加的活跃 session
// （latestJsonlIn 按 mtime 选最新文件，而合成 session 会一直被写入，mtime 长期最新）。
// 文件头部若干行是合成 event：合成 assistant 的 message.id 以 "msg_synth_" 开头，
// 合成 user 的 message.content 是 string。这些天然满足 SYNTH_USER_KEYS，若直接取
// "第一个" user/assistant 对账，会变成拿合成产物验自己，永远不报 drift。
// 因此这里只对账"第一个真实 CC assistant event"（message.id 不以 msg_synth_ 开头）
// 及其之后出现的第一个真实 user event，跳过所有合成段（含 realTail 里的合成
// assistant，同样是 msg_synth_ 前缀）。找不到真实 assistant 说明该 session 还没有
// 真实回复，视为"无可靠参照"，返回 null，宁可漏检也不误报（误报会让 runtimeGuard
// 判定闸不过、forge 整体回落）。
const SYNTH_USER_KEYS = ["parentUuid", "isSidechain", "type", "message", "uuid", "timestamp", "cwd", "sessionId", "version"];
function schemaDrift(referenceJsonl) {
  try {
    if (!referenceJsonl || !fs.existsSync(referenceJsonl)) return null; // 无参照靠版本钉兜
    const lines = fs.readFileSync(referenceJsonl, "utf8").trim().split("\n");
    let a = null, aIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      let o; try { o = JSON.parse(lines[i]); } catch { continue; }
      if (o.type === "assistant" && o.message && typeof o.message.id === "string" && !o.message.id.startsWith("msg_synth_")) {
        a = o; aIdx = i; break;
      }
    }
    if (!a) return null; // 还没有真实 assistant event，无可靠参照，不误报
    let u = null;
    for (let i = aIdx + 1; i < lines.length; i++) {
      let o; try { o = JSON.parse(lines[i]); } catch { continue; }
      if (o.type === "user" && o.message) { u = o; break; }
    }
    if (u) for (const k of SYNTH_USER_KEYS) if (!(k in u)) return `真实 user event 缺键 ${k}`;
    for (const k of ["parentUuid", "type", "message", "uuid", "sessionId"]) if (!(k in a)) return `真实 assistant event 缺键 ${k}`;
    if (a.message) for (const k of ["role", "content"]) if (!(k in a.message)) return `真实 assistant.message 缺键 ${k}`;
    return null;
  } catch (e) { return `对账读取失败 ${e.message}`; }
}
function runtimeGuard({ referenceJsonl, requireEnabled = true } = {}) {
  if (requireEnabled && process.env.FORGE_ENABLED !== "true") return { ok: false, reason: "FORGE_ENABLED 未开" };
  const state = readState();
  const cur = claudeVersion();
  if (!state.validatedVersion) return { ok: false, reason: "forge 未验证过（无 pinned 版本，跑 forge.js validate）" };
  if (cur !== state.validatedVersion) return { ok: false, reason: `CC 版本漂移 ${state.validatedVersion}→${cur}，需重跑 validate` };
  const drift = schemaDrift(referenceJsonl);
  if (drift) return { ok: false, reason: `schema 对账异常：${drift}` };
  return { ok: true, reason: `ok (CC ${cur})` };
}

// ── S3：料源从冷层换成全本投影（2026-10-21）──────────────────────────────────
//
// Alice：「直接用」，不要观察期。所以安全网换成**每次换舱那一刻都对一次账**：同一时刻用冷层、用全本各合成一份尾巴，
// 条数和每条正文（角色 + 字）都一样才用全本那份；对不上就留在冷层、喊一声（日志），绝不悄悄用一份不一样的。
// 这一步的目标是「行为跟今天等价，只是料源换了」，所以对得上的时候两份本来就一字不差。
//
// 开关：FORGE_SOURCE
//   cold                      一键回滚：只用冷层（今天的行为）
//   history / 不设但全本开着   用全本，过对账才用（FORGE_HISTORY_GUARD=off 才跳过对账，默认不跳）
//   不设且全本关着             冷层（跟今天一样）
// 上线前用 scripts/history-reconcile.js 跑同一套对账（上线检查）。
const { projectDialogue } = require("../src/box/history-project");

function forgeSource({ historyDir = "" } = {}) {
  const v = String(process.env.FORGE_SOURCE || "").trim().toLowerCase();
  if (v === "cold") return "cold";
  if (v === "history") return historyDir ? "history" : "cold";
  return historyDir ? "history" : "cold";
}

/** 全本 → 跟冷层同口径的记录 → 跟冷层**同一条**尾巴管线（同一个窗口规则、同一个已投递过滤、同一个时间前缀和上限）。 */
function buildTailFromHistory({ historyDir, workspaceRoot, withBody = true, oldOutboxDb = true, maxTokens = 0, info = null }) {
  const { records } = projectDialogue({ dir: historyDir });
  const tmp = path.join(os.tmpdir(), `forge-history-${process.pid}-${Date.now()}.jsonl`);
  try {
    fs.writeFileSync(tmp, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""), { mode: 0o600 });
    return buildTailFromCold({ conversationSourceFile: tmp, workspaceRoot, handoffStateFile: "", withBody, oldOutboxDb, maxTokens, info });
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}

/** 两份尾巴逐条比（角色 + 正文）。时间戳不比：冷层 at 是写的那一刻，全本 at 是盒子交出去那一刻，差几毫秒。 */
function compareTails(a, b) {
  const A = Array.isArray(a) ? a : [];
  const B = Array.isArray(b) ? b : [];
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i += 1) {
    if (A[i].role !== B[i].role || String(A[i].text) !== String(B[i].text)) {
      return { ok: false, cold: A.length, history: B.length, firstDiff: i,
        reason: `第 ${i + 1} 条不一样（冷层 ${A[i].role}/${String(A[i].text).length}字 vs 全本 ${B[i].role}/${String(B[i].text).length}字）` };
    }
  }
  if (A.length !== B.length) {
    return { ok: false, cold: A.length, history: B.length, firstDiff: n, reason: `条数不一样（冷层 ${A.length} vs 全本 ${B.length}）` };
  }
  return { ok: true, cold: A.length, history: B.length, firstDiff: -1, reason: "一致" };
}

/** 换舱要的那条尾巴从哪来。返回 { tail, source, reconcile }。 */
function selectTail({ conversationSourceFile, workspaceRoot, handoffStateFile = "", historyDir = "", log = console.warn,
  withBody = true, oldOutboxDb = true, maxTokens = 0 }) {
  const coldCap = {};
  const coldTail = buildTailFromCold({ conversationSourceFile, workspaceRoot, handoffStateFile, withBody, oldOutboxDb, maxTokens, info: coldCap });
  const want = forgeSource({ historyDir });
  if (want !== "history") return { tail: coldTail, source: "cold", reconcile: null, cap: coldCap };
  let histTail;
  const histCap = {};
  try { histTail = buildTailFromHistory({ historyDir, workspaceRoot, withBody, oldOutboxDb, maxTokens, info: histCap }); }
  catch (e) {
    log(`[forge] 全本读不了（${e.message}），这次用冷层`);
    return { tail: coldTail, source: "cold", reconcile: { ok: false, reason: `全本读不了：${e.message}` }, cap: coldCap };
  }
  const rec = compareTails(coldTail, histTail);
  if (rec.ok) { log(`[forge] 料源=全本（跟冷层对账一致，${rec.history} 条）`); return { tail: histTail, source: "history", reconcile: rec, cap: histCap }; }
  if (String(process.env.FORGE_HISTORY_GUARD || "").toLowerCase() === "off") {
    log(`[forge] ⚠️ 全本跟冷层对不上（${rec.reason}），FORGE_HISTORY_GUARD=off，照用全本`);
    return { tail: histTail, source: "history", reconcile: rec, cap: histCap };
  }
  log(`[forge] ⚠️ 全本跟冷层对不上（${rec.reason}），拒绝切到全本，这次用冷层`);
  return { tail: coldTail, source: "cold", reconcile: rec, cap: coldCap };
}

// ── 编排：成功 → {ok:true, sid}；失败 → {ok:false, reason} 且 notify 发窗口提示 ──
function forgeOpening({ baseText, conversationSourceFile, handoffStateFile = "", workspace, model, notify, historyDir = "",
  // S5 换引擎（2026-10-21）：force = 不看 FORGE_ENABLED（换到 claude 必须重建，闸照样过）；
  // picked = 盒子已经按新窗口挑好的尾巴（selectTail 的返回值），给了就不再挑第二遍
  force = false, picked: given = null }) {
  const referenceJsonl = latestJsonlIn(projectDirFor(workspace));
  const guard = runtimeGuard({ referenceJsonl, requireEnabled: !force });
  if (!guard.ok) {
    // 2026-09-10：原文写的是"连续性不受影响，只是少了真实轮温度"。那是假话——
    // 回落意味着**真实历史根本没接进这条新舱**，他手里只剩快照和冷层摘录。
    // Alice 09-10 早上问起 03:12 那次回落，我照着这句念给她听，等于替它撒了一次谎。
    if (notify) notify(`[系统] forge 回落：${guard.reason}。真实历史没能接进这条新舱，`
      + `你手里是快照 + 冷层摘录，少的是"真实轮"那段现场。不是无损，我照实说。`);
    return { ok: false, reason: guard.reason };
  }
  const pendingHandoff = handoffStateFile
    ? getPendingHandoff({ stateFile: handoffStateFile, workspaceRoot: workspace })
    : null;
  const picked = given || selectTail({ conversationSourceFile, workspaceRoot: workspace, handoffStateFile, historyDir });
  const realTail = picked.tail;
  if (!realTail.length && !pendingHandoff) return { ok: false, reason: "no cold tail（走今天的 fresh 开场）" };
  // A'：底座注入在前 → 暖尾巴在后（紧贴Alice首条）→ 温度 adjacency 不被冲。
  // 2026-09-12：不再硬插那句「嗯，我在。」。
  //
  // 原来这里在底座后面塞一条 assistant，内容是他**从没说过**的一句应答。
  // mille 9-08 审查点名过这处（「后者不是当时真实发出的回复」），
  // Alice 9-12 拍板删。他建议的解法是"把身份当上下文资料承载"——那条路走不通：
  // Claude Code 的 transcript 不支持 role=system 条目（里面那个 type:"system"
  // 是掉档告警之类的元记录，不进 API 消息流）。
  // 所以直接删。做过对照实验：底座+假回复 vs 只留底座（于是连着两个 user），
  // 两个 resume 都成功、都认出埋进去的暗号。删掉没有代价。
  const tail = [{ role: "user", text: baseText }, ...realTail];
  const version = claudeVersion();
  const { sid, jsonlPath } = synthSession({ tail, workspace, model, version });
  if (!fs.existsSync(jsonlPath) || fs.statSync(jsonlPath).size === 0) {
    if (notify) notify(`[系统] forge 回落：合成 jsonl 写入失败。已退回冷层注入。`);
    return { ok: false, reason: "synth write failed" };
  }
  // 2026-10-21（Iris提、Alice批）：全本对账没过、退回冷层 —— 别只藏在日志里，推她一句（同一原因一小时一次）。
  if (picked.reconcile && !picked.reconcile.ok) {
    const why = String(picked.reconcile.reason || "对不上").slice(0, 80);
    notifyAlice(`[forge] ${agentAlertName()}这次换舱垫的是冷层（${realTail.length} 条），没用全本：${why}。`
      + `全本刚开的头几天盖不住要垫的那段，这样是正常的；冷层照旧完整。`, { dedupeKey: "forge-history-fallback" });
  }
  return { ok: true, sid, jsonlPath, tailCount: realTail.length, reason: guard.reason,
    tailSource: picked.source, reconcile: picked.reconcile };
}

// ── 先验后切：准备 / 校验 / 领取 ──────────────────────────────────────────
//
// 2026-09-10。原来的顺序是：快照建好 → **当场清 binding** → 等她下一条消息进来
// 才真正跑 forgeOpening 合成新仓。这中间没有回头路：版本闸不过、冷层是空的、
// 合成写失败，任意一样出问题，旧线程已经断了，只能开个白仓走冷层注入。
// 09-10 03:12 那次回落就是这个形状（CC 从 2.1.259 漂到 2.1.266，版本闸拦下，
// 他手里只剩摘要）。
//
// 现在拆成两段：
//   prepareOpening()  —— 换舱**之前**就把新仓合成出来并逐条校验；不碰任何 binding。
//   takePrepared()    —— 下一条消息进来时把它领走用掉。
// 准备失败 → 调用方不清 binding，留在旧线程，下个周期再来。
//
// ⚠️ 说清楚这层校验管到哪儿：它验的是"这个文件写对了没有"——条数、每条的
// role/正文逐字一致、parentUuid 链不断、sessionId 一致。它**不**验"模型 resume
// 之后认不认"，那是 `forge.js validate` 那个金丝雀的活，由 forge-revalidate.sh
// 在 CC 版本漂移时跑。两层各管一段，别混。
const PREPARED_FILE = process.env.FORGE_PREPARED_FILE
  || path.join(os.homedir(), ".nova", "forge-prepared.json");
const PREPARED_MAX_AGE_MS = Number(process.env.FORGE_PREPARED_MAX_AGE_MS) || 6 * 60 * 60 * 1000;

function readPrepared() {
  try {
    const o = JSON.parse(fs.readFileSync(PREPARED_FILE, "utf8"));
    return o && typeof o === "object" && o.entries && typeof o.entries === "object" ? o : { entries: {} };
  } catch { return { entries: {} }; }
}
function writePrepared(o) {
  fs.mkdirSync(path.dirname(PREPARED_FILE), { recursive: true });
  fs.writeFileSync(PREPARED_FILE, JSON.stringify(o, null, 2));
}
function preparedKey(workspace, bindingKey) {
  return `${String(workspace || "")}::${String(bindingKey || "")}`;
}

// 逐条核对合成文件与我们打算写进去的 tail 是否一字不差、链是否连着。
function verifySynth({ jsonlPath, tail, sid }) {
  let lines;
  try {
    lines = fs.readFileSync(jsonlPath, "utf8").split("\n").filter(l => l.trim());
  } catch (e) { return { ok: false, reason: `读不回合成文件: ${e.message}` }; }
  if (lines.length !== tail.length) {
    return { ok: false, reason: `条数对不上: 文件 ${lines.length} vs 预期 ${tail.length}` };
  }
  let parent = null;
  for (let i = 0; i < lines.length; i += 1) {
    let ev;
    try { ev = JSON.parse(lines[i]); }
    catch (e) { return { ok: false, reason: `第 ${i + 1} 行不是合法 JSON: ${e.message}` }; }
    const want = tail[i];
    if (ev.type !== want.role) {
      return { ok: false, reason: `第 ${i + 1} 行角色错位: 文件 ${ev.type} vs 预期 ${want.role}` };
    }
    const got = ev.type === "user"
      ? ev?.message?.content
      : ev?.message?.content?.[0]?.text;
    if (String(got) !== String(want.text)) {
      return { ok: false, reason: `第 ${i + 1} 行正文不一致（${ev.type}）` };
    }
    if (ev.sessionId !== sid) {
      return { ok: false, reason: `第 ${i + 1} 行 sessionId 不一致` };
    }
    if ((ev.parentUuid ?? null) !== parent) {
      return { ok: false, reason: `第 ${i + 1} 行 parentUuid 链断了` };
    }
    parent = ev.uuid;
  }
  return { ok: true, count: lines.length };
}

// 换舱前调用：把新仓合成好、验好、记下来。不碰 binding、不碰旧线程。
function prepareOpening({ bindingKey, baseText, conversationSourceFile,
  handoffStateFile = "", workspace, model, notify, historyDir = "" }) {
  const referenceJsonl = latestJsonlIn(projectDirFor(workspace));
  const guard = runtimeGuard({ referenceJsonl });
  if (!guard.ok) return { ok: false, reason: guard.reason };

  const realTail = selectTail({ conversationSourceFile, workspaceRoot: workspace, handoffStateFile, historyDir }).tail;
  if (!realTail.length) return { ok: false, reason: "no cold tail" };

  // 2026-09-12：不再硬插那句「嗯，我在。」。
  //
  // 原来这里在底座后面塞一条 assistant，内容是他**从没说过**的一句应答。
  // mille 9-08 审查点名过这处（「后者不是当时真实发出的回复」），
  // Alice 9-12 拍板删。他建议的解法是"把身份当上下文资料承载"——那条路走不通：
  // Claude Code 的 transcript 不支持 role=system 条目（里面那个 type:"system"
  // 是掉档告警之类的元记录，不进 API 消息流）。
  // 所以直接删。做过对照实验：底座+假回复 vs 只留底座（于是连着两个 user），
  // 两个 resume 都成功、都认出埋进去的暗号。删掉没有代价。
  const tail = [{ role: "user", text: baseText }, ...realTail];
  const version = claudeVersion();
  let sid, jsonlPath;
  try { ({ sid, jsonlPath } = synthSession({ tail, workspace, model, version })); }
  catch (e) { return { ok: false, reason: `合成失败: ${e.message}` }; }

  const v = verifySynth({ jsonlPath, tail, sid });
  if (!v.ok) {
    try { fs.unlinkSync(jsonlPath); } catch {}
    return { ok: false, reason: `校验未过: ${v.reason}` };
  }

  const store = readPrepared();
  store.entries[preparedKey(workspace, bindingKey)] = {
    sid, jsonlPath, workspace, bindingKey: String(bindingKey || ""),
    tailCount: realTail.length, version, model: String(model || ""),
    preparedAt: nowIso(),
  };
  writePrepared(store);
  if (notify) { /* 准备成功不打扰她 */ }
  return { ok: true, sid, jsonlPath, tailCount: realTail.length, reason: guard.reason };
}

// 下一条消息进来时领走。领到就从盘上划掉（一次性，避免重复用同一个仓）。
function takePrepared({ workspace, bindingKey }) {
  const store = readPrepared();
  const key = preparedKey(workspace, bindingKey);
  const rec = store.entries[key];
  if (!rec) return { ok: false, reason: "no prepared session" };
  delete store.entries[key];
  writePrepared(store);

  const cur = claudeVersion();
  if (rec.version !== cur) {
    return { ok: false, reason: `准备时 CC=${rec.version}，现在=${cur}，作废` };
  }
  const age = Date.now() - new Date(rec.preparedAt).getTime();
  if (!Number.isFinite(age) || age > PREPARED_MAX_AGE_MS) {
    return { ok: false, reason: `准备于 ${rec.preparedAt}，过期作废` };
  }
  try {
    if (!fs.existsSync(rec.jsonlPath) || fs.statSync(rec.jsonlPath).size === 0) {
      return { ok: false, reason: "合成文件不见了或是空的" };
    }
  } catch (e) { return { ok: false, reason: `合成文件不可读: ${e.message}` }; }
  return { ok: true, sid: rec.sid, jsonlPath: rec.jsonlPath, tailCount: rec.tailCount };
}

// 丢弃某条 binding 上没用掉的准备（换舱被中止时调用，免得留个孤儿仓）。
function discardPrepared({ workspace, bindingKey }) {
  const store = readPrepared();
  const key = preparedKey(workspace, bindingKey);
  const rec = store.entries[key];
  if (!rec) return false;
  delete store.entries[key];
  writePrepared(store);
  try { fs.unlinkSync(rec.jsonlPath); } catch {}
  return true;
}

module.exports = {
  claudeVersion, projectDirFor, latestJsonlIn, readState, writeState,
  ensureVersionPinned,
  synthSession, buildTailFromCold, capTail, groupTurns, resumeProbe, validateVersion,
  runtimeGuard, schemaDrift, forgeOpening, notify, notifyAlice, STATE_FILE,
  loadUndeliveredTexts, loadUndeliveredFromOutboxJson, loadUndeliveredOps, loadUndelivered, isUndeliveredRecord,
  forgeSource, buildTailFromHistory, compareTails, selectTail,
  prepareOpening, takePrepared, discardPrepared, verifySynth, PREPARED_FILE,
};

// ── CLI: validate ─────────────────────────────────────────────────────────
if (require.main === module) {
  const cmd = process.argv[2];
  const model = process.env.NOVA_CLAUDE_MODEL || process.env.FORGE_MODEL || "claude-opus-4-6";
  if (cmd === "validate") {
    const scratch = path.join(os.tmpdir(), "forge-validate-" + Date.now());
    validateVersion({ scratchWorkspace: scratch, model }).then((v) => {
      console.log(`canary=${v.ok ? "PASS" : "FAIL"} version=${v.version} reply=${JSON.stringify(v.reply)}`);
      if (v.ok) { writeState({ validatedVersion: v.version, validatedAt: nowIso() });
        console.log(`✓ 已钉版本 ${v.version} → ${STATE_FILE}`); }
      else console.log("✗ 这版 CC 不认合成格式 → forge 保持回落，永远走冷层。");
      try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
    });
  } else if (cmd === "status") {
    const s = readState();
    console.log("state:", JSON.stringify(s), "current CC:", claudeVersion(),
      "FORGE_ENABLED:", process.env.FORGE_ENABLED || "(unset)");
    console.log("guard:", JSON.stringify(runtimeGuard({})));
  } else {
    console.log("usage: node scripts/forge.js [validate|status]");
  }
}
