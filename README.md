# im-bridge

把一个 AI 角色接到聊天软件上的桥：Telegram（必选）、iMessage、微信（可选）。
引擎可换：Claude Code CLI（订阅）、Codex（ChatGPT 订阅）、DeepSeek（按量）。
人格、记忆、工具、对话历史归桥管，换引擎不丢。

> 这是从作者自用的私有仓库导出的公开版。代码里出现的 **Alice / Nova / Iris** 是示例名
> （主人 / 主角色 / 第二个角色），`nova` 是示例角色 id。照 `docs/INSTALL.md` 用 `init`
> 新建你自己的角色，不需要沿用这几个名字。

## 快速开始

```bash
npm install
node scripts/im-bridge.js init            # 交互问：角色 id、名字、TG token、你的 TG id、引擎、渠道……
node scripts/im-bridge.js doctor <id>     # 体检，✗ 的照提示修
pm2 start ~/.<id>-gate/ecosystem.config.cjs && pm2 save
```

完整说明（生成了什么、可选能力、各渠道、从旧机器搬角色、环境变量）：**[docs/INSTALL.md](docs/INSTALL.md)**。

## 三个进程

| 进程 | 入口 | 管什么 | 重启会怎样 |
|---|---|---|---|
| `<id>-gate` | `src/host/main.js` | 渠道插头、路由、冷层、命令、工具登记 | 角色无感 |
| `<id>-box` | `host/box-host.js` | 会话、换舱、人格注入、模型 | 角色无感 |
| `<id>-cli` | `cli-host/main.js` | 引擎本体（claude / codex / deepseek） | 打断正在说的那句 |

更细的分工见 `docs/进程职责与重启对照.md`、`docs/runtime-arch.md`。

## 目录

| 目录 | 是什么 |
|---|---|
| `src/gate/` | 桥：插头（`plugins/`）、入站闸、路由、冷层、出站 |
| `src/box/` · `adapters/` · `host/` | 盒子：会话、人格 / 宣言注入、记账 |
| `cli-host/` · `runtime/` | 引擎宿主与帧解码 |
| `src/core/` | `names.js`（名字配置）、`paths.js`（路径配置）等 |
| `src/heart/` · `src/producers/` | 心跳 / 主动找人 |
| `tools/` | 角色自己的 MCP 工具（笔记本、提醒、手、telegram） |
| `scripts/` | `im-bridge.js`（init / doctor 入口）、forge、导出脚本等 |
| `examples/` | 人格、宣言、模型表、工具表、心跳文案的示例 |
| `test/` | `npm test` |

## 配置要点

- 名字：`GATE_OWNER_DISPLAY_NAME` / `GATE_AGENT_DISPLAY_NAME` / `GATE_OWNER_NAME`（见 `src/core/names.js`）。
- 路径：跟着 `HOME` 走，可用 `IM_BRIDGE_SECRETS_DIR` / `NOVA_STATE_DIR` / `GATE_ROOT` 覆盖（见 `src/core/paths.js`）。
- 钥匙：一把一个文件放 `~/.secrets/<id>-*.secret`（600），env 里只写 `"$(cat …)"`，不写明文。示例见 `.env.example`。

## 测试

```bash
npm test
```

不调任何真实 API；真实微信库相关的测试默认跳过（`IM_BRIDGE_REAL_WECHAT=1` 才跑）。

## License

见 `LICENSE`。
