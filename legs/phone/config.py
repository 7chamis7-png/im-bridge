#!/usr/bin/env python3
"""通话进程的配置 —— **只从环境变量读**，没有指向任何人家目录的默认值。

全表见 docs/phone.md「配置项」。这里的规矩跟桥一样（src/core/paths.js）：
  · 必填的缺了就当场点名、退出，不回落到「猜一个路径」
  · 钥匙只从 env 或钥匙文件读，绝不写进仓库
  · 可选的（north-ear、拨号、接通提醒）没配就是关着，日志里说一声
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
# 微信那条腿的脚本（拨号 / 挂断）跟着仓库走，不写绝对路径
WXDIR_DEFAULT = os.path.join(REPO, "src", "gate", "plugins", "wechat")


class ConfigError(Exception):
    """配置缺了 / 写错了。message 里逐条点名。"""


def load_env_file(path, environ=None):
    """读一个 KEY=VALUE 的 env 文件（`#` 注释、可带 `export `、值可带引号）。

    **只补没设的**（setdefault）：命令行 / run.sh 里显式给的优先。
    钥匙文件放仓库外（比如 ~/.secrets/），这个函数只读不写。
    """
    env = os.environ if environ is None else environ
    with open(path, encoding="utf-8") as fh:
        for ln in fh:
            ln = ln.strip()
            if not ln or ln.startswith("#") or "=" not in ln:
                continue
            if ln.startswith("export "):
                ln = ln[len("export "):].strip()
            k, v = ln.split("=", 1)
            k = k.strip()
            if k:
                env.setdefault(k, v.strip().strip('"').strip("'"))


def _s(env, key, default=""):
    return str(env.get(key, default) or "").strip()


def _f(env, key, default):
    raw = _s(env, key)
    if not raw:
        return float(default)
    try:
        return float(raw)
    except ValueError:
        raise ConfigError(f"{key} 要一个数字，拿到的是 {raw!r}")


def load(environ=None, need_voice=True):
    """把环境变量收成一个 dict。缺必填项抛 ConfigError（一次列全）。

    need_voice=False 时不查 ElevenLabs 那两项（只做体检 / 测试用）。
    """
    env = os.environ if environ is None else environ

    env_file = _s(env, "PHONE_ENV_FILE")
    if env_file:
        try:
            load_env_file(env_file, env)
        except OSError as e:
            raise ConfigError(f"PHONE_ENV_FILE 读不了：{env_file}（{e.strerror}）")

    key = _s(env, "ELEVENLABS_API_KEY")
    key_file = _s(env, "ELEVENLABS_API_KEY_FILE")
    if not key and key_file:
        try:
            with open(key_file, encoding="utf-8") as fh:
                key = fh.read().strip()
        except OSError as e:
            raise ConfigError(f"ELEVENLABS_API_KEY_FILE 读不了：{key_file}（{e.strerror}）")

    gate_root = _s(env, "GATE_ROOT")
    model_file = _s(env, "ELEVENLABS_MODEL_FILE") or (os.path.join(gate_root, "tts-model") if gate_root else "")

    cfg = {
        # —— 跟桥的契约（src/gate/plugins/phone.js 读同一组变量）——
        "inbox": _s(env, "GATE_PHONE_INBOX_DIR"),
        "socket": _s(env, "GATE_PHONE_SOCKET"),
        "peer": _s(env, "GATE_OWNER_PHONE_ID"),
        "producers_dir": _s(env, "GATE_PRODUCERS_DIR") or (os.path.join(gate_root, "producers") if gate_root else ""),
        # —— 声音设备（scripts/setup-phone-audio.sh 用同一组名字建）——
        "speaker": _s(env, "PHONE_SPEAKER", "imb_speaker"),
        "listen_device": _s(env, "PHONE_LISTEN_DEVICE"),
        "mic_sink": _s(env, "PHONE_MIC_SINK", "imb_mic_sink"),
        "xdg_runtime_dir": _s(env, "XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}",
        "tmp_dir": _s(env, "PHONE_TMP_DIR", "/tmp/imb-phone"),
        # —— ElevenLabs ——
        "el_key": key,
        "el_voice": _s(env, "PHONE_VOICE_ID") or _s(env, "ELEVENLABS_DEFAULT_VOICE_ID"),
        "el_model_file": model_file,
        "el_model": _s(env, "ELEVENLABS_MODEL"),
        "el_stt_model": _s(env, "PHONE_STT_MODEL", "scribe_v1"),
        "el_base": _s(env, "ELEVENLABS_API_BASE", "https://api.elevenlabs.io").rstrip("/"),
        # —— 听语气（可选，north-ear 不在本仓库）——
        "north_ear_python": _s(env, "NORTH_EAR_PYTHON"),
        "north_ear_script": _s(env, "NORTH_EAR_SCRIPT"),
        # —— 拨号 / 挂断（走微信那条腿的 wx-call.py；只在要拨号或退出挂断时用）——
        "wx_target": _s(env, "LINUX_WX_TARGET") or _s(env, "GATE_WECHAT_TARGET"),
        "wx_lock": _s(env, "PHONE_WECHAT_LOCK") or _s(env, "GATE_WECHAT_SEND_LOCK"),
        "wx_dir": _s(env, "PHONE_WECHAT_DIR") or WXDIR_DEFAULT,
        "display": _s(env, "DISPLAY") or _s(env, "LINUX_WX_DISPLAY"),
        "hangup_on_exit": _s(env, "PHONE_HANGUP_ON_EXIT", "1") not in ("0", "off", "false", "no"),
        # —— 通话在不在（见 phone.py「通话状态」）——
        "call_probe": _s(env, "PHONE_CALL_PROBE", "wechat-window"),
        "call_window": _s(env, "PHONE_CALL_WINDOW", "^Voice Call$"),
        "call_poll_s": _f(env, "PHONE_CALL_POLL_S", 1.0),
        # —— 接通后她一直不出声 → 推一条提醒让他先开口（0 = 关）——
        "nudge_after_s": _f(env, "PHONE_NUDGE_AFTER_S", 4.0),
        "nudge_fallback_s": _f(env, "PHONE_NUDGE_FALLBACK_S", 15.0),
        "nudge_text": _s(env, "PHONE_NUDGE_TEXT"),
    }

    missing = []
    for k, name, why in (
        ("inbox", "GATE_PHONE_INBOX_DIR", "她说的话落到这个目录，桥来捞（要跟桥那边同一个值）"),
        ("socket", "GATE_PHONE_SOCKET", "他的话从这个 unix socket 递过来（要跟桥那边同一个值）"),
        ("peer", "GATE_OWNER_PHONE_ID", "她在电话这条腿上的身份（要跟桥那边同一个值）"),
    ):
        if not cfg[k]:
            missing.append(f"  · {name} —— {why}")
    if need_voice:
        if not cfg["el_key"]:
            missing.append("  · ELEVENLABS_API_KEY（或 ELEVENLABS_API_KEY_FILE / PHONE_ENV_FILE）—— 转写和合成都要它")
        if not cfg["el_voice"]:
            missing.append("  · ELEVENLABS_DEFAULT_VOICE_ID（或 PHONE_VOICE_ID）—— 他用哪个音色说话。不填不猜，免得用上别人的声音")
    if cfg["call_probe"] not in ("wechat-window", "always"):
        missing.append(f"  · PHONE_CALL_PROBE 只能是 wechat-window / always，拿到的是 {cfg['call_probe']!r}")
    if missing:
        raise ConfigError("通话进程配置不全：\n" + "\n".join(missing))
    return cfg


def tts_model(cfg):
    """合成用哪个模型：文件 → 环境变量 → eleven_v3（跟桥 tts-service.js 同一个顺序、同一个文件）。

    每次现读：改了文件，下一句就换，不用重启。
    """
    path = cfg.get("el_model_file") or ""
    if path:
        try:
            with open(path, encoding="utf-8") as fh:
                raw = fh.read().strip()
            if raw:
                return raw
        except OSError:
            pass
    return cfg.get("el_model") or "eleven_v3"
