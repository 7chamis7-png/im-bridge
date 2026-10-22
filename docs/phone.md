# 电话（可选的一条腿）

让他在微信语音通话里**开口说话、听她说话**。桥这边把电话当成一条普通渠道（`phone`）：
她说的话转成文字进闸、落冷层、进他的线程；他的回话出闸后由通话进程念出来。

这条腿**可选**：不配 `GATE_PHONE_INBOX_DIR` / `GATE_PHONE_SOCKET`，桥上就没有它，别的渠道照常。

> English summary at the end.

## 1. 架构

```
                         ┌──────────────── 通话进程 legs/phone/phone.py ────────────────┐
 微信通话（对方的声音）    │                                                              │
   │ 播放到默认输出        │  parecord ← <PHONE_SPEAKER>.monitor                          │
   ▼                      │     │ VAD 断句（ear.py）                                      │
 <PHONE_SPEAKER> null-sink│     ▼                                                        │
                          │  转写 ElevenLabs Scribe ∥ 语气 north-ear（可选）               │
                          │     │                                                        │
                          │     ▼  <12位序号>.json                                       │
                          │  $GATE_PHONE_INBOX_DIR ─────────────┐                        │
                          │                                     │                        │
                          │  $GATE_PHONE_SOCKET ◀─ {"type":"say"}┼──┐                     │
                          │     │ 合成 ElevenLabs TTS（流式 PCM）│  │                     │
                          │     ▼                               │  │                     │
                          │  pacat → <PHONE_MIC_SINK>           │  │                     │
                          └─────────┬───────────────────────────┼──┼─────────────────────┘
                                    │ .monitor                  │  │
                                    ▼ remap                     ▼  │
 微信通话（他的声音）◀── 默认输入 <PHONE_MIC>        桥 src/gate/plugins/phone.js（phone 腿）
                                                     │ 入闸 → 冷层 → 他 → 出闸 ──┘
                                                     └ 盒子边写边递（src/host/phone-stream.js）
```

- **入站走文件、出站走 socket**：她说的话不能丢（落盘，桥消化完才删）；他的话过期作废
  （电话挂了再念就是鬼话 —— 通话进程回 `ok:false`，桥记一笔没送达，不攒到下一通）。
- **拨号 / 挂断不归这条腿**：是微信界面上的动作，走微信那条腿（`call` / `hang_up` 工具 →
  `src/gate/plugins/wechat/wx-call.py`）。
- **为什么不会有回声**：录的是 `<PHONE_SPEAKER>.monitor`（只有微信放出来的对方声音），
  放的是 `<PHONE_MIC_SINK>`（只进微信的麦克风）。两个 null-sink 互不相通，他听不见自己。
- **通话在不在**：默认 `PHONE_CALL_PROBE=wechat-window`，每秒用 `xdotool search --name '^Voice Call$'`
  看一眼微信的通话窗口（只读窗口标题，**不扫无障碍树**——扫树会让微信黑屏）。
  - 不在通话里：他递来的话一律回 `ok:false「现在没有通话」`；录到的声音（消息提示音之类）不转写（省钱）。
  - 挂断那一刻：排着没念的作废，正在放的掐掉。
  - `PHONE_CALL_PROBE=always`：不看窗口，进程活着就当在通话（旧行为）。
- **接通了谁先开口**：见 §6。

## 2. 依赖

| 要什么 | 干什么 | 怎么装 |
|---|---|---|
| Linux 版微信 + Xvfb + 微信那条腿 | 通话本身、拨号 / 挂断 | 见 [INSTALL.md §4 微信](INSTALL.md#微信她自己的真实微信)、[WECHAT_KEY.md](WECHAT_KEY.md) |
| PulseAudio + `pulseaudio-utils` | 虚拟声卡；`parecord` / `pacat` / `pactl` | `apt install pulseaudio pulseaudio-utils` |
| `xdotool` | 看通话窗口在不在（`PHONE_CALL_PROBE=wechat-window`） | `apt install xdotool`（微信那条腿本来就要） |
| `ffmpeg` | 合成失败时的兜底播放路 | `apt install ffmpeg` |
| python3（3.8+，只用标准库） | 通话进程本身 | 系统自带 |
| ElevenLabs API key + voice id | 转写（Scribe）+ 合成 | ElevenLabs 后台。**按量计费**，见 §8 |
| north-ear（可选，不在本仓库） | 听语气：音高 / 气声，附在转写后面一行；也用来认回铃音 | 自己装一个 venv，配 `NORTH_EAR_PYTHON` / `NORTH_EAR_SCRIPT`；不配就跳过 |

### 验证过的环境（2026-10）

| 部件 | 版本 |
|---|---|
| 系统 | Ubuntu 24.04 LTS |
| 微信 | 官方 Linux 版 4.1.13.23（`apt-mark hold wechat` 锁住，不自动升级） |
| 虚拟屏 / 窗管 | Xvfb 21.1、openbox 3.6 |
| 无障碍 | at-spi2-core 2.52、xdotool 3.20160805 |
| 声音 | PulseAudio 16.1 + pulseaudio-utils 16.1 |
| 其他 | ffmpeg 6.1、Node.js 22、Python 3.12 |
| 语音服务 | ElevenLabs（转写 + 合成，按量计费） |

微信大版本升级后，界面坐标 / 窗口标题 / 库表都可能要重对。

## 3. 安装

1. **虚拟声卡**（幂等，已经有的不重复建）：

   ```bash
   PHONE_SPEAKER=imb_speaker PHONE_MIC_SINK=imb_mic_sink PHONE_MIC=imb_mic scripts/setup-phone-audio.sh
   scripts/setup-phone-audio.sh --check          # 只读体检，一样不改
   ```

   想让 pulse 重启后自动建：`scripts/setup-phone-audio.sh --print-default-pa >> ~/.config/pulse/default.pa`
   （那份文件要么开头 `.include /etc/pulse/default.pa`，要么自己写全），或者 `--print-systemd` 生成一个
   `systemd --user` 单元。

2. **建完设备 / pulse 重启过之后，重启微信**（见 §7 第一条）。

3. **钥匙**放仓库外，`chmod 600`：

   ```bash
   printf 'ELEVENLABS_API_KEY=%s\n' '<你的 key>' > ~/.secrets/<id>-phone.env && chmod 600 ~/.secrets/<id>-phone.env
   ```

4. **桥那边**（`<id>-env.sh`）加上这条腿，重启 `<id>-gate`（不打断他）：

   ```bash
   export GATE_PHONE_INBOX_DIR=$GATE_ROOT/phone-inbox
   export GATE_PHONE_SOCKET=$GATE_ROOT/phone.sock
   export GATE_OWNER_PHONE_ID=<她在电话这条腿上的身份，随便一个固定字符串>
   export GATE_WECHAT_MIC_SINK=imb_mic_sink      # 微信发语音条也往这个设备放，要跟 PHONE_MIC_SINK 一样
   ```

5. **通话进程**：拷 `legs/phone/run.example.sh` 到 `~/.<id>-gate/run-phone.sh`，改掉 `<…>`，然后

   ```bash
   pm2 start ~/.<id>-gate/run-phone.sh --name <id>-phone && pm2 save
   ```

   systemd 也行（`--user` 单元，`ExecStart=` 指那个 run-phone.sh）。**一定用 `env -i` 起**
   （样例里就是）：不继承你 shell 里的变量，别的角色的 `GATE_*` 会让它落错收件箱、挂到别人的 socket 上。

   重启它**不打断他**（他在别的进程里），但**会挂断正在进行的通话**（退出时默认挂断，
   `PHONE_HANGUP_ON_EXIT=0` 关掉）。

## 4. 配置项

通话进程只读环境变量（`legs/phone/config.py`）。必填的缺了会一次列全、退出码 2。

| 变量 | 必填 | 默认 | 管什么 |
|---|---|---|---|
| `GATE_PHONE_INBOX_DIR` | ✓ | — | 她说的话落这个目录（跟桥同一个值） |
| `GATE_PHONE_SOCKET` | ✓ | — | 他的话从这个 unix socket 递过来（跟桥同一个值） |
| `GATE_OWNER_PHONE_ID` | ✓ | — | 她在这条腿上的身份（跟桥同一个值；空的话桥会拒收） |
| `ELEVENLABS_API_KEY` | ✓ | — | 也可以 `ELEVENLABS_API_KEY_FILE`（文件里只有 key）或 `PHONE_ENV_FILE` |
| `PHONE_ENV_FILE` | | — | 一个 `KEY=VALUE` 文件，**只补没设的**变量（钥匙放这里，不进仓库） |
| `ELEVENLABS_DEFAULT_VOICE_ID` | ✓ | — | 他的音色；`PHONE_VOICE_ID` 优先。**不填不猜**，免得用上别人的声音 |
| `ELEVENLABS_MODEL_FILE` | | `$GATE_ROOT/tts-model` | 合成模型开关文件（跟桥的语音条同一份，每句现读） |
| `ELEVENLABS_MODEL` | | `eleven_v3` | 文件没有时用这个。非 v3 的模型会先剥掉 `[标签]` |
| `PHONE_STT_MODEL` | | `scribe_v1` | 转写模型 |
| `ELEVENLABS_API_BASE` | | `https://api.elevenlabs.io` | 接口地址（反代时改） |
| `PHONE_SPEAKER` | | `imb_speaker` | 微信播放进的 null-sink；录它的 `.monitor` |
| `PHONE_LISTEN_DEVICE` | | `<PHONE_SPEAKER>.monitor` | 直接指定录哪个 source |
| `PHONE_MIC_SINK` | | `imb_mic_sink` | 他的声音放进这个 null-sink |
| `PHONE_MIC` | | `imb_mic` | （只给 setup 脚本用）remap 出来的麦克风名 |
| `XDG_RUNTIME_DIR` | | `/run/user/<uid>` | 找 pulse 用 |
| `DISPLAY` | | — | 微信所在的 X（看通话窗口、拨号 / 挂断都要）。也认 `LINUX_WX_DISPLAY` |
| `PHONE_CALL_PROBE` | | `wechat-window` | `wechat-window` = 看通话窗口；`always` = 进程活着就当在通话（旧行为） |
| `PHONE_CALL_WINDOW` | | `^Voice Call$` | 通话窗口标题（正则）。中文界面可能要改 |
| `PHONE_CALL_POLL_S` | | `1` | 多久看一次 |
| `GATE_PRODUCERS_DIR` | | `$GATE_ROOT/producers` | 桥的生产者投递口（先开口提醒往这儿投）。没有就不提醒 |
| `PHONE_NUDGE_AFTER_S` | | `4` | 回铃音停了之后她静了这么久 → 提醒他先开口。`0` = 关 |
| `PHONE_NUDGE_FALLBACK_S` | | `15` | 一直没听到回铃音时，通话窗口开了这么久她还没出声 → 提醒 |
| `PHONE_NUDGE_TEXT` | | 内置一句 | 提醒的正文，`{secs}` 换成秒数 |
| `LINUX_WX_TARGET` | 拨号时 | 也认 `GATE_WECHAT_TARGET` | 她的微信会话标题（自己拨号 / 退出挂断用） |
| `PHONE_WECHAT_LOCK` | 拨号时 | 也认 `GATE_WECHAT_SEND_LOCK` | 微信窗口锁（**跟桥同一个文件**，一次只许一个人碰微信） |
| `PHONE_WECHAT_DIR` | | 仓库里的 `src/gate/plugins/wechat` | `wx-call.py` 在哪 |
| `PHONE_HANGUP_ON_EXIT` | | `1` | 进程退出时挂断 |
| `PHONE_TMP_DIR` | | `/tmp/imb-phone` | 录下来的句子（最近 20 段循环覆盖） |
| `NORTH_EAR_PYTHON` / `NORTH_EAR_SCRIPT` | | — | 听语气（跟桥同名变量）。两个都配才开 |

命令行：`phone.py --no-dial` = 只接管已经打通的电话（拨号由他调 `call` 工具走微信那条腿）；
不带 = 起来先自己拨一次。

## 5. 桥那边

- `src/gate/plugins/phone.js`：入站 `poll()` 读收件箱，出站 `send()` 递 `{"type":"say","operationId","text"}`，
  等一行 `{"ok":true|false,"why":...}`（8 秒，`GATE_PHONE_SEND_TIMEOUT_MS`）。`ok:false` → 记成没送达。
- `src/host/phone-stream.js`：电话那一轮，盒子把他一边写的字一边按句递过去（`"stream":true`）；
  整轮结束桥再递一次整段，通话进程把流过的扣掉，只补念剩下的。
- 收件箱一条：`{"id":"<序号>","at":"<UTC ISO>","text":"…","peerId":"<GATE_OWNER_PHONE_ID>","accountId":"phone"}`，
  文件名 `<12 位序号>.json`，先写 `.tmp` 再原子改名。**序号必须大于桥的游标**（用秒级时间戳起步）。

## 6. 接通了谁先开口

原来的流程：他调 `call` → 微信那条腿点拨号 → 工具回「拨出去了」→ 这一轮结束。之后**没有任何东西告诉他
「接通了」**，他只能等她先出声（她的第一句话进收件箱才会开一轮）。她要是也在等他、或者她那头没声音，
两边就干等；等她挂了，他才想起来说话 —— 那句话到通话进程时电话早挂了。

现在：

1. 通话进程看到通话窗口 → 记下「通话开始」。
2. 她说了话 → 照旧递给桥，什么都不多做。
3. 她一直没出声：回铃音停了之后静了 `PHONE_NUDGE_AFTER_S` 秒（没认出回铃音时按窗口开了
   `PHONE_NUDGE_FALLBACK_S` 秒）→ 往桥的**生产者投递口**投一条系统提醒，落点指定为电话
   （`target: {platform:"phone"}`）。他那一轮的回话照常走电话、边写边念。一通电话只提醒一次。
4. 挂断：排着没念的作废；之后才到的话回 `ok:false`。

为什么投系统提醒、不往收件箱里塞一句：收件箱里的每一条都会被当成「她说的」进冷层 —— 那等于替她编了一句话。

为什么不做「拨号时预先排一句，接通即念」：那要一个**可靠的接通信号**，而微信只给了一个通话窗口
（响铃和接通是同一个窗口）。认错了就是对着回铃音念，那句话就丢了。提醒的坏处小得多：最坏是他在
还在响的时候开口，那句没人听见，她接起来说「喂」之后照常接上。

## 7. 排错

**pulse 重启过之后，微信必须跟着重启。** 微信连着的还是旧 pulse，通话**两头都哑**：她听不见他，
通话进程也录不到她（日志里只剩 `本底 0`，一句「→ 桥」都没有）。`scripts/setup-phone-audio.sh --check`
按「pulse 启动时间 vs 微信启动时间」判断，微信比 pulse 早起就会提示「需要重启微信」。重启微信前先拿微信窗口锁，
别跟正在发消息的那条撞上。

**通话没声音，按这个顺序查：**

1. `scripts/setup-phone-audio.sh --check` —— 设备在不在、默认输出 / 输入对不对、微信是不是比 pulse 早起。
2. 通话进程日志里有没有「通话开始（看到通话窗口）」。没有 → `DISPLAY` 不对、`PHONE_CALL_WINDOW` 跟界面语言对不上，
   或者先用 `PHONE_CALL_PROBE=always` 排除。
3. **她说话，听不到**：日志有没有「→ 桥:」。只有「本底 0 → 开句阈值 120」、再无下文 = 一帧声音都没录到 →
   微信没往 `<PHONE_SPEAKER>` 放（默认输出不对 / 微信连着旧 pulse）。有「跳过·转不出字」= 录到了但不是人话。
   有「转写失败」= key / 网络。
4. **他说话，她听不到**：日志有没有「合成完 N句」。有 → 声音放进了 `<PHONE_MIC_SINK>`，查默认输入是不是 `<PHONE_MIC>`、
   `<PHONE_MIC>` 是不是 `<PHONE_MIC_SINK>.monitor` 的 remap（`--check` 都会查）；再查微信是不是连着旧 pulse。
   没有「他说」→ 桥没递过来：看桥日志里那条有没有记成没送达、`GATE_PHONE_SOCKET` 两边是不是同一个值。
5. 他说「现在没有通话」但明明在通话：通话窗口没被认出来（见 2）。

**为什么不会有回声：** 他的声音只进 `<PHONE_MIC_SINK>` → `<PHONE_MIC>` → 微信采集；通话进程只录 `<PHONE_SPEAKER>.monitor`，
那里只有微信放出来的对方声音。微信本身不把麦克风回放到扬声器。两条路不相交，所以他永远听不到自己说的话，
也不会「自己回答自己」。（要是把两个设备设成同一个、或者默认输出设成了 `<PHONE_MIC_SINK>`，就会出回声 —— `--check` 会报默认设备不对。）

**他说话重复 / 抢话：** 通话进程会在他说完（静了 2.5 秒）之前把她新说的攒着、原样重复的丢掉，说完再一次性递。
45 秒还没说完也放行。

## 8. 费用

- ElevenLabs **按量计费**：转写按音频时长，合成按字符数。电话是实时的，两样都会跑得很快，开通前去后台看好单价、设好额度。
- `PHONE_CALL_PROBE=wechat-window` 时，不在通话里录到的声音（消息提示音）**不送去转写**；`always` 模式下每一声提示音都会转写一次。
- 听语气（north-ear）在本机跑，不花钱。
- 他那头（模型）一句话一轮，跟别的渠道一样算。

---

## English summary

Verified on Ubuntu 24.04, WeChat for Linux 4.1.13.23 (held), Xvfb 21.1, openbox 3.6, at-spi2 2.52, PulseAudio 16.1, ffmpeg 6.1, Node 22, Python 3.12, ElevenLabs.


The **phone leg** lets the agent talk and listen inside a WeChat voice call. The bridge treats it as a normal
channel (`phone`): her speech is transcribed into text and enters the gate; his replies leave the gate and are spoken
by a separate process, `legs/phone/phone.py`.

- **Audio path**: WeChat plays the remote voice into a null-sink (`PHONE_SPEAKER`, default `imb_speaker`, set as
  default output); the phone process records its `.monitor`, splits utterances (VAD), transcribes with ElevenLabs
  Scribe (+ optional north-ear prosody line) and drops `<12-digit-seq>.json` into `GATE_PHONE_INBOX_DIR`. Replies come
  in on the unix socket `GATE_PHONE_SOCKET` as `{"type":"say","text":...}`, are synthesized with ElevenLabs (streaming
  PCM) and played into `PHONE_MIC_SINK`, whose monitor is remapped to the default input `PHONE_MIC`. The two sinks never
  touch, so there is no echo.
- **Setup**: `scripts/setup-phone-audio.sh` (idempotent), `--check` (read-only health check, including "WeChat started
  before PulseAudio → restart WeChat"), `--print-default-pa`, `--print-systemd`.
- **Run**: copy `legs/phone/run.example.sh`, start it under pm2/systemd with `env -i`. Config is env-only (table in §4);
  secrets come from env, `ELEVENLABS_API_KEY_FILE` or `PHONE_ENV_FILE`, never from the repo.
- **Call state**: by default the process watches WeChat's call window (`xdotool search --name`, no accessibility-tree
  scan). Outside a call, `say` returns `ok:false` ("no call"), so the bridge records the line as undelivered instead of
  speaking into a dead line; on hang-up, queued speech is dropped. `PHONE_CALL_PROBE=always` restores the old behaviour.
- **Who speaks first**: if she stays silent after pickup, the process posts one system note to the bridge's producer
  inbox targeted at the phone channel, prompting him to say hello.
- **Troubleshooting**: after a PulseAudio restart WeChat must be restarted too, otherwise both directions are silent.
- **Cost**: ElevenLabs bills STT by audio length and TTS by characters.
