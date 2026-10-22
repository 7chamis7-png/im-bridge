#!/usr/bin/env python3
"""微信发起语音通话（2026-09-18）—— 他打给她

发起 + 挂断两半都有。接听那半做不了：微信的语音通话只在一个设备上响，
而 `Rhodes` 这个号在Nova的安卓专机上也登着，铃声去了手机（当天实测：
库里有 type=50 的通话记录，说明 Linux 客户端知道这通电话，但界面没响）。
要让来电落到这台，得先把那台手机上的微信退掉。

用法：wx-call.py [--hangup]
环境：LINUX_WX_TARGET=聊天窗标题

⚠️ 跟发语音同一套规矩（都是当天踩出来的）：
  · **盲点**：坐标从缓存读，不扫无障碍树（扫树会让微信黑屏）
  · **不碰会话行**：她那条对话框本来开着，再点一下等于点两次，微信会把它收回去
  · 点击模仿真人：带轨迹、随机停顿，不瞬移不连点
"""

import json
import os
import random
import subprocess
import sys
import time

os.environ.setdefault("DISPLAY", os.environ.get("LINUX_WX_DISPLAY", ":98"))
os.environ.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")

SPOTS_FILE = os.environ.get("LINUX_WX_SPOTS", os.path.join(os.environ.get("NOVA_STATE_DIR") or os.path.expanduser("~/.nova"), "phone", "wx-spots.json"))


def window_id(title="^Weixin$", required=True):
    r = subprocess.run(["xdotool", "search", "--name", title],
                       capture_output=True, text=True)
    ids = [x for x in r.stdout.strip().split("\n") if x.strip()]
    if not ids:
        if required:
            raise SystemExit("找不到窗口：" + title)
        return None
    return ids[0]


def geometry(wid):
    g = subprocess.run(["xdotool", "getwindowgeometry", wid],
                       capture_output=True, text=True).stdout
    pos = [l for l in g.split("\n") if "Position" in l][0].split()[1].split(",")
    geo = [l for l in g.split("\n") if "Geometry" in l][0].split()[1].split("x")
    return int(pos[0]), int(pos[1]), int(geo[0]), int(geo[1])


def load_spot(name, geo, section=None):
    """缓存存的是相对窗口的偏移 —— 微信一重启窗口就挪位置，存绝对坐标会失效。

    `section` 指定读哪一份坐标：默认读顶层（主窗口），传 "call_window" 读通话窗那份。
    通话界面是**独立窗口**（标题 Voice Call, 375x667），跟主窗口不是一个原点，
    两份坐标混用就会点到聊天记录里去。
    """
    try:
        with open(SPOTS_FILE, encoding="utf-8") as fh:
            d = json.load(fh)
    except Exception:                                # noqa: BLE001
        return None
    if section:
        d = d.get(section) or {}
    size = d.get("size") or []
    if len(size) != 2 or abs(size[0] - geo[2]) > 8 or abs(size[1] - geo[3]) > 8:
        return None
    rel = (d.get("rel") or {}).get(name)
    return (geo[0] + rel[0], geo[1] + rel[1]) if rel else None


def click(x, y):
    """像真人那样点：带轨迹、到位先停一下、按完再停一下。"""
    cur = subprocess.run(["xdotool", "getmouselocation", "--shell"],
                         capture_output=True, text=True).stdout
    cx = cy = 0
    for line in cur.split("\n"):
        if line.startswith("X="):
            cx = int(line[2:])
        elif line.startswith("Y="):
            cy = int(line[2:])
    steps = random.randint(8, 14)
    for i in range(1, steps + 1):
        t = i / steps
        ease = t * t * (3 - 2 * t)
        jitter = 0 if i == steps else random.randint(-3, 3)
        subprocess.run(["xdotool", "mousemove",
                        str(int(cx + (x - cx) * ease) + jitter),
                        str(int(cy + (y - cy) * ease) + jitter)], check=False)
        time.sleep(random.uniform(0.008, 0.028))
    time.sleep(random.uniform(0.09, 0.22))
    subprocess.run(["xdotool", "click", "1"], check=False)
    time.sleep(random.uniform(0.12, 0.30))


def main():
    hangup = "--hangup" in sys.argv

    if hangup:
        # ⚠️ 挂断**不碰主窗口**：通话是独立窗口（标题 Voice Call），
        #    去激活主窗口等于在她的会话上多点一下 —— 那正是把对话框点没了的动作。
        cwid = window_id("^Voice Call$", required=False)
        if not cwid:
            raise SystemExit("现在没有通话（找不到 Voice Call 窗口）")
        cgeo = geometry(cwid)
        spot = load_spot("Hang Up", cgeo, section="call_window")
        if not spot:
            raise SystemExit("缓存里缺挂断键的位置（通话窗大小变成 %dx%d 了？"
                             "得趁下一通电话开着的时候重扫一次）" % (cgeo[2], cgeo[3]))
        subprocess.run(["xdotool", "windowactivate", cwid], check=False)
        time.sleep(random.uniform(0.3, 0.6))
        click(*spot)
        # **点完要验**（跟发语音查库同一条规矩）：通话窗没消失就是没挂断，
        # 别点一下就报 ok —— 那正是"脚本跑完了≠活干了"。
        for _ in range(12):
            time.sleep(0.4)
            if not window_id("^Voice Call$", required=False):
                print("ok")
                return
        raise SystemExit("点了挂断但通话窗还在 —— 没挂掉")

    wid = window_id()
    geo = geometry(wid)
    subprocess.run(["xdotool", "windowactivate", wid], check=False)
    time.sleep(random.uniform(0.4, 0.7))

    # ⚠️ **拨号是两步**（2026-09-18 她看着屏幕点破的：「没播出来 还要再点一下」）。
    #    点标题栏那个 `Voice Call` 只是**把菜单弹出来**（语音通话 / 视频通话），
    #    得再点菜单里的"语音通话"才真拨出去。
    #    菜单项的位置也缓存了，所以这两步全是盲点，不用扫树。
    spot = load_spot("Voice Call", geo)
    menu = load_spot("Voice Call menu", geo)
    if not spot or not menu:
        raise SystemExit("缓存里缺拨号的位置（窗口大小变了？跑一次扫描重建）："
                         + ("Voice Call " if not spot else "")
                         + ("Voice Call menu" if not menu else ""))

    click(*spot)                                     # ① 弹出菜单
    time.sleep(random.uniform(0.8, 1.2))
    click(*menu)                                     # ② 选"语音通话"，这才真拨出去
    time.sleep(1.5)
    print("ok")


if __name__ == "__main__":
    main()
