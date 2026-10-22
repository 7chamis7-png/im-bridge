#!/usr/bin/env bash
# 电话那条腿的虚拟声卡：建 / 体检 / 出持久化配置。详见 docs/phone.md。
#
#   微信 ──播放──▶ <speaker>（null-sink，设为默认输出）──.monitor──▶ 通话进程录
#   通话进程 ──放──▶ <mic_sink>（null-sink）──.monitor──remap──▶ <mic>（设为默认输入）──▶ 微信采集
#
# 用法：
#   scripts/setup-phone-audio.sh             建（幂等：已经有的不重复建），设默认
#   scripts/setup-phone-audio.sh --check     只读体检，一样不改；有问题退出码 1
#   scripts/setup-phone-audio.sh --print-default-pa   打印 ~/.config/pulse/default.pa 片段（重启 pulse 后自动建）
#   scripts/setup-phone-audio.sh --print-systemd      打印 systemd --user 单元（登录后跑一次本脚本）
#
# 设备名：环境变量 PHONE_SPEAKER / PHONE_MIC_SINK / PHONE_MIC（默认 imb_speaker / imb_mic_sink / imb_mic）。
# 要跟通话进程（legs/phone）和微信发语音（GATE_WECHAT_MIC_SINK）用同一组名字。
#
# ⚠️ pulse 重启之后**微信必须跟着重启**：微信连着的还是旧 pulse，通话两头都哑。
#    --check 会按「pulse 启动时间 vs 微信启动时间」提示这件事。
set -u

SPEAKER="${PHONE_SPEAKER:-imb_speaker}"
MIC_SINK="${PHONE_MIC_SINK:-imb_mic_sink}"
MIC="${PHONE_MIC:-imb_mic}"
WECHAT_PROC="${PHONE_WECHAT_PROC:-wechat}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

mode="setup"
case "${1:-}" in
  "") ;;
  --check) mode="check" ;;
  --print-default-pa) mode="pa" ;;
  --print-systemd) mode="systemd" ;;
  -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
  *) echo "不认识的参数：$1（--check / --print-default-pa / --print-systemd）" >&2; exit 2 ;;
esac

for n in "$SPEAKER" "$MIC_SINK" "$MIC"; do
  if ! [[ "$n" =~ ^[A-Za-z0-9_.-]+$ ]]; then echo "设备名只许字母数字和 _ . -：$n" >&2; exit 2; fi
done

if [ "$mode" = "pa" ]; then
  cat <<EOF
### 电话那条腿的虚拟声卡（scripts/setup-phone-audio.sh --print-default-pa 生成）
### 放进 ~/.config/pulse/default.pa（文件开头要有 .include /etc/pulse/default.pa，或者整份自己写全）
load-module module-null-sink   sink_name=$MIC_SINK   sink_properties=device.description="Phone_Mic_Sink"
load-module module-null-sink   sink_name=$SPEAKER    sink_properties=device.description="Phone_Speaker"
load-module module-remap-source master=$MIC_SINK.monitor source_name=$MIC source_properties=device.description="Phone_Mic"
set-default-sink   $SPEAKER
set-default-source $MIC
EOF
  exit 0
fi

if [ "$mode" = "systemd" ]; then
  here="$(cd "$(dirname "$0")" && pwd)"
  cat <<EOF
# ~/.config/systemd/user/imb-phone-audio.service
# 装：systemctl --user daemon-reload && systemctl --user enable --now imb-phone-audio.service
# 注意：它只在 pulse 起来之后建设备；pulse 重启了要再跑一次，并且**重启微信**。
[Unit]
Description=Phone leg virtual audio devices
After=pulseaudio.service
Requires=pulseaudio.service

[Service]
Type=oneshot
Environment=PHONE_SPEAKER=$SPEAKER PHONE_MIC_SINK=$MIC_SINK PHONE_MIC=$MIC
ExecStart=$here/setup-phone-audio.sh

[Install]
WantedBy=default.target
EOF
  exit 0
fi

if ! command -v pactl >/dev/null 2>&1; then
  echo "✗ 没有 pactl（apt install pulseaudio-utils）" >&2; exit 2
fi
if ! info="$(pactl info 2>/dev/null)"; then
  echo "✗ 连不上 pulse（XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR）。pulse 没在跑，或者不是这个用户的。" >&2
  exit 1
fi

has_sink()   { pactl list short sinks   2>/dev/null | awk '{print $2}' | grep -qxF "$1"; }
has_source() { pactl list short sources 2>/dev/null | awk '{print $2}' | grep -qxF "$1"; }
default_of() { printf '%s\n' "$info" | sed -n "s/^Default $1: //p" | head -1; }

if [ "$mode" = "setup" ]; then
  if has_sink "$MIC_SINK"; then echo "· $MIC_SINK 已有"; else
    pactl load-module module-null-sink sink_name="$MIC_SINK" sink_properties=device.description=Phone_Mic_Sink >/dev/null \
      && echo "+ 建了 $MIC_SINK" || { echo "✗ 建 $MIC_SINK 失败" >&2; exit 1; }
  fi
  if has_sink "$SPEAKER"; then echo "· $SPEAKER 已有"; else
    pactl load-module module-null-sink sink_name="$SPEAKER" sink_properties=device.description=Phone_Speaker >/dev/null \
      && echo "+ 建了 $SPEAKER" || { echo "✗ 建 $SPEAKER 失败" >&2; exit 1; }
  fi
  if has_source "$MIC"; then echo "· $MIC 已有"; else
    pactl load-module module-remap-source master="$MIC_SINK.monitor" source_name="$MIC" source_properties=device.description=Phone_Mic >/dev/null \
      && echo "+ 建了 $MIC" || { echo "✗ 建 $MIC 失败" >&2; exit 1; }
  fi
  pactl set-default-sink "$SPEAKER" && pactl set-default-source "$MIC" || { echo "✗ 设默认设备失败" >&2; exit 1; }
  echo "· 默认输出 = $SPEAKER，默认输入 = $MIC"
  echo "  提醒：微信要是在这之前就开着，它不一定换到新的默认设备上 —— 不出声就重启微信。"
  info="$(pactl info 2>/dev/null)"
fi

# ───────── 体检（建完也顺手查一遍）─────────
bad=0
ok()   { echo "✓ $*"; }
fail() { echo "✗ $*"; bad=1; }
note() { echo "○ $*"; }

has_sink "$SPEAKER"  && ok "输出设备 $SPEAKER 在（微信播放 → 这里 → $SPEAKER.monitor 给通话进程录）" || fail "缺输出设备 $SPEAKER"
has_sink "$MIC_SINK" && ok "放音设备 $MIC_SINK 在（通话进程往这里放）" || fail "缺放音设备 $MIC_SINK"
has_source "$MIC"    && ok "麦克风 $MIC 在" || fail "缺麦克风 $MIC"
if pactl list short modules 2>/dev/null | grep -q "module-remap-source.*master=$MIC_SINK\.monitor.*source_name=$MIC\b"; then
  ok "$MIC 是 $MIC_SINK.monitor 的 remap"
elif has_source "$MIC"; then
  fail "$MIC 存在，但不是 $MIC_SINK.monitor 的 remap —— 他的声音进不了微信"
fi
ds="$(default_of Sink)"; dsrc="$(default_of Source)"
[ "$ds" = "$SPEAKER" ] && ok "默认输出 = $SPEAKER" || fail "默认输出是「${ds:-?}」，应该是 $SPEAKER（微信的声音不会进 $SPEAKER，通话进程听不见）"
[ "$dsrc" = "$MIC" ]   && ok "默认输入 = $MIC"     || fail "默认输入是「${dsrc:-?}」，应该是 $MIC（微信采不到他的声音）"

# 微信连着的是不是现在这个 pulse：比启动时间。微信比 pulse 早起 = 连着旧的 = 两头都哑。
age() { ps -o etimes= -p "$1" 2>/dev/null | tr -d ' '; }
ppid_="$(pgrep -x pulseaudio 2>/dev/null | head -1)"
wpid="$(pgrep -x "$WECHAT_PROC" 2>/dev/null | head -1)"
if [ -z "$ppid_" ]; then
  note "找不到 pulseaudio 进程（可能是 pipewire-pulse），跳过启动时间比较"
elif [ -z "$wpid" ]; then
  note "微信没在跑（进程名 $WECHAT_PROC）"
else
  pa="$(age "$ppid_")"; wa="$(age "$wpid")"
  if [ -n "$pa" ] && [ -n "$wa" ]; then
    if [ "$wa" -gt "$pa" ]; then
      fail "微信比 pulse 早起（微信 ${wa}s 前、pulse ${pa}s 前）→ 微信连着旧 pulse，通话会两头都哑：**需要重启微信**"
    else
      ok "微信在 pulse 之后起的（微信 ${wa}s 前、pulse ${pa}s 前）"
    fi
  else
    note "读不到启动时间，跳过比较"
  fi
  if pactl list short clients 2>/dev/null | awk '{print $3}' | grep -qxF "$WECHAT_PROC"; then
    ok "微信是现在这个 pulse 的客户端"
  else
    note "微信现在不是这个 pulse 的客户端（没在放/录声音时也会这样，单看这条不算错）"
  fi
fi

[ "$bad" = 0 ] && { echo "体检通过"; exit 0; }
echo "体检有问题（见上面 ✗）"; exit 1
