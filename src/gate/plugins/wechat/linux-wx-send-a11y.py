#!/usr/bin/env python3
"""Linux 微信出站（无障碍版）：靠 AT-SPI 认界面，不截图、不 OCR。

2026-09-17 Keeper写。老的 linux-wx-send.py 原样留着当回退，phone reply 先试这个。

为什么能这么写：装了 libatk-adaptor 之后微信会把整棵控件树报到 AT-SPI 总线上，
会话标题、会话列表、输入框都能按名字查到，还带精确坐标。于是：
  「我在不在她的会话里」→ 查顶部 label，不用 OCR 认字
  「输入框在哪」        → 查 role=text 的节点，不用按窗口比例猜
  「发出去了没」        → 查输入框内容变空，不用找绿色发送键
所有等待都改成**轮询到状态成立为止**，不再 sleep 死时间。

⚠️ AT-SPI 只能读不能点（按钮的 action 只有 SetFocus），点击仍走 xdotool。
⚠️ AT-SPI 坐标和 X 屏幕坐标差一个窗口装饰的偏移，所以一律换算成
   「相对 frame 原点」再用 xdotool mousemove --window 点，这个实测准。
"""
from __future__ import annotations

import os
import re
import tempfile
import subprocess
import sys
import time

DISPLAY = os.environ.get("LINUX_WX_DISPLAY", ":98")
os.environ.setdefault("DISPLAY", DISPLAY)
os.environ.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
os.environ.setdefault("DBUS_SESSION_BUS_ADDRESS", f"unix:path={os.environ['XDG_RUNTIME_DIR']}/bus")
ENV = dict(os.environ)

# 2026-09-17：默认值一个字没动。加环境变量只是为了拿「文件传输助手」当靶子
# 做出站验证时不用改代码——生产任何一条路都不设这个变量，行为完全照旧。
# 2026-10-21：不再给默认窗口标题（原来写死的是她的微信名）。桥那头（a11y-send.js）一直带着
# LINUX_WX_TARGET=$GATE_WECHAT_TARGET，所以生产行为不变；没给就拒发，绝不拿空串去匹配「任何一行」。
TARGET = os.environ.get("LINUX_WX_TARGET", "")
# 顶部标题在这个高度以内；再往下就是聊天记录里的名字，不能当判据
TITLE_MAX_Y = 100
DEADLINE_ENTER = 3.0      # 等进入她的会话
DEADLINE_FILLED = 2.0     # 等文字落进输入框
DEADLINE_SENT = 4.0       # 等输入框清空（= 发出去了）
TICK = 0.05


def run(cmd, **kw):
    kw.setdefault("env", ENV)
    kw.setdefault("check", True)
    kw.setdefault("timeout", 20)
    return subprocess.run(cmd, **kw)


# ── AT-SPI ────────────────────────────────────────────────────────────────

def _atspi():
    import pyatspi
    return pyatspi


def frame_node():
    """微信顶层 frame。拿不到就抛，调用方回退到截图版。"""
    pyatspi = _atspi()
    desktop = pyatspi.Registry.getDesktop(0)
    for i in range(desktop.childCount):
        app = desktop.getChildAtIndex(i)
        if app is None or app.name != "wechat":
            continue
        for j in range(app.childCount):
            f = app.getChildAtIndex(j)
            if f is not None and f.getRoleName() == "frame":
                return f
    raise RuntimeError("微信不在无障碍总线上（微信是不是没用 start-wechat.sh 起的？）")


def scan(f):
    """遍历可见节点，返回 [(role, name, relx, rely, w, h, node)]，坐标相对 frame 原点。"""
    pyatspi = _atspi()
    fx, fy = tuple(f.queryComponent().getExtents(pyatspi.DESKTOP_COORDS))[:2]
    out = []

    def walk(n, depth=0):
        if depth > 40:
            return
        try:
            st = n.getState()
            if st.contains(pyatspi.STATE_SHOWING) and n.name:
                x, y, w, h = tuple(n.queryComponent().getExtents(pyatspi.DESKTOP_COORDS))[:4]
                out.append((n.getRoleName(), n.name, x - fx, y - fy, w, h, n))
            for i in range(min(n.childCount, 80)):
                c = n.getChildAtIndex(i)
                if c is not None:
                    walk(c, depth + 1)
        except Exception:
            return

    walk(f)
    return out


def in_target_chat(nodes) -> bool:
    """顶部标题是她 = 当前就在她的会话里。"""
    for role, name, x, y, w, h, _ in nodes:
        if role == "label" and y < TITLE_MAX_Y and name.strip().startswith(TARGET):
            return True
    return False


def input_box(nodes):
    """输入框：role=text 且名字是对方。搜索框也是 text，靠名字区分。"""
    for role, name, x, y, w, h, node in nodes:
        if role == "text" and name.strip().startswith(TARGET):
            return (x + w // 2, y + h // 2, node)
    return None


def session_item(nodes):
    """会话列表里她那一行。"""
    for role, name, x, y, w, h, _ in nodes:
        if role == "list item" and name.strip().startswith(TARGET):
            return (x + w // 2, y + h // 2)
    return None


def box_text(node) -> str:
    """⚠️ 微信的输入框节点**不报告内容**，读出来永远是空。
    留着只为调试，别拿它当"有没有字"的判据——2026-09-17 就是栽在这上面。"""
    try:
        return node.queryText().getText(0, 4096)
    except Exception:
        return ""


def send_button(nodes):
    """发送键：没字时 ENABLED=False，有字变 True，发出去又变回 False。
    这是真正靠谱的判据（实测），替掉了"读输入框内容"和"找绿色像素"。"""
    for role, name, x, y, w, h, node in nodes:
        # ⚠️ 角色名跟微信版本有关：4.1.13.9 报 "button"，4.1.13.23 报 "push button"。
        # 2026-10-20 搬德国机换到 .23 后这里就永远匹配不上，出站全挂在"没有发送键"。
        if role in ("button", "push button") and name.strip() == "Send":
            return (x + w // 2, y + h // 2, node)
    return None


def node_enabled(node) -> bool:
    """只查这一个节点的状态。轮询时别再遍历整棵树——遍历一次 0.4 秒，
    查一个节点 0.00x 秒，差出来的就是她能感觉到的那几秒。"""
    import pyatspi
    try:
        return node.getState().contains(pyatspi.STATE_ENABLED)
    except Exception:
        return False


def send_ready(f) -> bool:
    """输入框里有东西可发 = 发送键亮着。（要反复问的话用 node_enabled）"""
    btn = send_button(scan(f))
    return bool(btn) and node_enabled(btn[2])


def wait_for(fn, deadline: float):
    """轮询到条件成立，返回最后一次结果。不再 sleep 死时间。"""
    end = time.time() + deadline
    val = None
    while time.time() < end:
        val = fn()
        if val:
            return val
        time.sleep(TICK)
    return val


# ── X 操作 ────────────────────────────────────────────────────────────────

def weixin_wid() -> str:
    r = run(["xdotool", "search", "--name", "^Weixin$"], capture_output=True, text=True, check=False)
    wids = [ln.strip() for ln in r.stdout.splitlines() if ln.strip()]
    if not wids:
        raise RuntimeError("Linux 微信窗口不在")
    return wids[-1]


def activate(wid: str) -> None:
    run(["xdotool", "windowactivate", "--sync", wid], check=False)
    run(["xdotool", "windowfocus", "--sync", wid], check=False)


def click_rel(wid: str, x: int, y: int) -> None:
    """按「相对窗口」坐标点击，绕开窗口装饰造成的偏移。"""
    run(["xdotool", "mousemove", "--window", wid, str(x), str(y)], check=False)
    run(["xdotool", "click", "1"], check=False)


def set_clipboard(text: str) -> None:
    for sel in ("clipboard", "primary"):
        subprocess.run(
            ["xclip", "-selection", sel],
            input=text.encode("utf-8"), env=ENV, check=True, timeout=10,
        )


def png_for(path: str) -> str:
    """微信剪贴板只认位图。webp/其它一律先转成 PNG，转出来的放临时目录。

    2026-09-17：贴纸源图是 512x512 静态 webp（`/root/sticker-build/pack-*/`），
    实测 11 张全是单帧，所以只转 PNG 不做 GIF。哪天有动图再说。
    """
    if path.lower().endswith(".png"):
        return path
    out = os.path.join(tempfile.gettempdir(), "wx-send-" + str(os.getpid()) + ".png")
    subprocess.run(["convert", path, out], env=ENV, check=True, timeout=20)
    return out


def set_clipboard_image(png_path: str) -> None:
    """把图片放进剪贴板。

    ⚠️ 跟 set_clipboard 同一个坑：xclip 读完会 fork 到后台占住选区。
    这里让它自己 fork（不捕获 stdout），父进程立刻返回 —— 捕获 stdout 会挂死。
    """
    subprocess.run(
        ["xclip", "-selection", "clipboard", "-t", "image/png", "-i", png_path],
        env=ENV, check=True, timeout=10,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


def key(wid: str, *keys: str) -> None:
    for k in keys:
        run(["xdotool", "key", "--window", wid, "--clearmodifiers", k], check=False)


# ── 发送 ──────────────────────────────────────────────────────────────────

def split_segs(text: str) -> list[str]:
    segs = [s.strip() for s in re.split(r"\n\s*\n+", text) if s.strip()]
    return segs or [text.strip()]


def ensure_in_chat(wid: str, f) -> list:
    """保证光标在她的会话里。已经在就直接返回，不做无谓动作。"""
    nodes = scan(f)
    if in_target_chat(nodes):
        return nodes
    item = session_item(nodes)
    if not item:
        raise RuntimeError(f"会话列表里没找到 {TARGET}，没敢盲发")
    click_rel(wid, item[0], item[1])
    nodes = wait_for(lambda: (lambda ns: ns if in_target_chat(ns) else None)(scan(f)), DEADLINE_ENTER)
    if not nodes or not in_target_chat(nodes):
        raise RuntimeError(f"点了 {TARGET} 那一行但标题没变过来，没敢盲发")
    return nodes


def send_one(wid: str, f, text: str) -> None:
    nodes = ensure_in_chat(wid, f)
    box = input_box(nodes)
    if not box:
        raise RuntimeError("无障碍树里没有输入框，没敢盲发")
    bx, by, node = box
    btn = send_button(nodes)
    if not btn:
        raise RuntimeError("无障碍树里没有发送键，没敢盲发")
    send_node = btn[2]

    click_rel(wid, bx, by)
    set_clipboard(text)
    key(wid, "ctrl+a", "BackSpace", "ctrl+v")

    # 等文字真落进输入框：看发送键亮没亮，不猜时间、也不读输入框
    if not wait_for(lambda: node_enabled(send_node), DEADLINE_FILLED):
        raise RuntimeError("粘贴后发送键没亮，字没进去，没发")

    # 用回车发，不点发送键。
    # 2026-09-17 实测：发送键只有 53×27，无障碍坐标和 X 坐标之间那点装饰偏移
    # 就足够点空；同样的偏移点 168×36 的登录键却没事。小控件一律别点。
    key(wid, "Return")

    # 发送键重新变灰 = 微信收下并发出去了
    if not wait_for(lambda: not node_enabled(send_node), DEADLINE_SENT):
        raise RuntimeError("发送键还亮着，字卡在输入框里没发出去")


def available() -> bool:
    try:
        f = frame_node()
        nodes = scan(f)
        return in_target_chat(nodes) or session_item(nodes) is not None
    except Exception:
        return False


def send_image(wid: str, f, image_path: str) -> None:
    """发一张图。判据跟发字一模一样：发送键亮了才回车，变灰了才算发出去。"""
    if not os.path.isfile(image_path):
        raise RuntimeError(f"图不存在: {image_path}")
    png = png_for(image_path)
    nodes = ensure_in_chat(wid, f)
    box = input_box(nodes)
    if not box:
        raise RuntimeError("无障碍树里没有输入框，没敢盲发")
    bx, by, _node = box
    btn = send_button(nodes)
    if not btn:
        raise RuntimeError("无障碍树里没有发送键，没敢盲发")
    send_node = btn[2]

    click_rel(wid, bx, by)
    key(wid, "ctrl+a", "BackSpace")
    set_clipboard_image(png)
    key(wid, "ctrl+v")

    if not wait_for(lambda: node_enabled(send_node), DEADLINE_FILLED + 2.0):
        raise RuntimeError("粘贴后发送键没亮，图没进去，没发")
    key(wid, "Return")
    if not wait_for(lambda: not node_enabled(send_node), DEADLINE_SENT + 2.0):
        raise RuntimeError("发送键还亮着，图卡在输入框里没发出去")


def main() -> int:
    if len(sys.argv) < 2:
        print("用法: linux-wx-send-a11y.py [--check | --image <路径>] <文本>", file=sys.stderr)
        return 2
    if sys.argv[1] == "--check":
        return 0 if available() else 1
    if not TARGET.strip():
        print("没给 LINUX_WX_TARGET（发给哪个聊天窗），没敢盲发", file=sys.stderr)
        return 2
    if sys.argv[1] == "--image":
        if len(sys.argv) < 3:
            print("用法: linux-wx-send-a11y.py --image <图片路径>", file=sys.stderr)
            return 2
        t0 = time.time()
        wid = weixin_wid()
        send_image(wid, frame_node(), sys.argv[2])
        print(f"linux-wechat(a11y) 发图 1 张，{time.time() - t0:.2f}s")
        return 0
    text = sys.argv[1]
    if not text.strip():
        print("empty", file=sys.stderr)
        return 2

    t0 = time.time()
    wid = weixin_wid()
    f = frame_node()
    activate(wid)
    segs = split_segs(text)
    for i, seg in enumerate(segs):
        send_one(wid, f, seg)
    print(f"linux-wechat(a11y) 发了 {len(segs)} 段，{time.time() - t0:.2f}s")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as e:
        print(str(e), file=sys.stderr)
        raise SystemExit(1)
