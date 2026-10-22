"use strict";

/**
 * 电话边写边念（2026-10-21 Keeper 建，Alice：「重启桥不就行了 还要重启他？」—— 她对了）
 *
 * 他的 CLI 早就开着 --include-partial-messages，一个字一个字往外吐，到盒子这儿
 * 只拿来记了个首字时间就扔了。整轮写完才交给桥 → 电话里她干等 7~16 秒。
 *
 * 这里只管**来路是 phone 的那一轮**：字攒够一句就直接递给通话进程（phone.sock），
 * 不经过桥。桥那条照旧：整轮结束后把整段交过去、落冷层、记账，一样不少 ——
 * 通话进程认得「这句刚才流着念过了」，跳过不念第二遍。
 * 所以这一层丢了 / 坏了 / 通话进程不在，最坏也只是退回原来那样等整段，不会少收。
 *
 * 规矩：
 *   · 只认正文（text_delta），思考不念
 *   · 切点：。！？!?… 换行；他的文风是空格断句，所以中文旁边的空格也算；
 *     逗号攒够 12 字才切。太短（<4 字）不单独念
 *   · 不在 [soft laugh] 这种标签中间切
 *   · 行首冒出 `<英文标签`（他编的假入站 / 工具调用）→ 这一轮剩下的不流了，交给桥那条
 */

const net = require("net");

const SOCK = process.env.GATE_PHONE_SOCKET || require("path").join(require("../core/paths").gateRoot(), "phone.sock");
const MIN = 4;
const COMMA_MIN = 12;
const len = (s) => Array.from(s).length;

function nextCut(buf) {
  let depth = 0;
  const chars = Array.from(buf);
  let pos = 0;                                       // 按 UTF-16 下标累计，好 slice
  let n = 0;                                         // 标签外、非空白的字数
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    pos += c.length;
    if (c === "[") { depth++; continue; }
    if (c === "]") { depth = Math.max(0, depth - 1); continue; }
    if (depth) continue;
    if (!/\s/.test(c)) n++;
    if (/[。！？!?…\n]/.test(c) && n >= MIN) {
      // 连着的标点一起带走（「！！」「？！」「……」）
      let j = i + 1, p = pos;
      while (j < chars.length && /[。！？!?…]/.test(chars[j])) { p += chars[j].length; j++; }
      return p;
    }
    if ((c === "，" || c === ",") && n >= COMMA_MIN) return pos;
    if (c === " " && n >= MIN && i > 0 && i + 1 < chars.length
        && (/[一-龥]/.test(chars[i - 1]) || /[一-龥]/.test(chars[i + 1]))) return pos;
  }
  return -1;
}

function sendSay(text, turnId, log) {
  return new Promise((resolve) => {
    const s = net.createConnection(SOCK);
    let done = false;
    const end = (ok) => { if (done) return; done = true; try { s.destroy(); } catch {} resolve(ok); };
    const t = setTimeout(() => end(false), 8000);
    s.on("connect", () => s.write(JSON.stringify({ type: "say", text, stream: true, turnId }) + "\n"));
    s.on("data", () => { clearTimeout(t); end(true); });
    s.on("error", (e) => { clearTimeout(t); log("[电话流] 递不过去：" + e.message); end(false); });
  });
}

function makePhoneStreamer({ log = () => {} } = {}) {
  /** turnId -> { buf, chain, dead } */
  const turns = new Map();

  const st = (turnId) => {
    let t = turns.get(turnId);
    if (!t) { t = { buf: "", chain: Promise.resolve(), dead: false, lineStart: true }; turns.set(turnId, t); }
    return t;
  };

  const emitPiece = (turnId, t, piece) => {
    const clean = piece.trim();
    if (!clean) return;
    t.chain = t.chain.then(() => sendSay(clean, turnId, log)).then((ok) => { if (!ok) t.dead = true; });
  };

  return {
    /** 一小块正文 */
    delta(turnId, text) {
      const t = st(turnId);
      if (t.dead) return;
      t.buf += text;
      // 假入站 / 工具调用：行首 `<英文`。这一轮剩下的交给桥
      if (/(^|\n)\s*(user)?<[A-Za-z]/.test(t.buf)) {
        const k = t.buf.search(/(^|\n)\s*(user)?<[A-Za-z]/);
        const before = t.buf.slice(0, k);
        t.buf = ""; t.dead = true;
        if (len(before.trim()) >= 1) emitPiece(turnId, t, before);
        log("[电话流] 行首冒出标签，这一轮剩下的不流了");
        return;
      }
      for (;;) {
        const k = nextCut(t.buf);
        if (k < 0) break;
        const piece = t.buf.slice(0, k);
        t.buf = t.buf.slice(k);
        emitPiece(turnId, t, piece);
      }
    },
    /** 一个正文块写完了（工具调用前 / 整轮末尾）：剩下的不管多短都念掉 */
    flush(turnId) {
      const t = turns.get(turnId);
      if (!t || t.dead) return;
      const rest = t.buf; t.buf = "";
      if (rest.trim()) emitPiece(turnId, t, rest);
    },
    done(turnId) {
      this.flush(turnId);
      const t = turns.get(turnId);
      if (t) t.chain.finally(() => turns.delete(turnId));
    },
  };
}

module.exports = { makePhoneStreamer, nextCut };
