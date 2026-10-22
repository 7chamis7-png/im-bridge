#!/usr/bin/env node
"use strict";

/**
 * 新建一个角色（2026-10-21「拉下来就能用」）。
 *
 *   node scripts/im-bridge.js init [角色id]                交互问
 *   node scripts/im-bridge.js init --answers a.json        不问，照文件来（测试 / 批量）
 *   node scripts/im-bridge.js init ah7 --telegram-token … --owner-telegram-id … --engine claude-cli --yes
 *
 * 生成（全在这个角色自己的目录里，**已存在的角色目录绝不覆盖**）：
 *   ~/.<id>-gate/          GATE_ROOT：<id>-env.sh、run-*.sh、tools.json、models.json、ecosystem.config.cjs
 *   ~/.<id>/               他的数据目录（NOVA_STATE_DIR / GATE_MEMORY_DIR）：memory.md、operations.md、channels/、skills/
 *   ~/<id>/                工作目录：system-prompt.md（宣言）、<名字>.md（人格文件）
 *   ~/.secrets/<id>-*.secret   钥匙（600）。env 文件里只写「去哪读」，不写值
 *
 * pm2 进程名前缀 = 角色 id：<id>-cli / <id>-box / <id>-gate（+ <id>-imessage、<id>-heart）。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const ENGINES = {
  "claude-cli": { legacy: "claude", entry: "cli-host/main.js", model: "claude-opus-5-5" },
  "codex": { legacy: "codex", entry: "cli-host/codex-main.js", model: "gpt-5.6-sol" },
  "deepseek": { legacy: "deepseek", entry: "cli-host/main.js", model: "deepseek-chat" },
};
const CHANNELS = ["telegram", "imessage", "wechat"];
const ID_RE = /^[a-z][a-z0-9-]{1,30}$/;

/** 登记表里住在桥外面的工具（要另装代码 / 要别人的号）—— 新角色默认不挂，装好了再从 exclude 里拿掉。 */
const EXTERNAL_TOOLS = ["cedartoy", "taibu", "browser", "notebook", "stickers", "garden", "aisay", "crotown"];

// ——————————————————————————————————————————— 答案

/**
 * 「~」「~/x」展开成绝对路径。env 文件里是单引号写的（shq），shell 不会再展开 ——
 * 不在这儿展开就会生成 CODEX_HOME='~/.codex' 这种字面量，引擎找不到登录态。
 */
function expandHome(p, home = os.homedir()) {
  const s = String(p == null ? "" : p).trim();
  if (s === "~") return home;
  if (s.startsWith("~/")) return path.join(home, s.slice(2));
  return s;
}

function normalizeAnswers(raw, { home = os.homedir() } = {}) {
  const a = { ...raw };
  const errors = [];
  a.id = String(a.id || "").trim();
  if (!ID_RE.test(a.id)) errors.push(`角色 id「${a.id}」不行：小写字母开头，只用 a-z 0-9 -，2~31 个字（它会当 pm2 进程名前缀和目录名）`);
  a.agentName = String(a.agentName || a.id).trim();
  a.ownerName = String(a.ownerName || "").trim();
  if (!a.ownerName) errors.push("主人叫什么（ownerName）没填");
  a.ownerKey = String(a.ownerKey || "owner").trim();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(a.ownerKey)) errors.push(`ownerKey「${a.ownerKey}」只能是小写字母数字（账本里记的身份键）`);
  a.ownerPronoun = String(a.ownerPronoun || "她").trim();
  a.telegramToken = String(a.telegramToken || "").trim();
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(a.telegramToken)) errors.push("TG bot token 不像 token（形如 123456:ABC…，找 @BotFather 要）");
  a.ownerTelegramId = String(a.ownerTelegramId || "").trim();
  if (!/^-?\d{3,}$/.test(a.ownerTelegramId)) errors.push("主人的 TG id 要是数字（问 @userinfobot）");
  a.engine = String(a.engine || "claude-cli").trim();
  if (a.engine === "claude") a.engine = "claude-cli";
  if (!ENGINES[a.engine]) errors.push(`引擎「${a.engine}」不认识（只认 ${Object.keys(ENGINES).join(" / ")}）`);
  a.channels = (Array.isArray(a.channels) ? a.channels : String(a.channels || "telegram").split(","))
    .map((s) => String(s).trim()).filter(Boolean);
  if (!a.channels.includes("telegram")) a.channels.unshift("telegram");
  for (const c of a.channels) if (!CHANNELS.includes(c)) errors.push(`渠道「${c}」init 不管（只认 ${CHANNELS.join(" / ")}）`);
  a.imessage = a.imessage && typeof a.imessage === "object" ? a.imessage : {};
  if (a.channels.includes("imessage")) {
    for (const k of ["photonProjectId", "photonSecret", "ownerHandles"]) {
      if (!String(a.imessage[k] || "").trim()) errors.push(`选了 iMessage 但没填 imessage.${k}`);
    }
  }
  // 微信（她自己的真实微信：读库收 + 无障碍点屏幕发）。密钥文件怎么拿到不归这里管，见 docs/INSTALL.md
  a.wechat = a.wechat && typeof a.wechat === "object" ? { ...a.wechat } : {};
  if (a.channels.includes("wechat")) {
    const w = a.wechat;
    for (const k of ["target", "ownerWxid"]) w[k] = String(w[k] || "").trim();
    for (const k of ["keysFile", "imageKeyFile", "dataDir"]) w[k] = expandHome(w[k], home);
    w.display = String(w.display || ":98").trim();
    for (const [k, why] of [["keysFile", "库密钥文件（all_keys.json）"], ["imageKeyFile", "图片 key 文件"], ["target", "她的聊天窗标题"], ["ownerWxid", "她的 wxid"]]) {
      if (!w[k]) errors.push(`选了微信但没填 wechat.${k}（${why}）`);
    }
  }
  a.deepseekKey = String(a.deepseekKey || "").trim();
  // 2026-10-22 数据隔离：默认每个角色一份自己的 codex 家（~/.<id>-codex），不跟同机别的角色共用 ~/.codex
  a.codexHome = expandHome(a.codexHome || path.join(home, `.${a.id}-codex`), home);
  a.heart = a.heart === true || a.heart === "yes" || a.heart === "y";
  // ——— 共用能力（都可选；不填 = 关着，doctor 会明说是关着的）———
  const obj = (v) => (v && typeof v === "object" ? { ...v } : {});
  a.transcribe = obj(a.transcribe);           // { apiKey, baseUrl, model, local }
  a.transcribe.apiKey = String(a.transcribe.apiKey || "").trim();
  a.transcribe.baseUrl = String(a.transcribe.baseUrl || "").trim();
  a.transcribe.model = String(a.transcribe.model || "").trim();
  a.transcribe.local = a.transcribe.local === true || a.transcribe.local === "y" || a.transcribe.local === "yes";
  if (a.transcribe.apiKey && !a.transcribe.baseUrl) a.transcribe.baseUrl = "https://api.openai.com/v1";
  if (a.transcribe.apiKey && !a.transcribe.model) a.transcribe.model = "whisper-1";
  a.tts = obj(a.tts);                         // { apiKey, voiceId }
  a.tts.apiKey = String(a.tts.apiKey || "").trim();
  a.tts.voiceId = String(a.tts.voiceId || "").trim();
  if (a.tts.apiKey && !a.tts.voiceId) errors.push("填了 ElevenLabs key 就要填 voice id（不填的话会用代码里那个别人的音色）");
  a.image = obj(a.image);                     // { apiKey, model }（r8_ 开头 = Replicate，否则 OpenAI 图像接口）
  a.image.apiKey = String(a.image.apiKey || "").trim();
  a.image.model = String(a.image.model || "").trim();
  a.acoustic = obj(a.acoustic);               // { enabled, python, script }
  a.acoustic.enabled = a.acoustic.enabled === true || a.acoustic.enabled === "y";
  for (const k of ["python", "script"]) if (a.acoustic[k]) a.acoustic[k] = expandHome(a.acoustic[k], home);
  a.tz = String(a.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  a.locale = String(a.locale || "zh-CN");
  return { answers: a, errors };
}

// ——————————————————————————————————————————— 生成什么

function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

function fill(tpl, a) {
  return String(tpl)
    .replaceAll("{{AGENT_NAME}}", a.agentName)
    .replaceAll("{{OWNER_NAME}}", a.ownerName)
    .replaceAll("{{USER_NAME}}", a.ownerName)
    .replaceAll("{{USER_PRONOUN}}", a.ownerPronoun);
}

function which(cmd, envPath = process.env.PATH || "") {
  for (const dir of envPath.split(":")) {
    if (!dir) continue;
    const f = path.join(dir, cmd);
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* 下一个 */ }
  }
  return "";
}

/**
 * @returns {{ dirs, files: Array<{path, content, mode?, kind}>, info }}
 *   kind: gate（角色目录，整个是新的）/ data（数据或工作目录，已有的文件不动）/ secret（钥匙，已有的不动）
 */
function planRole(a, { home = os.homedir(), repo = REPO_ROOT, nodePath = process.execPath, pathEnv = process.env.PATH } = {}) {
  const gateRoot = path.join(home, `.${a.id}-gate`);
  const stateDir = path.join(home, `.${a.id}`);
  const workspace = path.join(home, a.id);
  const secretsDir = path.join(home, ".secrets");
  const sec = (name) => path.join(secretsDir, `${a.id}-${name}.secret`);
  const eng = ENGINES[a.engine];
  const personaFile = path.join(workspace, `${a.agentName}.md`);
  const ex = (f) => fs.readFileSync(path.join(repo, "examples", f), "utf8");

  // PATH：pm2 起的进程不一定带登录 shell 的 PATH。把 node 和找得到的 claude / codex 所在目录钉进去。
  const pathDirs = [path.dirname(nodePath)];
  for (const c of ["claude", "codex"]) { const w = which(c, pathEnv); if (w) pathDirs.push(path.dirname(w)); }
  pathDirs.push("/usr/local/bin", "/usr/bin", "/bin");
  const PATH = [...new Set(pathDirs)].join(":");

  const models = JSON.parse(ex("init/models.example.json"));
  models.default = eng.model;
  for (const m of models.models) if (m.engine === "openai-chat") m.secret = `${a.id}-deepseek`;
  const window = (models.models.find((m) => m.id === eng.model) || {}).window || 200000;

  const tools = {
    _说明: "这个角色的工具配置（登记表在 src/toolbox/registry.js）。exclude 里是住在桥外面、要另装的工具包；装好了从 exclude 里拿掉。钥匙的值不写这里，写进 secretsFiles 指的文件（KEY=VALUE 一行一个）。",
    persona: a.id,
    personaFile,
    vars: { STATE_DIR: stateDir, WORKSPACE: workspace, ...(a.image.model ? { IMAGE_MODEL: a.image.model } : {}) },
    secretsFiles: [],
    secretFiles: {
      ...(a.tts.apiKey ? { ELEVENLABS_API_KEY: sec("elevenlabs") } : {}),
      ...(a.image.apiKey ? { NOVA_IMAGE_API_KEY: sec("image") } : {}),
    },
    exclude: EXTERNAL_TOOLS,
  };

  const L = [];
  const add = (k, v, note = "") => L.push(`${k}=${shq(v)}${note ? "   # " + note : ""}`);
  L.push("#!/usr/bin/env bash",
    `# ${a.agentName}（${a.id}）这一套的共用配置。run-*.sh 都 source 它 —— 配置只有一份。`,
    `# ${new Date().toISOString()} 由 im-bridge init 生成。钥匙不在这里：只写去 ~/.secrets 哪个文件读。`,
    "set -a", "");
  L.push("# ——— 位置 ———");
  add("PATH", PATH);
  add("IM_BRIDGE_HOME", repo, "代码在哪");
  add("GATE_ROOT", gateRoot, "桥自己的目录（账本/游标/冷层/socket）");
  add("NOVA_STATE_DIR", stateDir, "他的数据目录（名字是历史遗留）");
  add("GATE_MEMORY_DIR", stateDir, "换舱拼底子从这儿读 memory.md / operations.md / channels/");
  add("GATE_WORKSPACE_ROOT", workspace, "他的工作目录");
  add("GATE_SYSTEM_PROMPT_FILE", path.join(workspace, "system-prompt.md"), "宣言，进系统提示最前面");
  add("GATE_IDENTITY_INJECTION_FILE", path.join(stateDir, "identity-injection.txt"), "身份底座（可选，没有这个文件就不拼）");
  add("GATE_COLD_FILE", path.join(gateRoot, "cold.jsonl"));
  add("GATE_BOX_SOCKET", path.join(gateRoot, "box.sock"));
  add("NOVA_CLI_SOCKET", path.join(gateRoot, "cli.sock"));
  L.push("", "# ——— 谁 ———");
  add("GATE_PERSONA_NAME", a.id);
  add("GATE_AGENT_DISPLAY_NAME", a.agentName, "提示词里他怎么称呼自己");
  add("GATE_OWNER_DISPLAY_NAME", a.ownerName, "提示词里主人叫什么");
  add("GATE_OWNER_NAME", a.ownerKey, "账本里主人的身份键");
  add("GATE_BINDING_KEY", `${a.id}:main`, "sessions.json 里这条会话的键");
  add("GATE_OWNER_TELEGRAM_ID", a.ownerTelegramId);
  add("GATE_PREFERRED_CHAT_ID", a.ownerTelegramId, "他主动说话时发去哪");
  add("OUTWARD_TZ", a.tz);
  add("OUTWARD_LOCALE", a.locale);
  L.push("", "# ——— 引擎 ———");
  add("GATE_ENGINE", eng.legacy, "claude / codex / deepseek；具体模型看 models.json 的 default");
  add("GATE_MODEL", "", "空着 = models.json + /model 说了算；钉值会让 /model 一律被拒");
  add("GATE_BOX_CONTEXT_LIMIT", String(window), "上下文上限（报水位用），换模型记得改");
  add("GATE_CLAUDE_PERMISSION_MODE", "acceptEdits", "默认档下每个工具都要问许可、没人应答会挂死");
  // 总是写：不选 codex 的角色以后 /engine 切到 codex 也要用它自己的（没登录 = 切的时候明确报错，不借别人的）
  add("CODEX_HOME", a.codexHome, "这个角色自己的 codex 登录态 / thread；用 codex 前先 CODEX_HOME=… codex login");
  if (a.engine === "deepseek") {
    add("DEEPSEEK_ALLOW_BILLING", "1", "按量计费的钱闸：init 时选了 deepseek = 明确同意");
    add("DEEPSEEK_SECRET", `${a.id}-deepseek`);
  }
  add("GATE_HEARTBEAT_MS", "15000");
  add("GATE_WATCH_MS", "30000");
  L.push("", "# ——— 共用能力（不填的 = 关着；doctor 逐条说）———");
  const t = a.transcribe;
  if (t.apiKey) {
    L.push(`NOVA_TRANSCRIPTION_API_KEY="$(cat ${shq(sec("transcribe"))} 2>/dev/null)"   # 语音转文字（OpenAI 兼容 /audio/transcriptions）`);
    add("NOVA_TRANSCRIPTION_BASE_URL", t.baseUrl);
    add("NOVA_TRANSCRIPTION_MODEL", t.model);
  }
  add("NOVA_TRANSCRIPTION_LOCAL", t.local ? "true" : "false", "本地 whisper 兜底（python3 -c 'import whisper' + ~/.cache/whisper/<模型>.pt）");
  if (!t.apiKey && !t.local) add("GATE_TRANSCRIBE", "off", "没配转写：语音进来他会看到「转写没接上」，不会假装听了");
  if (a.tts.apiKey) {
    L.push(`ELEVENLABS_API_KEY="$(cat ${shq(sec("elevenlabs"))} 2>/dev/null)"   # 语音合成（发语音）`);
    add("ELEVENLABS_DEFAULT_VOICE_ID", a.tts.voiceId);
  } else L.push("# 语音合成：没配 ElevenLabs，send_voice 会被明确挡下（缺 synthesize_voice）");
  if (a.image.apiKey) {
    L.push(`NOVA_IMAGE_API_KEY="$(cat ${shq(sec("image"))} 2>/dev/null)"   # 画图（r8_ 开头走 Replicate，否则 OpenAI 图像接口）`);
    if (a.image.model) add("NOVA_IMAGE_MODEL", a.image.model);
  } else L.push("# 画图：没配，generate_image 不注册");
  if (a.acoustic.enabled) {
    if (a.acoustic.python) add("NORTH_EAR_PYTHON", a.acoustic.python);
    if (a.acoustic.script) add("NORTH_EAR_SCRIPT", a.acoustic.script);
  } else add("GATE_ACOUSTIC", "off", "听语气（north-ear）要本机另装，见 docs/INSTALL.md");

  L.push("", "# ——— 渠道 ———");
  L.push(`GATE_TELEGRAM_TOKEN="$(cat ${shq(sec("telegram"))} 2>/dev/null)"`);
  if (a.channels.includes("imessage")) {
    add("GATE_IMESSAGE_INBOX_DIR", path.join(gateRoot, "imessage-inbox"));
    add("GATE_IMESSAGE_SOCKET", path.join(gateRoot, "imessage.sock"));
    add("GATE_OWNER_IMESSAGE_ID", a.imessage.ownerHandles, "她的手机号 / Apple ID，逗号分隔，都要写");
    add("NOVA_IMESSAGE_ALLOWED_HANDLES", a.imessage.ownerHandles);
    L.push(`PHOTON_PROJECT_ID="$(cat ${shq(sec("photon-project-id"))} 2>/dev/null)"`);
    L.push(`PHOTON_PROJECT_SECRET="$(cat ${shq(sec("photon-secret"))} 2>/dev/null)"`);
  }
  if (a.channels.includes("wechat")) {
    const w = a.wechat;
    const wdir = path.join(stateDir, "wechat");
    L.push("", "# ——— 微信（读库收 + 无障碍发）。⚠️ 自动发送有封号风险，见 docs/INSTALL.md「微信」———");
    add("GATE_WECHAT_SENDER_MODE", "a11y", "只点屏幕，不注入微信进程");
    add("GATE_WECHAT_KEYS_FILE", w.keysFile, "库密钥（_db_dir + 各库 enc_key），你自己提供");
    add("GATE_WECHAT_IMAGE_KEY_FILE", w.imageKeyFile);
    if (w.dataDir) add("GATE_WECHAT_DATA_DIR", w.dataDir, "xwechat_files（doctor 拿来对 _db_dir）");
    add("GATE_WECHAT_WHITELIST_FILE", path.join(wdir, "whitelist"), "只收这里面的人（一行一个 wxid / 昵称）");
    add("GATE_WECHAT_SENDER", path.join(repo, "src", "gate", "plugins", "wechat", "linux-wx-send-a11y.py"));
    add("GATE_WECHAT_TARGET", w.target, "她的聊天窗标题（无障碍靠它认人）");
    add("GATE_OWNER_WECHAT_ID", w.ownerWxid);
    add("GATE_WECHAT_SEND_LOCK", path.join(wdir, ".send.lock"));
    add("GATE_WECHAT_SEND_LOG", path.join(wdir, "a11y-send.log"));
    add("GATE_WECHAT_DISPLAY", w.display, "微信跑在哪个 X 屏（Xvfb）");
    add("LINUX_WX_DISPLAY", w.display);
    add("LINUX_WX_SPOTS", path.join(wdir, "wx-spots.json"), "发语音 / 拨号用的坐标");
    add("GATE_WECHAT_GAP_MIN_MS", "1000", "段间随机间隔下限 —— 发送节奏，别调太快");
    add("GATE_WECHAT_GAP_MAX_MS", "3000");
    if (w.micSink) add("GATE_WECHAT_MIC_SINK", w.micSink, "发语音用的虚拟麦克风（PulseAudio sink）");
  }
  L.push("", "set +a", "");
  const envFile = path.join(gateRoot, `${a.id}-env.sh`);

  // run-*.sh：干净环境重跑自己（不继承启动者的 env —— 别的角色的 GATE_/NOVA_ 会让它挂错腿、拿错 token）
  const runSh = (proc, what, entry, extra = []) => [
    "#!/usr/bin/env bash",
    `# ${a.agentName} 的 ${what}（pm2: ${a.id}-${proc}）。由 im-bridge init 生成。`,
    "set -e",
    `[ "\${IMB_CLEAN_ENV:-}" = "$$" ] || exec env -i IMB_CLEAN_ENV=$$ HOME=${shq(home)} PATH=${shq(PATH)} bash "$0" "$@"`,
    `. ${shq(envFile)}`,
    ...extra,
    `cd ${shq(repo)}`,
    `exec node ${entry}`,
    "",
  ].join("\n");

  const procs = [
    { proc: "cli", what: "引擎宿主（他本人住的进程，重启会打断他）", entry: eng.entry },
    { proc: "box", what: "盒子（会话 / forge / 人格注入）", entry: "host/box-host.js" },
    { proc: "gate", what: "桥（插头 / 路由 / 冷层 / 命令）", entry: "src/host/main.js", extra: ["export GATE_BOX=remote"] },
  ];
  if (a.channels.includes("imessage")) procs.push({ proc: "imessage", what: "iMessage 喂料进程", entry: "src/host/imessage-spectrum.js" });
  if (a.heart) procs.push({ proc: "heart", what: "心脏（check-in / reminder，只往 producers 扔文件）", entry: "src/host/heart-host.js" });

  const eco = [
    '"use strict";',
    `// ${a.agentName}（${a.id}）的 pm2 配置。由 im-bridge init 生成。`,
    `// 起：pm2 start ${path.join(gateRoot, "ecosystem.config.cjs")} && pm2 save`,
    "module.exports = {",
    "  apps: [",
    ...procs.map((p) => [
      "    {",
      `      name: ${JSON.stringify(`${a.id}-${p.proc}`)},`,
      `      script: ${JSON.stringify(path.join(gateRoot, `run-${p.proc}.sh`))},`,
      `      cwd: ${JSON.stringify(repo)},`,
      '      interpreter: "none",',
      "      autorestart: true,",
      "      restart_delay: 5000,",
      "      kill_timeout: 10 * 60 * 1000,",
      "    },",
    ].join("\n")),
    "  ],",
    "};",
    "",
  ].join("\n");

  const files = [
    { kind: "gate", path: envFile, content: L.join("\n"), mode: 0o600 },
    ...procs.map((p) => ({ kind: "gate", path: path.join(gateRoot, `run-${p.proc}.sh`), content: runSh(p.proc, p.what, p.entry, p.extra), mode: 0o700 })),
    { kind: "gate", path: path.join(gateRoot, "ecosystem.config.cjs"), content: eco },
    // 总开关：有这个文件桥才接消息（删掉 = 暂停接收，不用重启）。新角色默认开着
    { kind: "gate", path: path.join(gateRoot, ".gate-enabled"), content: "" },
    { kind: "gate", path: path.join(gateRoot, "tools.json"), content: JSON.stringify(tools, null, 2) + "\n" },
    { kind: "gate", path: path.join(gateRoot, "models.json"), content: JSON.stringify(models, null, 2) + "\n" },
    { kind: "data", path: path.join(workspace, "system-prompt.md"), content: fill(ex("init/system-prompt.md"), a) },
    { kind: "data", path: personaFile, content: fill(ex("init/persona.md"), a) },
    { kind: "data", path: path.join(stateDir, "memory.md"), content: fill(ex("init/memory.md"), a) },
    { kind: "data", path: path.join(stateDir, "operations.md"), content: fill(ex("memory/operations.md"), a) },
    { kind: "data", path: path.join(stateDir, "channels", "telegram.md"), content: fill(ex("memory/channels/telegram.md"), a) },
    { kind: "secret", path: sec("telegram"), content: a.telegramToken + "\n", mode: 0o600 },
  ];
  if (a.transcribe.apiKey) files.push({ kind: "secret", path: sec("transcribe"), content: a.transcribe.apiKey + "\n", mode: 0o600 });
  if (a.tts.apiKey) files.push({ kind: "secret", path: sec("elevenlabs"), content: a.tts.apiKey + "\n", mode: 0o600 });
  if (a.image.apiKey) files.push({ kind: "secret", path: sec("image"), content: a.image.apiKey + "\n", mode: 0o600 });
  if (a.channels.includes("wechat")) {
    files.push({ kind: "data", path: path.join(stateDir, "wechat", "whitelist"), content: a.wechat.ownerWxid + "\n" });
  }
  if (a.engine === "deepseek" && a.deepseekKey) files.push({ kind: "secret", path: sec("deepseek"), content: a.deepseekKey + "\n", mode: 0o600 });
  if (a.channels.includes("imessage")) {
    files.push({ kind: "secret", path: sec("photon-project-id"), content: a.imessage.photonProjectId + "\n", mode: 0o600 });
    files.push({ kind: "secret", path: sec("photon-secret"), content: a.imessage.photonSecret + "\n", mode: 0o600 });
  }
  const dirs = [
    { path: gateRoot, mode: 0o700 }, { path: path.join(gateRoot, "state"), mode: 0o700 },
    { path: stateDir, mode: 0o700 }, { path: path.join(stateDir, "skills") }, { path: path.join(stateDir, "inbox") },
    { path: workspace }, { path: secretsDir, mode: 0o700 },
  ];
  if (a.channels.includes("imessage")) dirs.push({ path: path.join(gateRoot, "imessage-inbox"), mode: 0o700 });
  return { dirs, files, info: { gateRoot, stateDir, workspace, envFile, procs: procs.map((p) => `${a.id}-${p.proc}`), engine: a.engine } };
}

/** 落盘。角色目录（GATE_ROOT）已存在 → 一个字不写，直接拒。数据/钥匙文件已存在 → 跳过那个文件。 */
function writeRole(plan) {
  if (fs.existsSync(plan.info.gateRoot)) {
    throw new Error(`${plan.info.gateRoot} 已经在了 —— 这个角色建过，init 绝不覆盖。要重来先自己挪走它。`);
  }
  const written = [], kept = [];
  for (const d of plan.dirs) {
    fs.mkdirSync(d.path, { recursive: true, ...(d.mode ? { mode: d.mode } : {}) });
  }
  for (const f of plan.files) {
    if (f.kind !== "gate" && fs.existsSync(f.path)) { kept.push(f.path); continue; }
    fs.mkdirSync(path.dirname(f.path), { recursive: true });
    fs.writeFileSync(f.path, f.content, { flag: "wx", ...(f.mode ? { mode: f.mode } : {}) });
    if (f.mode) fs.chmodSync(f.path, f.mode);
    written.push(f.path);
  }
  return { written, kept };
}

// ——————————————————————————————————————————— 命令行

function parseArgs(argv) {
  const out = { flags: {}, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const [k, inline] = t.slice(2).split("=", 2);
      if (inline !== undefined) out.flags[k] = inline;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) out.flags[k] = argv[++i];
      else out.flags[k] = true;
    } else out.positional.push(t);
  }
  return out;
}

const FLAG_MAP = {
  "agent-name": "agentName", "owner-name": "ownerName", "owner-key": "ownerKey", "owner-pronoun": "ownerPronoun",
  "telegram-token": "telegramToken", "owner-telegram-id": "ownerTelegramId", engine: "engine", channels: "channels",
  "deepseek-key": "deepseekKey", "codex-home": "codexHome", heart: "heart", tz: "tz",
};

async function ask(rl, q, def = "", { secret = false } = {}) {
  const shown = def ? `${q} [${secret ? "已填" : def}]: ` : `${q}: `;
  const v = (await new Promise((r) => rl.question(shown, r))).trim();
  return v || def;
}

async function interactive(a) {
  const readline = require("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("新建一个角色。直接回车 = 用方括号里的默认值。\n");
    a.id = await ask(rl, "角色 id（英文小写，当 pm2 前缀和目录名，比如 ah7）", a.id || "");
    a.agentName = await ask(rl, "他叫什么（提示词里怎么称呼自己）", a.agentName || a.id);
    a.ownerName = await ask(rl, "你叫什么（他怎么称呼你）", a.ownerName || "");
    a.ownerPronoun = await ask(rl, "提到你用哪个字（她 / 他 / TA）", a.ownerPronoun || "她");
    a.telegramToken = await ask(rl, "Telegram bot token（@BotFather 给的）", a.telegramToken || "", { secret: true });
    a.ownerTelegramId = await ask(rl, "你的 Telegram 数字 id（@userinfobot 能查）", a.ownerTelegramId || "");
    a.engine = await ask(rl, "引擎（claude-cli / codex / deepseek）", a.engine || "claude-cli");
    if (a.engine === "deepseek") a.deepseekKey = await ask(rl, "DeepSeek API key（可以先空着，回头放进 ~/.secrets）", a.deepseekKey || "", { secret: true });
    if (a.engine === "codex") a.codexHome = await ask(rl, "CODEX_HOME（codex 登录态放哪）", a.codexHome || path.join(os.homedir(), `.${a.id}-codex`));
    const ch = await ask(rl, "渠道（telegram 必选；还可以加 imessage / wechat，逗号分隔）", (a.channels || ["telegram"]).join(","));
    a.channels = ch.split(",").map((s) => s.trim()).filter(Boolean);
    if (a.channels.includes("imessage")) {
      a.imessage = a.imessage || {};
      a.imessage.photonProjectId = await ask(rl, "  Photon project id", a.imessage.photonProjectId || "");
      a.imessage.photonSecret = await ask(rl, "  Photon project secret", a.imessage.photonSecret || "", { secret: true });
      a.imessage.ownerHandles = await ask(rl, "  你的 iMessage 号（手机号 / Apple ID，逗号分隔）", a.imessage.ownerHandles || "");
    }
    if (a.channels.includes("wechat")) {
      a.wechat = a.wechat || {};
      console.log("  微信：读库收、点屏幕发。密钥文件要你自己准备好（格式见 docs/INSTALL.md），这里只问放在哪。自动发送有封号风险。");
      a.wechat.dataDir = await ask(rl, "  微信数据目录（xwechat_files/<wxid>）", a.wechat.dataDir || "");
      a.wechat.keysFile = await ask(rl, "  库密钥文件（all_keys.json）", a.wechat.keysFile || "");
      a.wechat.imageKeyFile = await ask(rl, "  图片 key 文件（image_key.txt）", a.wechat.imageKeyFile || "");
      a.wechat.ownerWxid = await ask(rl, "  你的 wxid", a.wechat.ownerWxid || "");
      a.wechat.target = await ask(rl, "  他给你发消息时点哪个聊天窗（窗口标题 = 你在他那边的备注名）", a.wechat.target || "");
      a.wechat.display = await ask(rl, "  微信跑在哪个 X 屏（Xvfb 的 DISPLAY）", a.wechat.display || ":98");
    }
    a.heart = /^y/i.test(await ask(rl, "要不要他隔一阵主动找你（心跳 check-in，y/n）", a.heart ? "y" : "n"));
    console.log("\n下面几样能力都可选，直接回车 = 先关着（以后改 env 文件 + 把 key 放进 ~/.secrets 就能开）。");
    a.transcribe = a.transcribe || {};
    a.transcribe.apiKey = await ask(rl, "语音转文字：OpenAI 兼容转写接口的 key", a.transcribe.apiKey || "", { secret: true });
    if (a.transcribe.apiKey) {
      a.transcribe.baseUrl = await ask(rl, "  base_url", a.transcribe.baseUrl || "https://api.openai.com/v1");
      a.transcribe.model = await ask(rl, "  模型", a.transcribe.model || "whisper-1");
    }
    a.transcribe.local = /^y/i.test(await ask(rl, "  本机装了 whisper（pip install openai-whisper）要拿它兜底吗（y/n）", a.transcribe.local ? "y" : "n"));
    a.tts = a.tts || {};
    a.tts.apiKey = await ask(rl, "语音合成：ElevenLabs key", a.tts.apiKey || "", { secret: true });
    if (a.tts.apiKey) a.tts.voiceId = await ask(rl, "  voice id（ElevenLabs 里选好的音色）", a.tts.voiceId || "");
    a.image = a.image || {};
    a.image.apiKey = await ask(rl, "画图：OpenAI 图像接口或 Replicate（r8_ 开头）的 key", a.image.apiKey || "", { secret: true });
    a.acoustic = a.acoustic || {};
    a.acoustic.enabled = /^y/i.test(await ask(rl, "听语气（north-ear，要本机另装，见 docs/INSTALL.md）开吗（y/n）", a.acoustic.enabled ? "y" : "n"));
  } finally { rl.close(); }
  return a;
}

function nextSteps(info, a) {
  const S = [];
  S.push("", `建好了：${a.agentName}（${a.id}）`, `  角色目录 ${info.gateRoot}`, `  数据目录 ${info.stateDir}`, `  工作目录 ${info.workspace}`, "");
  const on = (x) => (x ? "开" : "关");
  S.push("能力：", `  语音转文字 ${on(a.transcribe.apiKey || a.transcribe.local)}${a.transcribe.apiKey ? "（接口）" : ""}${a.transcribe.local ? "（本地 whisper）" : ""}`,
    `  语音合成 ${on(a.tts.apiKey)}   画图 ${on(a.image.apiKey)}   听语气 ${on(a.acoustic.enabled)}`,
    `  看图 ${a.engine === "deepseek" ? "关 —— DeepSeek 看不了图，她发的图他只会收到「看不了」的说明" : "开（引擎自己看）"}`, "");
  S.push("接下来：");
  if (a.engine === "claude-cli") S.push("  1. 确认 claude 登录的是订阅：claude /login（桥只许走订阅，API key 会当场停）");
  if (a.engine === "codex") S.push(`  1. 登录 codex（ChatGPT 订阅）：CODEX_HOME=${a.codexHome} codex login`);
  if (a.engine === "deepseek") S.push(`  1. 钥匙放好：~/.secrets/${a.id}-deepseek.secret（600）`);
  S.push(`  2. 体检：node ${path.join(REPO_ROOT, "scripts/im-bridge.js")} doctor ${a.id}`);
  S.push(`  3. 写人格：${path.join(info.workspace, a.agentName + ".md")}（可选，空模板也能跑）`);
  S.push(`  4. 起：pm2 start ${path.join(info.gateRoot, "ecosystem.config.cjs")} && pm2 save`);
  S.push(`  5. 在 Telegram 上给 bot 发一句话。看日志：pm2 logs ${a.id}-gate`);
  return S.join("\n");
}

async function main(argv = process.argv.slice(2)) {
  const { flags, positional } = parseArgs(argv);
  let a = {};
  if (flags.answers) a = JSON.parse(fs.readFileSync(String(flags.answers), "utf8"));
  if (positional[0]) a.id = positional[0];
  for (const [flag, key] of Object.entries(FLAG_MAP)) if (flags[flag] !== undefined) a[key] = flags[flag];
  const nonInteractive = Boolean(flags.answers || flags.yes) || !process.stdin.isTTY;
  if (!nonInteractive) a = await interactive(a);
  const { answers, errors } = normalizeAnswers(a);
  if (errors.length) {
    console.error("填的不对，一个都没写：\n  - " + errors.join("\n  - "));
    return 2;
  }
  const plan = planRole(answers);
  let res;
  try { res = writeRole(plan); }
  catch (e) { console.error(e.message); return 1; }
  for (const f of res.written) console.log("  写了 " + f);
  for (const f of res.kept) console.log("  已有，没动 " + f);
  console.log(nextSteps(plan.info, answers));
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
}

module.exports = { normalizeAnswers, expandHome, planRole, writeRole, main, parseArgs, ENGINES, EXTERNAL_TOOLS };
