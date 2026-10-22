"use strict";
// 2026-10-22：拒收自动重投 / whenReady 超时 / /pending / 死信重投去重 / /status 新行 / 守护推送节流。
// 起因：生产死信里躺着她 4 句话（10-07、10-09），全仓没有任何地方会再捡起它们。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { buildGate } = require("../../src/gate/wire");
const { makeFakeBox } = require("../../src/gate/box");
const { TelegramPlugin } = require("../../src/gate/plugins/telegram");
const { makeTurnQueue } = require("../../src/gate/turn-queue");
const { makeEnvelope } = require("../../src/gate/envelope");
const { registerClaudeCodeCommands } = require("../../src/host/gate-commands-claudecode");
const { makeWatch, inspect } = require("../../src/host/watch");
const { makeWatchNotify } = require("../../src/host/watch-notify");
const { createRemoteRuntime } = require("../../cli-host/client");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(5); }
  return false;
};
const raw = (id, text = "hello", chat = 1) => ({ message_id: id, text, chat: { id: chat, type: "private" }, from: { id: 1 }, date: 1 });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** 一整座桥（真入闸 / 真出闸 / 真队列 / 真命令），盒子可以换成会拒收的。 */
function build({ box = makeFakeBox(), retry = { baseMs: 10, capMs: 40, maxAttempts: 3 } } = {}) {
  const root = tmp("gate-pending-");
  const sent = [];
  const plugin = new TelegramPlugin({ sender: async (x) => { sent.push(x); return "m" + sent.length; }, call: async () => [] });
  const gate = buildGate({ root, coldFile: path.join(root, "cold.jsonl"), files: { gateEnabled: path.join(root, "enabled") },
    identities: { "telegram:1": "owner" }, owner: "owner", box, plugins: { telegram: plugin },
    preferredRoute: { platform: "telegram", chat_id: "1" }, sendGapMs: 0, turnRetry: retry });
  registerClaudeCodeCommands(gate.pipe.commands, { runtime: {}, box, workspaceRoot: root, gateRoot: root,
    pending: gate.pipe.pending });
  const say = (id, text) => gate.pipe.ingest({ channel: "telegram", raw: raw(id, text) });
  const lastText = () => (sent[sent.length - 1] || {}).text || "";
  return { gate, root, sent, say, lastText, box };
}

/** 前 n 次明确拒收（notAccepted），之后照常。 */
function rejectingBox(n, { flag = "notAccepted" } = {}) {
  const box = makeFakeBox({ answer: (e) => "回：" + e.payload.text });
  const original = box.deliver;
  box.attempts = 0;
  box.deliver = async (e) => {
    box.attempts += 1;
    if (box.attempts <= n) throw Object.assign(new Error("nova-cli 不在"), flag ? { [flag]: true } : {});
    return original(e);
  };
  return box;
}

test("拒收后自动退避重投，最终投成功；不进死信、冷层只一条", async () => {
  const box = rejectingBox(2);
  const { gate, root, sent, say } = build({ box });
  const first = await say(1, "在吗");
  assert.equal(first.accepted, true);
  assert.equal(first.state, "rejected");          // 不再抛给收信人
  assert.ok(await until(() => sent.some((s) => s.text === "回：在吗")), "自动重投后他回了");
  assert.equal(box.attempts, 3);
  const row = gate.pipe.tasks()[0];
  assert.equal(row.state, "completed");
  assert.equal(row.attempts, 2);
  const cold = fs.readFileSync(path.join(root, "cold.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(cold.filter((r) => r.role === "user").length, 1);
  assert.equal(fs.existsSync(path.join(root, "dead-telegram.jsonl")), false);
  gate.pipe.stop();
});

test("拒收中排在后面的话不插队：先她第一句，再第二句", async () => {
  const box = rejectingBox(1);
  const { gate, say } = build({ box });
  await say(1, "一");
  await say(2, "二");
  assert.ok(await until(() => gate.pipe.tasks().every((r) => r.state === "completed")));
  assert.deepEqual(box._seen.map((e) => e.payload.text), ["一", "二"]);
  gate.pipe.stop();
});

test("重投次数用完转 unknown（堵住队列），守护报 turn_acceptance_unknown 并推一句人话", async () => {
  const box = rejectingBox(99);
  const { gate, say } = build({ box, retry: { baseMs: 5, capMs: 10, maxAttempts: 3 } });
  await say(1, "第一句");
  assert.ok(await until(() => gate.pipe.tasks()[0].state === "unknown"));
  const row = gate.pipe.tasks()[0];
  assert.equal(row.exhausted, true);
  assert.equal(row.attempts, 3);
  assert.match(row.reason, /连续 3 次明确拒收/);
  // 后面的话被堵住，不越过它
  await say(2, "第二句");
  await sleep(30);
  assert.equal(box.attempts, 3);
  assert.equal(gate.pipe.tasks().find((r) => r.envelope.payload.text === "第二句").state, "queued");
  // 守护：心跳里的 progress → 告警；推送说人话
  const hbFile = path.join(tmp("hb-"), "hb.json");
  fs.writeFileSync(hbFile, JSON.stringify({ at: new Date().toISOString(), upSec: 1, progress: gate.pipe.progress() }));
  const pushed = [];
  const watch = makeWatch({ heartbeatFile: hbFile, notify: makeWatchNotify({ push: async (t) => { pushed.push(t); return true; } }) });
  const r = watch.tick();
  assert.ok(r.issues.some((i) => i.code === "turn_acceptance_unknown" && i.n === 1));
  await sleep(5);
  assert.equal(pushed.length, 1);
  assert.match(pushed[0], /有 1 条消息卡住了.*\/pending/);
  gate.pipe.stop();
});

test("/pending 列出卡住的那条（编号/北京时间/状态/原因/前 20 字），drop 之后队列恢复", async () => {
  const box = rejectingBox(3);
  const { gate, say, sent, lastText } = build({ box, retry: { baseMs: 5, capMs: 10, maxAttempts: 3 } });
  await say(1, "这是一句很长很长的话，用来看前二十个字是不是被截住了");
  assert.ok(await until(() => gate.pipe.tasks()[0].state === "unknown"));
  await say(2, "后面这句");
  await say(3, "/pending");
  const listing = lastText();
  assert.match(listing, /待处理 1 条/);
  assert.match(listing, /#t[0-9a-f]{4} \d{2}:\d{2} 她→他 拒收 3 次，停了等你/);
  assert.match(listing, /「这是一句很长很长的话，用来看前二十个字是…」/);
  assert.match(listing, /原因：盒子连续 3 次明确拒收/);
  // TG 带按钮（测试插头的 sender 不收 extras，看出闸账本里这条回执的 extras）
  const op = gate.outbound.outbox.all().filter((o) => o.payload && /待处理/.test(o.payload.text || "")).pop();
  assert.ok(JSON.stringify(op.payload.extras || {}).includes("/pending drop t"), "TG 带按钮");
  const code = /#(t[0-9a-f]{4})/.exec(listing)[1];
  await say(4, "/pending drop " + code);
  assert.match(lastText(), /放弃了/);
  assert.ok(await until(() => gate.pipe.tasks().find((r) => r.envelope.payload.text === "后面这句").state === "completed"));
  const dropped = gate.pipe.tasks().find((r) => r.id === gate.pipe.tasks()[0].id);
  assert.equal(dropped.state, "failed");
  assert.equal(dropped.dropped, true);
  await say(5, "/pending");
  assert.match(lastText(), /都清了/);
  gate.pipe.stop();
});

test("/pending retry 放行 unknown：重新投给他（她拍板的），队列接着走", async () => {
  const box = rejectingBox(3);
  const { gate, say, sent, lastText } = build({ box, retry: { baseMs: 5, capMs: 10, maxAttempts: 3 } });
  await say(1, "卡住的那句");
  assert.ok(await until(() => gate.pipe.tasks()[0].state === "unknown"));
  await say(2, "/pending");
  const code = /#(t[0-9a-f]{4})/.exec(lastText())[1];
  await say(3, "/pending retry " + code);
  assert.match(lastText(), /重新交给他/);
  assert.ok(await until(() => sent.some((s) => s.text === "回：卡住的那句")));
  assert.equal(gate.pipe.tasks()[0].state, "completed");
  await say(4, "/pending retry " + code);
  assert.match(lastText(), /没有编号/);
  gate.pipe.stop();
});

test("死信 retry：按原件重走入站，投出去一次；再 retry / 原件重放都不重复", async () => {
  const box = makeFakeBox({ answer: (e) => "回：" + e.payload.text });
  const { gate, root, say, sent, lastText } = build({ box });
  // 跟生产那 4 条一个形状（receiver.js 写的死信），同一条进了两次死信
  const dead = { channel: "telegram", cursor: 658800407, error: "nova-cli 没在 60000ms 内回 enqueue", raw: raw(77, "死信里那句") };
  fs.writeFileSync(path.join(root, "dead-telegram.jsonl"),
    JSON.stringify({ at: "2026-10-09T11:38:22.554Z", ...dead }) + "\n" + JSON.stringify({ at: "2026-10-09T11:39:00.000Z", ...dead }) + "\n");
  await say(1, "/pending");
  assert.match(lastText(), /待处理 1 条/);
  assert.match(lastText(), /#d[0-9a-f]{4} 10-9 \d{2}:\d{2} 死信·telegram 进了死信/);
  assert.match(lastText(), /「死信里那句」/);
  const code = /#(d[0-9a-f]{4})/.exec(lastText())[1];
  await say(2, "/pending retry " + code);
  assert.match(lastText(), /已重新交给他/);
  assert.ok(await until(() => sent.filter((s) => s.text === "回：死信里那句").length === 1));
  await say(3, "/pending retry " + code);
  assert.match(lastText(), /没有编号/);
  // 平台把同一条又推一次（nativeId 一样）：入闸去重 + 轮次账本已有结论 → 不再投
  await gate.pipe.ingest({ channel: "telegram", raw: raw(77, "死信里那句") });
  await sleep(20);
  assert.equal(box._seen.filter((e) => e.payload.text === "死信里那句").length, 1);
  const handled = fs.readFileSync(path.join(root, "handled-dead-letters.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(handled.length, 1);
  assert.equal(handled[0].action, "retried");
  gate.pipe.stop();
});

test("死信 retry：那条以前已经处理过（轮次有结论）→ 不再投，只从列表拿掉", async () => {
  const box = makeFakeBox({ answer: (e) => "回：" + e.payload.text });
  const { gate, root, say, lastText } = build({ box });
  await say(5, "早就回过的");
  assert.equal(box._seen.length, 1);
  fs.writeFileSync(path.join(root, "dead-telegram.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), channel: "telegram", cursor: 5, error: "x", raw: raw(5, "早就回过的") }) + "\n");
  await say(6, "/pending");
  const code = /#(d[0-9a-f]{4})/.exec(lastText())[1];
  await say(7, "/pending retry " + code);
  assert.match(lastText(), /以前已经处理过了/);
  assert.equal(box._seen.filter((e) => e.payload.text === "早就回过的").length, 1);
  await say(8, "/pending drop " + code);
  assert.match(lastText(), /没有编号/);
  gate.pipe.stop();
});

test("/status 多一行：卡住 · 拒收待重投 · 死信 · 待核对，有就提示 /pending", async () => {
  const box = rejectingBox(99);
  const { gate, root, say, lastText } = build({ box, retry: { baseMs: 60_000, capMs: 60_000, maxAttempts: 5 } });
  await say(1, "/status");
  assert.match(lastText(), /🧯 卡住 0 · 拒收待重投 0 · 死信 0 · 待核对 0$/m);
  await say(2, "被拒的");
  fs.writeFileSync(path.join(root, "dead-telegram.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), channel: "telegram", cursor: 9, error: "x", raw: raw(9, "死信") }) + "\n");
  gate.undelivered.note({ state: "unknown", operationId: "op-x", text: "他说的", channel: "telegram", chatId: "1" });
  await say(3, "/status");
  assert.match(lastText(), /🧯 卡住 0 · 拒收待重投 1 · 死信 1 · 待核对 1（发 \/pending 看）/);
  gate.pipe.stop();
});

test("undelivered：not_sent 用同一个操作号重发；unknown drop 后不再列", async () => {
  const box = makeFakeBox({ answer: () => null });
  const { gate, say, sent, lastText } = build({ box });
  // 让出闸第一次发失败（确定没出去）
  const plugin = gate.outbound.plugins.get("telegram");
  const realSend = plugin.send.bind(plugin);
  let fail = true;
  plugin.send = async (x) => { if (fail) { fail = false; throw Object.assign(new Error("429"), { notSent: true }); } return realSend(x); };
  await gate.outbound.deliver({ turnId: "t1", operationId: "op-1", outputId: "op-1", replyToEventId: "e1",
    inboundEvent: { eventId: "e1", channel: "telegram", chatId: "1" }, text: "没发出去那句" });
  gate.undelivered.note({ state: "unknown", operationId: "op-2", text: "不知道发没发", channel: "telegram", chatId: "1" });
  await say(1, "/pending");
  const L = lastText();
  assert.match(L, /他→她 没发出去/);
  assert.match(L, /他→她 不知道发没发/);
  const codes = [...L.matchAll(/#(u[0-9a-f]{4})[^\n]*\n\s+「([^」]*)」/g)].map((m) => ({ code: m[1], text: m[2] }));
  const ns = codes.find((c) => c.text === "没发出去那句").code;
  const un = codes.find((c) => c.text === "不知道发没发").code;
  const before = sent.length;
  await say(2, "/pending retry " + ns);
  assert.ok(sent.slice(before).some((s) => s.text === "没发出去那句" && s.operationId === "op-1"));
  await say(3, "/pending drop " + un);
  await say(4, "/pending");
  assert.match(lastText(), /都清了/);
  gate.pipe.stop();
});

test("whenReady 超时：抛 notAccepted（一个字节没写出去），队列当拒收自动重投", async () => {
  const dir = tmp("cli-ready-");
  const rt = createRemoteRuntime({ socketPath: path.join(dir, "nobody.sock"), ingressPath: path.join(dir, "ingress.json"),
    readyTimeoutMs: 30, reconnectMs: 5, maxReconnectMs: 10 });
  const err = await rt.enqueue({ uuid: "u1" }).catch((e) => e);
  assert.equal(err.notAccepted, true);
  assert.equal(err.code, "ENGINE_HOST_NOT_READY");
  assert.notEqual(err.maybeAccepted, true);
  // 队列这头：这种错 = rejected + 退避重投，不是 unknown 堵死
  let calls = 0;
  const box = { onReply() {}, onTurnDone(fn) { box.done = fn; },
    async deliver(e) { calls += 1; if (calls === 1) await rt.enqueue({ uuid: "u2" }); return { turnId: "t-" + e.trace_id, threadId: "th" }; } };
  const q = makeTurnQueue({ file: path.join(dir, "turns.json"), box, onReply: async () => {}, onDone: async () => {},
    retry: { baseMs: 5, capMs: 5, maxAttempts: 3 } });
  const env = makeEnvelope({ trace_id: "x1", source: { kind: "system" }, payload: { text: "hi" } });
  await q.submit(env, { ok: true, target: { platform: "telegram", chat_id: "1" } }).catch(() => {});
  assert.equal(q.store.get("x1").state, "rejected");
  assert.ok(await until(() => q.store.get("x1").state === "accepted"));
  assert.equal(calls, 2);
  q.stop();
  rt.dispose();
});

test("请求已写出去后超时：maybeAccepted，不打 notAccepted（避免自动重投回两遍）", async () => {
  const dir = tmp("cli-sent-");
  const sock = path.join(dir, "cli.sock");
  const conns = [];
  const server = net.createServer((c) => { conns.push(c); /* 收下，永远不回 */ });
  await new Promise((r) => server.listen(sock, r));
  const rt = createRemoteRuntime({ socketPath: sock, ingressPath: path.join(dir, "ingress.json"), callTimeoutMs: 40 });
  const err = await rt.enqueue({ uuid: "u1" }).catch((e) => e);
  assert.equal(err.maybeAccepted, true);
  assert.notEqual(err.notAccepted, true);
  rt.dispose();
  for (const c of conns) c.destroy();
  server.close();
});

test("守护推送节流：同一类 1 小时内只推一次；没配推送只写日志", async () => {
  let t = 0;
  const pushed = [];
  const logs = [];
  const notify = makeWatchNotify({ push: async (x) => { pushed.push(x); return true; }, log: (m) => logs.push(m), now: () => t });
  const issue = (code, n = 1) => ({ issues: [{ code, n, text: code }] });
  notify("a", issue("turn_acceptance_unknown"));
  t = 30 * 60_000; notify("b", issue("turn_acceptance_unknown"));
  t = 59 * 60_000; notify("c", issue("turn_acceptance_unknown"));
  notify("d", issue("in_no_out", 2));                 // 另一类不受影响
  t = 61 * 60_000; notify("e", issue("turn_acceptance_unknown"));
  notify("f", issue("restarted"));                    // 没有人话模板的类别不推
  await sleep(5);
  assert.equal(pushed.length, 3);
  assert.match(pushed[0], /有 1 条消息卡住了/);
  assert.match(pushed[1], /有 2 条消息等了好几分钟/);
  assert.equal(logs.length, 6, "每次都写日志");
  const quiet = [];
  makeWatchNotify({ push: null, log: (m) => quiet.push(m) })("x", issue("turn_acceptance_unknown"));
  assert.deepEqual(quiet, ["x"]);
  // inspect 结构化：带条数
  const r = inspect({ now: Date.now(), hb: { at: new Date().toISOString(), progress: { pending: 0, unknown: 2, unknownRows: [] } } });
  assert.equal(r.issues.find((i) => i.code === "turn_acceptance_unknown").n, 2);
});
