#!/usr/bin/env bash
# 桥那 49 个测试（每个文件一个进程，自己打分自己 exit）。
# 2026-09-20 从 /root/cyberboss/test/gate 搬过来的 —— 它们一直是咱们写的。
cd "$(dirname "$0")/.." || exit 1
ok=0; bad=""; skipped=""
for f in test/gate/*.js; do
  if timeout 90 node "$f" >/tmp/gate-test-out 2>&1; then ok=$((ok+1));
    # 默认不碰真实微信库：这些文件会打印 SKIP:，在汇总里点名，别让「跳过」看起来像「通过」。
    grep -q '^[[:space:]]*SKIP' /tmp/gate-test-out && skipped="$skipped $f"
  else bad="$bad $f"; echo "=== 失败: $f"; tail -20 /tmp/gate-test-out; fi
done
total=$(ls test/gate/*.js | wc -l)
echo "桥测试：通过 $ok / $total"
[ -z "$skipped" ] || { echo "其中含跳过段（SKIP）：$skipped"; echo "  （真实微信库测试需 IM_BRIDGE_REAL_WECHAT=1 才跑）"; }
[ -z "$bad" ] || { echo "失败:$bad"; exit 1; }
