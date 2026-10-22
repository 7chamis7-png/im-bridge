#!/usr/bin/env bash
# 通话进程启动脚本样例 —— 拷一份到 ~/.<id>-gate/run-phone.sh，改掉 <…> 再用。
#
#   pm2 start ~/.<id>-gate/run-phone.sh --name <id>-phone && pm2 save
#
# 用 env -i 起：**不继承**你 shell 里的变量（别的角色的 GATE_* 会让它落错收件箱、
# 挂到别人的 socket 上）。需要的全在下面显式给。钥匙不写在这里，从钥匙文件读。
set -eu
REPO=<仓库路径>                       # 比如 $HOME/im-bridge
GATE=<桥目录>                         # 比如 $HOME/.<id>-gate（跟桥的 GATE_ROOT 同一个）

exec env -i \
  HOME="$HOME" PATH=/usr/local/bin:/usr/bin:/bin \
  XDG_RUNTIME_DIR=/run/user/$(id -u) \
  DISPLAY=:98 \
  GATE_ROOT="$GATE" \
  GATE_PHONE_INBOX_DIR="$GATE/phone-inbox" \
  GATE_PHONE_SOCKET="$GATE/phone.sock" \
  GATE_OWNER_PHONE_ID=<跟桥那边一样的值> \
  PHONE_ENV_FILE="$HOME/.secrets/<id>-phone.env" \
  ELEVENLABS_DEFAULT_VOICE_ID=<你的 voice id> \
  PHONE_SPEAKER=imb_speaker PHONE_MIC_SINK=imb_mic_sink \
  LINUX_WX_TARGET='<她在微信里的会话标题>' \
  PHONE_WECHAT_LOCK=<跟桥 GATE_WECHAT_SEND_LOCK 同一个文件> \
  python3 -u "$REPO/legs/phone/phone.py" --no-dial
# 可选：NORTH_EAR_PYTHON=… NORTH_EAR_SCRIPT=…（听语气）；PHONE_CALL_PROBE=always（不看通话窗口，老行为）
