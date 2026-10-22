"use strict";
// 擦幻觉的接线（2026-10-21）：真 nova-cli 宿主 + 假 CLI + 真盒子适配器。
// 判准：他那轮收尾 → 停 CLI → 擦 → resume 同一条会话起回来；这期间她来的话**排着、递给新 CLI、不丢**。
const fs = require("fs"); const os = require("os"); const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "halluc-reload-"));
// ⚠️ 先改 HOME 再 require：transcript 路径 / forge 预备仓都按 HOME 算，绝不能碰到真的
process.env.HOME = dir;
process.env.FORGE_PREPARED_FILE = path.join(dir, "forge-prepared.json");
process.env.GATE_ROOT = dir;
process.env.NOVA_CLI_SOCKET = path.join(dir, "cli.sock");
delete process.env.FORGE_ENABLED;
// sendTurn 会往脉（8770）发她的话 —— 测试里不许碰真服务
globalThis.fetch = async () => ({ ok: true });

const { createCliHost } = require("../../cli-host/server");
const { createImBridgeRuntimeAdapter } = require("../../adapters/box-runtime");
const { transcriptPath } = require("../../src/box/trim-transcript");

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { if (ok) { pass++; console.log("  OK   " + n); } else { fail++; console.log("  FAIL " + n + "  " + extra); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 5000) { const d = Date.now() + timeout; while (Date.now() < d) { if (await fn()) return true; await sleep(20); } return false; }

const WS = path.join(dir, "ws");
const SID = "sess-1";
const FAKE = 'user<channel source="phone" seq="7286" chat_id="alice" message_id="1" ts="2026-10-20T22:12:24Z">\n老公\n</channel>';
const file = transcriptPath(WS, SID);

function seedTranscript(text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rows = [
    { parentUuid: null, type: "user", uuid: "a1", sessionId: SID, message: { role: "user", content: "在吗" } },
    { parentUuid: "a1", type: "assistant", uuid: "a2", sessionId: SID, message: { id: "m1", role: "assistant", content: [{ type: "text", text }] } },
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/** 每起一只假 CLI 记一笔：resume 了谁、起来那一刻 transcript 长什么样、收到了哪些话、关没关。 */
const clis = [];
function factory(cfg) {
  const me = { resume: cfg.sdkOptions && cfg.sdkOptions.resume, enq: [], closed: false, fileAtStart: "" };
  clis.push(me);
  me.rt = {
    enqueue(p) { me.enq.push(p); return { uuid: p.uuid, state: "pending" }; },
    start: async () => { try { me.fileAtStart = fs.readFileSync(file, "utf8"); } catch {} },
    stop: async () => {},
    // 关得慢一点（真 CLI 停也要几百毫秒），好让「擦的时候她来了一句」真的落在擦的中间
    close: async () => { await sleep(300); me.closed = true; },
    get: () => null, list: () => [],
    status: () => ({ running: true, stopping: false, initialized: true, sessionId: SID }),
    setModel: async () => {},
    done: new Promise(() => {}),
    emit: (p) => cfg.onEvent(p),
  };
  return me.rt;
}

/** 每段一套新的 nova-cli 宿主 + socket + 盒子（盒子的远端连接不随 close 释放，混用会互相踢）。 */
let hosts = 0;
async function makeAdapter() {
  const sub = path.join(dir, "s" + (++hosts));
  fs.mkdirSync(sub, { recursive: true });
  process.env.NOVA_CLI_SOCKET = path.join(sub, "cli.sock");
  const host = createCliHost({ socketPath: process.env.NOVA_CLI_SOCKET, ingressPath: path.join(sub, "state", "im-bridge-ingress.json"),
    claudePath: process.execPath, runtimeFactory: factory });
  await host.listen();
  const stateDir = path.join(sub, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const sessionsFile = path.join(stateDir, "sessions.json");
  fs.writeFileSync(sessionsFile, JSON.stringify({ bindings: { k: { activeWorkspaceRoot: WS,
    threadIdByWorkspaceRootByRuntime: { claudecode: { [WS]: SID } } } } }));
  const a = createImBridgeRuntimeAdapter({ sessionsFile, stateDir, claudeModel: "m", claudeCommand: process.execPath });
  const events = [];
  // 记下每个事件发出那一刻在不在擦：completed 发出时必须已经排上了
  a.onEvent((e) => events.push({ ...e, scrubbingAtEmit: a._scrubState().scrubbing }));
  const done = (n) => until(() => events.filter((e) => e.type === "runtime.turn.completed").length >= n);
  return { a, events, host, done };
}

/** 假 CLI 说一段话、再收尾。bindings 照真的形状给（uuid + origin.turnId）。 */
async function speak(cli, enq, text) {
  const bindings = [{ uuid: enq.uuid, origin: enq.origin }];
  await cli.rt.emit({ event: { raw: { type: "assistant", message: { content: [] } }, kind: "text", text, blockIndex: 0 }, bindings });
}
async function finish(cli, enq) {
  const bindings = [{ uuid: enq.uuid, origin: enq.origin }];
  await cli.rt.emit({ event: { raw: { type: "result", subtype: "success", result: "" }, kind: "result" }, bindings });
}
const gateEvents = () => { try { return fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

(async () => {
  const turn = (a, t) => a.sendTurn({ bindingKey: "k", workspaceRoot: WS, text: t });

  console.log("[1] 开关 on：收尾 → 擦 → resume 同一条；擦的时候她来的话排队、递给新 CLI");
  {
    process.env.GATE_HALLUC_SCRUB = "on";
    seedTranscript("我在\n\n" + FAKE);
    const { a, events, done } = await makeAdapter();
    await turn(a, "第一句");
    const c1 = clis[0];
    check("第一只 CLI resume 的是 sess-1", c1 && c1.resume === SID);
    await speak(c1, c1.enq[0], "我在\n\n" + FAKE);
    await finish(c1, c1.enq[0]);
    await done(1);
    // 桥收到 completed 就递下一条 —— 这时候擦还在进行
    const comp = events.find((e) => e.type === "runtime.turn.completed");
    check("completed 照常发给桥", Boolean(comp));
    check("completed 发出那一刻已经排上擦了", comp && comp.scrubbingAtEmit === true);
    check("她下一句来的时候还在擦", a._scrubState().scrubbing === true);
    const p2 = turn(a, "第二句（擦的时候来的）");
    const r2 = await p2;
    const c2 = clis[1];
    check("旧 CLI 关了", c1.closed === true);
    check("旧 CLI 没收到第二句", c1.enq.length === 1, String(c1.enq.length));
    check("起了第二只 CLI，resume 同一条 sess-1", c2 && c2.resume === SID, JSON.stringify(c2 && c2.resume));
    check("第二只起来时 transcript 已经干净", c2 && !c2.fileAtStart.includes("channel") && c2.fileAtStart.includes("我在"));
    check("第二句递给了新 CLI", c2 && c2.enq.length === 1 && JSON.stringify(c2.enq[0].message).includes("第二句"));
    check("sendTurn 正常返回同一条会话", r2 && r2.threadId === SID);
    const ev = gateEvents().filter((e) => e.kind === "transcript.hallucination_scrub");
    check("账本里有 transcript.hallucination_scrub", ev.length === 1 && ev[0].changed === true && ev[0].hits.length === 1, JSON.stringify(ev));
    check("备份在 GATE_ROOT/scrub-bak", ev[0] && ev[0].backup.startsWith(path.join(dir, "scrub-bak")) && fs.existsSync(ev[0].backup));
    check("擦完不在擦了", a._scrubState().scrubbing === false);
    await a.close();
  }

  console.log("[2] 他还在忙（后面排着一轮）：这轮收尾不擦，等排着的那轮也收尾");
  {
    seedTranscript("嗯\n\n" + FAKE);
    const n0 = clis.length;
    const { a, events, done } = await makeAdapter();
    await turn(a, "A");
    const c = clis[n0];
    await turn(a, "B");                 // B 排在 A 后面（turns 表里有两轮）
    await speak(c, c.enq[0], "嗯\n\n" + FAKE);
    await finish(c, c.enq[0]);
    await done(1);
    check("A 收尾时 B 还在 → 不擦、不停 CLI", a._scrubState().scrubbing === false && a._scrubState().pending === 1 && !c.closed);
    await speak(c, c.enq[1], "好的");
    await finish(c, c.enq[1]);
    await done(2);
    const comps = events.filter((e) => e.type === "runtime.turn.completed");
    check("A 的 completed 发出时没在擦、B 的发出时在擦", comps.length === 2 && comps[0].scrubbingAtEmit === false && comps[1].scrubbingAtEmit === true);
    await until(() => a._scrubState().scrubbing === false);
    check("擦完：旧 CLI 关了、新 CLI 起来了", c.closed && clis.length === n0 + 2 && clis[n0 + 1].resume === SID);
    check("文件干净了", !fs.readFileSync(file, "utf8").includes("channel"));
    await a.close();
  }

  console.log("[3] 干跑：只记账，不停 CLI、不改文件");
  {
    process.env.GATE_HALLUC_SCRUB = "dry";
    seedTranscript("唔\n\n" + FAKE);
    const before = fs.readFileSync(file, "utf8");
    const n0 = clis.length;
    const evN = gateEvents().length;
    const { a, done } = await makeAdapter();
    await turn(a, "C");
    const c = clis[n0];
    await speak(c, c.enq[0], "唔\n\n" + FAKE);
    await finish(c, c.enq[0]);
    await done(1);
    await until(() => gateEvents().length > evN, 4000);
    const ev = gateEvents().slice(evN).filter((e) => e.kind === "transcript.hallucination_scrub");
    check("记了一笔 dryRun", ev.length === 1 && ev[0].dryRun === true && ev[0].hits.length === 1, JSON.stringify(ev));
    check("CLI 没停、没起新的", !c.closed && clis.length === n0 + 1);
    check("文件没动", fs.readFileSync(file, "utf8") === before);
    await a.close();
  }

  console.log("[4] 关着（默认）：什么都不做");
  {
    delete process.env.GATE_HALLUC_SCRUB;
    seedTranscript("哦\n\n" + FAKE);
    const before = fs.readFileSync(file, "utf8");
    const n0 = clis.length;
    const evN = gateEvents().length;
    const { a, done } = await makeAdapter();
    await turn(a, "D");
    const c = clis[n0];
    await speak(c, c.enq[0], "哦\n\n" + FAKE);
    await finish(c, c.enq[0]);
    await done(1);
    await sleep(1800);
    check("不擦、不停、不记", !c.closed && clis.length === n0 + 1 && fs.readFileSync(file, "utf8") === before && gateEvents().length === evN);
    check("没排着", a._scrubState().pending === 0 && a._scrubState().mode === "off");
    await a.close();
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  // 盒子退出时会把游标落一次盘 —— 清目录挂在它后面（exit 回调按注册顺序跑）
  process.once("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FAIL", e && e.stack || e); process.exit(1); });
