#!/usr/bin/env python3
"""Linux WeChat outbound via accessibility (AT-SPI): no screenshots, no OCR.

With libatk-adaptor installed, WeChat exposes its widget tree on the AT-SPI bus,
so the chat title, chat list and input box can be found by name with exact
coordinates:
  "am I in the target chat?"  -> check the top label
  "where is the input box?"   -> find the role=text node
  "was it sent?"              -> the Send button becomes disabled again
Every wait polls until the condition holds instead of sleeping fixed times.

Notes:
- AT-SPI can read but not click (button actions only offer SetFocus); clicks use xdotool.
- AT-SPI coordinates differ from X screen coordinates by the window decoration
  offset, so everything is converted to frame-relative coordinates and clicked
  with `xdotool mousemove --window`.

WARNING: UI automation of the WeChat client may trigger account restrictions.
Use at your own risk.

Environment:
  LINUX_WX_TARGET   title of the target chat (required)
  LINUX_WX_DISPLAY  X display (default :0)
"""
from __future__ import annotations

import os
import re
import tempfile
import subprocess
import sys
import time

DISPLAY = os.environ.get("LINUX_WX_DISPLAY", ":0")
os.environ.setdefault("DISPLAY", DISPLAY)
os.environ.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
os.environ.setdefault("DBUS_SESSION_BUS_ADDRESS", f"unix:path={os.environ['XDG_RUNTIME_DIR']}/bus")
ENV = dict(os.environ)

TARGET = os.environ.get("LINUX_WX_TARGET", "")
# The chat title sits above this y; names further down are chat content, not the title
TITLE_MAX_Y = 100
DEADLINE_ENTER = 3.0      # wait to enter the target chat
DEADLINE_FILLED = 2.0     # wait for text to land in the input box
DEADLINE_SENT = 4.0       # wait for the Send button to disable (= sent)
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
    """WeChat's top-level frame. Raises if unavailable."""
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
    raise RuntimeError("WeChat is not on the accessibility bus (was it started with accessibility enabled?)")


def scan(f):
    """Walk visible nodes; returns [(role, name, relx, rely, w, h, node)] relative to the frame origin."""
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
    """Top title matches TARGET = the target chat is open."""
    for role, name, x, y, w, h, _ in nodes:
        if role == "label" and y < TITLE_MAX_Y and name.strip().startswith(TARGET):
            return True
    return False


def input_box(nodes):
    """Input box: role=text named after the peer (the search box is also text; the name disambiguates)."""
    for role, name, x, y, w, h, node in nodes:
        if role == "text" and name.strip().startswith(TARGET):
            return (x + w // 2, y + h // 2, node)
    return None


def session_item(nodes):
    """The target's row in the chat list."""
    for role, name, x, y, w, h, _ in nodes:
        if role == "list item" and name.strip().startswith(TARGET):
            return (x + w // 2, y + h // 2)
    return None


def box_text(node) -> str:
    """WeChat's input node does NOT report its content (always empty).
    Debug only; never use it to check whether text is present."""
    try:
        return node.queryText().getText(0, 4096)
    except Exception:
        return ""


def send_button(nodes):
    """Send button: disabled when empty, enabled with content, disabled again after sending.
    This is the reliable signal."""
    for role, name, x, y, w, h, node in nodes:
        if role == "button" and name.strip() == "Send":
            return (x + w // 2, y + h // 2, node)
    return None


def node_enabled(node) -> bool:
    """Check a single node's state. When polling, avoid walking the whole tree
    (~0.4s per walk vs. milliseconds for one node)."""
    import pyatspi
    try:
        return node.getState().contains(pyatspi.STATE_ENABLED)
    except Exception:
        return False


def send_ready(f) -> bool:
    """Something to send = Send button enabled. (Use node_enabled when polling.)"""
    btn = send_button(scan(f))
    return bool(btn) and node_enabled(btn[2])


def wait_for(fn, deadline: float):
    """Poll until the condition holds; returns the last result."""
    end = time.time() + deadline
    val = None
    while time.time() < end:
        val = fn()
        if val:
            return val
        time.sleep(TICK)
    return val


# ── X operations ───────────────────────────────────────────────────────────────

def weixin_wid() -> str:
    r = run(["xdotool", "search", "--name", "^Weixin$"], capture_output=True, text=True, check=False)
    wids = [ln.strip() for ln in r.stdout.splitlines() if ln.strip()]
    if not wids:
        raise RuntimeError("Linux WeChat window not found")
    return wids[-1]


def activate(wid: str) -> None:
    run(["xdotool", "windowactivate", "--sync", wid], check=False)
    run(["xdotool", "windowfocus", "--sync", wid], check=False)


def click_rel(wid: str, x: int, y: int) -> None:
    """Click at window-relative coordinates, avoiding the decoration offset."""
    run(["xdotool", "mousemove", "--window", wid, str(x), str(y)], check=False)
    run(["xdotool", "click", "1"], check=False)


def set_clipboard(text: str) -> None:
    for sel in ("clipboard", "primary"):
        subprocess.run(
            ["xclip", "-selection", sel],
            input=text.encode("utf-8"), env=ENV, check=True, timeout=10,
        )


def png_for(path: str) -> str:
    """WeChat's clipboard paste only accepts bitmaps; convert webp/others to PNG
    in the temp dir. Animated images are not handled (first frame only).
    """
    if path.lower().endswith(".png"):
        return path
    out = os.path.join(tempfile.gettempdir(), "wx-send-" + str(os.getpid()) + ".png")
    subprocess.run(["convert", path, out], env=ENV, check=True, timeout=20)
    return out


def set_clipboard_image(png_path: str) -> None:
    """Put an image on the clipboard.

    xclip forks into the background to hold the selection; don't capture stdout
    or the parent will hang.
    """
    subprocess.run(
        ["xclip", "-selection", "clipboard", "-t", "image/png", "-i", png_path],
        env=ENV, check=True, timeout=10,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


def key(wid: str, *keys: str) -> None:
    for k in keys:
        run(["xdotool", "key", "--window", wid, "--clearmodifiers", k], check=False)


# ── sending ─────────────────────────────────────────────────────────────────

def split_segs(text: str) -> list[str]:
    segs = [s.strip() for s in re.split(r"\n\s*\n+", text) if s.strip()]
    return segs or [text.strip()]


def ensure_in_chat(wid: str, f) -> list:
    """Make sure the target chat is open; no-op if it already is."""
    nodes = scan(f)
    if in_target_chat(nodes):
        return nodes
    item = session_item(nodes)
    if not item:
        raise RuntimeError(f"{TARGET} not found in the chat list; refusing to send blindly")
    click_rel(wid, item[0], item[1])
    nodes = wait_for(lambda: (lambda ns: ns if in_target_chat(ns) else None)(scan(f)), DEADLINE_ENTER)
    if not nodes or not in_target_chat(nodes):
        raise RuntimeError(f"clicked {TARGET} but the title did not change; refusing to send blindly")
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

    # wait for the text to land: watch the Send button, not a timer
    if not wait_for(lambda: node_enabled(send_node), DEADLINE_FILLED):
        raise RuntimeError("粘贴后发送键没亮，字没进去，没发")

    # Send with Enter rather than clicking: the Send button is small enough that the
    # decoration offset can make clicks miss.
    key(wid, "Return")

    # Send button disabled again = WeChat accepted and sent it
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
    """Send an image. Same signal as text: Enter once Send is enabled, done once it disables."""
    if not os.path.isfile(image_path):
        raise RuntimeError(f"image not found: {image_path}")
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
    if not TARGET:
        print("LINUX_WX_TARGET is not set", file=sys.stderr)
        return 2
    if len(sys.argv) < 2:
        print("usage: linux-wx-send-a11y.py [--check | --image <path>] <text>", file=sys.stderr)
        return 2
    if sys.argv[1] == "--check":
        return 0 if available() else 1
    if sys.argv[1] == "--image":
        if len(sys.argv) < 3:
            print("usage: linux-wx-send-a11y.py --image <image path>", file=sys.stderr)
            return 2
        t0 = time.time()
        wid = weixin_wid()
        send_image(wid, frame_node(), sys.argv[2])
        print(f"linux-wechat(a11y) sent 1 image in {time.time() - t0:.2f}s")
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
    print(f"linux-wechat(a11y) sent {len(segs)} segment(s) in {time.time() - t0:.2f}s")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as e:
        print(str(e), file=sys.stderr)
        raise SystemExit(1)
