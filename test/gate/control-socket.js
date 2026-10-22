"use strict";
/**
 * 本机控制口（2026-10-22）—— 面板按「换舱」= 她在 TG 发 /new，同一条路
 *
 * 真零件：真主循环、真命令表、真出闸、真路由；只有盒子是假的。
 * 盯的是：①控制口跑的就是命令表里那个 /new（同一个处理函数、同一个收尾 → 换舱顺序）
 *         ②以主人身份、回执推到她手机 ③白名单外的、不是命令的一律不收 ④socket 0600
 */
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { makePipeline } = require("../../src/gate/pipeline");
const { GateStore } = require("../../src/gate/store");
const { ColdWriter } = require("../../src/gate/cold-writer");
const { InboundGate } = require("../../src/gate/inbound");
const { OutboundGate } = require("../../src/gate/outbound");
const { TelegramPlugin } = require("../../src/gate/plugins/telegram");
const { makeFakeBox } = require("../../src/gate/box");
const { makeRouter } = require("../../src/gate/routing");
const { makeControlSocket } = require("../../src/gate/control-socket");

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : "  " + extra)); ok ? pass++ : fail++; };

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-ctl-"));
const HER = "1000000001";
const tgMsg = (id, text) => ({ message_id: id, text, chat: { id: Number(HER), type: "private" }, from: { id: Number(HER) }, date: Math.floor(Date.now() / 1000) });

function build(dir) {
  const store = new GateStore({ root: path.join(root, dir) });
  const cold = new ColdWriter({ file: path.join(root, dir, "cold.jsonl") });
  const sent = [];
  const plugin = new TelegramPlugin({ sender: async ({ chatId, text }) => { sent.push({ chatId, text }); return "m" + sent.length; }, call: async () => [] });
  const plugins = new Map([["telegram", plugin]]);
  const inbound = new InboundGate({ store, cold, identities: { ["telegram:" + HER]: "alice" } });
  const outbound = new OutboundGate({ store, cold, plugins });
  const order = [];
  const box = makeFakeBox({ answer: (env) => { order.push("收尾轮:" + String(env.payload.text).slice(0, 4)); return null; } });
  const rawRotate = box.rotate;
  box.rotate = async (o) => { order.push("换舱:" + (o && o.reason)); return rawRotate(o); };
  const router = makeRouter({ preferred: { platform: "telegram", chat_id: HER } });
  const pipe = makePipeline({ plugins, inbound, outbound, box, router, log: () => {}, closingNote: () => "收个尾吧" });
  return { pipe, sent, box, order };
}

function ask(file, req) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(file);
    let buf = "";
    s.on("connect", () => s.write(JSON.stringify(req) + "\n"));
    s.on("data", (d) => { buf += d; const i = buf.indexOf("\n"); if (i >= 0) { s.destroy(); resolve(JSON.parse(buf.slice(0, i))); } });
    s.on("error", reject);
  });
}

(async () => {
  console.log("[1] TG 发 /new 和控制口按 /new：同一张命令表、同一个处理函数");
  {
    const { pipe } = build("a");
    const calls = [];
    // 把命令表里的 new 换成探针：两条路要是都走它，就证明是同一个入口
    pipe.commands.register("new", async ({ rest }) => { calls.push(rest); return { text: "探针换好了" }; }, { desc: "探针" });
    await pipe.ingest({ channel: "telegram", raw: tgMsg(1, "/new 从TG") });
    const r = await pipe.runOwnerCommand("/new 从面板", { by: "panel" });
    check("两条路都进了同一个处理函数", JSON.stringify(calls) === JSON.stringify(["从TG", "从面板"]), JSON.stringify(calls));
    check("控制口的回执", r.ok && r.command === "new" && r.text === "探针换好了", JSON.stringify(r));
  }

  console.log("\n[2] 真的 /new：先收尾轮、再换舱；回执推到她 TG");
  {
    const { pipe, sent, box, order } = build("b");
    const r = await pipe.runOwnerCommand("/new 她在面板上按的", { by: "panel" });
    check("顺序：收尾轮 → 换舱", order.length === 2 && order[0].startsWith("收尾轮") && order[1] === "换舱:她在面板上按的", JSON.stringify(order));
    check("换成了新舱", box._rotations() === 1 && r.ok && /新舱 fake-thread-2/.test(r.text), r.text);
    check("回执推到她 TG（跟 TG /new 回的同一句）", sent.length === 1 && sent[0].chatId === HER && sent[0].text === r.text, JSON.stringify(sent));
  }

  console.log("\n[3] 控制口：只收白名单、以主人身份、socket 0600");
  {
    const { pipe, box } = build("c");
    const file = path.join(root, "c", "control.sock");
    const seen = [];
    const ctl = makeControlSocket({ file, owner: "alice", parse: (t) => pipe.commands.match(t),
      run: (text, opts) => { seen.push({ text, by: opts.by }); return pipe.runOwnerCommand(text, opts); } });
    await ctl.start();
    check("socket 0600", (fs.statSync(file).mode & 0o777) === 0o600, (fs.statSync(file).mode & 0o777).toString(8));
    const r = await ask(file, { id: "x", op: "command", text: "/new 面板手动换舱", by: "panel", waitMs: 3000 });
    check("回同一个 id", r.id === "x");
    check("跑完了：done", r.ok && r.job.state === "done" && /换好了/.test(r.job.text), JSON.stringify(r));
    check("以主人身份", r.job.as === "alice" && r.job.command === "new");
    check("真的进了 /new（换了一次舱）", box._rotations() === 1 && seen[0].text === "/new 面板手动换舱" && seen[0].by === "panel");
    const st = await ask(file, { id: "y", op: "status", job: r.job.id });
    check("status 查得到", st.ok && st.job.state === "done");
    let modelRan = false;
    pipe.commands.register("model", async () => { modelRan = true; return { text: "换了模型" }; });
    pipe.commands.register("stop", async () => ({ text: "停了" }));
    const bad1 = await ask(file, { op: "command", text: "/stop" });
    check("白名单外的命令（/stop，桥认识）不收", !bad1.ok && /不收/.test(bad1.error), JSON.stringify(bad1));
    const bad2 = await ask(file, { op: "command", text: "想你了" });
    check("不是命令的话不收（不进盒子）", !bad2.ok && box._seen.every((e) => e.payload.text !== "想你了"), JSON.stringify(bad2));
    const bad3 = await ask(file, { op: "command", text: "/undo ok" });
    check("/undo 也不收", !bad3.ok);
    const bad4 = await ask(file, { op: "status", job: "j-nope" });
    check("不认识的任务号", !bad4.ok);
    check("盒子只换过那一次", box._rotations() === 1);
    console.log("\n[3b] /model /engine 的参数：只收登记表里的一个 id");
    const known = new Set(["model-a", "claude-x[1m]"]);
    const f2 = path.join(root, "c", "control2.sock");
    const ctl2 = makeControlSocket({ file: f2, owner: "alice", parse: (t) => pipe.commands.match(t),
      validate: (name, rest) => ((name === "model" || name === "engine") && !known.has(rest) ? `登记表里没有「${rest}」` : ""),
      run: (text, opts) => pipe.runOwnerCommand(text, opts) });
    await ctl2.start();
    for (const [t, why] of [["/model", "没给 id"], ["/model model-a now", "多带了词"], ["/model model-a; rm -rf /", "带了别的字符"],
      ["/model 不在表里的", "非登记表 id"], ["/model nope-9", "非登记表 id（格式对）"], ["/engine x\ny", "换行"], ["/new " + "长".repeat(81), "理由太长"], ["/new 第一行\n第二行", "理由换行"]]) {
      const x = await ask(f2, { op: "command", text: t });
      check(`拒：${why}`, !x.ok, JSON.stringify(x));
    }
    check("被拒的都没跑", !modelRan);
    const okm = await ask(f2, { op: "command", text: "/model claude-x[1m]", waitMs: 2000 });
    check("登记表里的 id（带 [1m]）→ 收、跑了 /model", okm.ok && okm.job.state === "done" && modelRan, JSON.stringify(okm));
    const seqBad = await ask(f2, { op: "command", texts: ["/model model-a", "/new"] });
    check("串只认 /new → /model（反过来不收）", !seqBad.ok);
    const seq3 = await ask(f2, { op: "command", texts: ["/new", "/model model-a", "/new"] });
    check("串最多 2 条", !seq3.ok);
    await ctl2.stop();
    await ctl.stop();
    check("停了之后 socket 文件删掉", !fs.existsSync(file));
  }

  console.log("\n[4] 慢的 /new：先回「在排队 / 正在换」，结果另查");
  {
    const { pipe } = build("d");
    let release;
    pipe.commands.register("new", async () => { await new Promise((r) => { release = r; }); return { text: "慢慢换好了" }; });
    const file = path.join(root, "d", "control.sock");
    const ctl = makeControlSocket({ file, owner: "alice", run: (t, o) => pipe.runOwnerCommand(t, o) });
    await ctl.start();
    const r = await ask(file, { op: "command", text: "/new", waitMs: 200 });
    check("没跑完先回 running", r.ok && r.job.state === "running", JSON.stringify(r.job));
    release();
    await new Promise((r2) => setTimeout(r2, 50));
    const st = await ask(file, { op: "status", job: r.job.id });
    check("跑完之后 status = done", st.job.state === "done" && st.job.text === "慢慢换好了");
    await ctl.stop();
  }

  console.log("\n[5] 一串：/new 再 /model —— 同一个串行道位置连着跑，前一条没成后一条不跑");
  {
    const { pipe, sent, order } = build("e");
    pipe.commands.register("model", async ({ rest }) => { order.push("模型:" + rest); return { text: "换成 " + rest + " 了。下一轮生效。" }; });
    const r = await pipe.runOwnerCommand(["/new 面板", "/model m2"], { by: "panel" });
    check("顺序：收尾轮 → 换舱 → 换模型", order.length === 3 && order[0].startsWith("收尾轮") && order[1] === "换舱:面板" && order[2] === "模型:m2", JSON.stringify(order));
    check("两步都成、回执两条都到她 TG", r.ok && r.steps.length === 2 && sent.length === 2 && /换好了/.test(sent[0].text) && /换成 m2/.test(sent[1].text), JSON.stringify(sent));
    const p2 = build("f");
    let modelRan = false;
    p2.pipe.commands.register("new", async () => ({ ok: false, text: "换舱没成" }));
    p2.pipe.commands.register("model", async () => { modelRan = true; return { text: "x" }; });
    const r2 = await p2.pipe.runOwnerCommand(["/new", "/model m2"], { by: "panel" });
    check("/new 没成 → /model 不跑，回执说清", !r2.ok && !modelRan && r2.steps[1].skipped === true, JSON.stringify(r2.steps));
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
