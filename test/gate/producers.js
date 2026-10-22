"use strict";
/**
 * 生产者投递口：桥外面的东西怎么推一轮进来（2026-09-18）
 * 盯的是：多进程同时投不丢、消化完了才删、坏文件不卡住后面的、有轮在飞就等。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { putNote, makeProducerInbox } = require("../../src/gate/producers");

let pass = 0, fail = 0;
const check = (n, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(g)} want=${JSON.stringify(w)}`));
  ok ? pass++ : fail++;
};
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-prod-"));
const files = (d) => fs.readdirSync(d).filter((f) => f.endsWith(".json") && !f.startsWith("."));

(async () => {
  console.log("[1] 投一条、消化一条");
  {
    const dir = path.join(root, "a");
    putNote({ dir, producer: "checkin", text: "她又浮上心头" });
    const inbox = makeProducerInbox({ dir });
    check("攒了 1 条", inbox.pending(), 1);
    const got = [];
    const r = await inbox.drain(async (n) => { got.push(n); });
    check("消化成功", [r.ok, r.failed], [1, 0]);
    check("正文和生产者都带过来了", [got[0].text, got[0].producer], ["她又浮上心头", "checkin"]);
    check("消化完文件就删了", files(dir).length, 0);
  }

  console.log("\n[2] **多个生产者同时投不会互相覆盖**（老桥单文件队列的坑）");
  {
    const dir = path.join(root, "b");
    // 模拟 20 个生产者进程同时投
    for (let i = 0; i < 20; i += 1) putNote({ dir, producer: "p" + i, text: "第" + i + "条" });
    const inbox = makeProducerInbox({ dir });
    check("20 条一条不少", inbox.pending(), 20);
    const got = [];
    await inbox.drain(async (n) => { got.push(n.text); });
    check("全消化掉", got.length, 20);
    check("按时间顺序", got[0], "第0条");
  }

  console.log("\n[3] 消化完了才算数：handle 抛错 → 文件留着下次再来");
  {
    const dir = path.join(root, "c");
    putNote({ dir, producer: "x", text: "会失败的" });
    const inbox = makeProducerInbox({ dir });
    let tries = 0;
    const r1 = await inbox.drain(async () => { tries += 1; throw new Error("盒子挂了"); });
    check("这次没消化成", [r1.ok, r1.failed], [0, 1]);
    check("**文件留着，没丢**", files(dir).length, 1);
    const r2 = await inbox.drain(async () => { tries += 1; });
    check("下次再来就成了", r2.ok, 1);
    check("一共试了两次", tries, 2);
    check("这回删掉了", files(dir).length, 0);
  }

  console.log("\n[4] 重复的不投两遍（上次崩在删文件之前）");
  {
    const dir = path.join(root, "d");
    const { file } = putNote({ dir, producer: "x", text: "只该投一次" });
    const raw = fs.readFileSync(file, "utf8");
    const inbox = makeProducerInbox({ dir });
    let n = 0;
    await inbox.drain(async () => { n += 1; });
    fs.writeFileSync(file, raw);                    // 同一条又冒出来（同一个 id）
    await inbox.drain(async () => { n += 1; });
    check("只进了一次盒子", n, 1);
    check("重复的那份也清掉了", files(dir).length, 0);
  }

  console.log("\n[5] 坏文件不许卡住后面的，也不许无声消失");
  {
    const dir = path.join(root, "e");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "2026-01-01-bad.json"), "{ 这不是 json");
    putNote({ dir, producer: "x", text: "后面这条得进去" });
    const inbox = makeProducerInbox({ dir });
    const got = [];
    const r = await inbox.drain(async (n) => { got.push(n.text); });
    check("好的那条照样消化", got, ["后面这条得进去"]);
    check("坏的记一笔 failed", r.failed, 1);
    check("坏文件留成 .bad 证据，不是删掉",
      fs.readdirSync(dir).filter((f) => f.endsWith(".bad")).length, 1);
  }

  console.log("\n[6] 投的时候就把话说清楚");
  {
    const dir = path.join(root, "f");
    const bad = (o) => { try { putNote({ dir, ...o }); return ""; } catch (e) { return e.message; } };
    check("没正文 → 报", /没有正文/.test(bad({ producer: "x", text: "  " })), true);
    check("没说谁推的 → 报", /是谁推的/.test(bad({ producer: "", text: "y" })), true);
    check("没目录 → 报", /要一个目录/.test((() => {
      try { putNote({ producer: "x", text: "y" }); return ""; } catch (e) { return e.message; }
    })()), true);
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}   (隔离目录 ${root})`);
  process.exit(fail ? 1 : 0);
})();
