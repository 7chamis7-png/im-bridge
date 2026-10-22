"use strict";

// 账本轮转：只丢「已有结论」的，从最老丢起；在途的和 unknown 一条都不许丢。
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Outbox } = require("../../src/gate/outbox");
const { TurnStore } = require("../../src/gate/turn-store");

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (ok ? "OK  " : "FAIL ") + name
    + (ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-retention-"));

console.log("[1] outbox：超出上限时丢最老的已终结，在途的留着");
{
  const box = new Outbox({ root: path.join(root, "outbox"), keepSettled: 3 });
  box.create({ operationId: "old-1", state: "sent", updatedAt: "2026-01-01T00:00:00.000Z" });
  box.create({ operationId: "old-2", state: "failed", updatedAt: "2026-01-02T00:00:00.000Z" });
  box.create({ operationId: "flight", state: "running", updatedAt: "2026-01-03T00:00:00.000Z" });
  box.create({ operationId: "unk", state: "unknown", updatedAt: "2026-01-04T00:00:00.000Z" });
  box.create({ operationId: "new-1", state: "sent", updatedAt: "2026-02-01T00:00:00.000Z" });
  box.create({ operationId: "new-2", state: "blocked", updatedAt: "2026-02-02T00:00:00.000Z" });
  check("最老那条已终结被丢", box.has("old-1"), false);
  check("在途的不丢", box.has("flight"), true);
  check("unknown 不丢（要留着核对）", box.has("unk"), true);
  check("刚写的留着", [box.has("new-1"), box.has("new-2")], [true, true]);
  check("重开一次仍是同一份账", new Outbox({ root: path.join(root, "outbox"), keepSettled: 3 }).has("old-1"), false);
}

console.log("\n[2] turn-store：completed/failed 才丢，队列里的不丢");
{
  const file = path.join(root, "turns.json");
  const store = new TurnStore({ file, keepSettled: 2 });
  const mk = (id, state) => {
    store.ensure({ trace_id: id }, { ok: true });
    if (state !== "queued") store.update(id, { state });
  };
  mk("done-1", "completed");
  mk("done-2", "failed");
  mk("queued-1", "queued");
  mk("unknown-1", "unknown");
  mk("done-3", "completed");
  mk("done-4", "completed");
  check("最老的已完成被丢", store.get("done-1"), null);
  check("排队中的不丢", Boolean(store.get("queued-1")), true);
  check("unknown 不丢", Boolean(store.get("unknown-1")), true);
  check("落盘后重开一致", Boolean(new TurnStore({ file, keepSettled: 2 }).get("done-1")), false);
}

console.log("\n[3] 上限内一条都不丢");
{
  const box = new Outbox({ root: path.join(root, "small"), keepSettled: 50 });
  for (let i = 0; i < 10; i += 1) box.create({ operationId: "op-" + i, state: "sent", updatedAt: "2026-01-0" + (i % 9) });
  check("十条都在", box.all().length, 10);
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
