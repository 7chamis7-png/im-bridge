"use strict";

/**
 * Tool socket: how an out-of-process tool asks the bridge to send something.
 *
 * ## Why
 *
 * MCP tools run in a child process spawned by the Claude CLI and cannot reach
 * the bridge's outbound gate. If tools talked to platforms directly (own token,
 * own Bot API calls), then:
 *   - the channel would be guessed by the tool (reply goes to the wrong app)
 *   - the bridge would not know the agent said anything (no archive, no ledger)
 *
 * So tools never send. They only say "I want to send this"; how, where, and
 * what gets recorded is decided by the outbound gate. This file is that path.
 *
 * ## Boundaries
 *
 * - The bridge listens on a local unix socket, used only by the CLI's children.
 * - Protocol: NDJSON, one request per line with an `id`, echoed in the response.
 * - No auth: the socket file is 0600 (only its owner can connect).
 * - Everything received is validated as external input; unknown intents are rejected.
 *
 * ## Who picks the channel
 *
 *   - no channel given   -> reply along this turn's inbound route
 *   - explicit channel   -> honored (the owner asked to "send it on X")
 *   - either way it passes the gate: leg available, intent supported;
 *     otherwise the result says so. Never silently re-routed.
 *
 * "Where did this turn come from" is looked up in `turn-binding`, not guessed.
 */

const fs = require("fs");
const net = require("net");
const path = require("path");

const { loadTools } = require("./tools");
const { classifyArgs } = require("./surface");

/**
 * @param {object} o
 * @param {string} o.file        socket path (under GATE_ROOT)
 * @param {object} o.outbound    outbound gate
 * @param {object} o.binding     turn-binding: which inbound started this turn
 * @param {function} [o.activeTurn] asked for the running turn when no turnId is given
 * @param {object} [o.tools]     tool plugin registry (defaults to scanning the tools dir)
 * @param {function} [o.addressOn] (channel) => {chat_id} - the owner's address on that
 *   channel. The model only names a channel; the bridge resolves the address (router.addressOn).
 * @param {function} [o.log]
 */
function makeToolSocket({ file, outbound, binding, activeTurn = () => null,
  tools = null, addressOn = () => null, log = () => {} }) {
  if (!String(file || "").trim()) throw new Error("工具口要一个 socket 路径 —— 不许用默认值猜");
  if (!outbound) throw new Error("工具口要出闸（没有它这条通路没有意义）");
  if (!binding) throw new Error("工具口要 turn-binding（不然查不到这轮从哪来）");
  // tools are plugins discovered from tools/; names are never enumerated here
  const registry = tools || loadTools({ log }).byName;

  /** Turn one tool request into one outbound delivery. */
  async function handle(req) {
    const tool = String(req.tool || "").trim();
    const plugin = registry.get(tool);
    if (!plugin) {
      return { ok: false, error: "不认识的工具：" + (tool || "(空)")
        + "；装上的是 " + [...registry.keys()].join(" / ") };
    }
    if (!plugin.intent) {
      // non-delivery tools have their own handler and do not use this path
      return { ok: false, error: tool + " 不是投递类工具，不该走工具口" };
    }
    const intent = plugin.intent;

    // which turn: prefer what the tool reports, otherwise ask the bridge
    const active = activeTurn() || {};
    const threadId = String(req.threadId || active.threadId || "").trim();
    const turnId = String(req.turnId || active.turnId || "").trim();

    // inbound route: look it up on disk, never guess
    const bound = binding.lookup(threadId, turnId);
    const wanted = String(req.channel || "").trim().toLowerCase();

    if (!bound && !wanted) {
      return { ok: false, error: "查不到这一轮从哪来，而且你也没指定 channel —— "
        + "不猜地址（要主动发就明确给 channel）" };
    }

    // no channel -> reply where the owner spoke
    let inboundEvent = bound ? {
      eventId: bound.eventId, channel: bound.channel,
      chatId: bound.chatId, accountId: bound.accountId || "",
    } : null;

    // explicit channel -> honored. The address comes from that leg's latest inbound;
    // if unknown, say so explicitly - no guessing, no re-routing.
    if (wanted && (!inboundEvent || inboundEvent.channel !== wanted)) {
      const addr = addressOn(wanted);
      if (!addr || !addr.chat_id) {
        return { ok: false, outcome: "blocked", intent, channel: wanted,
          reason: "channel_address_unknown",
          error: "你指定了 " + wanted + "，但桥还不知道 owner 在这条腿上的地址（这条腿还没有过入站）" };
      }
      inboundEvent = { eventId: (bound && bound.eventId) || "", channel: wanted,
        chatId: addr.chat_id, accountId: addr.accountId || "" };
    }

    // Channel-specific args (buttons, reply-to...) are classified against the channel
    // this delivery actually goes to. Plugins read `extras`; `toolArgs` is still
    // passed whole (e.g. react's emoji relies on it).
    const { extras, unsupported } = classifyArgs({
      args: req.args && typeof req.args === "object" ? req.args : {},
      channel: (inboundEvent && inboundEvent.channel) || "",
    });
    // A reaction defaults to the owner's message of this turn: when no message_id is
    // given and we are still on the inbound's channel, use the bound native id.
    // Never carry it to another channel: native ids are platform-internal.
    if (intent === "react" && !extras.message_id
        && bound && bound.nativeId && inboundEvent && inboundEvent.channel === bound.channel) {
      extras.message_id = bound.nativeId;
    }

    const turn = {
      turnId: turnId || "tool-" + Date.now(),
      outputId: String(req.id || "") + "-tool",
      // The outbound gate uses this to know it is replying to an inbound; also set
      // for explicit channels so target resolution follows the same path.
      replyToEventId: (bound && bound.eventId) || ("tool-" + (turnId || Date.now())),
      inboundEvent,
      // Image/file tools call the text `caption` (in args) but plugins read `text`;
      // map it here so the caption is neither dropped nor missing from the archive.
      text: String(req.text || (req.args && typeof req.args.caption === "string" ? req.args.caption : "") || ""),
      intent,
      ...(req.args && typeof req.args === "object" ? { toolArgs: req.args } : {}),
      extras,
    };

    const r = await outbound.deliver(turn);
    // Return the verdict as is: blocked must never look like success.
    return {
      ok: r.outcome === "sent" || r.outcome === "silent",
      outcome: r.outcome,
      reason: r.reason || "",
      intent,
      channel: r.channel || (inboundEvent && inboundEvent.channel) || wanted || "",
      detail: r.detail || null,
      notes: r.notes || [],
      // unsupported extras must be reported (e.g. buttons on a channel without them)
      unsupportedExtras: unsupported,
    };
  }

  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let req = null;
        try { req = JSON.parse(line); }
        catch { sock.write(JSON.stringify({ ok: false, error: "不是 JSON" }) + "\n"); continue; }
        Promise.resolve()
          .then(() => handle(req))
          .catch((e) => ({ ok: false, error: String((e && e.message) || e) }))
          .then((res) => {
            try { sock.write(JSON.stringify({ id: req.id, ...res }) + "\n"); }
            catch (e) { log("[工具口] 回不去：" + ((e && e.message) || e)); }
          });
      }
    });
    sock.on("error", (e) => log("[工具口] 连接出错：" + ((e && e.message) || e)));
  });

  return {
    tools: registry,
    handle,                                    // exposed for tests (no socket needed)
    async start() {
      try { fs.unlinkSync(file); } catch { /* not present */ }
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(file, () => { server.removeListener("error", reject); resolve(); });
      });
      fs.chmodSync(file, 0o600);
      log("[工具口] 开在 " + file);
      return file;
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      try { fs.unlinkSync(file); } catch { /* already gone */ }
    },
  };
}

module.exports = { makeToolSocket };
