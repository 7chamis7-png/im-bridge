#!/usr/bin/env python3
"""通话进程 —— 桥上 `phone` 那条腿（src/gate/plugins/phone.js）的另一半。

分工按桥定的来，**一句都不越界**：
    这个进程   只管声音：录 → 断句 → 转写 → 落收件箱；收到他的话 → 合成 → 放出去
    桥和他     只管文字：入闸 → 冷层 → 他的线程 → 出闸
  所以这里**一个模型都不调**，他是谁、记得什么，全是桥那边的事。

两条口子（桥的契约）：
    入站   往 $GATE_PHONE_INBOX_DIR 落 `<12位序号>.json`，桥消化完自己删
    出站   在 $GATE_PHONE_SOCKET 上监听，收 {"type":"say","text":...}，回 {"ok":...}。
           **念不出去要如实回 ok:false** —— 电话挂了再念就是鬼话，
           桥会记一笔没送达，不会攒到下一通。

录的是 `<PHONE_SPEAKER>.monitor`（微信把对方的声音播这儿），
放的是 `<PHONE_MIC_SINK>`（remap 成微信的默认麦克风）。两个独立虚拟设备，
物理上不相通 → **不会听见他自己**，没有回声循环。

配置全从环境变量来，见 config.py / docs/phone.md。
"""
import json
import os
import queue
import re
import socket
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config  # noqa: E402

_TAG = re.compile(r"[\[（(][^\]）)]{0,40}[\]）)]")   # [tone] [outro jingle] (笑) 这类音频事件标签

# 轮流说话：递出一句后，到他说完（说过话、且静了 HOLD 秒）之前，对方新说的先攒着，
# 原样重复的直接丢（对方在催，不是新话），说完再一次性递。等太久（GIVEUP）也放行。
HOLD, GIVEUP = 2.5, 45.0

DEFAULT_NUDGE = ("[电话] 通话已经开了 {secs} 秒，对方那头一直没出声 —— 多半是接起来了在等你。"
                 "你先开口打个招呼（一两句就好，像接电话那样）。"
                 "如果你已经收到对方说的话，就直接接那句话，别重复打招呼。")


def _norm(t):
    return re.sub(r"[\s，。！？!?,.~～…、]", "", t)


def acoustic_line(t):
    """语气一行。格式跟桥里语音条那份（acoustic-service.js summarizeAcoustics）一字不差。"""
    try:
        segs = (t or {}).get("segments") or []
        if not segs:
            return ""
        parts = []
        for i, g in enumerate(segs):
            pitch = "无音高" if g.get("avg_hz") is None else f"{g['avg_hz']}Hz{g.get('direction') or ''} range{g.get('range_hz')}"
            parts.append(f"段{i+1} {pitch} 呻吟感{g.get('moan')} 气声{g.get('breath')}·{g.get('desc')}")
        return f"[声学 {t.get('total_duration')}s/{t.get('n_segments')}段] " + " ; ".join(parts)
    except Exception:
        return ""


def log(*a):
    print(time.strftime("[%H:%M:%S]"), *a, flush=True)


# ---------- 通话在不在 ----------
def window_probe(cfg, run=subprocess.run):
    """有没有微信的通话窗口。跟 wx-call.py --hangup 判「现在有没有通话」是同一个办法：
    `xdotool search --name`，只读窗口标题，**不扫无障碍树**（扫树会让微信黑屏）。"""
    env = {**os.environ}
    if cfg.get("display"):
        env["DISPLAY"] = cfg["display"]

    def probe():
        try:
            r = run(["xdotool", "search", "--name", cfg["call_window"]],
                    capture_output=True, text=True, timeout=5, env=env)
            return bool(r.stdout.strip())
        except Exception:
            return False
    return probe


def put_note(dir_, producer, text, target=None, now=None):
    """往桥的生产者投递口放一条（格式跟 src/gate/producers.js putNote 一字不差）。"""
    now = time.time() if now is None else now
    os.makedirs(dir_, exist_ok=True)
    at = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + ".%03dZ" % int((now % 1) * 1000)
    nid = "n-" + format(int(now * 1000), "x") + "-" + os.urandom(3).hex()
    note = {"id": nid, "at": at, "producer": producer, "text": text}
    if target:
        note["target"] = target
    name = re.sub(r"[:.]", "-", at) + "-" + "%06d" % (int(now * 1e6) % 1000000) + "-" + nid + ".json"
    final = os.path.join(dir_, name)
    tmp = os.path.join(dir_, "." + name + ".tmp-" + str(os.getpid()))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(note, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, final)
    return final


class Phone:
    def __init__(self, cfg, voice=None, probe=None, clock=time.time, logger=log):
        self.cfg = cfg
        if voice is None:
            import voice as voice_mod
            voice = voice_mod
        self.voice = voice
        self.clock = clock
        self.log = logger
        # 通话在不在：always = 老行为（进程活着就当在通话）；wechat-window = 看通话窗口
        self.probe = probe or (window_probe(cfg) if cfg["call_probe"] == "wechat-window" else (lambda: True))
        self.always = cfg["call_probe"] == "always" and probe is None
        self.live = self.always
        self.call = {"since": 0.0, "heard": False, "nudged": False, "tone_end": 0.0}

        # ⚠️ 序号必须**单调且大于桥的游标**（桥把 seq <= cursor 的当成消化过的直接删）。
        # 用秒级时间戳起步：重启后也比上次大，截短了会比旧游标小、话被当陈旧文件删掉。
        self._seq = [int(time.time())]
        self._seq_lock = threading.Lock()
        self._turn = threading.Condition()
        self._st = {"waiting": False, "dropped_at": 0.0, "spoke": False, "last_say": 0.0,
                    "speaking": 0, "last_text": "", "buf": []}
        self._say_q = queue.Queue()
        # 盒子边写边递过来的句子（stream:true）。桥整轮结束后还会把整段再递一遍 ——
        # 那份里流过的句子扣掉，剩下的（流断了 / 被标签截停的）才念。
        self._streamed = []
        self.mouth = None

    # ---------- 入站：对方说的话落收件箱 ----------
    def drop(self, text):
        with self._seq_lock:
            self._seq[0] += 1
            n = self._seq[0]
        rec = {"id": str(n), "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "text": text, "peerId": self.cfg["peer"], "accountId": "phone"}
        inbox = self.cfg["inbox"]
        tmp = os.path.join(inbox, f".{n:012d}.tmp")
        dst = os.path.join(inbox, f"{n:012d}.json")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(rec, f, ensure_ascii=False)
        os.replace(tmp, dst)          # 原子落盘：桥不会读到写了一半的文件
        self.log("→ 桥:", text)
        return dst

    def hear(self, text, ac=""):
        with self._turn:
            if not self.live:
                self.log("丢·没在通话:", text)
                return
            self.call["heard"] = True
            if not self._st["waiting"]:
                self._drop_now([(text, ac)])
                return
            n = _norm(text)
            if n == _norm(self._st["last_text"]) or n in (_norm(t) for t, _ in self._st["buf"]):
                self.log("丢·重复(他还没答完):", text)
                return
            self._st["buf"].append((text, ac))
            self.log("攒着(他还在说):", text)

    def _drop_now(self, items):
        self.drop("\n".join(f"{t}\n{a}" if a else t for t, a in items))
        self._st.update(waiting=True, dropped_at=self.clock(), spoke=False, last_text=items[-1][0], buf=[])

    def flush_tick(self):
        with self._turn:
            if not self._st["waiting"] or self._st["speaking"]:
                return
            now = self.clock()
            done = self._st["spoke"] and now - self._st["last_say"] >= HOLD
            stale = now - self._st["dropped_at"] >= GIVEUP
            if not (done or stale):
                return
            if self._st["buf"]:
                self._drop_now(self._st["buf"])
            else:
                self._st["waiting"] = False

    # ---------- 通话状态 ----------
    def call_tick(self):
        """看一眼通话在不在；接通 / 挂断各做一次收拾；该提醒他先开口就推一条。"""
        if self.always:
            return
        now = self.clock()
        up = bool(self.probe())
        if up and not self.live:
            with self._turn:
                self.live = True
                self.call = {"since": now, "heard": False, "nudged": False, "tone_end": 0.0}
                self._reset_turn()
            self.log("通话开始（看到通话窗口）")
        elif not up and self.live:
            with self._turn:
                self.live = False
                self._reset_turn()
                dropped = 0
                try:
                    while True:
                        self._say_q.get_nowait()
                        dropped += 1
                except queue.Empty:
                    pass
                self._st["speaking"] = 0
            if self.mouth is not None:
                self.mouth.stop()
            self.log("通话结束（通话窗口没了）" + (f"，排着没念的 {dropped} 段作废" if dropped else ""))
        if self.live:
            self._maybe_nudge(now)

    def _reset_turn(self):
        self._st.update(waiting=False, dropped_at=0.0, spoke=False, last_say=0.0, last_text="", buf=[])

    def mark_sound_skipped(self):
        """通话中听到一段不是人话的声音（回铃音 / 提示音）。它结束 ≈ 那头接起来了。"""
        if self.live and not self.always:
            self.call["tone_end"] = self.clock()

    def _maybe_nudge(self, now):
        c, cfg = self.call, self.cfg
        if c["nudged"] or c["heard"] or cfg["nudge_after_s"] <= 0 or not cfg["producers_dir"]:
            return
        quiet_after_tone = c["tone_end"] and now - c["tone_end"] >= cfg["nudge_after_s"]
        quiet_overall = now - c["since"] >= max(cfg["nudge_fallback_s"], cfg["nudge_after_s"])
        if not (quiet_after_tone or quiet_overall):
            return
        c["nudged"] = True                         # 一通电话只提醒一次
        secs = int(now - c["since"])
        text = (cfg["nudge_text"] or DEFAULT_NUDGE).replace("{secs}", str(secs))
        try:
            put_note(cfg["producers_dir"], "phone", text,
                     target={"platform": "phone", "chat_id": cfg["peer"]}, now=now)
            self.log(f"接通 {secs}s 对方没出声 → 提醒他先开口")
        except Exception as e:
            self.log("提醒他先开口没投出去:", str(e)[:160])

    # ---------- 出站：他的话，念出来 ----------
    def _minus_streamed(self, text):
        """扣掉流着念过的句子 → (剩下要念的, 有没有扣掉过东西)。剩一两个字算念完了。"""
        with self._turn:
            now = time.time()
            self._streamed[:] = [x for x in self._streamed if now - x[0] < 300]
            rest, used = text, []
            for item in self._streamed:
                k = rest.find(item[1])
                if k >= 0:
                    rest = rest[:k] + rest[k + len(item[1]):]
                    used.append(item)
            for item in used:
                self._streamed.remove(item)
        if len(_norm(_TAG.sub("", rest))) <= 1:
            return "", bool(used)
        return rest.strip(), bool(used)

    def on_request(self, req):
        """一条出站请求 → 回给桥的那个 dict。网络那层在 handle()。"""
        if req.get("type") != "say":
            return {"ok": False, "why": "只会 say"}
        text = (req.get("text") or "").strip()
        if req.get("stream"):
            if not self.live:
                return {"ok": False, "why": "现在没有通话"}
            with self._turn:
                self._streamed.append((time.time(), text))
            self.log("他说(流):", text)
        else:
            rest, streamed_some = self._minus_streamed(text)
            if not self.live and not (not rest and streamed_some):
                # 挂断了。只有「通话中已经流着念完」的整段照实回 ok（确实说出去了），
                # 别的一律 ok:false —— 包括只有一两个字的（那个「太短不念」是通话中的规矩）
                self.log("没在通话，不念:", text[:40])
                return {"ok": False, "why": "现在没有通话"}
            if not rest:
                self.log("已流着念过，跳过:", text[:40])
                return {"ok": True, "why": ""}
            if rest != text:
                self.log("流里念过一部分，补念剩下的")
            text = rest
            self.log("他说:", text)
        # 收下就回 ok，排队念：桥只等 8 秒，排在前一段后面的会被它当成没送达
        with self._turn:
            self._st["speaking"] += 1
            self._st["spoke"] = True
        self._say_q.put(text)
        return {"ok": True, "why": ""}

    def handle(self, c):
        try:
            buf = b""
            while b"\n" not in buf:
                d = c.recv(65536)
                if not d:
                    return
                buf += d
            res = self.on_request(json.loads(buf.split(b"\n")[0]))
            c.sendall(json.dumps(res, ensure_ascii=False).encode() + b"\n")
        except Exception as e:
            try:
                c.sendall(json.dumps({"ok": False, "why": str(e)[:160]}, ensure_ascii=False).encode() + b"\n")
            except Exception:
                pass
        finally:
            try:
                c.close()
            except Exception:
                pass

    def serve(self, ready=None):
        sock = self.cfg["socket"]
        if os.path.exists(sock):
            os.unlink(sock)
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.bind(sock)
        os.chmod(sock, 0o600)
        s.listen(8)
        self.log("出站口就绪", sock)
        if ready:
            ready.set()
        while True:
            c, _ = s.accept()
            threading.Thread(target=self.handle, args=(c,), daemon=True).start()

    def play_batch(self):
        """取一批（同一刻涌来的几句合成一个请求，语调连得上、少一次等待）念掉。"""
        batch = [self._say_q.get()]
        time.sleep(0.15)
        while True:
            try:
                batch.append(self._say_q.get_nowait())
            except queue.Empty:
                break
        text = "\n".join(batch)
        t0 = time.time()
        ok = True
        try:
            secs = self.mouth.synth(text)
        except Exception as e:
            secs = 0
            ok = False
            self.log("  念失败:", str(e)[:120])
            try:
                ok = self.voice.speak(self.cfg, text)        # 老路兜底
            except Exception:
                pass
        finally:
            with self._turn:
                self._st["speaking"] = max(0, self._st["speaking"] - len(batch))
                self._st["last_say"] = max(time.time(), self.mouth.play_until)   # 声音放完才算说完
        self.log("  合成完 %d句 %.1fs音频 用时%.2fs%s" % (len(batch), secs, time.time() - t0, "" if ok else " ✗"))

    def player(self):
        self.mouth = self.mouth or self.voice.Mouth(self.cfg)
        while True:
            self.play_batch()

    # ---------- 听 ----------
    def process_utterance(self, i, pcm, rate):
        """一段录到的声音 → 转写 + 语气 → 递给桥（或说清楚为什么跳过）。"""
        secs = len(pcm) / 2 / rate
        if not self.live:
            # 不在通话里（提示音 / 消息声）：连转写都不调，省钱
            self.log("跳过·没在通话 %.1fs" % secs)
            return None
        os.makedirs(self.cfg["tmp_dir"], exist_ok=True)
        wav = self.voice_save(pcm, os.path.join(self.cfg["tmp_dir"], f"utt-{i % 20}.wav"))
        # 语气（本地）和转写（网上）并行跑，不排队
        box = {}
        th = threading.Thread(target=lambda: box.update(tn=self.voice.tone(self.cfg, wav)), daemon=True)
        th.start()
        err = None
        try:
            txt = self.voice.transcribe(self.cfg, wav)
        except Exception as e:
            txt = None
            err = e
        th.join(25)
        tn = box.get("tn")
        if self.voice.is_tone_not_voice(tn):
            self.log("跳过·回铃音 %.1fs" % secs)
            self.mark_sound_skipped()
            return None
        if txt is None:
            self.log("转写失败:", str(err)[:120])
            return None
        raw, txt = txt, _TAG.sub("", txt or "").strip()
        if not txt:
            self.log("跳过·转不出字 %.1fs" % secs, raw)
            self.mark_sound_skipped()
            return None
        self.hear(txt, acoustic_line(tn))
        return txt

    def voice_save(self, pcm, path):
        import ear
        return ear.save_wav(pcm, path)

    # ---------- 拨号 / 挂断（走微信那条腿的脚本，自己持锁）----------
    def wx(self, args=""):
        cfg = self.cfg
        if not cfg["wx_lock"] or not cfg["wx_target"]:
            self.log("拨号/挂断没配（要 PHONE_WECHAT_LOCK 和 LINUX_WX_TARGET），跳过")
            return False
        script = os.path.join(cfg["wx_dir"], "wx-call.py")
        cmd = (f'exec 9>{json.dumps(cfg["wx_lock"])}; flock -w 60 9 || exit 1; '
               f'timeout -k 5 60 python3 -u {json.dumps(script)} {args}')
        env = {**os.environ, "LINUX_WX_TARGET": cfg["wx_target"], "XDG_RUNTIME_DIR": cfg["xdg_runtime_dir"]}
        if cfg["display"]:
            env["DISPLAY"] = cfg["display"]
        # ⚠️ fd 9 在 sh -c 里自己开自己关，不外泄给别的子进程（外泄过：起微信时继承了锁，整条出站被挡死）
        return subprocess.run(["/bin/sh", "-c", cmd], capture_output=True, text=True, env=env).returncode == 0


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    try:
        cfg = config.load()
    except config.ConfigError as e:
        print(str(e), file=sys.stderr, flush=True)
        return 2
    import ear
    import voice as voice_mod

    ph = Phone(cfg, voice=voice_mod)
    os.makedirs(cfg["inbox"], exist_ok=True)
    log("配置：录", cfg["listen_device"] or cfg["speaker"] + ".monitor", "· 放", cfg["mic_sink"],
        "· 通话判定", cfg["call_probe"],
        "· 语气", "开" if cfg["north_ear_python"] and cfg["north_ear_script"] else "关",
        "· 先开口提醒", ("关" if cfg["nudge_after_s"] <= 0 or not cfg["producers_dir"] or ph.always
                    else f"{cfg['nudge_after_s']:g}s/{cfg['nudge_fallback_s']:g}s"))
    if cfg["call_probe"] == "wechat-window" and subprocess.run(
            ["sh", "-c", "command -v xdotool"], capture_output=True).returncode != 0:
        print("PHONE_CALL_PROBE=wechat-window 要 xdotool（apt install xdotool），或者改成 always", file=sys.stderr)
        return 2

    ready = threading.Event()
    threading.Thread(target=ph.serve, args=(ready,), daemon=True).start()

    def loop(fn, every):
        while True:
            time.sleep(every)
            try:
                fn()
            except Exception as e:
                log("后台小循环出错:", str(e)[:160])
    threading.Thread(target=loop, args=(ph.flush_tick, 0.3), daemon=True).start()
    threading.Thread(target=loop, args=(ph.call_tick, cfg["call_poll_s"]), daemon=True).start()
    threading.Thread(target=ph.player, daemon=True).start()
    ready.wait(5)
    if "--no-dial" not in argv:
        log("拨号 →", cfg["wx_target"])
        if not ph.wx():
            log("拨号失败（继续监听，也可以手动接）")
    try:
        device = cfg["listen_device"] or cfg["speaker"] + ".monitor"
        for i, pcm in enumerate(ear.utterances(device, cfg["xdg_runtime_dir"])):
            ph.process_utterance(i, pcm, ear.RATE)
    except KeyboardInterrupt:
        pass
    finally:
        log("收尾：" + ("挂断 + " if cfg["hangup_on_exit"] else "") + "撤掉出站口")
        if cfg["hangup_on_exit"]:
            ph.wx("--hangup")
        try:
            os.unlink(cfg["socket"])
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
