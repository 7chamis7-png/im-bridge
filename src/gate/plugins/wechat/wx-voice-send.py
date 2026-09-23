#!/usr/bin/env python3
"""Send a WeChat voice message through a virtual microphone.

The Linux WeChat client can't send an audio file as a voice message; voice
messages can only be recorded. So TTS audio is played into a fake microphone
while WeChat records:

    click "Send Voice"  ->  start recording
    paplay -> virtual mic sink  ->  WeChat records the audio
    click "Send"        ->  a real voice bubble is sent

Usage: wx-voice-send.py <audio.wav>
Env:   LINUX_WX_TARGET       chat window title
       PULSE_SINK            virtual mic sink (default agent_mic_sink)
       LINUX_WX_DISPLAY      X display (default :0)
       LINUX_WX_SPOTS        cached button offsets JSON
                             (default $IM_BRIDGE_HOME/wechat/wx-spots.json)
       LINUX_WX_A11Y         accessibility helper (default: linux-wx-send-a11y.py next to this file)
       LINUX_WX_KEYS         WeChat DB keys JSON, used to verify the message landed (optional)
       LINUX_WX_OWNER_WXID   peer wxid, used for the same verification (optional)

Pitfalls:
1. AT-SPI coordinates are scaled (e.g. ~1.04x vs. xdotool); convert with
   screen = window origin + AT-SPI relative * scale. Small buttons miss otherwise.
2. Once recording starts, the `Send` button disappears from the accessibility
   tree (the recording UI is custom-drawn), so both positions are recorded
   before starting.
3. A previously unfinished recording can hide `Send Voice`; press Esc first.

WARNING: UI automation of the WeChat client may trigger account restrictions.
"""

import importlib.util
import json
import os
import random
import subprocess
import sys
import time

# The bridge process usually has no DISPLAY; provide one.
os.environ.setdefault("DISPLAY", os.environ.get("LINUX_WX_DISPLAY", ":0"))
os.environ.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")

HERE = os.path.dirname(os.path.abspath(__file__))
# Button offsets are cached: frequent accessibility-tree scans can hang or crash
# the WeChat client, so scan only on first use or after the window size changes.
_HOME = os.environ.get("IM_BRIDGE_HOME") or os.path.expanduser("~/.im-bridge")
SPOTS_FILE = os.environ.get("LINUX_WX_SPOTS") or os.path.join(_HOME, "wechat", "wx-spots.json")
# Reuse the accessibility helpers (find window, scan nodes) from the text sender
A11Y = os.environ.get("LINUX_WX_A11Y") or os.path.join(HERE, "linux-wx-send-a11y.py")


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
        raise SystemExit("WeChat window not found")
    return ids[0]


def geometry(wid):
    g = subprocess.run(["xdotool", "getwindowgeometry", wid],
                       capture_output=True, text=True).stdout
    pos = [l for l in g.split("\n") if "Position" in l][0].split()[1].split(",")
    geo = [l for l in g.split("\n") if "Geometry" in l][0].split()[1].split("x")
    return int(pos[0]), int(pos[1]), int(geo[0]), int(geo[1])


def load_spots(geo):
    """The cache stores offsets relative to the window origin, not absolute coordinates,
    so it survives window moves; it is invalidated only when the window size changes.
    """
    try:
        with open(SPOTS_FILE, encoding="utf-8") as fh:
            d = json.load(fh)
    except Exception:                                # noqa: BLE001
        return None
    size = d.get("size") or []
    if len(size) != 2 or abs(size[0] - geo[2]) > 8 or abs(size[1] - geo[3]) > 8:
        return None                                  # window resized: offsets are stale
    rel = d.get("rel") or {}
    if "Send Voice" not in rel or "Send" not in rel:
        return None
    return {k: (geo[0] + v[0], geo[1] + v[1]) for k, v in rel.items()}


def save_spots(geo, spots):
    """Store offsets (absolute - window origin) plus the current window size."""
    try:
        os.makedirs(os.path.dirname(SPOTS_FILE), exist_ok=True)
        rel = {k: [v[0] - geo[0], v[1] - geo[1]] for k, v in spots.items()}
        with open(SPOTS_FILE, "w", encoding="utf-8") as fh:
            json.dump({"size": [geo[2], geo[3]], "rel": rel}, fh, ensure_ascii=False, indent=2)
        os.chmod(SPOTS_FILE, 0o600)
    except Exception as e:                           # noqa: BLE001
        print("could not write the offset cache (this send is unaffected): " + str(e), file=sys.stderr)


def voice_count():
    """Number of voice messages (type=34) in the target chat. Returns -1 when unknown, never 0."""
    try:
        import hashlib
        import sqlite3                                # noqa: F401  (just checks sqlite is available)
        keys_file = os.environ.get("LINUX_WX_KEYS", "")
        if not keys_file:
            return -1
        keys = json.load(open(keys_file, encoding="utf-8"))
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
    """Is the chat pane open? Samples one pixel instead of touching accessibility.

    Clicking the chat row when the chat is already open collapses it, so the
    script never "ensures" the chat is open by clicking.
    """
    wx0, wy0, ww, wh = geo
    png = "/tmp/wx-openprobe.png"
    r = subprocess.run(["import", "-window", "root", png], capture_output=True)
    if r.returncode != 0:
        return None                                  # can't capture: don't guess
    try:
        from PIL import Image
        im = Image.open(png).convert("RGB")
        # chat area: plain white when no chat is open
        px = im.getpixel((wx0 + int(ww * 0.72), wy0 + int(wh * 0.45)))
        return not (px[0] > 244 and px[1] > 244 and px[2] > 244)
    except Exception:                                # noqa: BLE001
        return None


def click(x, y):
    """Click gently: move along an eased path, pause, click, pause.

    Instant jumps plus rapid clicks were observed to hang the client's renderer.
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
        # ease out near the target
        t = i / steps
        ease = t * t * (3 - 2 * t)
        jitter = 0 if i == steps else random.randint(-3, 3)
        nx = int(cx + (x - cx) * ease) + jitter
        ny = int(cy + (y - cy) * ease) + jitter
        subprocess.run(["xdotool", "mousemove", str(nx), str(ny)], check=False)
        time.sleep(random.uniform(0.008, 0.028))

    time.sleep(random.uniform(0.09, 0.22))      # pause before clicking
    subprocess.run(["xdotool", "click", "1"], check=False)
    time.sleep(random.uniform(0.12, 0.30))      # pause after clicking


def scan_spots(wid, geo):
    """Scan the tree once to record three positions: the chat row, Send Voice, Send.

    The only place that touches AT-SPI; runs only when there is no cache.
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
        raise SystemExit("accessibility tree is empty (WeChat not rendered?); refusing to click blindly")

    fw = tuple(frame.queryComponent().getExtents(pyatspi.DESKTOP_COORDS))[2]
    scale = ww / fw if fw else 1.0            # AT-SPI coordinates are scaled; convert
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
        raise SystemExit(target + " not in the chat list; refusing to send blindly")

    # The input-row buttons only exist once a chat is open: open it, then rescan.
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
        raise SystemExit("still not found after opening the chat: " + " ".join(missing))
    return spots


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: wx-voice-send.py <audio.wav>")
    audio = sys.argv[1]
    if not os.path.exists(audio):
        raise SystemExit("audio file not found: " + audio)
    sink = os.environ.get("PULSE_SINK", "agent_mic_sink")

    wid = window_id()
    geo = geometry(wid)
    subprocess.run(["xdotool", "windowactivate", wid], check=False)
    time.sleep(random.uniform(0.4, 0.7))

    spots = load_spots(geo)
    if spots:
        print("using cached offsets, no accessibility scan", file=sys.stderr)
    else:
        spots = scan_spots(wid, geo)
        save_spots(geo, spots)
        print("first run: scanned and cached offsets", file=sys.stderr)

    before = voice_count()

    # --- three clicks using cached offsets ---
    # Don't click the chat row (it collapses an already-open chat). If the chat
    # wasn't open, the database check at the end reports the failure.
    click(*spots["Send Voice"])               # start recording
    time.sleep(random.uniform(1.1, 1.5))      # wait for recording to start so the beginning isn't cut

    r = subprocess.run(["paplay", "--device=" + sink, audio], capture_output=True, text=True)
    if r.returncode != 0:
        subprocess.run(["xdotool", "key", "Escape"], check=False)
        raise SystemExit("playback failed (recording cancelled): " + (r.stderr or "").strip()[:200])
    time.sleep(0.3)

    click(*spots["Send"])                     # send

    # Clicking is not proof of sending: verify a new voice row appeared in the DB.
    if before < 0:
        print("ok (not verified: no DB keys / peer configured)", file=sys.stderr)
        return
    for _ in range(12):
        time.sleep(1.0)
        if voice_count() > before:
            print("ok")
            return
    raise SystemExit("clicked send but no new voice row in the database: NOT sent")


if __name__ == "__main__":
    main()
