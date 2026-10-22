"use strict";
/**
 * 电话这条腿：桥（src/gate/plugins/phone.js）↔ 通话进程（legs/phone/phone.py）的接线。
 *
 * 两头各自的单测抓不到「字段名 / 形状对不上」—— 对不上不报错、只会静默变空。
 * 所以这里起一个真的 phone.py（声音零件全换成假的，不碰声卡、不碰网络），
 * 让桥这头的真插头去读它落的文件、往它的 socket 里递话。
 *
 * 另外顺带跑 legs/phone 的 python 单测（test/legs/phone/test_phone.py）。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const { PhonePlugin } = require("../../src/gate/plugins/phone");
const { makeProducerInbox } = require("../../src/gate/producers");
const { isPhoneTurn } = require("../../src/host/gate-box-claudecode");

const ROOT = path.join(__dirname, "..", "..");
let pass = 0, fail = 0;
const check = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pyEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };

const py = spawnSync("python3", ["--version"], { encoding: "utf8" });
if (py.status !== 0) { console.log("  SKIP 没有 python3"); process.exit(0); }

(async () => {
  console.log("[1] legs/phone 的 python 单测");
  {
    const r = spawnSync("python3", [path.join(ROOT, "test", "legs", "phone", "test_phone.py")],
      { encoding: "utf8", env: pyEnv, timeout: 120000 });
    const m = /Ran (\d+) tests/.exec(r.stderr || "");
    check("python 单测全过（" + (m ? m[1] : "?") + " 个）", r.status, 0);
    if (r.status !== 0) console.log((r.stderr || "").split("\n").slice(-30).join("\n"));
  }

  console.log("[2] 真 phone.py ↔ 真插头");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phone-leg-"));
  const inboxDir = path.join(root, "inbox");
  const socketPath = path.join(root, "phone.sock");
  const prodDir = path.join(root, "producers");
  const flag = path.join(root, "call-up");
  fs.writeFileSync(flag, "1");
  // 声音零件换成假的；通话在不在看 flag 文件（代替微信通话窗口）
  const helper = `
import os, sys, threading, time
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "legs", "phone"))})
import config, phone
class V:
    def transcribe(self, cfg, wav): return "听得到吗"
    def tone(self, cfg, wav): return None
    is_tone_not_voice = staticmethod(lambda t: False)
    def speak(self, cfg, text): return True
class M:
    play_until = 0.0
    def synth(self, text): print("SYNTH", text, flush=True); return 0.5
    def stop(self): print("STOP", flush=True)
cfg = config.load()
os.makedirs(cfg["inbox"], exist_ok=True)
ph = phone.Phone(cfg, voice=V(), probe=lambda: os.path.exists(${JSON.stringify(flag)}), logger=lambda *a: None)
ph.mouth = M()
ph.call_tick()
ph.process_utterance(0, b"\\x00\\x01" * 16000, 16000)
phone.put_note(cfg["producers_dir"], "phone", "提醒", target={"platform": "phone", "chat_id": cfg["peer"]})
ready = threading.Event()
threading.Thread(target=ph.serve, args=(ready,), daemon=True).start()
ready.wait(5)
def ticks():
    while True:
        time.sleep(0.05); ph.call_tick()
threading.Thread(target=ticks, daemon=True).start()
threading.Thread(target=ph.player, daemon=True).start()
print("READY", flush=True)
time.sleep(30)
`;
  const child = spawn("python3", ["-c", helper], {
    env: { ...pyEnv, GATE_PHONE_INBOX_DIR: inboxDir, GATE_PHONE_SOCKET: socketPath, GATE_OWNER_PHONE_ID: "peer-9",
      GATE_PRODUCERS_DIR: prodDir, ELEVENLABS_API_KEY: "test-key", ELEVENLABS_DEFAULT_VOICE_ID: "v",
      PHONE_TMP_DIR: path.join(root, "t"), PHONE_NUDGE_AFTER_S: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "", err = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { err += c; });
  for (let i = 0; i < 100 && !out.includes("READY"); i++) await sleep(50);
  check("通话进程起来了", out.includes("READY"), true);
  if (!out.includes("READY")) console.log(err.slice(-2000));

  try {
    const p = new PhonePlugin({ inboxDir, socketPath, peerId: "peer-9", sendTimeoutMs: 3000 });
    const { items, cursor } = await p.poll({ since: 0 });
    check("插头捞到通话进程落的那一句", items.length, 1);
    const d = p.toDelivery(items[0].message);
    check("入站形状：渠道 / 人 / 正文 / 加工", [d.channel, d.senderId, d.chatId, d.text, d.processing],
      ["phone", "peer-9", "peer-9", "听得到吗", ["transcribed"]]);
    check("nativeId = 文件序号", d.nativeId, String(items[0].update_id));
    check("游标推到这一条", cursor, items[0].update_id);
    const again = await p.poll({ since: cursor });
    check("消化过的被插头删掉", [again.items.length, fs.readdirSync(inboxDir).filter((f) => f.endsWith(".json")).length], [0, 0]);

    const box = makeProducerInbox({ dir: prodDir });
    const got = [];
    const r = await box.drain(async (n) => { got.push(n); });
    check("先开口提醒：桥的投递口认得（没被当坏文件）", [r.ok, r.failed], [1, 0]);
    check("提醒的落点是电话", got[0] && got[0].target, { platform: "phone", chat_id: "peer-9" });
    check("这种系统轮也边写边念", isPhoneTurn({ source: { kind: "system", producer: "phone" }, target: { platform: "phone" } }), true);
    check("别的渠道的系统轮不念", isPhoneTurn({ source: { kind: "system" }, target: { platform: "wechat" } }), false);
    check("她在电话里说的照旧念", isPhoneTurn({ source: { kind: "user", platform: "phone" } }), true);

    check("通话中：插头在线", p.health().availability, "ready");
    const sent = await p.send({ operationId: "op-1", chatId: "peer-9", text: "我在，听得到" });
    check("通话中 say → 送达", sent, { nativeId: null, sentAs: "spoken" });
    for (let i = 0; i < 40 && !out.includes("SYNTH 我在，听得到"); i++) await sleep(50);
    check("念的就是递过去的那句", out.includes("SYNTH 我在，听得到"), true);

    fs.unlinkSync(flag);                                  // 挂断
    for (let i = 0; i < 40 && !out.includes("STOP"); i++) await sleep(50);
    check("挂断：通话进程掐掉了正在放的", out.includes("STOP"), true);
    let why = "";
    try { await p.send({ operationId: "op-2", chatId: "peer-9", text: "挂了才到的这句" }); why = "居然送达了"; }
    catch (e) { why = e.name + ":" + e.message; }
    check("挂断后 say → ok:false → 插头抛 notSent（契约没破）", /NotSentError.*现在没有通话/.test(why), true);
    try { await p.send({ operationId: "op-3", chatId: "peer-9", text: "嗯" }); why = "居然送达了"; }
    catch (e) { why = e.name + ":" + e.message; }
    check("挂断后一个字的也不算送达", /现在没有通话/.test(why), true);
  } finally {
    child.kill();
  }

  console.log("[3] 通话进程不在 → 现在没有通话（原有契约）");
  {
    const p = new PhonePlugin({ inboxDir, socketPath: path.join(root, "nope.sock"), peerId: "peer-9" });
    let why = "";
    try { await p.send({ operationId: "op-4", chatId: "peer-9", text: "喂" }); } catch (e) { why = e.message; }
    check("socket 不在 → notSent「现在没有通话」", /现在没有通话/.test(why), true);
    check("socket 不在 → offline", p.health().availability, "offline");
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
