# im-bridge 面板

> **先看一眼：**
>
> ```bash
> node src/panel/server.js --demo
> ```
>
> 用一套假数据（两位假角色）在 `http://127.0.0.1:8790` 起一个完整的面板，免登录、只读 —— 卡住的消息、出过的错、整舱预演、暖尾巴挑选都能看到真实的样子。不需要真的桥在跑，不读你机器上的任何东西。

English: [panel.en.md](panel.en.md)

![总览（手机，白天 / 夜间）](panel-img/home.png)

## 是什么

一个给桥（im-bridge）的主人用的网页面板：一页看清每一位角色此刻怎么样，少数几件需要动手的事（换舱、改他的文件、挑换舱时带哪几轮对话）也能在这里做 —— 每一步都要先确认。

- 服务端渲染，零外部资源、零脚本（CSP 全禁），手机上好用，跟随系统白天 / 夜间。
- 默认只听 `127.0.0.1`。要从外网用，自己挂反向代理 / 隧道（见下文）。
- 没有新依赖：只用 Node 自带模块。

## 功能

| 页面 | 做什么 |
|---|---|
| 总览 | 每位一张卡：此刻真正在用的模型（盒子实测，不拿配置冒充）、上下文水位、最后收发、pm2 进程、卡住的消息、24 小时出错 |
| 卡住的消息 | 跟 Telegram `/pending` 同一套口径，只看不动（处理在 TG 里发 `/pending`），正文只露前 20 字 |
| 出错详情 | 账本里的失败、错误日志新增（面板自己记基线）、掉档告警 |
| 这一舱装了什么 | 下次换舱会拼进去的底子，逐节列来源文件；来源落进别的角色目录的整节标红 |
| 整舱预演 | 按开新舱真实的顺序拼成一整篇：系统提示 → 人格 → 底子 → 暖尾巴；总字数 + 估算 token。用的是换舱那几处真在用的函数，不是另拼一份近似的 |
| 暖尾巴挑选 | 下次换舱会垫进新舱的最近对话，逐轮列出，取消勾选的这次不带（只对下一次有效，用完自动清空；冷层原文不动） |
| 换舱 | 确认页写清后果；可选换舱后用哪个模型（清单 = 这位的模型登记表）。不换模型 = 跟 TG 发 `/new` 同一条路 |
| 改文件 | 「这一舱装了什么」里属于他自己目录的文件 + 人格文件：改动对比 → 确认 → 写入；历史版本可一键恢复 |
| 他写的东西 | 他自己目录里的文字文件（笔记本、日记、备忘……），同样的规矩 |
| 操作记录 | 每一次换舱 / 保存 / 恢复 / 挑尾巴，一行一条 |

## 安全模型

**登录**
- `node src/panel/server.js --issue-link` 打出一条一次性登录链接 **和** 一个 8 位登录码（去掉 0/O/1/I/L 这类易混字）。两者是同一条记录：10 分钟内有效，二选一，用掉一个另一个也作废。
- 链接点开先是「进门」按钮（GET 不消耗），点了才消耗 —— 聊天软件的链接预览抓一下不会把它用掉。
- 登录码给「添加到主屏幕」的网页 App 用：它的 cookie 跟浏览器是隔开的，全屏下也没地址栏可点链接，登录页直接输码。
- 码登录限速：同一来源 IP 连错 5 次锁 15 分钟；全站 10 分钟内错 30 次也锁 15 分钟。经 Cloudflare 进来时按 `CF-Connecting-IP` 认来源。
- 会话：默认 3650 天（`PANEL_SESSION_DAYS`），**滑动续期** —— 每次访问把期限往后顺延、cookie 同步刷新。
- 吊销：`node src/panel/server.js --revoke-all` 清掉所有会话，所有设备都得重新登录。
- token、登录码、会话 id 在磁盘上只存 sha256；状态目录 0700、文件 0600。cookie：`HttpOnly; SameSite=Strict`，`PANEL_PUBLIC_URL` 是 https 时加 `Secure`。

**改动类请求**
- 只收 POST、只收表单；带一个跟会话绑定的 CSRF 令牌（由会话 id 推出来，换个会话就对不上）。
- 另外核对来源：`Sec-Fetch-Site` 是跨站的拒；带了 `Origin` 且不是 `PANEL_PUBLIC_URL` / 本站的拒。
- 换舱、改文件、恢复都有确认页；刷新结果页不会再做一次（按完就 303 跳走）。

**换舱走桥的控制口**
- 桥（gate 进程）在 `$GATE_ROOT/control.sock` 开一个本机 unix socket（0600），面板往这里发命令，桥用**跟 Telegram 完全相同的命令表**执行，以主人身份，回执也推到主人的聊天里。
- 只收三条：`/new`（理由一行、≤80 字）、`/model <id>`、`/engine <id>`；后两条只收这位模型登记表里存在的一个 id。一串命令只认 `/new` → `/model`（换舱 + 同一家换模型）。
- 注意：同一台机器、同一个用户下的进程（包括角色自己的工具）都能连上这个 socket —— 它防的是别的用户，不是同机同用户。

**能改哪些文件**
- 能改：「这一舱装了什么」里落在这位自己目录（env 里的 `GATE_ROOT` / `NOVA_STATE_DIR` / `GATE_MEMORY_DIR` / `GATE_WORKSPACE_ROOT` 等声明的目录）里的文件、人格文件，以及「他写的东西」里的文字文件。
- 不能改：别的角色目录里的（标红）、`.env` / `*.secret` / `*-env.sh` / 名字像凭据的（token、credential、key……）、桥的运行账本（turns.json、events.jsonl、cold.jsonl、cursor-*、dead-*、sessions.json……；桥根目录整个不列）、二进制、超过 2MB 的。
- 路径必须原样出现在当场重算的清单里；`..`、多余斜杠拒；**realpath 之后再判一次**，软链接指出去的拒。

**写入**
- 乐观锁：编辑页记着打开时的 sha256，写之前比对（rename 前再比一次）；期间文件被改过（角色自己也会改他的文件）就拒绝、不写，把你那一版留在页面上给你复制。
- 写前备份旧版到 `PANEL_STATE_DIR/backups/<角色>/<日期>/`，每个文件留最近 `PANEL_BACKUP_KEEP` 份（默认 20）。
- 原子写：同目录临时文件（原权限、原属主）→ fsync → rename。
- 审计：`PANEL_STATE_DIR/audit.jsonl`（0600，只追加）：时间、角色、动作、文件、前后指纹、结果。

## 安装运行

前提：Node ≥ 22；桥按 `docs/INSTALL.md` 装好，每位角色有一个 `<id>-env.sh`。

```bash
cp examples/panel.env.example ~/.im-bridge-panel.env   # 改成你的
node src/panel/server.js --issue-link                   # 发登录链接 + 登录码
```

**为什么要 `env -i` 起**：面板读每位角色的路径时，只认那位自己 env 文件里写的（数据隔离）。如果起面板的 shell 里混着别的角色的变量（比如你刚 source 过某位的 env），它们会被带进面板进程。用一个干净环境起最稳妥：

```bash
env -i HOME="$HOME" PATH="$PATH" bash -c 'set -a; . ~/.im-bridge-panel.env; set +a; exec node src/panel/server.js'
```

pm2：

```bash
cat > ~/run-panel.sh <<'SH'
#!/usr/bin/env bash
exec env -i HOME="$HOME" PATH="$PATH" bash -c 'set -a; . "$HOME/.im-bridge-panel.env"; set +a; cd /path/to/im-bridge && exec node src/panel/server.js'
SH
chmod +x ~/run-panel.sh
pm2 start ~/run-panel.sh --name panel && pm2 save
```

systemd（用户服务）：

```ini
# ~/.config/systemd/user/im-bridge-panel.service
[Unit]
Description=im-bridge panel
[Service]
ExecStart=/usr/bin/env -i HOME=%h PATH=/usr/local/bin:/usr/bin:/bin bash -c 'set -a; . %h/.im-bridge-panel.env; set +a; cd /path/to/im-bridge && exec node src/panel/server.js'
Restart=on-failure
[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now im-bridge-panel
```

面板认 pm2 进程的方式：名字以 `<角色 id>-` 开头的（比如 `alpha-gate`、`alpha-box`、`alpha-cli`）算那一位的。面板只调 `pm2 jlist`，pm2 守护进程没在跑就不调（免得把它拉起来）。

换舱 / 选模型要桥那头有控制口：起桥的版本要包含 `src/gate/control-socket.js`（gate 进程启动日志里有「控制口 开在 …」）。

## 挂到外网（Cloudflare Tunnel 示例）

**先在本机确认两件事再挂：** 不带 cookie 访问任何页面都是 401；`PANEL_PUBLIC_URL` 写成 https 的地址（cookie 才会带 Secure）。

```yaml
# ~/.cloudflared/config.yml
tunnel: <你的 tunnel id>
credentials-file: /home/you/.cloudflared/<tunnel id>.json
ingress:
  - hostname: panel.example.com
    service: http://127.0.0.1:8790
  - service: http_status:404
```

```bash
cloudflared tunnel route dns <tunnel 名> panel.example.com
cloudflared tunnel run <tunnel 名>
```

面板自己就有登录；想再加一道门可以在 Cloudflare Access 前面挡一层（注意那样主屏幕 App 也要过 Access）。

## 配置项

| 变量 | 默认 | 说明 |
|---|---|---|
| `PANEL_PORT` | 8790 | 端口（只听 127.0.0.1） |
| `PANEL_STATE_DIR` | `~/.im-bridge-panel` | 面板自己的状态：会话 / 登录 token 的哈希、错误日志基线、备份、审计 |
| `PANEL_CHARACTERS` | 扫 `~/.*-gate/*-env.sh` | `alpha:/path/alpha-env.sh,beta:/path/beta-env.sh` |
| `PANEL_NAMES` | env 里的 `GATE_AGENT_DISPLAY_NAME`，再没有就用 id | 面板上的显示名 `alpha:晨星,beta:暮雨`（不影响进提示词的名字） |
| `PANEL_ACCENTS` | 按顺序分 | 每位的点缀色 `alpha:ruby,beta:sapphire`（sapphire / ruby / emerald / amber） |
| `PANEL_PUBLIC_URL` | `http://127.0.0.1:<端口>` | 生成登录链接用；https 时 cookie 带 Secure，也用于来源核对 |
| `PANEL_SESSION_DAYS` | 3650 | 会话期限（天），滑动续期 |
| `PANEL_BACKUP_KEEP` | 20 | 每个文件留几份旧版 |
| `PANEL_LANG` | auto | `zh` / `en` / `auto`（按浏览器 Accept-Language，默认中文） |
| `PANEL_COPY_FILE` | — | 文案覆盖 JSON：`{"zh":{"原句":"新句"},"en":{...}}` |
| `PANEL_TZ` | Asia/Shanghai | 页面上的时间按哪个时区 |
| `PANEL_HERO_IMAGE` | 自带 | 头图换成一张本地图片 |
| `PANEL_NIGHT_IMAGE` | 自带 | 夜间背景换成一张本地图片 |
| `PM2_HOME` | `~/.pm2` | pm2 的目录 |

角色那边（各自的 env 文件里）面板会读：`GATE_ROOT`、`NOVA_STATE_DIR`、`GATE_MEMORY_DIR`、`GATE_WORKSPACE_ROOT`、`GATE_IDENTITY_INJECTION_FILE`、`GATE_COLD_FILE`、`NOVA_NOTEBOOK_FILE`、`GATE_BINDING_KEY`、`GATE_HEARTBEAT_FILE`、`GATE_CONTROL_SOCKET`、`GATE_MODEL`、`GATE_MODELS_FILE`、`GATE_TOOLS_CONFIG`、`GATE_SYSTEM_PROMPT_FILE`、`GATE_ENGINE`、`GATE_HISTORY`。

## 常见问题

- **登录链接点开说「已经用过了」**：链接只能用一次、10 分钟作废；再 `--issue-link` 一个。
- **主屏幕 App 里没登录**：它跟浏览器不共用 cookie。用登录码。
- **换舱按钮说「连不上他的桥」**：那位的 gate 没在跑，或者是没有控制口的旧版本 —— 重启 gate。
- **改文件提示「被改过了」**：打开之后文件变了（往往是角色自己写的）。重新打开看最新的再改；你那一版在页面上留着。
- **某个文件列在「不能改」里**：页面上写着原因（别人目录 / 凭据类 / 账本 / 太大 / 二进制）。
- **时间不对**：设 `PANEL_TZ`。

## 已知限制

- Codex 引擎不报实测模型：卡片上的「此刻真正在用的模型」只能显示「未确认」+ 请求的那个。
- 控制口挡不住同机同用户的进程（见上）。
- 改文件的乐观锁在「最后一次比对」和 rename 之间还有几毫秒空档。
- 错误日志没有时间戳，「24 小时新增」靠面板自己记的基线，第一次看只有尾巴。
- 「他写的东西」最多走 6 层目录、列 4000 个文件。

## 素材

头图与夜间背景图由项目维护者使用 AI 图像生成工具制作，随本仓库许可发布。线稿（`cathedral.svg`）与图标（`icon.svg`）为本项目原创矢量图。
