#!/usr/bin/env bash
# Iris（codex app-server 引擎）那份环境 —— 对照 /root/.iris-gate/iris-env.sh 用。
# 三个进程（iris-cli / iris-box / iris-gate）的 run-*.sh 都先 source 它。
# 钥匙不在这儿：GATE_TELEGRAM_TOKEN 等照生产那份填，别提交。
set -a

export PATH=/usr/local/bin:/usr/bin:/bin
export OUTWARD_TZ=Asia/Shanghai
export OUTWARD_LOCALE=zh-CN

export IM_BRIDGE_HOME=/root/im-bridge
export GATE_ROOT=/root/.iris-gate
export GATE_TELEGRAM_TOKEN=
export GATE_OWNER_TELEGRAM_ID=
export GATE_PREFERRED_CHAT_ID=
export GATE_OWNER_NAME=alice
export GATE_BINDING_KEY=

export GATE_WORKSPACE_ROOT=/root/iris
export GATE_MEMORY_DIR=/root/iris
export GATE_IDENTITY_INJECTION_FILE=/root/iris-identity/injection.txt
export GATE_COLD_FILE=/root/.iris-gate/cold.jsonl

export GATE_MODEL='gpt-5.6-sol'
export GATE_CODEX_COMMAND=/usr/local/bin/codex
export GATE_CODEX_MODEL_PROVIDER=''
export GATE_BOX_SOCKET=/root/.iris-gate/box.sock
export GATE_HEARTBEAT_MS=15000

# ——— S3c（2026-10-21）：桥来换舱，抢在 codex 自压缩前面 ———
# codex 的自动压缩关不掉：实际阈值 ≈ min(model_auto_compact_token_limit, 有效窗口 × 90%)，
# 有效窗口 = model_context_window × 95%（设计稿 §8.2）。872000 → 有效 828,400 → 自压缩约 74.5 万。
# 桥在 872000 × 0.344 ≈ 30 万就换舱（清 codex-thread.json → 新 thread → forge inject 尾巴），自压缩只当兜底。
#   CODEX_MODEL_CONTEXT_WINDOW：只有 iris-cli 读（app-server 的 -c，改了要重启 iris-cli = 打断他）
#   GATE_BOX_CONTEXT_LIMIT / GATE_AUTO_ROTATE_RATIO / GATE_WATCH_MS：iris-box 和 iris-gate 读（不打断他）
export CODEX_MODEL_CONTEXT_WINDOW=872000
export GATE_BOX_CONTEXT_LIMIT=872000
export GATE_AUTO_ROTATE_RATIO=0.344
# 守护要开着水位才有人看（原来 0 = 守护整个关着，换舱阈值写了也没人触发）
export GATE_WATCH_MS=30000

set +a
export GATE_ENGINE=codex   # 盒子别靠模型名猜引擎（codex 不裁工具链、换舱走 cli 宿主那半）
