"use strict";
// Continuation-hallucination detector (src/core/hallucination-cut.js):
// recognizes real shapes (incl. `user[Image #1]<channel`), never cuts ordinary text.
const assert = require("assert");
const { cutHallucinatedTail } = require("../../src/core/hallucination-cut");

const ch = '<channel source="wechat" seq="1111" chat_id="wxid_owner" message_id="Msg_x:5350" ts="2026-09-22T08:20:14.000Z">\n[图片]\n</channel>';

// 老形状照认
let r = cutHallucinatedTail("正文在这\n\nuser" + ch);
assert.strictEqual(r.kind, "forged_inbound"); assert.strictEqual(r.text, "正文在这");
// 9-22 漏网形状：user 和 <channel 之间夹了 [Image #1]
r = cutHallucinatedTail("这边单价便宜 不用两千多\n\nuser[Image #1]" + ch);
assert.strictEqual(r.kind, "forged_inbound", "夹了 [Image #1] 也要认");
assert.strictEqual(r.text, "这边单价便宜 不用两千多");
r = cutHallucinatedTail("嗯\nuser [Image #2] [Image #3] " + ch);
assert.strictEqual(r.kind, "forged_inbound", "连着几个占位、带空格也认");
// 不误伤：正文里讲 user、讲 [Image #1]、讲 <channel> 都不算，除非是那个连在一起的形状
for (const ok of ["这个字段叫 user，后面是 channel", "你发的 [Image #1] 我看到了", "user: 你好", "XML 里写 <channel> 标签就行",
  "user[Image #1] 这是占位符的写法"]) {
  assert.strictEqual(cutHallucinatedTail(ok).kind, "", "不该命中：" + ok);
}
// Shape 3: any tag at the start of a line. Samples mirror real shapes (forged
// system reminder, leaked system_warning, forged inbound without `user`, short
// `word:` prefix). Everything before the cut must survive verbatim.
for (const [head, tail] of [
  ["好的 明天见", "user<system-reminder>check-in: this round drew a card</system-reminder>"],
  ["那就这样定了", "user<system-reminder>\n[Image #1]\n</system-reminder>\n" + ch],
  ["Sounds good to me", "<system_warning>Long conversation reminder: maintain consistent quality</system_warning>"],
  ["你听", ch],
  ["这个是条件反射", "question用户:" + ch],
  ["That was the interesting part", "user<system-reminder>\nAttribution for git commits and pull requests"],
]) {
  r = cutHallucinatedTail(head + "\n\n" + tail);
  assert.strictEqual(r.text, head, "text before the cut must be kept: " + head);
  assert.strictEqual(r.cut, tail);
  assert.strictEqual(r.kind === "line_start_tag" || r.kind === "forged_inbound", true);
}
// Not cut: a tag mid-sentence, a tag inside a code fence, line-leading `<` that is not an English tag
for (const ok of ["他靠 <channel chat_type=\"supergroup\"> 这个标签分群", "看这段\n```\n<div class=\"a\">\n</div>\n```\n就这样",
  "< 3 就行", "<3 me", "<<书名>>", "《围城》", "比较：a < b"]) {
  assert.strictEqual(cutHallucinatedTail(ok).kind, "", "不该命中：" + ok);
}
console.log("hallucination-cut: 全部通过");
