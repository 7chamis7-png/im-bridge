#!/usr/bin/env python3
"""微信发语音（2026-09-18）—— 靠虚拟麦克风把他的声音"说"进去

微信 Linux 版没有"发一个音频文件当语音"的口子，语音条只能是**录出来的**。
所以这条路是：把 TTS 音频放进一个假麦克风，让微信自己录。

    点 Send Voice  →  进录音
    paplay → nova_mic_sink  →  微信录到"他的声音"（波形真的在动）
    点 Send 的位置  →  发出真语音气泡

用法：wx-voice-send.py <音频.wav>
环境：LINUX_WX_TARGET=聊天窗标题   PULSE_SINK=nova_mic_sink（默认）

⚠️ 三个实测踩出来的坑，改的时候别踩回去：

1. **AT-SPI 报的坐标是缩放过的**（实测 1.0421：xdotool 说窗口 915px，AT-SPI 说 878px）。
   发文字一直没事是因为输入框大，4% 误差无所谓；28×28 的按钮就偏出去了。
   必须换算：屏幕坐标 = 窗口原点 + AT-SPI相对坐标 × scale。

2. **录音一开始，`Send` 按钮就从无障碍树里消失**（录音界面的 ✕ 和绿色 ↑ 是自绘的，
   AT-SPI 看不见）。所以两个坐标必须在**进录音之前**一起记下来。

3. **开工先按 Esc**：上一次没发完的录音会挂在那儿，挂着的时候连 `Send Voice`
   都扫不到。
"""

import importlib.util
import json
import os
import random
import subprocess
import sys
import time

# ⚠️ 桥进程的环境里**没有 DISPLAY**（2026-09-18 他实测：合成过了、卡在"找不到微信窗口"）。
# 手动跑时我自己 export 了，走桥就没有。跟现网那个发文字的脚本一样，自己兜底。
os.environ.setdefault("DISPLAY", os.environ.get("LINUX_WX_DISPLAY", ":98"))
os.environ.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")

HERE = os.path.dirname(os.path.abspath(__file__))
# 坐标缓存：按钮位置一整天都不变，没必要每次发语音都去扫无障碍树。
# **密集扫树是微信崩的元凶**（2026-09-18 一下午挂了四次，每次挂之前都在密集 scan；
# 9-17 也因为「无障碍查询在微信繁忙时无限阻塞」把无障碍版临时下线过）。
# 所以：窗口几何没变就直接用缓存，只有第一次、或者窗口动过，才扫一次。
SPOTS_FILE = os.environ.get("LINUX_WX_SPOTS", os.path.join(os.environ.get("NOVA_STATE_DIR") or os.path.expanduser("~/.nova"), "phone", "wx-spots.json"))
# 无障碍那套（找窗口、扫节点）复用现网那份，别再抄一遍
# ⚠️ 默认值原来指着老桥 /root/cyberboss/...，那条路搬德国机后已经不存在了
# （2026-10-21 实测：发语音必挂在 load_a11y）。改成同目录那份现网脚本。
A11Y = os.environ.get(
    "LINUX_WX_A11Y",
    os.path.join(HERE, "linux-wx-send-a11y.py"),
)


def load_a11y():
    spec = importlib.util.spec_from_file_location("wxa11y", A11Y)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def window_id():
    r = subprocess.run(["xdotool", "search", "--name", "^Weixin$"],
                       capture_output=True, text=True)
    ids = [x for x in r.stdout.strip().split("\n") if x.strip()]
    if not ids:
        raise SystemExit("找不到微信窗口")
    return ids[0]


def geometry(wid):
    g = subprocess.run(["xdotool", "getwindowgeometry", wid],
                       capture_output=True, text=True).stdout
    pos = [l for l in g.split("\n") if "Position" in l][0].split()[1].split(",")
    geo = [l for l in g.split("\n") if "Geometry" in l][0].split()[1].split("x")
    return int(pos[0]), int(pos[1]), int(geo[0]), int(geo[1])


def load_spots(geo):
    """缓存的是**相对窗口原点的偏移**，不是绝对坐标。

    ⚠️ 微信一重启窗口位置就变（实测 181,466 → 254,263），存绝对坐标的话缓存立刻作废、
       又得去扫树 —— 而扫树正是让它黑屏的那个动作（Alice当天亲眼看到：什么都没点，
       一下子黑屏）。存偏移，窗口挪到哪都能用；只有**窗口大小**变了才作废。
    """
    try:
        with open(SPOTS_FILE, encoding="utf-8") as fh:
            d = json.load(fh)
    except Exception:                                # noqa: BLE001
        return None
    size = d.get("size") or []
    if len(size) != 2 or abs(size[0] - geo[2]) > 8 or abs(size[1] - geo[3]) > 8:
        return None                                  # 窗口换了大小 → 偏移不作数了
    rel = d.get("rel") or {}
    if "Send Voice" not in rel or "Send" not in rel:
        return None
    return {k: (geo[0] + v[0], geo[1] + v[1]) for k, v in rel.items()}


def save_spots(geo, spots):
    """存偏移（绝对坐标 - 窗口原点）+ 当时的窗口大小。"""
    try:
        os.makedirs(os.path.dirname(SPOTS_FILE), exist_ok=True)
        rel = {k: [v[0] - geo[0], v[1] - geo[1]] for k, v in spots.items()}
        with open(SPOTS_FILE, "w", encoding="utf-8") as fh:
            json.dump({"size": [geo[2], geo[3]], "rel": rel}, fh, ensure_ascii=False, indent=2)
        os.chmod(SPOTS_FILE, 0o600)
    except Exception as e:                           # noqa: BLE001
        print("坐标缓存写不进去（不影响这次）：" + str(e), file=sys.stderr)


def voice_count():
    """她那条会话里现有多少条语音（type=34）。查不到就返回 -1，不当成 0。"""
    try:
        import hashlib
        import sqlite3                                # noqa: F401  （只为确认环境有 sqlite）
        keys = json.load(open(os.environ.get("LINUX_WX_KEYS", os.path.expanduser("~/wxkey/all_keys.json")),
                              encoding="utf-8"))
        rel = "message/message_0.db"
        db = os.path.join(keys["_db_dir"], rel)
        key = keys[rel]["enc_key"]
        wxid = os.environ.get("LINUX_WX_OWNER_WXID", "")
        target = os.environ.get("LINUX_WX_TARGET", "")
        who = wxid or ("filehelper" if target.lower().startswith("file") else "")
        if not who:
            return -1
        tbl = "Msg_" + hashlib.md5(who.encode()).hexdigest()
        spec2 = importlib.util.spec_from_file_location(
            "dw", os.path.join(HERE, "db-watch.py"))
        dw = importlib.util.module_from_spec(spec2)
        spec2.loader.exec_module(dw)
        from pathlib import Path
        rows = dw.sqlcipher(Path(db), key,
                            f"SELECT count(*) FROM {tbl} WHERE local_type=34;")
        return int(rows[0]) if rows else -1
    except Exception:                                # noqa: BLE001
        return -1


def chat_is_open(geo):
    """聊天窗开着没 —— **只采一个像素，不碰无障碍**。

    2026-09-18 Alice看着屏幕点破的：会话本来开着，脚本每次还去点一下那一行，
    等于点了两下，微信把对话框收回去了，于是录音键点了个空。
    所以改成「开着就别碰」。判据用像素而不是 AT-SPI —— 扫树是当天唯一
    被亲眼确认过的黑屏诱因。
    """
    wx0, wy0, ww, wh = geo
    png = "/tmp/wx-openprobe.png"
    r = subprocess.run(["import", "-window", "root", png], capture_output=True)
    if r.returncode != 0:
        return None                                  # 截不到就别猜
    try:
        from PIL import Image
        im = Image.open(png).convert("RGB")
        # ⚠️ 判据不能采聊天区正中那一个像素（原来就是这么写的）：那里两条消息之间
        #    本来就是白的，会话开着也会被判成"没开"。2026-10-21 实测，开着/没开
        #    两种状态在那个点上都是白。
        # 改成看**输入框底下那条工具栏**（表情/文件/剪刀/麦克风），它只有在会话开着
        # 时才存在。2026-10-21 实测：
        #     会话开着          2440 个非白像素（这条工具栏是固定的，两次测都是 2440）
        #     刚重启没选会话       0
        #     通讯录名片页       881（底下那排 Messages/Voice Call）—— 生产不会出现，
        #                        但阈值取 1200 顺手把它也排除掉
        # 判不准时宁可多切一次会话，也好过盲点在白板上。
        band = im.crop((wx0 + int(ww * 0.36), wy0 + wh - 60, wx0 + ww - 20, wy0 + wh - 20))
        nonwhite = sum(1 for p in band.getdata()
                       if not (p[0] > 240 and p[1] > 240 and p[2] > 240))
        return nonwhite > 1200
    except Exception:                                # noqa: BLE001
        return None


def click(x, y):
    """像真人那样点（Alice 2026-09-18：「你脚本点的时候模仿真人啊」）。

    瞬移 + 连点会把微信点崩 —— 当天实测三次把渲染子进程点成僵尸、界面整个空白。
    所以：分段移过去、路上带点抖、到位先停一下再按、按完再停一下。
    """
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
        # 越接近目标走得越慢（真人手到位前会减速）
        t = i / steps
        ease = t * t * (3 - 2 * t)
        jitter = 0 if i == steps else random.randint(-3, 3)
        nx = int(cx + (x - cx) * ease) + jitter
        ny = int(cy + (y - cy) * ease) + jitter
        subprocess.run(["xdotool", "mousemove", str(nx), str(ny)], check=False)
        time.sleep(random.uniform(0.008, 0.028))

    time.sleep(random.uniform(0.09, 0.22))      # 到位了先停一下，别手到就按
    subprocess.run(["xdotool", "click", "1"], check=False)
    time.sleep(random.uniform(0.12, 0.30))      # 按完也停一下，别连着下一个动作


def scan_spots(wid, geo):
    """扫一次树，把**三个**要点的位置记下来：她那行会话、录音键、发送键。

    这是唯一会碰 AT-SPI 的地方，只在没有缓存时跑一次。
    扫树是当天唯一被亲眼看到的黑屏诱因（什么都没点、一下子黑屏），所以能不扫就不扫。
    """
    wx = load_a11y()
    import pyatspi

    wx0, wy0, ww, _wh = geo
    frame = wx.frame_node()
    nodes = []
    for _ in range(20):
        nodes = wx.scan(frame)
        if nodes:
            break
        time.sleep(0.4)
        frame = wx.frame_node()
    if not nodes:
        raise SystemExit("无障碍树是空的（微信多半没渲染），不敢瞎点")

    fw = tuple(frame.queryComponent().getExtents(pyatspi.DESKTOP_COORDS))[2]
    scale = ww / fw if fw else 1.0            # AT-SPI 坐标比实际小 ~4.2%，必须换算
    target = os.environ.get("LINUX_WX_TARGET", "")

    def collect(ns):
        out = {}
        for role, name, x, y, w, h, _n in ns:
            abs_xy = (int(wx0 + (x + w // 2) * scale), int(wy0 + (y + h // 2) * scale))
            if name in ("Send Voice", "Send") and name not in out:
                out[name] = abs_xy
            elif role == "list item" and target and name.strip().startswith(target) and "chat" not in out:
                out["chat"] = abs_xy
        return out

    spots = collect(nodes)
    if "chat" not in spots:
        raise SystemExit("会话列表里没有 " + target + "，不敢瞎发")

    # ⚠️ 输入框那排按钮**只有打开聊天窗之后才存在**（刚登录时右边是空的）。
    #    所以：先点进会话，再扫一次拿录音键和发送键。
    if "Send Voice" not in spots or "Send" not in spots:
        click(*spots["chat"])
        for _ in range(12):
            time.sleep(0.6)
            more = collect(wx.scan(wx.frame_node()))
            if "Send Voice" in more and "Send" in more:
                spots.update(more)
                break
    missing = [k for k in ("Send Voice", "Send") if k not in spots]
    if missing:
        raise SystemExit("进了会话还是扫不到：" + " ".join(missing))
    return spots


def main():
    if len(sys.argv) < 2:
        raise SystemExit("用法: wx-voice-send.py <音频.wav>")
    audio = sys.argv[1]
    if not os.path.exists(audio):
        raise SystemExit("音频文件不在：" + audio)
    sink = os.environ.get("PULSE_SINK", "nova_mic_sink")

    wid = window_id()
    geo = geometry(wid)
    subprocess.run(["xdotool", "windowactivate", wid], check=False)
    time.sleep(random.uniform(0.4, 0.7))

    spots = load_spots(geo)
    if spots:
        print("盲点：用缓存偏移，全程不碰无障碍", file=sys.stderr)
    else:
        spots = scan_spots(wid, geo)
        save_spots(geo, spots)
        print("第一次：扫了一遍并缓存（以后不用再扫）", file=sys.stderr)

    before = voice_count()

    # ——— ① 只在"聊天区是白板"时才去开会话 ———
    # ⚠️ **不许每次都点一下**（2026-09-18 Alice连说两次"多余"）：点两下微信会把
    #    对话框收回去，录音键就点在白板上。
    # ⚠️ 也不许用扫树来判断（2026-10-21 Alice："画蛇添足……正常情况下页面是不动的"）。
    #    语音这条路整个设计就是**不扫树**（缓存坐标盲点），因为密集扫树是微信崩的元凶；
    #    为了判断而凭空多扫一次，正好踩在它要躲的东西上。
    #    所以用 chat_is_open()：**只采一个像素**。正常情况（页面没动）一次树都不扫。
    #    —— 这个函数 2026-09-18 就写好了，但一直没人调用，今天才接上。
    # 为什么还是要管：录音是往**当前开着的那个会话**里录的。微信刚重启时一个会话都没开，
    #    盲点就点在白板上。（发文字那边本来就有 ensure_in_chat 自己会开，语音是唯一没有的。）
    if chat_is_open(geo) is False:            # None = 截不到图，不猜，照旧往下走
        a11y = load_a11y()
        a11y.ensure_in_chat(wid, a11y.frame_node())
        time.sleep(random.uniform(0.3, 0.5))

    # ——— 盲点两步 ———
    click(*spots["Send Voice"])               # ② 进录音
    time.sleep(random.uniform(1.1, 1.5))      # 等录音真开起来，别把开头吃掉

    r = subprocess.run(["paplay", "--device=" + sink, audio], capture_output=True, text=True)
    if r.returncode != 0:
        subprocess.run(["xdotool", "key", "Escape"], check=False)
        raise SystemExit("放音失败（录音已取消）：" + (r.stderr or "").strip()[:200])
    time.sleep(0.3)

    click(*spots["Send"])                     # ③ 发出去

    # ⚠️ **点完不等于发出去了**（当天栽过：脚本报 ok、她那头什么都没有）。
    #    去库里查有没有长出新的语音记录；查不到就如实报失败。
    if before < 0:
        print("ok（没法查库验证：不知道该查哪张表）", file=sys.stderr)
        return
    for _ in range(12):
        time.sleep(1.0)
        if voice_count() > before:
            print("ok")
            return
    raise SystemExit("点了发送，但库里没长出语音记录 —— 这条**没发出去**")


if __name__ == "__main__":
    main()
