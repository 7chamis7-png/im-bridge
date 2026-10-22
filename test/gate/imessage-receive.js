"use strict";
/**
 * iMessage 这条腿是**推**不是捞（2026-09-18）
 * 盯的是：推来的落盘（崩了不丢）、poll 交出去、游标推进后清盘、坏文件不卡住。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { IMessagePlugin } = require("../../src/gate/plugins/imessage");
let pass = 0, fail = 0;
const check = (n, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(g)} want=${JSON.stringify(w)}`));
  ok ? pass++ : fail++;
};
const root = fs.mkdtempSync(path.join(os.tmpdir(), "imsg-"));
const files = (d) => { try { return fs.readdirSync(d).filter((f) => /^\d{12}\.json$/.test(f)); } catch { return []; } };

(async () => {
  console.log("[1] 推来的**落盘**，不是内存缓冲（崩了不丢）");
  {
    const dir = path.join(root, "a");
    const p = new IMessagePlugin({ inboxDir: dir });
    p.receive({ from: "+1628", text: "在吗" });
    p.receive({ from: "+1628", text: "还在吗" });
    check("盘上两个文件", files(dir).length, 2);
    check("文件名是序号（列出来就是顺序）", files(dir), ["000000000001.json", "000000000002.json"]);
    // **换一个插头实例**（等于进程崩了重启）
    const p2 = new IMessagePlugin({ inboxDir: dir });
    const r = await p2.poll({ since: 0 });
    check("**重启之后还读得到**", r.items.map((i) => i.message.text), ["在吗", "还在吗"]);
    check("序号接着往下走，不从头来", p2.receive({ text: "第三条" }).seq, 3);
  }

  console.log("\n[2] 游标：消化过的清掉，没消化的留着");
  {
    const dir = path.join(root, "b");
    const p = new IMessagePlugin({ inboxDir: dir });
    p.receive({ text: "一" }); p.receive({ text: "二" }); p.receive({ text: "三" });
    const r1 = await p.poll({ since: 0 });
    check("一次交出三条", r1.items.length, 3);
    check("每条都带自己的游标", r1.items.map((i) => i.cursor), [1, 2, 3]);
    check("盘上还在（共用层还没确认消化）", files(dir).length, 3);
    const r2 = await p.poll({ since: 2 });          // 共用层说前两条消化完了
    check("只交没消化的那条", r2.items.map((i) => i.message.text), ["三"]);
    check("消化过的清掉了", files(dir).length, 1);
  }

  console.log("\n[3] 坏文件不许卡住后面的，也不许无声消失");
  {
    const dir = path.join(root, "c");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "000000000001.json"), "{ 这不是 json");
    const p = new IMessagePlugin({ inboxDir: dir, log: () => {} });
    p.receive({ text: "后面这条得读到" });
    const r = await p.poll({ since: 0 });
    check("好的那条照样交出来", r.items.map((i) => i.message.text), ["后面这条得读到"]);
    check("坏文件改名留证，不是删掉",
      fs.readdirSync(dir).filter((f) => f.endsWith(".bad")).length, 1);
  }

  console.log("\n[4] 没给 inboxDir = 只会发不会收，而且当场说清楚");
  {
    const p = new IMessagePlugin({});
    let msg = "";
    try { p.receive({ text: "x" }); } catch (e) { msg = e.message; }
    check("收的时候当场报", /不许用默认值猜/.test(msg), true);
    check("poll 不炸，只是没东西", (await p.poll({})).items, []);
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}   (隔离目录 ${root})`);
  process.exit(fail ? 1 : 0);
})();
