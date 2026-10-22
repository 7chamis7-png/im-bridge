#!/usr/bin/env node
"use strict";

/**
 * 体检（2026-10-21「拉下来就能用」）—— 逐条打勾 / 打叉，打叉的说怎么修。**只读**：不起进程、不动 pm2、不写文件。
 *
 *   node scripts/im-bridge.js doctor <角色id>        读 ~/.<id>-gate/<id>-env.sh（没有就读那个目录里唯一的 *-env.sh）
 *   node scripts/im-bridge.js doctor --env <文件>    指定 env 文件
 *   node scripts/im-bridge.js doctor                 用当前 shell 的环境（已经 source 过 env 文件时）
 *   --offline                                        不联网（跳过 TG getMe）
 *
 * 记号：✓ 好的   ✗ 坏的（会起不来 / 收不到）   ○ 关着（没配，不是错）   ! 能跑但要留心
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const { parseArgs } = require("./init");

function findEnvFile(id, home = os.homedir()) {
  const dir = path.join(home, `.${id}-gate`);
  const exact = path.join(dir, `${id}-env.sh`);
  if (fs.existsSync(exact)) return exact;
  let list = [];
  try { list = fs.readdirSync(dir).filter((f) => /-env\.sh$/.test(f)); } catch { /* 没这个目录 */ }
  return list.length === 1 ? path.join(dir, list[0]) : "";
}

/** 在干净的 bash 里 source env 文件，把结果读回来（跟 run-*.sh 看到的一样）。 */
function loadEnvFile(file) {
  const out = execFileSync("bash", ["-c", 'set -a; . "$1" >/dev/null 2>&1; env -0', "doctor", file],
    { env: { HOME: os.homedir(), PATH: process.env.PATH || "/usr/bin:/bin" }, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const env = {};
  for (const kv of out.split("\0")) {
    const i = kv.indexOf("=");
    if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return env;
}

function which(cmd, envPath) {
  if (path.isAbsolute(cmd)) { try { fs.accessSync(cmd, fs.constants.X_OK); return cmd; } catch { return ""; } }
  for (const dir of String(envPath || "").split(":")) {
    if (!dir) continue;
    const f = path.join(dir, cmd);
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* 下一个 */ }
  }
  return "";
}

function tryRun(cmd, args, env) {
  try { return { ok: true, out: execFileSync(cmd, args, { env, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }).trim() }; }
  catch (e) { return { ok: false, out: String((e.stderr || e.message || "")).trim().split("\n")[0] }; }
}


async function runChecks(env, { offline = false, envFile = "" } = {}) {
  const rows = [];
  const ok = (what, extra = "") => rows.push({ mark: "✓", what, extra });
  const bad = (what, fix) => rows.push({ mark: "✗", what, fix });
  const off = (what, how = "") => rows.push({ mark: "○", what, fix: how });
  const warn = (what, fix = "") => rows.push({ mark: "!", what, fix });
  const section = (t) => rows.push({ section: t });
  const home = env.HOME || os.homedir();
  const str = (k) => String(env[k] || "").trim();

  section("基础");
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 22) ok(`node ${process.versions.node}`);
  else bad(`node ${process.versions.node} 太旧`, "装 node 22 或更新（nvm install 22）");
  try { require.resolve("@anthropic-ai/claude-agent-sdk", { paths: [REPO_ROOT] }); ok("依赖装好了（npm install）"); }
  catch { bad("依赖没装", `cd ${REPO_ROOT} && npm install`); }
  if (envFile) ok(`env 文件 ${envFile}`);
  if (which("pm2", env.PATH || process.env.PATH)) ok("pm2 在");
  else warn("没装 pm2（不用 pm2 也能手动跑 run-*.sh）", "npm install -g pm2");

  section("配置");
  const root = str("GATE_ROOT");
  if (!root) { bad("没有 GATE_ROOT", "先 init 一个角色，或 source 它的 env 文件再跑 doctor"); return rows; }
  if (fs.existsSync(root)) ok(`GATE_ROOT ${root}`); else bad(`GATE_ROOT ${root} 不存在`, `mkdir -p ${root}`);
  const flag = str("GATE_ENABLED_FILE") || path.join(root, ".gate-enabled");
  if (fs.existsSync(flag)) ok(`总开关开着（${flag}）`);
  else bad(`总开关关着：${flag} 不在 —— 桥起来了也不接消息`, `touch ${flag}`);
  for (const [k, why] of [["GATE_BINDING_KEY", "接哪条会话"], ["GATE_WORKSPACE_ROOT", "工作目录"], ["GATE_PREFERRED_CHAT_ID", "他主动说话发去哪"]]) {
    if (!str(k)) bad(`缺 ${k}（${why}）`, `在 env 文件里补上 ${k}=…`);
  }
  const ws = str("GATE_WORKSPACE_ROOT");
  if (ws) { if (fs.existsSync(ws)) ok(`工作目录 ${ws}`); else bad(`工作目录 ${ws} 不存在`, `mkdir -p ${ws}`); }
  const sp = str("GATE_SYSTEM_PROMPT_FILE");
  if (sp) { if (fs.existsSync(sp)) ok(`宣言 ${sp}`); else bad(`宣言文件 ${sp} 不存在`, "写一份，或把 GATE_SYSTEM_PROMPT_FILE 那行删掉"); }
  const toolsFile = str("GATE_TOOLS_CONFIG") || path.join(root, "tools.json");
  let tools = null;
  if (fs.existsSync(toolsFile)) {
    try {
      tools = JSON.parse(fs.readFileSync(toolsFile, "utf8"));
      ok(`tools.json ${toolsFile}`);
      if (tools.personaFile) {
        if (fs.existsSync(tools.personaFile)) ok(`人格文件 ${tools.personaFile}`);
        else bad(`人格文件 ${tools.personaFile} 不存在 —— cli 会拒绝起引擎`, "写一份（哪怕先空着标题），或改 tools.json 的 personaFile");
      }
      for (const [name, f] of Object.entries(tools.secretFiles || {})) {
        if (!fs.existsSync(f)) bad(`tools.json 要的钥匙 ${name} 不在 ${f}`, `把 key 写进去（chmod 600）`);
      }
    } catch (e) { bad(`tools.json 不是合法 JSON：${e.message}`, `修好 ${toolsFile}`); }
  } else warn(`没有 tools.json（${toolsFile}）：他只有桥自己那包嘴，没有别的工具`, "从 examples/tools/ 拷一份，或重新 init");

  const { loadModelRegistry, normalizeEngine } = require(path.join(REPO_ROOT, "src/box/model-registry"));
  const reg = loadModelRegistry({ env });
  let model = null;
  if (!reg.exists) warn(`没有 models.json：/model /engine 没有按钮，模型靠 GATE_MODEL`, `cp ${path.join(REPO_ROOT, "examples/init/models.example.json")} ${path.join(root, "models.json")}`);
  else if (!reg.ok || reg.errors.length) bad(`models.json 有问题：${reg.errors.join("；")}`, `修 ${reg.file}`);
  else {
    const want = str("GATE_MODEL") || reg.default;
    model = reg.models.find((m) => m.id === want) || null;
    if (model) ok(`models.json：默认 ${model.id}（${model.engine}）`);
    else bad(`models.json 里找不到默认模型「${want}」`, "改 default，或把 GATE_MODEL 清空");
  }
  const engine = (model && model.engine) || normalizeEngine(str("GATE_ENGINE")) || "claude-cli";

  section(`引擎（${engine}）`);
  if (engine === "claude-cli") {
    const cmd = which(str("GATE_CLAUDE_COMMAND") || "claude", env.PATH);
    if (!cmd) bad("找不到 claude", "npm install -g @anthropic-ai/claude-code（装完确认在 env 文件的 PATH 里）");
    else {
      const v = tryRun(cmd, ["--version"], env);
      if (v.ok) ok(`claude ${v.out.split(" ")[0]}（${cmd}）`); else bad(`claude 跑不起来：${v.out}`, "重装 claude");
    }
    const cred = path.join(str("CLAUDE_CONFIG_DIR") || path.join(home, ".claude"), ".credentials.json");
    if (fs.existsSync(cred) || str("CLAUDE_CODE_OAUTH_TOKEN")) ok("claude 登录态在（订阅；不是订阅的话起 CLI 时会当场停）");
    else bad("claude 没登录", "claude 然后 /login（用订阅账号；桥拒绝 API key 计费）");
    if (str("ANTHROPIC_API_KEY")) warn("env 里有 ANTHROPIC_API_KEY —— CLI 可能走按量计费，桥见了会当场停", "从 env 文件里删掉它");
  } else if (engine === "codex-appserver") {
    const cmd = which(str("CODEX_COMMAND") || str("GATE_CODEX_COMMAND") || "codex", env.PATH);
    if (!cmd) bad("找不到 codex", "npm install -g @openai/codex");
    else {
      const { codexVersionGuard } = require(path.join(REPO_ROOT, "cli-host/codex-runtime"));
      const g = codexVersionGuard({ codexPath: cmd, env });
      if (g.ok) ok(`${g.reason}（${cmd}）`);
      else warn(`codex 版本闸：${g.reason}（换舱垫历史会被拒）`, "装白名单里的版本，或验过之后加进 CODEX_VERSION_ALLOW");
    }
    const authFile = str("CODEX_AUTH_FILE") || path.join(str("CODEX_HOME") || path.join(home, ".codex"), "auth.json");
    try {
      require(path.join(REPO_ROOT, "cli-host/codex-runtime")).assertSubscription(authFile);
      ok(`codex 登录态是 ChatGPT 订阅（${authFile}）`);
    } catch (e) { bad(e.message.replace(/Iris/g, "他"), `${str("CODEX_HOME") ? "CODEX_HOME=" + str("CODEX_HOME") + " " : ""}codex login（用 ChatGPT 账号，不用 API key）`); }
  } else if (engine === "openai-chat") {
    const secret = (model && model.secret) || str("DEEPSEEK_SECRET") || "deepseek";
    const { readSecret } = require(path.join(REPO_ROOT, "cli-host/engines"));
    const dir = str("IM_BRIDGE_SECRETS_DIR") || path.join(home, ".secrets");
    try { readSecret(secret, { dir }); ok(`钥匙 ${path.join(dir, secret + ".secret")}`); }
    catch (e) { bad(e.message, `echo '<key>' > ${path.join(dir, secret + ".secret")} && chmod 600 ${path.join(dir, secret + ".secret")}`); }
    if (model && model.billing === "api" && !/^(1|true|on|yes)$/i.test(str(model.requiresAllow))) {
      bad(`${model.id} 按量计费，钱闸 ${model.requiresAllow} 没开 —— 起不来`, `env 文件里加 ${model.requiresAllow}=1`);
    }
  }

  section("socket");
  const sockets = [["box.sock（gate → box）", str("GATE_BOX_SOCKET") || path.join(root, "box.sock")],
    ["cli.sock（box → cli）", str("NOVA_CLI_SOCKET") || path.join(root, "cli.sock")]];
  for (const [label, file] of sockets) {
    if (Buffer.byteLength(file) > 103) { bad(`${label} 路径太长（${Buffer.byteLength(file)} 字节，unix socket 上限 ~104）`, "把 GATE_ROOT 挪到短一点的路径"); continue; }
    if (!fs.existsSync(path.dirname(file))) { bad(`${label} 的目录不在：${path.dirname(file)}`, `mkdir -p ${path.dirname(file)}`); continue; }
    // ⚠️ 只看文件，**绝不去连**：cli.sock 上盒子是唯一的连接，旁边再连一次会把盒子踢掉
    let st = null;
    try { st = fs.statSync(file); } catch { /* 不在 */ }
    if (!st) ok(`${label} ${file}（还没起）`);
    else if (st.isSocket()) ok(`${label} ${file}（socket 文件在，进程大概在跑）`);
    else bad(`${label} ${file} 是个普通文件，不是 socket`, "看看是谁写的，挪走它");
  }

  section("Telegram");
  const token = str("GATE_TELEGRAM_TOKEN");
  if (!token) bad("没有 GATE_TELEGRAM_TOKEN", "把 bot token 写进 env 文件指的 ~/.secrets/<id>-telegram.secret");
  else if (offline) off("TG token 在（--offline，没去 getMe）");
  else {
    const base = str("GATE_TELEGRAM_API_BASE").replace(/\/+$/, "") || "https://api.telegram.org";
    try {
      const res = await fetch(`${base}/bot${token}/getMe`, { signal: AbortSignal.timeout(10_000) });
      const j = await res.json().catch(() => ({}));
      if (j && j.ok) ok(`TG token 能用：@${j.result.username}`);
      else bad(`TG getMe 被拒：${(j && j.description) || res.status}`, "token 抄错了 / 被 revoke 了 —— 找 @BotFather 重新拿");
    } catch (e) { bad(`TG getMe 连不上：${e.message}`, "这台机器连不上 api.telegram.org？要代理就设 GATE_TELEGRAM_API_BASE 或 HTTPS_PROXY"); }
  }
  if (/^-?\d+$/.test(str("GATE_OWNER_TELEGRAM_ID"))) ok(`主人的 TG id ${str("GATE_OWNER_TELEGRAM_ID")}`);
  else bad("GATE_OWNER_TELEGRAM_ID 没填或不是数字 —— 她的消息会被当成陌生人挡掉", "问 @userinfobot 拿数字 id");

  if (str("GATE_IMESSAGE_INBOX_DIR") || str("GATE_IMESSAGE_SOCKET")) {
    section("iMessage");
    for (const k of ["GATE_IMESSAGE_INBOX_DIR", "GATE_IMESSAGE_SOCKET", "GATE_OWNER_IMESSAGE_ID", "PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET"]) {
      if (str(k)) ok(`${k} 在`); else bad(`缺 ${k}`, "补进 env 文件（钥匙写 ~/.secrets）");
    }
  }

  if (str("GATE_WECHAT_KEYS_FILE")) checkWechat(env, { ok, bad, warn, off, section });

  section("共用能力");
  // 语音转文字
  const pyCmd = str("NOVA_TRANSCRIPTION_PYTHON") || "python3";
  const localOn = String(env.NOVA_TRANSCRIPTION_LOCAL || "true").toLowerCase() !== "false";
  if (str("GATE_TRANSCRIBE").toLowerCase() === "off") off("语音转文字：关着（她发语音，他会看到「转写没接上」）", "配 key：NOVA_TRANSCRIPTION_API_KEY / BASE_URL / MODEL，或装本地 whisper，再删掉 GATE_TRANSCRIBE=off");
  else {
    const key = str("NOVA_TRANSCRIPTION_API_KEY") || str("OPENAI_API_KEY");
    if (key) ok(`语音转文字：接口 ${str("NOVA_TRANSCRIPTION_BASE_URL") || "https://api.openai.com/v1"} · ${str("NOVA_TRANSCRIPTION_MODEL") || "whisper-1"}`);
    if (localOn) {
      const m = str("NOVA_TRANSCRIPTION_LOCAL_MODEL") || "small";
      const r = tryRun(pyCmd, ["-c", "import whisper"], env);
      const pt = path.join(home, ".cache", "whisper", `${m}.pt`);
      if (!r.ok) (key ? warn : bad)(`本地 whisper 兜底：${pyCmd} 里没有 whisper 模块`, `pip install openai-whisper（或 env 里写 NOVA_TRANSCRIPTION_LOCAL=false 关掉兜底）`);
      else if (!fs.existsSync(pt)) warn(`本地 whisper：模块在，模型 ${pt} 还没下（第一次转写会现下，慢）`, `${pyCmd} -c "import whisper; whisper.load_model('${m}')"`);
      else ok(`本地 whisper 兜底：${m}.pt 在`);
    } else if (!key) bad("语音转文字：没 key 也没开本地 whisper，但也没关 —— 每条语音都会报转写失败", "配 key，或 env 里写 GATE_TRANSCRIBE=off");
    else off("本地 whisper 兜底：关着（NOVA_TRANSCRIPTION_LOCAL=false）");
  }
  // 语音合成
  if (str("ELEVENLABS_API_KEY")) {
    if (str("ELEVENLABS_DEFAULT_VOICE_ID")) ok(`语音合成：ElevenLabs · voice ${str("ELEVENLABS_DEFAULT_VOICE_ID")}`);
    else warn("语音合成：有 key 没 voice id —— 会用代码里默认的那个音色（不是你的）", "env 里写 ELEVENLABS_DEFAULT_VOICE_ID=…");
  } else off("语音合成：关着（他发语音会被明确挡下）", "ElevenLabs key 写进 ~/.secrets，env 里 ELEVENLABS_API_KEY=\"$(cat …)\" + ELEVENLABS_DEFAULT_VOICE_ID");
  // 画图
  const img = str("NOVA_IMAGE_API_KEY") || str("OPENAI_API_KEY");
  if (img) ok(`画图：${img.startsWith("r8_") ? "Replicate" : "OpenAI 图像接口"}${str("NOVA_IMAGE_MODEL") ? " · " + str("NOVA_IMAGE_MODEL") : ""}`);
  else off("画图：关着（generate_image 不注册）", "OpenAI / Replicate（r8_…）key 写进 ~/.secrets，env 里 NOVA_IMAGE_API_KEY=\"$(cat …)\"");
  // 看图
  if (model) {
    if (model.vision) ok(`看图：${model.id} 自己看`);
    else off(`看图：${model.id} 看不了图（她发的图他只会收到「看不了」的说明）`, "要看图就换一个 vision:true 的模型（/model 或 /engine）");
  }
  // 听语气
  if (str("GATE_ACOUSTIC").toLowerCase() === "off") off("听语气（north-ear）：关着", "见 docs/INSTALL.md「听语气」一节");
  else {
    const py = str("NORTH_EAR_PYTHON") || path.join(home, "north-ear", "venv", "bin", "python");
    const sc = str("NORTH_EAR_SCRIPT") || path.join(home, "north-ear", "north_ear.py");
    if (fs.existsSync(py) && fs.existsSync(sc)) ok(`听语气：north-ear 在（${sc}）`);
    else warn(`听语气：开着但 north-ear 不在（${fs.existsSync(sc) ? py : sc}）—— 只是静默少一行，不影响转写`, "装好 north-ear，或 env 里写 GATE_ACOUSTIC=off");
  }
  return rows;
}

/**
 * 微信腿。**只读**：不碰微信窗口、不扫无障碍树（扫树会让微信黑屏，2026-09 栽过）、不连任何 socket。
 * 解库用 sqlcipher -readonly 读一个库的表数。
 */
function checkWechat(env, { ok, bad, warn, off, section }) {
  section("微信");
  const str = (k) => String(env[k] || "").trim();
  const P = env.PATH || process.env.PATH;
  for (const [cmd, why] of [["python3", "读库脚本"], ["sqlcipher", "解库"], ["zstd", "长消息解压"], ["ffmpeg", "语音 / 图片转码"], ["xdotool", "点窗口"], ["xclip", "剪贴板贴字"], ["flock", "发送锁"]]) {
    if (which(cmd, P)) ok(`${cmd}（${why}）`);
    else bad(`缺 ${cmd}（${why}）`, `apt install ${cmd === "flock" ? "util-linux" : cmd}`);
  }
  if (str("GATE_WECHAT_SENDER_MODE").toLowerCase() === "rpc") warn("GATE_WECHAT_SENDER_MODE=rpc：注入式发送，封号风险高", "改回 a11y");
  const keysFile = str("GATE_WECHAT_KEYS_FILE");
  let keys = null;
  try { keys = JSON.parse(fs.readFileSync(keysFile, "utf8")); }
  catch (e) { bad(`库密钥文件读不了：${keysFile}（${e.code || e.message}）`, "放好你自己的 all_keys.json（格式见 docs/INSTALL.md「微信」）"); }
  if (keys) {
    const mode = fs.statSync(keysFile).mode & 0o777;
    if (mode & 0o077) warn(`库密钥文件权限 ${mode.toString(8)}，别人也能读`, `chmod 600 ${keysFile}`);
    const dbDir = String(keys._db_dir || "");
    const n = Object.keys(keys).filter((k) => !k.startsWith("_") && keys[k] && keys[k].enc_key).length;
    if (!dbDir) bad("库密钥文件里没有 _db_dir", "补上 _db_dir（xwechat_files/<wxid>/db_storage 的绝对路径）");
    else if (!fs.existsSync(dbDir)) bad(`_db_dir 不存在：${dbDir}`, "微信没登录过 / 数据目录挪了？改 all_keys.json 的 _db_dir");
    else {
      ok(`库密钥文件：${n} 个库，_db_dir ${dbDir}`);
      const dataDir = str("GATE_WECHAT_DATA_DIR");
      if (dataDir && !path.resolve(dbDir).startsWith(path.resolve(dataDir))) warn(`_db_dir 不在 GATE_WECHAT_DATA_DIR（${dataDir}）底下 —— 是不是密钥对应的是另一个号`);
      const rel = ["contact/contact.db", "message/message_0.db"].find((r) => keys[r] && keys[r].enc_key && fs.existsSync(path.join(dbDir, r)));
      if (!rel) bad("找不到能试解的库（contact/contact.db、message/message_0.db 都没有）", "确认微信登录过、数据目录对");
      else if (which("sqlcipher", P)) {
        const script = `PRAGMA key = "x'${keys[rel].enc_key}'";\nPRAGMA cipher_compatibility = 4;\nSELECT count(*) FROM sqlite_master;\n`;
        let out = "", err = "";
        try { out = execFileSync("sqlcipher", ["-readonly", "-batch", path.join(dbDir, rel)], { input: script, encoding: "utf8", timeout: 15_000, stdio: ["pipe", "pipe", "pipe"] }); }
        catch (e) { err = String(e.stderr || e.message).trim().split("\n").pop(); }
        const cnt = Number(String(out).split("\n").filter((l) => /^\d+$/.test(l.trim())).pop());
        if (!err && cnt > 0) ok(`试解 ${rel}（只读）：${cnt} 张表`);
        else bad(`试解 ${rel} 失败：${err || "读出来是空的"} —— 密钥不对（换号 / 重装过微信要重新拿）`, "换一份对得上的 all_keys.json");
      }
    }
  }
  const img = str("GATE_WECHAT_IMAGE_KEY_FILE");
  if (img && fs.existsSync(img) && fs.readFileSync(img, "utf8").trim()) ok(`图片 key ${img}`);
  else warn(`图片 key 读不到（${img || "没配"}）—— 图片和语音只会是标签`, "放好 image_key.txt");
  const wl = str("GATE_WECHAT_WHITELIST_FILE");
  const wlLines = wl && fs.existsSync(wl) ? fs.readFileSync(wl, "utf8").split("\n").filter((l) => l.trim()).length : 0;
  if (wlLines) ok(`白名单 ${wl}（${wlLines} 个人）`);
  else bad(`白名单是空的 / 不在（${wl || "没配"}）—— 谁的消息都不收`, `echo '<她的 wxid>' > ${wl || "<白名单文件>"}`);
  for (const k of ["GATE_WECHAT_TARGET", "GATE_OWNER_WECHAT_ID", "GATE_WECHAT_SENDER", "GATE_WECHAT_SEND_LOCK"]) {
    if (!str(k)) bad(`缺 ${k}`, "补进 env 文件");
  }
  const sender = str("GATE_WECHAT_SENDER");
  if (sender && !fs.existsSync(sender)) bad(`发送脚本不在：${sender}`, `指到 ${path.join(REPO_ROOT, "src/gate/plugins/wechat/linux-wx-send-a11y.py")}`);
  // X 屏：只看 Xvfb 的 socket 在不在（不连、不截图）
  const disp = str("GATE_WECHAT_DISPLAY") || str("LINUX_WX_DISPLAY") || ":98";
  const m = /^:(\d+)/.exec(disp);
  const xsock = m ? `/tmp/.X11-unix/X${m[1]}` : "";
  if (xsock && fs.existsSync(xsock)) ok(`X 屏 ${disp} 在（${xsock}）`);
  else bad(`X 屏 ${disp} 不在（${xsock || "DISPLAY 认不出"}）—— 点不到微信窗口`, `Xvfb ${disp} -screen 0 1280x800x24 &（再在这个屏上起微信）`);
  // 无障碍：只看模块和会话总线在不在，**不扫树**
  const py = str("GATE_WECHAT_PYTHON") || "python3";
  const at = tryRun(py, ["-c", "import pyatspi"], env);
  if (at.ok) ok("AT-SPI（pyatspi）能导入");
  else bad(`AT-SPI 用不了：${at.out}`, "apt install python3-pyatspi at-spi2-core");
  const xdg = str("XDG_RUNTIME_DIR") || `/run/user/${process.getuid()}`;
  const bus = (str("DBUS_SESSION_BUS_ADDRESS").match(/unix:path=([^,;]+)/) || [])[1] || path.join(xdg, "bus");
  if (fs.existsSync(bus)) ok(`会话总线 ${bus} 在（没去扫无障碍树 —— 扫树会让微信黑屏）`);
  else bad(`会话总线 ${bus} 不在 —— 无障碍找不到微信`, "微信要在有 dbus 会话的环境里起（dbus-run-session / systemd --user），见 docs/INSTALL.md「微信」");
}

function render(rows) {
  const L = [];
  for (const r of rows) {
    if (r.section) { L.push("", `【${r.section}】`); continue; }
    L.push(`  ${r.mark} ${r.what}${r.extra ? "  " + r.extra : ""}`);
    if (r.fix && r.mark !== "✓") L.push(`      怎么${r.mark === "○" ? "开" : "修"}：${r.fix}`);
  }
  const n = (m) => rows.filter((r) => r.mark === m).length;
  L.push("", `✓ ${n("✓")}   ✗ ${n("✗")}   ! ${n("!")}   ○ ${n("○")}（关着的不算错）`);
  return L.join("\n");
}

async function main(argv = process.argv.slice(2)) {
  const { flags, positional } = parseArgs(argv);
  let envFile = flags.env ? String(flags.env) : "";
  if (!envFile && positional[0]) {
    envFile = findEnvFile(positional[0]);
    if (!envFile) { console.error(`找不到角色 ${positional[0]} 的 env 文件（~/.${positional[0]}-gate/${positional[0]}-env.sh）。用 --env 指一下。`); return 2; }
  }
  const env = envFile ? loadEnvFile(envFile) : { ...process.env };
  const rows = await runChecks(env, { offline: Boolean(flags.offline), envFile });
  console.log(render(rows));
  return rows.some((r) => r.mark === "✗") ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
}

module.exports = { runChecks, render, loadEnvFile, findEnvFile, main };
