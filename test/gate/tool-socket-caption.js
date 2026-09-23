"use strict";
// send_image / send_file call their text `caption` (in args), but plugins read `text`.
// The tool socket must map it, otherwise captions are silently dropped.
const assert = require("assert");
const { makeToolSocket } = require("../../src/gate/tool-socket");

(async () => {
  const sent = [];
  const tools = new Map([
    ["send_image", { name: "send_image", intent: "send_generated_image" }],
    ["send_file", { name: "send_file", intent: "send_file" }],
  ]);
  const sock = makeToolSocket({
    file: "/tmp/unused.sock", tools,
    outbound: { deliver: async (t) => { sent.push(t); return { outcome: "sent", channel: "telegram" }; } },
    binding: { lookup: () => ({ eventId: "ev-1", channel: "telegram", chatId: "c1" }) },
    activeTurn: () => ({ threadId: "th", turnId: "tu" }),
  });

  await sock.handle({ id: "1", tool: "send_image", args: { filePath: "/x.png", caption: "给你看" } });
  assert.strictEqual(sent[0].text, "给你看", "caption 要当配字送给插头");
  assert.strictEqual(sent[0].toolArgs.filePath, "/x.png");

  await sock.handle({ id: "2", tool: "send_file", text: "正文优先", args: { filePath: "/a.mp3", caption: "别用这个" } });
  assert.strictEqual(sent[1].text, "正文优先", "给了 text 就用 text");

  await sock.handle({ id: "3", tool: "send_file", args: { filePath: "/a.mp3" } });
  assert.strictEqual(sent[2].text, "", "都没给就是空，不编");

  await sock.handle({ id: "4", tool: "send_image", args: { filePath: "/x.png", caption: 42 } });
  assert.strictEqual(sent[3].text, "", "caption 不是字符串就不认");

  console.log("tool-socket-caption: 4/4 通过");
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
