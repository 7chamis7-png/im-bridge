'use strict';

/**
 * 「日常」这一包的配置（2026-09-20）—— 全从 env 来，没给就用**生产现在实际在用的值**。
 *
 * 跟老 cyberboss 读写**同一批文件、同一个格式**，新旧能随时互换（回滚 = 换回老工具，一个字节不用搬）。
 * 所以变量名沿用老名字：
 *
 *   NOVA_STATE_DIR         家目录，**必须给**（2026-10-21 起不再默认 ~/.nova；Nova = /root/.nova）
 *   REMINDER_QUEUE_FILE         提醒队列，默认 <家>/reminder-queue.json
 *                               —— **跟 nova-heart 那边同名同默认**（heart-host.js），两头永远指着同一个文件
 *   NOVA_ACCOUNT_ID        微信 bot 账号（生产 .env 里有）；没给就从 <家>/accounts/ 里挑唯一那个
 *   NOVA_ALLOWED_USER_IDS  她的微信 id，逗号分隔取第一个（生产 .env 里有）
 *   NOVA_WORKSPACE_ID      会话绑定的 workspace，默认 "default"（只在猜收件人那一级用）
 *   HEART_REMINDER_STALE_MS     心脏的补投窗口（跟 nova-heart 同名；生产没设 = 它默认 2 小时）。
 *                               这边清过期提醒的门槛 = max(48 小时, 它)，免得删掉心脏还会投的
 *   NOVA_CHROMIUM_PATH     浏览器可执行文件；没给就去 ~/.cache/ms-playwright 找最新的 chromium-*
 *
 * 其余路径老代码都是从家目录拼的、没有单独开关，这里也不多开：
 *   <家>/accounts/<账号>.json                  微信账号（只读：看它在不在、有没有 token）
 *   <家>/accounts/<账号>.context-tokens.json   每个人的 context_token（只读）
 *   <家>/sessions.json                         会话绑定（只读，猜收件人的第三级）
 *
 * 不需要任何密钥。账号文件里那个 token 只看「有没有」，不读出来用、不打印。
 *
 * 每次调用现读一遍（不在启动时缓存）：改 env 或测试换目录都立刻生效。
 */

const os = require('node:os');
const path = require('node:path');

function text(env, name) {
  const v = env[name];
  return typeof v === 'string' ? v.trim() : '';
}

// 照老 config.js 的 readListEnv：逗号切、去空白、扔空项
function list(env, name) {
  return String(env[name] || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function loadConfig(env = process.env) {
  // 老 config.js 用的是 `process.env.NOVA_STATE_DIR || ~/.nova`；2026-10-21 起没给就报错，
  // 免得别人的提醒排进Nova的队列（nova-heart 读的就是那份）
  const stateDir = text(env, 'NOVA_STATE_DIR');
  if (!stateDir) throw new Error('daily：没配 NOVA_STATE_DIR（他自己的数据目录）。不再默认 ~/.nova —— 那是Nova家。');
  return {
    stateDir,
    reminderQueueFile: text(env, 'REMINDER_QUEUE_FILE') || path.join(stateDir, 'reminder-queue.json'),
    accountsDir: path.join(stateDir, 'accounts'),
    sessionsFile: path.join(stateDir, 'sessions.json'),
    accountId: text(env, 'NOVA_ACCOUNT_ID'),
    allowedUserIds: list(env, 'NOVA_ALLOWED_USER_IDS'),
    workspaceId: text(env, 'NOVA_WORKSPACE_ID') || 'default',
    heartStaleMs: Number(text(env, 'HEART_REMINDER_STALE_MS')) || 0,
    chromiumPath: text(env, 'NOVA_CHROMIUM_PATH'),
    homeDir: os.homedir(),
  };
}

module.exports = { loadConfig };
