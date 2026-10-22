"use strict";
/**
 * 工具跟人走（2026-10-21）：登记表 + 人格配置 → mcpServers。
 *
 * 守的几件事：
 *   · Nova切过去 = 今天那 16 包原样（同名、同路径、同 env）；工具名一个不变
 *   · Iris渲染出来的东西里**没有一个字指向Nova家**（/root/.nova、/root/.nova-gate、/root/.cyberboss）
 *   · 号类没钥匙 = 不挂 + 日志说清楚（只说名字，不说值）；绝不借别人的号
 *   · 专属记忆只在配置显式给了位置时挂
 *   · codex 那头：钥匙不上命令行，env 经跳板显式交给子进程
 * 全程只读两份示例配置 + 临时目录；钥匙全是假的。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { renderToolServers, parseEnvText } = require("../../src/toolbox/render");
const { SERVERS } = require("../../src/toolbox/registry");
const { buildMcpOverrides } = require("../../cli-host/codex-appserver");

let pass = 0, fail = 0;
const check = (n, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(g)} want=${JSON.stringify(w)}`));
  ok ? pass++ : fail++;
};
const truthy = (n, v) => check(n, !!v, true);

const REPO = path.resolve(__dirname, "..", "..");
const EX = path.join(REPO, "examples", "tools");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tools-registry-"));
const FAKE = { GARDEN_TOKEN: "fake-garden-111", AISAY_TOKEN: "fake-aisay-222", CROTOWN_TOKEN: "fake-crotown-333", ELEVENLABS_API_KEY: "fake-el-444" };
function secretsFile(name, obj) {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, "# 假的\n" + Object.entries(obj).map(([k, v]) => `export ${k}="${v}"`).join("\n") + "\n", { mode: 0o600 });
  return f;
}
/** 示例配置换上假钥匙文件（其余一字不改） */
function exampleWith(which, secretsFiles, patch = {}) {
  const cfg = JSON.parse(fs.readFileSync(path.join(EX, which), "utf8"));
  cfg.secretsFiles = secretsFiles;
  Object.assign(cfg, patch);
  const f = path.join(tmp, `${which}-${Math.random().toString(16).slice(2, 8)}.json`);
  fs.writeFileSync(f, JSON.stringify(cfg));
  return f;
}
function render(opts) {
  const logs = [];
  const out = renderToolServers({ nodePath: "/opt/node-v22.23.3-linux-x64/bin/node", imBridgeHome: "/root/im-bridge", ...opts, log: (m) => logs.push(m) });
  return { out, logs };
}

// ——— 0. 小零件 ———
console.log("零件");
check("env 文件：export / 引号 / 注释", parseEnvText("# c\nexport A=\"1\"\nB='2'\nC=3=4\n bad line\n"), { A: "1", B: "2", C: "3=4" });
check("没有 tools.json → null（走老 GATE_EXTRA_MCP）", render({ gateRoot: tmp, configFile: path.join(tmp, "nope.json") }).out, null);

// ——— 1. Nova：跟今天原样 ———
console.log("Nova");
const novaSecrets = [secretsFile("nova-bridge.env", { ELEVENLABS_API_KEY: FAKE.ELEVENLABS_API_KEY, TELEGRAM_BOT_TOKEN: "fake-tg" }),
  secretsFile("nova-tools.env", { GARDEN_TOKEN: FAKE.GARDEN_TOKEN, AISAY_TOKEN: FAKE.AISAY_TOKEN, CROTOWN_TOKEN: FAKE.CROTOWN_TOKEN })];
const nova = render({ gateRoot: "/root/.nova-gate", toolSocket: "/root/.nova-gate/tools.sock", coldFile: "/root/.nova-gate/cold.jsonl",
  workspace: "/root/nova", configFile: exampleWith("nova.tools.json", novaSecrets) });
const R = nova.out.servers;
check("17 包全在、键名不变", Object.keys(R).sort(), Object.keys(SERVERS).sort());
check("17 = 今天两份配置的并集 16 包 + 技能包（10-21 第 3 步从 .claude/skills 搬进桥）", Object.keys(R).sort(),
  ["browser", "cedartoy", "lmc5", "aisay", "garden", "stmem", "stmem-may", "taibu",
    "notebook", "stickers", "notebooks", "hands", "daily", "telegram", "ib-sign", "crotown", "skills"].sort());
check("Nova：技能目录 = 人格配置给的", R.skills.env, { SKILLS_DIRS: "/root/.nova/skills" });

// 今天的 stdio 规格（/root/nova/.mcp.json + /root/.nova-gate/mcp-extra.json，10-21 抄的；没有钥匙）
const TODAY = {
  browser: { command: "/usr/local/bin/node", args: ["/root/browser-mcp/node_modules/@playwright/mcp/cli.js", "--browser", "chromium", "--headless", "--no-sandbox", "--user-data-dir", "/root/.cyberboss/browser-profile"], env: { DISPLAY: ":99" } },
  stmem: { command: "/root/stone-memory-guisuo/tools/mcp-guisuo.sh", args: ["guisuo-cold"] },
  "stmem-may": { command: "/root/stone-memory-guisuo/tools/mcp-guisuo.sh", args: ["guisuo-prequel-may-v2"] },
  notebook: { command: "/usr/local/bin/node", args: ["/root/nova-notebook/mcp-server.js"], env: { NOTEBOOK_FILE: "/root/.nova/notebook.json" } },
  stickers: { command: "/usr/local/bin/node", args: ["/root/nova-stickers/mcp-server.js"], env: { STICKER_ROOT: "/root/.nova", STICKER_INBOX_DIRS: "/root/.nova-gate/files:/root/.nova-gate/phone-inbox:/root/.nova-gate/imessage-inbox:/root/.nova/inbox" } },
  notebooks: { command: "/usr/local/bin/node", args: ["/root/im-bridge/tools/notebooks/mcp-server.js"] },
  hands: { command: "/usr/local/bin/node", args: ["/root/im-bridge/tools/hands/mcp-server.js"] },
  daily: { command: "/usr/local/bin/node", args: ["/root/im-bridge/tools/daily/mcp-server.js"] },
  telegram: { command: "/usr/local/bin/node", args: ["/root/im-bridge/tools/telegram/mcp-server.js"] },
  "ib-sign": { command: "/usr/local/bin/node", args: ["/root/ib-production-next/mcp/ib-sign-mcp-server.js"], env: { IB_PIPELINE_CONFIG: "/root/.nova/ib/pipeline.config.json", IB_SUBJECT_HOME: "/root/.nova/ib" } },
};
for (const [name, want] of Object.entries(TODAY)) {
  check(`${name} 命令/参数跟今天一样`, [R[name].command, R[name].args], [want.command, want.args]);
  for (const [k, v] of Object.entries(want.env || {})) check(`${name} env ${k} 跟今天一样`, R[name].env[k], v);
}
check("taibu：同一个 node（/usr/local/bin/node 是 /opt 那个的软链）+ 同一个入口",
  [R.taibu.args, R.taibu.command], [["/opt/node-v22.23.3-linux-x64/lib/node_modules/taibu-mcp/dist/index.js"], "/usr/local/bin/node"]);
// 今天靠继承的默认值，现在显式写出来 —— 值必须跟老默认一样
check("notebooks 显式 env = 老默认", R.notebooks.env, { NOVA_STATE_DIR: "/root/.nova", MEMORY_SOURCES_FILE: "/root/.nova-gate/cold.jsonl" });
check("hands 显式 env = 老默认（钥匙从 secrets 来）", R.hands.env, {
  NOVA_STATE_DIR: "/root/.nova", GATE_TOOL_SOCKET: "/root/.nova-gate/tools.sock", HANDS_SONG_CONFIG: "/root/.nova/song-config.json",
  HANDS_ZHIHU_PROFILE: "/root/.nova/browser-profile", HANDS_PLAYWRIGHT: "/root/browser-mcp/node_modules/playwright", DISPLAY: ":99",
  ELEVENLABS_API_KEY: FAKE.ELEVENLABS_API_KEY });
check("telegram 显式 socket = 老默认", R.telegram.env, { GATE_TOOL_SOCKET: "/root/.nova-gate/tools.sock" });
check("daily：只有家目录（微信 id 照旧靠 nova-env.sh 继承）", R.daily.env, { NOVA_STATE_DIR: "/root/.nova" });
check("常驻的只有 notebook（今天就是这样）；im_bridge 在 main.js",
  Object.keys(R).filter((k) => R[k].alwaysLoad), ["notebook"]);

const PROXY = "/root/im-bridge/tools/_lib/mcp-http-proxy.js";
const remote = (n) => [R[n].command, R[n].args, R[n].env];
check("garden → 本地代理 + bearer", remote("garden"), ["/usr/local/bin/node", [PROXY],
  { MCP_PROXY_NAME: "garden", MCP_PROXY_URL: "https://galatea.abysslumina.com/mcp", MCP_PROXY_TOKEN: FAKE.GARDEN_TOKEN, MCP_PROXY_AUTH: "bearer" }]);
check("aisay → 本地代理 + ?token=", remote("aisay")[2], { MCP_PROXY_NAME: "aisay", MCP_PROXY_URL: "https://aisay.top/chatroom/mcp", MCP_PROXY_TOKEN: FAKE.AISAY_TOKEN, MCP_PROXY_AUTH: "query:token" });
check("crotown → 本地代理 + ?token=", remote("crotown")[2], { MCP_PROXY_NAME: "crotown", MCP_PROXY_URL: "https://crotown.app/mcp", MCP_PROXY_TOKEN: FAKE.CROTOWN_TOKEN, MCP_PROXY_AUTH: "query:token" });
check("cedartoy → 本地代理、无钥匙", remote("cedartoy")[2], { MCP_PROXY_NAME: "cedartoy", MCP_PROXY_URL: "https://toy.cedarstar.org" });
check("lmc5 → 本地代理", remote("lmc5")[2], { MCP_PROXY_NAME: "lmc5", MCP_PROXY_URL: "http://127.0.0.1:8100/mcp" });
check("渲染结果里没有 headers / url 形状（codex 带不过去的那种）",
  Object.values(R).some((s) => s.headers || s.url || s.type), false);
check("Nova：日志里没有钥匙的值", nova.logs.some((l) => Object.values(FAKE).some((v) => l.includes(v))), false);
check("Nova：一包没漏", nova.out.omitted, []);

// ——— 2. Iris：数据全在他自己家，号只用他自己的 ———
console.log("Iris");
const hzSecrets = [secretsFile("iris-tools.env", { GARDEN_TOKEN: "fake-hz-garden-781" })];
const hzCfg = exampleWith("iris.tools.json", hzSecrets);
const hz = render({ gateRoot: "/root/.iris-gate", toolSocket: "/root/.iris-gate/tools.sock", coldFile: "/root/.iris-gate/cold.jsonl",
  workspace: "/root/telegram-nova-workspace", configFile: hzCfg });
const H = hz.out.servers;
const hzText = JSON.stringify(H);
const LEAK = /\/root\/\.nova(\/|"|:)|\/root\/\.nova-gate|\/root\/\.cyberboss|\/root\/nova(\/|"|:)/;
check("阳性对照：同一个判据在Nova的结果上能抓到", LEAK.test(JSON.stringify(R)), true);
check("Iris：渲染结果里没有 /root/.nova / .nova-gate / .cyberboss", LEAK.test(hzText), false);
check("Iris：没有Nova的钥匙", Object.values(FAKE).some((v) => hzText.includes(v)), false);
check("Iris：挂上的包", Object.keys(H).sort(), ["cedartoy", "daily", "garden", "hands", "notebook", "notebooks", "skills", "stickers", "telegram"].sort());
check("Iris：技能目录在他家（默认 ${STATE_DIR}/skills）", H.skills.env, { SKILLS_DIRS: "/root/.iris/skills" });
check("Iris：专属记忆一个都没挂", ["lmc5", "stmem", "stmem-may", "ib-sign"].filter((k) => H[k]), []);
check("Iris：没钥匙的号不挂（aisay/crotown）", ["aisay", "crotown"].filter((k) => H[k]), []);
truthy("Iris：没钥匙的日志说了是哪把", hz.logs.some((l) => l.includes("aisay") && l.includes("AISAY_TOKEN")));
check("Iris：skipHeavy 摘掉 browser / taibu；garden 单开（他自己的花园号）", [!!H.browser, !!H.taibu, !!H.garden], [false, false, true]);
check("Iris：garden 用的是他自己的钥匙", H.garden.env.MCP_PROXY_TOKEN, "fake-hz-garden-781");
check("Iris：notebooks 家目录 + 冷层是他的", H.notebooks.env, { NOVA_STATE_DIR: "/root/.iris", MEMORY_SOURCES_FILE: "/root/.iris-gate/cold.jsonl" });
check("Iris：手 / TG 交给他自己的桥", [H.hands.env.GATE_TOOL_SOCKET, H.telegram.env.GATE_TOOL_SOCKET], ["/root/.iris-gate/tools.sock", "/root/.iris-gate/tools.sock"]);
check("Iris：知乎 profile / 歌喉配置在他家", [H.hands.env.HANDS_ZHIHU_PROFILE, H.hands.env.HANDS_SONG_CONFIG], ["/root/.iris/browser-profile", "/root/.iris/song-config.json"]);
check("Iris：没有 ElevenLabs 钥匙就不带这个键（不是空串）", "ELEVENLABS_API_KEY" in H.hands.env, false);
check("Iris：贴纸柜 + 收件箱在他家", H.stickers.env, { STICKER_ROOT: "/root/.iris", STICKER_INBOX_DIRS: "/root/.iris-gate/files:/root/.iris/inbox" });
check("Iris：本子在他家", H.notebook.env.NOTEBOOK_FILE, "/root/.iris/notebook.json");
check("Iris：没有常驻的（codex 本来也不分）", Object.keys(H).filter((k) => H[k].alwaysLoad), []);
// 共享的代码路径可以出现（/root/im-bridge、/root/browser-mcp、/root/nova-notebook …）
truthy("Iris：共享代码路径照常", hzText.includes("/root/im-bridge/tools/") && hzText.includes("/root/browser-mcp/"));

const hzAll = render({ gateRoot: "/root/.iris-gate", configFile: exampleWith("iris.tools.json", hzSecrets, { skipHeavy: false }) });
check("Iris skipHeavy=false：browser 回来，profile 在他家", hzAll.out.servers.browser.args.slice(-1), ["/root/.iris/browser-profile"]);
check("Iris skipHeavy=false：crotown 照样因为没钥匙不挂", [!!hzAll.out.servers.crotown, hzAll.logs.some((l) => l.includes("CROTOWN_TOKEN"))], [false, true]);

// ——— 3. 缺钥匙 / 缺文件 / 缺目录 ———
console.log("缺东西");
const partial = render({ gateRoot: "/root/.nova-gate", configFile: exampleWith("nova.tools.json", [secretsFile("p.env", { GARDEN_TOKEN: "g" })]) });
check("缺 AISAY_TOKEN / CROTOWN_TOKEN → 这两包不挂，别的照挂", ["aisay", "crotown", "garden", "notebook"].map((k) => !!partial.out.servers[k]), [false, false, true, true]);
check("不挂的原因写清楚", partial.out.omitted.map((o) => o.name).sort(), ["aisay", "crotown"]);
const nofile = render({ gateRoot: "/root/.nova-gate", configFile: exampleWith("nova.tools.json", [path.join(tmp, "missing.env")]) });
check("secrets 文件不在 → 号类全不挂", ["aisay", "crotown", "garden"].filter((k) => nofile.out.servers[k]), []);
truthy("secrets 文件不在 → 日志喊了", nofile.logs.some((l) => l.includes("secrets 文件读不到")));
const nostate = render({ gateRoot: tmp, configFile: exampleWith("iris.tools.json", [], { vars: {} }) });
check("没给 STATE_DIR → 数据类一包不挂（不回落到别人家）",
  Object.keys(nostate.out.servers).filter((k) => SERVERS[k].category === "per-persona-data"), []);
check("没给 STATE_DIR → 共享的照挂（taibu 是 heavy，示例里 skipHeavy）", Object.keys(nostate.out.servers).sort(), ["cedartoy"]);
const half = render({ gateRoot: "/root/.nova-gate", configFile: exampleWith("nova.tools.json", novaSecrets, { vars: { STATE_DIR: "/root/.nova", STMEM_DIR: "/x" } }) });
check("专属记忆：只给了一半位置（缺 STMEM_PROFILE）→ 不挂", [!!half.out.servers.stmem, !!half.out.servers.lmc5, !!half.out.servers["ib-sign"]], [false, false, false]);
const off = render({ gateRoot: "/root/.nova-gate", configFile: exampleWith("nova.tools.json", novaSecrets, { exclude: ["taibu"], servers: { hands: { enabled: false } } }) });
check("exclude / enabled:false 都能关", [!!off.out.servers.taibu, !!off.out.servers.hands], [false, false]);
const fixedTry = render({ gateRoot: "/root/.iris-gate", configFile: exampleWith("iris.tools.json", hzSecrets, { vars: { STATE_DIR: "/root/.iris", GATE_ROOT: "/root/.nova-gate", TOOL_SOCKET: "/root/.nova-gate/tools.sock" } }) });
check("配置里写 GATE_ROOT / TOOL_SOCKET 不认（桥自己定）", fixedTry.out.servers.telegram.env.GATE_TOOL_SOCKET, "/root/.iris-gate/tools.sock");
const badJson = path.join(tmp, "bad.json"); fs.writeFileSync(badJson, "{oops");
let threw = ""; try { render({ gateRoot: tmp, configFile: badJson }); } catch (e) { threw = e.message; }
truthy("坏 JSON → 抛（main.js 接住、喊、只少工具）", /不是合法 JSON/.test(threw));

// ——— 4. main.js 接线：tools.json + GATE_EXTRA_MCP 顶替 ———
console.log("main.js 接线");
const { buildToolServers, readExtraMcp } = require("../../src/host/main");
const groot = fs.mkdtempSync(path.join(os.tmpdir(), "tools-gate-"));
fs.writeFileSync(path.join(groot, "tools.json"), JSON.stringify({ persona: "t", vars: { STATE_DIR: path.join(groot, "state") } }));
const mlogs = [];
const built = buildToolServers({ root: groot, coldFile: path.join(groot, "cold.jsonl"), toolsConfigFile: path.join(groot, "tools.json") }, path.join(groot, "tools.sock"), (m) => mlogs.push(m));
check("main.js：渲染出来的 telegram 用这座桥的 socket", built.telegram.env.GATE_TOOL_SOCKET, path.join(groot, "tools.sock"));
truthy("main.js：日志报了挂几包", mlogs.some((l) => /挂上 \d+ 包/.test(l)));
check("main.js：没有 tools.json → {}", buildToolServers({ root: groot, toolsConfigFile: path.join(groot, "nope.json") }, "", () => {}), {});
check("main.js：坏配置 → {}（不拦起桥）", buildToolServers({ root: groot, toolsConfigFile: badJson }, "", () => {}), {});
const extraF = path.join(groot, "extra.json");
fs.writeFileSync(extraF, JSON.stringify({ mcpServers: { telegram: { command: "x" } } }));
check("GATE_EXTRA_MCP 照旧能读（兼容）", readExtraMcp(extraF), { telegram: { command: "x" } });

// ——— 5. codex：钥匙不上命令行，env 经跳板显式交给子进程 ———
console.log("codex");
const ov = buildMcpOverrides(H, { nodePath: "/n", launchScript: "/l.js" });
const argText = ov.args.join(" ");
check("命令行里没有钥匙", argText.includes("fake-hz-garden-781"), false);
check("命令行里没有 env.X=（老写法）", /\.env\./.test(argText), false);
truthy("每包都 approve", Object.keys(H).every((k) => argText.includes(`mcp_servers.${k}.default_tools_approval_mode="approve"`)));
truthy("garden 只透传它自己那一个变量", argText.includes('mcp_servers.garden.env_vars=["IMB_MCP_GARDEN"]'));
const decoded = JSON.parse(Buffer.from(ov.env.IMB_MCP_GARDEN, "base64").toString("utf8"));
check("变量里是 garden 的全套 env", decoded.MCP_PROXY_TOKEN, "fake-hz-garden-781");
const novaOv = buildMcpOverrides({ "stmem-may": R["stmem-may"], "ib-sign": R["ib-sign"] }, { nodePath: "/n", launchScript: "/l.js" });
truthy("带连字符的包名照样能拼（TOML 裸键）", novaOv.args.join(" ").includes("mcp_servers.ib-sign.env_vars=[\"IMB_MCP_IB_SIGN\"]"));
check("没 env 的包不走跳板", novaOv.args.join(" ").includes('mcp_servers.stmem-may.command="/root/stone-memory-guisuo/tools/mcp-guisuo.sh"'), true);
// 跳板本身：真起一次，看子进程拿到的 env
const probe = path.join(tmp, "print-env.js");
fs.writeFileSync(probe, "process.stdout.write(JSON.stringify({a: process.env.A_DIR, t: process.env.MCP_PROXY_TOKEN, leak: process.env.IMB_MCP_X || null, argv: process.argv.slice(2)}))");
const r = spawnSync(process.execPath, [path.join(REPO, "cli-host", "codex-mcp-launch.js"), "IMB_MCP_X", process.execPath, probe, "--flag"], {
  env: { PATH: process.env.PATH, IMB_MCP_X: Buffer.from(JSON.stringify({ A_DIR: "/root/.iris", MCP_PROXY_TOKEN: "tok" })).toString("base64") },
  encoding: "utf8" });
check("跳板：子进程拿到 env、参数原样、那个打包变量不再往下传", JSON.parse(r.stdout || "{}"), { a: "/root/.iris", t: "tok", leak: null, argv: ["--flag"] });

// ——— 6. 工具包不再默认Nova的 socket ———
console.log("工具包默认值");
const { askGate } = require("../../tools/_lib/gate");
const saved = process.env.GATE_TOOL_SOCKET; delete process.env.GATE_TOOL_SOCKET;
askGate({ tool: "reply", text: "x" }).then((res) => {
  if (saved !== undefined) process.env.GATE_TOOL_SOCKET = saved;
  check("没配 GATE_TOOL_SOCKET → 当场报错，不连Nova的桥", [res.ok, /GATE_TOOL_SOCKET/.test(res.error)], [false, true]);
  for (const [mod, name] of [["../../tools/notebooks/config", "notebooks"], ["../../tools/hands/lib/config", "hands"], ["../../tools/daily/config", "daily"]]) {
    let e = ""; try { require(mod).loadConfig({}); } catch (err) { e = err.message; }
    truthy(`${name}：没给 NOVA_STATE_DIR → 报错（不再默认 ~/.nova）`, /NOVA_STATE_DIR/.test(e));
  }
  let e2 = ""; try { require("../../tools/notebooks/self-state").selfState(""); } catch (err) { e2 = err.message; }
  truthy("self_state：没目录 → 报错（不读 /root/.nova）", /NOVA_STATE_DIR/.test(e2));

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(groot, { recursive: true, force: true });
  console.log(`工具登记表：通过 ${pass} / ${pass + fail}`);
  process.exit(fail ? 1 : 0);
});
