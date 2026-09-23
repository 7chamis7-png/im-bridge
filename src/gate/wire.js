"use strict";

/**
 * Assembly — wires the parts of src/gate/ into one object.
 *
 * The host only calls `buildGate(...)`; everything else is assembled here, so reviewers can
 * read one file.
 *
 * This file assembles; it doesn't start loops. When legs run is decided by the host.
 * The killswitch defaults to off (flag file missing = disabled), so building a gate never
 * takes over traffic by itself.
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
 * @param {string} o.root          gate storage directory (event ledger + cursors)
 * @param {string} o.coldFile      cold-layer file (the gate is the only writer)
 * @param {object} o.plugins       { slot: pluginInstance } — the channel comes from plugin.channel
 * @param {object} [o.capabilities] shared capability implementations, injected by the caller:
 *   { file_store, fetch_bytes, transcribe, acoustic, vision, synthesize_voice, generate_image }
 * @param {boolean} [o.nativeImageInput] can the agent see images itself (pass the image vs. paid vision)
 * @param {object|null} o.box  the box running the CLI (see box.js). Must be given explicitly;
 *   a read-only gate passes null.
 * @param {object} [o.identities]  "channel:senderId" -> identity name
 * @param {object} [o.groups]      group config { allowed:[], alwaysWake:[], wakeNames?:[] }.
 *   The allowlist comes only from here; never learned from chat.
 *   Omitted = this gate does not accept group messages.
 * @param {string} [o.owner]       owner identity name, default "owner". Only used to decide who may run commands.
 * @param {object} [o.segment] segmentation options { minChars, maxBubbles, softMax }, see segment.js.
 *   Default: split on blank lines only, merge short segments, no cap, no hard split.
 * @param {number} [o.sendGapMs] delay between consecutive bubbles, default 700ms.
 * @param {string} [o.producersDir] producer drop directory (check-ins drop files here).
 *   Omitted = no external pushes. The bridge doesn't know who producers are.
 * @param {object|null} [o.preferredRoute] preferred target { platform, chat_id } (routing policy 4).
 *   From config, never hard-coded (SPEC §4). Omitted = only policies 1–3 can match.
 * @param {function} [o.log]
 */
function buildGate({ root, coldFile, plugins = {}, capabilities = {}, identities = {}, files = {},
  nativeImageInput = true, box, preferredRoute = null, groups = null, owner = "owner",
  producersDir = "", segment = {}, sendGapMs = 700, sendGapByChannel = {}, enforceEnabled = false, log = () => {},
  // text of the pre-rotation closing turn (from the host; opaque to the bridge). Omitted = no closing turn.
  closingNote = null }) {
  // The box must be given explicitly: an object is validated right away; null means this gate
  // never sends into a box (read-only). `undefined` means the caller forgot — fail loudly
  // instead of silently assembling a gate with nothing connected.
  if (box === undefined) {
    throw new Error("buildGate 要 box：给盒子对象，或者显式给 null（表示这座桥不往盒子里送）");
  }
  if (box !== null) assertBox(box);
  const store = new GateStore({ root });
  const cold = new ColdWriter({ file: coldFile });

  // —— Layer 1: shared capabilities. One implementation each; duplicates throw. ——
  // Implementations are injected by the caller: the gate only asks for "something that turns
  // audio into text". The adapters for a given machine live in `src/host/gate-capabilities.js`,
  // outside the bridge. Registered once, shared by all plugins.
  const caps = new Capabilities();
  for (const [name, impl] of Object.entries(capabilities)) if (impl) caps.register(name, impl);

  // Each plugin declares its own `.channel`, so this table needs no knowledge of specific legs.
  // A plugin's slot name and channel name may differ (e.g. slot `wechatA11y`, channel `wechat`).
  // Different sources on the same platform (e.g. a personal WeChat client vs. a bot account)
  // are separate slots with separate channels: identity, reply address and cold records differ.
  const pluginMap = new Map();
  for (const [slot, plugin] of Object.entries(plugins || {})) {
    if (!plugin) continue;
    const ch = String(plugin.channel || "").trim();
    if (!ch) { log("⚠️ 插头 " + slot + " 没说自己是哪个渠道，跳过（它收到的消息会找不到人认领）"); continue; }
    if (pluginMap.has(ch)) { log("⚠️ 渠道 " + ch + " 有两个插头抢（" + slot + "），后来的不生效"); continue; }
    pluginMap.set(ch, plugin);
  }

  // Media pipeline: plugins only hand over bytes; storage, type sniffing, pass-image vs.
  // transcribe, frame grabbing all happen here. `nativeImageInput` is a property of the box,
  // not of the channel, so the caller (which knows the box) tells the bridge.
  const media = new MediaPipeline({
    caps,
    fileStore: caps.has("file_store") ? caps.impls.get("file_store").store : null,
    nativeImageInput,
  });

  const inbound = new InboundGate({ store, cold, identities });
  // Undelivered ledger. The outbound gate must have it, otherwise "the owner never received it"
  // would only be visible in the event ledger — so it's wired here, not left to the caller.
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
  // Per-turn origin persisted to disk: the tool process is separate and can only recover
  // "where did this turn come from" from here.
  const binding = new TurnBinding({ file: files.turnBinding || require("path").join(root, "turn-bindings.json") });

  /** For outbound / the tool process: rebuild a turn from threadId:turnId. */
  function turnFor({ threadId, turnId, text, intent }) {
    const b = binding.lookup(threadId, turnId);
    return {
      turnId, threadId, text, intent,
      replyToEventId: b ? b.eventId : null,
      inboundEvent: b ? { eventId: b.eventId, channel: b.channel, chatId: b.chatId, accountId: b.accountId } : null,
    };
  }

  // ==== The single inbound entry point ====
  // Collectors only fetch a raw platform record; the remaining steps happen here.
  const intake = makeIntake({ inbound, media, pluginFor: (ch) => pluginMap.get(ch) });

  // ==== Main loop ====
  // One assembly path only. A read-only gate (box=null) has no pipeline (pipe = null).
  // Group gate only when configured; otherwise group turns are explicitly rejected, not dropped.
  const groupGate = groups ? makeGroupGate({
    ...groups,
    stateFile: groups.stateFile || require("path").join(root, "groups.json"),
  }) : null;
  const pipe = box === null ? null : makePipeline({
    plugins: pluginMap, inbound, outbound, box, router, media, undelivered,
    groups: groupGate, owner, binding, enabled: () => !enforceEnabled || killswitch.enabled(), log,
    closingNote,
  });

  // Producer drop-box: one file per note; anyone (including separate processes) can drop.
  // The bridge doesn't know who producers are — `producer` is free text.
  const producerInbox = producersDir ? makeProducerInbox({ dir: producersDir }) : null;

  return {
    store, cold, caps, media, inbound, outbound, killswitch, binding, turnFor, intake, box,
    router, undelivered, pipe, groups: groupGate, producers: producerInbox,

    /**
     * Consume notes dropped by producers.
     *
     * While a turn is in flight the whole batch waits — that's a technical collision for any
     * producer. Any other timing policy (e.g. "the owner just spoke, skip this check-in")
     * belongs to the producer itself.
    async drainProducers() {
      if (!producerInbox || !pipe) return { ok: 0, failed: 0, skipped: 0, held: 0 };
      // Only guard against technical collisions: pushing a turn while one is in flight would
      // scramble the queue and routing. Timing policies belong to the producers.
      const b = pipe.busy();
      if (b.busy) return { ok: 0, failed: 0, skipped: 0, held: producerInbox.pending(), why: b.why };
      return producerInbox.drain((note) => pipe.push({
        id: note.id, text: note.text, producer: note.producer, target: note.target || null,
      }));
    },
    /** Outlet: the bridge's single "I want to send this" entry. No box → no outlet. */
    outlet: pipe ? pipe.outlet : null,
    /**
     * Attach a self-polling leg: fetch → main loop → box → outbound → send, no manual feeding.
     *
     * Cursor / dead-letter files default to the gate's own storage directory (`root` is
     * given by the caller). Returns the receiver; the caller decides when to run()/stop() —
     * the bridge never starts background loops by itself.
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
    /** Should the gate take over turns right now? Unreadable flag = false. */
    enabled: () => killswitch.enabled(),
    preflight: () => preflight({ caps, plugins, killswitch, pluginMap }),
  };
}

/**
 * The single inbound entry point.
 *
 *   raw platform record → plugin.toDelivery (locate) → media.hydrate (fetch bytes + process) → inbound.accept
 *
 * Keeping the three steps behind one function guarantees every collector goes through
 * the media stage; otherwise media would be silently skipped.
 *
 * @param {object} o
 * @param {object} o.inbound   inbound gate
 * @param {object} [o.media]   media pipeline; if absent, text only (no crash)
 * @param {function} o.pluginFor  channel name -> plugin
 * @returns {(o:{channel:string, raw:object, extraMedia?:Array}) => Promise<object>}
 */
function makeIntake({ inbound, media = null, pluginFor }) {
  return async function intake({ channel, raw, extraMedia = [] }) {
    const plugin = pluginFor(channel);
    if (!plugin) throw new Error("没有这个渠道的插头：" + channel);
    // toDelivery is sync for some plugins and async for others — await handles both.
    const delivery = await plugin.toDelivery(raw);
    // Extra media known to the collector is merged in and processed together.
    if (extraMedia && extraMedia.length) {
      delivery.media = (Array.isArray(delivery.media) ? delivery.media : []).concat(extraMedia);
    }
    if (media) await media.hydrate(delivery, plugin);
    return inbound.accept(delivery);
  };
}

/**
 * Pre-takeover checklist: what's missing, which plugins left intents undeclared, killswitch state.
 * Report only; never fixes or enables anything.
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
    // cutover checklist: these must be handed over explicitly; restarting alone is not enough
    切换清单: [
      "入站游标（别重复投也别漏投）",
      "未处理入站（切的瞬间在队列里的）",
      "当前轮次（agent 正在说话的那一轮，别腰斩）",
      "长任务（跑着的工具调用）",
      "已发未确认（outbound.unknown —— 结果不明不等于没发，别自动重发）",
      "冷层待写（写了一半的）",
    ],
  };
}

module.exports = { buildGate, preflight, makeIntake };
