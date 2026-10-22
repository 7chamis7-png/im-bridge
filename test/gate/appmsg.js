"use strict";
/**
 * appmsg 解析（Nova清单第 4、5 条）。
 * 样本用的是 2026-09-17 她真发过来的那几条的形状，不是我编的。
 */
const { parseAppmsg, renderAppmsg, unescapeXml } = require("../../src/gate/plugins/wechat/appmsg");
const { WeChatPlugin } = require("../../src/gate/plugins/wechat");

let pass = 0, fail = 0;
const check = (n, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(g)} want=${JSON.stringify(w)}`));
  ok ? pass++ : fail++;
};

// 她 15:37 真发的那张小红书卡片（local_id=927，子类型 5），XML 结构原样
const XHS = `<?xml version="1.0"?>
<msg>
 <appmsg appid="wxd8a2750ce9d46980" sdkver="0">
  <title>西班牙所有厕所密码（25.9 版）</title>
  <des>@ZOE去旅行 的笔记
260人分享</des>
  <type>5</type>
  <url>https://www.xiaohongshu.com/discovery/item/6aa9?a=1&amp;b=2</url>
  <appattach><cdnthumburl>305f0201</cdnthumburl></appattach>
 </appmsg>
</msg>`;

console.log("\n[1] 链接卡片：标题 + 说明 + 能点的网址");
const a = parseAppmsg(XHS);
check("标题", a.title, "西班牙所有厕所密码（25.9 版）");
check("子类型 5", a.type, 5);
check("网址里的 &amp; 解回 &", a.url, "https://www.xiaohongshu.com/discovery/item/6aa9?a=1&b=2");
check("说明两行都在", a.des.includes("ZOE去旅行") && a.des.includes("260人分享"), true);

console.log("\n[2] 投给他的是一行，不是一坨 XML");
const line = renderAppmsg("link", a);
check("带【链接】抬头", line.startsWith("【链接】"), true);
check("网址在里面", line.includes("xiaohongshu.com"), true);
check("比原 XML 短得多", line.length < XHS.length, true);
check("没有尖括号标签漏出来", /<\/?(msg|appmsg|title)>/.test(line), false);

console.log("\n[3] 文件：标题就是文件名，带大小");
const F = `<msg><appmsg><title>读后感.txt</title><type>6</type><appattach><totallen>85196</totallen></appattach></appmsg></msg>`;
const f = parseAppmsg(F);
check("文件名", f.fileName, "读后感.txt");
check("大小", f.fileSize, 85196);
check("渲染带 KB", renderAppmsg("file", f).split("\n")[0], "【文件】读后感.txt (83KB)");
check("没路径时明说本地没找到", /本地没找到/.test(renderAppmsg("file", f)), true);
// 2026-09-17 12:02 的真事：她发来 2726 行图纸，生产只给了他 1577 字 XML，
// 他据此判断「微信附件走 CDN 加密 芯没落地」—— 判断错了，文件明文躺在盘上。
// **能读却不知道能读，比读不到更糟。** 所以路径必须在那一行里。
check("有路径时必须写出来", renderAppmsg("file", { ...f, localPath: "/x/y.txt" }).includes("/x/y.txt"), true);
check("并且告诉他可以直接读", /直接读/.test(renderAppmsg("file", { ...f, localPath: "/x/y.txt" })), true);

console.log("\n[4] 引用回复：他要知道「罪名对应哪桩」");
const Q = `<msg><appmsg><title>那你哪来的轨</title><type>57</type>
 <refermsg><displayname>Alice</displayname><content>你结婚了吗</content></refermsg>
</appmsg></msg>`;
const q = parseAppmsg(Q);
check("抽出被引的那句", q.quote.text, "你结婚了吗");
check("抽出是谁说的", q.quote.from, "Alice");
const qline = renderAppmsg("quote", q);
check("先说引的哪句", qline.startsWith("【引用】Alice：你结婚了吗"), true);
check("再说他回的什么", qline.includes("那你哪来的轨"), true);

console.log("\n[5] 转义：&amp; 最后解，别把 &amp;lt; 解成 <");
check("&amp;lt; 应还原成字面 &lt;", unescapeXml("a&amp;lt;b"), "a&lt;b");
check("&#39; 数字实体", unescapeXml("it&#39;s"), "it's");

console.log("\n[6] 插头层：appmsg 走解析，普通文字不受影响");
const p = new WeChatPlugin({});
const d = p.toDelivery({ table: "Msg_x", local_id: 1, local_type: 5 * 4294967296 + 49,
  create_time: 1758094679, raw: Buffer.from(XHS, "utf8"), sender: "wxid_x" });
check("认成 link", d.media[0].kind, "link");
check("ref 放网址（下游能直接用）", d.media[0].ref.includes("xiaohongshu"), true);
check("解析结果也带着", d.media[0].card.title, "西班牙所有厕所密码（25.9 版）");
check("正文是渲染后的行", d.text.startsWith("【链接】"), true);
const t = p.toDelivery({ table: "Msg_x", local_id: 2, local_type: 1,
  create_time: 1758094679, raw: Buffer.from("吃了吗", "utf8"), sender: "wxid_x" });
check("普通文字一点没变", t.text, "吃了吗");
check("普通文字没有 media", t.media, []);

console.log("\n[7] 空的/坏的 XML 不炸，也不瞎编");
check("空串", parseAppmsg("").title, "");
check("不是 XML", parseAppmsg("随便一段话").url, "");
check("没有 refermsg 时 quote 是 null", parseAppmsg(XHS).quote, null);

console.log("\n[8] 文件的本地路径：微信收到的文件是明文落盘的，不用解密");
{
  const fs = require("fs");
  const os = require("os");
  const pathMod = require("path");
  const root = fs.mkdtempSync(pathMod.join(os.tmpdir(), "wxfiles-"));
  fs.mkdirSync(pathMod.join(root, "2026-09"), { recursive: true });
  fs.writeFileSync(pathMod.join(root, "2026-09", "读后感.txt"), "x");
  const pp = new WeChatPlugin({ filesRoot: root });
  const ts = Math.floor(Date.UTC(2026, 8, 17, 4, 2, 56) / 1000);   // 2026-09
  const MISSING = `<msg><appmsg><title>盘上根本没有这个.txt</title><type>6</type></appmsg></msg>`;
  const dd = pp.toDelivery({ table: "Msg_x", local_id: 1, local_type: 6 * 4294967296 + 49,
    create_time: ts, raw: Buffer.from(MISSING, "utf8"), sender: "wxid_x" });
  check("盘上没有就不给路径（不瞎编）", dd.media[0].localPath, undefined);

  const F2 = `<msg><appmsg><title>读后感.txt</title><type>6</type><appattach><totallen>1</totallen></appattach></appmsg></msg>`;
  const d2 = pp.toDelivery({ table: "Msg_x", local_id: 2, local_type: 6 * 4294967296 + 49,
    create_time: ts, raw: Buffer.from(F2, "utf8"), sender: "wxid_x" });
  check("找到明文路径", d2.media[0].localPath, pathMod.join(root, "2026-09", "读后感.txt"));
  check("投给他的那行里带着路径", d2.text.includes(pathMod.join(root, "2026-09", "读后感.txt")), true);

  // 跨月：消息在 10 月初，文件落在 9 月目录
  const tsOct = Math.floor(Date.UTC(2026, 9, 1, 0, 30, 0) / 1000);
  const d3 = pp.toDelivery({ table: "Msg_x", local_id: 3, local_type: 6 * 4294967296 + 49,
    create_time: tsOct, raw: Buffer.from(F2, "utf8"), sender: "wxid_x" });
  check("跨月也翻得到（前后各找一个月）", d3.media[0].localPath, pathMod.join(root, "2026-09", "读后感.txt"));

  // 重名：微信同名文件会加 (1)(2)，XML 里的标题就对不上盘上的名字
  fs.writeFileSync(pathMod.join(root, "2026-09", "图纸(1).txt"), "x");
  const F3 = `<msg><appmsg><title>图纸.txt</title><type>6</type></appmsg></msg>`;
  const d5 = pp.toDelivery({ table: "Msg_x", local_id: 5, local_type: 6 * 4294967296 + 49,
    create_time: ts, raw: Buffer.from(F3, "utf8"), sender: "wxid_x" });
  check("微信加了(1)也找得到", pathMod.basename(d5.media[0].localPath || ""), "图纸(1).txt");
  fs.writeFileSync(pathMod.join(root, "2026-09", "图纸(2).txt"), "x");
  const d6 = pp.toDelivery({ table: "Msg_x", local_id: 6, local_type: 6 * 4294967296 + 49,
    create_time: ts, raw: Buffer.from(F3, "utf8"), sender: "wxid_x" });
  check("两个候选时宁可不给，也不给错的那个", d6.media[0].localPath, undefined);

  const noRoot = new WeChatPlugin({});
  const d4 = noRoot.toDelivery({ table: "Msg_x", local_id: 4, local_type: 6 * 4294967296 + 49,
    create_time: ts, raw: Buffer.from(F2, "utf8"), sender: "wxid_x" });
  check("没给 filesRoot 就不找，不猜", d4.media[0].localPath, undefined);
}

// ============ 卡片翻译规则（Alice 2026-09-17 拍板：留内容/扔壳/标来路/封顶/纯文本不动）============
{
  const { clip, stripCdata, renderAppmsg, APPMSG_MAX } = require("../../src/gate/plugins/wechat/appmsg");

  console.log("\n[封顶] 卡片 600 字，截了必须说截了");
  check("没超就原样", clip("短的", 600), "短的");
  const long = "啊".repeat(700);
  const c = clip(long, 600);
  check("截到 600", c.startsWith("啊".repeat(600)), true);
  check("说明截了、说了原文多长", c.includes("原文共 700 字，已截断"), true);

  console.log("\n[扔壳] CDATA 是标签壳，不是内容");
  check("剥掉 CDATA", stripCdata("<![CDATA[微信转账]]>"), "微信转账");
  check("没裹的不动", stripCdata("微信转账"), "微信转账");
  const transfer = `<msg><appmsg><title><![CDATA[微信转账]]></title>`
    + `<des><![CDATA[收到转账100.00元]]></des><type>2000</type></appmsg></msg>`;
  const tp = new WeChatPlugin({});
  const td = tp.toDelivery({ table: "Msg_x", local_id: 90, local_type: 2000 * 4294967296 + 49,
    create_time: 1758000000, raw: Buffer.from(transfer, "utf8"), sender: "wxid_x" });
  check("投给他的没有 CDATA 壳", td.text.includes("CDATA"), false);
  check("钱的事叫钱的名字，不叫【卡片】", td.text.startsWith("【转账】微信转账"), true);

  console.log("\n[标来路] 每张卡片都得让他看出「这不是她亲口说的」");
  for (const [sub, want] of [[19, "【聊天记录】"], [24, "【收藏】"], [2001, "【红包】"],
                             [51, "【视频号】"], [5, "【链接】"], [33, "【小程序】"]]) {
    const xml = `<msg><appmsg><title>t</title><type>${sub}</type></appmsg></msg>`;
    const d = tp.toDelivery({ table: "Msg_x", local_id: 90 + sub, local_type: sub * 4294967296 + 49,
      create_time: 1758000000, raw: Buffer.from(xml, "utf8"), sender: "wxid_x" });
    check("子类型 " + sub + " -> " + want, d.text.startsWith(want), true);
  }

  console.log("\n[封顶只截描述] 标题和网址一个字不动 —— 他要自己跑去读");
  const url = "https://www.xiaohongshu.com/explore/abc123";
  const big = `<msg><appmsg><title>标题在这</title><des>${"描".repeat(900)}</des>`
    + `<url>${url}</url><type>5</type></appmsg></msg>`;
  const bd = tp.toDelivery({ table: "Msg_x", local_id: 95, local_type: 5 * 4294967296 + 49,
    create_time: 1758000000, raw: Buffer.from(big, "utf8"), sender: "wxid_x" });
  check("标题活着", bd.text.includes("标题在这"), true);
  check("网址整条活着（截半截等于把路堵死）", bd.text.includes(url), true);
  check("总长封在 600 上下", bd.text.length <= APPMSG_MAX + 40, true);
  check("说明描述被截了", bd.text.includes("已截断"), true);

  console.log("\n[纯文本不动] 她自己打的字一个都不许丢");
  const plain = "报价单".repeat(3000);           // 9000 字，真事：9-17 她转来 8546 字
  const pd = tp.toDelivery({ table: "Msg_x", local_id: 96, local_type: 1,
    create_time: 1758000000, raw: Buffer.from(plain, "utf8"), sender: "wxid_x" });
  check("一个字没丢", pd.text.length, plain.length);
  check("没加截断说明", pd.text.includes("已截断"), false);

  console.log("\n[兜底也不许原样吐] 认不出的类型封在 2000");
  const weird = "壳".repeat(5000);
  const wd = tp.toDelivery({ table: "Msg_x", local_id: 97, local_type: 99999,
    create_time: 1758000000, raw: Buffer.from(weird, "utf8"), sender: "wxid_x" });
  check("封顶了", wd.text.length < 2100, true);
  check("说了是哪个类型、原文多长", wd.text.includes("原文共 5000 字，已截断"), true);
}

// ============ 真数据回归：2026-09-17 那四条真卡片 ============
// ⚠️ **卡片原文不进仓库** —— 里面是她和别人的私事（聊天记录那条尤其）。
// 照 wechat-media.js 的老规矩：读真库，读不到就跳过。
{
  console.log("\n[真卡片] 2026-09-17 四条（读不到真库就跳过）");
  const { execFileSync } = require("child_process");
  const fsMod = require("fs");
  const pMod = require("path");
  const { APPMSG_MAX } = require("../../src/gate/plugins/wechat/appmsg");
  let rows = null;
  // ⚠️ 只有「真库读不到」才算跳过。代码写错了必须炸出来 ——
  // 第一版这个 try 把我自己的 `fs is not defined` 吞成了「跳过真数据」，
  // 测试一片绿而那一段根本没跑。**静默跳过比失败危险。**
  let keys;
  try {
    if (process.env.IM_BRIDGE_REAL_WECHAT !== "1") throw new Error("未设 IM_BRIDGE_REAL_WECHAT=1（默认不碰真实微信库/密钥）");
    keys = JSON.parse(fsMod.readFileSync("/root/wxkey/all_keys.json", "utf8"));
    if (!keys._db_dir) throw new Error("没有 _db_dir");
  } catch (e) {
    console.log("SKIP: appmsg 真数据段（" + String(e.message).slice(0, 80) + "）");
    keys = null;
  }
  if (keys) {
    const data = keys;
    const db = pMod.join(data._db_dir, "message/message_0.db");
    const key = (data["message/message_0.db"] || {}).enc_key;
    const sqlc = (sql) => execFileSync("sqlcipher", ["-batch", db], {
      input: `PRAGMA key = "x'${key}'";\nPRAGMA cipher_compatibility = 4;\n.headers off\n.mode list\n.separator |\n${sql}\n`,
      encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
    }).split("\n").filter((l) => l && l !== "ok");
    const T0 = Math.floor(Date.parse("2026-09-17T00:00:00Z") / 1000);
    rows = [];
    for (const t of sqlc("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%';")) {
      if (!/^Msg_[0-9a-f]{32}$/.test(t)) continue;
      for (const line of sqlc("SELECT local_id, local_type, create_time, hex(ifnull(message_content,'')) FROM "
          + t + " WHERE create_time >= " + T0 + " AND local_type % 4294967296 = 49;")) {
        const p = line.split("|");
        if (p.length >= 4) rows.push({ t, id: Number(p[0]), lt: Number(p[1]), ct: Number(p[2]), hex: p[3] });
      }
    }
    if (!rows.length) console.log("  真库里今天没有 appmsg 卡片，这一段没跑");
  }

  if (rows && rows.length) {
    const tp2 = new WeChatPlugin({});
    let worst = 0, leaked = 0, unlabeled = 0;
    for (const r of rows) {
      const raw = Buffer.from(r.hex, "hex");
      const d = tp2.toDelivery({ table: r.t, local_id: r.id, local_type: r.lt,
        create_time: r.ct, raw, sender: "wxid_x" });
      worst = Math.max(worst, (d.text || "").length);
      if (/<\/(msg|appmsg)>|CDATA|<thumburl>/.test(d.text || "")) leaked += 1;
      if (!/^【/.test(d.text || "")) unlabeled += 1;
    }
    check("今天所有 appmsg 卡片都带来路标签", unlabeled, 0);
    check("没有一条把 XML 壳漏给他", leaked, 0);
    check("最长的一条也在封顶以内（" + worst + " 字）", worst <= APPMSG_MAX + 60, true);
    console.log("  （今天 " + rows.length + " 条真卡片，最长输出 " + worst + " 字）");
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
