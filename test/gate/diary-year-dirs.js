"use strict";
// 2026-10-22：底子里的「近 3 天日记」两种摆法都认 —— 平铺 diary/YYYY-MM-DD.md（Nova）、按年 diary/YYYY/YYYY-MM-DD.md（Iris）。
//   [1] 年份目录能读到近 3 天
//   [2] 跨年（01-01 往回看 12-31、12-30）各自去对应年份的目录找
//   [3] 平铺 + 年份混合；同一天两处都有 → 以平铺为准、不合并
//   [4] 回归：只有平铺文件时（Nova的摆法），输出跟改之前的实现逐字节一样（含空文件、缺天）
//   [5] 隔离：只在本角色的 diaryDir 底下找；另一个角色的日记目录里同一天有文件也不读
const fs = require("fs"); const os = require("os"); const path = require("path");
const { loadRecentDiary } = require("../../src/box/instructions");
const { INTERNAL_TZ } = require("../../src/core/outward-tz");

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { if (ok) { pass++; console.log("  OK   " + n); } else { fail++; console.log("  FAIL " + n + "  " + extra); } };
const fmt = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: INTERNAL_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const daysAgo = (now, i) => { const d = new Date(now); d.setDate(d.getDate() - i); return fmt(d); };
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const top = fs.mkdtempSync(path.join(os.tmpdir(), "diary-year-"));

// 改之前的实现（原文照抄，只把 now 提成参数），回归的尺子
function oldLoadRecentDiary(config = {}, days = 3, now = new Date()) {
  const diaryDir = typeof config.diaryDir === "string" ? config.diaryDir.trim() : "";
  if (!diaryDir) return "";
  try {
    const entries = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: INTERNAL_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
      const filePath = path.join(diaryDir, `${dateStr}.md`);
      try {
        const content = fs.readFileSync(filePath, "utf8").trim();
        if (content) entries.push(`### ${dateStr}\n\n${content}`);
      } catch { /* no entry */ }
    }
    return entries.join("\n\n---\n\n");
  } catch { return ""; }
}

const now = new Date();
console.log("[1] 年份目录能读到近 3 天");
{
  const dir = path.join(top, "hz1", "diary");
  for (let i = 0; i < 4; i++) { const ds = daysAgo(now, i); put(path.join(dir, ds.slice(0, 4), `${ds}.md`), `年份目录 ${ds}`); }
  const out = loadRecentDiary({ diaryDir: dir }, 3, now);
  check("三天都在、按新到旧", [0, 1, 2].every((i) => out.includes(`### ${daysAgo(now, i)}\n\n年份目录 ${daysAgo(now, i)}`))
    && out.indexOf(daysAgo(now, 0)) < out.indexOf(daysAgo(now, 2)), out);
  check("第 4 天不带", !out.includes(daysAgo(now, 3)));
}

console.log("[2] 跨年");
{
  const dir = path.join(top, "hz2", "diary");
  // 东八区 01-01 中午 = UTC 04:00；INTERNAL_TZ 不管是哪个，按它算出来的日期去建文件
  const ny = new Date("2027-01-01T04:00:00Z");
  const want = [0, 1, 2].map((i) => daysAgo(ny, i));
  for (const ds of want) put(path.join(dir, ds.slice(0, 4), `${ds}.md`), `跨年 ${ds}`);
  const out = loadRecentDiary({ diaryDir: dir }, 3, ny);
  check(`三天都读到（${want.join(" / ")}）`, want.every((ds) => out.includes(`### ${ds}\n\n跨年 ${ds}`)), out);
  check("确实跨了年（两个年份目录都用上了）", new Set(want.map((d) => d.slice(0, 4))).size === 2, want.join(","));
}

console.log("[3] 平铺 + 年份混合；同一天两处都有以平铺为准");
{
  const dir = path.join(top, "mix", "diary");
  const [d0, d1, d2] = [0, 1, 2].map((i) => daysAgo(now, i));
  put(path.join(dir, `${d0}.md`), `平铺 ${d0}`);
  put(path.join(dir, d0.slice(0, 4), `${d0}.md`), `年份 ${d0}`);
  put(path.join(dir, d1.slice(0, 4), `${d1}.md`), `年份 ${d1}`);
  put(path.join(dir, `${d2}.md`), `平铺 ${d2}`);
  const out = loadRecentDiary({ diaryDir: dir }, 3, now);
  check("今天：用平铺那份", out.includes(`平铺 ${d0}`));
  check("今天：年份那份不合并进来", !out.includes(`年份 ${d0}`));
  check("昨天：只有年份目录 → 读到", out.includes(`年份 ${d1}`));
  check("前天：只有平铺 → 读到", out.includes(`平铺 ${d2}`));
  check("每天只出现一次", [d0, d1, d2].every((d) => out.split(`### ${d}`).length === 2), out);
}

console.log("[4] 回归：只有平铺时跟原实现逐字节一样");
{
  const dir = path.join(top, "nova", "diary");
  const [d0, , d2] = [0, 1, 2].map((i) => daysAgo(now, i));
  put(path.join(dir, `${d0}.md`), `  Nova今天\n\n## 小标题\n正文  \n`);
  put(path.join(dir, `${d2}.md`), "");   // 空文件：两版都跳过
  put(path.join(dir, `${daysAgo(now, 5)}.md`), "太早的");
  check("fixture：新 = 旧", loadRecentDiary({ diaryDir: dir }, 3, now) === oldLoadRecentDiary({ diaryDir: dir }, 3, now));
  check("空 diaryDir：新 = 旧 = 空", loadRecentDiary({}, 3, now) === "" && oldLoadRecentDiary({}, 3, now) === "");
  check("目录不存在：新 = 旧", loadRecentDiary({ diaryDir: path.join(top, "nope") }, 3, now) === oldLoadRecentDiary({ diaryDir: path.join(top, "nope") }, 3, now));
  // 平铺有、但是空文件：以平铺为准 → 这天跳过，不去年份目录捞（跟原实现一样跳过）
  const dir2 = path.join(top, "nova2", "diary");
  put(path.join(dir2, `${d0}.md`), "");
  put(path.join(dir2, d0.slice(0, 4), `${d0}.md`), "年份里的");
  check("平铺空文件 → 这天跳过（以平铺为准）", loadRecentDiary({ diaryDir: dir2 }, 1, now) === "");
}

console.log("[5] 隔离：只读本角色 diaryDir 底下");
{
  const mine = path.join(top, "iso", "iris", "diary");
  const other = path.join(top, "iso", "nova", "diary");
  const d0 = daysAgo(now, 0);
  put(path.join(other, `${d0}.md`), "NOVA-ONLY 另一个角色的平铺");
  put(path.join(other, d0.slice(0, 4), `${d0}.md`), "NOVA-ONLY 另一个角色的年份");
  put(path.join(path.dirname(mine), d0.slice(0, 4), `${d0}.md`), "NOVA-ONLY diaryDir 外面的");
  fs.mkdirSync(mine, { recursive: true });
  check("自己目录空 → 什么都不读（不往外找）", loadRecentDiary({ diaryDir: mine }, 3, now) === "");
  put(path.join(mine, d0.slice(0, 4), `${d0}.md`), "我自己的");
  const out = loadRecentDiary({ diaryDir: mine }, 3, now);
  check("只读到自己的", out.includes("我自己的") && !out.includes("NOVA-ONLY"), out);
}

console.log(`\n日记两种摆法：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
