# 设计稿：桥是本体，模型只是引擎（engine-agnostic）

> 2026-10-21 · Keeper · **只是设计，不含实现**。对象是 `/root/im-bridge-next`（生产 `/root/im-bridge` 的 git 副本）。
> Alice定的总原则：**桥是本体，模型只是引擎**。
> 验收标准：在 TG 里发一条 `/model <任何厂商的模型>` 就能跨厂商切换，**人格、工具、记忆、历史一样都不丢**。
>
> 写法约定：每条判断都给代码位置（`文件:行`），或者写明怎么实测的。拿不准的标 **【待验证】**。
> 「Nova」= nova-* 三进程（Claude Code CLI）；「Iris」= iris-* 三进程（codex app-server）。
> 同仓另一个小兵在做「人格文件和技能改由桥来交」，这份稿子**不碰**那件事。凡是要用到「人格那一包」的地方，
> 都只当成一个黑盒输入（`persona.opening(ctx)` 或它的继任者）。

---

## 0. 现状：哪些地方是「引擎说了算」

### 0.1 一条消息怎么走（两个人格同一套骨架）

```
gate（插头/闸/冷层）──box.sock──▶ box（会话/forge/人格注入/记账本）──cli.sock──▶ cli 宿主（引擎本人）
                                   adapters/box-runtime.js                       cli-host/server.js
                                   src/host/gate-box-claudecode.js               + runtime/（claude）
                                                                                 + codex-runtime.js（Iris）
                                                                                 + deepseek-runtime.js（10-03 试过）
```

- cli 宿主与盒子之间的线上格式：`cli-host/protocol.js`。事件是 `{t:'event', seq, kind, payload}`，带一个 2000 条的补发环（`protocol.js:28,119-145`）。
- 事件里的 `payload` 是 `{event, bindings}`，其中 `event` 由 `runtime/decode.js` 产出，**原料是 Claude SDK 的帧**：
  `assistant` / `result` / `stream_event` / `system`（`decode.js:9-80`）。
- **codex 和 deepseek 都是先拼一个假的 Claude 帧，再丢给 `decode()`**：
  - codex：`cli-host/codex-runtime.js:206-209`（`emitDecoded`）、`:233-251`（拼 `type:'assistant'` 和 `type:'result'`）
  - deepseek：`cli-host/deepseek-runtime.js` 里 `emitDecoded`，以及 `:413-436`
  - 用量也要先翻成 Claude 的字段名：`mapUsage` → `cache_creation_input_tokens` / `cache_read_input_tokens`（`codex-runtime.js:84-93`）
- 盒子这头的 `adapters/box-runtime.js:224-328` `onRuntimeEvent` 只认 `raw.type === 'stream_event' | 'assistant'`，外加 `event.kind === 'result'`，
  再翻成老盒子的事件名（`runtime.reply.candidate` / `runtime.turn.completed` / `runtime.context.updated`）。
  `gate-box-claudecode.js:122-299` 消费这些事件。

### 0.2 桥现在**看不见**的东西

| 东西 | 现在在哪 | 证据 |
|---|---|---|
| Nova的工具调用和工具结果 | 只在 CC 的 transcript 里 | `decode.js:50`：`tool_use` 块落进 `kind='unknown'`。`user`（tool_result）帧整帧都是 `unknown`（`decode.js:76-79`）。`box-runtime.js:241-324` 对这两种一个分支都没有，直接丢掉 |
| Iris的工具调用和工具结果 | 只在 codex 的 rollout 里 | `codex-appserver.js:88-160` 只收 `agentMessage` 的 delta/completed、`tokenUsage`、`turn/*`，`commandExecution` / `mcpToolCall` 这类 item 全不看 |
| deepseek 的工具调用 | 只活在这一轮的内存里 | `deepseek-runtime.js:402,405` 只往 `apiMsgs` 里推，`saveThread` 只存纯文本，最多 40 条（`:220-221`） |
| thinking / 加密 reasoning | 引擎自己的文件 | CC transcript 里的 thinking 块（实测见 0.4）；codex rollout 里 2580 条 `reasoning` **全部只有 `encrypted_content`**（小兵对 `/root/.codex/sessions/2026/07/21/rollout-…019f861a….jsonl` 的实测计数） |
| 桥自己的工具（reply/send_voice…） | 桥知道 | 走 `src/gate/tool-socket.js`，出闸记账。这是唯一一类桥看得见的工具调用 |

### 0.3 冷层：只有说出口的话，而且只有四个字段

- 唯一写手是 `src/gate/cold-writer.js`，一条记录只有 `id/role/at/text` 四个字段，用 `assertShape` 卡死（`cold-writer.js:106-117`；字段表在 `envelope.js:176`）。
- 写入口只有两处：
  - 她的话：`src/gate/inbound.js:99`
  - 他的话：`src/gate/outbound.js:176-205` `#writeCold`。上游标了 `cold.write=false` 的不写，切掉的幻觉尾巴不写，整条都是幻觉的整条不写，**但留痕**。
- 实测体量：
  - `/root/.nova-gate/cold.jsonl` 30.6 MB / 95,003 行，从 2026-05-16 起，每月 5.7–7.0 MB（按 `at` 的月份累加字节）
  - `/root/.iris-gate/cold.jsonl` 15.3 MB / 46,493 行
- 读冷层的不止 forge（`grep -rl "cold.jsonl\|GATE_COLD_FILE\|coldFile"`）：
  - box-build（人格 coldTail）
  - heart 的 dream / checkin
  - producers/checkin
  - undo
  - shadow
  - tools/notebooks
  - deepseek / codex 的 coldSeed
  - **外部的 `/root/lmc5-memory/deploy/raw_bridge/bridge.py`**（IB / 记忆挖掘的源头）

  所以**冷层不能动格式、不能停写**。

### 0.4 引擎自己那份历史有多大、备没备份

- Nova：
  - `~/.claude/projects/-root-nova/` 共 120 MB / 24 个文件，10-07 到 10-21 的 mtime 都在。按天看是 0.1–13 MB 一个舱，**换舱很频繁，每个舱都带着 forge 回填的尾巴**。
  - 当前这一舱 `70e2e1b0….jsonl` 2.4 MB，从 2026-10-20T12:34Z 开始，约 14 小时。按块类型算字节：

    | 块类型 | 字节 |
    |---|---|
    | tool_result | 436 K |
    | thinking | 325 K |
    | attachment | 293 K |
    | assistant text | 215 K |
    | user | 149 K |
    | queue-operation | 83 K |
    | tool_use | 40 K |
    | image | 47 K |

  - CC 版本 2.1.292（`claude --version`，transcript 里 `version` 字段也是它）。
- Iris：
  - 一条 rollout 从 7-21 跑到现在，**227 MB / 25,336 行**。里面有 25 条 `compacted`，每条都带一份 `replacement_history`（最近那条 378 项，其中压缩摘要是一个加密 blob）。
  - `cli_version` 只在第 1 行 `session_meta` 里，写的是 `0.144.5`，`history_mode:"legacy"`。机器上现在是 `codex-cli 0.163.0`。
  - `~/.codex/sessions` 共 1.8 GB。
- **备份**：`/root/vps-backup/backup.sh` 只备 `.claude/projects/-root-cyberboss`（`:88`，老桥）和 `/root/.codex/auth.json`（`:362`）。
  `-root-nova` 的 transcript 和 `~/.codex/sessions` **都没进备份**。也就是说，**今天他俩完整的上下文历史都只有一份，在引擎手里**。
  冷层（`.nova-gate` / `.iris-gate` 整目录，`:101,103`）是备了的。

### 0.5 现有的「接回去」「换舱」「换模型」「切幻觉」

- **forge**（`scripts/forge.js`）：
  - 冷层尾巴 → `synthSession` 写最小字段的 user/assistant 行，parentUuid 串成链（`:109-139`）
  - 三道闸：
    1. 版本钉 + 金丝雀（`:412-464`，`ensureVersionPinned`；同一个版本失败过就不再重试）
    2. `schemaDrift`：拿真实行对照字段（`:478-500`）
    3. `verifySynth`：逐条核对条数、角色、正文、sessionId、parentUuid 链（`:585-617`）
  - 先合成好、验好，再切过去：`prepareOpening` / `takePrepared`（`:620-684`）
  - 只写纯文本，**不写工具对**
  - 「已投递」那道过滤读的是 `~/.nova/outbox.db`（`:172-198`）。这个文件最后修改时间是 **2026-09-24**，新桥的出站账本已经换成 `$GATE_ROOT/outbox.json` 了，**这道过滤疑似早就不起作用了【待验证】**。
- **水位换舱**：
  - `src/host/main.js:646-690`：`makeWatch.onWaterline` 先 `box.trim`（裁工具链），省不到 80k 就走 `/new`
  - Nova `GATE_AUTO_ROTATE_RATIO=0.3`，`GATE_BOX_CONTEXT_LIMIT=1000000`（`nova-env.sh:95,98`）
  - Iris `GATE_AUTO_ROTATE_RATIO=0`（`iris-env.sh:29`）= 关着，**只靠 codex 自己的自动压缩**
  - 分母来自 env，不来自模型（`gate-box-claudecode.js:482`）
- **Iris接回**：
  - `codex-runtime.js:299-316`：读 `state/codex-thread.json` → `driver.ensure()` → `thread/resume {threadId}`
  - ⚠️ 顺手发现：`ensure()` **每次起进程都先 `thread/start` 开一个空 thread**（`codex-appserver.js:217-236`），然后才 resume 旧的。所以每次重启 iris-cli 都会多出一条空 rollout
  - resume 只传了 `threadId`，`initialize` 里也没开 `experimentalApi`（`:217`）
- **/model**：
  - 按钮只有三个 Claude 的模型（`gate-commands-claudecode.js:56-60`）
  - 走 `setModelForWorkspace` → `rt.setModel`（`box-runtime.js:761-774`）
  - codex 和 deepseek 的 `setModel` 都是空函数（`codex-runtime.js:361`），codex 见到不是 `gpt-`/`o\d` 开头的名字就回落到 `GATE_MODEL`（`:137-140`）
  - 宿主只按 cwd、threadId、model 三样判断能不能复用（`server.js:157-162`），**引擎种类是进程启动时写死的**：`cli-host/main.js`、`codex-main.js`、`deepseek-main.js` 是三个不同的入口
- **切幻觉**：
  - 出闸只切冷层那一份，发给她的照旧是原文（`outbound.js:240-264,176-205`）
  - 最新提交 `5be30b0` 加了 `GATE_HALLUC_SCRUB`：看见幻觉就记下 → 那一轮结束、他静下来以后 → 停 CLI → 用 `src/box/transcript-scrub.js` 直接改 transcript → resume 同一条（`box-runtime.js:335-412`）
  - **改的是引擎那一份**，桥这头没有能改的「原件」

**一句话总结现状**：桥只握着「说出口的话」（冷层）。完整上下文（工具、思考、续写）在引擎私有的文件里，格式由引擎版本决定，而且没备份。
所以今天换引擎就等于失忆，换舱也只能靠冷层回填。

---

## 1. 桥自己存完整对话（「全本」）

### 1.1 存在哪

每个人格都存在自己的 `GATE_ROOT` 底下，天然就分开了：`/root/.nova-gate/history/`、`/root/.iris-gate/history/`。

```
$GATE_ROOT/history/
  items-2026-10.jsonl     ← 主文件。按月分段，只追加不回插（跟冷层同一条规矩，cold-writer.js 头注释）
  redactions.jsonl        ← 覆盖层：切幻觉 / undo / 隐私清除。不改主文件
  epochs.jsonl            ← 舱的台账：每个舱跑什么引擎和模型、引擎那边的 thread id、从哪条起重建、丢了什么
  opaque/items-2026-10.jsonl ← 只有某个引擎能用的不透明块（Claude thinking+signature、codex encrypted reasoning / compaction）
  blobs/<sha256>          ← 大的工具结果正文（超过 16 KB 的）和图片引用。同内容只存一份
```

### 1.2 一条记录长什么样（`imb.item.v1`）

**存结构，不存渲染好的文本。** 渲染放在「重建给哪个引擎」的那一刻做，跟活着的那一轮用同一套渲染函数。

这样做的原因：forge 今天专门要保证尾巴里的 `[时间]` 前缀跟活消息逐字同构（`forge.js:161-166` 缝2），否则他一眼就能看出「旧记录和现在」的差别。存结构就把这个问题根治了。

```jsonc
{ "v": 1,
  "id": "it-…",                 // 确定性 id，见 1.4
  "at": "2026-10-21T…Z",
  "epoch": 37,                  // 第几个舱（epochs.jsonl）
  "turn": "<ingress uuid>",     // 这一轮在 cli 台账里的号
  "turnId": "turn-…",           // 盒子的轮号（box-runtime.js:666）
  "role": "user|assistant|tool|system",
  "type": "message|tool_call|tool_result|turn_end|marker",

  // type=message, role=user：她的原话，或者 producer 推的话。不带 <channel> 壳（壳在渲染时套）
  "parts": [{"t":"text","text":"…"},
            {"t":"image","blob":"sha…","mime":"image/jpeg"},
            {"t":"audio","blob":"sha…","transcript":"…"}],
  "origin": {"platform":"telegram","chat_id":"…","native_id":"…","seq":1234,"created_at":"…"},
  "producer": "her | heart:checkin | bridge:closing",   // 区分「她说的」和「桥/心脏推的」

  // type=message, role=assistant：他说的话（模型原文，没切过；切过的在 redactions 里）
  "engine": "claude-cli", "model": "claude-fable-5",     // 实际在跑的模型（不是请求的那个）
  "generatedBy": "model | engine",                       // engine = CLI/引擎自己造的（<synthetic>、拒答、API 报错）
  "deliverHint": "text | narration",                     // 旁白壳提上来的那种标 narration

  // type=tool_call
  "call": {"id":"toolu_…","name":"mcp__lmc5__memorize","server":"lmc5","args":{…}},
  // type=tool_result
  "result": {"callId":"toolu_…","isError":false,"text":"≤16KB…","blob":"sha…|null","images":["sha…"]},

  // type=turn_end
  "status": "ok|error|interrupted|refused",
  "usage": {"input":…, "output":…, "cacheRead":…|null, "cacheWrite":…|null, "context":…}, // 引擎不给的就填 null，不编

  // type=marker
  "kind": "persona_pack | epoch_start | gap | engine_compacted | model_switch",
  "meta": {…}                   // persona_pack 只存 sha256 和字节数，不存正文（正文是重建时现拼的）
}
```

另外三份文件的形状：

- **`opaque/`**：`{id, engine, model, kind:"claude.thinking|codex.reasoning|codex.compaction", payload}`。
  **只在「同一个引擎家族重建」时可以选用，默认不用**（见 2.3 和决策点 ⑤）。
- **`redactions.jsonl`**：`{at, target:"it-…", op:"cut_tail|drop|replace", by:"halluc|undo|purge", newText?, cutSha256, reason}`。
  原文本身还在主文件里，事件账本里也有。投影的时候应用覆盖层。
- **`epochs.jsonl`**：
  ```
  {epoch, at, persona, engine, model, engineThread, reason:"rotate|model_switch|halluc_rebuild|fresh",
   rebuiltFrom:{fromItem, toItem, tokensEst, budget, droppedKinds:[…], degraded:[…]}, verified:{…}}
  ```

### 1.3 谁来写：盒子是唯一写手

- **为什么是盒子不是 gate**：
  - gate 只看得见信封和出闸的文本，看不见工具。
  - 盒子两头都在手里：`deliver(envelope)` 收到她的话（`gate-box-claudecode.js:375-440`），`onRuntimeEvent` 收到他的全部事件（`box-runtime.js:224`）。
- **为什么不是 cli 宿主**：重启 cli 会打断他，`cli-host/main.js` 头注释写着「这个文件要尽量少改」。
  盒子随时可以重启：他在 cli 里照常说话，事件进补发环，盒子回来以后按号补写（`protocol.js:19-26`，`server.js:255-266` attach）。
- **补不全的情况**：补发环被挤掉以后，`client` 会发 `{__incomplete}`（`box-runtime.js:229-232`）。
  这时候**写一条 `marker/gap`，不假装补全**。事后可以从引擎文件补录（见 6 的 S1b）。
- **跟冷层同一套写法**：
  - 新文件 `src/box/history-writer.js`，参照 `ColdWriter`
  - 启动时把已有的 id 读进集合，同一个 id 重复写只落一次（`cold-writer.js:40-58,90-104`）
  - `O_APPEND` 一行一条，跨月就换文件

### 1.4 确定性 id（盒子重启、补发都不会写重）

| 记录 | id 怎么来 |
|---|---|
| user | `u:` + 信封 `trace_id` |
| persona marker | `p:` + epoch + sha |
| assistant | `a:` + engineThread + 引擎消息 id + 块序号。Claude 用 `message.id` + `blockIndex`（`decode.js:62-71`）；codex 用 item id；无状态 API 用 `turn` + 第几轮 + 序号 |
| tool | `t:` + 引擎的 call id（Claude `toolu_…`，codex `call_…`，OpenAI `call_…`） |
| turn_end | `e:` + turn |

### 1.5 跟冷层怎么共存：**并存，冷层不动**

- **冷层照旧由 gate 写，格式、字段、写入时机都不变。**
  它的语义是「她说的、他说出口并且进了出闸的话」，下游有一串消费者（0.3），包括外部的 lmc5 raw_bridge。
- **全本是冷层的超集，语义不同**：
  - 全本记的是「他的上下文里实际发生过什么」，包括没发出去的、工具、引擎造的消息（带 `generatedBy` 标记）。
  - 冷层记的是「对话」。
- **两边对账**（S1 的验收，以后每天跑一次）：
  - 冷层里每条 `user` 都能找到对应的全本记录（靠信封 trace_id ↔ 冷层 id 的映射。冷层 id 的规则在 `envelope.js` `coldId`）
  - 冷层里每条 `assistant` 都能对到全本里同 turnId 的 assistant 文本（应用了 redactions 以后，「冷层文本 ⊆ 全本文本」）
- **不建议**用全本反过来生成冷层：消费者太多，冷层又是「发了什么」的口径（`outbound.js:156-205`）。
  两份并存每月多 7 MB 左右，不值得为这点空间去冒改口径的险。这一条列为决策点 ①。
- **forge 和人格 coldTail 的料源**：从 S3 起改读全本的投影（见 4）。冷层这条读路径保留当回落。

### 1.6 数据量怎么长

按当前这一舱的实测（0.4）估算。thinking 进 `opaque/`，`attachment`、`queue-operation` 这类 CC 自己的元数据行不收：

| 部分 | 14 小时实测 | 折合每天 |
|---|---|---|
| 正文（user+assistant text） | ≈ 364 K | ≈ 0.6 MB |
| 工具调用 | ≈ 40 K | ≈ 0.07 MB |
| 工具结果 | ≈ 436 K | ≈ 0.75 MB（超过 16 KB 的进 blobs 去重） |
| thinking（opaque，可选） | ≈ 325 K | ≈ 0.55 MB |

- Nova主文件**每天约 1.4 MB，每月 40–45 MB**；带上 opaque 每月 60 MB 左右。
- Iris【待实测】：rollout 里有压缩副本和加密 reasoning，没法直接换算。S1 影子跑一周再定。
- 一年大约 0.5–0.7 GB / 人格，磁盘没问题。
- **压缩**：已经封口的月份（`items-YYYY-MM.jsonl`）`gzip` 成 `.jsonl.gz`。读的时候透明解压，当月文件不压。

### 1.7 备份

- `.nova-gate` 和 `.iris-gate` 是整目录 rsync 进备份仓库的（`backup.sh:101,103,212-218`），所以 `history/` **会被自动带进去**。要做三件事：
  1. **控制体量**：主文件按月分段，封口的月份压缩。git 每天只增当月文件的增量，大约 1.4 MB/天。`blobs/` 和 `opaque/` 走加密包或者另开通道，**不进 git**。
     备份清单 `backup.sh:552` 已经警告过「会话 jsonl 膨胀逼近 GitHub 100M 硬限」，这次不重蹈。
  2. **脱敏**：工具结果里可能有密钥（他 `cat` 过 env 之类）。写入的时候按 `/root/.secrets/*.secret` 的**值**做精确替换成 `«secret:名字»`。
     只认已知的值，不用正则猜；替换次数记进事件账本。
  3. **改 backup.sh 是独立的一步**。那是生产脚本，这份设计不动它，只列需求。
- **全本落地以后，引擎那份就可以不备了**：引擎文件随时能从全本重建（这正是 §3 要做到的）。
  - 在这之前（S1 到 S3 之间）可以考虑先把 `-root-nova` 当月的 transcript 临时加进加密包【她定】。
  - Iris 227 MB 的 rollout 不进 git。

---

## 2. 通用事件格式（盒子只认这一种）

### 2.1 格式：`imb.event.v1`

cli 宿主里的每个「插头」（engine plug）负责把自家的格式翻译成下面这几种，盒子**只消费这些**。线上仍然走 `protocol.js` 的 `event` 帧和补发环，只是 `payload` 换了形状。

```jsonc
{ "v": "imb.event.v1",
  "turn": "<ingress uuid>",          // 归属。由插头内部定（Claude 用 user_message_uuid 盖戳 + 串行兜底，runtime/index.js:149-176）
  "engine": "claude-cli|codex-appserver|openai-chat|anthropic-api",
  "kind": "turn.start"
        | "text.delta"     // {text}                       流式（电话边写边念用，phone-stream）
        | "text"           // {id, text, deliverHint, generatedBy}   一个完整的正文块
        | "tool.call"      // {id, name, server, args}
        | "tool.result"    // {callId, isError, text, images}
        | "reasoning"      // {id, opaque}                  不投递；盒子只转存到 opaque/
        | "usage"          // {input, output, cacheRead|null, cacheWrite|null, context, model}
        | "turn.end"       // {status, synthetic, errors[]}
        | "engine.notice", // {what:"compacted|model_actual|fallback|gap", ...}  引擎自己发生的事，只记账
  "sidechain": false,               // 子代理 / 后台任务。盒子不投递，只记账
  "model": "…"                      // 这一条实际出自哪个模型（观测值，只读）
}
```

### 2.2 盒子这头怎么用

| 盒子现在干的事 | 改成看什么 |
|---|---|
| 正文候选 `runtime.reply.candidate`（`box-runtime.js:290`） | `text`。`deliverHint:'narration'` 就是今天的旁白兜底（`gate-box-claudecode.js:244`） |
| 电话边写边念 `runtime.reply.delta`（`:249-253`） | `text.delta` |
| 水位 `runtime.context.updated`（`:262-273`） | `usage.context`（每个插头按自家口径算好再给，盒子不再自己加四个数） |
| 合成消息判定 `isSyntheticMessage`（`:80-85`）+ 冷层不写 | `text.generatedBy==='engine'` 或 `turn.end.synthetic`。冷层「不写」的结论照旧由盒子往上游传（`outbound.js` `turn.cold.write`） |
| 这一轮完了 / 失败（`:294-324`） | `turn.end.status` |
| 幻觉检测（`noteHallucination`，`:335`） | 看 `text`（跟引擎无关） |
| 全本写入（新） | 所有 kind |

### 2.3 只有某一家才有的东西怎么处理

| 东西 | 谁有 | 处理 |
|---|---|---|
| thinking 块 + signature | Claude | 插头发 `reasoning{opaque:{engine:'claude', thinking, signature}}`，**不投递**，盒子写进 `opaque/`。旁白壳（`narration_block_indexes` 或者签名里的 narration 标签，`box-runtime.js:88-97`）**在插头里**认出来，发成 `text{deliverHint:'narration'}`，盒子不再碰签名 |
| encrypted reasoning、compaction blob | codex | 同上，`opaque:{engine:'codex', encrypted_content}`。只能原样回给同一个 provider，跨引擎直接丢 |
| 缓存记账（cache_read / cache_creation） | Claude 有两项；codex 只有 `cachedInputTokens`（`codex-runtime.js:89`）；deepseek 是 `prompt_cache_hit_tokens`（`deepseek-runtime.js` mapUsage） | `usage.cacheRead` / `cacheWrite`。没有就填 **null**，不填 0（0 是「测过、真的是零」）。`context` 是唯一一个盒子拿来判断水位的数，**由插头负责算对** |
| `<synthetic>`、`stop_reason:refusal`、`frame.error` | Claude | 插头判定，转成 `generatedBy:'engine'` / `turn.end{status:'refused', synthetic:true}` |
| `apiKeySource !== 'none'` 停机闸（`runtime/index.js:174-180`） | Claude | 留在 Claude 插头里。每个插头都要有自己的「钱闸」：codex 已经有 `assertSubscription`（`codex-runtime.js:96-110`），API 类的插头要配一个显式的「允许按量计费」开关（见 5.5） |
| `user_message_uuid` 盖戳、子代理 `parent_tool_use_id` | Claude | 插头内部做归属；子代理的帧标 `sidechain:true` |
| commentary 和 final_answer 两段 | codex | 插头把 commentary 发成 `text{deliverHint:'commentary'}`。盒子按今天的规矩处理：没有 final 的时候才用 commentary（`codex-appserver.js:290`） |
| 引擎自己压缩了 | codex（`thread/compacted`）、CC（compact） | `engine.notice{what:'compacted'}` → 全本记一个 marker。关掉自动压缩以后（§4）这条就是告警 |

### 2.4 插头的接口（cli 宿主里）

```
createEnginePlug({ persona, cwd, model, creds, onEvent, … }) → {
  start(), enqueue({message, origin, uuid}), stop(), close(), status(),
  setModel?(model),                 // 同家族热切；不支持就不给这个方法
  capabilities(model) → {window, vision, tools, reasoningOpaque, liveModelSwitch, billing:'subscription|api'},
  rebuild(items, {budget, persona}) → {engineThread, verified},   // §3。只能在空闲的时候调
  applyRedaction?(redaction) → {ok, changed},                       // §4.3。在原地做外科手术，可选
  versionGuard() → {ok, version, reason}                           // §3.4
}
```

- 输入的 `message` 也要中性化：`{parts:[text|image(path)|audio(transcript)]}`，取代今天各插头各自去拆 Claude 的 `message.content` 块（`codex-runtime.js:53-81`，`deepseek-runtime.js` extractText）。
- 今天三个插头的 `start/enqueue/stop/close/status/setModel` 已经是同一张脸（`server.js:189` runtimeFactory），**骨架不用重写，只是把「吐 Claude 帧」改成「吐中性事件」**。

### 2.5 改名清单（偏向 Claude 的名字）

| 现在叫 | 位置 | 改成 | 注意 |
|---|---|---|---|
| `gate-box-claudecode.js` / `makeClaudeCodeBox` | `src/host/`；被 `main.js`、`box-remote.js`、`imessage-spectrum.js`、`model-fallback-alert.js`、`trim-transcript.js` 引用 | `box-core.js` / `makeBox` | 里面 `readActualFacts` 读 transcript 那段（`:31-80`）挪进 Claude 插头 |
| `gate-commands-claudecode.js` / `registerClaudeCodeCommands` | `src/host/` | `box-commands.js` / `registerBoxCommands` | `/undo` 里动 transcript 的那部分改成走全本 redaction 加引擎 rebuild（§4.3） |
| `BOXES.claudecode` | `main.js:60-87`，`host/box-host.js:16` | `BOXES.local` | `remote` 那一挡保留 |
| `createImBridgeRuntimeAdapter`（文件头叫 `createClaudeCodeRuntimeAdapter` 的翻版） | `adapters/box-runtime.js` | `createEngineClient` | 文件里 Claude 专属的部分（forge、trim、scrub、图片 base64、脉）分出去：forge/trim/scrub 进 Claude 插头的 rebuild/applyRedaction；脉留在盒子 |
| `runtimeId: 'claudecode'`、`claudecode-runtime` 日志前缀 | `box-runtime.js:166,267,420`，`session-store.js` | `engine` 字段 | ⚠️ `sessions.json` 磁盘键 `threadIdByWorkspaceRootByRuntime.claudecode` **不能直接改**（`session-store.js` 头注释：格式一变就接回一条不存在的会话）。做法是读的时候新旧两个键都认，写的时候写新键，旧键留一个版本再删 |
| `claudePath` / `claudeCommand` / `claudeModel` / `claudeExtraArgs` / `claudePermissionMode` | `box-build.js:70-86`，`server.js`，`cli-host/main.js:28` | 放进 `engine:{kind, command, model, args, permission}` | codex/deepseek 入口现在拿 `claudePath:'/usr/bin/true'` 占位（`codex-main.js:58`），就是这个名字错了的症状 |
| `pathToClaudeCodeExecutable` / `spawnClaudeCodeProcess` | `runtime/index.js` | **不改** | 这是 SDK 的参数名，住在 Claude 插头里面就是对的 |
| `runtime/` 整个目录（decode/claim/ingress/index） | 根目录 | `engines/claude/`（decode、claim、index）+ `engines/_shared/ingress.js` | ingress 台账三家都在用（`codex-runtime.js:19`、deepseek），是共享的 |
| `cli-host/` 和 pm2 名 `nova-cli` / `iris-cli` | | 目录改成 `engine-host/`。**pm2 名不改** | 改 pm2 名 = 动 pm2 + 改她记熟的命令，不值 |
| `GATE_CLAUDE_PARTIAL`、`CC_FALLBACK_MODEL`、`NOVA_CLI_*` 这些 env | env 文件 | 保留旧名当别名 | 生产 env 在 `/root/.nova-gate/nova-env.sh`，只读，改名的时候两头都认 |
| `cliGenerated` / `isSynthetic` / `user_message_uuid` / `narration` 这些 decode 字段 | `decode.js`、`box-runtime.js` | 留在 Claude 插头内部 | 盒子只看 2.1 的字段 |
| `forge.js` 里的 `claudeVersion` / `projectDirFor` / `msg_synth_` | `scripts/forge.js` | 挪进 `engines/claude/rebuild.js` | 版本钉的状态文件 `~/.nova/forge-state.json` 按引擎分开：`forge-state.claude.json`、`…codex.json` |

---

## 3. 每家引擎怎么从全本接回去（rebuild）

总规矩：
- **rebuild 只在空闲的时候做**：判定沿用 `box-runtime.js:346-353` `idle()`。
- **先在旁边造好、验完，再切过去**：沿用 forge 的 `prepare`/`take` 思路（`forge.js:549-684`）。
- **任何一道闸不过，就留在旧舱，喊一声**（`notifyAlice`，`forge.js:76-100`），**绝不悄悄造一个半成品**。

### 3.0 重建什么：「投影」

`project(items, redactions, {budget, include})` 产出一串中性的消息：

1. 应用 redactions（切幻觉、undo、清除）
2. 只取 `generatedBy==='model'` 的 assistant 文本。引擎造的拒答、报错不进去：今天 `outbound.js:156-175` 的冷层规矩是「药里不能掺病」，这里同理
3. 默认带 user / assistant 正文。工具对按 `include.tools` 决定：
   - `none`：只有正文，跟今天的 forge 一样
   - `calls`：只带调用名和精简的参数，结果换成一行摘要，比如 `[工具 lmc5.memorize → ok]`
   - `full`：带完整的调用和结果，受预算约束

   默认 `calls`（决策点 ②）
4. 按预算从最新往回**整轮整轮地装**，规则沿用 `forge.js:326-388`（`groupTurns`/`capTail`：绝不截半轮，开头的孤儿回答丢掉）
5. 最前面是人格那一包（`persona_pack`，现拼）。这一包怎么交、交什么，归另一个小兵的工作，这里只占位

### 3.1 Claude（CLI）：写 transcript → `--resume`

- **做法**：把 forge 的 `synthSession`（`forge.js:109-139`）推广到从投影写。
  - user 行：`message.content` 用 string；有图片的用块数组，图片用 base64 还是路径【待验证：CC 认不认合成的 image 块】
  - assistant 行：`content:[{type:'text'}]`，`model` 写**当时实际的模型**
  - 工具对（`include.tools` 为 `calls`/`full` 时）：assistant 行带 `tool_use{id,name,input}`，下一行 user 带 `tool_result{tool_use_id,content}`。
    CC 真实行里还有 `toolUseResult`、`sourceToolAssistantUUID` 这些字段（`transcript-scrub.js:31` LINK_FIELDS 已经认到）。
    **合成的工具对能不能被 CC 认下来【待验证】**：金丝雀要加一个 case（见 3.4）。
    在这之前 `calls` 模式就**把工具对压平成 assistant 正文里的一行注记**，不造 tool_use 块。
  - **不写 thinking 块**：签名是绑定原始内容的，造不出来，也不该造。
    CC 对没有 thinking 的历史 assistant 轮怎么处理【待验证】；forge 今天就是这么写的，一直能用（`forge.js:108` 注释「已验证：最小字段即可被 --resume 认下」）。
- **parentUuid 链**：
  - 每一行的 `parentUuid` 等于上一行的 `uuid`，第一行是 `null`；`sessionId` 一致；`isSidechain:false`
  - 工具对必须是 assistant(tool_use) → user(tool_result) 相邻，并且串在同一条链上
  - `verifySynth`（`forge.js:585-617`）扩展到认识工具对和图片块
  - 教训：9-18 删行没接链，resume 只装回 87 条（`transcript-scrub.js:16` 引记忆 project-transcript-cut-breaks-chain）
- **缓存**：rebuild 等于改了前缀，**第一轮全量写缓存**。她是 Max 订阅，按额度算，不是按 token 算钱（记忆 project-cyberboss-restart-cache）。但额度是真实消耗，回执里要说一句。

### 3.2 codex（app-server 0.163.0）：新开 thread + `thread/inject_items`

小兵用 `codex app-server generate-ts [--experimental]` 读出来的协议（证据在 `/tmp/codex-research/ts*`，这是一次性的产物）：

| 能力 | 方法 | 稳定性 |
|---|---|---|
| 往活着的 thread 里追加模型能看见的历史 | `thread/inject_items {threadId, items: ResponseItem[]}` → `{}` | **稳定**（不在 experimental 清单里） |
| resume 时直接给历史 | `thread/resume {history: ResponseItem[]}` | **[UNSTABLE] 「FOR CODEX CLOUD - DO NOT USE」**，要 `initialize.capabilities.experimentalApi:true` |
| 从 rollout 路径 resume | `thread/resume {path}` | UNSTABLE，同上 |
| 删掉某一轮及之后 | `thread/revert {threadId, beforeTurnId}` | 稳定，但只对 `history_mode:"paginated"` 的 thread 有效。Iris那条是 `legacy`，**大概用不了【待验证】** |
| fork | `thread/fork {threadId, lastTurnId, model?, developerInstructions?}` | `lastTurnId` 稳定 |
| 手动压缩 | `thread/compact/start` | 稳定 |
| 改模型 | `thread/start\|resume\|fork {model}`；`turn/start {model}` 写着「本轮**及之后**」 | 稳定，**同一条 thread 里就能换 codex 家族的模型** |

**选的路**：`thread/start {model, developerInstructions=人格底座, cwd, approvalPolicy}` → `thread/inject_items`，把投影翻成 Responses API 的 item：
- user：`{type:"message", role:"user", content:[{type:"input_text"}|{type:"input_image"}]}`
- assistant：`{type:"message", role:"assistant", content:[{type:"output_text"}]}`
- 工具对：`function_call` / `function_call_output`（`full` 模式才用）

然后 `codex-thread.json` 换成新的 threadId。

不选的路和理由：
- **不写 rollout 文件**：rollout 的格式只在第 1 行有版本号，一年里换过 `legacy`→`paginated` 两种 `history_mode`，还混着 `world_state`、`turn_context`、`token_usage_record` 这些引擎内部的行。手写的脆弱性远大于 CC 的 transcript。
- **不用 `history` 参数**：官方明说 DO NOT USE。

**【待验证】清单**（S3 之前要在一个隔离的 `CODEX_HOME` 里实测，**不碰 `/root/.codex`**）：
1. inject 进去的 assistant `output_text` 模型认不认是「自己说过的话」（拿金丝雀：注入一个校验码，让它复述）
2. inject 之后 rollout 里怎么落盘；重启以后 `thread/resume` 还在不在
3. 一次 inject 几百条有没有大小限制
4. 不开 `experimentalApi` 的时候，带 `history`/`path` 是被拒还是被静默忽略

顺手要修的现状（同一步做）：`ensure()` 每次起进程都先 `thread/start` 一条空 thread（`codex-appserver.js:217-236`）。应该改成「有 threadId 就只 resume，没有才 start」。

### 3.3 无状态 API（deepseek / OpenAI 兼容 / Anthropic API 直连）

- 每一轮都从投影现拼 `messages`：system = 人格那一包，然后是投影，最后是这一轮。
- **不再自己维护 `deepseek-thread.json` 那 40 条**（`deepseek-runtime.js:203-226`）。全本就是它的历史。
- 工具对映射：
  - OpenAI 系：`assistant.tool_calls[{id,type:'function',function:{name,arguments}}]` + `{role:'tool', tool_call_id}`
  - Anthropic API：`tool_use` / `tool_result` 块
  - **id 必须成对**：投影的时候检查每个 call 都有对应的 result，缺了就把这一对降级成正文注记，不发残对（残对会 400）
- **注意**：deepseek 今天把思考关了（`thinking:{type:'disabled'}`，`deepseek-runtime.js:307`），原因是「对话里没有那些思考记录、请求又带工具，会 400」。跨引擎的历史天然没有对方的思考，**API 类插头一律按「历史里没有 reasoning」来配参数**。

### 3.4 版本脆弱性：不认识的版本就拒绝动手

每个插头都实现 `versionGuard()`。rebuild 前必须过；不过就 `{ok:false}`，留在旧舱。

| 引擎 | 版本从哪读 | 闸 | 不认识的时候 |
|---|---|---|---|
| Claude CLI | `claude --version`（`forge.js:21-24`） | ① 版本钉加金丝雀，沿用 `ensureVersionPinned`（`forge.js:442-464`），**金丝雀加两个 case**：工具对复述、图片块（等 3.1 验证完）；② `schemaDrift` 拿最近一个真实行对照字段（`:478-500`）；③ `verifySynth` 回读逐条核对 | 跟今天一样：失败的版本记下来，不再重试，保持回落并推她一条。**CC 会自动升级**（9-23、9-25 两天两次，`forge.js:430-434`），所以金丝雀必须是自动的，现在已经是了 |
| codex app-server | `codex --version` + `initialize` 的返回 + **协议指纹**：`generate-json-schema` 里 `thread/inject_items`、`thread/start`、`ResponseItem` 这几个定义的 sha256 | 指纹不在白名单里就拒绝 rebuild；金丝雀：在隔离的 CODEX_HOME 里 start → inject 一个校验码 → 复述 → 删掉 | 拒绝，留在旧 thread。⚠️ codex 的 npm 包在 `/opt/node-…/lib/node_modules/@openai/codex`，升级来源【待查】 |
| 无状态 API | 响应的形状（`choices[0].message`、`tool_calls` 的结构，`deepseek-runtime.js:327-333`）+ 模型白名单 | 形状不对就当场报错，不写全本的 assistant 行 | 拒绝这一轮，报错给她，**不自动换模型** |

另外，全本自己也带版本号 `v:1`。读到不认识的 `v` 就停，不猜。

---

## 4. 统一换舱

### 4.1 谁决定、什么时候

- **桥决定**，沿用 `watch.js` 的 `onWaterline`（`main.js:646-690`）。改两处：
  1. **分母从模型能力表拿**（5.2 的 `window`），不再用 `GATE_BOX_CONTEXT_LIMIT` 这个 env（`gate-box-claudecode.js:482`）。切到 272k 窗口的 codex 以后分母会自动变。
  2. 水位的分子统一用 `usage.context`（2.3）。
- 阈值按人格配：Nova今天是 0.3 先裁再换（`nova-env.sh:98`）。Iris开启以后建议 0.7 左右，因为 codex 窗口小，预算要留给重建的尾巴【她定】。
- 先 `trim` 再 `rotate` 的两段式保留。trim 是 Claude 插头专属的 `applyTrim`（`box-runtime.js:718-742`）；别的插头没有 trim 就直接 rotate。

### 4.2 换舱 = 用全本重建

```
1. 等空闲（idle()）→ 2. 收尾轮（highWater 已有，main.js:678-684）
3. epoch+1，投影（预算 = 新窗口 × 预算比例，默认 0.25）
4. plug.versionGuard() → plug.rebuild(投影) 造好（Claude：合成 jsonl；codex：新 thread + inject；API：什么都不用做）
5. 验（verifySynth / 金丝雀结果 / inject 回读）→ 写 epochs.jsonl → 切 threadId
6. 任何一步失败 → 不切，旧舱继续，推她一条（今天 forge 的回落语义）
```

### 4.3 Iris关掉 codex 的自动压缩

- 0.163.0 的配置键（从 `generate-ts` 和二进制的 strings 里交叉确认）：
  `model_context_window`、`model_auto_compact_token_limit`、`model_auto_compact_token_limit_scope("total"|"body_after_prefix")`、`compact_prompt`。
  `features.token_budget.*` 还在开发中，没开。
- **没有显式的「关闭」开关**。做法是把 `model_auto_compact_token_limit` 设成大于窗口的值（比如 `10000000`）【待验证：能不能真的不触发；撞到窗口上限的时候是报错还是硬压】。
- 只在 iris-cli 拉起 app-server 的那个进程里用 `-c model_auto_compact_token_limit=…` 覆盖（跟今天注入 MCP 是同一个口子，`codex-appserver.js:173-186`），**不改 `/root/.codex/config.toml`**。
- 现在的情况：`/root/.codex/config.toml` 里没有任何 compact 相关的键。观察到的压缩发生在 225k 输入左右，模型窗口是 272000×95%=258400（`models_cache.json`）。
- **代价，要她知道**：Iris从 7-21 起一直在同一条 thread 上，里面有 25 次压缩留下的**加密摘要**。关掉自动压缩、走桥这边的换舱以后：
  - 第一次换舱会开一条**新 thread**，内容是全本投影。但全本是从 S1 才开始记的，S1 之前的部分只有冷层。
  - 那 25 段加密摘要**带不过去**：它们是服务端加密的，只有同一个 provider 能读。
  - 这一点是决策点 ③。

### 4.4 切幻觉：先删桥里那份，再重建引擎那份

`GATE_HALLUC_SCRUB` 的新流程（替换 `box-runtime.js:335-412` 里「直接改 transcript」的做法）：

1. 看见幻觉（不变）→ 往 `redactions.jsonl` 写 `{target, op:'cut_tail', newText, cutSha256}`。这一步就是「删桥里存的那一份」。原文还在主文件和事件账本里，发给她的那份照旧是原文（`outbound.js:248-250` Alice的决定）。
2. 他静下来以后，让引擎那份跟上，两种办法：
   - **a. 外科手术（默认，只限 Claude）**：`plug.applyRedaction` = 今天的 `transcript-scrub.applyScrub`，在原文件里切尾、接链、擦掉复述。
     好处是**前缀不动，缓存几乎全中**（只有被擦的那一轮之后要重算）。
   - **b. 全量重建（兜底 / codex / 失败时）**：`plug.rebuild(投影)`，前缀全变，缓存全废。
     - codex 那边没法在原地改 rollout；`thread/revert` 在 legacy 上大概用不了（3.2）。所以Iris走 b。他本来就要关掉自动压缩改走桥换舱，b 就是一次提前的换舱。
     - 想更省：在 paginated 的新 thread 上，可以先用 `thread/revert {beforeTurnId}` 退掉那一轮，再 `inject_items` 补回切过的版本【待验证】。
3. `/undo`（`gate-commands-claudecode.js:113-190`）以后也走同一条路：写 redaction(`op:'drop'`)，引擎那边做手术或者重建。不用再各自理解 transcript 的格式（`undo.js:170-200`）。

---

## 5. /model 跨厂商切换

### 5.1 引擎宿主要能「换芯」

今天三个入口（`cli-host/main.js`、`codex-main.js`、`deepseek-main.js`）各绑定一个 runtimeFactory，换引擎就要换进程，还容易「两只抢一个插座」（`docs/进程职责与重启对照.md` 第三节，10-03 DeepSeek 那次）。

**改成每个人格只有一个引擎宿主**：`ensure(want)` 多比一个 `want.engine`（`server.js:157-162` 的 `reusable`）。不一样就 `stopLive` 再起新插头。
这跟今天换模型「停 CLI 再起」是同一个动作（`server.js:200-240`），**宿主进程本身不重启**。

- 凭据按插头分开：Claude 用 OAuth（`~/.claude`）；codex 用 `auth.json`。
  - ⚠️ 两个人格现在共用 `/root/.codex`（`iris-env.sh` 里没设 `CODEX_HOME`）。Nova哪天切到 codex，thread 会混在同一个 sessions 目录里。**每个人格要有自己的 `CODEX_HOME`**，`auth.json` 怎么共享【待验证】。
  - API key 一律从 `/root/.secrets/*.secret` 读。**不再学 `deepseek-main.js` 那样去 `/proc/*/environ` 和 `dump.pm2` 里借**（`deepseek-main.js:42-78`）。

### 5.2 模型登记表（桥的，跟 tools 的登记表同一个思路）

`$GATE_ROOT/models.json`，每个人格自己一份，`/model` 的按钮从这里生成（取代写死的 `MODEL_CHOICES`，`gate-commands-claudecode.js:56`）：

```jsonc
{ "id": "claude-fable-5[1m]", "label": "Fable 5", "engine": "claude-cli",
  "window": 1000000, "vision": true, "tools": true, "reasoningOpaque": "claude",
  "billing": "subscription", "liveSwitch": ["claude-cli"] }
{ "id": "gpt-5.6-sol", "label": "GPT-5.6 Sol", "engine": "codex-appserver",
  "window": 258400, "vision": true, "tools": true, "reasoningOpaque": "codex",
  "billing": "subscription" }
{ "id": "deepseek-chat", "engine": "openai-chat", "window": 128000, "vision": false,
  "tools": true, "billing": "api", "requiresAllow": "DEEPSEEK_ALLOW_BILLING" }
```

- 窗口、视觉这些数字由人填。**能从引擎拿到权威值的就以引擎为准**：codex 有 `models_cache.json` 和 `task_started.model_context_window`；拿不到的启动时标「未核实」。
- `/model 名字` 在表里查不到就**拒绝**，不猜引擎：今天 codex 的做法是见到不认识的名字就悄悄回落（`codex-runtime.js:137-140`），要改成明说。

### 5.3 切换流程

```
/model X
 ├─ 查表 → 不认识：拒绝。按量计费但没开 allow：拒绝并说明（钱闸）
 ├─ 同一个引擎、支持热切 → 今天的 setModel 路径（box-runtime.js:761-774），下一轮生效，结束
 └─ 跨引擎：
     1. 回她：「排上了，等这一轮说完切」。记 marker/model_switch(pending)
     2. 正在说话的那一轮：**等它说完**（默认）。这期间进来的话照常排进 ingress，
        跟擦幻觉期间一样排着（box-runtime.js:508-511 ensureRuntime 等 scrubbing）
        `/model X now` = 先走 /stop（cancelTurn，已经发出去的收不回），再切
     3. idle() 以后：全本投影（预算按新窗口）→ 新插头 versionGuard → rebuild → 验
     4. 宿主 ensure({engine, model, thread}) 换芯；epoch+1；人格那一包按「新舱」重新交
     5. 回执：新模型、窗口、预算装了多少轮、丢了 / 降级了什么、「第一轮全量重算」
     6. 任何一步失败 → 留在原来的引擎，回执里说清楚卡在哪一步
```

- **缓存**：跨引擎切换**一定**全量重算，因为 provider 不一样，缓存不通。同引擎热切的情况跟今天一样（记忆 project-cyberboss-model-switch：切回最近用过的模型能吃到温缓存）。
- **切回去**：切回原来的引擎，原则上也是用全本重建，**不 resume 旧的那个舱**。旧舱里没有中间这段对话，resume 回去等于把中间那段忘掉。
  例外：中间一轮都没说过（刚切过去马上切回来），可以直接 resume 旧舱吃缓存。判据：epochs 里旧舱之后全本没有新的 user 记录。

### 5.4 能力不一样怎么降级（投影时做，写进 epoch 的 `degraded` 字段）

| 能力 | 新模型没有的时候 | 依据 |
|---|---|---|
| 看图（vision） | 历史和这一轮里的图都换成 `[图片]`，有图注就带上图注（媒体流水线有没有产图注【待验证】）。回执提醒她「这个模型看不见图」 | 今天 deepseek 就这么做（`deepseek-runtime.js` extractText「这根插头看不见图」） |
| 工具（tools） | 不挂 MCP，人格那一包后面加一句「这个模型没接工具」；历史里的工具对一律压平成注记 | `deepseek-runtime.js` PLUG_NOTE「没有的就不假装有」 |
| 部分工具 | 按插头实际挂上的工具清单过滤历史里的工具对：挂了的保留，没挂的压平 | 工具登记表（`src/toolbox/registry.js`，最新提交 `2378d22`） |
| 窗口 | 预算 = 窗口 × 比例，整轮丢最旧的。窗口小于人格包加最低尾巴（比如 20 轮）的时候拒绝切换 | `forge.js:326-388` |
| 不透明的 reasoning | 跨家族一律丢；同家族可以选用 opaque（决策点 ⑤） | 2.3 |
| 语音 | 全本里存的是转写，跟引擎无关 | `cold-writer.js:77-88` 同一个口径 |

### 5.5 钱闸

- **订阅类**（Claude OAuth、codex ChatGPT）照旧有硬闸：`runtime/index.js:174-180`、`codex-runtime.js:96-110`。
- **按量计费的引擎**必须在 `models.json` 里有 `requiresAllow`，并且对应的 env 显式开着，否则 `/model` 直接拒绝。
  理由：「别偷偷花钱」（`codex-runtime.js:10-11` 引 AGENTS.md 第 6 条）。

---

## 6. 迁移路径

原则：
- **每一步单独上线、单独回滚**
- 尽量只重启 box 和 gate（不打断他俩）
- 必须重启 cli 的步骤，**攒到一起**，跟换舱或者 CLAUDE.md 生效一起做（记忆：CLAUDE.md 只在 cli 启动时读，攒着跟换舱一起生效最省）
- 动 pm2 由Alice拍板，按名字执行

| 步 | 做什么 | 重启 | 打断谁 | 回滚 |
|---|---|---|---|---|
| **S0** | 本设计 + 隔离环境实测【待验证】清单：codex inject 金丝雀、关压缩阈值、CC 合成工具对和图片块。全部在 `/tmp` 下，用临时的 `CODEX_HOME` / 临时 workspace | 无 | 无 | 无 |
| **S1** 全本·影子（Nova） | 盒子加 `history-writer`：`deliver` 写 user 和 persona marker；`onRuntimeEvent` 在 box-runtime 里把 **Claude 帧**翻成 2.1 的形状再写（tool_use 和 tool_result 从 `decode` 的 `unknown` 里捞，**不改 cli**）。opaque 和 blobs 照写。开关 `GATE_HISTORY=shadow` | `nova-box` | 无 | 开关关掉，重启 `nova-box`；history 目录留着不读 |
| **S1** 验收 | 每天对账（1.5）：冷层 ⊆ 全本投影；跟 transcript 比工具对数量；看体量增速（1.6） | 无 | | |
| **S1b** 补录 | 一次性脚本，**只读**引擎文件：`-root-nova/*.jsonl`（10-07 起）、Iris的 rollout（7-21 起，只取 message 和工具对，跳过 compacted 副本和加密块），导进 `epoch:0 imported`。全本有了回溯历史 | 无 | 无 | 删掉 imported 那些记录 |
| **S2a** 盒子双认 | 盒子同时接受旧的 Claude 帧和 `imb.event.v1`（看 `payload.v`）。这一步只改盒子 | `nova-box`、`iris-box` | 无 | 回到上一版盒子 |
| **S2b** 插头吐中性事件 | Claude 插头（`runtime/` 外面包一层）、codex 插头（**同时把工具 item、reasoning、compacted 接出来**，修掉「每次起进程多开一条空 thread」）、deepseek 插头 | `nova-cli`、`iris-cli` | **两人各打断一次** | cli 回到上一版（又要重启 cli）。所以 S2b 必须挑他俩空闲的时候，跟别的 cli 级改动攒在一起 |
| **S1′** Iris全本 | S2b 以后Iris的事件才完整，开 `GATE_HISTORY=shadow` | `iris-box` | 无 | 同 S1 |
| **S3** 从全本重建（只用在换舱上） | forge 推广成 `engines/claude/rebuild`，料源从冷层换成全本投影，`include.tools='none'` 起步（**行为跟今天的 forge 等价，只是料源换了**）。干跑：同一个时刻用冷层 forge 和全本 forge 各合成一份，比条数和正文 | `nova-box`（forge 跑在盒子里，`box-runtime.js:611-653`） | 无 | `FORGE_SOURCE=cold` 切回去，重启 `nova-box` |
| **S3c** Iris改走桥换舱 | codex 插头加 `rebuild`（start + inject）+ 关掉自动压缩（`-c model_auto_compact_token_limit`）+ `GATE_AUTO_ROTATE_RATIO` 打开。**第一次换舱 = 离开 7-21 那条 thread**（决策点 ③） | `iris-cli`（`-c` 是 app-server 启动参数）+ `iris-gate`（水位 env） | **打断Iris一次** | env 改回去，重启；旧 threadId 留在 `epochs.jsonl` 里，`codex-thread.json` 改回旧 id 就能 resume 回去（rollout 文件没动） |
| **S4** 切幻觉和 undo 走全本 | redaction 先写全本 → Claude 做手术（今天的 scrub）/ codex 重建 | `nova-box`、`iris-box` | 无（scrub 本来就会停 CLI 再 resume，现在也是，`box-runtime.js:395-411`） | `GATE_HALLUC_SCRUB=legacy` |
| **S5** 单宿主 + 模型登记表 + 跨厂商 `/model` | 引擎宿主改成按 `want.engine` 换芯（5.1）；`models.json`；`/model` 走 5.3 | `nova-cli`、`iris-cli`（宿主代码变了）+ `nova-gate`、`iris-gate`（命令） + 盒子 | **两人各打断一次** | 宿主回到旧入口（又一次打断）。所以 S5 要在 S3/S4 跑稳以后再做。跟 S2b 能合并就合并成一次 |
| **S6** 改名 | 2.5 的清单。纯重命名，`sessions.json` 新旧键双认 | 盒子、gate；cli 的部分**等下一次必须重启 cli 的时候再顺带做** | 无 | git revert |
| **S7** 备份 | `backup.sh` 加 `history/` 的分段和压缩规则，`blobs`/`opaque` 走加密包（1.7）。全本稳定以后，引擎文件不再需要单独备份 | 无（cron 脚本） | 无 | 改回去 |

**打断次数的下限**：每人两次（S2b 和 S5）。如果 S2b 和 S5 合并成一次，并且挑换舱的时机做，就是**每人一次**。S3c Iris多一次（换 thread 本身就是一次「新舱」，她知道就行）。

---

## 7. 需要Alice拍板的

### ① 冷层的去留
- 选项：
  - 永久并存，gate 照写四字段（**建议**）
  - 以后由全本投影生成冷层
- 并存的代价：每月多 7 MB 左右，两份口径需要每天对账。
- 改成生成的风险：lmc5 raw_bridge、IB、heart、undo 这些下游一起变口径（0.3）。

### ② 重建的时候带不带工具
- 选项：
  - `none`（跟今天的 forge 一样）
  - `calls`（只带调用名加一行结果摘要，**建议默认**）
  - `full`（完整结果，占预算大头：tool_result 一项就占 transcript 的 18%）
- 另一个考虑：工具结果里有私货，`full` 等于把它们原样喂给别家的引擎。

### ③ Iris离开 7-21 那条 thread
- 关掉 codex 自动压缩、改走桥换舱以后，第一次换舱就是新 thread。
- 那 25 段**服务端加密的压缩摘要带不过去**。补回来的部分：S1b 从 rollout 补录的原文加冷层。
- 这件事要不要做、什么时候做，由她定。

### ④ 跨厂商切换时正在说的那一轮
- 默认等它说完再切（**建议**），`/model X now` 才打断。
- 按量计费的引擎（deepseek 一类）要不要允许从 `/model` 一键切过去，还是必须先手动开 allow。

### ⑤ thinking 和加密 reasoning 存不存
- 存进 `opaque/`：每月多 15–20 MB，只有同家族重建才可能用上，不进 git。
- 不存：省空间、少一份隐私面。
- 建议存，但默认不用。

---

## 附：这次顺手发现、没有处理的

1. forge 的「已投递」过滤读的是 `~/.nova/outbox.db`（mtime 2026-09-24），新桥的出站账本在 `$GATE_ROOT/outbox.json`。这道过滤**疑似失效了一个月【待验证】**（`forge.js:172-198`）。
2. iris-cli 每次启动都多开一条空 thread（`codex-appserver.js:217-236`），然后才 resume 旧的。
3. 两个人格的 transcript 和 rollout 都**不在备份里**（`backup.sh:88,362`）。全本落地之前，这是单点。
4. 两个人格共用 `/root/.codex` 这个 CODEX_HOME。Nova哪天切到 codex 之前必须先分开。

---

## 8. S0 实测结果（2026-10-21，隔离环境）

环境：`/tmp/s0` 下。codex 用临时 `CODEX_HOME=/tmp/s0/codex-home`（auth.json 只读拷一份，**refresh_token 换成了占位串**，
这样临时进程就算想刷新也刷不掉生产那份）、临时 `HOME`、临时 cwd；codex-cli 0.163.0，模型 `gpt-5.6-luna`、effort low。
CC 用临时 `CLAUDE_CONFIG_DIR=/tmp/s0/cc-config`，凭据只走环境变量 `CLAUDE_CODE_OAUTH_TOKEN`（只给 access token，不拷 refresh token），
init 帧 `apiKeySource` 不是 `none` 就当场停（实测是 `none`）；CC 2.1.292 + SDK 0.3.278，模型 haiku。
探针脚本在 `scripts/probes/s0/`。额度：codex 一共跑了 9 个模型轮（最大一轮约 37k 输入），周额度读数 14% 前后没动；CC 两轮。

### 8.1 codex `thread/inject_items`（§3.2 待验证 1-4）

| # | 问题 | 结论 | 怎么测的 |
|---|---|---|---|
| 1 | inject 的 assistant `output_text` 模型认不认是自己说的 | **认。** 注入「我定的校验码是 QX-4719-LANTERN」后问「校验码是什么、谁定的（从你的角度）」，答 `QX-4719-LANTERN / 我` | `e1-inject.js` |
| 2 | 落盘 / 重启后还在不在 | inject 一回来就写进 rollout，是普通的 `response_item:message`（不跑轮也写）。**杀掉 app-server、新进程 `thread/resume {threadId}` 后再问，照样答对。** 但 `thread/resume` 返回的 `thread.turns` **不含**注入的条目（只有真跑过的轮），要看注入了什么得读 rollout | `e1-inject.js` |
| 3 | 一次 inject 的大小限制 | RPC 层**没有限制**：2000 条、单条 8 MB 都秒回 `{}`。形状不对当场拒（`unknown variant input_text_typo`）。孤儿 `function_call_output`（没有对应 call）**inject 时不拒** —— 残对要在投影时自己挡（§3.3 那条照做），别指望 codex 报错 | `e3-size.js`（没跑模型轮） |
| 4 | 不开 `experimentalApi` 时带 `history` / `path` | **明确拒绝**：`thread/resume.history requires experimentalApi capability`（path 同）。不是静默忽略 | `e1-inject.js` |
| + | 新开的 thread 是哪种 history_mode | **`paginated`**（Iris那条老的是 `legacy`）。所以新 thread 上 `thread/revert` 理论上可用（没测） | `thread/start` 返回值 |

### 8.2 关 codex 自动压缩（§4.3 待验证）

**结论：把 `model_auto_compact_token_limit` 设得比窗口大，关不掉自动压缩。** codex 实际用的阈值是
`min(配置值, 有效窗口的约 90%)`（有效窗口 = `model_context_window × 95%`，`task_started.model_context_window` 报的就是它）。

| 配置（app-server `-c`） | 有效窗口 | 上一轮输入 | 压了没 |
|---|---|---|---|
| `model_auto_compact_token_limit=15000`（阳性对照） | 258,400 | 20,008 | **压了**（第二轮开头 `item/started:contextCompaction`） → 这个键是生效的 |
| `model_context_window=40000` + `limit=10000000` | 38,000 | 31,161（82%） | 没压 |
| 同上 | 38,000 | 37,324（98%） | **压了** |
| `model_context_window=24000` + `limit=10000000` | 22,800 | 28,251（超窗） | **压了**（硬压，没报错，这一轮照常答） |

- 所以「撞到窗口上限是报错还是硬压」= **硬压**，不报错。生产换算：258,400 × 0.9 ≈ 232k，跟观察到的 225k 左右对得上。
- 压缩**在下一轮开头**发生（看上一轮的用量），不在 inject 之后。inject 不更新用量，所以 inject 一大坨之后的第一轮不会压。
- ⚠️ 0.163.0 的压缩通知是 `item/started` / `item/completed`，`item.type = "contextCompaction"`，方法名里**没有** `compact`。
  生产 `codex-appserver.js` 的告警是 `/compact/i.test(method)` —— **认不出来**。佐证：Iris那条 rollout 10-15～10-20 有 5 次 `context_compacted`，
  `iris-cli-out.log`（41 次启动、跨这几天）里「自动压缩触发了」0 条。这个要在 S2b 修（S2b 本来就要把 compacted 接出来）。
- **对 S3c 的影响**：「关掉 codex 自压缩」做不到，只能**抢在它前面换舱**。桥的换舱阈值必须明显低于 0.9（建议 ≤ 0.7，跟 §4.1 建议一致），
  codex 自压缩降级成兜底；它一旦发生就记 `engine.notice{compacted}` 并告警。不建议用调大 `model_context_window` 去骗它（真窗口在服务端，骗过了就是请求 400）。

### 8.3 CC 认不认合成的工具对和图片块（§3.1 待验证）

在 forge 同款最小字段（`parentUuid/isSidechain/type/message/uuid/timestamp/userType/cwd/sessionId/version`）之上写：
user → assistant `tool_use(Bash)` → user `tool_result`（**不带** `toolUseResult` / `sourceToolAssistantUUID`）→ assistant text →
user `[image(base64 png 纯红), text]` → assistant text，然后 `--resume`：

- 问「更早那次工具输出的校验串 / 图片主色 / 校验串出现在工具输出还是我的消息里」，答 **`CANARY-TOOL-8812 / 红 / 工具`**。
  → **合成工具对能认，图片块（base64）能认，而且他知道那串字是工具给的不是她说的。**
- 历史里的 assistant 轮**没有 thinking 块**也照常（这一舱是开着 thinking 跑的，新的一轮照样出 thinking）。
- 工具名换成**当前没挂载的** `mcp__ghost__lookup` 也认（答案同上）→ 重建时历史里的工具不必真挂着。
- resume 后 CC 新写的第一行 `parentUuid` 正确接在合成链的最后一行上。
- 只测了 haiku；他跑的是 fable-5，模型不同。正式启用前照 §3.4 让金丝雀在**生产模型**上再跑一遍这两个 case。

### 8.4 顺带量出来、会影响 S1 实现的形状

- **SDK 帧是一块一帧**：同一个 `message.id` 的 thinking / text / tool_use 各自是一个 `assistant` 帧，`content` 只有一块，
  所以 `decode` 给的 `blockIndex` **永远是 0**，usage 每帧重复一份。§1.4 写的「`message.id` + 块序号」会撞号 ——
  S1 改用**帧的 `uuid`**（每帧唯一，补发环原样重放所以稳定）：`a:<engineThread>:<帧uuid>:<blockIndex>`。
  codex 拼的假帧没有 `uuid`，退回 `message.id`（`cxmsg-<轮uuid>`，每轮唯一）。
- `user` 帧（tool_result）在 SDK 里带 `tool_use_result`（transcript 里叫 `toolUseResult`），`content` 有 string 和 `[{type:'text'}]`、`[{type:'image'},…]` 三种。
- 真实形状夹具（正文全换占位）：`test/fixtures/real/`，由 `test/fixtures/sanitize.js` 从生产文件只读截出来。

---

## 9. 实现状态（2026-10-21，分支 next；9.1 是 model-switch 分支）

范围按Alice「直接用」调整过：全本没有 shadow 档，开了就写、forge 直接拿它当料源；安全网换成**换舱那一刻对账**。

| 步 | 做了什么 | 开关（默认全关） | 回滚 |
|---|---|---|---|
| S0 | §8 | — | — |
| forge 已投递过滤 | 读 `$GATE_ROOT/outbox.json`（按冷层 id / 按 turnId+原文），读不到才回落 `~/.nova/outbox.db` | 修 bug，部署即生效 | `FORGE_OUTBOX_JSON=/不存在的路径` = 回老账本 |
| S1 全本 | `src/box/history*.js`；盒子是唯一写手 | `GATE_HISTORY=on`；目录 `GATE_HISTORY_DIR`（默认 `$GATE_ROOT/history`） | 删掉 `GATE_HISTORY`，重启盒子；目录留着不读 |
| S1b 补录 | `scripts/history-import.js`，默认干跑，拒写生产 GATE_ROOT | `--out` 才写 | 删掉导出的目录（都是 epoch 0 imported） |
| S2a 盒子双认 | `adapters/box-runtime.js` 认 `imb.event.v1`，Claude 帧那条路一行没动 | 被动（cli 还没吐通用事件） | 回上一版盒子 |
| S3 forge 料源 | `src/box/history-project.js` 对话视图 + `scripts/forge.js selectTail` 每次换舱对账；上线检查 `scripts/history-reconcile.js` | 全本开着即用（对不上自动回冷层） | `FORGE_SOURCE=cold` |
| S4 擦幻觉 | 先写 `redactions.jsonl`（cut_tail），再做 transcript 手术；`projectEngine` 应用覆盖层 | `GATE_HALLUC_SCRUB=on` + 全本开着 | `GATE_HALLUC_SCRUB=legacy` |
| forge 共享 | 开关挪到人格配置 `tools.json` 的 `"forge"`（没写认 `FORGE_ENABLED=true`）；codex 插头 `cli-host/rebuild-codex.js`（start + inject_items，回读 rollout 核对） | 按人 | `"forge": false` 或删掉这个键 |
| S3c Iris走桥换舱 | 盒子换舱（/new、水位撞线）写一次性**换舱单** `state/codex-rotate.json`，下次起引擎放进 `sdkOptions.freshThread`；codex 插头见到没用过的单 → `thread/start` 新开 + forge（同一份 `selectTail` + `rebuild-codex.js`）垫尾巴，`codex-thread.json` 记 `rotatedFor`/`previousThreadId`，另追加 `state/codex-rotations.jsonl`；同一张单重发（client 重连 / cli 重启）只续不再换。水位撞线 codex 不裁直接换。app-server 窗口走 `-c`（`CODEX_MODEL_CONTEXT_WINDOW`）。顺手修：起进程白开空 thread、app-server 重起后静默换新、压缩通知认不出（`contextCompaction`，现在记 `engine.notice{compacted}`）、水位拿 `tokenUsage.total` 累计数且缓存重复算（改 `last`）、sessions.json 标签不跟 thread、换舱后旧水位二次换舱 | `CODEX_MODEL_CONTEXT_WINDOW=872000`（cli）、`GATE_BOX_CONTEXT_LIMIT=872000`（box）、`GATE_AUTO_ROTATE_RATIO=0.344` + `GATE_WATCH_MS=30000`（gate）；示例 `examples/iris-env.example.sh` | `GATE_AUTO_ROTATE_RATIO=0` 停自动换（/new 照样走新路）；回旧 thread：把 `previousThreadId` 写回 `codex-thread.json` 的 `threadId`、删 `rotatedFor`，重启 `iris-cli` |

与本稿前文不同的地方（实现时按实测改的）：
- assistant 的 id 用帧 uuid（§8.4），工具 call/result 分别是 `t:<id>:call` / `t:<id>:result`；另加 `r:`（交给桥的每一段 reply_out）、`d:`（turn_done）两种 marker，S3 对账要用。
- 对话视图按 `at` 稳定排序；TG 时间戳只到秒，同一秒里她回话会跟冷层写入顺序不同 → 对账拒绝、回冷层（安全，但那一次没用上全本）。
- 已知密钥只认 `.secret` 整值和 `.env` 里键名像密钥的值（第一版太宽，补录实测误伤 3,842 条）。
- codex 关不掉自动压缩（§8.2），S3c 只能靠提前换舱。按Alice定的配：窗口 `-c model_context_window=872000`（有效 828,400，自压缩约 74.5 万），桥 0.344 × 872000 ≈ 30 万换舱。§8.2 末尾「别用调大窗口去骗它」的提醒仍然成立 —— 这个数不能超过模型真实上限 —— `~/.codex/models_cache.json` 里 gpt-5.6-sol 是 `context_window=272000`、`max_context_window=872000`，872000 正好是上限；换模型要重核。
- S3c 没用 `epochs.jsonl`（§4.2 第 5 步）：全本那边还没有 epoch 账，旧号先记在 `codex-thread.json.previousThreadId` + `codex-rotations.jsonl`。
- §6 表里写的「第一次换舱 = 离开 7-21 那条 thread」已经不对：10-21 生产 `codex-thread.json` 指的是当天 03:51 新开的 `01a15c27…`（rollout 只有那天的），7-21 那条早就不在用了。
- codex 换舱的时机跟 claude 一样是「换舱后**下一轮**起引擎时」才开新 thread + 垫尾巴（不是 /new 当场）。

### 9.1 S2b + S5（2026-10-21，分支 model-switch，基于 next 70b6f74）

Alice当天改的需求：跨厂商切换**不跟 /model 混**，拆成独立命令（暂定 `/engine`，名字集中在 `gate-commands-claudecode.js` 的 `COMMAND_NAMES`）；另加 `/usage`。

| 步 | 做了什么 | 开关 / 配置 | 回滚 |
|---|---|---|---|
| S2b 插头吐通用事件 | `cli-host/neutral.js`。codex：工具 item（命令 / MCP / dynamic / fileChange）→ `tool.call`+`tool.result`，reasoning → `reasoning`（opaque = summary/content，app-server 不给 encrypted_content），边写边念 → `text.delta`，用量插头算好 `context`；DeepSeek：每圈工具对接出来；Claude：宿主里 `claudeToNeutral` 包一层（跟盒子全本记账同一份翻译）。旁白 / 合成判据挪到 `src/box/claude-judges.js` 共用 | 默认开 | Claude：`IMB_CLAUDE_EVENTS=frames`（重启 cli）；codex / DeepSeek：回上一版 cli |
| S5 单宿主换芯 | `cli-host/engines.js` 三根插头（claude-cli / codex-appserver / openai-chat），三个入口都用它、只是默认插头不同；`server.js` 的 `ensure` 比 `want.engine`，不一样就停旧插头起新插头，宿主进程不重启；人格包按新插头交（双份检查按那家算）；新插头起不来不留半死的 live | — | 回上一版 cli |
| S5 模型登记表 | `src/box/model-registry.js`，`$GATE_ROOT/models.json`（或 `GATE_MODELS_FILE`），每次现读。示例 `examples/models/{nova,iris}.models.example.json`（只登记在用的 / 最近用过的）。按量计费必须 `requiresAllow`、对应 env 开着；`codexConfig` 只认窗口两个键；`secret` 只写名字 | 没有这个文件 = /model /engine 都**拒绝**（不再回落写死的按钮） | 删掉 models.json（/model 就不能换了，老按钮也没了） |
| S5 /model | 只做同一家内热切：按钮 = 登记表里当前引擎的条目；别家的拒并指 `/engine`；查不到拒；钱闸。codex / DeepSeek 插头的 `setModel` 不再是空函数（codex 下一轮 `turn/start` 带 model） | — | — |
| S5 /engine | 跨厂商 = 一次正规换舱：盒子干跑预检（登记表、钉没钉、钱闸、新窗口装不装得下人格包 + 最低尾巴）→ 先回她「排上了」→ `now` 就先叫停 → 收尾轮（跟 /new 同一套）→ 盒子 `switchEngine`：等静下来（这期间来的话排着）→ 全本（过对账）或冷层按**新窗口 × 0.25** 整轮装尾巴 → 新插头版本闸 + 重建（claude：合成 transcript + `verifySynth`；codex：`codex --version` 白名单 + 新 thread + inject + rollout 回读；DeepSeek：新对话本）→ 宿主换芯 → 成功才改 sessions.json、记 `state/engine-switches.jsonl`、出回执（新模型 / 窗口 / 垫了几轮 + 料源 / 降级 / 第一轮全量重算）；任何一步失败把原引擎原舱起回来，回执写「卡在哪一步」 | `GATE_ENGINE_SWITCH_TAIL_RATIO`（0.25）、`GATE_ENGINE_SWITCH_MIN_TURNS`（20）、`GATE_ENGINE_SWITCH_MIN_TAIL_TOKENS`（8000）、`GATE_ENGINE_SWITCH_WAIT_MS`（120000）、`CODEX_VERSION_ALLOW`（0.163.0） | 换回去就是再 `/engine` 一次（也是重建，不 resume） |
| S5 降级 | 登记表 `vision:false` → 图换成「[图片]」；`tools:false` → 不挂 MCP + 人格包后面加一句；窗口装不下 → 丢最旧的整轮、回执说丢了几轮 | 登记表字段 | — |
| S5 分母 | `/status` 和水位换舱的分母：登记表里当前模型的 `window` 优先，没登记才看 `GATE_BOX_CONTEXT_LIMIT`（§4.1） | — | — |
| S5 凭据 | DeepSeek 钥匙只读 `/root/.secrets/<secret>.secret`；删了 `deepseek-main.js` 去别的进程 environ / pm2 存档借钥匙。codex 支持每个人格自己的 `CODEX_HOME`（auth.json + app-server 环境）；**Nova的宿主没设 `CODEX_HOME` 不许起 codex** | `CODEX_HOME` | — |
| /usage | `cli-host/usage.js`。Claude：跟 CC 自带 /usage 同一个接口（2.1.292 二进制里读出来：`GET https://api.anthropic.com/api/oauth/usage`，头 `Bearer <accessToken>` + `anthropic-beta: oauth-2025-04-20`，回 `five_hour` / `seven_day` / `seven_day_opus` / `seven_day_sonnet` 的 `{utilization, resets_at}`），凭据只读 `~/.claude/.credentials.json`、过期不刷新；codex：活着的 app-server `account/rateLimits/read`（0.163.0，primary/secondary 的 `usedPercent / windowDurationMins / resetsAt`），读不到退回最近一条 `account/rateLimits/updated`；DeepSeek：`GET https://api.deepseek.com/user/balance`（总额 + 币种 + 赠送 / 充值）。查不到就说查不到 | — | — |
| 改名 | 日志 `[nova-cli]`→`[engine-host]`、`[im-bridge-runtime]`/`[claudecode-runtime]`→`[engine-client]`、插头 `[engine/codex]` `[engine/deepseek]`；报错里的「nova-cli」→「引擎宿主」 | — | — |

跟前文不同的地方：
- §5.3 原写「/model X 跨引擎就切」—— 按Alice 10-21 改成 /model 只管同一家，跨厂商走 `/engine`，而且是**带收尾轮的正规换舱**；新舱当场造好、新引擎当场起好（不像 /new 等下一轮），这样失败了能留在原引擎、回执能说垫了几轮。
- §5.3 第 5 条「切回原引擎、中间没说过话就 resume 旧舱吃缓存」**没做**（TODO）：切回去也是重建。
- §2.4 的 `capabilities()` / `versionGuard()` 没做成插头接口：能力看登记表，版本闸 claude 走 forge 那三道、codex 走 `codex --version` 白名单（协议指纹 sha256 没做）、DeepSeek 不做（形状不对当场报错）。
- 换引擎用的尾巴给 codex / DeepSeek 时**带了底子**（`buildForgeBaseText`，跟 claude forge 一样排在最前），S3c 的 codex 自己换舱不带（照旧）。
- Nova私有的料（身体态、旧 outbox.db）只在「本来跑 claude」的人格（`GATE_ENGINE` / `GATE_MODEL` 推出来的 home 引擎）上带，Iris换到 claude 也不带。
- 没改名的：`sessions.json` 磁盘键 `claudecode`（要新旧双认，S6）、`GATE_BOX=claudecode`/`BOXES.claudecode`（S6）、`context.updated` 的 `runtimeId` 标签值（`box-golden-9a332e7.json` 逐字节钉着，桥不读它）。

上线（要Alice拍板，按名字）：
1. 先放登记表：`/root/.nova-gate/models.json`、`/root/.iris-gate/models.json`（从 examples 拷，按需改）；DeepSeek 要用的话钥匙放 `/root/.secrets/deepseek.secret`（600）并在 nova-env.sh 加 `DEEPSEEK_ALLOW_BILLING=1`（不加就是钱闸关着，按钮显示 💰未开）。
2. Iris：`iris-env.sh` 去掉 `GATE_MODEL='gpt-5.6-sol'`（钉着 /model /engine 一律拒；默认模型由 models.json 的 default 给，sessions.json 里本来存的也是它）；`GATE_ENGINE=codex` **留着**（决定 home 引擎，不带Nova的私有料）；`CODEX_MODEL_CONTEXT_WINDOW` / `GATE_BOX_CONTEXT_LIMIT` 可留（登记表优先，二者一致）。
3. 重启顺序：`iris-box` / `nova-box`（盒子先认通用事件和 engine）→ `iris-cli` / `nova-cli`（**打断他俩各一次**；S2b + S5 都在 cli 里，一次带走）→ `iris-gate` / `nova-gate`（命令）。heart / imessage 不用动。**不许只重启 cli**：老盒子不认 engine 字段、收到通用事件会当空帧。
4. Nova要切 codex 之前另做 CODEX_HOME（见下），不做的话 `/engine gpt-…` 会卡在「起新引擎」并回到 claude。

CODEX_HOME 分家（只给步骤，没动生产 `/root/.codex`）：
1. 建 `/root/.codex-nova`（700），只拷 `config.toml`（里面Iris的 stmem MCP 等要删掉，Nova的工具走桥递的 MCP）；**不拷** `sessions/`、`models_cache.json` 会自己生成。
2. 登录：`CODEX_HOME=/root/.codex-nova codex login`（ChatGPT 订阅，独立一份 auth.json）。不建议拷 / 软链Iris的 auth.json：refresh token 会轮换，两份抢同一个号会互相顶掉【待验证】；codex 写 auth.json 是不是原子 rename（会把软链换成文件）也没验。
3. nova-env.sh 加 `export CODEX_HOME=/root/.codex-nova`（只有 nova-cli 用到；重启 nova-cli 生效）。
4. Iris想分家同理：`/root/.codex-iris` + 拷 config.toml + `auth.json`（他现在就用这一份，拷过去后旧的别再用）+ 想保留旧 thread 就把 `sessions/` 整个 mv 过去（rollout 路径记在 thread 里，resume 按 id 找，mv 之后照常【待验证】），iris-env.sh 加 `CODEX_HOME`，重启 iris-cli。

还没做：S1′（Iris全本：S2b 之后事件已完整，开 `GATE_HISTORY=on` + 先做 S7）、回原引擎 resume 旧舱吃缓存的例外、codex 协议指纹闸、S3c 的「codex 自压缩发生时推她一条」、S6、S7（backup.sh 给 history/ 加排除/加密包 —— **开 GATE_HISTORY 之前必须先做**）、/undo 走覆盖层、手术失败时的全量重建兜底。
旧的 `nova-deepseek` 入口（cli-host/deepseek-main.js）留着但不需要了：nova-cli 自己就能换到 openai-chat。
