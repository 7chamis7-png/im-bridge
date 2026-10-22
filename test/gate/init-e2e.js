"use strict";
/**
 * 「拉下来就能用」端到端（2026-10-21）：
 *   init 在临时 HOME 里生成一个新角色 → 用**它生成的** run-cli.sh / run-box.sh / run-gate.sh 起三个真进程
 *   → 假 Telegram Bot API 推一条主人的消息 → gate → box → cli-host → 假 claude CLI → 回话 → gate → 假 TG 收到 sendMessage。
 *
 * 不调任何真 API：TG 走 GATE_TELEGRAM_API_BASE 指到本地假服务，claude 是 test/runtime/helpers/fake-cli.js。
 * 不碰生产：HOME / GATE_ROOT / socket 全在临时目录；run-*.sh 用 env -i 干净环境起。
 * 另外验：二次 init 拒绝覆盖；钥匙文件 600、env 文件里没有 token 明文；codex / deepseek 两种引擎生成的东西对得上。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const REPO = path.join(__dirname, "..", "..");
const CLI = path.join(REPO, "scripts", "im-bridge.js");
const FAKE_CLI = path.join(REPO, "test", "runtime", "helpers", "fake-cli.js");
const TOKEN = "123456:TESTtokenTESTtokenTESTtoken_xx";
const OWNER = "424242";

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => {
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : "  " + extra));
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function init(home, answers, extraArgs = []) {
  const file = path.join(home, "answers.json");
  fs.writeFileSync(file, JSON.stringify(answers));
  try {
    const out = execFileSync(process.execPath, [CLI, "init", "--answers", file, ...extraArgs],
      { env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) { return { code: e.status, out: String(e.stdout || "") + String(e.stderr || "") }; }
}

/** 假 Bot API：getUpdates 先给一条主人的话，之后空着长轮询；sendMessage 记下来。 */
function fakeTelegram() {
  const sent = [];
  const calls = [];
  let delivered = false;
  let released = false;   // 等桥连上盒子再放那条消息（不然它进死信：「盒子没连上」—— 那是另一件事）
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      const m = /^\/bot([^/]+)\/(\w+)/.exec(req.url) || [];
      const method = m[2] || "";
      calls.push({ token: m[1], method });
      let params = {};
      try { params = body && /json/.test(req.headers["content-type"] || "") ? JSON.parse(body) : {}; } catch { /* multipart 不管 */ }
      const reply = (result) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, result })); };
      if (m[1] !== TOKEN) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" })); }
      if (method === "getMe") return reply({ id: 999, is_bot: true, first_name: "测试", username: "test_bot" });
      if (method === "getUpdates") {
        if (!delivered && released) {
          delivered = true;
          return reply([{ update_id: 1001, message: { message_id: 7, date: Math.floor(Date.now() / 1000),
            from: { id: Number(OWNER), is_bot: false, first_name: "A" }, chat: { id: Number(OWNER), type: "private" }, text: "在吗" } }]);
        }
        await sleep(300);
        return reply([]);
      }
      if (/^send/.test(method)) {
        sent.push({ method, params });
        return reply({ message_id: 100 + sent.length, date: Math.floor(Date.now() / 1000), chat: { id: Number(params.chat_id) || 0, type: "private" }, text: params.text || "" });
      }
      return reply(true);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, sent, calls, release: () => { released = true; }, base: `http://127.0.0.1:${server.address().port}` })));
}

function fakeCliScript(home, gateRoot) {
  const fixture = fs.readFileSync(path.join(REPO, "test", "fixtures", "cli-raw.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const init = { ...fixture.find((f) => f.subtype === "init"), session_id: "fake-session" };
  const baseText = fixture.find((f) => f.message && f.message.content && f.message.content[0].type === "text");
  const baseResult = fixture.find((f) => f.type === "result");
  const assistant = { ...baseText, session_id: "$SESSION", user_message_uuid: "$UUID",
    message: { ...baseText.message, id: "message-$UUID", stop_reason: "end_turn", content: [{ type: "text", text: "在呢，我是阿七。" }] } };
  const result = { ...baseResult, session_id: "$SESSION", user_message_uuid: "$UUID" };
  const file = path.join(home, "fake-cli-script.json");
  fs.writeFileSync(file, JSON.stringify({ init, initOnUser: false, turns: [[assistant, result]],
    ingressPath: path.join(gateRoot, "state", "im-bridge-ingress.json"), tracePath: path.join(home, "fake-cli-trace.jsonl") }));
  return file;
}

(async () => {
  console.log("\n[1] init 生成一套角色（claude-cli，只有 Telegram）");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "imb-init-e2e-"));
  const answers = { id: "ah7", agentName: "阿七", ownerName: "小A", telegramToken: TOKEN, ownerTelegramId: OWNER, engine: "claude-cli" };
  const r = init(home, answers);
  check("init 成功", r.code === 0, r.out);
  const gateRoot = path.join(home, ".ah7-gate");
  const envFile = path.join(gateRoot, "ah7-env.sh");
  for (const f of ["ah7-env.sh", "run-cli.sh", "run-box.sh", "run-gate.sh", "ecosystem.config.cjs", "tools.json", "models.json"]) {
    check("生成了 " + f, fs.existsSync(path.join(gateRoot, f)));
  }
  check("人格文件 / 宣言", fs.existsSync(path.join(home, "ah7", "阿七.md")) && fs.existsSync(path.join(home, "ah7", "system-prompt.md")));
  const sec = path.join(home, ".secrets", "ah7-telegram.secret");
  check("token 进了 ~/.secrets，600", fs.existsSync(sec) && (fs.statSync(sec).mode & 0o777) === 0o600);
  check("env 文件里没有 token 明文", !fs.readFileSync(envFile, "utf8").includes(TOKEN));
  const eco = require(path.join(gateRoot, "ecosystem.config.cjs"));
  check("pm2 进程名前缀 = 角色 id", JSON.stringify(eco.apps.map((a) => a.name)) === JSON.stringify(["ah7-cli", "ah7-box", "ah7-gate"]));
  check("models.json 默认是 claude 那条",
    JSON.parse(fs.readFileSync(path.join(gateRoot, "models.json"), "utf8")).default === "claude-opus-5-5");

  console.log("\n[2] 已存在的角色目录绝不覆盖");
  const before = fs.readFileSync(envFile, "utf8");
  const again = init(home, { ...answers, ownerName: "别人" });
  check("第二次 init 被拒", again.code !== 0 && /绝不覆盖/.test(again.out), again.out);
  check("原文件一个字没动", fs.readFileSync(envFile, "utf8") === before);

  console.log("\n[3] doctor 能读这套配置（不联网）");
  let doc = "";
  try { doc = execFileSync(process.execPath, [CLI, "doctor", "ah7", "--offline"], { env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8" }); }
  catch (e) { doc = String(e.stdout || "") + String(e.stderr || ""); }
  check("doctor 认出 GATE_ROOT", doc.includes(gateRoot), doc.slice(0, 400));
  check("doctor 认出 models.json", /models\.json/.test(doc) && !/✗[^\n]*models\.json/.test(doc), doc);

  console.log("\n[4] 用生成的 run-*.sh 起三个进程，假 TG + 假 CLI 走一轮");
  const tg = await fakeTelegram();
  const script = fakeCliScript(home, gateRoot);
  fs.appendFileSync(envFile, [
    "# —— 测试追加 ——",
    `export GATE_TELEGRAM_API_BASE='${tg.base}'`,
    `export GATE_CLAUDE_COMMAND='${FAKE_CLI}'`,
    `export IM_BRIDGE_FAKE_SCRIPT='${script}'`,
    "export GATE_WATCH_MS=0",
    "export GATE_POLL_TIMEOUT_SEC=1",
    "",
  ].join("\n"));
  const logs = {};
  const procs = ["cli", "box", "gate"].map((p) => {
    logs[p] = "";
    const child = spawn("bash", [path.join(gateRoot, `run-${p}.sh`)], { env: { PATH: process.env.PATH, HOME: home }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    child.stdout.on("data", (d) => { logs[p] += d; });
    child.stderr.on("data", (d) => { logs[p] += d; });
    return child;
  });
  const ready = Date.now() + 20_000;
  while (Date.now() < ready && !/连上盒子了/.test(logs.gate)) await sleep(100);
  tg.release();
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline && !tg.sent.some((s) => s.method === "sendMessage")) await sleep(200);
  const msg = tg.sent.find((s) => s.method === "sendMessage");
  check("TG 收到了他的回话", Boolean(msg), "\n--- gate ---\n" + logs.gate.slice(-2500) + "\n--- box ---\n" + logs.box.slice(-2500) + "\n--- cli ---\n" + logs.cli.slice(-1500));
  if (msg) {
    check("发给主人", String(msg.params.chat_id) === OWNER, JSON.stringify(msg.params));
    check("是假 CLI 说的那句", /在呢，我是阿七/.test(msg.params.text || ""), JSON.stringify(msg.params));
  }
  const trace = fs.existsSync(path.join(home, "fake-cli-trace.jsonl"))
    ? fs.readFileSync(path.join(home, "fake-cli-trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  const got = trace.find((t) => t.type === "received");
  check("假 CLI 收到了她的原话", Boolean(got) && JSON.stringify(got.message).includes("在吗"));
  check("cold.jsonl 记了这一轮", fs.existsSync(path.join(gateRoot, "cold.jsonl"))
    && fs.readFileSync(path.join(gateRoot, "cold.jsonl"), "utf8").includes("在呢，我是阿七"));
  check("socket 都在角色目录里", fs.existsSync(path.join(gateRoot, "box.sock")) && fs.existsSync(path.join(gateRoot, "cli.sock")));

  for (const c of procs) { try { process.kill(-c.pid, "SIGTERM"); } catch { /* 已经没了 */ } }
  await sleep(500);
  for (const c of procs) { try { process.kill(-c.pid, "SIGKILL"); } catch { /* 已经没了 */ } }
  tg.server.close();

  console.log("\n[5] codex / deepseek 两种引擎生成的东西对得上（只看生成物，不起进程）");
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), "imb-init-e2e2-"));
  const c = init(home2, { ...answers, id: "hz2", engine: "codex", codexHome: path.join(home2, ".codex-hz2") });
  check("codex init 成功", c.code === 0, c.out);
  const cliSh = fs.readFileSync(path.join(home2, ".hz2-gate", "run-cli.sh"), "utf8");
  check("codex 起的是 codex-main.js", /exec node cli-host\/codex-main\.js/.test(cliSh));
  check("CODEX_HOME 写进 env", fs.readFileSync(path.join(home2, ".hz2-gate", "hz2-env.sh"), "utf8").includes(`CODEX_HOME='${path.join(home2, ".codex-hz2")}'`));
  const t = init(home2, { ...answers, id: "hz6", engine: "codex", codexHome: "~/.codex" });
  const tenv = t.code === 0 ? fs.readFileSync(path.join(home2, ".hz6-gate", "hz6-env.sh"), "utf8") : t.out;
  check("codexHome 写 ~ 也展开成绝对路径（不生成 CODEX_HOME='~/.codex' 字面量）",
    tenv.includes(`CODEX_HOME='${path.join(home2, ".codex")}'`) && !tenv.includes("'~"), tenv.split("\n").find((l) => l.startsWith("CODEX_HOME")) || tenv);
  const d = init(home2, { ...answers, id: "ds3", engine: "deepseek", deepseekKey: "sk-test-xxxxxxxx" });
  check("deepseek init 成功", d.code === 0, d.out);
  const dsModels = JSON.parse(fs.readFileSync(path.join(home2, ".ds3-gate", "models.json"), "utf8"));
  check("deepseek 默认模型 + 钥匙名跟角色走", dsModels.default === "deepseek-chat"
    && dsModels.models.find((m) => m.engine === "openai-chat").secret === "ds3-deepseek");
  const dsKey = path.join(home2, ".secrets", "ds3-deepseek.secret");
  check("deepseek 钥匙 600", fs.existsSync(dsKey) && (fs.statSync(dsKey).mode & 0o777) === 0o600);
  const w = init(home2, { ...answers, id: "wx4", channels: ["telegram", "wechat"],
    wechat: { keysFile: path.join(home2, "k.json"), imageKeyFile: path.join(home2, "img.txt"), target: "小A", ownerWxid: "wxid_test" } });
  check("微信 init 成功", w.code === 0, w.out);
  const wenv = fs.readFileSync(path.join(home2, ".wx4-gate", "wx4-env.sh"), "utf8");
  check("微信走无障碍发送，不注入", /GATE_WECHAT_SENDER_MODE='a11y'/.test(wenv) && !/rpc/i.test(wenv.replace(/#.*$/gm, "")));
  check("白名单里是她的 wxid", fs.readFileSync(path.join(home2, ".wx4", "wechat", "whitelist"), "utf8").trim() === "wxid_test");
  const wmiss = init(home2, { ...answers, id: "wx5", channels: "telegram,wechat", wechat: {} });
  check("微信缺密钥文件路径就拒", wmiss.code === 2 && /wechat\.keysFile/.test(wmiss.out), wmiss.out);
  const bad = init(home2, { ...answers, id: "Bad Id", telegramToken: "nope" });
  check("填错了一个都不写", bad.code === 2 && !fs.existsSync(path.join(home2, ".Bad Id-gate")), bad.out);

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(home2, { recursive: true, force: true });
  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
