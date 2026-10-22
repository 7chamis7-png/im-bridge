"use strict";
/**
 * 技能包搬进桥（2026-10-21 第 3 步）：list_skills / read_skill。
 *
 *   · 目录跟人走（SKILLS_DIRS），软链技能能读（gpt-image-2 在生产就是软链）
 *   · 读说明书 / 读包里的文件；出了技能目录的一律不读
 *   · 真起一次 MCP 进程：initialize + tools/list + tools/call
 *   · 开关走 tools.json（enabled:false / exclude）
 * 全程临时目录。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { makeTools, scanSkills, parseFrontmatter } = require("../../tools/skills/tools");
const { renderToolServers } = require("../../src/toolbox/render");

let pass = 0, fail = 0;
const check = (n, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(g)} want=${JSON.stringify(w)}`));
  ok ? pass++ : fail++;
};
const truthy = (n, v) => check(n, !!v, true);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skills-tool-"));
const dirA = path.join(tmp, "a");
const dirB = path.join(tmp, "b");
const elsewhere = path.join(tmp, "elsewhere", "painter");
fs.mkdirSync(path.join(dirA, "chuanda"), { recursive: true });
fs.writeFileSync(path.join(dirA, "chuanda", "SKILL.md"), "---\nname: chuanda\ndescription: 穿搭验收。\n---\n\n# 标准\n领口往下开。\n");
fs.mkdirSync(path.join(elsewhere, "scripts"), { recursive: true });
fs.writeFileSync(path.join(elsewhere, "SKILL.md"), "---\nname: painter\ndescription: >\n  画画用的。\n  第二行。\n---\n跑 scripts/gen.js\n");
fs.writeFileSync(path.join(elsewhere, "scripts", "gen.js"), "console.log('hi')\n");
fs.symlinkSync(path.relative(dirA, elsewhere), path.join(dirA, "painter"));   // 跟生产一样是相对软链
fs.mkdirSync(path.join(dirA, "no-skill-md"));
fs.mkdirSync(path.join(dirB, "chuanda"), { recursive: true });
fs.writeFileSync(path.join(dirB, "chuanda", "SKILL.md"), "---\nname: chuanda\n---\n后面那份\n");
fs.writeFileSync(path.join(tmp, "secret.txt"), "不该读到\n");

function rpc(child, msg) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d) => {
      buf += d;
      const line = buf.split("\n").find((l) => l.trim() && JSON.parse(l).id === msg.id);
      if (line) { child.stdout.off("data", onData); resolve(JSON.parse(line)); }
    };
    child.stdout.on("data", onData);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
    setTimeout(() => reject(new Error("超时 " + msg.method)), 5000);
  });
}

async function main() {
  console.log("零件");
  check("--- 头：折叠块拼起来", parseFrontmatter("---\nname: x\ndescription: >\n  一\n  二\n---\nbody").meta, { name: "x", description: "一 二" });
  const { skills, problems } = scanSkills([dirA, dirB, path.join(tmp, "nope")]);
  check("扫到两个（软链的也算）", [...skills.keys()].sort(), ["chuanda", "painter"]);
  check("软链解到真目录", skills.get("painter").dir, fs.realpathSync(elsewhere));
  check("同名：先到先得（目录顺序 = 优先级）", skills.get("chuanda").dir, path.join(dirA, "chuanda"));
  truthy("问题都说出来：缺 SKILL.md / 重名 / 目录读不到",
    problems.some((p) => p.includes("no-skill-md")) && problems.some((p) => p.includes("重名")) && problems.some((p) => p.includes("nope")));

  console.log("两个工具");
  const [list, read] = makeTools({ dirs: [dirA, dirB] });
  truthy("list_skills 的说明里带目录（他不调也知道有啥）", list.description.includes("chuanda") && list.description.includes("painter"));
  const l = await list.handler({});
  check("list_skills 回名字 + 说明", l.data.skills.map((s) => s.name).sort(), ["chuanda", "painter"]);
  const r = await read.handler({ name: "painter" });
  truthy("read_skill 给说明书 + 技能目录 + 包里的文件", r.includes("跑 scripts/gen.js") && r.includes("技能目录：" + fs.realpathSync(elsewhere)) && r.includes("scripts/gen.js"));
  const rf = await read.handler({ name: "painter", file: "scripts/gen.js" });
  truthy("read_skill file= 读包里的文件", rf.includes("console.log('hi')"));
  let e1 = null; try { await read.handler({ name: "painter", file: "../../secret.txt" }); } catch (e) { e1 = e; }
  truthy("出了技能目录 → 不读", e1 && /不在技能目录里|没有/.test(e1.message));
  let e2 = null; try { await read.handler({ name: "没有这个" }); } catch (e) { e2 = e; }
  truthy("没有这个技能 → 说现有哪些", e2 && e2.message.includes("chuanda"));
  // 现扫：新丢进去一个不用重启
  fs.mkdirSync(path.join(dirB, "fresh"));
  fs.writeFileSync(path.join(dirB, "fresh", "SKILL.md"), "新的\n");
  check("新技能丢进目录，下一次 list 就有", (await list.handler({})).data.skills.map((s) => s.name).sort(), ["chuanda", "fresh", "painter"]);

  console.log("真起 MCP 进程");
  const child = spawn(process.execPath, [path.join(__dirname, "..", "..", "tools", "skills", "mcp-server.js")],
    { env: { PATH: process.env.PATH, SKILLS_DIRS: `${dirA}:${dirB}` }, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  try {
    await rpc(child, { id: 1, method: "initialize", params: {} });
    const tl = await rpc(child, { id: 2, method: "tools/list" });
    check("tools/list", tl.result.tools.map((t) => t.name), ["list_skills", "read_skill"]);
    const call = await rpc(child, { id: 3, method: "tools/call", params: { name: "read_skill", arguments: { name: "chuanda" } } });
    truthy("tools/call read_skill", !call.result.isError && call.result.content[0].text.includes("领口往下开"));
  } finally { child.kill(); }
  const bare = spawn(process.execPath, [path.join(__dirname, "..", "..", "tools", "skills", "mcp-server.js")], { env: { PATH: process.env.PATH } });
  const code = await new Promise((res) => bare.on("exit", res));
  check("没有 SKILLS_DIRS → 不猜，退出", code, 1);

  console.log("开关走 tools.json");
  const cfg = (extra) => { const f = path.join(tmp, `t-${Math.random().toString(16).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify({ persona: "p", vars: { STATE_DIR: tmp }, ...extra })); return f; };
  const base = { gateRoot: tmp, toolSocket: path.join(tmp, "tools.sock") };
  const on = renderToolServers({ ...base, configFile: cfg({}) });
  check("默认挂上，目录 = ${STATE_DIR}/skills", on.servers.skills && on.servers.skills.env, { SKILLS_DIRS: path.join(tmp, "skills") });
  const custom = renderToolServers({ ...base, configFile: cfg({ vars: { STATE_DIR: tmp, SKILLS_DIRS: `${dirA}:${dirB}` } }) });
  check("人格配置可以指过去（多个目录）", custom.servers.skills.env.SKILLS_DIRS, `${dirA}:${dirB}`);
  const off = renderToolServers({ ...base, configFile: cfg({ servers: { skills: { enabled: false } } }) });
  check("servers.skills.enabled:false → 不挂", !!off.servers.skills, false);
  const ex = renderToolServers({ ...base, configFile: cfg({ exclude: ["skills"] }) });
  check("exclude → 不挂", !!ex.servers.skills, false);
  const noState = renderToolServers({ ...base, configFile: (() => { const f = path.join(tmp, "nostate.json"); fs.writeFileSync(f, "{}"); return f; })() });
  check("没 STATE_DIR → 不挂（不回落到别人家）", !!noState.servers.skills, false);

  console.log(`\n技能包：通过 ${pass} / ${pass + fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
