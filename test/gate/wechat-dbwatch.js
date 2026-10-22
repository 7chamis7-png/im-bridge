"use strict";
/**
 * 微信采集器：搬过来的那份跟老桥那份**规则一致**（2026-09-18）
 *
 * 它是从 src/adapters/channel/android-wechat/linux-db-watch.py **原样抄**的，
 * 只改了三处（路径从参数来 / 产出交给调用方 / 游标不落盘）。
 * 老桥那份还在 pm2 42 上跑，**两份会漂移** —— 这个文件就是盯着别漂。
 *
 * ⚠️ 搬这种东西最容易漏的是**紧跟在难段后面的几个 if**
 *（记忆 feedback-port-the-filters-too）。所以这里逐条点名，少一条就红。
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
const OLD = path.join(__dirname, "..", "..", "src/adapters/channel/android-wechat/linux-db-watch.py");
const mine = fs.readFileSync(MINE, "utf8");
/** 只看代码行 —— 注释里讲历史的不算（守卫别把自己的文档当成代码抓） */
const codeOnly = (s) => s.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const mineCode = codeOnly(mine);
const old = fs.existsSync(OLD) ? fs.readFileSync(OLD, "utf8") : "";

console.log("[1] 四条过滤条件一条都不许漏");
{
  check("① 方向：他自己发的跳过", /if m\["sender"\] == me:\s*\n\s*continue/.test(mine), true);
  check("② 白名单 fail-closed（**不是** `if allow and ...`）",
    /if from_name not in allow and wxid not in allow:/.test(mine), true);
  // ⚠️ 只看代码行：头注释里引用过旧写法当反面教材，别把文档抓成违规
  check("②b 而且没有退回旧写法", /if allow and /.test(mineCode), false);
  check("③ 空正文不投", /if not m\["body"\]:\s*\n\s*continue/.test(mine), true);
  check("④ mtime 短路（文件没变不查库）", /if prev == stamp and rel in cursors:/.test(mine), true);
  check("⑤ 白名单为空 → 不采集**且不推进游标**", /不采集、不推进游标|停止采集/.test(mine), true);
}

console.log("\n[2] 抄过来只改了三处，别的跟老桥一致");
if (!old) {
  console.log("  --  老桥那份已经删了（切换完成），这节跳过");
} else {
  // 归一化：把**预期内的两处**挖掉，剩下的逻辑仍然逐字比 —— 这条纪律是防重写，
  // 不是禁止修 bug。挖掉的是：
  //   · raw_hex —— 插头的 toDelivery 自己解正文，比 format_body 认得全
  //   · server_id —— 语音字节在 media_0.db/VoiceInfo，靠它对上。**老桥那份也漏了**，
  //     所以微信语音在新旧桥上都没真通过（2026-09-18 Nova「还是听不见」查出来，
  //     补完真库干跑取到 96KB WAV）。补漏不算重写。
  const core = (s) => {
    const m = codeOnly(s).match(/def query_new_messages[\s\S]*?\n    return found, new_since/);
    if (!m) return "";
    return m[0]
      .replace(/sql = \([\s\S]*?\n        \)/, "SQL")        // SQL 拼接整段挖掉
      .replace(/"raw_hex":\s*parts\[4\] or "",?/, "")
      .replace(/"server_id":\s*parts\[5\] or "",?/, "")
      .replace(/if len\(parts\) < \d+:/, "if len(parts) < N:")
      .replace(/\s+/g, " ");
  };
  check("查库那段只多了 raw_hex 和 server_id，别的一字没改", core(mine), core(old));
  check("表名判据一样（Msg_ + 32 位十六进制）",
    /Msg_\[0-9a-f\]\{32\}/.test(mine) && /Msg_\[0-9a-f\]\{32\}/.test(old), true);
  check("会话表名靠 md5(wxid) 匹配", /hashlib\.md5\(wxid\.encode\(\)\)\.hexdigest\(\) == digest/.test(mine), true);
}

console.log("\n[3] --once 模式：**不写任何文件**（游标归共用层）");
{
  const once = mine.slice(mine.indexOf("def run_once"));
  check("有 --once 入口", /"--once" not in sys\.argv/.test(mine), true);
  check("不写 inbox", /append_inbox/.test(once), false);
  check("不写 state", /save_state/.test(once), false);
  check("游标吃进来", /--cursor/.test(once), true);
  check("游标吐出去", /"cursor": state/.test(once), true);
  check("路径从参数来（铁律 1）", /--keys/.test(once) && /--whitelist/.test(once), true);
  // ⚠️ 第一版我留了 `/root/wxkey/...` 当默认值，铁律自查当场抓出来。
  // 留默认 = 拷到别的机器上它会去读一个不存在的路径，正是铁律 1 要防的。
  check("**一个写死的路径都没有**", /"\/root\//.test(codeOnly(mine)), false);
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
