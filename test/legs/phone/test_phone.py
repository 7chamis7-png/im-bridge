"""通话进程（legs/phone）的单元测试 —— 不碰真声卡、不碰网络。

跑法：python3 -m unittest discover -s test/legs/phone -t .
（test/gate/phone-leg.js 会顺带跑它，所以 npm test 里也有。）
"""
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import wave

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
LEG = os.path.join(ROOT, "legs", "phone")
sys.path.insert(0, LEG)

import config  # noqa: E402
import ear  # noqa: E402
import phone  # noqa: E402
import voice  # noqa: E402


def _readjson(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def base_env(tmp, **extra):
    env = {
        "GATE_PHONE_INBOX_DIR": os.path.join(tmp, "inbox"),
        "GATE_PHONE_SOCKET": os.path.join(tmp, "phone.sock"),
        "GATE_OWNER_PHONE_ID": "peer-1",
        "ELEVENLABS_API_KEY": "test-key",
        "ELEVENLABS_DEFAULT_VOICE_ID": "voice-x",
        "XDG_RUNTIME_DIR": "/run/user/test",
        "PHONE_TMP_DIR": os.path.join(tmp, "t"),
    }
    env.update(extra)
    return env


class FakeResp:
    def __init__(self, body=b"", chunks=None):
        self.body = body
        self.chunks = list(chunks or [])

    def read(self, n=-1):
        if self.chunks:
            return self.chunks.pop(0)
        if n == -1 or n is None:
            b, self.body = self.body, b""
            return b
        b, self.body = self.body[:n], self.body[n:]
        return b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FakeMouth:
    def __init__(self):
        self.said = []
        self.stopped = 0
        self.play_until = 0.0

    def synth(self, text):
        self.said.append(text)
        return 1.0

    def stop(self):
        self.stopped += 1


class FakeVoice:
    def __init__(self, text="你好", tone=None, fail=False):
        self.text, self.tn, self.fail = text, tone, fail
        self.transcribed = 0
        self.spoken = []

    def transcribe(self, cfg, wav):
        self.transcribed += 1
        if self.fail:
            raise RuntimeError("网断了")
        return self.text

    def tone(self, cfg, wav):
        return self.tn

    is_tone_not_voice = staticmethod(voice.is_tone_not_voice)

    def speak(self, cfg, text):
        self.spoken.append(text)
        return True


class Clock:
    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t


def make_phone(tmp, probe_state=None, clock=None, voice_=None, **envx):
    cfg = config.load(base_env(tmp, **envx))
    os.makedirs(cfg["inbox"], exist_ok=True)
    probe = (lambda: probe_state["up"]) if probe_state is not None else None
    ph = phone.Phone(cfg, voice=voice_ or FakeVoice(), probe=probe, clock=clock or Clock(), logger=lambda *a: None)
    ph.mouth = FakeMouth()
    return ph


class ConfigTest(unittest.TestCase):
    def test_missing_required_lists_all(self):
        with self.assertRaises(config.ConfigError) as cm:
            config.load({})
        msg = str(cm.exception)
        for name in ("GATE_PHONE_INBOX_DIR", "GATE_PHONE_SOCKET", "GATE_OWNER_PHONE_ID",
                     "ELEVENLABS_API_KEY", "ELEVENLABS_DEFAULT_VOICE_ID"):
            self.assertIn(name, msg)

    def test_need_voice_false_skips_elevenlabs(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = base_env(tmp)
            del env["ELEVENLABS_API_KEY"], env["ELEVENLABS_DEFAULT_VOICE_ID"]
            cfg = config.load(env, need_voice=False)
            self.assertEqual(cfg["el_key"], "")

    def test_neutral_defaults(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = config.load(base_env(tmp))
            self.assertEqual((cfg["speaker"], cfg["mic_sink"]), ("imb_speaker", "imb_mic_sink"))
            self.assertEqual(cfg["call_probe"], "wechat-window")
            self.assertEqual(cfg["wx_dir"], os.path.join(ROOT, "src", "gate", "plugins", "wechat"))
            self.assertTrue(os.path.exists(os.path.join(cfg["wx_dir"], "wx-call.py")))
            self.assertEqual(cfg["north_ear_python"], "")

    def test_key_from_env_file_and_key_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            ef = os.path.join(tmp, "x.env")
            with open(ef, "w") as fh:
                fh.write("# c\nexport ELEVENLABS_API_KEY='from-env-file'\nOTHER=1\n")
            env = base_env(tmp, PHONE_ENV_FILE=ef)
            del env["ELEVENLABS_API_KEY"]
            self.assertEqual(config.load(env)["el_key"], "from-env-file")
            # 显式给的优先，不被文件覆盖
            env2 = base_env(tmp, PHONE_ENV_FILE=ef)
            self.assertEqual(config.load(env2)["el_key"], "test-key")
            kf = os.path.join(tmp, "k.secret")
            with open(kf, "w") as fh:
                fh.write("from-key-file\n")
            env3 = base_env(tmp, ELEVENLABS_API_KEY_FILE=kf)
            del env3["ELEVENLABS_API_KEY"]
            self.assertEqual(config.load(env3)["el_key"], "from-key-file")

    def test_bad_env_file_and_probe(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(config.ConfigError):
                config.load(base_env(tmp, PHONE_ENV_FILE=os.path.join(tmp, "nope")))
            with self.assertRaises(config.ConfigError) as cm:
                config.load(base_env(tmp, PHONE_CALL_PROBE="maybe"))
            self.assertIn("PHONE_CALL_PROBE", str(cm.exception))

    def test_tts_model_file_then_env_then_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(config.tts_model(config.load(base_env(tmp))), "eleven_v3")
            self.assertEqual(config.tts_model(config.load(base_env(tmp, ELEVENLABS_MODEL="eleven_flash_v2_5"))),
                             "eleven_flash_v2_5")
            with open(os.path.join(tmp, "tts-model"), "w") as fh:
                fh.write("eleven_multilingual_v2\n")
            cfg = config.load(base_env(tmp, GATE_ROOT=tmp, ELEVENLABS_MODEL="eleven_flash_v2_5"))
            self.assertEqual(config.tts_model(cfg), "eleven_multilingual_v2")
            self.assertEqual(cfg["producers_dir"], os.path.join(tmp, "producers"))

    def test_main_exits_2_on_missing_config(self):
        r = subprocess.run([sys.executable, os.path.join(LEG, "phone.py"), "--no-dial"],
                           env={"PATH": os.environ.get("PATH", ""), "PYTHONDONTWRITEBYTECODE": "1"}, capture_output=True, text=True, timeout=20)
        self.assertEqual(r.returncode, 2)
        self.assertIn("GATE_PHONE_SOCKET", r.stderr)


class InboxTest(unittest.TestCase):
    def test_drop_matches_bridge_contract(self):
        with tempfile.TemporaryDirectory() as tmp:
            ph = make_phone(tmp, probe_state={"up": True})
            ph.call_tick()
            p1 = ph.drop("喂")
            p2 = ph.drop("听得到吗")
            n1, n2 = os.path.basename(p1), os.path.basename(p2)
            self.assertRegex(n1, r"^\d{12}\.json$")
            self.assertLess(n1, n2)                      # 单调，桥按文件名排序 + 游标
            rec = _readjson(p1)
            self.assertEqual(set(rec), {"id", "at", "text", "peerId", "accountId"})
            self.assertEqual(rec["id"], n1[:12].lstrip("0"))
            self.assertEqual((rec["text"], rec["peerId"], rec["accountId"]), ("喂", "peer-1", "phone"))
            self.assertRegex(rec["at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
            self.assertEqual([f for f in os.listdir(ph.cfg["inbox"]) if f.startswith(".")], [])

    def test_seq_starts_above_old_cursor(self):
        with tempfile.TemporaryDirectory() as tmp:
            ph = make_phone(tmp)
            self.assertGreater(int(os.path.basename(ph.drop("x"))[:12]), 1_700_000_000)


class SayTest(unittest.TestCase):
    def test_say_queues_and_plays_batch(self):
        with tempfile.TemporaryDirectory() as tmp:
            ph = make_phone(tmp, probe_state={"up": True})
            ph.call_tick()
            self.assertEqual(ph.on_request({"type": "say", "text": "第一句"}), {"ok": True, "why": ""})
            self.assertEqual(ph.on_request({"type": "say", "text": "第二句"})["ok"], True)
            ph.play_batch()
            self.assertEqual(ph.mouth.said, ["第一句\n第二句"])      # 同一刻涌来的合成一个请求
            self.assertEqual(ph._st["speaking"], 0)

    def test_unknown_type(self):
        with tempfile.TemporaryDirectory() as tmp:
            ph = make_phone(tmp, probe_state={"up": True})
            self.assertEqual(ph.on_request({"type": "dial"})["ok"], False)

    def test_streamed_then_whole_skips_repeat(self):
        with tempfile.TemporaryDirectory() as tmp:
            ph = make_phone(tmp, probe_state={"up": True})
            ph.call_tick()
            ph.on_request({"type": "say", "text": "你好呀，", "stream": True})
            ph.on_request({"type": "say", "text": "听得到吗", "stream": True})
            self.assertEqual(ph.on_request({"type": "say", "text": "你好呀，听得到吗"}), {"ok": True, "why": ""})
            self.assertEqual(ph._say_q.qsize(), 2)                       # 只有流着的两句

    def test_after_hangup_say_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            st = {"up": True}
            ph = make_phone(tmp, probe_state=st)
            ph.call_tick()
            ph.on_request({"type": "say", "text": "还没念的这句"})
            st["up"] = False
            ph.call_tick()
            self.assertFalse(ph.live)
            self.assertEqual(ph._say_q.qsize(), 0)                       # 排着的作废
            self.assertEqual(ph.mouth.stopped, 1)                        # 正在放的掐掉
            r = ph.on_request({"type": "say", "text": "挂了才到的这句"})
            self.assertEqual(r, {"ok": False, "why": "现在没有通话"})
            r = ph.on_request({"type": "say", "text": "流的也不收", "stream": True})
            self.assertEqual(r["ok"], False)
            self.assertEqual(ph._say_q.qsize(), 0)

    def test_after_hangup_fully_streamed_whole_is_ok(self):
        """通话中已经流着念完的那一轮，整段在挂断后才到：确实说过了，回 ok。"""
        with tempfile.TemporaryDirectory() as tmp:
            st = {"up": True}
            ph = make_phone(tmp, probe_state=st)
            ph.call_tick()
            ph.on_request({"type": "say", "text": "拜拜啦", "stream": True})
            st["up"] = False
            ph.call_tick()
            self.assertEqual(ph.on_request({"type": "say", "text": "拜拜啦"})["ok"], True)
            self.assertEqual(ph.on_request({"type": "say", "text": "拜拜啦，还有一句没流"})["ok"], False)

    def test_before_any_call_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            ph = make_phone(tmp, probe_state={"up": False})
            ph.call_tick()
            self.assertEqual(ph.on_request({"type": "say", "text": "喂"})["ok"], False)

    def test_always_mode_is_legacy(self):
        with tempfile.TemporaryDirectory() as tmp:
            ph = make_phone(tmp, PHONE_CALL_PROBE="always")
            self.assertTrue(ph.live)
            ph.call_tick()
            self.assertEqual(ph.on_request({"type": "say", "text": "喂"})["ok"], True)

    def test_synth_failure_falls_back_to_speak(self):
        with tempfile.TemporaryDirectory() as tmp:
            fv = FakeVoice()
            ph = make_phone(tmp, probe_state={"up": True}, voice_=fv)
            ph.call_tick()

            def boom(text):
                raise RuntimeError("x")
            ph.mouth.synth = boom
            ph.on_request({"type": "say", "text": "兜底"})
            ph.play_batch()
            self.assertEqual(fv.spoken, ["兜底"])


class SocketTest(unittest.TestCase):
    def test_socket_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            st = {"up": True}
            ph = make_phone(tmp, probe_state=st)
            ph.call_tick()
            ready = threading.Event()
            threading.Thread(target=ph.serve, args=(ready,), daemon=True).start()
            self.assertTrue(ready.wait(5))
            self.assertEqual(stat.S_IMODE(os.stat(ph.cfg["socket"]).st_mode), 0o600)
            import socket as so

            def ask(obj):
                c = so.socket(so.AF_UNIX, so.SOCK_STREAM)
                c.connect(ph.cfg["socket"])
                c.sendall(json.dumps(obj).encode() + b"\n")
                data = c.recv(4096)
                c.close()
                return json.loads(data.split(b"\n")[0])
            self.assertEqual(ask({"type": "say", "operationId": "op1", "text": "嗨"})["ok"], True)
            st["up"] = False
            ph.call_tick()
            self.assertEqual(ask({"type": "say", "text": "嗨"}), {"ok": False, "why": "现在没有通话"})


class NudgeTest(unittest.TestCase):
    def notes(self, ph):
        d = ph.cfg["producers_dir"]
        if not os.path.isdir(d):
            return []
        return [_readjson(os.path.join(d, f)) for f in sorted(os.listdir(d))
                if f.endswith(".json") and not f.startswith(".")]

    def test_nudge_after_ringback_ends(self):
        with tempfile.TemporaryDirectory() as tmp:
            clk = Clock(1000.0)
            ph = make_phone(tmp, probe_state={"up": True}, clock=clk, GATE_PRODUCERS_DIR=os.path.join(tmp, "prod"),
                            voice_=FakeVoice(text="[outro jingle]"))
            ph.call_tick()                                    # 1000：窗口出现（在响）
            clk.t = 1003.0
            ph.process_utterance(0, b"\x00\x01" * 16000, 16000)   # 回铃音结束
            self.assertNotEqual(ph.call["tone_end"], 0.0)
            clk.t = 1006.0
            ph.call_tick()
            self.assertEqual(self.notes(ph), [])              # 才静了 3 秒
            clk.t = 1007.5
            ph.call_tick()
            notes = self.notes(ph)
            self.assertEqual(len(notes), 1)
            n = notes[0]
            self.assertEqual(n["producer"], "phone")
            self.assertEqual(n["target"], {"platform": "phone", "chat_id": "peer-1"})
            self.assertIn("7 秒", n["text"])
            self.assertRegex(n["at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")
            self.assertTrue(n["id"].startswith("n-"))
            clk.t = 1030.0
            ph.call_tick()
            self.assertEqual(len(self.notes(ph)), 1)          # 一通电话只提醒一次

    def test_no_nudge_when_she_spoke(self):
        with tempfile.TemporaryDirectory() as tmp:
            clk = Clock(1000.0)
            ph = make_phone(tmp, probe_state={"up": True}, clock=clk, GATE_PRODUCERS_DIR=os.path.join(tmp, "prod"))
            ph.call_tick()
            clk.t = 1002.0
            self.assertEqual(ph.process_utterance(0, b"\x00\x01" * 16000, 16000), "你好")
            clk.t = 1100.0
            ph.call_tick()
            self.assertEqual(self.notes(ph), [])
            self.assertEqual(len(os.listdir(ph.cfg["inbox"])), 1)

    def test_fallback_without_any_sound(self):
        with tempfile.TemporaryDirectory() as tmp:
            clk = Clock(1000.0)
            ph = make_phone(tmp, probe_state={"up": True}, clock=clk, GATE_PRODUCERS_DIR=os.path.join(tmp, "prod"))
            ph.call_tick()
            clk.t = 1014.0
            ph.call_tick()
            self.assertEqual(self.notes(ph), [])
            clk.t = 1015.0
            ph.call_tick()
            self.assertEqual(len(self.notes(ph)), 1)

    def test_new_call_resets_nudge(self):
        with tempfile.TemporaryDirectory() as tmp:
            clk = Clock(1000.0)
            st = {"up": True}
            ph = make_phone(tmp, probe_state=st, clock=clk, GATE_PRODUCERS_DIR=os.path.join(tmp, "prod"))
            ph.call_tick()
            clk.t = 1020.0
            ph.call_tick()
            st["up"] = False
            clk.t = 1021.0
            ph.call_tick()
            st["up"] = True
            clk.t = 1030.0
            ph.call_tick()
            clk.t = 1046.0
            ph.call_tick()
            self.assertEqual(len(self.notes(ph)), 2)

    def test_disabled(self):
        for extra in ({"PHONE_NUDGE_AFTER_S": "0"}, {}):          # 关掉 / 没配投递口
            with tempfile.TemporaryDirectory() as tmp:
                clk = Clock(1000.0)
                env = dict(extra)
                if extra:
                    env["GATE_PRODUCERS_DIR"] = os.path.join(tmp, "prod")
                ph = make_phone(tmp, probe_state={"up": True}, clock=clk, **env)
                ph.call_tick()
                clk.t = 1100.0
                ph.call_tick()
                self.assertFalse(os.path.isdir(os.path.join(tmp, "prod")) and os.listdir(os.path.join(tmp, "prod")))

    def test_always_mode_never_nudges(self):
        with tempfile.TemporaryDirectory() as tmp:
            clk = Clock(1000.0)
            ph = make_phone(tmp, clock=clk, PHONE_CALL_PROBE="always", GATE_PRODUCERS_DIR=os.path.join(tmp, "prod"))
            clk.t = 1100.0
            ph.call_tick()
            self.assertFalse(os.path.isdir(os.path.join(tmp, "prod")))


class ListenTest(unittest.TestCase):
    def test_not_live_skips_transcription(self):
        with tempfile.TemporaryDirectory() as tmp:
            fv = FakeVoice()
            ph = make_phone(tmp, probe_state={"up": False}, voice_=fv)
            ph.call_tick()
            self.assertIsNone(ph.process_utterance(0, b"\x00\x01" * 16000, 16000))
            self.assertEqual(fv.transcribed, 0)                   # 不在通话里连 API 都不调（省钱）

    def test_ringback_by_tone_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            tn = {"segments": [{"pitch_range_hz": 2.9}]}
            ph = make_phone(tmp, probe_state={"up": True}, voice_=FakeVoice(text="嘟", tone=tn))
            ph.call_tick()
            self.assertIsNone(ph.process_utterance(0, b"\x00\x01" * 16000, 16000))
            self.assertEqual(os.listdir(ph.cfg["inbox"]), [])

    def test_acoustic_line_attached(self):
        with tempfile.TemporaryDirectory() as tmp:
            tn = {"total_duration": 2.0, "n_segments": 1, "segments": [
                {"avg_hz": 220, "direction": "→", "range_hz": 50, "moan": 0.0, "breath": 0.1, "desc": "清晰说话"}]}
            ph = make_phone(tmp, probe_state={"up": True}, voice_=FakeVoice(text="在吗", tone=tn))
            ph.call_tick()
            ph.process_utterance(0, b"\x00\x01" * 16000, 16000)
            f = os.listdir(ph.cfg["inbox"])[0]
            rec = _readjson(os.path.join(ph.cfg["inbox"], f))
            self.assertEqual(rec["text"], "在吗\n[声学 2.0s/1段] 段1 220Hz→ range50 呻吟感0.0 气声0.1·清晰说话")

    def test_transcribe_failure_logged_not_dropped(self):
        with tempfile.TemporaryDirectory() as tmp:
            ph = make_phone(tmp, probe_state={"up": True}, voice_=FakeVoice(fail=True))
            ph.call_tick()
            self.assertIsNone(ph.process_utterance(0, b"\x00\x01" * 16000, 16000))

    def test_turn_taking_buffers_and_dedups(self):
        with tempfile.TemporaryDirectory() as tmp:
            clk = Clock(1000.0)
            ph = make_phone(tmp, probe_state={"up": True}, clock=clk)
            ph.call_tick()
            ph.hear("你好")
            ph.hear("你好。")                                     # 重复 = 在催
            ph.hear("在吗")
            self.assertEqual(len(os.listdir(ph.cfg["inbox"])), 1)
            ph.on_request({"type": "say", "text": "在呢"})
            ph.play_batch()
            clk.t = 1000.0 + 0.1
            ph.flush_tick()
            self.assertEqual(len(os.listdir(ph.cfg["inbox"])), 1)   # 他刚说完，还没静够 HOLD
            ph._st["last_say"] = 0
            ph.flush_tick()
            self.assertEqual(len(os.listdir(ph.cfg["inbox"])), 2)


class VoiceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.cfg = config.load(base_env(self.tmp, PHONE_MIC_SINK="sink_t"))
        self.reqs = []
        self.orig = (voice.urlopen, voice.subprocess.Popen, voice.subprocess.run)

    def tearDown(self):
        voice.urlopen, voice.subprocess.Popen, voice.subprocess.run = self.orig
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_transcribe_request(self):
        def fake(req, timeout=None):
            self.reqs.append(req)
            return FakeResp(json.dumps({"text": " 你好 "}).encode())
        voice.urlopen = fake
        wav = os.path.join(self.tmp, "a.wav")
        ear.save_wav(b"\x00\x00" * 160, wav)
        self.assertEqual(voice.transcribe(self.cfg, wav), "你好")
        r = self.reqs[0]
        self.assertEqual(r.full_url, "https://api.elevenlabs.io/v1/speech-to-text")
        self.assertEqual(r.get_header("Xi-api-key"), "test-key")
        self.assertIn(b'name="model_id"\r\n\r\nscribe_v1', r.data)
        self.assertIn(b'filename="a.wav"', r.data)

    def test_mouth_synth_and_play_args(self):
        popens = []

        class P:
            def __init__(self, args, **kw):
                popens.append((args, kw))
                self.stdin = io.BytesIO()

            def poll(self):
                return None

            def kill(self):
                pass
        voice.subprocess.Popen = P

        def fake(req, timeout=None):
            self.reqs.append(req)
            return FakeResp(chunks=[b"\x01\x02\x03", b"\x04\x05", b""])
        voice.urlopen = fake
        m = voice.Mouth(self.cfg, start_writer=False)
        secs = m.synth("[soft laugh] 你好")
        r = self.reqs[0]
        self.assertEqual(r.full_url, "https://api.elevenlabs.io/v1/text-to-speech/voice-x/stream?output_format=pcm_22050")
        self.assertEqual(json.loads(r.data), {"text": "[soft laugh] 你好", "model_id": "eleven_v3"})   # v3 保留标签
        self.assertEqual(r.get_header("Xi-api-key"), "test-key")
        chunks = []
        while not m.audio.empty():
            chunks.append(m.audio.get()[1])
        self.assertEqual(b"".join(chunks), b"\x01\x02\x03\x04")       # 奇数字节留到下一块，最后半个样本丢
        self.assertAlmostEqual(secs, 4 / 2 / 22050)
        m._pacat()
        args, kw = popens[0]
        self.assertEqual(args, ["pacat", "--playback", "--device=sink_t", "--raw", "--rate=22050",
                                "--channels=1", "--format=s16le", "--latency-msec=300"])
        self.assertEqual(kw["env"]["XDG_RUNTIME_DIR"], "/run/user/test")

    def test_non_v3_strips_tags_and_empty_skips(self):
        cfg = config.load(base_env(self.tmp, ELEVENLABS_MODEL="eleven_flash_v2_5"))
        voice.urlopen = lambda req, timeout=None: (self.reqs.append(req), FakeResp(chunks=[b""]))[1]
        m = voice.Mouth(cfg, start_writer=False)
        m.synth("[sigh] 好吧")
        self.assertEqual(json.loads(self.reqs[0].data)["text"], "好吧")
        self.assertEqual(m.synth("[sigh]"), 0.0)
        self.assertEqual(len(self.reqs), 1)

    def test_stop_discards_pending_audio(self):
        m = voice.Mouth(self.cfg, start_writer=False)
        m.audio.put((m.gen, b"\x00\x00"))
        m.stop()
        self.assertTrue(m.audio.empty())
        self.assertEqual(m.gen, 1)

    def test_tone_without_north_ear_is_none(self):
        called = []
        voice.subprocess.run = lambda *a, **k: called.append(a)
        self.assertIsNone(voice.tone(self.cfg, "/x.wav"))
        self.assertEqual(called, [])

    def test_tone_with_north_ear(self):
        cfg = config.load(base_env(self.tmp, NORTH_EAR_PYTHON="/py", NORTH_EAR_SCRIPT="/ne.py"))
        seen = []

        def run(args, **kw):
            seen.append(args)
            return subprocess.CompletedProcess(args, 0, stdout='{"segments": []}', stderr="")
        voice.subprocess.run = run
        self.assertEqual(voice.tone(cfg, "/x.wav"), {"segments": []})
        self.assertEqual(seen[0], ["/py", "/ne.py", "/x.wav", "--json"])


class EarTest(unittest.TestCase):
    def test_segment_splits_on_silence(self):
        import array
        frame = ear.FRAME

        def frames(amp, n):
            return [array.array('h', [amp if i % 2 else -amp for i in range(frame)]).tobytes() for _ in range(n)]
        seq = frames(0, 50) + frames(3000, 40) + frames(0, 60) + frames(3000, 5) + frames(0, 60)
        data = io.BytesIO(b"".join(seq))
        out = list(ear.segment(data.read))
        self.assertEqual(len(out), 1)                 # 第二段只有 100ms，太短不要
        self.assertGreaterEqual(len(out[0]) / 2 / ear.RATE, 0.8)

    def test_save_wav(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = ear.save_wav(b"\x00\x00" * 1600, os.path.join(tmp, "a.wav"))
            w = wave.open(p)
            self.assertEqual((w.getframerate(), w.getnchannels(), w.getnframes()), (16000, 1, 1600))


class WindowProbeTest(unittest.TestCase):
    def test_probe_uses_xdotool_title_search(self):
        seen = []

        def run(args, **kw):
            seen.append((args, kw.get("env", {}).get("DISPLAY")))
            return subprocess.CompletedProcess(args, 0, stdout="12345\n", stderr="")
        with tempfile.TemporaryDirectory() as tmp:
            cfg = config.load(base_env(tmp, DISPLAY=":77"))
        self.assertTrue(phone.window_probe(cfg, run=run)())
        self.assertEqual(seen[0], (["xdotool", "search", "--name", "^Voice Call$"], ":77"))
        self.assertFalse(phone.window_probe(cfg, run=lambda a, **k: subprocess.CompletedProcess(a, 1, "", ""))())

        def boom(a, **k):
            raise FileNotFoundError("xdotool")
        self.assertFalse(phone.window_probe(cfg, run=boom)())


# ───────── scripts/setup-phone-audio.sh --check（假 pactl / pgrep / ps）─────────
SCRIPT = os.path.join(ROOT, "scripts", "setup-phone-audio.sh")


def fake_bin(tmp, sinks, sources, modules, default_sink, default_source, pulse_age, wechat_age, clients="wechat"):
    b = os.path.join(tmp, "bin")
    os.makedirs(b, exist_ok=True)
    log = os.path.join(tmp, "pactl.log")

    def w(name, body):
        p = os.path.join(b, name)
        with open(p, "w") as fh:
            fh.write("#!/bin/sh\n" + body)
        os.chmod(p, 0o755)
    w("pactl", f"""echo "$*" >> {log}
case "$*" in
  info) printf 'Server Name: pulseaudio\\nDefault Sink: {default_sink}\\nDefault Source: {default_source}\\n' ;;
  "list short sinks") printf '{sinks}' ;;
  "list short sources") printf '{sources}' ;;
  "list short modules") printf '{modules}' ;;
  "list short clients") printf '17\\tprotocol-native.c\\t{clients}\\n' ;;
  *) exit 1 ;;
esac
""")
    w("pgrep", """case "$2" in pulseaudio) echo 100 ;; wechat) %s ;; esac
""" % ("echo 200" if wechat_age is not None else "exit 1"))
    w("ps", f"""case "$4" in 100) echo " {pulse_age}" ;; 200) echo " {wechat_age}" ;; esac
""")
    return b, log


GOOD = dict(
    sinks="0\\timb_mic_sink\\tmodule-null-sink.c\\n1\\timb_speaker\\tmodule-null-sink.c\\n",
    sources="0\\timb_mic_sink.monitor\\tx\\n1\\timb_speaker.monitor\\tx\\n2\\timb_mic\\tmodule-remap-source.c\\n",
    modules="3\\tmodule-remap-source\\tmaster=imb_mic_sink.monitor source_name=imb_mic source_properties=x\\n",
    default_sink="imb_speaker", default_source="imb_mic")


class SetupScriptTest(unittest.TestCase):
    def run_check(self, **kw):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        args = {**GOOD, "pulse_age": 5000, "wechat_age": 100, **kw}
        b, log = fake_bin(tmp, **args)
        env = {"PATH": b + ":/usr/bin:/bin", "XDG_RUNTIME_DIR": tmp}
        r = subprocess.run(["bash", SCRIPT, "--check"], env=env, capture_output=True, text=True, timeout=20)
        calls = ""
        if os.path.exists(log):
            with open(log) as fh:
                calls = fh.read()
        return r, calls

    def test_syntax(self):
        self.assertEqual(subprocess.run(["bash", "-n", SCRIPT]).returncode, 0)

    def test_all_good(self):
        r, calls = self.run_check()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("体检通过", r.stdout)
        self.assertNotIn("load-module", calls)                        # 只读：一样没建
        self.assertNotIn("set-default", calls)

    def test_wechat_older_than_pulse_needs_restart(self):
        r, _ = self.run_check(pulse_age=100, wechat_age=5000)
        self.assertEqual(r.returncode, 1)
        self.assertIn("需要重启微信", r.stdout)

    def test_missing_devices_and_wrong_defaults(self):
        r, calls = self.run_check(sinks="0\\tsomething\\tx\\n", sources="", modules="",
                                  default_sink="something", default_source="other")
        self.assertEqual(r.returncode, 1)
        for want in ("缺输出设备 imb_speaker", "缺放音设备 imb_mic_sink", "缺麦克风 imb_mic", "默认输出是「something」",
                     "默认输入是「other」"):
            self.assertIn(want, r.stdout)
        self.assertNotIn("load-module", calls)

    def test_mic_not_remap_of_mic_sink(self):
        r, _ = self.run_check(modules="")
        self.assertEqual(r.returncode, 1)
        self.assertIn("不是 imb_mic_sink.monitor 的 remap", r.stdout)

    def test_wechat_not_running_is_note_only(self):
        r, _ = self.run_check(wechat_age=None)
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("微信没在跑", r.stdout)

    def test_custom_names(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        b, _ = fake_bin(tmp, sinks="0\\tmy_spk\\tx\\n1\\tmy_ms\\tx\\n", sources="2\\tmy_mic\\tx\\n",
                        modules="3\\tmodule-remap-source\\tmaster=my_ms.monitor source_name=my_mic\\n",
                        default_sink="my_spk", default_source="my_mic", pulse_age=9, wechat_age=1)
        env = {"PATH": b + ":/usr/bin:/bin", "XDG_RUNTIME_DIR": tmp,
               "PHONE_SPEAKER": "my_spk", "PHONE_MIC_SINK": "my_ms", "PHONE_MIC": "my_mic"}
        r = subprocess.run(["bash", SCRIPT, "--check"], env=env, capture_output=True, text=True, timeout=20)
        self.assertEqual(r.returncode, 0, r.stdout)

    def test_bad_name_rejected(self):
        r = subprocess.run(["bash", SCRIPT, "--check"], env={"PATH": "/usr/bin:/bin", "PHONE_MIC": "a b"},
                           capture_output=True, text=True, timeout=20)
        self.assertEqual(r.returncode, 2)

    def test_print_snippets(self):
        r = subprocess.run(["bash", SCRIPT, "--print-default-pa"], env={"PATH": "/usr/bin:/bin"},
                           capture_output=True, text=True, timeout=20)
        self.assertEqual(r.returncode, 0)
        self.assertIn("load-module module-remap-source master=imb_mic_sink.monitor source_name=imb_mic", r.stdout)
        self.assertIn("set-default-sink   imb_speaker", r.stdout)
        r = subprocess.run(["bash", SCRIPT, "--print-systemd"], env={"PATH": "/usr/bin:/bin"},
                           capture_output=True, text=True, timeout=20)
        self.assertEqual(r.returncode, 0)
        self.assertIn("Type=oneshot", r.stdout)


if __name__ == "__main__":
    unittest.main()
