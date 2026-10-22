'use strict';

/**
 * 他给自己设闹钟（2026-09-20 从老 reminder-service.js + reminder-queue-store.js +
 * account-store / context-token-store / default-targets 里用到的那几段重写）。
 *
 * ## 写到哪、谁来读
 *
 * 写 `<家>/reminder-queue.json`（`{ "reminders": [...] }`，2 空格缩进）。
 * **读它的是 nova-heart 的提醒拍**（/root/cyberboss/src/heart/beats/reminder.js）：
 * 每 30 秒扫一遍，`id` 有、`dueAtMs` 到了、自己账上没投过的 → 把 `text` 原话递回给他。
 * 它**只读不写**队列（投过哪些记在它自己的 heart-fired.json），所以队列的写手只有这里一个。
 *
 * 心脏只看 `id / dueAtMs / text`。往哪个渠道递是**桥**按它自己的规矩定的（心脏只往
 * producers/ 扔文件，不带渠道），跟这条记录里的 accountId/senderId 没关系。
 *
 * ## 那为什么还要写 accountId / senderId / contextToken？
 *
 * 为了**回滚**：老队列代码（ReminderQueueStore.normalizeReminder）读文件时，**缺这三样
 * 任何一样的条目整条扔掉**，下次写回去就没了。这边要是只写心脏看的三个字段，一换回老工具，
 * 他设的提醒会在老工具第一次 enqueue 时被悄悄删光。所以记录形状跟老的一模一样：
 *
 *   { id, accountId, senderId, contextToken, text, dueAtMs, createdAt }
 *
 * 这三样怎么找、找不到报什么错，也全照老的（找不到就拒绝设 —— 老的就是这样，他见过这些报错）。
 *
 * ## 时间
 *
 * `delayMinutes` = 从现在起多少分钟（服务器时钟无所谓，毫秒时间戳没有时区）。
 * `dueAt` = **她的钟（北京时间）**。**凡是没写时区的，不管什么写法，一律当 +08:00**：
 *   `2026-04-07T21:30` / `2026-04-07 21:30:15` / `2026-04-07T21:30:00.000` / `2026/04/07 21:30` /
 *   `2026.4.7 9:05` …… 只给日期 = 那天早上 9 点北京时间。
 * 自带 Z / ±hh:mm / ±hhmm 的照它自己的。
 * 其它解不出来的（`tomorrow`、`2026-02-30`、`25:00`）→ 报老那句「Missing a valid time」，**绝不按服务器时区猜**。
 *
 * ⚠️ 跟老的有意不同（2026-09-20 协调人要的）：老代码对「带毫秒」「斜杠日期」这类写法直接丢给
 * Date.parse，按**进程本地时区**解 —— 这台机是 CEST，差 6 小时，她会平白错过提醒。
 * 另外老的会把 `2026-02-30` 这种不存在的日子悄悄滚成 3 月 2 日，这里直接拒。
 *
 * ## 写法
 *
 * 读 → 按老规矩规整（缺字段的扔、按 dueAtMs 排序）→ **扔掉过期 48 小时以上的** → 加一条 → 再排 → 写回。
 *
 * 跟老的有意不同的两处：
 *   · 先写临时文件再 rename（原子替换）——心脏在另一个进程里随时会读，读到半截文件它会当这一拍
 *     没有提醒（不炸，但白白晚 30 秒）。
 *   · 顺手清过期的：心脏只读不写、老桥的「取出即删」也没了，队列只进不出。心脏对晚了 2 小时以上的
 *     一律不补投（只记 missed），所以晚了 48 小时的**永远不会再响**，留着只是死账。
 *     门槛取 48 小时和 HEART_REMINDER_STALE_MS 里大的那个 —— 哪天心脏把补投窗口调大了，这边也不会抢先删。
 *     删的只是队列里的条目；心脏自己那本 heart-fired.json 不碰。
 *
 * 文件格式没变，老队列代码照读（回滚照样能用）。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TZ_LABEL = 'Asia/BJ'; // 老 outward-tz.js 的 INTERNAL_TZ_LABEL：给他看的时区名用别名，不写 +08:00

function t(v) {
  return typeof v === 'string' ? v.trim() : '';
}

// ——— 时间 ———

/** 老 parseDelayMinutes：空 = 0；parseInt；正数才算（×60000），0 和负数当没给。 */
function parseDelayMinutes(raw) {
  if (raw === undefined || raw === null || raw === '') return 0;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n * 60_000 : 0;
}

const ZONED = /([zZ]|[+-]\d{2}:?\d{2})$/;
// 没时区的写法：年 分隔 月 分隔 日（分隔符 - / . 前后一致），可选 [空格|T] 时:分[:秒[.小数]]
const LOCAL_FORM = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/;
const BJ_OFFSET_MS = 8 * 3600e3;

/**
 * 解她给的钟点 → 毫秒时间戳；解不出 = 0（上层报「Missing a valid time」）。
 *   · 带时区的：照老的（第一个空格换成 T）交给 Date.parse
 *   · 不带的：自己按字段拆，一律北京时间；日期不存在 / 钟点越界 → 0
 */
function parseAbsoluteTime(raw) {
  const s = String(raw || '').trim();
  if (!s) return 0;
  if (ZONED.test(s)) {
    const ms = Date.parse(s.replace(' ', 'T'));
    return Number.isFinite(ms) ? ms : 0;
  }
  const m = s.match(LOCAL_FORM);
  if (!m) return 0; // 不认识的写法：**不猜**，尤其不按服务器时区猜
  const [y, mo, d] = [Number(m[1]), Number(m[3]), Number(m[4])];
  const hasClock = m[5] !== undefined;
  const h = hasClock ? Number(m[5]) : 9; // 只给日期 = 早上 9 点（老规矩）
  const mi = hasClock ? Number(m[6]) : 0;
  const sec = m[7] !== undefined ? Number(m[7]) : 0;
  const msPart = m[8] !== undefined ? Number(m[8].slice(0, 3).padEnd(3, '0')) : 0;
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || sec > 59) return 0;
  const wall = Date.UTC(y, mo - 1, d, h, mi, sec, msPart);
  const back = new Date(wall);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return 0; // 2 月 30 日之类
  return wall - BJ_OFFSET_MS;
}

/**
 * 两个时间源只许给一个（都算出正数才算「给了」）。都没给 / 都解不出 = 0，交给上层报错。
 * 报错原文照老的（里面还提着 delay / at —— 那是老服务层认、但 schema 从来不放进来的两个参数）。
 */
function resolveDueAtMs({ delayMinutes, dueAt = '' } = {}, now = Date.now()) {
  const byDelay = parseDelayMinutes(delayMinutes);
  const byClock = parseAbsoluteTime(dueAt);
  if ([byDelay, byClock].filter((v) => v > 0).length > 1) {
    throw new Error('Use only one of delay, delayMinutes, at, or dueAt.');
  }
  if (byDelay) return now + byDelay;
  if (byClock) return byClock;
  return 0;
}

// ——— 微信账号 / 收件人 / context_token（全只读） ———

/** 老 normalizeAccountId：小写，非 [a-z0-9._-] 的一串换成一个 -，去头尾 -。账号文件就按它起名。 */
function normalizeAccountId(raw) {
  return String(raw || '').trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 读一个账号文件。只取判断要用的：规整后的 id、有没有 token、savedAt。token 本身不往外带。 */
function loadAccount(accountsDir, accountId) {
  const id = normalizeAccountId(accountId);
  if (!id) return null;
  try {
    const j = readJson(path.join(accountsDir, `${id}.json`));
    if (!j || typeof j !== 'object') return null;
    return {
      accountId: id,
      hasToken: typeof j.token === 'string' && j.token !== '',
      savedAt: typeof j.savedAt === 'string' ? j.savedAt : '',
    };
  } catch {
    return null;
  }
}

/** 老 resolveSelectedAccount：指定了就认指定的；没指定就要求 accounts/ 里**恰好一个**。报错原文照抄。 */
function resolveSelectedAccount(cfg) {
  if (cfg.accountId) {
    const account = loadAccount(cfg.accountsDir, cfg.accountId);
    if (!account) throw new Error(`WeChat account not found: ${cfg.accountId}`);
    if (!account.hasToken) throw new Error(`WeChat account is missing a token: ${account.accountId}. Run login again.`);
    return account;
  }
  let names = [];
  try {
    names = fs.readdirSync(cfg.accountsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.json') && !e.name.endsWith('.context-tokens.json'))
      .map((e) => e.name.slice(0, -5));
  } catch { /* 目录不在 = 没账号（老的会先建目录再读，结果一样是空） */ }
  const accounts = names.map((n) => loadAccount(cfg.accountsDir, n)).filter(Boolean)
    .sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
  if (!accounts.length) throw new Error('No saved WeChat account was found. Run `npm run login` first.');
  if (accounts.length > 1) {
    throw new Error(`Multiple WeChat accounts were detected. Set NOVA_ACCOUNT_ID. Available values: ${accounts.map((a) => a.accountId).join(', ')}`);
  }
  if (!accounts[0].hasToken) throw new Error(`WeChat account is missing a token: ${accounts[0].accountId}. Run login again.`);
  return accounts[0];
}

/** 老 loadPersistedContextTokens：{ 用户id: token }，两边都要非空，trim 过。读不到就是空表。 */
function loadContextTokens(accountsDir, accountId) {
  try {
    const j = readJson(path.join(accountsDir, `${normalizeAccountId(accountId)}.context-tokens.json`));
    if (!j || typeof j !== 'object') return {};
    return Object.fromEntries(Object.entries(j)
      .filter(([u, tok]) => typeof u === 'string' && u.trim() && typeof tok === 'string' && tok.trim())
      .map(([u, tok]) => [u.trim(), tok.trim()]));
  } catch {
    return {};
  }
}

/** 老 collectBindingSenderIds：sessions.json 里属于这个账号（workspace 对得上或没写）的绑定，收 senderId。 */
function bindingSenderIds(cfg, accountId) {
  const acc = t(accountId);
  if (!acc) return [];
  let bindings = {};
  try {
    const j = readJson(cfg.sessionsFile);
    if (j && typeof j === 'object' && j.bindings) bindings = j.bindings || {};
  } catch { return []; }
  const ids = new Set();
  for (const b of Object.values(bindings)) {
    const sid = t(b?.senderId);
    if (!sid || t(b?.accountId) !== acc) continue;
    const ws = t(b?.workspaceId);
    if (ws && ws !== t(cfg.workspaceId)) continue;
    ids.add(sid);
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

/**
 * 提醒记在谁名下。老的顺序是：
 *   ① 参数 userId → ② **这一轮的 senderId（per-turn context）** → ③ NOVA_ALLOWED_USER_IDS 第一个
 *   → ④ sessions.json 里唯一的绑定 → ⑤ context-tokens 里唯一的人 → 都没有 = ''
 *
 * ② 这一包没有了（没有 per-turn context）。老的 ② 读的是 project-tool-runtime-context.json，
 * 那文件 9-18 老桥退役后就冻住了，里面的 senderId 就是她的微信 id —— 跟 ③ 是同一个值，
 * 所以跳过 ② 结果不变。而且这个字段心脏根本不看（见文件头），只影响回滚后老代码认不认这条。
 */
function resolveSenderId(cfg, accountId, explicitUser) {
  const explicit = t(explicitUser);
  if (explicit) return explicit;
  if (cfg.allowedUserIds.length) return cfg.allowedUserIds[0];
  const bound = bindingSenderIds(cfg, accountId);
  if (bound.length === 1) {
    process.stderr.write(`[daily] 提醒收件人按会话绑定猜的：${bound[0]}（没配 NOVA_ALLOWED_USER_IDS）\n`);
    return bound[0];
  }
  const persisted = Object.keys(loadContextTokens(cfg.accountsDir, accountId)).map(t).filter(Boolean);
  if (persisted.length === 1) {
    process.stderr.write(`[daily] 提醒收件人按 context_token 猜的：${persisted[0]}（没配 NOVA_ALLOWED_USER_IDS）\n`);
    return persisted[0];
  }
  return '';
}

// ——— 队列 ———

/** 老 normalizeReminder：七个字段全 trim；缺 id/账号/收件人/token/正文、dueAtMs 不是正数 → 这条不要。 */
function normalizeReminder(r) {
  if (!r || typeof r !== 'object') return null;
  const id = t(r.id);
  const accountId = t(r.accountId);
  const senderId = t(r.senderId);
  const contextToken = t(r.contextToken);
  const text = t(r.text);
  const dueAtMs = Number(r.dueAtMs);
  const createdAt = t(r.createdAt);
  if (!id || !accountId || !senderId || !contextToken || !text || !Number.isFinite(dueAtMs) || dueAtMs <= 0) return null;
  return { id, accountId, senderId, contextToken, text, dueAtMs, createdAt: createdAt || new Date().toISOString() };
}

/** 老 load：只认 `reminders` 数组，规整、扔坏的、按到期排。读不了/坏 JSON = 空队列（老的也是）。 */
function loadQueue(file) {
  try {
    const j = readJson(file);
    const list = Array.isArray(j?.reminders) ? j.reminders : [];
    return list.map(normalizeReminder).filter(Boolean).sort((a, b) => a.dueAtMs - b.dueAtMs);
  } catch {
    return [];
  }
}

const PRUNE_AFTER_MS = 48 * 3600e3;

/** 过了这个点还没响的，心脏永远不会再投了：max(48 小时, 心脏的补投窗口)。 */
function pruneCutoffMs(now, heartStaleMs = 0) {
  return now - Math.max(PRUNE_AFTER_MS, Number(heartStaleMs) || 0);
}

/**
 * 加一条，写回。格式 = JSON.stringify({reminders}, null, 2)，末尾不带换行（跟老的逐字节一样）。
 * 写之前清掉到期时间早于 cutoff 的（见文件头「写法」）。
 */
function enqueue(file, reminder, { now = Date.now(), heartStaleMs = 0 } = {}) {
  const cutoff = pruneCutoffMs(now, heartStaleMs);
  const reminders = loadQueue(file).filter((r) => r.dueAtMs >= cutoff);
  const one = normalizeReminder(reminder);
  if (!one) throw new Error('invalid reminder');
  reminders.push(one);
  reminders.sort((a, b) => a.dueAtMs - b.dueAtMs);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify({ reminders }, null, 2));
  fs.renameSync(tmp, file);
  return one;
}

// ——— 入口 ———

/** 老 text-input.normalizeBody：\r\n → \n，trim。 */
function normalizeBody(v) {
  return String(v || '').replace(/\r\n/g, '\n').trim();
}

/**
 * 设一条。检查顺序跟老的一样（先报哪个错他见过）：
 *   正文空 → 时间（两个都给 / 没有 / 已经过去）→ 账号 → 收件人 → context_token → 写
 */
function createReminder(cfg, { text = '', delayMinutes, dueAt = '', userId = '' } = {}, { now = () => Date.now() } = {}) {
  const body = normalizeBody(text);
  if (!body) throw new Error('Reminder text cannot be empty. Pass text or textFile.');

  const dueAtMs = resolveDueAtMs({ delayMinutes, dueAt }, now());
  if (!Number.isFinite(dueAtMs) || dueAtMs <= now()) {
    throw new Error(`Missing a valid time. Use delayMinutes or dueAt like 2026-04-07T21:30 (${TZ_LABEL}).`);
  }

  const account = resolveSelectedAccount(cfg);
  const senderId = resolveSenderId(cfg, account.accountId, userId);
  if (!senderId) throw new Error('Cannot determine the WeChat user for this reminder.');

  const contextToken = t(loadContextTokens(cfg.accountsDir, account.accountId)[senderId] || '');
  if (!contextToken) {
    throw new Error(`Cannot find context_token for ${senderId}. Let this user talk to the bot once first.`);
  }

  return enqueue(cfg.reminderQueueFile, {
    id: crypto.randomUUID(),
    accountId: account.accountId,
    senderId,
    contextToken,
    text: body,
    dueAtMs,
    createdAt: new Date(now()).toISOString(),
  }, { now: now(), heartStaleMs: cfg.heartStaleMs });
}

module.exports = {
  createReminder, resolveDueAtMs, parseDelayMinutes, parseAbsoluteTime, pruneCutoffMs, PRUNE_AFTER_MS,
  normalizeAccountId, resolveSelectedAccount, resolveSenderId, loadContextTokens,
  normalizeReminder, loadQueue, enqueue, TZ_LABEL,
};
