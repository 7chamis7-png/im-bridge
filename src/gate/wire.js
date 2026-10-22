"use strict";

/**
 * 装配（2026-09-17）——把 src/gate/ 的零件拼成一个能挂进生产的整体。
 *
 * 目的是**让最终动生产的那几行尽量少**：app.js 只需要 `buildGate(...)` 拿回一个对象，
 * 剩下全在这里。审的时候看这一个文件，不用在 2151 行的投递层里找改了哪几处。
 *
 * ⚠️ 这个文件**不自己接线**，只负责装配。挂不挂、什么时候挂，在 app.js 那头。
 * ⚠️ 默认是**关着的**（killswitch 读不到文件 = 走老路），装上也不会自己接管。
 */

const { GateStore } = require("./store");
const { ColdWriter } = require("./cold-writer");
const { InboundGate } = require("./inbound");
const { OutboundGate } = require("./outbound");
const { Capabilities } = require("./capabilities");
const { KillSwitch } = require("./killswitch");
const { describePlugin, missingShared, COMMON_INTENTS } = require("./surface");
const { TurnBinding } = require("./turn-binding");
const { MediaPipeline } = require("./media-pipeline");
const { assertBox } = require("./box");
const { makePipeline } = require("./pipeline");
const { makeRouter } = require("./routing");
const { makeUndelivered } = require("./undelivered");
const { makeGroupGate } = require("./group");
const { makeProducerInbox } = require("./producers");
const { makeSegmenter } = require("./segment");

/**
 * @param {object} o
 * @param {string} o.root          闸自己的存储目录（事件账本 + 游标）
 * @param {string} o.coldFile      冷层文件（闸是唯一写手）
 * @param {object} o.plugins       { telegram, imessage, wechatA11y, wechatImbot } 实例
 * @param {object} [o.capabilities] 共用能力实现，**由调用方注入**：
 *   { file_store, fetch_bytes, transcribe, acoustic, vision, synthesize_voice, generate_image }
 * @param {boolean} [o.nativeImageInput] 盒子里那位自己看得了图吗（决定递原图还是花钱识图）
 * @param {object|null} o.box  跑 CLI 的盒子（见 box.js 的五条口）。**必须显式给**；
 *   只读的桥（影子）显式传 null。
 * @param {object} [o.identities]  "channel:senderId" -> 身份名
 * @param {object} [o.groups]      群配置 { allowed:[], alwaysWake:[], wakeNames?:[] }。
 *   **白名单只认这儿给的**，桥不许从聊天里自动学习（Bot 被拉进陌生群不会自行扩权）。
 *   不给 = 这座桥不收群消息。
 * @param {string} [o.owner]       她的身份名，默认 alice。**只用来判谁有资格下命令。**
 * @param {object} [o.segment] 分段参数 { minChars, maxBubbles, softMax }。见 segment.js。
 *   默认：只按空行切、短段合并、**不封顶、不做超长兜底切**（都是拿真数据量出来的默认）。
 * @param {number} [o.sendGapMs] 一条一条发之间隔多久，默认 700ms（她要的说话节奏）。
 * @param {string} [o.producersDir] 生产者投递目录（check-in 往这儿放文件）。
 *   不给 = 这座桥不收外面推的东西。**桥不认识生产者是谁**（铁律 2/3）。
 * @param {object|null} [o.preferredRoute] 首选落点 { platform, chat_id }（路由第 4 档）。
 *   **配置里写，不是代码里写死**（SPEC §4）。不给就只有前三档能命中。
 * @param {function} [o.log]
 */
function buildGate({ root, coldFile, plugins = {}, capabilities = {}, identities = {}, files = {},
  nativeImageInput = true, box, preferredRoute = null, groups = null, owner = "alice",
  producersDir = "", segment = {}, sendGapMs = 700, sendGapByChannel = {}, enforceEnabled = false, log = () => {},
  // 关舱前那一轮的正文（宿主给；桥不认识里面写的是什么）。不给 = 没有这一步。
  closingNote = null }) {
  // 盒子**必须显式给**：给一个对象 = 五条口当场点名；给 null = 这座桥不往盒子里送
  // （影子那种只读观察）。**不给 = 忘了传**，当场报——9-17 就是靠「可选参数默认空」
  // 把「插头一个都没接」这件事瞒过了装配、瞒过了测试，直到开关一开才发作。
  if (box === undefined) {
    throw new Error("buildGate 要 box：给盒子对象，或者显式给 null（表示这座桥不往盒子里送）");
  }
  if (box !== null) assertBox(box);
  const store = new GateStore({ root });
  const cold = new ColdWriter({ file: coldFile });

  // —— 第 1 层：共用能力。每样只有一份，注册重了会自己报错。——
  // **实现由调用方注入**（铁律 1）：闸只说「我要一个能把音频变成字的东西」，
  // 谁提供不管。在这台机器上凑齐它们的适配器在 `src/host/gate-capabilities.js`，
  // 那个文件不属于桥。注册一次**所有插头共用**——转写和识图以前是各条腿
  // 各调一遍、微信一直没人给它接，病根就在没有这一层。
  const caps = new Capabilities();
  for (const [name, impl] of Object.entries(capabilities)) if (impl) caps.register(name, impl);

  // —— 微信两条路**不是一个插口**（2026-09-18 Alice拆开）——
  // a11y 直读的是她自己的微信客户端：身份是 wxid，会话是真人聊天窗。
  // 老网关是 im.bot 上的一个 bot 账号：身份是 fromUserId，回话要 contextToken。
  // 「都是微信」不等于同一个来源 —— 信息处理从头到尾都不一样，硬塞进一个渠道名
  // 会让身份、回复地址、冷层记录三样全对不上。所以各占一格，也就没有选择器。
  // ⚠️ 2026-09-18：这张表原来是**手写死的四行**（telegram/imessage/wechatA11y/
  //    wechatImbot）。插头插排做了一半 —— 腿能自己装上，但这里没人告诉它，
  //    于是新加的 `phone` 腿装上了、也开始捞消息了，第一条入站却找不到插头，
  //    `没有这个渠道的插头：phone` 抛出来把整个桥打进重启循环（28 次）。
  //
  //    改成**问插头自己**：每个插头都有 `.channel`（那是它的身份，不是插排给的名字），
  //    所以这里不需要认识任何一条腿。加 QQ 照样一个字不用动。
  //    保留 `.channel` 这个来源而不是用插排的 key，是因为一个插头的**槽名**和
  //    **渠道名**本来就可以不一样（wechatA11y 这一格的渠道叫 wechat）。
  const pluginMap = new Map();
  for (const [slot, plugin] of Object.entries(plugins || {})) {
    if (!plugin) continue;
    const ch = String(plugin.channel || "").trim();
    if (!ch) { log("⚠️ 插头 " + slot + " 没说自己是哪个渠道，跳过（它收到的消息会找不到人认领）"); continue; }
    if (pluginMap.has(ch)) { log("⚠️ 渠道 " + ch + " 有两个插头抢（" + slot + "），后来的不生效"); continue; }
    pluginMap.set(ch, plugin);
  }

  // 媒体流水线：插头只交字节，落仓/嗅类型/该递原图还是转写/抽帧 全在这一层。
  // nativeImageInput 是**运行时**的属性，不是渠道的 —— 所以判断在这儿做，插头不用管。
  // nativeImageInput = 盒子里那位自己看不看得了图。**这是盒子的属性，不是渠道的**，
  // 所以由调用方告诉桥（它认识盒子，桥不认识）。
  const media = new MediaPipeline({
    caps,
    fileStore: caps.has("file_store") ? caps.impls.get("file_store").store : null,
    nativeImageInput,
  });

  const inbound = new InboundGate({ store, cold, identities });
  // 发不出去的账。**出闸必须拿到它**，否则「她其实没收到」只进事件账本，
  // 没有一处一眼看得见 —— 所以在这儿装配，不留给调用方记得传。
  const undelivered = makeUndelivered({
    file: files.undelivered || require("path").join(root, "undelivered.jsonl"),
  });
  const outbound = new OutboundGate({ store, cold, plugins: pluginMap, caps, undelivered,
    segmenter: makeSegmenter(segment), sendGapMs, sendGapByChannel });
  const router = makeRouter({ preferred: preferredRoute,
    file: require("path").join(root, "last-active-route.json"),
    isAlive: (route) => {
      const plugin = pluginMap.get(route.platform);
      return Boolean(plugin) && (typeof plugin.health !== "function" || plugin.health().availability !== "offline");
    },
  });
  const killswitch = new KillSwitch(files.gateEnabled ? { flagFile: files.gateEnabled } : {});
  // 本轮来路落盘 —— 工具进程是独立进程，只能靠盘上这份找回「这轮从哪来的」。
  const binding = new TurnBinding({ file: files.turnBinding || require("path").join(root, "turn-bindings.json") });

  /** 出闸/工具进程用：把 threadId:turnId 还原成一个能喂给出闸的 turn。 */
  function turnFor({ threadId, turnId, text, intent }) {
    const b = binding.lookup(threadId, turnId);
    return {
      turnId, threadId, text, intent,
      replyToEventId: b ? b.eventId : null,
      inboundEvent: b ? { eventId: b.eventId, channel: b.channel, chatId: b.chatId, accountId: b.accountId } : null,
    };
  }

  // ==== 入站唯一入口 ====
  // 采集器（生产 listener / 影子）只管「从平台捞到一条原始记录」，剩下三步都在这里。
  // 以前影子和生产各走各的、媒体那一段谁都没接 —— 现在只有这一条路。
  const intake = makeIntake({ inbound, media, pluginFor: (ch) => pluginMap.get(ch) });

  // ==== 主循环 ====
  // 2026-09-18 补：装配原来只装到 `intake` 为止（那是「嫁接到老桥门上」那一版的形状，
  // 由 app.js 自己往下接）。结果 `scripts/gate-box-live.js` 只好**自己手搓一套**
  // pipeline/router/undelivered —— 两套装配并存、各自漂移，正是今天冷层那个 bug 的病根
  // （`forCold` 零调用、真正在跑的是另一份写手）。现在只有这一条装配路。
  //
  // 影子（只读、显式给 box=null）没有盒子，主循环无从谈起 —— 那种情况 pipe 就是 null。
  // 群闸：配置给了才有。没给 = 这座桥不收群消息（群轮会被明确挡下，不是静默丢）。
  const groupGate = groups ? makeGroupGate({
    ...groups,
    stateFile: groups.stateFile || require("path").join(root, "groups.json"),
  }) : null;
  const pipe = box === null ? null : makePipeline({
    plugins: pluginMap, inbound, outbound, box, router, media, undelivered,
    groups: groupGate, owner, binding, enabled: () => !enforceEnabled || killswitch.enabled(), log,
    closingNote,
  });

  // 生产者投递口：一条一个文件，谁都能往里投（独立进程也行）。
  // **桥不认识它们是谁** —— producer 是自由文本。
  const producerInbox = producersDir ? makeProducerInbox({ dir: producersDir }) : null;

  return {
    store, cold, caps, media, inbound, outbound, killswitch, binding, turnFor, intake, box,
    router, undelivered, pipe, groups: groupGate, producers: producerInbox,

    /**
     * 消化生产者投进来的东西。
     *
     * **有轮在飞就整批不动** —— 那是技术撞车，对任何生产者都成立。
     * 别的时机判断（比如「她刚说过话，这次 check-in 没意义」）**归生产者自己**，
     * 桥不认识它们的策略。
     */
    async drainProducers() {
      if (!producerInbox || !pipe) return { ok: 0, failed: 0, skipped: 0, held: 0 };
      // **只挡技术撞车**：有轮在飞的时候再塞一轮进去，排队会乱、来路会串。
      // 「她刚说过话所以这次没意义」那条判据**归生产者自己**（check-in 在
      // src/producers/checkin.js 里自己读冷层判，投都不投）——桥不认识
      // 各个生产者的时机策略（Alice 2026-09-18：「是从脚本那里就直接丢掉」）。
      const b = pipe.busy();
      if (b.busy) return { ok: 0, failed: 0, skipped: 0, held: producerInbox.pending(), why: b.why };
      return producerInbox.drain((note) => pipe.push({
        id: note.id, text: note.text, producer: note.producer, target: note.target || null,
      }));
    },
    /** 投递口：桥对外唯一的「我要发这个」。没有盒子就没有这个口。 */
    outlet: pipe ? pipe.outlet : null,
    /**
     * 给某条腿装上「自己去捞」。装完这条腿就是活的：
     * 捞 → 主循环 → 盒子 → 出闸 → 发回去，中间不用人手喂。
     *
     * 游标/死信默认落在闸自己的存储目录底下（`root` 是调用方给的，没有写死路径）。
     * 返回收信人，**什么时候 run()/stop() 由调用方决定** —— 桥不自己起后台循环。
     */
    attach({ channel, cursorFile, deadLetterFile, enabled = () => true, log: legLog = log } = {}) {
      if (!pipe) throw new Error("这座桥没有盒子（box=null），挂不了自己捞消息的腿");
      const path_ = require("path");
      return pipe.attach({
        channel, enabled,
        cursorFile: cursorFile || path_.join(root, "cursor-" + channel + ".json"),
        deadLetterFile: deadLetterFile || path_.join(root, "dead-" + channel + ".jsonl"),
        log: legLog,
      });
    },
    /** 新桥现在该不该接管这一轮。**读不到一律 false。** */
    enabled: () => killswitch.enabled(),
    preflight: () => preflight({ caps, plugins, killswitch, pluginMap }),
  };
}

/**
 * **入站唯一入口**（2026-09-17）。
 *
 *   平台原始记录 → plugin.toDelivery（定位） → media.hydrate（取字节+加工） → inbound.accept
 *
 * 为什么非得收成一个口子：9-17 之前这三步散在各处，媒体那一段**谁都没接**——
 * `media.ingest` 和 `fetchMedia` 全仓只有测试在调，图片解密解得再对，
 * 投到他眼前仍然是一个 `[图片]`。而影子和生产各走各的路，影子验过的不代表生产走的。
 * 现在两边都走这个函数：**影子验的就是真交付**。
 *
 * @param {object} o
 * @param {object} o.inbound   入闸
 * @param {object} [o.media]   媒体流水线。给不了就退成「只走文本」，不炸。
 * @param {function} o.pluginFor  渠道名 -> 插头（微信那格每次都问一遍选择器）
 * @returns {(o:{channel:string, raw:object, extraMedia?:Array}) => Promise<object>}
 */
function makeIntake({ inbound, media = null, pluginFor }) {
  return async function intake({ channel, raw, extraMedia = [] }) {
    const plugin = pluginFor(channel);
    if (!plugin) throw new Error("没有这个渠道的插头：" + channel);
    // toDelivery 有的插头是同步的（微信）有的是异步的（TG）—— await 两种都吃。
    const delivery = await plugin.toDelivery(raw);
    // 采集器额外知道的媒体（如 TG 收件箱壳里的 attachment_path），并进来一起加工。
    if (extraMedia && extraMedia.length) {
      delivery.media = (Array.isArray(delivery.media) ? delivery.media : []).concat(extraMedia);
    }
    if (media) await media.hydrate(delivery, plugin);
    return inbound.accept(delivery);
  };
}

/**
 * 接管之前照着念一遍：缺什么、谁没表态、现在开关在哪一挡。
 * **只报告，不修、不启用。**
 */
function preflight({ caps, plugins, killswitch, pluginMap }) {
  const rows = [];
  for (const [label, p] of Object.entries(plugins)) {
    if (!p) { rows.push({ plugin: label,状态: "没实例" }); continue; }
    const d = describePlugin(p);
    const h = typeof p.health === "function" ? p.health() : {};
    rows.push({
      plugin: label, channel: d.channel,
      支持: d.supported.length + "/" + COMMON_INTENTS.length,
      漏表态: d.undeclared,
      专属: d.extras,
      接线: h.plugin || "?", 在线: h.availability || "?",
    });
  }
  return {
    缺的共用能力: missingShared(caps),
    插头: rows,
    接了几条腿: [...pluginMap.keys()],
    开关: killswitch.enabled() ? "开（新桥接管）" : "关（走老路）",
    // 切换清单：这几样在切的那一刻必须交接清楚，光靠重启不行
    切换清单: [
      "入站游标（影子那份 vs 生产那份，别重复投也别漏投）",
      "未处理入站（切的瞬间在队列里的）",
      "当前轮次（他正在说话的那一轮，别腰斩）",
      "长任务（跑着的工具调用）",
      "已发未确认（outbound.unknown —— 结果不明不等于没发，别自动重发）",
      "冷层待写（老路写了一半的）",
    ],
  };
}

module.exports = { buildGate, preflight, makeIntake };
