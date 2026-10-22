"use strict";

/**
 * 心脏的进程外壳（2026-09-19，pm2: nova-heart）
 *
 * 把路径凑齐、把拍子摆上、跑起来。**一条策略都不在这儿** —— 什么时候跳、
 * 该不该跳、递什么，全在各自那一拍里（`src/heart/beats/`）。
 *
 * 它替掉了今天上午临时挂的 `nova-checkin`（那会儿只有一拍，单开一个进程）。
 *
 * ## 配置跨着两个目录
 *
 * · 新桥这边 `$GATE_ROOT`：投递口 `producers/`、冷层 `cold.jsonl`、自己的账 `heart-fired.json`
 * · 老 state 目录 `/root/.nova`：区间配置、骰子权重、check-in 文案、提醒队列
 *   —— 这几样是他和工具一直在写/读的现役数据，**搬家是另一件事，不在心脏这一趟里做**。
 * 都能用环境变量盖掉，一个默认值都不藏。
 *
 * ## 手动敲
 *
 *   node src/host/heart-host.js --once reminder        # 敲一拍看结果
 *   node src/host/heart-host.js --once check-in --dir /tmp/试投   # 投临时目录，不进桥
 */

const fs = require("fs");
const path = require("path");
const { homeDir, gateRoot, personaStateDir, claudeProjectDir } = require("../core/paths");
const { makeHeart } = require("../heart/heart");
const { makeCheckinBeat } = require("../heart/beats/checkin");
const { makeReminderBeat } = require("../heart/beats/reminder");
const { makeDreamBeat } = require("../heart/beats/dream");

function bjNow() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 19);
}
function log(line) {
  console.log(bjNow() + " 京时 | " + line);
}

function readArgs(argv) {
  const out = { once: "", dir: "" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--once") { out.once = argv[i + 1] || "*"; i += 1; }
    else if (argv[i] === "--dir") { out.dir = argv[i + 1] || ""; i += 1; }
  }
  return out;
}

function buildHeart({ env = process.env, dirOverride = "" } = {}) {
  const root = gateRoot(env);
  const oldState = personaStateDir(env);
  const dir = dirOverride || env.GATE_PRODUCERS_DIR || path.join(root, "producers");

  const beats = [
    makeCheckinBeat({
      dir,
      configFile: env.CHECKIN_CONFIG_FILE || path.join(oldState, "checkin-config.json"),
      // HEADER + 四分支全文，改了不用重启；文件缺失/缺段自动退回代码里的内置副本
      // （见 producers/checkin.js 的 DEFAULT_TEXTS，2026-09-22 加骰子分支时一起加的）
      textsFile: env.CHECKIN_TEXTS_FILE || path.join(oldState, "checkin-texts.md"),
      // 上次抽到的分支 + 彩蛋各副牌的状态（2026-09-22 加），只有我们自己写，
      // 跟 checkin-config.json 放一起图个眼熟，不是同一份东西——见
      // producers/checkin.js 的 readState() 说明。
      stateFile: env.CHECKIN_STATE_FILE || path.join(oldState, "checkin-state.json"),
      coldFile: env.GATE_COLD_FILE || path.join(root, "cold.jsonl"),
      // 「悬着的」的供料函数仍指向笔记本，跟换舱那块同一个来源（2026-09-20；
      // 9-21 起 pending-promises.md 退役；9-22 起意图卡那半也拿掉了，「有空再说」
      // 这类待办笔记本要不要接、算哪个 kind 还没定——HEADER 目前也不渲染这一行了，
      // 见 producers/checkin.js 和 heart/beats/checkin.js 文件头）；
      // 模块路径跟 instructions.js 同一个开关
      notebookModule: env.NOVA_NOTEBOOK_MODULE || path.join(homeDir(env), "nova-notebook", "store"),
      notebookFile: env.NOVA_NOTEBOOK_FILE || "",
      desireUrl: env.DESIRE_URL || "http://127.0.0.1:8766",
      log,
    }),
    makeReminderBeat({
      dir,
      queueFile: env.REMINDER_QUEUE_FILE || path.join(oldState, "reminder-queue.json"),
      firedFile: env.HEART_FIRED_FILE || path.join(root, "heart-fired.json"),
      staleAfterMs: Number(env.HEART_REMINDER_STALE_MS || 0) || undefined,
      log,
    }),
    // 织梦（2026-09-24）：每天掷一次，掷中就在她睡着时炖一个梦锁进匣子，她醒来第一句之后推残片
    makeDreamBeat({
      dir,
      configFile: env.DREAM_CONFIG_FILE || path.join(oldState, "dream-config.json"),
      promptFile: env.DREAM_PROMPT_FILE || path.join(oldState, "dream-prompt.md"),
      stateFile: env.DREAM_STATE_FILE || path.join(root, "dream-state.json"),
      boxDir: env.DREAM_BOX_DIR || path.join(root, "dream-box"),
      coldFile: env.GATE_COLD_FILE || path.join(root, "cold.jsonl"),
      jarFile: env.NOVA_JAR_FILE || path.join(oldState, "幸福罐子.md"),
      // 他的会话记录目录 = Claude Code 按工作目录起的名（/root/nova → ~/.claude/projects/-root-nova）
      transcriptDir: env.NOVA_TRANSCRIPT_DIR || claudeProjectDir(env.GATE_WORKSPACE_ROOT || path.join(homeDir(env), "nova"), env),
      claudeBin: env.DREAM_CLAUDE_BIN || "/usr/local/bin/claude",  // 2026-10-14 搬德国机后 claude 从 /usr/bin 挪到 /usr/local/bin，织梦 spawn ENOENT 炖不出梦；改成实际路径
      log,
    }),
  ];

  return { heart: makeHeart({ beats, log }), root, dir };
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const { heart, root, dir } = buildHeart({ dirOverride: args.dir });

  if (args.once) {
    const names = args.once === "*" ? ["check-in", "reminder"] : [args.once];
    for (const n of names) log(n + " → " + JSON.stringify(await heart.tickOnce(n)));
    return;
  }

  log("投递口：" + dir);
  // 心跳：各拍跳了几次、最后一次什么时候、连着失败几次。**只给我和Alice看**
  //（Nova那头看不见这本账 —— 考核指标不进他的正文，9-18 砍「连续 N 次未开口」同理）。
  const beatFile = process.env.HEART_BEAT_FILE || path.join(root, "heart.json");
  const beatTimer = setInterval(() => {
    try {
      fs.writeFileSync(beatFile, JSON.stringify({ at: new Date().toISOString(), books: heart.books() }, null, 1));
    } catch (e) { log("心跳写不出去：" + e.message); }
  }, 30_000);

  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      log("收到 " + sig + "，停了");
      clearInterval(beatTimer);
      heart.stop();
      process.exit(0);
    });
  }
  await heart.run();
}

main().catch((e) => {
  log("起不来：" + ((e && e.stack) || e));
  process.exit(1);
});

module.exports = { buildHeart };
