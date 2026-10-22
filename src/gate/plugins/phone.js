"use strict";

/**
 * 电话插件（2026-09-18）—— **她说话，他说话，中间不打字**
 *
 * Alice拍的板：「电话就当成一条新渠道」。这样白捡整条闸 ——
 * 她说的自动落冷层、自动绑轮次、他的回话自动走出闸，不用为电话单开一套。
 *
 * ## 这条腿跟别的腿哪里不一样
 *
 * 别的腿两头都是文字。这条腿两头是**声音**，文字只是中间形态：
 *
 * ```
 *   微信播放 → <PHONE_SPEAKER> null-sink（默认输出）.monitor → VAD 断句 → 转写 ──┐
 *                                                                              ↓
 *                                                                   这条腿的入站（文字）
 *                                                                              ↓
 *                                                                   闸 → 他 → 出闸
 *                                                                              ↓
 *   微信采集 ← <PHONE_MIC>（默认输入，remap）← <PHONE_MIC_SINK> ← 合成 ←────────┘
 *                                                                   这条腿的出站（文字）
 * ```
 *
 * 设备怎么建见 `scripts/setup-phone-audio.sh`（2026-09-18 那版走过 snd-aloop 真声卡，
 * 现在是两个 null-sink + 一个 remap，以那个脚本为准）。
 *
 * 声音那一整段脏活在**另一个进程**里（`legs/phone/phone.py`，见 docs/phone.md）。
 * 这条腿只管跟它交换文字，一个音频 API 都不碰。
 *
 * ## 为什么入站走文件、出站走 socket
 *
 * - **入站**：她说的话不能丢。落成文件，消化完了共用层才推游标（跟 iMessage 一样）。
 *   哪怕桥正好在重启，她说的那句还在盘上等着。
 * - **出站**：他的话**过期作废** —— 电话挂了再说出来就是鬼话。所以走 socket：
 *   通话进程连着就说得出去，没连着就当场报「现在没有通话」，
 *   让出闸如实记一笔没送达，而不是攒着等下一通电话再念。
 *
 * ## 拨号不归这条腿
 *
 * 拨号和挂断是**微信界面**上的动作（`start_call`/`end_call` 在微信那条腿上）。
 * 这条腿只在通话已经接通之后管「说」。所以它对那两个意图一律 unsupported ——
 * 不是做不到，是不归它管，混在一起会变成两个地方都能拨号。
 */

const fs = require("fs");
const net = require("net");
const path = require("path");

const { notSent } = require("../errors");

class PhonePlugin {
  /**
   * @param {object} opts
   * @param {string} [opts.inboxDir] 通话进程把「她说了什么」落这儿
   * @param {string} [opts.socketPath] 通话进程监听的口子，出站往这儿递
   * @param {string} [opts.peerId] 她在这条腿上的身份（要跟 GATE_OWNER_PHONE_ID 对上）
   * @param {number} [opts.sendTimeoutMs] 递过去多久没回音就算没送达
   * @param {function} [opts.log]
   */
  constructor({ inboxDir = "", socketPath = "", peerId = "", sendTimeoutMs = 8000, log = () => {} } = {}) {
    this.channel = "phone";
    this.transport = "pipecat";
    this.inboxDir = inboxDir;
    this.socketPath = socketPath;
    this.peerId = peerId;
    this.sendTimeoutMs = sendTimeoutMs;
    this.log = log;
    // §7.3 平台支持度：只说「电话这个东西提供不提供」。
    // 电话里只有声音 —— 图、文件、贴纸、表情在通话中都无处可去，不是没接，是没有。
    this.capabilities = {
      send_text: "supported",            // 说出来（出闸给文字，这条腿负责变成声音）
      send_file: "unsupported",
      send_voice: "unsupported",         // 电话本身就是语音，再发一条语音条没有意义
      send_sticker: "unsupported",
      send_generated_image: "unsupported",
      react: "unsupported",
      // 拨号/挂断是微信界面上的动作，归微信那条腿。这里写 unsupported 是划界，不是做不到。
      start_call: "unsupported",
      end_call: "unsupported",
    };
  }

  #files() {
    try {
      return fs.readdirSync(this.inboxDir).filter((f) => /^\d{12}\.json$/.test(f)).sort();
    } catch { return []; }
  }

  /** 捞：把通话进程落下的话交出来。推游标是共用层的事，这里只管交。 */
  async poll({ since = 0 } = {}) {
    if (!String(this.inboxDir || "").trim()) return { items: [], cursor: since };
    const cur = Number(since) || 0;
    const items = [];
    for (const f of this.#files()) {
      const seq = Number(f.slice(0, 12));
      const full = path.join(this.inboxDir, f);
      if (seq <= cur) {                          // 共用层确认消化过了，清掉
        try { fs.unlinkSync(full); } catch { /* 删不掉下次再说 */ }
        continue;
      }
      let rec;
      try { rec = JSON.parse(fs.readFileSync(full, "utf8")); }
      catch {
        // 坏文件不许卡住后面的，也不许无声消失
        try { fs.renameSync(full, full + ".bad"); } catch { /* ignore */ }
        this.log("[电话] 收件箱里有一条坏文件，已改名留证：" + f);
        continue;
      }
      items.push({ update_id: seq, cursor: seq, message: rec.raw || rec });
    }
    return { items, cursor: items.length ? items[items.length - 1].cursor : cur };
  }

  /**
   * 通话进程给的原始事件 → 标准交付。
   *
   * §0.5 处理链：**这条腿的文字是转写出来的，不是她打的**，必须声明 ——
   * 下游（还有他自己）该知道这句话可能听错了，跟她亲手打的字不是一个可信度。
   */
  toDelivery(raw) {
    const id = String((raw && raw.peerId) || this.peerId || "");
    return {
      channel: this.channel,
      accountId: (raw && raw.accountId) || "phone",
      senderId: id,
      chatId: id,
      chatType: "private",
      nativeId: raw && raw.id != null ? String(raw.id) : "",
      receivedAt: (raw && raw.at) || new Date().toISOString(),
      text: String((raw && raw.text) || ""),
      media: [],
      processing: ["transcribed"],
    };
  }

  /**
   * 出站：把他的话递给通话进程去念。
   *
   * **递不过去要抛**（notSent）—— 出闸会如实记一笔没送达。
   * 最要命的反面做法是攒着等下一通电话，那等于让他对着空气说完、
   * 然后在三小时后的另一通电话里突然接上一句。
   */
  async send({ operationId, chatId, text, intent = "send_text" }) {
    if (!chatId) throw notSent("插件收到的目标为空——出闸应当先解析目标");
    if (intent !== "send_text") {
      throw notSent("电话这条腿只会说话，办不了「" + intent + "」");
    }
    const say = String(text || "").trim();
    if (!say) throw notSent("没有要说的话");
    if (!String(this.socketPath || "").trim()) throw notSent("电话这条腿没配 socket，递不过去");

    const payload = JSON.stringify({ type: "say", operationId, text: say }) + "\n";
    const res = await new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const sock = net.createConnection(this.socketPath);
      const timer = setTimeout(() => { try { sock.destroy(); } catch { /* 已断 */ } finish({ ok: false, why: "通话进程没回音" }); }, this.sendTimeoutMs);
      let buf = "";
      sock.on("connect", () => sock.write(payload));
      sock.on("data", (c) => {
        buf += c.toString("utf8");
        const i = buf.indexOf("\n");
        if (i < 0) return;
        clearTimeout(timer);
        try { finish(JSON.parse(buf.slice(0, i))); }
        catch (e) { finish({ ok: false, why: "通话进程回的不是 JSON：" + ((e && e.message) || e) }); }
        try { sock.end(); } catch { /* 已断 */ }
      });
      sock.on("error", (e) => {
        clearTimeout(timer);
        // ENOENT/ECONNREFUSED 就是「现在没有通话」，不是故障
        const why = (e && (e.code === "ENOENT" || e.code === "ECONNREFUSED"))
          ? "现在没有通话" : ("连不上通话进程：" + ((e && e.message) || e));
        finish({ ok: false, why });
      });
    });
    if (!res || !res.ok) throw notSent("这句话没说出去 —— " + ((res && res.why) || "通话进程没接"));
    // 电话没有「消息 ID」这种东西：说过就是说过，没有可以回头引用的编号
    return { nativeId: null, sentAs: "spoken" };
  }

  /**
   * 在线 = **现在真有一通电话**。
   *
   * 故意不写成「配置齐了就 ready」：那样闸会以为随时能说话，
   * 而实际上没通话时每一句都会撞墙。没通话就老实说 offline。
   */
  health() {
    const wired = Boolean(this.inboxDir && this.socketPath);
    let live = false;
    try { live = fs.statSync(this.socketPath).isSocket(); } catch { /* 没通话 */ }
    return {
      platform: "supported",
      plugin: wired ? "wired" : "unwired",
      availability: live ? "ready" : "offline",
    };
  }
}

module.exports = { PhonePlugin };

/** 自我介绍。没配收件箱和 socket 就是没插上 —— 那时候这条腿根本不存在。 */
module.exports.leg = {
  name: "phone",
  slot: "phone",
  configKeys: [
    ["GATE_PHONE_INBOX_DIR", "通话进程把「她说了什么」落这个目录"],
    ["GATE_PHONE_SOCKET", "通话进程监听的口子，他的话往这儿递"],
  ],
  // 读目录是问一次答一次，不像长轮询自己阻塞。电话要快，间隔给小一点。
  poll: { idleMsKey: "GATE_PHONE_IDLE_MS", idleMsDefault: 300 },
  make({ env, log }) {
    return new PhonePlugin({
      inboxDir: env.GATE_PHONE_INBOX_DIR,
      socketPath: env.GATE_PHONE_SOCKET,
      peerId: env.GATE_OWNER_PHONE_ID || "",
      sendTimeoutMs: Number(env.GATE_PHONE_SEND_TIMEOUT_MS || 8000),
      log,
    });
  },
};
