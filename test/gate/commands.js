"use strict";
/**
 * 命令（2026-09-18）
 *
 * 最要紧的一条守卫：**没注册过的斜杠开头，一律当正文**。
 * 她发 `/想你了`、`/抱抱`、`/滚`，绝不能因为开头有个斜杠就被桥吞掉 ——
 * 那种消失最难查，她会以为他不理她。
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
const HER = "1000000001";
const tgMsg = (id, text) => ({
  message_id: id, text, chat: { id: Number(HER), type: "private" },
  from: { id: Number(HER) }, date: Math.floor(Date.now() / 1000),
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
    inbound: new InboundGate({ store, cold, identities: { ["telegram:" + HER]: "alice" } }),
    outbound: new OutboundGate({ store, cold, plugins }),
    box,
    router: makeRouter({ preferred: { platform: "telegram", chat_id: HER } }),
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

  console.log("\n[2] **没注册过的斜杠开头，一律当正文**（她发 /想你了 不许被吞）");
  {
    const { pipe, sent, box } = build("a", (e) => "收到：" + e.payload.text);
    const r = await pipe.ingest({ channel: "telegram", raw: tgMsg(1, "/想你了") });
    check("当成正常一句话", r.accepted && !r.command, true);
    check("**进了盒子**", box._seen.length, 1);
    check("他回了", sent.map((s) => s.text), ["收到：/想你了"]);
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
    check("**没进盒子**（那不是跟他说的话）", box._seen.length, 0);
    check("回执发回她了", sent.length, 1);
    check("回执一眼看清现状", /水位|进来/.test(sent[0].text), true);
    // 每条腿最后一次真收 / 真发（9-21）。命令本身不算「收到」（它没进盒子），
    // 所以先来一句真话让他回一次，再看 /status 两行时间都在
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

  console.log("\n[6.5] 命令能带按钮 —— /model 弹选单，按一下就换（2026-09-23）");
  {
    const calls = [];
    const store = new GateStore({ root: path.join(root, "btn") });
    const cold = new ColdWriter({ file: path.join(root, "btn", "cold.jsonl") });
    // token 随便给一个：没 token 的 TG 腿自报 offline，出闸会拦下（call 已经换成假的，不会真打出去）
    const plugin = new TelegramPlugin({ token: "test", call: async (m, p) => { calls.push([m, p]); return m === "sendMessage" ? { message_id: 1 } : []; } });
    const plugins = new Map([["telegram", plugin]]);
    const pipe = makePipeline({ plugins,
      inbound: new InboundGate({ store, cold, identities: { ["telegram:" + HER]: "alice" } }),
      outbound: new OutboundGate({ store, cold, plugins }),
      box: makeFakeBox({ answer: () => "嗯" }),
      router: makeRouter({ preferred: { platform: "telegram", chat_id: HER } }), log: () => {} });
    const set = [];
    const runtime = { describe: () => ({ model: "claude-opus-5-5[1m]", engine: "claude-cli" }),
      setModelForWorkspace: async ({ model }) => { set.push(model); } };
    // 2026-10-21 S5：按钮从 $GATE_ROOT/models.json 来（不再写死），只列当前引擎下的
    const regRoot = path.join(root, "btn-reg"); fs.mkdirSync(regRoot, { recursive: true });
    fs.writeFileSync(path.join(regRoot, "models.json"), JSON.stringify({ v: 1, default: "claude-fable-5[1m]", models: [
      { id: "claude-fable-5[1m]", engine: "claude-cli", window: 1000000, billing: "subscription" },
      { id: "claude-fable-5-1[1m]", engine: "claude-cli", window: 1000000, billing: "subscription" },
      { id: "claude-opus-5-5[1m]", engine: "claude-cli", window: 1000000, billing: "subscription" },
      { id: "gpt-5.6-sol", engine: "codex-appserver", window: 872000, billing: "subscription" },
    ] }));
    require("../../src/host/gate-commands-claudecode").registerClaudeCodeCommands(pipe.commands,
      { runtime, box: { fullness: () => ({ model: "claude-opus-5-5" }) }, workspaceRoot: "/tmp/ws", gateRoot: regRoot });
    await pipe.ingest({ channel: "telegram", raw: tgMsg(50, "/model") });
    const sm = calls.filter(([m]) => m === "sendMessage").pop()[1];
    check("实际裸名 vs 请求带 [1m]：不误报「没给到」", /没给到/.test(sm.text), false);
    const kb = (sm.reply_markup && sm.reply_markup.inline_keyboard || []).map((r) => r[0]);
    check("回执真带了按钮（接线层：命令→出口→TG 腿）", kb.length >= 3, true);
    check("当前请求的那个打了勾", kb.some((b) => b.text.startsWith("✓ ") && b.callback_data === "/model claude-opus-5-5[1m]"), true);
    check("每个按钮都带 [1m]", kb.every((b) => b.callback_data.endsWith("[1m]")), true);
    check("别家的（codex）不在 /model 的按钮里", kb.some((b) => /gpt-/.test(b.callback_data)), false);
    check("callback_data ≤ 64 字节", kb.every((b) => Buffer.byteLength(b.callback_data) <= 64), true);
    // 按一下 = TG 腿交出来的就是那条命令原文
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
    // 命令层在入闸之前跑，所以这里要确认：陌生人的命令**不执行**
    check("没执行（换舱这种事陌生人碰不到）", box._rotations(), 0);
    check("也没回执给陌生人", sent.length, 0);
    check("入闸挡下了", r.accepted, false);
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}   (隔离目录 ${root})`);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
