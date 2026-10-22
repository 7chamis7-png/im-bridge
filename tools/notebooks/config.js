'use strict';

/**
 * 他的本子们落在哪（2026-09-20）。
 *
 * **跟老 cyberboss 读写的是同一批文件、同一个格式** —— 新旧两套能随时互换（回滚就是换回老工具，
 * 数据一个字不用搬）。所以环境变量**沿用老名字**，默认值就是生产那份：
 *
 *   NOVA_STATE_DIR   家目录，**必须给**（2026-10-21 起不再默认 ~/.nova —— 别人用这包会写进Nova家）
 *   SELF_LIFE_NOTES_DIR   纸条目录，默认 <家>/notes（老 self-life/config.js 同名同默认）
 *
 * 其余路径老代码都是从家目录拼出来的、没有单独的开关，这里也不多开：
 *   <家>/diary/YYYY-MM-DD.md            日记（一天一个文件）
 *
 *   MEMORY_SOURCES_FILE   原话搜索读哪份（新桥冷层，Nova = /root/.nova-gate/cold.jsonl）。
 *                         2026-10-21 起没有默认值：没给 = 原话搜索那一个工具报错，其余照常。
 *                         指回老的 <家>/conversation-sources.jsonl 也能读（两种形状都认），回滚用。
 *   <家>/relationship.yaml               关系状态
 *   <家>/black-room/drafts.jsonl         小黑屋草稿
 *   <家>/body-state.txt / ring_state.json / play_mode.flag   self_state 读的三样
 *
 * 不需要任何密钥。
 */

const path = require('node:path');

// 2026-10-21 去掉默认值（见上）。名字留着给老引用。
const DEFAULT_COLD_FILE = '';

function envText(env, name, fallback) {
  const v = env[name];
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

function loadConfig(env = process.env) {
  const stateDir = envText(env, 'NOVA_STATE_DIR', '');
  if (!stateDir) throw new Error('notebooks：没配 NOVA_STATE_DIR（他自己的数据目录）。不再默认 ~/.nova —— 那是Nova家。');
  return {
    stateDir,
    diaryDir: path.join(stateDir, 'diary'),
    // 9-20 改：老的 conversation-sources.jsonl 9-18 切桥后就冻住了，新桥冷层里是全量（5-16 起）
    conversationSourceFile: envText(env, 'MEMORY_SOURCES_FILE', DEFAULT_COLD_FILE),
    relationshipFile: path.join(stateDir, 'relationship.yaml'),
    blackRoomDraftsFile: path.join(stateDir, 'black-room', 'drafts.jsonl'),
    notesDir: envText(env, 'SELF_LIFE_NOTES_DIR', path.join(stateDir, 'notes')),
  };
}

/** 日记文件名、纸条文件名的「今天」：**固定北京时间**，历史文件全是按它起名的，别改成走环境变量。 */
function todayInShanghai(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/**
 * 调用方给的日期 / 时间要进文件路径或文件内容 —— **只认 YYYY-MM-DD / HH:MM**（2026-09-20 加）。
 *
 * 老代码不校验：`date: "../x"` 会直接拼进路径，读写到目录外面去。这是**故意比老的严**的地方。
 * 日期还得是日历上真有的那天（2026-02-30 不行）。空串 / 没给不归这里管（调用方自己退回「今天」）。
 */
function assertDate(value, label = 'date') {
  const s = String(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!m || d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
    throw new Error(`Invalid ${label} ${JSON.stringify(s)}: must be a real date in YYYY-MM-DD format (e.g. 2026-09-20).`);
  }
  return s;
}

function assertTime(value, label = 'time') {
  const s = String(value);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) {
    throw new Error(`Invalid ${label} ${JSON.stringify(s)}: must be HH:MM in 24-hour time (e.g. 09:05).`);
  }
  return s;
}

module.exports = { loadConfig, todayInShanghai, assertDate, assertTime, DEFAULT_COLD_FILE };
