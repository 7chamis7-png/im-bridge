"use strict";
/**
 * Commands.
 *
 * Most important guard: an unregistered slash-prefixed message is plain text.
 * A message like `/hello` must never be swallowed by the bridge just because it
 * starts with a slash — that kind of silent loss is the hardest to debug.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { makeCommands, parse } = require("../../src/gate/commands");
const { makePipeline } = require("../../src/gate/pipeline");
const { GateStore } = require("../../src/gate/store");
const { ColdWriter } = require("../../src/gate/cold-writer");
const { InboundGate } = require("../../src/gate/inbound");
const { OutboundGate } = require("../../src/gate/outbound");
const { TelegramPlugin } = require("../../src/gate/plugins/telegram");
const { makeFakeBox } = require("../../src/gate/box");
const { makeRouter } = require("../../src/gate/routing");

let pass = 0, fail = 0;
const check = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-cmd-"));
const OWNER = "10001";
const tgMsg = (id, text) => ({
  message_id: id, text, chat: { id: Number(OWNER), type: "private" },
  from: { id: Number(OWNER) }, date: Math.floor(Date.now() / 1000),
});

function build(dir, answer = () => "嗯") {
  const store = new GateStore({ root: path.join(root, dir) });
  const cold = new ColdWriter({ file: path.join(root, dir, "cold.jsonl") });
  const sent = [];
  const plugin = new TelegramPlugin({
    sender: async ({ chatId, text }) => { sent.push({ chatId, text }); return "m"; },
    call: async () => [],
  });
  const plugins = new Map([["telegram", plugin]]);
  const box = makeFakeBox({ answer });
  const pipe = makePipeline({
    plugins,
    inbound: new InboundGate({ store, cold, identities: { ["telegram:" + OWNER]: "owner" } }),
    outbound: new OutboundGate({ store, cold, plugins }),
    box,
    router: makeRouter({ preferred: { platform: "telegram", chat_id: OWNER } }),
    log: () => {},
  });
  return { pipe, sent, box, coldFile: path.join(root, dir, "cold.jsonl") };
}

(async () => {
  console.log("[1] 认得出命令的形状");
  check("/new", parse("/new"), { name: "new", rest: "" });
  check("带参数", parse("/model opus 5"), { name: "model", rest: "opus 5" });
  check("普通话不是命令", parse("在吗"), null);
  check("光一个斜杠不算", parse("/"), null);

  console.log("\n[2] **没注册过的斜杠开头，一律当正文**（/你好 不许被吞）");
  {
    const { pipe, sent, box } = build("a", (e) => "收到：" + e.payload.text);
    const r = await pipe.ingest({ channel: "telegram", raw: tgMsg(1, "/你好") });
    check("当成正常一句话", r.accepted && !r.command, true);
    check("**进了盒子**", box._seen.length, 1);
    check("agent 回了", sent.map((s) => s.text), ["收到：/你好"]);
  }

  console.log("\n[2.5] 整合后桥自带的就三条（别的归宿主）");
  {
    const { pipe } = build("a2");
    check("只有 new / status / help", pipe.commands.names().sort(), ["help", "new", "status"]);
  }

  console.log("\n[3] 桥自己那几条：拦下来，不送进盒子");
  {
    const { pipe, sent, box } = build("b");
    const r = await pipe.ingest({ channel: "telegram", raw: tgMsg(2, "/status") });
    check("认成命令", r.command, "status");
    check("**没进盒子**（那不是跟 agent 说的话）", box._seen.length, 0);
    check("回执发回 owner 了", sent.length, 1);
    check("回执一眼看清现状", /水位|进来/.test(sent[0].text), true);
    // Last real receive / send per leg. A command does not count as "received"
    // (it never reaches the box), so send a real message first.
    check("还没真收过：不报那两行", /最后收到/.test(sent[0].text), false);
    await pipe.ingest({ channel: "telegram", raw: tgMsg(21, "在吗") });
    const again = await pipe.ingest({ channel: "telegram", raw: tgMsg(22, "/status") });
    const last = sent[sent.length - 1].text;
    check("第二次 /status：最后收到 telegram HH:mm", again.command === "status" && /👂 最后收到 .*telegram \d{2}:\d{2}/.test(last), true);
    check("第二次 /status：最后发出 telegram HH:mm", /📤 最后发出 .*telegram \d{2}:\d{2}/.test(last), true);
  }

  console.log("\n[4] /new 真去开新舱");
  {
    const { pipe, sent, box } = build("c");
    const before = box._rotations();
    const r = await pipe.ingest({ channel: "telegram", raw: tgMsg(3, "/new 太满了") });
    check("认成命令", r.command, "new");
    check("真换了舱", box._rotations() - before, 1);
    check("回执里有新舱号", /换好了/.test(sent[0].text), true);
  }

  console.log("\n[5] 命令不进对话冷层");
  {
    const { pipe, coldFile } = build("d");
    await pipe.ingest({ channel: "telegram", raw: tgMsg(4, "/status") });
    const rows = fs.existsSync(coldFile)
      ? fs.readFileSync(coldFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    check("冷层里没有 /status 这条", rows.some((x) => x.text === "/status"), false);
  }

  console.log("\n[6] 宿主可以注册自己的命令 —— 桥不认识它们叫什么");
  {
    const { pipe, sent } = build("e");
    pipe.commands.register("diary", async ({ rest }) => ({ text: "日记记下了：" + rest }), { desc: "记一笔" });
    const r = await pipe.ingest({ channel: "telegram", raw: tgMsg(5, "/diary 今天很累") });
    check("宿主的命令也认", r.command, "diary");
    check("参数传进去了", /今天很累/.test(sent[0].text), true);
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "src", "gate", "commands.js"), "utf8");
    check("**桥的代码里没有 diary 这个名字**", /diary/i.test(src), false);
  }

  console.log("\n[6.5] 命令能带按钮 —— /model 弹选单，按一下就换");
  {
    const calls = [];
    const store = new GateStore({ root: path.join(root, "btn") });
    const cold = new ColdWriter({ file: path.join(root, "btn", "cold.jsonl") });
    // Any token: a TG leg without one reports offline and outbound blocks it (call is faked)
    const plugin = new TelegramPlugin({ token: "test", call: async (m, p) => { calls.push([m, p]); return m === "sendMessage" ? { message_id: 1 } : []; } });
    const plugins = new Map([["telegram", plugin]]);
    const pipe = makePipeline({ plugins,
      inbound: new InboundGate({ store, cold, identities: { ["telegram:" + OWNER]: "owner" } }),
      outbound: new OutboundGate({ store, cold, plugins }),
      box: makeFakeBox({ answer: () => "嗯" }),
      router: makeRouter({ preferred: { platform: "telegram", chat_id: OWNER } }), log: () => {} });
    const set = [];
    const runtime = { describe: () => ({ model: "claude-opus-5-5[1m]" }),
      setModelForWorkspace: async ({ model }) => { set.push(model); } };
    require("../../src/host/gate-commands-claudecode").registerClaudeCodeCommands(pipe.commands,
      { runtime, box: { fullness: () => ({ model: "claude-opus-5-5" }) }, workspaceRoot: "/tmp/ws" });
    await pipe.ingest({ channel: "telegram", raw: tgMsg(50, "/model") });
    const sm = calls.filter(([m]) => m === "sendMessage").pop()[1];
    check("实际裸名 vs 请求带 [1m]：不误报「没给到」", /没给到/.test(sm.text), false);
    const kb = (sm.reply_markup && sm.reply_markup.inline_keyboard || []).map((r) => r[0]);
    check("回执真带了按钮（接线层：命令→出口→TG 腿）", kb.length >= 3, true);
    check("当前请求的那个打了勾", kb.some((b) => b.text.startsWith("✓ ") && b.callback_data === "/model claude-opus-5-5[1m]"), true);
    check("每个按钮都带 [1m]", kb.every((b) => b.callback_data.endsWith("[1m]")), true);
    check("callback_data ≤ 64 字节", kb.every((b) => Buffer.byteLength(b.callback_data) <= 64), true);
    // A button tap arrives as the command text itself
    const r = await pipe.ingest({ channel: "telegram", raw: { ...tgMsg(51, kb[0].callback_data), message_id: "200-btn-x" } });
    check("按钮这句被当成 /model 命令", r.command, "model");
    check("真换了", set, [kb[0].callback_data.replace("/model ", "")]);
  }

  console.log("\n[7] 命令炸了要如实说，不许伪装成成功");
  {
    const { pipe, sent } = build("f");
    pipe.commands.register("boom", async () => { throw new Error("我炸了"); });
    const r = await pipe.ingest({ channel: "telegram", raw: tgMsg(6, "/boom") });
    check("报了不成功", r.ok, false);
    check("回执说得出为什么", /没执行成功|我炸了/.test(sent[0].text), true);
  }

  console.log("\n[8] 陌生人发命令：入闸先挡，轮不到命令层");
  {
    const { pipe, sent, box } = build("g");
    const stranger = { ...tgMsg(7, "/new"), from: { id: 999 }, chat: { id: 999, type: "private" } };
    const r = await pipe.ingest({ channel: "telegram", raw: stranger });
    // The command layer runs before inbound checks; strangers' commands must not execute
    check("没执行（换舱这种事陌生人碰不到）", box._rotations(), 0);
    check("也没回执给陌生人", sent.length, 0);
    check("入闸挡下了", r.accepted, false);
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}   (隔离目录 ${root})`);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
