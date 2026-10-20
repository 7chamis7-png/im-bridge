# im-bridge

[English](#english) · [中文](#中文)

---

## English

**im-bridge** connects instant-messaging channels (Telegram, WeChat, iMessage, a
voice-call leg, …) to a single long-running **Claude Code or Codex** session.
Claude uses the official **Claude Agent SDK**; Codex uses a persistent
`codex app-server`. An optional **DeepSeek** runtime (OpenAI-compatible chat
completions API) can stand in for either. Messages from any channel become
turns in one conversation; the agent answers through MCP tools (`reply`,
`send_image`, `send_voice`, `react`, …) and the bridge decides where and how
each reply is delivered.

### Architecture

The system runs as a few small processes that talk over Unix sockets
(newline-delimited JSON, see `cli-host/protocol.js`). Each piece can be
restarted without interrupting the others.

```
                 ┌────────────────────────── im-gate (src/host/main.js) ─────────────────────────┐
 Telegram ──┐    │ channel plugins → inbound gate → turn queue → outbound gate → channel plugins │
 WeChat   ──┼──▶ │ routing · groups · cold log · ledgers · shared capabilities (TTS, images, STT)│
 iMessage ──┤    │ tools.sock  ◀── MCP tool shim (src/gate/tools/mcp-server.js) ◀── agent         │
 Phone    ──┘    └───────────────────────────────┬───────────────────────────────────────────────┘
                                                 │ box.sock
                 ┌─────────── im-box (host/box-host.js) ───────────┐
                 │ session store · persona injection · reply journal│
                 └───────────────────────────────┬─────────────────┘
                                                 │ cli.sock
                 ┌─────────── im-cli (cli-host/main.js) ───────────┐
                 │ Claude Agent SDK / claude CLI · ingress ledger   │
                 └──────────────────────────────────────────────────┘

 im-heart (src/host/heart-host.js)      drops check-in / reminder notes into GATE_ROOT/producers
 im-imessage (src/host/imessage-spectrum.js)   optional iMessage feeder (Photon / spectrum-ts)
```

| Process | Entry | Role |
|---|---|---|
| `im-cli` | `cli-host/main.js`, `cli-host/codex-main.js` or `cli-host/deepseek-main.js` | Owns Claude via the Agent SDK, Codex via a persistent app-server, or DeepSeek via its HTTP API. Keeps an ingress ledger so no turn is sent twice or lost across restarts. Codex persists its thread id and resumes it after restart. Serves `cli.sock`. |
| `im-box` | `host/box-host.js` | Owns the session: binding → thread id (`sessions.json`), persona/opening injection, transcript trimming, and a journal of replies not yet acknowledged by the gate. Serves `box.sock`. |
| `im-gate` | `src/host/main.js` (`GATE_BOX=remote`) | The bridge. Loads channel plugins whose config is present, validates inbound events, queues turns, routes and delivers replies, writes the cold log, exposes `tools.sock` for the MCP tool shim, and runs the watchdog (context high-water / auto rotate). |
| `im-heart` | `src/host/heart-host.js` | Optional. Periodic "beats": idle check-ins and reminders, delivered as producer notes. |
| `im-imessage` | `src/host/imessage-spectrum.js` | Optional. Bridges an iMessage provider to the iMessage leg (inbox dir + socket). |

More detail: `src/gate/README.md`, `src/gate/docs/SPEC.md`, `docs/runtime-arch.md`,
`docs/runtime-rules.md`.

### Channels

| Leg | File | Notes |
|---|---|---|
| Telegram | `src/gate/plugins/telegram.js` | Bot API long polling; text, photos, voice, stickers, inline buttons (`tools/telegram`). |
| WeChat | `src/gate/plugins/wechat/` | Reads the local desktop client database; sends via UI automation. **See warning below.** |
| iMessage | `src/gate/plugins/imessage.js` | Inbox directory + socket; fed by `im-imessage`. |
| Phone | `src/gate/plugins/phone.js` | Text side of a voice-call pipeline (STT/TTS run in an external process). |
| weixin-bot | `src/gate/plugins/weixin-bot.js` | Library-only plugin, constructed in code (not auto-loaded). |

A leg is plugged in automatically when all of its required environment variables
are set; `GATE_LEG_<NAME>=off` disables one explicitly.

> ⚠️ **WeChat warning.** The WeChat leg reads the local WeChat client's encrypted
> database (you must supply the keys yourself) and drives the WeChat UI through
> accessibility automation. This is not an official API. The platform may detect it
> and restrict your account (for example, blocking logins on new devices).
> **Use entirely at your own risk.**

### Requirements

- Node.js ≥ 20 (developed on 22)
- The `claude` CLI installed and logged in, or the `codex` CLI logged in with a ChatGPT subscription,
  or a DeepSeek API key (`DEEPSEEK_API_KEY`)
- Optional per leg: Python 3, `zstd`, `ffmpeg`, SQLCipher tooling, AT-SPI (WeChat); an
  iMessage provider (iMessage); ElevenLabs / OpenAI-compatible keys (voice, images, STT)

### Configuration

All configuration is via environment variables; nothing is hard-coded.
See `.env.example` for a template. Data lives under `IM_BRIDGE_HOME`
(default `~/.im-bridge`).

**Core (im-gate / im-box share `readConfig`)**

| Variable | Default | Meaning |
|---|---|---|
| `IM_BRIDGE_HOME` | `~/.im-bridge` | Base data directory |
| `GATE_ROOT` | — (required) | Bridge storage root; sockets `box.sock`, `tools.sock`, `cli.sock` live here |
| `GATE_BINDING_KEY` | — (required) | Session binding key in `sessions.json` |
| `GATE_WORKSPACE_ROOT` | — (required) | Working directory of the Claude session |
| `GATE_PREFERRED_CHAT_ID` | — (required) | Where the agent speaks when not replying to anything |
| `GATE_BOX` | `claudecode` | Box kind. `im-gate` must use `remote`; `im-box` uses `claudecode` |
| `GATE_BOX_SOCKET` | `$GATE_ROOT/box.sock` | Box socket |
| `GATE_OWNER_NAME` | `owner` | Identity label of the owner |
| `GATE_OWNER_<CHANNEL>_ID` | — | Owner's id(s) on a channel, comma-separated (e.g. `GATE_OWNER_TELEGRAM_ID`) |
| `GATE_OWNER_PRONOUN` | `they` | Fills `{{USER_PRONOUN}}` in instruction templates |
| `GATE_MODEL` | — | Pin a model (disables `/model`) |
| `GATE_FALLBACK_MODEL` / `CC_FALLBACK_MODEL` | — | Fallback model passed to the SDK |
| `GATE_MODEL_CHOICES` | built-in list | `/model` buttons, `Label=model-id,...` |
| `GATE_CLAUDE_COMMAND` | `claude` | CLI command |
| `GATE_CLAUDE_PERMISSION_MODE` | `default` | SDK permission mode |
| `GATE_CLAUDE_PARTIAL` | — | `on` = stream partial messages |
| `GATE_SYSTEM_PROMPT_FILE` | — | System prompt file |
| `GATE_PLUGIN_DIR` | — | Claude Code plugin directory, passed as `--plugin-dir` |
| `GATE_PERSONA` / `GATE_PERSONA_NAME` | — | Persona directory or `.js` module (see `examples/persona/`) |
| `GATE_MEMORY_DIR` | `$IM_BRIDGE_HOME/memory` | Memory files injected on a new session (`memory.md`, `agent-state.txt`, `operations.md`, `channels/*.md`, `diary/`) — see `examples/memory/` |
| `GATE_IDENTITY_INJECTION_FILE` | — | Extra identity text injected on a new session |
| `GATE_EXTRA_MCP` | — | JSON file `{ "mcpServers": {...} }` merged into the agent's MCP config |
| `GATE_BOX_CONTEXT_LIMIT` | — | Context window size used for fullness reporting |
| `GATE_COLD_FILE` | `$GATE_ROOT/cold.jsonl` | Cold log (plain conversation record) |
| `GATE_ENABLED_FILE` | `$GATE_ROOT/.gate-enabled` | Kill switch: bridge only takes over while this file exists |
| `GATE_HEARTBEAT_FILE` / `GATE_HEARTBEAT_MS` | `$GATE_ROOT/heartbeat.json` / `15000` | Heartbeat |
| `GATE_PRODUCERS_DIR` | `$GATE_ROOT/producers` | Drop directory for producer notes |
| `GATE_POLL_TIMEOUT_SEC` | `25` | Long-poll timeout |
| `GATE_TZ` / `GATE_TZ_LABEL` | `UTC` | Time zone for clock math and date-named files |
| `GATE_OUTWARD_TZ` / `GATE_OUTWARD_LOCALE` | `GATE_TZ` / `en-US` | Rendering of times shown to the model |
| `GATE_TZ_OFFSET_HOURS` | `0` | Fixed offset used by check-ins / reminders |
| `AGENT_REFRESH_SLIM` | — | `0` = full re-injection after context compaction |
| `AGENT_SUMMARY_INJECT_MAX` / `AGENT_SUMMARY_HEADING` | `20` / `## Auto summaries` | Summary section of `memory.md` |
| `AGENT_COLD_WINDOW_HOURS` / `AGENT_COLD_MAX_RECORDS` / `AGENT_COLD_BACKFILL_MAX_HOURS` | `4` / `60` / `72` | Cold-log excerpt used for session handoff |

**Groups**

| Variable | Meaning |
|---|---|
| `GATE_GROUPS_ALLOWED` | Allowed groups, `channel:groupId` comma-separated (empty = no group messages) |
| `GATE_GROUPS_ALWAYS_WAKE` | Groups where every message wakes the agent |
| `GATE_GROUP_NAMES` | `id=name,...` labels for Telegram groups |
| `GATE_GROUP_WAKE_NAMES` | Words that wake the agent in a group |

**Watchdog / context**

| Variable | Default | Meaning |
|---|---|---|
| `GATE_WATCH_MS` | `30000` | Watchdog interval (`0` = off). It only reports, never restarts |
| `GATE_HIGH_WATER_RATIO` | `0.85` | Push a closing turn when the context reaches this ratio |
| `GATE_AUTO_ROTATE_RATIO` | `0` | Trim tool output / rotate session at this ratio (`0` = off) |
| `GATE_AUTO_ROTATE_COOLDOWN_MS` | `1800000` | Cool-down between attempts |
| `GATE_TRIM_MIN_GAIN_TOKENS` | `80000` | Minimum estimated gain to trim instead of rotating |
| `GATE_MODEL_ALERT_STATE_FILE` | `$GATE_ROOT/model-fallback-alert.json` | State for model-fallback alerts |
| `GATE_NOTIFY_BOT_TOKEN` / `GATE_NOTIFY_BOT_SECRET` / `GATE_NOTIFY_CHAT_ID` | — | Telegram bot used for alerts (unset = log only). The secret file may contain `TOKEN` and `NOTIFY_CHAT_ID=` |

**im-cli**

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_STATE_DIR` | — | Fallback for `GATE_ROOT` |
| `AGENT_CLI_SOCKET` | `$GATE_ROOT/cli.sock` | CLI socket (also read by im-box) |
| `AGENT_CLI_INGRESS` | `$GATE_ROOT/state/im-bridge-ingress.json` | Ingress ledger |
| `AGENT_CLI_PATH` | `/usr/bin/claude` | Claude binary |
| `AGENT_CLI_SCOPE` | `box` | Ledger scope |
| `AGENT_CLI_STOP_GRACE_MS` | `3000` | Grace period when stopping the CLI |
| `IM_BRIDGE_INGRESS_PATH`, `IM_BRIDGE_CLI_CWD`, `IM_BRIDGE_CLI_PATH`, `IM_BRIDGE_STREAM_TOKENS` | — | Low-level defaults for `runtime/index.js` |

**Codex runtime (alternative im-cli)**

| Variable | Default | Meaning |
|---|---|---|
| `CODEX_COMMAND` | `codex` | Codex CLI executable |
| `CODEX_MODEL` | account default | Codex model; kept independent from Claude `/model` choices |
| `CODEX_HOME_DIR` | OS home | Home containing `.codex/auth.json` |
| `CODEX_AUTH_FILE` | `$CODEX_HOME_DIR/.codex/auth.json` | Codex login file; only `auth_mode=chatgpt` is accepted |
| `CODEX_ROOT` | `GATE_ROOT` | Codex state directory |
| `CODEX_SOCKET` | `AGENT_CLI_SOCKET` or `$GATE_ROOT/cli.sock` | CLI socket used by im-box |
| `CODEX_INGRESS` | `$CODEX_ROOT/state/ingress.json` | Reliable ingress ledger |
| `CODEX_THREAD_FILE` | `$CODEX_ROOT/state/codex-thread.json` | Persisted thread id used by `thread/resume` after restart |
| `CODEX_APPROVAL_POLICY` | `never` | Approval policy passed to Codex app-server |
| `CODEX_START_TIMEOUT_MS` / `CODEX_TURN_TIMEOUT_MS` | `60000` / `300000` | Start and per-turn timeouts |

**DeepSeek runtime (alternative im-cli)**

Calls the DeepSeek chat-completions API directly (no CLI is spawned). It keeps
its own conversation file, separate from Claude's `sessions.json`, so switching
back to Claude finds the old session untouched. A brand-new conversation is
seeded from the tail of the cold log. Tools are the MCP servers the box passes
in, plus local `Read` / `Edit` / `Write` / `Bash`; every call still goes through
the box's permission check. Images are not supported. Note that this runtime is
billed per token by the API provider.

| Variable | Default | Meaning |
|---|---|---|
| `DEEPSEEK_API_KEY` | — (required) | API key; read from the environment only, never written to disk |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | API root; an Anthropic-compatible `.../anthropic` root is mapped back to `/chat/completions` |
| `DEEPSEEK_MODEL` | `deepseek-chat` | Model name; independent from Claude `/model` choices |
| `DEEPSEEK_TIMEOUT_MS` | `90000` | Per-request timeout |
| `DEEPSEEK_ROOT` | `$GATE_ROOT/deepseek` | State directory (ledger, `deepseek-thread.json`) |
| `DEEPSEEK_SOCKET` | `$DEEPSEEK_ROOT/deepseek.sock` | Socket to listen on. Set to the box's CLI socket (`AGENT_CLI_SOCKET`, default `$GATE_ROOT/cli.sock`) to serve the box instead of the Claude im-cli |
| `DEEPSEEK_INGRESS` | `$DEEPSEEK_ROOT/state/ingress.json` | Reliable ingress ledger |
| `DEEPSEEK_SCOPE` | `deepseek` | Ledger scope |
| `DEEPSEEK_CWD` | `GATE_WORKSPACE_ROOT` | Workspace (tool cwd; its `CLAUDE.md` and `.mcp.json` are read) |
| `DEEPSEEK_SYSTEM_PROMPT` | `GATE_IDENTITY_INJECTION_FILE` / `GATE_SYSTEM_PROMPT_FILE` | System prompt file |
| `DEEPSEEK_COLD_FILE` | — | Cold log used to seed a new conversation |
| `DEEPSEEK_MCP_FILE` | — | MCP config to read when the box has not passed a server list |

Try it without the box: `node cli-host/deepseek-ask.js "hello"` (refuses to
connect to the box's own `cli.sock` unless `DEEPSEEK_ASK_FORCE=1`).

**Telegram leg**: `GATE_TELEGRAM_TOKEN` (required), `GATE_BOT_ID`, `GATE_BOT_USERNAME`,
`GATE_STICKER_PACKS` (sticker book JSON), `GATE_STICKER_OWNER`, `GATE_STICKER_OWNERS` (`identity=pack,...`).

**iMessage leg**: `GATE_IMESSAGE_INBOX_DIR`, `GATE_IMESSAGE_SOCKET` (both required),
`GATE_IMESSAGE_SEND_TIMEOUT_MS` (`20000`). Feeder `im-imessage`: `PHOTON_PROJECT_ID`,
`PHOTON_PROJECT_SECRET`, `AGENT_IMESSAGE_ALLOWED_HANDLES` (empty = no restriction).

**Phone leg**: `GATE_PHONE_INBOX_DIR`, `GATE_PHONE_SOCKET` (both required),
`GATE_PHONE_SEND_TIMEOUT_MS` (`8000`), `GATE_PHONE_IDLE_MS` (`300`).
For phone turns the box also streams sentences to the call process while the
agent is still writing (`im-box` needs `GATE_PHONE_SOCKET` too). During the turn
the call process receives `{"type":"say","text":"…","stream":true,"turnId":"…"}`
frames, one per sentence; afterwards the full segment arrives as usual
(`{"type":"say","operationId":"…","text":"…"}`). The call process should speak
stream frames immediately and skip text it already spoke when the full segment
arrives. See `src/host/phone-stream.js` and the header of `src/gate/plugins/phone.js`.

**WeChat leg** — required: `GATE_WECHAT_KEYS_FILE`, `GATE_WECHAT_IMAGE_KEY_FILE`,
`GATE_WECHAT_WHITELIST_FILE`, `GATE_WECHAT_SENDER` (path to `linux-wx-send-a11y.py`),
`GATE_WECHAT_TARGET`, `GATE_WECHAT_SEND_LOCK`. Optional: `GATE_WECHAT_IDLE_MS` (`2000`),
`GATE_WECHAT_PYTHON` (`python3`), `GATE_WECHAT_FILES_ROOT`, `GATE_WECHAT_SEND_LOG`,
`GATE_WECHAT_DISPLAY` (`:0`), `GATE_WECHAT_MIC_SINK` (`agent_mic_sink`),
`GATE_WECHAT_VOICE_COOLDOWN_MS` (`12000`), `GATE_WECHAT_GAP_MIN_MS` / `GATE_WECHAT_GAP_MAX_MS`
(`1000` / `3000`, random delay between segments). Helper scripts: `LINUX_WX_TARGET`,
`LINUX_WX_DISPLAY`, `LINUX_WX_SPOTS` (`$IM_BRIDGE_HOME/wechat/wx-spots.json`), `LINUX_WX_A11Y`,
`LINUX_WX_KEYS`, `LINUX_WX_OWNER_WXID`, `LINUX_WX_POLL_S`, `PULSE_SINK`.

**Tools (MCP shim)**: `GATE_TOOL_SOCKET` (set automatically by im-gate), `GATE_TOOL_SERVER_NAME` (`im_bridge`).

**Shared capabilities (all optional; unset = capability not registered)**

| Variable | Meaning |
|---|---|
| `ELEVENLABS_API_KEY`, `ELEVENLABS_DEFAULT_VOICE_ID`, `ELEVENLABS_MODEL`, `ELEVENLABS_MODEL_FILE` | Text-to-speech (`send_voice`) |
| `AGENT_IMAGE_API_KEY` (or `OPENAI_API_KEY`), `AGENT_IMAGE_MODEL`, `AGENT_IMAGE_OUTPUT_DIR` | Image generation |
| `AGENT_TRANSCRIPTION_API_KEY`, `AGENT_TRANSCRIPTION_BASE_URL`, `AGENT_TRANSCRIPTION_MODEL`, `AGENT_TRANSCRIPTION_LANGUAGE`, `AGENT_TRANSCRIPTION_API_TIMEOUT_MS` | Speech-to-text via an OpenAI-compatible API |
| `AGENT_TRANSCRIPTION_LOCAL`, `AGENT_TRANSCRIPTION_LOCAL_MODEL`, `AGENT_TRANSCRIPTION_PYTHON`, `AGENT_TRANSCRIPTION_LOCAL_PROMPT`, `AGENT_TRANSCRIPTION_LOCAL_TIMEOUT_MS` | Local whisper fallback |
| `AGENT_ACOUSTIC_SCRIPT`, `AGENT_ACOUSTIC_PYTHON`, `AGENT_ACOUSTIC_TIMEOUT_MS` | Optional external voice-tone analyzer |

**im-heart**

| Variable | Default | Meaning |
|---|---|---|
| `GATE_CHECKIN_CONFIG_FILE` | `$AGENT_STATE_DIR/checkin-config.json` | Check-in config (`examples/checkin-config.example.json`) |
| `GATE_CHECKIN_TEXTS_FILE` | `$AGENT_STATE_DIR/checkin-texts.md` | Check-in texts (`examples/checkin-texts.example.md`) |
| `GATE_CHECKIN_STATE_FILE` | `$AGENT_STATE_DIR/checkin-state.json` | Check-in state |
| `GATE_CHECKIN_DRIVES_URL` | — | Optional JSON endpoint shown as a "drives" line |
| `GATE_REMINDER_QUEUE_FILE` | — (off) | Reminder queue `[{id, dueAtMs, text}]` |
| `GATE_REMINDER_FIRED_FILE` / `GATE_REMINDER_STALE_MS` | `$GATE_ROOT/heart-fired.json` / 2h | Delivered-reminder ledger / staleness cut-off |
| `GATE_HEART_FILE` | `$GATE_ROOT/heart.json` | Per-beat stats |
| `AGENT_NOTEBOOK_MODULE` / `AGENT_NOTEBOOK_FILE` | — (off) | Optional external notebook module (pending items in the opening turn and check-ins) |

### Running

```bash
npm install
cp .env.example .env        # edit it
set -a; . ./.env; set +a

node cli-host/main.js                      # im-cli
# Or, instead of the line above:
node cli-host/codex-main.js                # im-cli backed by persistent Codex app-server
# Or: DEEPSEEK_SOCKET="$GATE_ROOT/cli.sock" node cli-host/deepseek-main.js   # im-cli backed by DeepSeek API
node host/box-host.js                      # im-box
GATE_BOX=remote node src/host/main.js      # im-gate   (add --check for a dry health check)
node src/host/heart-host.js                # im-heart (optional)
node src/host/imessage-spectrum.js         # im-imessage (optional)
touch "$GATE_ROOT/.gate-enabled"           # let the bridge take over
```

Use any process manager (systemd, pm2, …) to keep them running. Restart order
does not matter; restarting `im-gate` or `im-box` does not interrupt a running
turn, because the CLI lives in `im-cli`.

In-chat commands: `/status`, `/help`, `/new` (new session), `/model`, `/stop`, `/undo`.

### Tests

```bash
npm test            # runtime + gate + cli-host + tools suites
npm run test:runtime
npm run test:gate   # each file in test/gate is a standalone script
npm run test:cli-host
npm run test:tools
```

The tests need no network and no credentials. `test/smoke/` contains manual
smoke scripts that talk to a real model and are not part of `npm test`.

### License

MIT — see `LICENSE`.

---

## 中文

**im-bridge** 把即时通讯渠道（Telegram、微信、iMessage、电话等）接到一个常驻的
**Claude Code 或 Codex** 会话上。Claude 使用官方 **Claude Agent SDK**，Codex 使用常驻的
`codex app-server`。另有可选的 **DeepSeek** 运行时（OpenAI 兼容的 chat completions 接口），可替代二者之一。
各渠道的消息都变成同一段对话里的轮次；
agent 通过 MCP 工具（`reply`、`send_image`、`send_voice`、`react` 等）回复，由桥决定发到哪里、怎么发。

### 架构

系统由几个小进程组成，彼此通过 Unix socket 通信（逐行 JSON，见 `cli-host/protocol.js`），
任何一个都可以单独重启而不打断其他进程：

| 进程 | 入口 | 职责 |
|---|---|---|
| `im-cli` | `cli-host/main.js`、`cli-host/codex-main.js` 或 `cli-host/deepseek-main.js` | 通过 Agent SDK 持有 Claude，或通过常驻 app-server 持有 Codex，或直接调用 DeepSeek 接口；入站台账保证重启前后每一轮不丢不重。Codex 的 thread id 会落盘，重启后调用 `thread/resume`。提供 `cli.sock`。 |
| `im-box` | `host/box-host.js` | 持有会话：绑定 → 线程号（`sessions.json`）、人格/开场注入、转录裁剪、未被桥确认的回复日志。提供 `box.sock`。 |
| `im-gate` | `src/host/main.js`（`GATE_BOX=remote`） | 桥本体：按配置自动插上渠道插件，校验入站、排队、路由与投递回复、写冷层记录，给 MCP 工具壳提供 `tools.sock`，并运行守护（上下文水位/自动换会话）。 |
| `im-heart` | `src/host/heart-host.js` | 可选。定时"心跳"：空闲问候、提醒，以 producer 笔记形式投递。 |
| `im-imessage` | `src/host/imessage-spectrum.js` | 可选。把 iMessage 服务商接到 iMessage 插件（收件目录 + socket）。 |

更多细节见 `src/gate/README.md`、`src/gate/docs/SPEC.md`、`docs/runtime-arch.md`、`docs/runtime-rules.md`。

### 渠道

Telegram、微信、iMessage、电话、weixin-bot（仅库用法）。某条腿需要的环境变量都配齐时自动插上；
`GATE_LEG_<名字>=off` 可以显式关掉。

> ⚠️ **微信警告**：微信插件读取本机微信客户端的加密数据库（密钥需自行提供），并通过无障碍接口
> 自动操作微信界面。这不是官方接口，可能被平台识别并限制账号（例如限制新设备扫码登录）。
> **使用风险完全自担。**

### 配置

全部通过环境变量配置，代码里没有写死的路径或 ID。模板见 `.env.example`，完整列表见上面英文部分的表格。
数据默认放在 `IM_BRIDGE_HOME`（默认 `~/.im-bridge`）。必填项：`GATE_ROOT`、`GATE_BINDING_KEY`、
`GATE_WORKSPACE_ROOT`、`GATE_PREFERRED_CHAT_ID`；`im-gate` 需要 `GATE_BOX=remote`。
人格、记忆、问候文案都从外部文件读取，示例在 `examples/`。

**电话边写边念**：来路是电话的那一轮，盒子会在 agent 还在写的时候按句递给通话进程
（`im-box` 也要配 `GATE_PHONE_SOCKET`）。轮内通话进程会收到
`{"type":"say","text":"…","stream":true,"turnId":"…"}`，一句一帧；之后整段照常再到一次
（`{"type":"say","operationId":"…","text":"…"}`）。通话进程应立刻念流式帧，整段到达时跳过已经念过的部分。
见 `src/host/phone-stream.js` 和 `src/gate/plugins/phone.js` 文件头。

**DeepSeek 运行时**：直接调 DeepSeek 接口，不起 CLI。对话单独存在 `deepseek-thread.json`，
不写 Claude 的 `sessions.json`，切回 Claude 原会话不受影响；新对话会用冷层尾部垫底。
工具 = 盒子递来的 MCP + 本地 `Read`/`Edit`/`Write`/`Bash`，每次调用仍经盒子的许可检查。不支持图片；
按 token 计费。必填 `DEEPSEEK_API_KEY`，其余变量见英文部分的表格。
不接盒子单独试：`node cli-host/deepseek-ask.js "你好"`。

### 运行

```bash
npm install
cp .env.example .env && 编辑
set -a; . ./.env; set +a
node cli-host/main.js                      # im-cli
# 或者用 Codex（与上一行二选一）：
node cli-host/codex-main.js                # 常驻 Codex app-server
# 或者用 DeepSeek：DEEPSEEK_SOCKET="$GATE_ROOT/cli.sock" node cli-host/deepseek-main.js
node host/box-host.js                      # im-box
GATE_BOX=remote node src/host/main.js      # im-gate（加 --check 只体检）
node src/host/heart-host.js                # im-heart（可选）
touch "$GATE_ROOT/.gate-enabled"           # 打开开关，桥开始接管
```

聊天内命令：`/status`、`/help`、`/new`、`/model`、`/stop`、`/undo`。

### 测试

```bash
npm test
```

测试不需要网络和凭据。`test/smoke/` 下是连真实模型的手动冒烟脚本，不在 `npm test` 里。

### 许可

MIT，见 `LICENSE`。
