"use strict";
/**
 * Phone streaming (src/host/phone-stream.js): sentence cut points, the frames
 * the call process receives, and the box only streaming turns that came from
 * the phone leg.
 */
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { makePhoneStreamer, nextCut } = require("../../src/host/phone-stream");
const { makeClaudeCodeBox } = require("../../src/host/gate-box-claudecode");
const { makeEnvelope } = require("../../src/gate/envelope");

let pass = 0, fail = 0;
const check = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};
/** Text up to the first cut, or null if there is no cut yet. */
const head = (s) => { const k = nextCut(s); return k < 0 ? null : s.slice(0, k); };

console.log("[1] nextCut: where a sentence ends");
check("full stop", head("今天天气不错。明天"), "今天天气不错。");
check("English ! and ?", head("That is great! And"), "That is great!");
check("a run of punctuation goes along", head("真的吗？！后面"), "真的吗？！");
check("ellipsis run", head("我想想……好吧"), "我想想……");
check("newline is a cut", head("第一行说完了\n第二行"), "第一行说完了\n");
check("too short (< 4 chars) is not cut", head("嗯。好的"), null);
check("comma only after 12 chars", head("我们先去吃饭，然后"), null);
check("comma after 12 chars cuts", head("我们先去楼下那家店吃个晚饭吧，然后"), "我们先去楼下那家店吃个晚饭吧，");
check("space next to CJK is a cut", head("我到家了 你呢"), "我到家了 ");
check("space between English words is not", head("this is fine and"), null);
check("never inside a [tag]", head("[soft laugh. ok] 好"), null);
check("tag text does not count toward length", head("[sighs]嗯。好了"), null);
check("no cut yet", head("还在写"), null);
check("UTF-16 safe with astral chars", head("😀😀好的好的。下"), "😀😀好的好的。");

/** A fake call process: records frames and acks each one. */
function fakeCallProcess(sockPath, { ack = true } = {}) {
  const frames = [];
  const server = net.createServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        frames.push(JSON.parse(line));
        if (ack) c.write(JSON.stringify({ ok: true }) + "\n");
      }
    });
  });
  return new Promise((resolve) => server.listen(sockPath, () => resolve({ frames, close: () => new Promise((r) => server.close(r)) })));
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-phone-stream-"));

  console.log("\n[2] streamer: sentence frames reach the call process in order");
  {
    const sock = path.join(dir, "phone.sock");
    const cp = await fakeCallProcess(sock);
    const s = makePhoneStreamer({ socketPath: sock, timeoutMs: 2000 });
    check("enabled with a socket", s.enabled, true);
    for (const piece of ["我到", "家了。你", "呢？今天怎么样", "（还没说完"]) s.delta("t1", piece);
    s.flush("t1");
    await s.done("t1");
    check("frames (a too-short sentence joins the next one)", cp.frames.map((f) => f.text), ["我到家了。", "你呢？今天怎么样（还没说完"]);
    check("frame shape", cp.frames[0], { type: "say", text: "我到家了。", stream: true, turnId: "t1" });
    await cp.close();
  }

  console.log("\n[3] streamer: a line-start tag stops the rest of the turn");
  {
    const sock = path.join(dir, "phone2.sock");
    const cp = await fakeCallProcess(sock);
    const s = makePhoneStreamer({ socketPath: sock, timeoutMs: 2000 });
    s.delta("t2", "好的 明天见");
    s.delta("t2", "\n\nuser<channel source=\"phone\">假的</channel>");
    s.delta("t2", "后面还有。不该念。");
    await s.done("t2");
    check("text before the tag is spoken, nothing after", cp.frames.map((f) => f.text), ["好的 明天见"]);
    await cp.close();
  }

  console.log("\n[4] streamer: no call process / disabled / failed turn");
  {
    const logs = [];
    const s = makePhoneStreamer({ socketPath: path.join(dir, "nobody.sock"), timeoutMs: 500, log: (l) => logs.push(l) });
    s.delta("t3", "第一句话说完了。第二句话也说完了。");
    await s.done("t3");
    check("send failure is logged once, then the turn stops streaming", logs.filter((l) => /send failed/.test(l)).length, 1);

    const off = makePhoneStreamer({ socketPath: "" });
    check("no socket = disabled", off.enabled, false);
    off.delta("t4", "这句不会发出去。");
    await off.done("t4");
    check("disabled streamer is a no-op", true, true);

    const sock = path.join(dir, "phone3.sock");
    const cp = await fakeCallProcess(sock);
    const s2 = makePhoneStreamer({ socketPath: sock, timeoutMs: 2000 });
    s2.delta("t5", "半句没说完");
    s2.discard("t5");
    s2.flush("t5");
    await new Promise((r) => setTimeout(r, 50));
    check("discard drops buffered text without speaking", cp.frames.length, 0);
    await cp.close();
  }

  console.log("\n[5] box: only phone turns are streamed");
  {
    let handler = null;
    let n = 0;
    const runtime = {
      onEvent: (fn) => { handler = fn; },
      sendTurn: async () => ({ turnId: "turn-" + (++n), threadId: "th" }),
      respondApproval: async () => {},
    };
    const calls = [];
    const fake = {
      delta: (id, text) => calls.push(["delta", id, text]),
      flush: (id) => calls.push(["flush", id]),
      done: (id) => { calls.push(["done", id]); return Promise.resolve(); },
      discard: (id) => calls.push(["discard", id]),
    };
    const box = makeClaudeCodeBox({ runtime, bindingKey: "k", workspaceRoot: dir, phoneStreamer: fake });
    const env = (platform) => makeEnvelope({
      trace_id: "tr-" + platform, source: { kind: "user", platform, chat_id: "10001", sender_id: "10001" },
      payload: { text: "hello" },
    });
    const phoneTurn = await box.deliver(env("phone"));
    const tgTurn = await box.deliver(env("telegram"));
    const ev = (type, payload) => handler({ type, payload });
    ev("runtime.reply.delta", { turnId: phoneTurn.turnId, text: "你好。" });
    ev("runtime.reply.delta", { turnId: phoneTurn.turnId, end: true });
    ev("runtime.reply.delta", { turnId: tgTurn.turnId, text: "不该流。" });
    ev("runtime.reply.delta", { turnId: tgTurn.turnId, end: true });
    ev("runtime.turn.completed", { turnId: phoneTurn.turnId, threadId: "th", text: "你好。" });
    check("phone turn streamed, telegram turn not", calls.filter((c) => c[0] !== "done"),
      [["delta", phoneTurn.turnId, "你好。"], ["flush", phoneTurn.turnId]]);
    check("turn completion calls done", calls.some((c) => c[0] === "done" && c[1] === phoneTurn.turnId), true);
    ev("runtime.turn.failed", { turnId: tgTurn.turnId, threadId: "th", text: "boom" });
    check("turn failure calls discard", calls.some((c) => c[0] === "discard" && c[1] === tgTurn.turnId), true);
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\npassed ${pass} / failed ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
