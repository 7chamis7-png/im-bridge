# 安装：新机器从零到跑起来

> 2026-10-21。目标：`git clone` → `npm install` → `init` → 回答几个问题 → 角色能跑。
> 一个「角色」= 一套人格 + 一个 TG bot + 一组进程（`<id>-cli` / `<id>-box` / `<id>-gate`）。同一台机器可以跑好几个角色，互不相干。

## 0. 要先有的东西

| 什么 | 为什么 | 怎么装 |
|---|---|---|
| Linux（Debian / Ubuntu 测过） | 进程之间走 unix socket | — |
| Node.js ≥ 22 | 桥本身 | `nvm install 22` |
| pm2（建议） | 守护进程、开机自启 | `npm install -g pm2` |
| 引擎三选一 | 他用哪家的脑子 | 见下表 |
| 一个 Telegram bot | 必选渠道 | 找 @BotFather 要 token；你自己的数字 id 问 @userinfobot |

| 引擎 | 要什么 | 计费 |
|---|---|---|
| `claude-cli` | `npm install -g @anthropic-ai/claude-code`，然后 `claude` → `/login` 用**订阅**账号 | 订阅。桥见到 API key 计费会当场停 |
| `codex` | `npm install -g @openai/codex`，然后 `CODEX_HOME=… codex login` 用 **ChatGPT** 账号 | 订阅。auth.json 是 API key 会拒绝起 |
| `deepseek` | DeepSeek API key | **按量**。init 选了它 = 明确同意（env 里写 `DEEPSEEK_ALLOW_BILLING=1`）。**看不了图** |

## 1. 五步跑起来

```bash
git clone <仓库地址> im-bridge && cd im-bridge
npm install
node scripts/im-bridge.js init          # 交互问；也可以 npm run init
node scripts/im-bridge.js doctor <id>   # 逐条体检，✗ 的照「怎么修」修
pm2 start ~/.<id>-gate/ecosystem.config.cjs && pm2 save
```

然后在 Telegram 上给 bot 发一句话。看日志：`pm2 logs <id>-gate`。

init 问的东西：

1. 角色 id（英文小写，当 pm2 前缀和目录名，比如 `ah7`）
2. 他叫什么、你叫什么、提到你用哪个字（她 / 他 / TA）
3. TG bot token、你的 TG 数字 id（必填）
4. 引擎（claude-cli / codex / deepseek）
5. 渠道：telegram 必选；可加 `imessage`、`wechat`
6. 要不要心跳（他隔一阵主动找你）
7. 四样可选能力（见第 3 节），直接回车 = 先关着

### 不想一问一答

```bash
node scripts/im-bridge.js init --answers answers.json
# 或者
node scripts/im-bridge.js init ah7 --agent-name 阿七 --owner-name 小A \
  --telegram-token 123456:ABC… --owner-telegram-id 424242 --engine claude-cli --yes
```

`answers.json` 长这样（只有前五个必填）：

```json
{
  "id": "ah7", "agentName": "阿七", "ownerName": "小A",
  "telegramToken": "123456:ABC…", "ownerTelegramId": "424242",
  "ownerPronoun": "她", "engine": "claude-cli", "channels": ["telegram"], "heart": false,
  "transcribe": { "apiKey": "", "baseUrl": "https://api.openai.com/v1", "model": "whisper-1", "local": false },
  "tts": { "apiKey": "", "voiceId": "" },
  "image": { "apiKey": "", "model": "" },
  "acoustic": { "enabled": false },
  "imessage": { "photonProjectId": "", "photonSecret": "", "ownerHandles": "+86…,me@icloud.com" },
  "wechat": { "dataDir": "", "keysFile": "", "imageKeyFile": "", "ownerWxid": "", "target": "", "display": ":98" },
  "deepseekKey": "", "codexHome": "~/.codex"
}
```

路径里的 `~` / `~/…`（`codexHome`、微信的 `keysFile` / `imageKeyFile` / `dataDir`、听语气的 `python` / `script`）init 会展开成绝对路径再写进 env —— env 文件是单引号写的，shell 不会替你展开。

## 2. init 生成了什么

**已存在的角色目录（`~/.<id>-gate`）init 绝不覆盖**，直接拒；数据目录 / 工作目录 / 钥匙里已有的文件跳过不动。

| 位置 | 是什么 | 里面 |
|---|---|---|
| `~/.<id>-gate/` | 桥的目录（`GATE_ROOT`） | `<id>-env.sh`（唯一一份配置）、`run-cli/box/gate.sh`、`tools.json`、`models.json`、`ecosystem.config.cjs`、`.gate-enabled`（总开关：删掉 = 暂停接收）；之后跑起来的账本 / 冷层 / socket 也在这 |
| `~/.<id>/` | 他的数据（`NOVA_STATE_DIR` / `GATE_MEMORY_DIR`） | `memory.md`、`operations.md`、`channels/`、`skills/`；他的工具写的东西 |
| `~/<id>/` | 工作目录 | `system-prompt.md`（宣言，进系统提示最前面）、`<名字>.md`（人格文件，`tools.json` 的 `personaFile`） |
| `~/.secrets/<id>-*.secret` | 钥匙，一把一个文件，600 | env 文件里只写 `"$(cat …)"`，**不写明文** |

`run-*.sh` 用 `env -i` 的干净环境起，不继承你 shell 里的变量（别的角色的 `GATE_*` 会让它挂错腿、拿错 token）。

进程分工（改什么重启谁）：

| 进程 | 管什么 | 重启会怎样 |
|---|---|---|
| `<id>-cli` | 引擎本人 | **打断他**（正在说的那句会断） |
| `<id>-box` | 会话 / 换舱 / 人格注入 / 模型 | 他没感觉 |
| `<id>-gate` | 渠道 / 路由 / 冷层 / 命令 / 工具 | 他没感觉 |

人格文件、宣言改了：下一次换舱或重启 `<id>-cli` 生效。`models.json`、`tools.json` 每次现读。

## 3. 共用能力（都可选）

不配的那项是**关着**，doctor 显示 `○`，不算错；他那头会被明确告知「没接」，不会假装做了。

| 能力 | 干什么 | 要什么 | 不配会怎样 | 怎么开（改 `<id>-env.sh`，钥匙放 `~/.secrets`） |
|---|---|---|---|---|
| 语音转文字 | 她发语音 → 他看到字 | OpenAI 兼容的 `/audio/transcriptions` 接口：key + base_url + 模型；**或**本地 whisper 兜底 | 他收到「[语音：转写没接上，音频已存在 …]」（`GATE_TRANSCRIBE=off`） | `NOVA_TRANSCRIPTION_API_KEY="$(cat ~/.secrets/<id>-transcribe.secret)"`、`NOVA_TRANSCRIPTION_BASE_URL`、`NOVA_TRANSCRIPTION_MODEL`，删掉 `GATE_TRANSCRIBE=off`。本地兜底：`pip install openai-whisper`，`NOVA_TRANSCRIPTION_LOCAL=true`（模型在 `~/.cache/whisper/<small>.pt`，第一次用会现下） |
| 语音合成 | 他发语音 | ElevenLabs key + voice id | 他调「发语音」会被明确挡下 | `ELEVENLABS_API_KEY="$(cat …)"`、`ELEVENLABS_DEFAULT_VOICE_ID=…`（**一定要填 voice id**，不填会用代码里别人的音色） |
| 画图 | 他出图 | OpenAI 图像接口 key，或 Replicate key（`r8_` 开头自动走 Replicate） | 画图工具不注册 | `NOVA_IMAGE_API_KEY="$(cat …)"`，可选 `NOVA_IMAGE_MODEL`；`tools.json` 的 `secretFiles` 里加 `"NOVA_IMAGE_API_KEY": "<文件>"`（他的出图工具也要） |
| 看图 | 她发的图他直接看 | 引擎自带：claude / codex 能看；**DeepSeek 看不了** | 图换成「[图片]」/「看不了图」的说明，不假装看过 | 换一个 `vision: true` 的模型（`/model`、`/engine`） |
| 听语气 | 语音里的音高 / 气声 / 呻吟感，附在转写后面一行 | 本机另装的 north-ear（**不在本仓库**）：一个 python venv + `north_ear.py`；可选喂给本机 `NOVA_PULSE_URL` 的身体层服务 | 少这一行，转写照常（`GATE_ACOUSTIC=off`） | 装好 north-ear，`NORTH_EAR_PYTHON=<venv>/bin/python`、`NORTH_EAR_SCRIPT=<…>/north_ear.py`，删掉 `GATE_ACOUSTIC=off`。它是尽力而为：脚本缺了 / 超时都静默跳过 |

改完 env 重启 `<id>-gate`（不打断他）。

## 4. 渠道

### Telegram（必选）

只要 token 和你的数字 id。连不上 `api.telegram.org` 的机器可以设 `GATE_TELEGRAM_API_BASE`（自建 Bot API server / 反代）。

### iMessage

走 Photon（Spectrum）。要 project id + secret（init 写进 `~/.secrets/<id>-photon-*.secret`），和你的 iMessage 号（手机号、Apple ID 邮箱**都要写**，逗号分隔 —— 只写一个，另一个来的消息会被当陌生人挡掉）。多一个进程 `<id>-imessage`。Spectrum 全机只能有一条连接，别让两个角色共用同一个 project。

### 微信（她自己的真实微信）

**收**：读微信本地数据库（只读，sqlcipher 解密）。**发**：AT-SPI 无障碍 + xdotool 在 Xvfb 里点微信窗口，像人一样打字发送。

要先准备好：

- Linux 版微信，跑在 Xvfb 上（比如 `Xvfb :98 -screen 0 1280x800x24`），在有 dbus 会话的环境里起（AT-SPI 要会话总线）
- `apt install sqlcipher zstd ffmpeg xdotool xclip python3-pyatspi at-spi2-core`
- **数据库密钥文件：需要你自己提供。** 怎么拿到不在本仓库的范围里，这里没有、也不会有读进程内存 / 扫密钥 / 注入的代码。格式：

  ```json
  {
    "_db_dir": "/home/you/xwechat_files/wxid_xxx/db_storage",
    "contact/contact.db":   { "enc_key": "<64 位 hex>" },
    "message/message_0.db": { "enc_key": "<64 位 hex>" },
    "message/media_0.db":   { "enc_key": "<64 位 hex>" },
    "hardlink/hardlink.db": { "enc_key": "<64 位 hex>" }
  }
  ```

  另一个文件 `image_key.txt`：图片 `.dat` 的解密 key，一行。两份都 `chmod 600`。
- 白名单（init 生成，`~/.<id>/wechat/whitelist`）：一行一个 wxid 或昵称，只收这里面的人。空的 = 谁都不收。

doctor 会试着用 `sqlcipher -readonly` 解开一个库数表，确认密钥对得上；它**不碰微信窗口、不扫无障碍树**（扫树会让微信黑屏）。

⚠️ **封号风险，开之前读完：**

- **只读相对安全**：读本地数据库不跟微信进程打交道。
- **自动发送有风险**：平台会看发送节奏。桥这边的开关：
  - `GATE_WECHAT_GAP_MIN_MS` / `GATE_WECHAT_GAP_MAX_MS`：一条回复拆成几段时，段间随机等多久（默认 1~3 秒）。**别调快**，同一秒连发几条是被风控盯上的特征之一。
  - `GATE_WECHAT_SENDER_MODE` 只用 `a11y`（点屏幕）。任何注入微信进程的发送方式风险高得多（有过触发安全处罚、限制登录新设备的实例）。
  - 总开关 `~/.<id>-gate/.gate-enabled`：删掉 = 立刻停收停发，不用重启。
- 被处罚期间别反复重启微信 / Xvfb，可能登不回来。

## 5. 从旧机器搬一个已有角色

原则：**按「不该搬什么」划，别按「该搬什么」列** —— 白名单一定漏。先停旧机器上这个角色的**全部**进程（两边同时跑 = 两边都在收同一个 bot 的消息、都在回）。

⚠️ **iMessage 全局只能有一条连接**（Photon / Spectrum 一个 project 一条）。两台机器的 `<id>-imessage` 同时跑会互相抢消息 —— 抢到的那边收、另一边漏，看着像「偶尔丢消息」。**搬家时旧机器的 imessage 进程必须先停**，再在新机器上起。

要拷的（路径按旧机器的，`<id>` 换成角色名；生产里Nova是 `.nova-gate` / `.nova` / `nova`）：

| 旧机器上 | 是什么 | 不拷会怎样 |
|---|---|---|
| `~/.<id>-gate/`（整个） | 配置、账本、冷层、游标、`state/sessions.json`（接哪条会话） | 他不记得在跟谁说话、游标回到零会重收旧消息 |
| `~/.<id>/`（整个） | 他的数据：记忆、笔记本、日记、贴纸本、技能 | 换舱时底子是空的 |
| `~/<id>/`（工作目录） | 宣言、人格文件 | cli 拒绝起引擎（找不到人格文件） |
| `~/.secrets/` 里这个角色用到的文件 | 钥匙 | 对应的能力 / 渠道起不来 |
| `~/.claude/`（claude 引擎） | 登录态 + `projects/<工作目录换成 - 的名字>/`（会话记录） | resume 不回原来那条会话，等于换舱 |
| `CODEX_HOME`（codex 引擎，默认 `~/.codex`） | 登录态 + thread | 同上 |
| 他用的外部工具代码（`tools.json` 里 exclude 之外、登记表 `CODE_DEFAULTS` 指的目录，比如 `~/browser-mcp`、`~/nova-notebook`） | 工具 | 那几包不挂，日志里点名 |
| 不在 `~/.<id>-gate/` 里的进程脚本（下面 `procs` 列出来、路径不在 gate 目录的那几行，比如Nova的 `nova-phone` → `~/nova-phone/run.sh`） | 额外的腿 | 那条腿不在 |

**不用搬**：`node_modules`（新机器 `npm install`）、`*.sock`（起的时候重建）、pm2 的 dump（新机器上按下面重新 start）、`/usr` 下任何东西。

旧机器上停：**按这个角色实际在跑的进程列，别照抄固定的三个** —— 除了 cli / box / gate，还可能有 `heart`、`imessage`、`phone`……漏停一个，两台机器就同时在干那件事（imessage 会抢消息、heart 会两边各叫醒他一次）。

```bash
# 旧机器
ID=<id>
procs() { pm2 jlist | node -e 'const id=process.argv[1];for(const p of JSON.parse(require("fs").readFileSync(0)))if(p.name.startsWith(id+"-"))console.log(p.name+"\t"+p.pm2_env.pm_exec_path)' "$ID"; }
procs                                   # 先看一眼：进程名 + 起的是哪个脚本（id 是别人前缀时，比如 nova / nova-x，确认没混进别的角色）
pm2 stop $(procs | cut -f1) && pm2 save # 全停；save 了重启机器也不会自己起回来
procs > ~/$ID-procs.txt                 # 这份清单带去新机器，起的时候对着它
```

```bash
# 新机器：拉过来（rsync -a 保留权限；钥匙目录要 700/600）
rsync -a old:~/.<id>-gate old:~/.<id> old:~/<id> ~/
rsync -a old:~/.secrets/<id>-* ~/.secrets/
rsync -a old:~/.claude ~/            # claude 引擎
# 代码
git clone <仓库地址> ~/im-bridge && cd ~/im-bridge && npm install
```

HOME 不一样（比如从 `/root` 搬到 `/home/you`）：`<id>-env.sh`、`run-*.sh`、`ecosystem.config.cjs`、`tools.json` 里的绝对路径要改；`~/.claude/projects/` 下的目录名跟工作目录路径绑定，工作目录路径变了要把那个目录改名（`/root/nova` → `-root-nova`，`/home/you/nova` → `-home-you-nova`）。改完：

```bash
node scripts/im-bridge.js doctor <id>
```

起进程。**`ecosystem.config.cjs` 只有 init 生成的角色才有**；init 之前手工搭的老角色可能没有（生产里Nova的 `.nova-gate` 就没有），有也不一定全（Iris那份只列了 box / gate，没有 cli）。通用起法 = 跟生产一样，一个 `run-*.sh` 起一个 pm2 进程，名字是 `<id>-<cli|box|gate|heart|imessage…>`：

```bash
ID=<id>
for f in ~/.$ID-gate/run-*.sh; do p=$(basename "$f" .sh); pm2 start "$f" --name "$ID-${p#run-}"; done
# 对着旧机器的 ~/$ID-procs.txt 看：路径不在 ~/.$ID-gate/ 里的那几行要单独起，名字照旧，比如
#   pm2 start ~/nova-phone/run.sh --name nova-phone
pm2 save
```

init 生成的角色也可以直接 `pm2 start ~/.<id>-gate/ecosystem.config.cjs && pm2 save`（它多带了 `kill_timeout` / `restart_delay`）—— 前提是里面列的进程跟 `~/$ID-procs.txt` 对得上。

老角色（init 之前手工搭的）的 env 文件名不一定是 `<id>-env.sh`：doctor 会在 `~/.<id>-gate/` 里找唯一一个 `*-env.sh`，找不到就 `doctor --env <文件>`。

## 6. 环境变量速查（这次新加的）

都**可以不写**：不写 = 跟以前一样。

| 变量 | 默认 | 管什么 |
|---|---|---|
| `IM_BRIDGE_SECRETS_DIR` | `~/.secrets` | 钥匙柜（`<名字>.secret`） |
| `GATE_OWNER_DISPLAY_NAME` | （旧默认值） | 提示词 / 工具说明里主人叫什么 |
| `GATE_AGENT_DISPLAY_NAME` | （旧默认值） | 提示词里他怎么称呼自己 |
| `GATE_AGENT_ALERT_NAME` | 同上 | 推给主人的掉档告警里管他叫什么 |
| `GATE_GROUP_WAKE_NAMES` | `[他, 主人]` | 群里叫醒他的词，逗号分隔 |
| `GATE_OWNER_NAME` | （旧默认值） | 账本里主人的身份键（ASCII，不给人看） |
| `GATE_TELEGRAM_API_BASE` | `https://api.telegram.org` | TG Bot API 地址 |
| `GATE_TRANSCRIBE` / `GATE_ACOUSTIC` | 开 | 写 `off` = 关掉转写 / 听语气 |
| `FORGE_NOTIFY_ENV_FILE` | `~/cc/.env` | 换舱回落时推告警用哪只 bot 的 token |

代码里原来写死的 `/root/...` 都改成了从 `HOME` / `GATE_ROOT` / `NOVA_STATE_DIR` 推（`src/core/paths.js`），默认结果跟以前一样。

## 7. 测试

```bash
npm test
```

`test/gate/init-e2e.js` 会在临时目录里 init 一个角色，用它生成的 `run-*.sh` 起三个真进程，假 Telegram + 假 claude CLI 走通一轮。不调任何真 API。
