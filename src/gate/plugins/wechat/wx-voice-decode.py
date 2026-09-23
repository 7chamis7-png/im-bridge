#!/usr/bin/env python3
"""WeChat SILK v3 voice -> WAV.

WeChat 4.0 stores voice in media_0.db VoiceInfo.voice_data as SILK v3
(header `\x02#!SILK_V3`). pilk decodes it to PCM (s16le); ffmpeg wraps it as WAV.

Usage:  wx-voice-decode.py <silk_in> <wav_out> [pcm_rate]
Exits non-zero with a reason on failure and never writes a partial file.
"""
import os
import sys
import subprocess


def main():
    if len(sys.argv) < 3:
        sys.stderr.write("usage: wx-voice-decode.py <silk_in> <wav_out> [pcm_rate]\n")
        return 2
    silk_in, wav_out = sys.argv[1], sys.argv[2]
    rate = int(sys.argv[3]) if len(sys.argv) > 3 else 24000
    if not os.path.isfile(silk_in) or os.path.getsize(silk_in) == 0:
        sys.stderr.write("silk input missing or empty\n")
        return 3
    import pilk
    pcm = wav_out + ".pcm"
    try:
        pilk.decode(silk_in, pcm, pcm_rate=rate)
        if not os.path.getsize(pcm):
            sys.stderr.write("pilk produced empty PCM\n")
            return 4
        r = subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-f", "s16le", "-ar", str(rate), "-ac", "1",
             "-i", pcm, wav_out],
            capture_output=True, text=True,
        )
        if r.returncode != 0 or not os.path.exists(wav_out) or not os.path.getsize(wav_out):
            sys.stderr.write("ffmpeg WAV wrap failed: " + (r.stderr or "")[-200:] + "\n")
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
