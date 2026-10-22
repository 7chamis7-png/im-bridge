"use strict";

/**
 * 微信出站：无障碍点界面那条（现役主力）
 *
 * 2026-09-18 从 `src/host/main.js` 搬进插头目录 —— 这是**微信特有的脏活**
 * （点窗口、走剪贴板、抢窗口锁），核心不该认识它。
 *
 * ⚠️ 两条踩过的坑，改的时候别踩回去：
 *
 * 1. **stdout 必须重定向进文件，不能用管道收。** `set_clipboard` 调的 xclip 会 fork
 *    一个后台进程占着选区，顺带占着那根管道，父进程等管道关闭就等死了
 *    （实测：消息 1 秒就发出去了，脚本挂到 60 秒超时）。
 *
 * 2. **必须异步。** 参考脚本用的是 `execFileSync` —— 那是跑完就退的脚本，无所谓；
 *    桥进程里同步阻塞 = 发一条微信就把别的腿的收信卡住一秒多。
 *
 * 3. **一次只让一个人碰微信窗口。** 微信只有一个窗口，两个进程同时操作
 *    （截图 / xdotool / 无障碍查询）会互相拖住，整条出站卡到超时。
 *    等不到锁宁可报错（出闸会记成没送达），也不要两个人一起点。
 */

const { execFile } = require("child_process");
const path = require("path");

function makeA11ySenders(env, log = () => {}) {
  const script = env.GATE_WECHAT_SENDER;
  const target = env.GATE_WECHAT_TARGET;
  const lock = env.GATE_WECHAT_SEND_LOCK;
  const sendLog = env.GATE_WECHAT_SEND_LOG || "";
  const python = env.GATE_WECHAT_PYTHON || "python3";

  const run = (extraArgs, arg, killSec, timeoutMs) => new Promise((resolve, reject) => {
    const tail = sendLog ? ` >> ${JSON.stringify(sendLog)} 2>&1` : " >/dev/null 2>&1";
    const guard = `exec 9>${JSON.stringify(lock)}; `
      + `flock -w 60 9 || { echo "等微信发送锁超时（另一条还在发）" >&2; exit 1; }; `;
    const cmd = guard
      + `timeout -k 5 ${killSec} ${JSON.stringify(python)} -u ${JSON.stringify(script)} `
      + `${extraArgs} "$1"${tail}`;
    execFile("/bin/sh", ["-c", cmd, "sh", arg],
      { timeout: timeoutMs, env: { ...process.env, LINUX_WX_TARGET: target } },
      (err) => {
        // 发不出去要**抛**：出闸会记成没送达，绝不当成发过了
        if (err) return reject(new Error("微信无障碍出站失败：" + ((err && err.message) || err)));
        resolve(null);   // 微信这条路平台不回消息 ID —— 是渠道限制，不是故障
      });
  });

  const voiceScript = path.join(__dirname, "wx-voice-send.py");
  const callScript = path.join(__dirname, "wx-call.py");

  /** 拨号 / 挂断共用这条：都得持锁（微信窗口一次只许一个人碰），都得把失败**抛**出去。 */
  const runCall = async (args, what, done) => {
    const t0 = Date.now();
    await new Promise((resolve, reject) => {
      const cmd = `exec 9>${JSON.stringify(lock)}; `
        + `flock -w 60 9 || { echo "等微信锁超时" >&2; exit 1; }; `
        + `python3 -u ${JSON.stringify(callScript)} ${args.join(" ")}`;
      execFile("/bin/sh", ["-c", cmd],
        { timeout: 60_000,
          env: { ...process.env, LINUX_WX_TARGET: target,
                 DISPLAY: process.env.DISPLAY || env.GATE_WECHAT_DISPLAY || ":98",
                 XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}` } },
        (err, _so, se) => (err
          ? reject(new Error("微信" + what + "失败：" + String(se || err.message).trim().slice(0, 200)))
          : resolve()));
    });
    log("[微信] " + done + "，用时 " + ((Date.now() - t0) / 1000).toFixed(2) + "s");
    return null;
  };

  return {
    /**
     * 发语音条 —— 靠虚拟麦克风让微信自己录（见 wx-voice-send.py 的说明）。
     *
     * 微信 Linux 版没有"把音频文件当语音发"的口子，语音条只能是录出来的。
     * 所以：点录音 → 把合成好的音频放进假麦克风 → 点发送。
     * 2026-09-18 实测通过，她那头收到的是真语音气泡。
     */
    voiceSender: async ({ filePath }) => {
      const t0 = Date.now();
      // paplay 只吃 wav，合成出来多半是 mp3 —— 转一道
      const src = String(filePath || "");
      if (!src) throw new Error("微信发语音：没拿到音频文件");
      // ⚠️ 限长的来历（2026-09-18，两段，第二段推翻第一段）：
      //
      //  · 傍晚我以为「长音频会把微信搞崩」，卡死 8 秒保命。
      //  · **那个判断是错的** —— 后来查清微信不是崩，是**风控强制登出**
      //    （"For account security, log in again"），跟音频长度没关系。
      //    她一句「换个环境呢」之后加了 snd-aloop 真声卡，风控就不踢了。
      //
      //  8 秒是那个误诊留下的疤：她 18 秒的语音被砍成 8 秒发出去，
      //  她听出来了（「感觉语音乖乖的」）。
      //
      // **限长整个拿掉了**（2026-09-18 Alice：「直接删掉 不需要控制语音时长」）。
      // 中间还当过一阵文件开关（`voice-max-sec`，默认 60 秒）—— 那只是把疤
      // 包了层纱布。真因既然是风控、不是长度，就不该留任何一刀。**他想说多长说多长。**
      const wav = src + ".gate.wav";
      await new Promise((resolve, reject) => {
        execFile("ffmpeg", ["-loglevel", "error", "-y", "-i", src,
          "-ar", "44100", "-ac", "1", wav],
          { timeout: 60_000 },
          (err) => (err ? reject(new Error("音频转 wav 失败：" + err.message)) : resolve()));
      });
      // ⚠️ 两条都要（2026-09-18 实测出来的）：
      //
      // 1. **持锁** —— 原来这条漏了 flock，发文字那条有。结果录音还在进行，
      //    桥那边发文字的点击就能同时进来，两个人一起点微信窗口。
      //
      // 2. **发完冷却** —— 语音发出去之后微信还在后台压缩上传，这时候再动它就崩
      //    （日志咬得很死：16:41:29 语音发完 → 16:41:32 发文字 → 界面没了）。
      //    最早那两次手动测试没崩，正是因为跑完我就去看日志了、隔了很久。
      //    冷却期间**锁一直攥着**，下一条消息只能等着 —— 慢几秒，总比崩了强。
      const cool = Number(env.GATE_WECHAT_VOICE_COOLDOWN_MS || 12000);
      await new Promise((resolve, reject) => {
        const cmd = `exec 9>${JSON.stringify(lock)}; `
          + `flock -w 90 9 || { echo "等微信发送锁超时（另一条还在发）" >&2; exit 1; }; `
          + `python3 -u ${JSON.stringify(voiceScript)} "$1" || exit $?; `
          + `sleep ${Math.max(0, Math.round(cool / 1000))}`;   // 冷却，锁不放
        execFile("/bin/sh", ["-c", cmd, "sh", wav],
          { timeout: 120_000 + cool,
            env: { ...process.env, LINUX_WX_TARGET: target,
                   LINUX_WX_OWNER_WXID: env.GATE_OWNER_WECHAT_ID || "",
                   LINUX_WX_KEYS: env.GATE_WECHAT_KEYS_FILE || "",
                   // 桥进程没有 DISPLAY（它不是从桌面起的），点不到窗口
                   DISPLAY: process.env.DISPLAY || env.GATE_WECHAT_DISPLAY || ":98",
                   XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`,
                   PULSE_SINK: env.GATE_WECHAT_MIC_SINK || "nova_mic_sink" } },
          (err, _so, se) => (err
            ? reject(new Error("微信发语音失败：" + String(se || err.message).trim().slice(0, 200)))
            : resolve()));
      });
      log("[微信] 发出一条语音，用时 " + ((Date.now() - t0) / 1000).toFixed(2) + "s");
      return null;
    },

    /** 打电话（只发起）。跟发语音同一套：盲点、不碰会话行、模仿真人。 */
    caller: () => runCall([], "拨号", "拨出去了"),

    /**
     * 挂断（2026-09-18 她点破「你要看的不应该是挂电话的键在哪里嘛」才记下来的）。
     *
     * 通话界面是**独立窗口**（标题 `Voice Call`, 375x667），跟主窗口不是一个原点 ——
     * 拿主窗口的偏移去点会点到聊天记录里。坐标只能趁通话开着的时候扫，
     * 挂完就再也扫不到了，所以它存在 wx-spots.json 的 `call_window` 里。
     *
     * 脚本点完会等窗口真的消失才报成功 —— 跟发语音查库同一条规矩：点了≠挂掉了。
     */
    hangUp: () => runCall(["--hangup"], "挂断", "挂断了"),

    sender: async ({ text }) => {
      const t0 = Date.now();
      await run("", String(text), 30, 45_000);
      log("[微信] 发出一段，用时 " + ((Date.now() - t0) / 1000).toFixed(2) + "s");
      return null;
    },
    imageSender: async ({ filePath }) => {
      const t0 = Date.now();
      await run("--image", String(filePath), 45, 60_000);
      log("[微信] 发出一张图，用时 " + ((Date.now() - t0) / 1000).toFixed(2) + "s");
      return null;
    },
  };
}

module.exports = { makeA11ySenders };
