# CLI 那一层 —— 架构稿 v2（改用官方 SDK）

> 2026-09-19 傍晚。v1（自己写 2,808 行）经两轮外审 + 实测后整个翻掉，留档在 `runtime-arch-v1.md`。
> 那 13 条规则仍然有效，见 `runtime-rules.md`。

## 0. 为什么翻掉 v1

审到第三轮，跑在 Claude Code 里的那位（fable 5.1）指出一件没人考虑过的事：
**`@anthropic-ai/claude-agent-sdk` 就是 `process-client.js` 的官方版本** ——
同一个二进制、同一套协议、有类型、自带 setModel/interrupt/resume/流式输入。

Alice的直觉是对的：「既然有 cyberboss 这种桥出现，官方 SDK 必定有覆盖不到的地方」。
查时间线，答案很干净：

| | |
|---|---|
| 2025-09-27 | SDK 第一版 |
| **2026-04-17** | 原作者写 `process-client.js`（当时 SDK 0.2.104） |
| 2026-07-22 | "排队轮 threadId 被清空"事故 → 他发明"写入顺序对齐" |
| 2026-09-03 | 旁白块吞正文事故 → 他猜了 `thinking_tokens=0` 这个判据 |
| 今天 | SDK 0.3.278（304 个版本，最新的就是今天） |

实测 0.2.104 那版：`setModel`/`origin`/`interrupt`/`forkSession` 都有，
但 **`user_message_uuid` 没有、`narration` 没有** —— 正是他后来吃事故补上的两处。
而且他猜的 `thinking_tokens=0` **是错判据**，官方的 `narration_block_indexes` 才对。

**不是重复造轮子，是那两个轮子当时还没造出来。**
→ 重写的姿势不是照着老代码写一遍，是**拿 13 条规则去问 SDK：这条你管了吗**。

## 1. 实测确认过的（不是读类型定义猜的）

探针在 `/root/im-bridge/fixtures/`，同一句话跑两遍：裸 CLI 一遍、走 SDK 一遍，对照。

1. **`user_message_uuid` 真能认领。** 写进去的消息自己挂 uuid，回来盖在
   **这轮第一个 assistant 帧**和 **result** 上。文档原话：
   `binds the reply to the send it answers **without waiting for the result**`。
   还有 `user_message_uuids`（数组）：批量合并成一轮时，发过其中任何一条的都能认领。
2. **SDK 给的是生的。** 对照裸 CLI：一条没吞、一条没合并，只多 `command_lifecycle`
   和它自己的 `uuid`。→ 判据仍要我们写，但**它不会在背后替我们做决定**。
3. **同一个二进制。** `pathToClaudeCodeExecutable` 指的就是本机的 `claude`。
   不是换引擎，是换调用方式。
4. **我们在用的每个 CLI 参数它都有**，外加 **`extraArgs` 逃生口**（没封装的原样透传）
   → 不存在被锁死。

## 2. 13 条规则逐条问 SDK

| 规则 | 归谁 | 怎么落 |
|---|---|---|
| **B-1** 来源用结构化字段 | **SDK** | `SDKUserMessage.origin` |
| **B-2** threadId 入队定死 | **SDK，更好** | `user_message_uuid` 协议层盖戳。老代码那套"pendingTurns 顺序 == stdin 写入顺序 == turn.started 顺序"**整个不需要了** |
| **D-5** 同会话换模型 | **SDK** | `query.setModel()` |
| **F-1** token 级流式 | **SDK** | `includePartialMessages` |
| **D-1** 只看信封认"CLI 造的" | SDK 给料，判据我们写 | assistant 帧上 `error?: SDKAssistantMessageError`（13 种）+ `isSynthetic`。**仍然只看信封不看正文** |
| **D-2** 旁白块当正文送 | SDK 给料，判据我们写 | 读 `narration_block_indexes`。⚠️ **`thinking_tokens=0` 是错判据，扔掉** |
| **A-1** ack 等真结果 | 一半 SDK | 控制方法返 Promise；"她那条到底送到没"仍要自己记 |
| **A-2** 没活进程不许丢消息 | **我们** | `ingress.js`，见 §3 |
| **C-1** 不许重复注入 | **我们** | prompt 完全由我们给，SDK 不会自己加 |
| **C-2** 交接摘要不漏进群 | **我们** | 纯业务 |
| **D-3** 实际模型只落只读快照 | **我们** | `message.model` 是观测值，永不写回请求值（写回会抹掉 `[1m]`） |
| **D-4** `--fallback-model` 别指望 | 知识不是代码 | 它走 availabilityFallbackChain，**拒答走另一条**，两个独立状态 |
| **E-1** 180 秒超时 | **不属于这层** | 那是 DeepSeek 重建快照的超时 |

**这轮新增的两条**（都属于"她会收错东西"）：

- **`parent_tool_use_id` 非 null = 子代理输出。** 不过滤，**子代理的话会当他的话发到她手机上**。
- **`result` 才是真边界。** `end_turn` 之后 Stop hook 能让它继续跑，
  所以"这轮结束了"只认 result 帧。

## 3. 还剩什么要写

```
runtime/
  decode.js    SDK 消息 → 规范事件      判据都在这儿，纯函数，好测
  claim.js     用 user_message_uuid 认领  入队绑 uuid，回包按 uuid 归属
  ingress.js   可靠投递（落盘 + 三态）    ← 唯一 SDK 不管的硬骨头
  index.js     装配：query() + 上面三个
```

估 **400 行上下**（v1 是 2,808）。

### `ingress.js` 必须原样守住的规则

老代码 `src/adapters/runtime/claudecode/reliable-ingress.js` 只有 56 行，
是整个项目最值钱的 56 行之一。**实现重写，规则一个字不许改**：

| 崩在哪 | 转成 | 因为 |
|---|---|---|
| `dispatching` | `pending` | 确定没提交 → **可安全重放** |
| `started` | `uncertain` | **可能已提交** → **绝不自动重放**，留着对账 |

⚠️ **落盘必须在写 stdin 之前**（老代码注释原话：
`Durable ingress must record the side-effect boundary **before** stdin write`）。
挪到写之后 = 重新打开"已经写进去、重启却自动重放"的窗口 ——
重放意味着他把同一条消息发她两遍、或者同一个工具跑两次。

## 4. 进程没了怎么办

v1 设计的"跨代次认领迟到结果"是**死代码** —— 等进程 close 之后再起新的，
旧轮的结果不可能出现（进程没了没人给结果）。真实存在的"迟到"只有一种：
**exit 时 stdout 还没读完的尾巴**。

阶梯，**等 `close` 不等 `exit`**：

```
interrupt() → SIGTERM → SIGKILL → 等 Node 的 close 事件（不是 exit）
                                   ↑ 这步自动接住没读完的尾巴
然后才标 uncertain、告诉她、起新进程
```

Alice要的「**ab 的回复我都要**」由此自动成立。

⚠️ **双进程不是"会串"，是"会分叉"**：两个进程 resume 同一个 id，各自在内存里持有一份、
各自往同一个文件追加。下次 resume 只能沿一条枝走，另一条枝**对他来说等于没发生** ——
她的体验是"他忘了刚才说的"。所以起新进程前必须确认旧的真停了。

## 5. 僵死脱困（唯一从"不做"改成"要做"的）

子进程活着但不响应、桥也活着，**没有退出事件触发重启** → 当前轮永久占槽，
后面的消息永远提交不了 → **直接让她少收东西**。而且发生过（2026-08 OB 那次，
MCP 会话成孤儿，下次工具调用无限挂）。

最低限度：**让她知道卡住了 + 一个命令作废当前轮释放槽**。
不诊断卡在哪，也不把长工具调用一律超时杀掉。

## 6. 版本策略

SDK 一天发好几版。但**不用 `DISABLE_AUTOUPDATER` 一刀切**（那是为防没发生过的事，
代价是永远拿不到修复）。做法：`package.json` **钉死具体版本号**，
升级由人发起、升完跑一遍探针对照 fixture。

判据跟本项目通则一致（**发生过 / 会撞上 / 只是理论上**）：
CLI 升级破坏协议属于第三类 —— 老桥跑了五个月、CLI 从 2.1.274 升到 2.1.278，一次没坏。

## 7. 开工顺序

1. **先跑真 CLI 存 fixture**，对着真实输出写 decode，不对着文档猜。
   理由不是防升级，是**写对** —— 13 条里已经有一条判据是错的，就因为对着注释写。
2. `decode.js` + 单测
3. `claim.js`
4. `ingress.js`
5. 装配 + 假 CLI 端到端
6. 逐条对 13 条规则验收，再切

**不嫁接**（新的自己长齐，整个换过去）**，但部署要能退回**（pm2 指回老的那条路留着）。
这两件是分开的：不在新代码里内置两套路由 ≠ 不准备回滚。
