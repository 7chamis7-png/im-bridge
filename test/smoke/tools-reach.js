#!/usr/bin/env node
"use strict";
/**
 * 连得上吗（2026-10-21）：按两份示例配置渲染，每一包**只用渲染出来的 env**（不继承本进程环境 ——
 * 跟 codex 一样）真起一次，initialize + tools/list。不调 tools/call。
 *
 *   node test/smoke/tools-reach.js            钥匙全假：号类会挂上但连不上（算预期）
 *   node test/smoke/tools-reach.js --live     钥匙从老配置现抽到临时目录（600，跑完删），号类真连
 *
 * Nova：真路径，只读（起服务 + 列工具，这几包启动时都不写盘）。
 * Iris：STATE_DIR / GATE_ROOT 换成临时目录，生产一个字节不碰；走 codex 跳板（codex-mcp-launch.js）起。
 * 已知坏的（不算失败）：stmem / stmem-may（目录没了）、lmc5（服务可能没开）。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const { renderToolServers } = require("../../src/toolbox/render");
const { buildMcpOverrides } = require("../../cli-host/codex-appserver");

const REPO = path.resolve(__dirname, "..", "..");
const LIVE = process.argv.includes("--live");
const KNOWN_BROKEN = new Set(["stmem", "stmem-may", "lmc5"]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tools-reach-"));
fs.chmodSync(tmp, 0o700);

function fakeSecrets(name, obj) {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, Object.entries(obj).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  return f;
}
function liveSecrets(who) {
  const f = path.join(tmp, `${who}-live.env`);
  execFileSync(process.execPath, [path.join(REPO, "scripts", "extract-tool-secrets.js"), who, "--out", f], { stdio: ["ignore", "ignore", "inherit"] });
  return f;
}

function probe(name, command, args, env) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let c;
    try { c = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] }); }
    catch (e) { return resolve({ ok: false, why: e.message }); }
    let out = "", err = "";
    const done = (r) => { clearTimeout(timer); try { c.kill(); } catch { /* 已停 */ } resolve({ ...r, ms: Date.now() - t0 }); };
    const timer = setTimeout(() => done({ ok: false, why: "30 秒没回 · " + err.trim().split("\n").pop() }), 30000);
    c.on("error", (e) => done({ ok: false, why: e.message }));
    c.on("exit", (code) => done({ ok: false, why: `退出 ${code} · ` + err.trim().split("\n").slice(-1)[0] }));
    c.stderr.on("data", (d) => (err += d));
    c.stdout.on("data", (d) => {
      out += d; let i;
      while ((i = out.indexOf("\n")) >= 0) {
        let m; try { m = JSON.parse(out.slice(0, i)); } catch { m = null; } out = out.slice(i + 1);
        if (!m) continue;
        if (m.id === 1) {
          if (m.error) return done({ ok: false, why: "initialize: " + String(m.error.message).slice(0, 120) });
          c.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
          c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
        } else if (m.id === 2) {
          if (m.error) return done({ ok: false, why: "tools/list: " + String(m.error.message).slice(0, 120) });
          const tools = m.result.tools || [];
          return done({ ok: true, tools: tools.length, chars: JSON.stringify(tools).length });
        }
      }
    });
    c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "tools-reach", version: "1" } } }) + "\n");
  });
}

const BASE_ENV = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/root" };

async function runPersona(label, rendered, { viaCodexLauncher = false } = {}) {
  console.log(`\n== ${label}：挂上 ${Object.keys(rendered.servers).length} 包，不挂 ${rendered.omitted.length} 包`);
  for (const o of rendered.omitted) console.log(`   · 不挂 ${o.name}：${o.why}`);
  const rows = [];
  let bad = 0;
  if (viaCodexLauncher) {
    // 照 codex 的样子起：只有 PATH/HOME + 那一个打包变量
    const ov = buildMcpOverrides(rendered.servers);
    const cfg = {};
    for (let i = 0; i < ov.args.length; i += 2) {
      const m = /^mcp_servers\.([^.]+)\.(command|args|env_vars)=(.*)$/.exec(ov.args[i + 1]);
      if (m) (cfg[m[1]] = cfg[m[1]] || {})[m[2]] = JSON.parse(m[3]);
    }
    for (const [name, c] of Object.entries(cfg)) {
      const env = { ...BASE_ENV };
      for (const v of c.env_vars || []) env[v] = ov.env[v];
      rows.push([name, await probe(name, c.command, c.args || [], env)]);
    }
  } else {
    for (const [name, spec] of Object.entries(rendered.servers)) {
      rows.push([name, await probe(name, spec.command, spec.args || [], { ...BASE_ENV, ...(spec.env || {}) })]);
    }
  }
  let tools = 0, chars = 0;
  for (const [name, r] of rows) {
    const known = KNOWN_BROKEN.has(name);
    const accountFake = !LIVE && /HTTP 40[13]|initialize/.test(r.why || "") && ["garden", "aisay", "crotown"].includes(name);
    const tag = r.ok ? "OK  " : (known ? "已知" : (accountFake ? "假钥" : "FAIL"));
    if (!r.ok && !known && !accountFake) bad++;
    if (r.ok) { tools += r.tools; chars += r.chars; }
    console.log(`  ${tag} ${name.padEnd(10)} ${r.ok ? `${String(r.tools).padStart(3)} 个工具 · 说明书 ${String(r.chars).padStart(6)} 字符 · ${r.ms}ms` : r.why}`);
  }
  console.log(`  合计：${tools} 个工具，说明书 ${chars} 字符（≈ ${Math.round(chars / 3.5 / 1000)}k token 粗估）`);
  return { bad, rows };
}

(async () => {
  let bad = 0;
  // ——— Nova：示例配置原样，真路径只读 ———
  const novaCfg = JSON.parse(fs.readFileSync(path.join(REPO, "examples", "tools", "nova.tools.json"), "utf8"));
  novaCfg.secretsFiles = LIVE ? ["/root/.secrets/nova-bridge.env", liveSecrets("nova")]
    : [fakeSecrets("nova.env", { GARDEN_TOKEN: "fake", AISAY_TOKEN: "fake", CROTOWN_TOKEN: "fake" })];
  const novaFile = path.join(tmp, "nova.tools.json");
  fs.writeFileSync(novaFile, JSON.stringify(novaCfg));
  const nova = renderToolServers({ gateRoot: "/root/.nova-gate", toolSocket: "/root/.nova-gate/tools.sock",
    coldFile: "/root/.nova-gate/cold.jsonl", workspace: "/root/nova", configFile: novaFile, imBridgeHome: REPO, log: () => {} });
  bad += (await runPersona("Nova（真路径，只读）", nova)).bad;

  // ——— Iris：示例配置，目录全换临时的；走 codex 跳板 ———
  const hzRoot = path.join(tmp, "iris-gate");
  const hzState = path.join(tmp, "iris-state");
  fs.mkdirSync(hzRoot); fs.mkdirSync(hzState);
  const hzCfg = JSON.parse(fs.readFileSync(path.join(REPO, "examples", "tools", "iris.tools.json"), "utf8"));
  hzCfg.vars.STATE_DIR = hzState;
  hzCfg.secretsFiles = LIVE ? [liveSecrets("iris")] : [fakeSecrets("hz.env", { GARDEN_TOKEN: "fake" })];
  const hzFile = path.join(tmp, "iris.tools.json");
  fs.writeFileSync(hzFile, JSON.stringify(hzCfg));
  const hz = renderToolServers({ gateRoot: hzRoot, coldFile: path.join(hzRoot, "cold.jsonl"), configFile: hzFile, imBridgeHome: REPO, log: () => {} });
  bad += (await runPersona("Iris（临时目录，codex 跳板）", hz, { viaCodexLauncher: true })).bad;

  // Iris如果连 browser 也开（skipHeavy=false）多出来多少 —— 给 codex 的取舍用
  hzCfg.skipHeavy = false;
  fs.writeFileSync(hzFile, JSON.stringify(hzCfg));
  const hzAll = renderToolServers({ gateRoot: hzRoot, coldFile: path.join(hzRoot, "cold.jsonl"), configFile: hzFile, imBridgeHome: REPO, log: () => {} });
  const onlyBrowser = { servers: { browser: hzAll.servers.browser }, omitted: [] };
  bad += (await runPersona("Iris + browser（skipHeavy=false 时多出来的）", onlyBrowser, { viaCodexLauncher: true })).bad;

  const leftovers = fs.readdirSync(hzState);
  console.log(`\nIris临时家目录启动后多了：${leftovers.length ? leftovers.join(", ") : "（没有）"}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(bad ? `连通：${bad} 包意外失败` : "连通：除已知坏的，全部连得上");
  process.exit(bad ? 1 : 0);
})();
