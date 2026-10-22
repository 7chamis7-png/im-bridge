"use strict";

/**
 * iMessage 插件（阶段 1 的第一个转接头）
 *
 * 按 §0.1，插件只负责两件事：
 *   入站：平台收取 + **本平台全部加工**（解密/解压/格式解析/转写），然后交付
 *   出站：把闸给定的目标和内容变成平台操作
 *
 * 它**拿不到冷层**（没有那个 require），**不认识编号**（闸分配的），
 * **不能自己决定发给谁**（目标由出闸给）。
 *
 * §0.5：交付时必须声明自己做了哪几步加工，闸据此判断该按什么验收。
 */

const fs = require("fs");
const net = require("net");
const path = require("path");

const { notSent } = require("../errors");

class IMessagePlugin {
  /**
   * @param {object} opts
   * @param {function} opts.sender  真正打到 iMessage 的函数。阶段 1 传隔离桩。
   * @param {string} [opts.inboxDir] 推来的消息先落这儿（见下面 `receive`）。
   *   不给 = 这条腿只会发不会收。
   * @param {function} [opts.log]
   */
  constructor({ sender = null, inboxDir = "", socketPath = "", sendTimeoutMs = 20_000, log = () => {} } = {}) {
    this.channel = "imessage";
    // `sender` 只给测试用（直接塞一个假函数）。生产走 `socketPath` ——
    // Spectrum 的连接归喂料进程（`src/host/imessage-spectrum.js`）独占，
    // 因为**全机只有这一条连接，两个 SDK 实例会抢同一批入站**。
    this.sender = sender;
    this.inboxDir = inboxDir;
    this.socketPath = socketPath;
    this.sendTimeoutMs = sendTimeoutMs;
    this.log = log;
    // §7.3 平台支持度：只说「这个平台协议提供不提供」，不说插件接没接
    this.capabilities = {
      send_text: "supported",
      send_file: "supported",
      // ⚠️ 2026-09-17 改：原来写 unsupported，是旧的。bridge.js 2026-09-15 就接了
      // 出站语音（uploadVoice + sendAttachment({isAudioMessage:true})，真语音气泡不是附件），
      // 声明没跟上 = 自己把一个已有的能力挡掉了。
      send_voice: "supported",
      send_sticker: "unsupported",
      send_generated_image: "supported",     // 图片就是附件，跟 send_file 同一条路
      react: "unsupported",
      // FaceTime 不归这条桥管（2026-09-18）
      start_call: "unsupported",
      end_call: "unsupported",
    };
  }

  /**
   * ==== 收：这条腿是**推**的，不是捞的 ====
   *
   * TG 和微信都能「自己去要」（getUpdates / 读库），iMessage 不行 ——
   * Spectrum SDK 是订阅式的，消息什么时候来由它说了算。而且老桥注释写着：
   * **「全机只有这一条连接，两个 SDK 实例会抢同一批入站」**。
   *
   * 所以形状是：**推来的先落盘，`poll()` 从盘上读**。
   *   · 落盘 = 崩了不丢（内存缓冲一崩就没，而她的话不能没）
   *   · 有 `poll()` = 跟另外两条腿同一个接口，共用层不用认识「推」这种东西
   *   · 一条一个文件 + `tmp→rename` —— 跟生产者投递口同一个形状（producers.js），
   *     不是新发明
   *
   * ⚠️ **连 SDK 的活不在这儿**（插头不 require spectrum-ts）。宿主接好之后，
   * 每来一条就调 `receive(raw)`。这样插头能测、也换得掉。
   *
   * @param {object} raw 平台原始事件
   * @returns {{seq:number, file:string}}
   */
  receive(raw) {
    if (!String(this.inboxDir || "").trim()) {
      throw new Error("iMessage 插头要 inboxDir 才收得到消息 —— 不许用默认值猜");
    }
    fs.mkdirSync(this.inboxDir, { recursive: true, mode: 0o700 });
    // 序号从盘上算：进程重启接着往下走，不从头来
    const seq = this.#nextSeq();
    const name = String(seq).padStart(12, "0") + ".json";
    const full = path.join(this.inboxDir, name);
    const tmp = path.join(this.inboxDir, "." + name + ".tmp-" + process.pid);
    fs.writeFileSync(tmp, JSON.stringify({ seq, at: new Date().toISOString(), raw }), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, full);          // 原子：写到一半断电不会留半截
    return { seq, file: full };
  }

  #files() {
    try {
      return fs.readdirSync(this.inboxDir)
        .filter((f) => /^\d{12}\.json$/.test(f))
        .sort();
    } catch { return []; }
  }

  /**
   * 序号**只增不减**（2026-09-22 修）：原来是「盘上最大号 + 1」，桥消化完会把文件删掉 →
   * 收件箱一空，下一条又从 1 号开始 → 共用层游标早就过了 1 → 当成「消化过了」直接删掉，
   * **她在 iMessage 发的第二条起全被无声吞掉**（9-22 06:50、06:52 两条就是这么没的）。
   * 现在另存一个计数器 `.last-seq`，取「盘上最大号」和「计数器」里大的那个再 + 1。
   */
  #nextSeq() {
    const all = this.#files();
    const onDisk = all.length ? Number(all[all.length - 1].slice(0, 12)) : 0;
    let saved = 0;
    try { saved = Number(fs.readFileSync(path.join(this.inboxDir, ".last-seq"), "utf8").trim()) || 0; } catch { /* 第一次没有 */ }
    const seq = Math.max(onDisk, saved) + 1;
    try { fs.writeFileSync(path.join(this.inboxDir, ".last-seq"), String(seq), { mode: 0o600 }); } catch { /* 写不上下次还会按盘上算 */ }
    return seq;
  }

  /**
   * 捞：从盘上读还没消化的。
   *
   * **消化完了才推进游标**是共用层的事（receiver.js），这里只管交出来。
   * 顺手把 `seq <= since` 的清掉 —— 那些共用层已经确认消化过了。
   */
  async poll({ since = 0 } = {}) {
    if (!String(this.inboxDir || "").trim()) return { items: [], cursor: since };
    const cur = Number(since) || 0;
    const items = [];
    for (const f of this.#files()) {
      const seq = Number(f.slice(0, 12));
      const full = path.join(this.inboxDir, f);
      if (seq <= cur) {                       // 消化过了，清掉
        try { fs.unlinkSync(full); } catch { /* 删不掉下次再说 */ }
        continue;
      }
      let rec;
      try { rec = JSON.parse(fs.readFileSync(full, "utf8")); }
      catch {
        // 坏文件不许卡住后面的，也不许无声消失
        try { fs.renameSync(full, full + ".bad"); } catch { /* ignore */ }
        this.log("[imessage] 收件箱里有一条坏文件，已改名留证：" + f);
        continue;
      }
      items.push({ update_id: seq, cursor: seq, message: rec.raw });
    }
    return { items, cursor: items.length ? items[items.length - 1].cursor : cur };
  }

  /** 平台原始事件 → 标准交付。iMessage 的正文本来就是明文，无需解密解压。 */
  toDelivery(raw) {
    const hasText = Boolean(raw && raw.text);
    const media = [];
    if (raw && raw.attachmentKind) media.push({ kind: raw.attachmentKind, ref: raw.attachmentPath || "" });

    return {
      channel: this.channel,
      accountId: (raw && raw.accountId) || "imessage",
      // 真实平台身份，绝不硬填。现网反面教材：bridge.js 写死 from_is_alice="true"
      senderId: (raw && raw.handle) || "",
      chatId: (raw && raw.handle) || "",
      chatType: "private",
      nativeId: raw && raw.id != null ? String(raw.id) : "",  // 平台原生 ID，不是文件行号
      receivedAt: (raw && raw.date) || new Date().toISOString(),
      text: hasText ? String(raw.text) : "",
      media,
      // §0.5 处理链声明：iMessage 文本是明文，没做任何加工
      processing: ["none"],
    };
  }

  /**
   * 出站：目标和内容都由出闸给定，插件不得自行变更。
   *
   * ⚠️ **默认拒绝**（2026-09-18）：只做显式写过的意图。
   * 在这之前这个函数不看 intent —— 能力表上写着「文件/语音/图片：支持」，
   * 而实际上三样都会变成**一段文字**发出去，出闸还记成「发成功」。
   * 守卫测试 `test/gate/plugin-intents.js` 当场抓到的。
   *
   * 平台确实支持那几样（桥 2026-09-15 就接了出站语音），
   * **但这条插头还没接** —— 两件事不一样，不许混。
   */
  async send({ operationId, chatId, text, intent = "send_text" }) {
    if (!chatId) throw notSent("插件收到的目标为空——出闸应当先解析目标");
    if (intent !== "send_text") {
      throw notSent("iMessage 这条腿还没接「" + intent + "」（平台支持，插头没写）——别把它发成一行字");
    }
    const say = String(text || "");
    // 测试桩优先（直接给函数），生产走喂料进程的 socket
    if (typeof this.sender === "function") {
      const nativeId = await this.sender({ chatId, text: say, operationId });
      return { nativeId: nativeId || null };
    }
    if (!String(this.socketPath || "").trim()) {
      throw notSent("iMessage 这条腿没配 socket，递不过去（喂料进程 nova-imessage 在跑吗）");
    }
    const res = await this.#ask({ type: "send_text", operationId, chatId, text: say });
    if (!res || !res.ok) throw notSent("这条没发出去 —— " + ((res && res.why) || "喂料进程没接"));
    return { nativeId: res.nativeId || null };
  }

  /** 递一条给喂料进程，等它把结论带回来。**一次一连**，跟工具口同一种说法。 */
  #ask(payload) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const sock = net.createConnection(this.socketPath);
      const timer = setTimeout(() => {
        try { sock.destroy(); } catch { /* 已断 */ }
        finish({ ok: false, why: "喂料进程没回音（等了 " + Math.round(this.sendTimeoutMs / 1000) + " 秒）" });
      }, this.sendTimeoutMs);
      let buf = "";
      sock.on("connect", () => sock.write(JSON.stringify(payload) + "\n"));
      sock.on("data", (c) => {
        buf += c.toString("utf8");
        const i = buf.indexOf("\n");
        if (i < 0) return;
        clearTimeout(timer);
        try { finish(JSON.parse(buf.slice(0, i))); }
        catch (e) { finish({ ok: false, why: "喂料进程回的不是 JSON：" + ((e && e.message) || e) }); }
        try { sock.end(); } catch { /* 已断 */ }
      });
      sock.on("error", (e) => {
        clearTimeout(timer);
        const why = (e && (e.code === "ENOENT" || e.code === "ECONNREFUSED"))
          ? "喂料进程没在跑（pm2 nova-imessage）" : ("连不上喂料进程：" + ((e && e.message) || e));
        finish({ ok: false, why });
      });
    });
  }

  health() {
    // ⚠️ **判据要跟 send() 真正用的东西一致**（2026-09-18 TG 插头栽过：health 看
    // `this.sender`，而 send() 有 token 就能自己发 → 生产一律 offline，出闸全挡）。
    // 这儿 send() 认两样：测试桩 `sender`，或者生产的 `socketPath`。
    const canSend = typeof this.sender === "function" || Boolean(String(this.socketPath || "").trim());
    return { platform: "supported", plugin: "wired", availability: canSend ? "ready" : "offline" };
  }
}

module.exports = { IMessagePlugin };

/** 自我介绍（2026-09-18 插头插件化）。没配 inbox 目录就是没插上。 */
module.exports.leg = {
  name: "imessage",
  slot: "imessage",
  configKeys: [
    ["GATE_IMESSAGE_INBOX_DIR", "喂料进程把推来的 iMessage 落这个目录"],
    ["GATE_IMESSAGE_SOCKET", "喂料进程监听的口子，他的话往这儿递"],
  ],
  poll: { idleMs: 1500 },
  make({ env, log }) {
    return new IMessagePlugin({
      inboxDir: env.GATE_IMESSAGE_INBOX_DIR,
      socketPath: env.GATE_IMESSAGE_SOCKET,
      sendTimeoutMs: Number(env.GATE_IMESSAGE_SEND_TIMEOUT_MS || 20_000),
      log,
    });
  },
};
