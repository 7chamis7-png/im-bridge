#!/usr/bin/env python3
"""Start / hang up a WeChat voice call via UI automation.

Answering is not supported: a WeChat call rings on only one logged-in device,
which may not be this desktop client.

Usage: wx-call.py [--hangup]
Env:   LINUX_WX_TARGET   chat window title
       LINUX_WX_DISPLAY  X display (default :0)
       LINUX_WX_SPOTS    cached button offsets JSON
                         (default $IM_BRIDGE_HOME/wechat/wx-spots.json)

Rules:
  · Clicks use cached window-relative offsets instead of scanning the
    accessibility tree during a call (scanning can blank the WeChat window).
  · Don't click the chat row: clicking an already-open chat again collapses it.
  · Clicks move along a path with small pauses rather than jumping instantly.

WARNING: UI automation of the WeChat client may trigger account restrictions.
"""

import json
import os
import random
import subprocess
import sys
import time

os.environ.setdefault("DISPLAY", os.environ.get("LINUX_WX_DISPLAY", ":0"))
os.environ.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")

_HOME = os.environ.get("IM_BRIDGE_HOME") or os.path.expanduser("~/.im-bridge")
SPOTS_FILE = os.environ.get("LINUX_WX_SPOTS") or os.path.join(_HOME, "wechat", "wx-spots.json")


def window_id(title="^Weixin$", required=True):
    r = subprocess.run(["xdotool", "search", "--name", title],
                       capture_output=True, text=True)
    ids = [x for x in r.stdout.strip().split("\n") if x.strip()]
    if not ids:
        if required:
            raise SystemExit("window not found: " + title)
        return None
    return ids[0]


def geometry(wid):
    g = subprocess.run(["xdotool", "getwindowgeometry", wid],
                       capture_output=True, text=True).stdout
    pos = [l for l in g.split("\n") if "Position" in l][0].split()[1].split(",")
    geo = [l for l in g.split("\n") if "Geometry" in l][0].split()[1].split("x")
    return int(pos[0]), int(pos[1]), int(geo[0]), int(geo[1])


def load_spot(name, geo, section=None):
    """The cache stores window-relative offsets (the window moves when WeChat restarts).

    `section`: default = main window; "call_window" = the separate call window
    (title "Voice Call"), which has its own origin.
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
    """Move along an eased path, pause, click, pause."""
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
        # Hang-up never touches the main window: the call is a separate window.
        cwid = window_id("^Voice Call$", required=False)
        if not cwid:
            raise SystemExit("no call in progress (Voice Call window not found)")
        cgeo = geometry(cwid)
        spot = load_spot("Hang Up", cgeo, section="call_window")
        if not spot:
            raise SystemExit("hang-up button offset missing from cache (call window is now %dx%d?"
                             " rescan during the next call)" % (cgeo[2], cgeo[3]))
        subprocess.run(["xdotool", "windowactivate", cwid], check=False)
        time.sleep(random.uniform(0.3, 0.6))
        click(*spot)
        # verify: the call window must actually disappear before reporting ok
        for _ in range(12):
            time.sleep(0.4)
            if not window_id("^Voice Call$", required=False):
                print("ok")
                return
        raise SystemExit("clicked hang-up but the call window is still open")

    wid = window_id()
    geo = geometry(wid)
    subprocess.run(["xdotool", "windowactivate", wid], check=False)
    time.sleep(random.uniform(0.4, 0.7))

    # Dialing takes two clicks: the title-bar `Voice Call` only opens a menu
    # (voice / video); the menu item actually places the call. Both offsets are cached.
    spot = load_spot("Voice Call", geo)
    menu = load_spot("Voice Call menu", geo)
    if not spot or not menu:
        raise SystemExit("dial button offsets missing from cache (window size changed? rescan): "
                         + ("Voice Call " if not spot else "")
                         + ("Voice Call menu" if not menu else ""))

    click(*spot)                                     # 1. open the menu
    time.sleep(random.uniform(0.8, 1.2))
    click(*menu)                                     # 2. choose voice call
    time.sleep(1.5)
    print("ok")


if __name__ == "__main__":
    main()
