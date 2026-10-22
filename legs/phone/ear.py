#!/usr/bin/env python3
"""电话线 · 听的那半 —— 从虚拟音箱连续录音，按停顿切出「对方说的一句」。

为什么录 `<PHONE_SPEAKER>.monitor`：微信把对方的声音播到这个虚拟音箱（它是默认输出），
我们在它的 monitor 上偷听。他自己的声音走的是另一个设备（`<PHONE_MIC_SINK>` → remap 成
默认麦克风），两条物理上不相通 —— 所以**不会听见他自己**，没有回声循环。

VAD 参数的来路：手机实测调出来的那套（约 200ms 真人声才开句、结尾静音 720ms 才提交），
这里按采样率换算成帧数。
"""
import array
import math
import os
import subprocess
import sys
import wave

RATE, CH, FRAME_MS = 16000, 1, 20
FRAME = RATE * FRAME_MS // 1000                # 320 样本
START_HOLD_MS = 200                            # 连续这么久有人声才算开句
END_SIL_MS = 720                               # 结尾静音这么久才提交
MIN_UTT_MS = 400                               # 太短的不要（咳嗽 / 杂音）
MAX_UTT_MS = 20000


def rms(buf):
    a = array.array('h')
    a.frombytes(buf)
    if not a:
        return 0.0
    return math.sqrt(sum(x * x for x in a) / len(a))


def open_stream(device, xdg_runtime_dir):
    return subprocess.Popen(
        ["parecord", f"--device={device}", "--rate", str(RATE), "--channels", str(CH),
         "--format=s16le", "--raw", "--latency-msec=20"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        env={**os.environ, "XDG_RUNTIME_DIR": xdg_runtime_dir})


def segment(read, calib_s=1.0, floor_mult=3.0, min_floor=120, log=None):
    """生成器：`read(n)` 给原始 PCM，每吐出一段「一句」的 PCM bytes。

    跟录音设备分开写，测试可以直接喂字节。
    """
    # 先听一秒本底噪声，阈值按它定（不同通话底噪差很多，写死会瞎）
    n = int(calib_s * 1000 / FRAME_MS)
    vals = []
    for _ in range(n):
        b = read(FRAME * 2)
        if not b:
            break
        vals.append(rms(b))
    base = sorted(vals)[len(vals) // 2] if vals else 0
    thr = max(base * floor_mult, min_floor)
    if log:
        log(f"[耳朵] 本底 {base:.0f} → 开句阈值 {thr:.0f}")

    need_start = START_HOLD_MS // FRAME_MS
    need_end = END_SIL_MS // FRAME_MS
    voiced = 0
    silent = 0
    buf = []
    active = False
    while True:
        b = read(FRAME * 2)
        if not b:
            break
        loud = rms(b) > thr
        if not active:
            voiced = voiced + 1 if loud else 0
            buf.append(b)
            buf = buf[-need_start * 2:]            # 留一点前置，别把字头吃掉
            if voiced >= need_start:
                active = True
                silent = 0
        else:
            buf.append(b)
            silent = 0 if loud else silent + 1
            dur = len(buf) * FRAME_MS
            if silent >= need_end or dur >= MAX_UTT_MS:
                pcm = b"".join(buf)
                buf = []
                active = False
                voiced = 0
                if len(pcm) / 2 / RATE * 1000 >= MIN_UTT_MS:
                    yield pcm


def utterances(device, xdg_runtime_dir, **kw):
    """从真实设备录。生成器：每吐出一段「一句」的 PCM bytes。"""
    p = open_stream(device, xdg_runtime_dir)
    log = lambda m: print(m, file=sys.stderr, flush=True)   # noqa: E731
    yield from segment(p.stdout.read, log=log, **kw)


def save_wav(pcm, path):
    w = wave.open(path, 'wb')
    w.setnchannels(CH)
    w.setsampwidth(2)
    w.setframerate(RATE)
    w.writeframes(pcm)
    w.close()
    return path
