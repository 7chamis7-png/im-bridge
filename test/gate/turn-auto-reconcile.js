"use strict";

// 重启之后：能证明「已经跑完」的自动认掉；证明不了的原样留着等人。
// 反向（判定「没跑过」）永远不自动做 —— 判错就是重复投递。
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { makeTurnQueue } = require("../../src/gate/turn-queue");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-reconcile-"));
let n = 0;
const ok = (name) => { n += 1; console.log("  OK  " + name); };

function makeBox() {
  const box = { seen: [], replies: [], dones: [] };
  box.onReply = (fn) => box.replies.push(fn);
  box.onTurnDone = (fn) => box.dones.push(fn);
  box.deliver = async (env) => { box.seen.push(env); return { turnId: "turn-" + env.trace_id }; };
  return box;
}

const env = (id) => ({ trace_id: id, text: "hi " + id });
const route = () => ({ ok: true, target: { platform: "telegram", chat_id: "1" } });

(async () => {
  // 造一份「重启前留下 unknown」的账本
  const file = path.join(root, "turns.json");
  {
    const box = makeBox();
    box.deliver = async () => { const e = new Error("管道断了，结果不明"); throw e; };
    const q = makeTurnQueue({ file, box, onReply: async () => {}, onDone: async () => {} });
    await q.submit(env("a"), route()).catch(() => {});
    assert.equal(q.store.get("a").state, "unknown");
  }
  ok("提交后结果不明 → unknown");

  // 1) 没有 reconciler：unknown 挡着，后面的任务一条都不投（原行为不变）
  {
    const box = makeBox();
    const q = makeTurnQueue({ file, box, onReply: async () => {}, onDone: async () => {} });
    await q.submit(env("b"), route());
    await q.recover();
    assert.equal(box.seen.length, 0, "unknown 没核对前不许开新轮");
  }
  ok("没有证据来源时：照旧停下等人");

  // 2) reconciler 拿不出证据：也不许自动放行
  {
    const box = makeBox();
    const q = makeTurnQueue({ file, box, onReply: async () => {}, onDone: async () => {},
      reconciler: () => null });
    await q.recover();
    assert.equal(box.seen.length, 0);
    assert.equal(q.store.get("a").state, "unknown");
  }
  ok("证明不了 → 保持 unknown，不猜");

  // 3) reconciler 给出证据：认掉，队列继续跑
  {
    const box = makeBox();
    const q = makeTurnQueue({ file, box, onReply: async () => {}, onDone: async () => {},
      reconciler: (row) => ({ done: true, evidence: "出站账本里有 op-1（状态 sent）" }) });
    await q.recover();
    assert.equal(q.store.get("a").state, "completed");
    assert.equal(q.store.get("a").reconciledBy, "auto");
    assert.match(q.store.get("a").evidence, /op-1/);
    assert.equal(box.seen.length, 1, "认掉之后排队的那条要投出去");
    assert.equal(box.seen[0].trace_id, "b");
  }
  ok("有证据 → 自动认定 completed，并带上证据和来源");

  // 4) reconciler 抛错不许把桥带崩，只留日志
  {
    const file2 = path.join(root, "turns2.json");
    const boom = makeBox();
    boom.deliver = async () => { throw new Error("断了"); };
    const q0 = makeTurnQueue({ file: file2, box: boom, onReply: async () => {}, onDone: async () => {} });
    await q0.submit(env("c"), route()).catch(() => {});

    const logs = [];
    const box = makeBox();
    const q = makeTurnQueue({ file: file2, box, onReply: async () => {}, onDone: async () => {},
      log: (m) => logs.push(m), reconciler: () => { throw new Error("证据源自己挂了"); } });
    await q.recover();
    assert.equal(q.store.get("c").state, "unknown");
    assert.ok(logs.some((m) => m.includes("自动核对出错")));
  }
  ok("证据源抛错 → 留日志、保持 unknown");

  // 5) 空证据字符串不算证据
  {
    const file3 = path.join(root, "turns3.json");
    const boom = makeBox();
    boom.deliver = async () => { throw new Error("断了"); };
    const q0 = makeTurnQueue({ file: file3, box: boom, onReply: async () => {}, onDone: async () => {} });
    await q0.submit(env("d"), route()).catch(() => {});

    const box = makeBox();
    const q = makeTurnQueue({ file: file3, box, onReply: async () => {}, onDone: async () => {},
      reconciler: () => ({ done: true, evidence: "   " }) });
    await q.recover();
    assert.equal(q.store.get("d").state, "unknown");
  }
  ok("空白证据不算证据");

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n通过 ${n} / 失败 0`);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
