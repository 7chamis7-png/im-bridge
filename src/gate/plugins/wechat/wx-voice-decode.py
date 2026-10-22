#!/usr/bin/env python3
"""微信语音 SILK v3 -> WAV。

微信 4.0 的语音存在 media_0.db 的 VoiceInfo.voice_data，编码是 SILK v3
（头部 `\x02#!SILK_V3`）。pilk 直接吃这个头，解成 PCM(s16le)，再用 ffmpeg 封成 WAV。
whisper 吃 WAV，声学层 north_ear 也吃 WAV。

用法:  wx-voice-decode.py <silk_in> <wav_out> [pcm_rate]
只做解码这一件事：读不到 / 解不出就非零退出并打印原因，绝不写半截文件。
"""
import os
import sys
import subprocess


def main():
    if len(sys.argv) < 3:
        sys.stderr.write("用法: wx-voice-decode.py <silk_in> <wav_out> [pcm_rate]\n")
        return 2
    silk_in, wav_out = sys.argv[1], sys.argv[2]
    rate = int(sys.argv[3]) if len(sys.argv) > 3 else 24000
    if not os.path.isfile(silk_in) or os.path.getsize(silk_in) == 0:
        sys.stderr.write("silk 源文件不存在或为空\n")
        return 3
    import pilk
    pcm = wav_out + ".pcm"
    try:
        pilk.decode(silk_in, pcm, pcm_rate=rate)
        if not os.path.getsize(pcm):
            sys.stderr.write("pilk 解出空 PCM\n")
            return 4
        r = subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-f", "s16le", "-ar", str(rate), "-ac", "1",
             "-i", pcm, wav_out],
            capture_output=True, text=True,
        )
        if r.returncode != 0 or not os.path.exists(wav_out) or not os.path.getsize(wav_out):
            sys.stderr.write("ffmpeg 封 WAV 失败: " + (r.stderr or "")[-200:] + "\n")
            return 5
    finally:
        try:
            os.remove(pcm)
        except OSError:
            pass
    print(os.path.getsize(wav_out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
