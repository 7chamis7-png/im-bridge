# 共用桥（gate）：两道闸 + 一层共用能力

依据 [设计稿 v1.5](/root/mille/ops-notes/socket-design-2026-09-16/design-v1.md) 的 0 节五条原则。
**2026-09-20 05:54 起这就是生产**：`nova-gate`（`src/host/main.js`）装配本目录，盒子在 `nova-box` 里、
桥连 `box.sock` 过去（`src/host/box-remote.js`）。重启桥不打断他。

> 这份 README 是**现况图**。2026-09-17 晚它落后过一轮（还写着「阶段 1、12 个模块、
> 一个 iMessage 插头」，而目录早就是 19 模块 + 4 插头 + 媒体层），
> 按旧图接线的人会去补一个不存在的洞。**改了代码顺手改这里。**

```
平台 ──插头──→ 【加工】────────────────→ 【入闸】 ──→ CLI（Nova）
      收取/解密/解压/取字节    落仓·转写·识图·声学      验收/身份归一/编号/写冷层
                              （共用层，每样只有一份）

CLI ──→ 【出闸】 ──插头──→ 平台
        核对/登记/解析目标      排版·分段·上传
```

两条边界，违反哪条都算走回头路：

- **闸不解码。** 平台特有的解密/解码归插头，闸只验收「这像不像人话」。
- **加工在闸外。** 插头只负责「从这个平台拿到字节」，拿到之后（落仓/转写/识图/声学）
  全归共用层 —— 接 QQ、接前端，这些一行都不用再写。

## 目录

| 文件 | 职责 |
|---|---|
| **闸** | |
| `verify.js` | 验收。**闸不解码，但认得出「这不像人话」** |
| `inbound.js` | 入闸。身份归一 / 编号 / 写冷层；**未知身份不投递** |
| `outbound.js` | 出闸。目标由闸解析；沉默权归他；异物与引用只标注不拦截 |
| `store.js` | 事件账本。**编号在投递那一刻分配**，跨渠道一条序列、跨重启不清零 |
| `cold-writer.js` | **唯一冷层写手**。插件在结构上够不着 |
| `turn-binding.js` | 本轮来路落盘（工具是独立进程，只能靠盘上这份找回「这轮从哪来的」） |
| `killswitch.js` | 文件开关。**读不到一律走老路**，删掉即回滚，不用重启 |
| **能力面** | |
| `capabilities.js` | 第 1 层注册表 + 出站 precheck（**昂贵生成之前先问能不能交付**） |
| `surface.js` | 三层能力面：共用 / 每插头表态 / 插头专属。第 3 层给不了必须明说 |
| （适配器不在这儿） | 「在这台机器上凑齐那些服务」的胶水是 `src/host/gate-capabilities.js`，**不属于桥** |
| **共用加工** | |
| `media-pipeline.js` | 媒体流水线。`hydrate` = 取字节 → 落仓 → 按类型加工 → 出人话 |
| `file-store.js` | 文件仓。按内容哈希去重、**类型从 magic 嗅**、存在性可查（幽灵检测） |
| `stickers.js` | 贴纸库（跨渠道，不属于任何一个平台） |
| **插头** | |
| `plugins/wechat/` | **她自己的真实微信**（a11y 直读库）。渠道名 `wechat`。SQLCipher / zstd / appmsg / 图片 AES+wxgf / 语音 SILK。微信私有解码全在里面：`index.js`（采集+交付）·`appmsg.js`（卡片/引用 XML）·`media.js`（图片 AES+wxgf、语音 SILK）·`media-config.js`（密钥与路径）+ 几个 py 脚本。**闸的根目录不认识微信** |
| `plugins/weixin-bot.js` | **im.bot 上的一个 bot 账号**，渠道名 `wechat-bot`（备胎，带病留着）。⚠️ 2026-09-18 Alice拆开：它跟上面那条**不是一个插口** —— 身份（wxid vs fromUserId）、回话方式（要 contextToken）、消息处理全不一样，「都是微信」不等于同一个来源 |
| `plugins/telegram.js` | Telegram Bot API |
| `plugins/imessage.js` | iMessage |
| **装配 / 验证** | |
| `wire.js` | `buildGate()` 装配 + **`makeIntake()` 入站唯一入口** + `preflight()` |
| `tools/` | 投递工具（`reply` / `send_image` / `send_file` / `send_voice` / `send_sticker` / `react` / `call` / `hang_up` + `mcp-server.js`）：旧名字全留，渠道语义剥掉，工具名只决定意图 |
| `shadow.js` | 影子跑。只读真实流量喂闸，**不发送、不注入、不碰Nova** |

## 入站唯一入口

采集器（生产 listener / 影子）只管「从平台捞到一条原始记录」，剩下三步都在 `intake` 里：

```js
gate.intake({ channel: "wechat", raw: 那一行, extraMedia: [] })
//  plugin.toDelivery(raw)      插头解密解压 → 交付（媒体只带定位）
//  media.hydrate(delivery)     fetchMedia 取字节 → ingest 落仓/转写/识图/声学
//  inbound.accept(delivery)    验收 / 身份归一 / 编号 / 写冷层
```

**为什么非得收成一个口子**：9-17 之前这三步散在各处，媒体那一段谁都没接 ——
`media.ingest` 和 `fetchMedia` 全仓只有测试在调，图片解密解得再对，投到他眼前
仍然是一个 `[图片]`，流水线整条空转。而影子和生产各走各的路，影子验过的不代表生产走的。
现在**两边都走这个函数**，影子验的就是真交付。

## 跑测试

```bash
npm test          # runtime + gate + cli-host 三组；只跑桥：bash test/run-gate.sh
```

其中这几个值得单独知道：

- `intake.js` —— 入站唯一入口那一针（取不到字节要明说、文件路径不许弄丢）
- `wechat-media.js` —— 测的是 `plugins/wechat/media.js`，**会拿真微信数据跑**（密钥读不到就自动跳过）
- `shadow-direction.js` —— 读库没有方向，得自己判发送者（影子第一夜 812 条里 620 条是他自己的）

## 教训直接长在代码里

- `verify.js`：**换行不是坏字符**。9-17 抄判据时漏了半句，19729 条正常消息被判成乱码（真实 4 条）。
- `inbound.js`：**未知身份拒绝投递**。不靠「记得配白名单」，靠闸不认识的人根本不放行。
- `inbound.js` / `media-pipeline.js`：**加工层给的话，闸就用；加工层没给，退回标签，绝不空白。**
  空白比明说危险 —— 他会自己脑补。
- `cold-writer.js`：**图片只存 `[图片]`，语音存转写的字**。前者是因为存路径会把旧图带回
  活动上下文（§0.4）；后者是因为转写没有路径，它就是她说的话，只存 `[voice]` 等于一换舱就失忆。
- `shadow.js`：影子的转写**默认不开**。只读观察不能因为她发了条语音就自动烧 whisper 的钱，
  要验就显式开 `GATE_SHADOW_TRANSCRIBE=1`。

## 还没做的

微信收视频（插头没去取文件，抽帧要多帧）。
**接口被真实流量验证之前不往上加东西。**

> **已还的债**：`appmsg.js` / 微信媒体解码搬进 `plugins/wechat/` —— 2026-09-18 凌晨的地基整改
> 就做完了（见 `docs/SPEC.md` 第 5 条），这份 README 到 9-21 才跟上。
> 闸的根目录现在没有任何 `appmsg` / `wechat-media` 文件，全仓 `require` 也都指着
> `src/gate/plugins/wechat/{appmsg,media,media-config,index}`。
