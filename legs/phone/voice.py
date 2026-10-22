#!/usr/bin/env python3
"""通话进程 · 声音零件：转写 / 听语气 / 出声。

⚠️ **这里没有「他回话」。** 桥定的分工（src/gate/plugins/phone.js）：
   声音那一整段脏活在另一个进程里，桥只跟它交换文字，一个音频 API 都不碰。
   反过来也成立：回话是桥和他的事，这个进程一个模型都不调。

所有外部调用都走模块级的 `urlopen` / `subprocess`，测试里换掉就不碰网络和声卡。
"""
import json
import os
import queue as _q
import re
import subprocess
import threading
import time
import urllib.request
import uuid

import config

urlopen = urllib.request.urlopen          # 测试替换点

_TAGS = re.compile(r"\[[^\]]*\]")


def _pulse_env(cfg):
    return {**os.environ, "XDG_RUNTIME_DIR": cfg["xdg_runtime_dir"]}


# ---------- ① 转写（ElevenLabs Scribe：实测 0.8~1.1s）----------
def transcribe(cfg, wav_path):
    b = "----imb" + uuid.uuid4().hex

    def part(name, val=None, fname=None, ctype=None, raw=None):
        h = f'--{b}\r\nContent-Disposition: form-data; name="{name}"'
        if fname:
            h += f'; filename="{fname}"\r\nContent-Type: {ctype}'
        h += "\r\n\r\n"
        return h.encode() + (raw if raw is not None else val.encode()) + b"\r\n"

    with open(wav_path, "rb") as fh:
        audio = fh.read()
    body = part("model_id", cfg["el_stt_model"]) \
        + part("file", fname="a.wav", ctype="audio/wav", raw=audio) \
        + f"--{b}--\r\n".encode()
    req = urllib.request.Request(cfg["el_base"] + "/v1/speech-to-text", data=body,
                                 headers={"xi-api-key": cfg["el_key"],
                                          "content-type": f"multipart/form-data; boundary={b}"})
    d = json.loads(urlopen(req, timeout=30).read())
    return (d.get("text") or "").strip()


# ---------- ② 听语气（north-ear，本地、可选，跟转写并行跑）----------
def tone(cfg, wav_path):
    """没配 north-ear（NORTH_EAR_PYTHON + NORTH_EAR_SCRIPT）就直接 None：少一行语气，别的照常。"""
    py, script = cfg.get("north_ear_python"), cfg.get("north_ear_script")
    if not py or not script:
        return None
    try:
        r = subprocess.run([py, script, wav_path, "--json"], capture_output=True, text=True, timeout=20)
        return json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip() else None
    except Exception:
        return None


def is_tone_not_voice(t):
    """回铃音 = 纯音：音高范围极小。实测回铃 range 2.9Hz，人说话远大于这个。"""
    try:
        segs = t.get("segments") or []
        if not segs:
            return True
        return all((s.get("pitch_range_hz") or s.get("range") or 99) < 15 for s in segs)
    except Exception:
        return False


# ---------- ③ 出声 ----------
# 模型跟语音条走同一个开关（桥 tts-service.js 读的那份文件）。
# v3 认 [soft laugh] 这类标签，保留；别的模型（flash）不认会当正文念出来，才剥。
def clean_for(model, text):
    clean = text.strip() if model == "eleven_v3" else _TAGS.sub("", text).strip()
    if not _TAGS.sub("", clean).strip():
        return ""
    return clean


def tts_request(cfg, text, model, output_format):
    url = f"{cfg['el_base']}/v1/text-to-speech/{cfg['el_voice']}/stream?output_format={output_format}"
    return urllib.request.Request(url, data=json.dumps({"text": text, "model_id": model}).encode(),
                                  headers={"xi-api-key": cfg["el_key"], "content-type": "application/json"})


def pacat_cmd(sink, rate, latency_ms):
    return ["pacat", "--playback", f"--device={sink}", "--raw", f"--rate={rate}",
            "--channels=1", "--format=s16le", f"--latency-msec={latency_ms}"]


def speak(cfg, text):
    """老路兜底（Mouth 合成失败时用）：一句一个请求、一个播放进程。"""
    model = config.tts_model(cfg)
    clean = clean_for(model, text)
    if not clean:
        return False
    try:
        return _speak_stream(cfg, clean, model)
    except Exception:
        pass
    os.makedirs(cfg["tmp_dir"], exist_ok=True)
    url = (f"{cfg['el_base']}/v1/text-to-speech/{cfg['el_voice']}/stream?optimize_streaming_latency=3")
    req = urllib.request.Request(url, data=json.dumps({"text": clean, "model_id": model,
                                                       "output_format": "mp3_22050_32"}).encode(),
                                 headers={"xi-api-key": cfg["el_key"], "content-type": "application/json"})
    mp3 = os.path.join(cfg["tmp_dir"], "out.mp3")
    wav = os.path.join(cfg["tmp_dir"], "out.wav")
    with urlopen(req, timeout=60) as r, open(mp3, "wb") as f:
        f.write(r.read())
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", mp3, "-ar", "44100", "-ac", "1", wav], check=True)
    subprocess.run(["paplay", f"--device={cfg['mic_sink']}", wav], env=_pulse_env(cfg), check=False)
    return True


def _speak_stream(cfg, clean, model):
    r = urlopen(tts_request(cfg, clean, model, "pcm_22050"), timeout=60)
    # 先攒 0.6 秒再开播：网上来的块一阵一阵，缓冲太小会断断续续
    pre = b""
    while len(pre) < 22050 * 2 * 6 // 10:
        b = r.read(4096)
        if not b:
            break
        pre += b
    if not pre:
        raise RuntimeError("空音频")
    p = subprocess.Popen(pacat_cmd(cfg["mic_sink"], 22050, 400), stdin=subprocess.PIPE, env=_pulse_env(cfg))
    # 开播之后出错不能抛出去：外面会回落老路把整句再念一遍
    try:
        p.stdin.write(pre)
        while True:
            b = r.read(4096)
            if not b:
                break
            p.stdin.write(b)
    except Exception:
        pass
    try:
        p.stdin.close()
        p.wait(timeout=120)
    except Exception:
        pass
    return True


# ---------- ④ 连读：一个播放进程常开，合成在调用者线程里边下边灌 ----------
class Mouth:
    RATE = 22050

    def __init__(self, cfg, start_writer=True):
        self.cfg = cfg
        self.sink = cfg["mic_sink"]
        self.p = None
        self.audio = _q.Queue()
        self.play_until = 0.0
        self.gen = 0                              # 挂断时 +1：还在下载的那句就地作废
        if start_writer:
            threading.Thread(target=self._writer, daemon=True).start()

    def _pacat(self):
        if self.p is None or self.p.poll() is not None:
            self.p = subprocess.Popen(pacat_cmd(self.sink, self.RATE, 300),
                                      stdin=subprocess.PIPE, env=_pulse_env(self.cfg))
        return self.p

    def synth(self, text):
        """在调用者线程里下载，块一边到一边进播放队列。返回这句的秒数。"""
        model = config.tts_model(self.cfg)
        clean = clean_for(model, text)
        if not clean:
            return 0.0
        gen = self.gen
        n = 0
        odd = b""
        with urlopen(tts_request(self.cfg, clean, model, f"pcm_{self.RATE}"), timeout=60) as r:
            while True:
                if gen != self.gen:
                    break                         # 电话挂了，剩下的不要了
                b = r.read(4096)
                if not b:
                    break
                b = odd + b
                if len(b) % 2:
                    odd, b = b[-1:], b[:-1]
                else:
                    odd = b""
                n += len(b)
                self.audio.put((gen, b))
        secs = n / 2 / self.RATE
        now = time.time()
        self.play_until = max(self.play_until, now) + secs
        return secs

    def stop(self):
        """挂断：排着的不放了，正在放的掐掉。"""
        self.gen += 1
        try:
            while True:
                self.audio.get_nowait()
        except _q.Empty:
            pass
        self.play_until = 0.0
        p, self.p = self.p, None
        if p is not None:
            try:
                p.kill()
            except Exception:
                pass

    def _writer(self):
        while True:
            gen, b = self.audio.get()
            if gen != self.gen:
                continue
            try:
                self._pacat().stdin.write(b)
                self.p.stdin.flush()
            except Exception:
                try:
                    self.p.kill()
                except Exception:
                    pass
                self.p = None
