"use strict";

/**
 * 工具口（2026-09-18）—— 独立进程怎么让桥替它把话送出去
 *
 * ## 为什么要有它
 *
 * MCP 工具跑在 **claude 自己拉起来的子进程**里，够不着桥进程里的出闸。
 * 老桥的解法是工具自己直连平台（自己读 token、自己调 Bot API），于是：
 *   · 渠道靠工具自己猜 —— 切桥当天她在微信说话、他的语音发去了 TG
 *   · 桥完全不知道他说过话 —— 不进冷层、不进账本，一换舱就失忆
 *
 * 所以工具**不该自己发**。它只说「我想发这个」，怎么发、发去哪、记什么账，
 * 全归出闸。这个文件就是那条通路。
 *
 * ## 边界
 *
 * - 桥监听一个 unix socket，**只在本机、只由 claude 的子进程连**。
 * - 协议是一行一个 JSON（NDJSON），请求带 `id`，响应原样带回同一个 `id`。
 * - **不做鉴权** —— socket 文件 0600，能读它的已经是 root 了。
 * - 收到的东西一律当**外部输入**校验：认不出的意图直接回错，不猜。
 *
 * ## 渠道归谁决定（Alice 2026-09-18 拍板）
 *
 *   · 工具**不给** channel → 出闸按这一轮的来路原路返回（治「你在微信他回 TG」）
 *   · 工具**显式给了** channel → 听他的，这是他的主动权（她让他"往哪哪发一条"时用）
 *   · 但给了也要过闸：腿在不在、支不支持这个意图 —— **不行就明说，绝不静默改投**
 *
 * 「这一轮从哪来」不靠猜，查 `turn-binding`（那份就是为独立进程落的盘）。
 */

const fs = require("fs");
const net = require("net");
const path = require("path");

const { loadTools } = require("./tools");
const { classifyArgs } = require("./surface");

/**
 * @param {object} o
 * @param {string} o.file        socket 路径（GATE_ROOT 底下）
 * @param {object} o.outbound    出闸
 * @param {object} o.binding     turn-binding：查「这一轮从哪来」
 * @param {function} [o.activeTurn] 拿不到 turnId 时问桥「现在在跑哪一轮」
 * @param {object} [o.tools]     工具插件表（不给就现扫一遍插件目录）
 * @param {function} [o.addressOn] (渠道) => {chat_id} —— 她在那条腿上的地址。
 *   她说「发我微信」时他只说得出渠道，**地址由桥查，不该让模型记**（router.addressOn）
 * @param {function} [o.log]
 */
function makeToolSocket({ file, outbound, binding, activeTurn = () => null,
  tools = null, addressOn = () => null, log = () => {} }) {
  if (!String(file || "").trim()) throw new Error("工具口要一个 socket 路径 —— 不许用默认值猜");
  if (!outbound) throw new Error("工具口要出闸（没有它这条通路没有意义）");
  if (!binding) throw new Error("工具口要 turn-binding（不然查不到这轮从哪来）");
  // 工具是插件：扔进 tools/ 就有，这里**不枚举**工具名（铁律 2/3）
  const registry = tools || loadTools({ log }).byName;

  /** 把一条工具请求变成一次出闸投递。 */
  async function handle(req) {
    const tool = String(req.tool || "").trim();
    const plugin = registry.get(tool);
    if (!plugin) {
      return { ok: false, error: "不认识的工具：" + (tool || "(空)")
        + "；装上的是 " + [...registry.keys()].join(" / ") };
    }
    if (!plugin.intent) {
      // 干活类插件（读日记、查记忆…）自己有 handler，不走出闸这条路
      return { ok: false, error: tool + " 不是投递类工具，不该走工具口" };
    }
    const intent = plugin.intent;

    // 这一轮是哪一轮：工具自己报的优先，报不上来就问桥
    const active = activeTurn() || {};
    const threadId = String(req.threadId || active.threadId || "").trim();
    const turnId = String(req.turnId || active.turnId || "").trim();

    // 来路：**查盘上那份，不猜**
    const bound = binding.lookup(threadId, turnId);
    const wanted = String(req.channel || "").trim().toLowerCase();

    if (!bound && !wanted) {
      return { ok: false, error: "查不到这一轮从哪来，而且你也没指定 channel —— "
        + "不猜地址（要主动发就明确给 channel）" };
    }

    // 不给 channel → 原路返回（她在哪说的就回哪）
    let inboundEvent = bound ? {
      eventId: bound.eventId, channel: bound.channel,
      chatId: bound.chatId, accountId: bound.accountId || "",
    } : null;

    // 给了 channel → 听他的（她让他"往哪哪发一条"）。
    // 地址不让模型记：桥按那条腿的最近入站查出来；查不到就**明说**，不猜、不改投。
    if (wanted && (!inboundEvent || inboundEvent.channel !== wanted)) {
      const addr = addressOn(wanted);
      if (!addr || !addr.chat_id) {
        return { ok: false, outcome: "blocked", intent, channel: wanted,
          reason: "channel_address_unknown",
          error: "你指定了 " + wanted + "，但桥还不知道她在这条腿上的地址（这条腿还没有过入站）" };
      }
      inboundEvent = { eventId: (bound && bound.eventId) || "", channel: wanted,
        chatId: addr.chat_id, accountId: addr.accountId || "" };
    }

    // 渠道专属参数（按钮、回复某一条…）：按**这一轮实际要去的渠道**分类。
    // 2026-09-20 修：原来这里只把 args 原样塞进 toolArgs，插头读的却是 extras ——
    // TG 那条腿一直认按钮和 reply_to，但从工具口进来的永远是空的，静默丢。
    // toolArgs 照旧整份给（react 的 emoji 等还靠它），extras 只是多给一份分好类的。
    const { extras, unsupported } = classifyArgs({
      args: req.args && typeof req.args === "object" ? req.args : {},
      channel: (inboundEvent && inboundEvent.channel) || "",
    });
    // 点表情默认点**她本轮那条** —— 2026-09-20 Nova报的：
    // 「react 第一次调用说『要知道点哪一条』，但说明书写的是默认点她本轮那条」。
    // 查下来是四跳里断了一跳：入站事件一直带着她那条的平台号（events.jsonl 的 nativeId），
    // 可轮次绑定不存、工具口不传，TG 腿只好抛「点表情要知道点哪一条」。
    // 现在：没显式给 message_id，而且这一轮**还在她说话那条腿上**，就拿绑定里那个号。
    // ⚠️ 改投到别的渠道时**绝不带**：号是平台内部的，换条腿就指向别人的消息。
    if (intent === "react" && !extras.message_id
        && bound && bound.nativeId && inboundEvent && inboundEvent.channel === bound.channel) {
      extras.message_id = bound.nativeId;
    }

    const turn = {
      turnId: turnId || "tool-" + Date.now(),
      outputId: String(req.id || "") + "-tool",
      // 出闸靠这个判断「是不是在回某条入站」；显式渠道时也给它一个，
      // 好让出闸走同一条目标解析（它只认 inboundEvent，不认别的字段）
      replyToEventId: (bound && bound.eventId) || ("tool-" + (turnId || Date.now())),
      inboundEvent,
      // 配字：发图/发文件那两个工具把配字叫 `caption`（在 args 里），而插头只认 `text`。
      // 2026-09-20 修：原来这里只看 req.text，`caption` 悄悄丢了 —— 图照发、字没了、
      // 冷层这一轮也是空的（换舱后他不记得发图时说过什么）。9-18 切桥起就这样。
      text: String(req.text || (req.args && typeof req.args.caption === "string" ? req.args.caption : "") || ""),
      intent,
      ...(req.args && typeof req.args === "object" ? { toolArgs: req.args } : {}),
      extras,
    };

    const r = await outbound.deliver(turn);
    // 原样把结论带回去 —— **blocked 不许伪装成成功**，他得知道这条没出去
    return {
      ok: r.outcome === "sent" || r.outcome === "silent",
      outcome: r.outcome,
      reason: r.reason || "",
      intent,
      channel: r.channel || (inboundEvent && inboundEvent.channel) || wanted || "",
      detail: r.detail || null,
      notes: r.notes || [],
      // 给不了的专属参数**必须明说**（比如微信轮上给了按钮：字照发，按钮没出去）
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
    handle,                                    // 给测试直接调，不必起 socket
    async start() {
      try { fs.unlinkSync(file); } catch { /* 没有就算了 */ }
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
      try { fs.unlinkSync(file); } catch { /* 已经没了 */ }
    },
  };
}

module.exports = { makeToolSocket };
