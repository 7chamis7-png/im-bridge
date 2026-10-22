#!/usr/bin/env bash
# CC 会自动升级（实测三天一漂），让 forge-state.json 钉的版本与当前不符 → 版本闸回落（forge 开着不发火）。
# 此脚本检测漂移 → 自动重跑 validate（金丝雀验这版 CC 认不认合成格式）→ 过了就重钉版本，恢复发火。
# 幂等：版本没漂就立即 no-op（不写日志免刷屏）。cron 定时跑。forge 没开则不管。
set -uo pipefail
# 2026-09-20 搬家：桥自己的家是 /root/im-bridge，配置只有 nova-env.sh 一份。
cd /root/im-bridge || exit 1
# 直接把生产配置 source 进来 —— 2026-07-31 那个「cron 不加载 .env，validate 掉回默认模型」
# 的补丁从此不需要了，模型跟生产是同一个来源。
. /root/.nova-gate/nova-env.sh
LOG=/root/.nova/forge-revalidate.log
STATE=/root/.nova/forge-state.json
ts(){ date -u +"%Y-%m-%d %H:%M:%SUTC"; }
say(){ echo "[$(ts)] $*" >> "$LOG"; }

# 0) forge 没开 → 不管（开关在 nova-env.sh）
[ "${FORGE_ENABLED:-}" = "true" ] || exit 0

# 1) 取当前 CC 版本 与 state 钉的版本
cur=$(claude --version 2>/dev/null | awk '{print $1}')
[ -z "${cur:-}" ] && { say "skip: 取不到当前 CC 版本"; exit 0; }
pin=$(node -e 'try{process.stdout.write((require("'"$STATE"'").validatedVersion)||"")}catch(e){}' 2>/dev/null)

# 2) 没漂 → no-op（静默）
[ "$cur" = "$pin" ] && exit 0

# 3) 漂了 → 重跑 validate
say "版本漂移 ${pin:-none}→${cur}，重跑 validate"
# 用生产那把模型去验（nova-env.sh 里的 GATE_MODEL 是唯一真相）。
FMODEL="${GATE_MODEL:-}"
say "用模型 ${FMODEL:-(默认)} 重验"
vout=$(timeout 180 env -u CC_MODEL -u FORGE_MODEL NOVA_CLAUDE_MODEL="$FMODEL" node scripts/forge.js validate 2>&1)
if echo "$vout" | grep -q "canary=PASS"; then
  say "重钉成功 → ${cur}（forge 恢复发火，Nova下次换 session 走真实轮）"
else
  # 这版 CC 不认合成格式：forge 自动保持回落，Nova不失忆只走冷层。人工需看一眼。
  say "validate 未通过 → forge 保持回落（不失忆，只走冷层）。out: $(echo "$vout" | tr '\n' ' ' | tail -c 200)"
  node -e 'require("/root/im-bridge/scripts/forge").notify("[系统] forge 自动重验失败：这版 CC 不认合成格式，已保持冷层回落（你不会失忆，只是少了真实轮温度）。等人来看一眼。")' >> "$LOG" 2>&1 || true
fi
