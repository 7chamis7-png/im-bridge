"use strict";
/**
 * 守卫：**每一条装上的腿都要能被它自己的渠道名找到**。
 *
 * A hard-coded channel -> plugin table can leave an attached leg unreachable:
 * it polls messages, but the first inbound can't find its plugin and the
 * exception crashes the bridge. This checks that every attached leg is reachable.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { makeFakeBox } = require("../../src/gate/box");
const { buildGate } = require("../../src/gate/wire");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-reach-"));
let pass = 0, fail = 0;
const check = (n, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(g)} want=${JSON.stringify(w)}`));
  ok ? pass++ : fail++;
};
const CAPS = { send_text: "supported", send_file: "unsupported", send_voice: "unsupported",
  send_sticker: "unsupported", send_generated_image: "unsupported", react: "unsupported",
  start_call: "unsupported", end_call: "unsupported" };
const mk = (channel) => ({
  channel, transport: "t", capabilities: CAPS,
  health: () => ({ platform: "supported", plugin: "wired", availability: "ready" }),
  send: async () => ({ nativeId: "n" }),
  toDelivery: (raw) => ({ channel, accountId: channel, senderId: "owner", chatId: "owner",
    chatType: "private", nativeId: "1", receivedAt: new Date().toISOString(),
    text: String((raw && raw.text) || ""), media: [], processing: ["none"] }),
});

// 槽名故意跟渠道名不一样（现网 wechatA11y 这一格的渠道就叫 wechat），
// 这样能抓到「拿槽名当渠道名」那种写法。
const SLOTS = { telegram: mk("telegram"), wechatA11y: mk("wechat"),
  wechatImbot: mk("wechat-bot"), phone: mk("phone"), 随便什么新腿: mk("qq") };

const g = buildGate({
  box: makeFakeBox(), root: path.join(root, "store"),
  coldFile: path.join(root, "cold.jsonl"), plugins: SLOTS,
  identities: Object.fromEntries(Object.values(SLOTS).map((p) => [p.channel + ":owner", "owner"])),
  files: { gateEnabled: path.join(root, ".on") },
});

console.log("\n[1] 每条腿都能按自己的渠道名找到（不是按槽名）");
for (const [slot, p] of Object.entries(SLOTS)) {
  check(`${slot} → 渠道 ${p.channel}`, g.outbound.plugins.get(p.channel) === p, true);
}
check("槽名不该被当成渠道名注册", g.outbound.plugins.has("wechatA11y"), false);

console.log("\n[2] 入站真送得到 —— 这才是当天崩掉的那一步");
(async () => {
  fs.writeFileSync(path.join(root, ".on"), "");
  for (const p of Object.values(SLOTS)) {
    let why = "";
    try { await g.pipe.ingest({ channel: p.channel, raw: { text: "在吗" } }); }
    catch (e) { why = String((e && e.message) || e); }
    check(`${p.channel} 的入站没被「没有这个渠道的插头」挡掉`, why, "");
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
