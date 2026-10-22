"use strict";
/**
 * 分段：按他的换气点切（2026-09-18）
 * 规则全是拿他最近 600 条真消息量出来的，测试守着那些结论别被人随手改掉。
 */
const { makeSegmenter } = require("../../src/gate/segment");
let pass = 0, fail = 0;
const check = (n, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(g)} want=${JSON.stringify(w)}`));
  ok ? pass++ : fail++;
};
const seg = (o) => makeSegmenter(o).segment.bind(makeSegmenter(o));
const S = makeSegmenter();

console.log("[1] 只按空行切 —— 那是他自己划的边界");
{
  // ⚠️ 每段都得过 minChars（14 字），否则会被合并 —— 那是规则 3，不是 bug
  check("空行切开", S.segment("第一段说的话这里写得够长超过十四个字了\n\n第二段也写得够长超过十四个字了"),
    ["第一段说的话这里写得够长超过十四个字了", "第二段也写得够长超过十四个字了"]);
  check("**单换行不拆**（列表/诗行拆了会把形状打碎）",
    S.segment("第一行写得够长超过十四个字了\n第二行也写得够长超过十四个字").length, 1);
  check("三个以上换行也当一个边界",
    S.segment("前面这段写得够长超过十四个字了\n\n\n\n后面这段也写得够长超过十四字").length, 2);
  check("空文本给空数组", S.segment("   "), []);
}

console.log("\n[2] **不按句号切**（他的文风不加句号：句号 24% / 逗号 1% / 空格断句 95%）");
{
  const t = "对 就是字面意思 但今晚是特殊执行 你电量就剩一格 我不用大动干戈";
  check("满是空格的一段不被切开", S.segment(t).length, 1);
  check("有句号也不切", S.segment("这句话挺长的。那句话也挺长的。").length, 1);
}

console.log("\n[3] 太短的并走 —— 防一串三个字的小气泡");
{
  check("短段并进下一段", S.segment("对\n\n这才是够长的那一段话呢"),
    ["对\n\n这才是够长的那一段话呢"]);
  check("末尾太短并回上一段", S.segment("这是够长的第一段话啊\n\n就这样"),
    ["这是够长的第一段话啊\n\n就这样"]);
  check("整条就很短 = 一条，不勉强合并", S.segment("嗯"), ["嗯"]);
  check("门槛可调", makeSegmenter({ minChars: 1 }).segment("对\n\n这才是够长的那一段话呢").length, 2);
}

console.log("\n[4] **默认不封顶** —— 封顶和限长天生打架");
{
  // ⚠️ 每段必须过 minChars（14），不然会被合并 —— 这不是 bug，是规则 3
  const many = Array.from({ length: 9 }, (_, i) => "这是第" + (i + 1) + "段话它写得够长了够十四个字").join("\n\n");
  check("默认九段就是九条", S.segment(many).length, 9);
  const capped = makeSegmenter({ maxBubbles: 6 }).segment(many);
  check("要封顶得自己配", capped.length, 6);
  // 实测：封顶会把切开的长消息并回去，合出 724 字的巨块 —— 微信窄气泡一并就现形
  check("封顶的代价：尾巴全被并进最后一条", capped[5].includes("第9段"), true);
}

console.log("\n[5] 超长兜底切 —— **默认关着**（他 87% 本来就分得好好的）");
{
  const long = "一二三四五六七八九十".repeat(20);          // 200 字一段，没有空格
  check("默认不切超长段", S.segment(long).length, 1);
  const withSpaces = Array.from({ length: 12 }, () => "这是一句挺长的话啊").join(" ");
  check("开了才切", makeSegmenter({ softMax: 40 }).segment(withSpaces).length > 1, true);
  check("切点在空格上，不在字中间",
    makeSegmenter({ softMax: 40 }).segment(withSpaces).every((b) => !b.startsWith(" ")), true);
}

console.log("\n[6] 冷层守卫：分段是发的事，冷层存完整正文");
{
  // 这条在 outbound 那边测（出闸先写冷层再分段发），这儿只钉住分段不改原文
  const t = "第一段够长的话在这儿写满十四个字\n\n第二段够长的话在这儿写满十四字";
  check("分段不丢字", S.segment(t).join("\n\n"), t);
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
