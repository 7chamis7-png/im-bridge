"use strict";
// 模型登记表（设计稿 §5.2 / §5.5）：查不到就拒绝、按量计费没开 allow 就拒绝、坏条目明说不吞。
const assert = require("assert");
const fs = require("fs"); const os = require("os"); const path = require("path");
const reg = require("../../src/box/model-registry");

let n = 0;
const ok = (m) => { n += 1; console.log("  OK  " + m); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-registry-"));
const write = (name, doc) => { const f = path.join(dir, name); fs.writeFileSync(f, typeof doc === "string" ? doc : JSON.stringify(doc)); return f; };

// 1. 没有文件：不是「空表」，是「没有登记表」—— 调用方要明说不能换
{
  const r = reg.loadModelRegistry({ file: path.join(dir, "nope.json") });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.exists, false);
  assert.ok(/没有模型登记表/.test(r.errors[0]));
  ok("没有 models.json → ok:false，明说没有");
}

// 2. 两份示例都能读
for (const who of ["nova", "iris"]) {
  const r = reg.loadModelRegistry({ file: path.join(__dirname, "..", "..", "examples", "models", `${who}.models.example.json`) });
  assert.ok(r.ok && r.models.length && !r.errors.length, JSON.stringify(r.errors));
  assert.ok(reg.lookup(r, r.default), "default 在表里");
}
ok("examples/models 两份示例读得通、default 在表里");

// 3. 精确查：[1m] 后缀是 id 的一部分
{
  const f = write("a.json", { v: 1, models: [
    { id: "claude-fable-5[1m]", engine: "claude-cli", window: 1000000, billing: "subscription", vision: true, tools: true },
    { id: "gpt-5.6-sol", engine: "codex", window: 872000, billing: "subscription" },
  ] });
  const r = reg.loadModelRegistry({ file: f });
  assert.ok(reg.lookup(r, "claude-fable-5[1m]"));
  assert.strictEqual(reg.lookup(r, "claude-fable-5"), null);
  assert.strictEqual(reg.lookup(r, "opus"), null);
  assert.strictEqual(reg.lookup(r, "gpt-5.6-sol").engine, "codex-appserver");
  ok("精确查（裸名查不到）；老引擎名 codex 认成 codex-appserver");
}

// 4. 坏条目：不进表，原因写进 errors
{
  const f = write("b.json", { v: 1, default: "ghost", models: [
    { id: "x", engine: "grok", window: 1, billing: "subscription" },
    { id: "y", engine: "claude-cli", window: -5, billing: "subscription" },
    { id: "ds", engine: "openai-chat", window: 128000, billing: "api", secret: "deepseek" },           // 缺 requiresAllow
    { id: "ds2", engine: "openai-chat", window: 128000, billing: "api", requiresAllow: "DS_ALLOW", secret: "/root/.secrets/x.secret" },
    { id: "ok", engine: "claude-cli", window: 200000, billing: "subscription" },
    { id: "ok", engine: "claude-cli", window: 200000, billing: "subscription" },
    { id: "cx", engine: "codex-appserver", window: 1, billing: "subscription", codexConfig: { sandbox_mode: 1 } },
  ] });
  const r = reg.loadModelRegistry({ file: f });
  assert.deepStrictEqual(r.models.map((m) => m.id), ["ok"]);
  assert.strictEqual(r.default, "");
  const all = r.errors.join("\n");
  for (const want of [/不认识的引擎/, /window 要是正整数/, /requiresAllow/, /secret 只写名字/, /登记了两次/, /codexConfig 不认/, /default「ghost」/]) assert.ok(want.test(all), String(want) + "\n" + all);
  ok("坏条目一条条点名（引擎 / 窗口 / 钱闸 / 钥匙写成路径 / 重复 / codexConfig 越权 / default 不在表）");
}

// 5. 不认识的版本、坏 JSON：整份不用
{
  assert.strictEqual(reg.loadModelRegistry({ file: write("c.json", { v: 2, models: [] }) }).ok, false);
  assert.strictEqual(reg.loadModelRegistry({ file: write("d.json", "{坏") }).ok, false);
  ok("v 不认识 / 坏 JSON → 整份不用，不猜");
}

// 6. 钱闸
{
  const api = { id: "ds", engine: "openai-chat", billing: "api", requiresAllow: "DEEPSEEK_ALLOW_BILLING" };
  assert.strictEqual(reg.billingAllowed(api, {}).ok, false);
  assert.ok(/DEEPSEEK_ALLOW_BILLING=1/.test(reg.billingAllowed(api, {}).why));
  assert.strictEqual(reg.billingAllowed(api, { DEEPSEEK_ALLOW_BILLING: "0" }).ok, false);
  assert.strictEqual(reg.billingAllowed(api, { DEEPSEEK_ALLOW_BILLING: "1" }).ok, true);
  assert.strictEqual(reg.billingAllowed({ billing: "subscription" }, {}).ok, true);
  assert.strictEqual(reg.billingAllowed(null, {}).ok, false);
  ok("钱闸：按量计费要 requiresAllow 那个 env 显式开着；订阅直接过");
}

// 7. 降级
{
  const claude = { id: "c", engine: "claude-cli", window: 1000000, vision: true, tools: true, verified: true };
  const ds = { id: "d", engine: "openai-chat", window: 128000, vision: false, tools: false, verified: false };
  const d = reg.degradations(claude, ds, { droppedTurns: 3 }).join("\n");
  for (const want of [/看不见图/, /没接工具/, /窗口变小/, /最旧的 3 轮/, /思考块/, /未从引擎核实/]) assert.ok(want.test(d), String(want));
  assert.deepStrictEqual(reg.degradations(claude, { ...claude, id: "c2" }), []);
  ok("降级清单：看图 / 工具 / 窗口 / 截掉的轮 / 思考块 / 窗口未核实；同家同能力 = 空");
}

// 8. 位置：GATE_MODELS_FILE 优先，其次 $GATE_ROOT/models.json
assert.strictEqual(reg.modelsFile({ GATE_ROOT: "/x" }), "/x/models.json");
assert.strictEqual(reg.modelsFile({ GATE_ROOT: "/x", GATE_MODELS_FILE: "/y.json" }), "/y.json");
ok("位置：GATE_MODELS_FILE > $GATE_ROOT/models.json");

console.log(`\n通过 ${n} / 失败 0`);
