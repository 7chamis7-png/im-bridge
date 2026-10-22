"use strict";
// S3c（2026-10-21）：Iris的 codex thread 生命周期 —— 真 codex-appserver 驱动 + 真 codex-runtime，底下是假 app-server
// （test/gate/lib/fake-codex-appserver.js，形状照 0.163.0）。
//   [1] 起进程不再多开一条空 thread（原来 ensure() 每次 thread/start，紧接着又 resume 旧的）
//   [2] app-server 中途死了被拉起来：续回原来那条，不静默换新
const fs = require("fs"); const os = require("os"); const path = require("path");
const { createCodexAppServer } = require("../../cli-host/codex-appserver");
const { createCodexRuntime } = require("../../cli-host/codex-runtime");

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { if (ok) { pass++; console.log("  OK   " + n); } else { fail++; console.log("  FAIL " + n + "  " + extra); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAKE = path.join(__dirname, "lib", "fake-codex-appserver.js");
fs.chmodSync(FAKE, 0o755);

function rpcLog(file) {
  try { return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-life-"));
  const auth = path.join(root, "auth.json");
  fs.writeFileSync(auth, JSON.stringify({ auth_mode: "chatgpt", tokens: {} }));
  const log = path.join(root, "rpc.jsonl");
  return { root, auth, log };
}

async function runtimeOnce({ root, auth, log, known = "", threadFile, env: extraEnv = {} }) {
  const env = { PATH: process.env.PATH, GATE_ROOT: root, FAKE_CODEX_LOG: log, FAKE_CODEX_KNOWN: known, ...extraEnv };
  const rt = createCodexRuntime({ ingressPath: path.join(root, "state", "ingress.json"), cwd: root, env, authFile: auth,
    codexPath: FAKE, threadFile });
  await rt.start();
  const st = rt.status();
  await rt.close();
  return st;
}

(async () => {
  console.log("[1] 驱动 ensure() 只起进程，不开 thread");
  {
    const { root, log } = setup();
    const d = createCodexAppServer({ codexPath: FAKE, cwd: root, env: { PATH: process.env.PATH, FAKE_CODEX_LOG: log } });
    await d.ensure();
    const calls = rpcLog(log).map((c) => c.method);
    check("ensure 只发 initialize", calls.join(",") === "initialize", calls.join(","));
    check("还没有 threadId", d.threadId === "");
    await d.close();
  }

  console.log("[2] 插头起来：有旧 thread 只续、没有才开一条");
  {
    const { root, auth, log } = setup();
    const threadFile = path.join(root, "state", "codex-thread.json");
    fs.mkdirSync(path.dirname(threadFile), { recursive: true });
    fs.writeFileSync(threadFile, JSON.stringify({ schema: "nova.codex-thread.v1", threadId: "old-thread-1" }));
    const st = await runtimeOnce({ root, auth, log, known: "old-thread-1", threadFile });
    const calls = rpcLog(log).map((c) => c.method);
    check("续旧的：0 次 thread/start", !calls.includes("thread/start"), calls.join(","));
    check("续旧的：1 次 thread/resume", calls.filter((m) => m === "thread/resume").length === 1);
    check("sessionId 是旧那条", st.sessionId === "old-thread-1", st.sessionId);
  }
  {
    const { root, auth, log } = setup();
    const threadFile = path.join(root, "state", "codex-thread.json");
    const st = await runtimeOnce({ root, auth, log, threadFile });
    const calls = rpcLog(log).map((c) => c.method);
    check("没有旧的：正好 1 次 thread/start", calls.filter((m) => m === "thread/start").length === 1, calls.join(","));
    check("落盘的就是开的那条", JSON.parse(fs.readFileSync(threadFile, "utf8")).threadId === st.sessionId && st.sessionId.startsWith("thr-"));
  }
  {
    const { root, auth, log } = setup();
    const threadFile = path.join(root, "state", "codex-thread.json");
    fs.mkdirSync(path.dirname(threadFile), { recursive: true });
    fs.writeFileSync(threadFile, JSON.stringify({ schema: "nova.codex-thread.v1", threadId: "gone-thread" }));
    const st = await runtimeOnce({ root, auth, log, threadFile });
    const calls = rpcLog(log).map((c) => c.method);
    check("旧的续不上：resume 一次 + start 一次，没有第二条", calls.filter((m) => m === "thread/start").length === 1
      && calls.filter((m) => m === "thread/resume").length === 1, calls.join(","));
    check("续不上时换成新开的那条", st.sessionId !== "gone-thread" && st.sessionId.startsWith("thr-"));
  }

  console.log("[3] app-server 半路死了：下一轮拉起来续原 thread，不开新的");
  {
    const { root, log } = setup();
    const d = createCodexAppServer({ codexPath: FAKE, cwd: root, env: { PATH: process.env.PATH, FAKE_CODEX_LOG: log } });
    await d.ensure();
    const first = await d.startThread();
    let died = false;
    try { await d.runTurn("DIE"); } catch { died = true; }
    check("那一轮报错（没装作答了）", died);
    for (let i = 0; i < 50 && d.initialized; i += 1) await sleep(10);
    const r = await d.runTurn("还在吗");
    const calls = rpcLog(log);
    const pids = [...new Set(calls.map((c) => c.pid))];
    const second = calls.filter((c) => c.pid === pids[1]).map((c) => c.method);
    check("拉起了第二个进程", pids.length === 2);
    check("第二个进程：resume 原 thread，不 start", second.includes("thread/resume") && !second.includes("thread/start")
      && calls.find((c) => c.pid === pids[1] && c.method === "thread/resume").params.threadId === first, second.join(","));
    check("这一轮照常答", r.text === "嗯。" && d.threadId === first);
    await d.close();
  }

  console.log("[4] 0.163.0 的压缩通知（item.type=contextCompaction，方法名里没有 compact）认得出，一次只算一次");
  {
    const { isCompactionNotice } = require("../../cli-host/codex-appserver");
    check("item/started:contextCompaction 认", isCompactionNotice("item/started", { item: { type: "contextCompaction", id: "x" } }));
    check("老的 thread/compacted 也认", isCompactionNotice("thread/compacted", { threadId: "t", turnId: "u" }));
    check("普通 agentMessage 不认", !isCompactionNotice("item/started", { item: { type: "agentMessage" } }));
    const { root, auth, log } = setup();
    const events = [];
    const env = { PATH: process.env.PATH, GATE_ROOT: root, FAKE_CODEX_LOG: log };
    const rt = createCodexRuntime({ ingressPath: path.join(root, "state", "ingress.json"), cwd: root, env, authFile: auth,
      codexPath: FAKE, threadFile: path.join(root, "state", "codex-thread.json"), onEvent: async (e) => { events.push(e); } });
    await rt.start();
    rt.enqueue({ uuid: "u-c", origin: {}, message: { type: "user", message: { role: "user", content: "COMPACT 一下" } } });
    for (let i = 0; i < 200 && !events.some((e) => e.event && e.event.type === "result"); i += 1) await sleep(10);
    const notices = events.filter((e) => e.event && e.event.v === "imb.event.v1" && e.event.kind === "engine.notice");
    check("started + completed + thread/compacted → 只算 1 次", rt.status().compactions === 1, String(rt.status().compactions));
    check("交给盒子一条 engine.notice{compacted}，挂在这一轮上", notices.length === 1 && notices[0].event.what === "compacted"
      && notices[0].bindings[0] && notices[0].bindings[0].uuid === "u-c", JSON.stringify(notices));
    // S2b：插头直接吐通用事件 usage，水位（context）由插头算好（设计稿 §2.3），不再拼假 Claude 帧让盒子加四个数
    const ue = events.find((e) => e.event && e.event.v === "imb.event.v1" && e.event.kind === "usage");
    const u = ue && ue.event;
    check("水位 = last 那次请求（55,924 入 + 188 出），不是整条 thread 累计、缓存不重复算",
      u && u.context === 56112 && u.cacheRead === 11264 && u.input === 55924 - 11264 && u.output === 188, JSON.stringify(u));
    check("没有假 Claude 帧了（S2b）", !events.some((e) => e.event && e.event.raw), "");
    await rt.close();
  }
  {
    const { mapUsage } = require("../../cli-host/codex-runtime");
    check("只有累计数没有 last → 不报（别拿累计冒充水位）", mapUsage({ total: { inputTokens: 791233 } }) === undefined);
    const old = mapUsage({ inputTokens: 1000, cachedInputTokens: 600, outputTokens: 10 });
    check("直接给 breakdown 的老调用照认", old.input_tokens === 400 && old.cache_read_input_tokens === 600);
  }

  console.log("[5] Iris的窗口参数：env → app-server 启动的 -c（只在这个进程里，不改 config.toml）");
  {
    const { root, auth, log } = setup();
    await runtimeOnce({ root, auth, log, threadFile: path.join(root, "state", "codex-thread.json"),
      env: { CODEX_MODEL_CONTEXT_WINDOW: "872000", CODEX_AUTO_COMPACT_TOKEN_LIMIT: "九十万" } });
    const argv = rpcLog(log)[0].argv.join(" ");
    check("带上 -c model_context_window=872000", argv.includes("-c model_context_window=872000"), argv);
    check("写错的值（不是正整数）不带上", !argv.includes("model_auto_compact_token_limit"), argv);
  }

  console.log(`\ncodex thread 生命周期：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
