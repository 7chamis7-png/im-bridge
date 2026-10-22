// 2026-10-22 数据隔离守卫：同机多个人格，任何一样「他的东西」没配置就必须拒绝 / 留空，
// 不许回落到写死的另一个人格的目录（10-22 测试角色换舱读到了Nova的笔记本）。
// 做法：干净 env（只给 HOME/PATH）起子进程，逐项看行为；再 grep 源码不许出现回落写法。
"use strict";
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..", "..");
let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : "  " + extra)); ok ? pass++ : fail++; };

const run = (code, env = {}) => {
  try { return { out: execFileSync(process.execPath, ["-e", code], { env: { HOME: "/root", PATH: process.env.PATH, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() }; }
  catch (e) { return { err: String(e.stderr || e.message) }; }
};
const R = JSON.stringify(ROOT);

console.log("\n[1] 没配置 → 拒绝或留空");
check("personaStateDir 没 NOVA_STATE_DIR 报错", !!run(`require(${R}+"/src/core/paths").personaStateDir()`).err);
check("gateRoot 没 GATE_ROOT 报错", !!run(`require(${R}+"/src/core/paths").gateRoot()`).err);
const tmp = fs.mkdtempSync("/tmp/iso-");
fs.writeFileSync(path.join(tmp, "store.js"), 'exports.render = ({ file } = {}) => file ? "FAKE-NOTE " + file : "DEFAULT-FILE-LEAK";');
const nbCode = (cfg) => `const i=require(${R}+"/src/box/instructions"); process.stdout.write(JSON.stringify(/PENDING PROMISES/.test(i.buildForgeBaseText(${JSON.stringify(cfg)}))))`;
check("笔记本没给 → 底子里没有 PENDING PROMISES（本机有 ~/nova-notebook 也不读）", run(nbCode({})).out === "false");
check("只给模块不给文件 → 也不读（不许走模块自己的默认文件）", run(nbCode({ notebookModule: path.join(tmp, "store") })).out === "false");
check("阳性对照：模块+文件都给 → 有", run(nbCode({ notebookModule: path.join(tmp, "store"), notebookFile: path.join(tmp, "n.json") })).out === "true");
const eng = run(`const {createEngineFactories}=require(${R}+"/cli-host/engines"); try{createEngineFactories({env:{},stateDir:"/tmp/x",workspace:"/tmp",requireCodexHome:false})["codex-appserver"]({});console.log("STARTED")}catch(e){console.log("REFUSED")}`);
check("codex 没 CODEX_HOME（哪怕 requireCodexHome:false）→ 拒绝", eng.out === "REFUSED", JSON.stringify(eng));

console.log("\n[2] 源码里不许有回落到写死人格目录的写法（scripts/retired-*、scripts/satellites 是Nova一个人的旧脚本，不属于桥，不扫）");
const BAD = [
  /homePath\(\s*["']\.nova(-gate|-deepseek)?["']/, /homePath\(\s*["']nova["']/, /homePath\(\s*["']identity-brain/,
  /homePath\(\s*["']nova-notebook["']\s*,\s*["']store["']/, /homePath\(\s*["']wxkey["']/, /homePath\(\s*["']\.codex["']/,
  /join\(\s*(userHome|homeDir|os\.homedir)\(\)\s*,\s*["']\.codex["']/,
  // 2026-10-22 Fable 指出守卫漏掉的形状：path.join(homeDir(env) / os.homedir(), "nova" / ".nova" / "nova-notebook" …)
  /join\(\s*(userHome|homeDir|os\.homedir)\([^)]*\)\s*,\s*["'](\.?nova|\.nova-gate|\.nova-deepseek|nova-notebook|identity-brain[^"']*|wxkey)["']/,
];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === "node_modules" || e.name === "test" || /^retired-/.test(e.name) || e.name === "satellites" ? [] : walk(path.join(d, e.name))) : e.name.endsWith(".js") ? [path.join(d, e.name)] : []);
const hits = [];
for (const dir of ["src", "cli-host", "host", "adapters", "runtime", "tools", "scripts"]) {
  if (!fs.existsSync(path.join(ROOT, dir))) continue;
  for (const f of walk(path.join(ROOT, dir))) {
    fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (/^\s*(\*|\/\/)/.test(line)) return;
      if (BAD.some((re) => re.test(line))) hits.push(path.relative(ROOT, f) + ":" + (i + 1));
    });
  }
}
check("没有回落写法", hits.length === 0, hits.join(" "));

console.log(`\n${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
