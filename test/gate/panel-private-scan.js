"use strict";
/**
 * 私货扫描：面板要随仓库公开，面板相关的文件里不能有真实角色名 / 主人名 / 私人路径 / 域名 / chat id 之类。
 *
 * 词表**不放在仓库里**（放进来就等于公开了）：PRIVATE_WORDS_FILE 指一个仓库外的文本文件，每行一个词。
 *   · 空行、# 开头的行忽略
 *   · 大小写不敏感，按子串匹配
 *   · allow:<原文> 开头的行是豁免：先把这些原文从内容里抠掉再查（比如桥本来就有的 env 名）
 * 没设 PRIVATE_WORDS_FILE → 打印「未配置私货词表，跳过」，算通过。格式样例见 examples/private-words.example。
 *
 * 扫的范围：src/panel/**、docs/panel*、examples/panel*、test/panel-fixture.js、test/gate/panel*.js（二进制图片不扫）。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const file = String(process.env.PRIVATE_WORDS_FILE || "").trim();
if (!file) { console.log("  SKIP 未配置私货词表，跳过（设 PRIVATE_WORDS_FILE=仓库外的词表文件）"); process.exit(0); }
let raw;
try { raw = fs.readFileSync(file, "utf8"); } catch (e) { console.log("  FAIL 词表读不了：" + e.message); process.exit(1); }
const words = [], allow = [];
for (const line of raw.split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  if (t.startsWith("allow:")) { const a = t.slice(6); if (a) allow.push(a); } else words.push(t.toLowerCase());
}

const BIN = new Set([".png", ".webp", ".jpg", ".jpeg", ".gif", ".ico", ".avif"]);
function walk(p, out) {
  let st; try { st = fs.statSync(p); } catch { return; }
  if (st.isDirectory()) { for (const n of fs.readdirSync(p)) walk(path.join(p, n), out); return; }
  if (!BIN.has(path.extname(p).toLowerCase())) out.push(p);
}
const targets = [];
walk(path.join(ROOT, "src", "panel"), targets);
for (const [dir, re] of [["docs", /^panel/], ["examples", /^panel/], ["test", /^panel-fixture\.js$/], [path.join("test", "gate"), /^panel/]]) {
  for (const n of fs.readdirSync(path.join(ROOT, dir))) if (re.test(n)) walk(path.join(ROOT, dir, n), targets);
}

let hits = 0;
for (const f of targets) {
  let text = fs.readFileSync(f, "utf8");
  for (const a of allow) text = text.split(a).join("");
  const lower = text.toLowerCase();
  for (const w of words) {
    let i = lower.indexOf(w);
    while (i >= 0) {
      const line = lower.slice(0, i).split("\n").length;
      console.log(`  FAIL ${path.relative(ROOT, f)}:${line} 命中第 ${words.indexOf(w) + 1} 个词`);   // 不打印词本身
      hits++;
      i = lower.indexOf(w, i + 1);
    }
  }
}
console.log(`\n扫了 ${targets.length} 个文件、${words.length} 个词：${hits ? hits + " 处命中" : "干净"}`);
console.log(`${hits ? 0 : 1} 过 / ${hits ? 1 : 0} 挂`);
process.exit(hits ? 1 : 0);
