"use strict";
// 时间前缀的格式跟 OUTWARD_LOCALE 走；测试按Iris的 zh-CN 断言，别吃跑测试那个 shell 的环境（10-21 清掉脏环境后挂过）
process.env.OUTWARD_LOCALE = 'zh-CN'; process.env.OUTWARD_TZ = 'Asia/Shanghai';
// forge 做成桥上的共享能力、按人开（2026-10-21）：
//   开关：$GATE_ROOT/tools.json 的 "forge": true|false（跟 personaFile 放一起）；没写才认旧的 FORGE_ENABLED=true
//   引擎差异在各家重建插头：claude = scripts/forge.js 合成 transcript；codex = cli-host/rebuild-codex.js（start + inject_items）
// codex 那半的 rollout 形状来自**真 codex app-server 0.163.0**（隔离 CODEX_HOME，scripts/probes/s0/rebuild-live.js
// 用这个插头真跑过：inject 4 条、回读一致、模型答出注入的暗号），夹具 test/fixtures/real/codex-rollout-0.163.0-injected.jsonl。
const fs = require("fs"); const os = require("os"); const path = require("path");

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { if (ok) { pass++; console.log("  OK   " + n); } else { fail++; console.log("  FAIL " + n + "  " + extra); } };
const FIX = path.join(__dirname, "..", "fixtures", "real");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { forgeSwitch } = require("../../src/box/forge-switch");
  const { tailToResponseItems, verifyInjected, rebuildCodexThread } = require("../../cli-host/rebuild-codex");

  console.log("[1] 开关：tools.json 优先，没写认 FORGE_ENABLED");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "forge-sw-"));
  const cfg = path.join(d, "tools.json");
  const sw = (content, env) => { if (content === null) { try { fs.unlinkSync(cfg); } catch {} } else fs.writeFileSync(cfg, content);
    return forgeSwitch({ env: { GATE_ROOT: d, ...env } }); };
  check("没有 tools.json、没 FORGE_ENABLED → 关", sw(null, {}).on === false);
  check("没有 tools.json、FORGE_ENABLED=true → 开（兼容）", sw(null, { FORGE_ENABLED: "true" }).on === true);
  check("tools.json 没写 forge → 认 FORGE_ENABLED", sw(JSON.stringify({ personaFile: "x.md" }), { FORGE_ENABLED: "true" }).on === true);
  check("tools.json forge:true → 开（不用 env）", sw(JSON.stringify({ personaFile: "x.md", forge: true }), {}).on === true);
  check("tools.json forge:false 压过 FORGE_ENABLED=true", sw(JSON.stringify({ forge: false }), { FORGE_ENABLED: "true" }).on === false);
  check("forge 写成字符串 → 当没写（回落 env）", sw(JSON.stringify({ forge: "yes" }), {}).on === false
    && sw(JSON.stringify({ forge: "yes" }), { FORGE_ENABLED: "true" }).on === true);
  check("tools.json 坏了 → 回落 env，不炸", sw("{坏", { FORGE_ENABLED: "true" }).on === true);
  check("FORGE_ENABLED 只认 true（跟以前一样）", sw(null, { FORGE_ENABLED: "1" }).on === false);

  const { boxEngine } = require("../../src/box/forge-switch");
  check("盒子认引擎：GATE_ENGINE 显式优先", boxEngine({ env: { GATE_ENGINE: "codex" }, model: "claude-fable-5" }) === "codex");
  check("盒子认引擎：Iris GATE_MODEL=gpt-5.6-sol → codex（盒子不给他合成 claude transcript）", boxEngine({ env: { GATE_MODEL: "gpt-5.6-sol" } }) === "codex");
  check("盒子认引擎：Nova GATE_MODEL 空 → claude", boxEngine({ env: { GATE_MODEL: "" } }) === "claude");

  console.log("[2] codex 插头：尾巴 → Responses item（S0 验过的形状）");
  const items = tailToResponseItems([{ role: "user", text: "在吗" }, { role: "assistant", text: "在" }, { role: "assistant", text: "  " }, { role: "x", text: "?" }]);
  console.log("  item 形状：" + JSON.stringify(items[0]));
  check("user → input_text、assistant → output_text，空的和不认识的角色不要", items.length === 2
    && items[0].content[0].type === "input_text" && items[1].content[0].type === "output_text");

  console.log("[3] 回读核对（真 codex 0.163.0 写的 rollout 形状）");
  const real = fs.readFileSync(path.join(FIX, "codex-rollout-0.163.0-injected.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const injected = real.filter((o) => o.type === "response_item" && o.payload.type === "message" && ["user", "assistant"].includes(o.payload.role)).slice(-4);
  console.log("  rollout 里注入那几行的形状：" + Object.keys(injected[0]).sort().join(",") + " / payload " + Object.keys(injected[0].payload).sort().join(","));
  const tailOf = (rows) => rows.map((o) => ({ role: o.payload.role, text: o.payload.content.map((b) => b.text).join("") }));
  const roll = path.join(d, "rollout.jsonl");
  fs.writeFileSync(roll, real.map((o) => JSON.stringify(o)).join("\n") + "\n");
  check("真 rollout：最后 4 条跟注入的逐条一致 → ok", verifyInjected({ rolloutPath: roll, items: tailToResponseItems(tailOf(injected)) }).ok);
  const wrong = tailOf(injected); wrong[1] = { ...wrong[1], text: wrong[1].text + "x" };
  check("改一个字 → 对不上", !verifyInjected({ rolloutPath: roll, items: tailToResponseItems(wrong) }).ok);
  check("rollout 路径不知道 → 不算过", !verifyInjected({ rolloutPath: "", items: tailToResponseItems(tailOf(injected)) }).ok);

  // 假驱动：injectItems 按**真 rollout 那几行的形状**往文件里追加（拿真行当模板，只换正文）
  const header = real.filter((o) => !injected.includes(o));
  const tpl = { user: injected.find((o) => o.payload.role === "user"), assistant: injected.find((o) => o.payload.role === "assistant") };
  function fakeDriver({ file, failInject = false } = {}) {
    const calls = { inject: [], turns: [] };
    fs.writeFileSync(file, header.map((o) => JSON.stringify(o)).join("\n") + "\n");
    return {
      calls,
      threadId: "", threadPath: "",
      async ensure() {},
      async startThread() { this.threadId = "01a1-fake"; this.threadPath = file; return this.threadId; },
      async resumeThread() { return false; },
      async injectItems(its) {
        if (failInject) throw new Error("模拟 RPC 失败");
        calls.inject.push(its);
        for (const it of its) {
          const t = tpl[it.role];
          fs.appendFileSync(file, JSON.stringify({ ...t, payload: { ...t.payload, content: [{ ...t.payload.content[0], text: it.content[0].text }] } }) + "\n");
        }
        return {};
      },
      async runTurn(input) { calls.turns.push(input); return { text: "嗯", usage: null }; },
      async interrupt() {}, async close() {},
    };
  }
  const fd = fakeDriver({ file: path.join(d, "r1.jsonl") });
  await fd.startThread();
  const r1 = await rebuildCodexThread({ driver: fd, tail: [{ role: "user", text: "她的话" }, { role: "assistant", text: "他的话" }] });
  check("插头：inject + 回读一致 → ok/verified", r1.ok && r1.verified && r1.injected === 2, JSON.stringify(r1));
  const fd2 = fakeDriver({ file: path.join(d, "r2.jsonl"), failInject: true });
  await fd2.startThread();
  const r2 = await rebuildCodexThread({ driver: fd2, tail: [{ role: "user", text: "a" }] });
  check("inject 失败 → ok:false（什么都没塞，调用方照旧文字垫底）", r2.ok === false);

  console.log("[4] 接线：codex 插头起新 thread 时按开关垫历史（真 codex-runtime，假驱动）");
  const { createCodexRuntime } = require("../../cli-host/codex-runtime");
  async function runCodex({ forge, legacyEnv = false }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-forge-"));
    const auth = path.join(root, "auth.json");
    fs.writeFileSync(auth, JSON.stringify({ auth_mode: "chatgpt", tokens: {} }));
    const now = Date.now();
    const coldRows = fs.readFileSync(path.join(FIX, "cold-for-outbox.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
      .slice(0, 2).flatMap((r, i) => [{ id: `cold-ev-${i}-user`, role: "user", at: new Date(now - 600000 + i * 1000).toISOString(), text: `她#${i}` },
        { ...r, at: new Date(now - 599500 + i * 1000).toISOString(), text: `他#${i}` }]);
    fs.writeFileSync(path.join(root, "cold.jsonl"), coldRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    if (forge !== undefined) fs.writeFileSync(path.join(root, "tools.json"), JSON.stringify({ forge }));
    let drv = null;
    const env = { GATE_ROOT: root, ...(legacyEnv ? { FORGE_ENABLED: "true" } : {}) };
    const rt = createCodexRuntime({ ingressPath: path.join(root, "state", "ingress.json"), cwd: root, env, authFile: auth,
      driverFactory: () => (drv = fakeDriver({ file: path.join(root, "rollout.jsonl") })) });
    await rt.start();
    rt.enqueue({ uuid: "u-1", origin: { channel: "box", threadId: "box", recipient: "gate" },
      message: { type: "user", message: { role: "user", content: "现在这句" } } });
    for (let i = 0; i < 100 && !drv.calls.turns.length; i += 1) await sleep(10);
    await rt.close();
    return drv.calls;
  }
  const on = await runCodex({ forge: true });
  check("forge:true → 起新 thread 时 inject 了冷层尾巴（4 条真实轮）", on.inject.length === 1 && on.inject[0].length === 4, JSON.stringify(on.inject.map((x) => x.length)));
  check("forge:true → 第一轮不再拼「【接上次…】」文字（没重复垫）", on.turns.length === 1 && !JSON.stringify(on.turns[0]).includes("接上次"));
  check("注入的用户轮带时间前缀（跟 claude forge 同一条尾巴管线）", /^\[\d{4}-\d\d-\d\d \d\d:\d\d\]/.test(on.inject[0][0].content[0].text), on.inject[0][0].content[0].text);
  const off = await runCodex({ forge: false });
  check("forge:false → 不 inject，照旧第一轮拼冷层文字（今天的样子）", off.inject.length === 0 && JSON.stringify(off.turns[0]).includes("接上次"));
  const legacy = await runCodex({ legacyEnv: true });
  check("没写 tools.json、FORGE_ENABLED=true → 也开", legacy.inject.length === 1);
  const none = await runCodex({});
  check("都没写 → 关（Iris今天的默认）", none.inject.length === 0);

  console.log(`forge 共享开关 + codex 插头：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
