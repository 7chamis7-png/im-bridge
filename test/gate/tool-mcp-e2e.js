"use strict";
/**
 * Tool layer end-to-end: agent calls a tool -> bridge delivers -> result returns to the agent.
 *
 * 跑的是真零件：真 MCP 壳（子进程，走 stdio）、真 unix socket、真出闸、真冷层。
 * 只有插头是假的（不真发到平台）。
 *
 * It answers three questions:
 *   · does the bridge record what the agent said via a tool (cold log + ledger)?
 *   · if the user spoke on WeChat, does the agent's voice stay on WeChat (not leak to Telegram)?
 *   · when something can't be delivered, is the agent told (no silent rerouting)?
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { GateStore } = require("../../src/gate/store");
const { ColdWriter } = require("../../src/gate/cold-writer");
const { OutboundGate } = require("../../src/gate/outbound");
const { TurnBinding } = require("../../src/gate/turn-binding");
const { makeToolSocket } = require("../../src/gate/tool-socket");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tool-e2e-"));
let n = 0;
const ok = (m) => { n += 1; console.log("  OK  " + m); };

// 两条假腿：微信只会打字，TG 什么都会
const sent = [];
const mkPlugin = (channel, caps) => ({
  channel, capabilities: caps,
  health: () => ({ platform: "supported", plugin: "wired", availability: "ready" }),
  async send({ chatId, text, intent }) { sent.push({ channel, chatId, text, intent }); return "m" + sent.length; },
});
const ALL = { send_text: "supported", send_voice: "supported", send_sticker: "supported",
  send_generated_image: "supported", send_file: "supported", react: "supported" };
const TEXT_ONLY = { ...ALL, send_voice: "unsupported" };

(async () => {
  const store = new GateStore({ root });
  const cold = new ColdWriter({ file: path.join(root, "cold.jsonl") });
  const outbound = new OutboundGate({ store, cold,
    plugins: new Map([["wechat", mkPlugin("wechat", TEXT_ONLY)], ["telegram", mkPlugin("telegram", ALL)]]) });
  const binding = new TurnBinding({ file: path.join(root, "binding.json") });

  // 这一轮是用户从**微信**发来的
  binding.bind("th-1", "turn-1", { eventId: "ev-1", channel: "wechat", chatId: "wxid_owner", accountId: "wx" });

  const sockFile = path.join(root, "tools.sock");
  const socket = makeToolSocket({
    file: sockFile, outbound, binding,
    activeTurn: () => ({ threadId: "th-1", turnId: "turn-1" }),
    addressOn: (ch) => (ch === "telegram" ? { chat_id: "861" } : null),
    log: () => {},
  });
  await socket.start();

  // ——— 起真的 MCP 壳（子进程），照 claude 的方式跟它说话 ———
  const shell = spawn(process.execPath, [path.join(__dirname, "..", "..", "src", "gate", "tools", "mcp-server.js")],
    { env: { ...process.env, GATE_TOOL_SOCKET: sockFile }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  shell.stdout.on("data", (c) => { out += c.toString(); });
  const rpc = (method, params, id) => new Promise((resolve) => {
    const before = out.length;
    shell.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    const t = setInterval(() => {
      const fresh = out.slice(before);
      const line = fresh.split("\n").find((l) => l.trim() && JSON.parse(l).id === id);
      if (line) { clearInterval(t); resolve(JSON.parse(line)); }
    }, 20);
  });

  const init = await rpc("initialize", {}, 1);
  assert.equal(init.result.serverInfo.name, "im_bridge");
  ok("壳起来了，自报家门 im_bridge");

  const list = await rpc("tools/list", {}, 2);
  const names = list.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["call", "hang_up", "react", "reply", "send_file", "send_image", "send_sticker", "send_voice"]);
  ok("agent 看得见目录里的工具（扔个文件就多一个）");
  assert.ok(list.result.tools.every((t) => !/telegram|wechat/.test(t.name)));
  ok("工具名里没有渠道 —— 名字是意图不是地址");

  // ① no channel -> reply goes back the way the turn came (WeChat)
  const r1 = await rpc("tools/call", { name: "reply", arguments: { text: "我在" } }, 3);
  const o1 = JSON.parse(r1.result.content[0].text);
  assert.equal(o1.outcome, "sent");
  assert.equal(sent.at(-1).channel, "wechat");
  ok("不给渠道 → 原路回微信（用户在哪说的就回哪）");

  // ② 桥知道 agent 说过话 —— 冷层有，账本也有
  const coldRows = fs.readFileSync(path.join(root, "cold.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(coldRows.some((r) => r.role === "assistant" && r.text === "我在"));
  ok("**冷层记下了**");

  // ③ 用户要求"发我 TG" → 听 agent 的，地址由桥查
  const r2 = await rpc("tools/call", { name: "reply", arguments: { text: "发这边", channel: "telegram" } }, 4);
  const o2 = JSON.parse(r2.result.content[0].text);
  assert.equal(o2.outcome, "sent");
  assert.equal(sent.at(-1).channel, "telegram");
  assert.equal(sent.at(-1).chatId, "861");
  ok("指定渠道 → 听 agent 的，地址桥自己查出来");

  // ④ 微信发不了语音 → 明确告诉 agent，**不静默改投 TG**
  const before = sent.length;
  const r3 = await rpc("tools/call", { name: "send_voice", arguments: { text: "晚安" } }, 5);
  const o3 = JSON.parse(r3.result.content[0].text);
  assert.equal(o3.ok, false);
  assert.equal(o3.outcome, "blocked");
  assert.match(o3.reason, /unsupported/);
  // 判据是「一个字都没发出去」，不是「最后一条不是 TG」——
  // blocked 本来就不新增发送，比 at(-1) 等于什么都没验（差点写成假绿）
  assert.equal(sent.length, before, "blocked 了却还是发出去了");
  ok("微信发不了语音 → 明说 blocked，一个字都没发出去");

  // ⑤ 不认识的工具不许瞎猜
  const r4 = await rpc("tools/call", { name: "telegram_reply", arguments: { text: "x" } }, 6);
  assert.match(JSON.parse(r4.result.content[0].text).error, /没有这个工具/);
  ok("老名字已经不存在了（telegram_reply → 明确报错）");

  shell.kill();
  await socket.stop();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n通过 ${n} / 失败 0`);
})().catch((e) => { console.error("FAIL", e && e.message); process.exit(1); });
