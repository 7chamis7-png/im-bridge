"use strict";
/**
 * WeChat DB reader guard: the filtering rules in db-watch.py must all be present,
 * and --once mode must not write any files (the cursor belongs to the shared layer).
 */
const fs = require("fs");
const path = require("path");
let pass = 0, fail = 0;
const check = (n, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(g)} want=${JSON.stringify(w)}`));
  ok ? pass++ : fail++;
};
const MINE = path.join(__dirname, "..", "..", "src/gate/plugins/wechat/db-watch.py");
const mine = fs.readFileSync(MINE, "utf8");
/** code lines only (ignore comments) */
const codeOnly = (s) => s.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const mineCode = codeOnly(mine);

console.log("[1] 四条过滤条件一条都不许漏");
{
  check("① direction: own messages are skipped", /if m\["sender"\] == me:\s*\n\s*continue/.test(mine), true);
  check("② 白名单 fail-closed（**不是** `if allow and ...`）",
    /if from_name not in allow and wxid not in allow:/.test(mine), true);
  check("②b 而且没有退回旧写法", /if allow and /.test(mineCode), false);
  check("③ 空正文不投", /if not m\["body"\]:\s*\n\s*continue/.test(mine), true);
  check("④ mtime 短路（文件没变不查库）", /if prev == stamp and rel in cursors:/.test(mine), true);
  check("⑤ 白名单为空 → 不采集**且不推进游标**", /不采集、不推进游标|停止采集/.test(mine), true);
}

console.log("\n[3] --once 模式：**不写任何文件**（游标归共用层）");
{
  const once = mine.slice(mine.indexOf("def run_once"));
  check("有 --once 入口", /"--once" not in sys\.argv/.test(mine), true);
  check("不写 inbox", /append_inbox/.test(once), false);
  check("不写 state", /save_state/.test(once), false);
  check("游标吃进来", /--cursor/.test(once), true);
  check("游标吐出去", /"cursor": state/.test(once), true);
  check("paths come from arguments", /--keys/.test(once) && /--whitelist/.test(once), true);
  check("no hard-coded absolute paths", /"\/(root|home)\//.test(codeOnly(mine)), false);
  check("缺参数当场报，不猜", /不许用默认值猜/.test(mine), true);
  check("只有 --once，没留常驻循环那半（没人走的路不留）",
    /def main\(/.test(mine), false);
}

console.log("\n[4] 交出去的是**原始字节**，正文解析归插头");
{
  check("带 raw_hex", /"raw_hex"/.test(mine), true);
  check("带表名和 local_id（local_id 只在表内唯一）",
    /"table": m\["table"\]/.test(mine) && /"local_id": m\["local_id"\]/.test(mine), true);
}

console.log("\n[5] 插头这头：调得起来、参数缺了当场报");
{
  const { WeChatPlugin } = require("../../src/gate/plugins/wechat");
  const p1 = new WeChatPlugin({});
  check("有 poll()", typeof p1.poll, "function");
  let msg = "";
  p1.poll({}).catch((e) => { msg = e.message; }).finally(() => {
    check("**缺 keysFile/whitelistFile 当场报**，不假装没消息", /不许用默认值猜/.test(msg), true);
    const p2 = new WeChatPlugin({ keysFile: "/x", whitelistFile: "/y" });
    check("采集器路径按本文件算，不写死", p2.watcher.endsWith("/plugins/wechat/db-watch.py"), true);
    console.log(`\n通过 ${pass} / 失败 ${fail}`);
    process.exit(fail ? 1 : 0);
  });
}

// 收尾在上面那个 finally 里（要等异步的 poll 报错回来）
