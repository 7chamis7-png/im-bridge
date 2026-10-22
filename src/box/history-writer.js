"use strict";

/**
 * 全本的落盘（imb.item.v1）—— 桥自己存的那份完整对话。设计稿 docs/design-engine-agnostic.md §1。
 *
 * 跟冷层（src/gate/cold-writer.js）同一套写法：
 *   · 一行一条、O_APPEND、只追加不回插；按月分段（items-YYYY-MM.jsonl），跨月换文件
 *   · 确定性 id，同一个 id 只落一次（盒子重启、cli 补发环重放都不会写重）
 *   · 起来时把最近两个月的 id 读进集合（重放只会是最近的事）
 *
 * 目录（默认 $GATE_ROOT/history，GATE_HISTORY_DIR 可改）：
 *   items-YYYY-MM.jsonl          主文件
 *   opaque/items-YYYY-MM.jsonl   只有某个引擎能用的不透明块（thinking+signature 等），默认不用（决策 ⑤）
 *   blobs/<sha256>               超过 16 KB 的工具结果正文、图片。同内容只存一份
 *   epochs.jsonl                 舱的台账
 *   redactions.jsonl             覆盖层（切幻觉 / undo / 清除）。不改主文件
 *
 * **脱敏**（§1.7）：写入时把 /root/.secrets 下已知密钥的**值**原样替换成 «secret:文件名»。
 * 只认已知的值，不用正则猜。替换次数记在这一条的 `secretsScrubbed` 上。
 *
 * ⚠️ 这里只管「怎么存」，不认识 Claude / codex（那是 history-claude.js 和 recorder 的事）。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ITEM_VERSION = 1;
const INLINE_TEXT_MAX = 16 * 1024;
const MIN_SECRET_LEN = 8;

const monthOf = (iso) => {
  const d = iso ? new Date(iso) : new Date();
  const t = Number.isNaN(d.getTime()) ? new Date() : d;
  return t.toISOString().slice(0, 7);
};

/**
 * 已知密钥的值（只认这些，不用正则猜正文）：
 *   · `*.secret`：单行 = 整个文件就是一个值；多行 = 逐行，KEY=VALUE 只取「键名像密钥」的值，没有 `=` 的整行（≥16）当值
 *   · `*.env` / `*.env.*`：只取键名像密钥的值（KEY / TOKEN / SECRET / PASSWORD / AUTH / COOKIE / CREDENTIAL / PRIVATE）
 * 路径（/ 开头）一律不算。太短的（<8）不认。
 * ⚠️ 2026-10-21 补录实测踩过：第一版把 .env 里每个 KEY=VALUE 都当密钥，路径、模型名全被换掉，3842 条记录被误伤。
 */
const SECRET_KEY_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|AUTH|COOKIE|CREDENTIAL|PRIVATE)/i;
function loadSecretValues(dir) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const isSecret = /\.secret$/.test(name);
    const isEnv = /\.env$/.test(name) || /\.env\./.test(name);
    if (!isSecret && !isEnv) continue;
    let raw;
    try { raw = fs.readFileSync(path.join(dir, name), "utf8"); } catch { continue; }
    const vals = new Set();
    const whole = raw.trim();
    if (isSecret && whole && !whole.includes("\n")) vals.add(whole);
    else {
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(t);
        if (m) {
          const v = m[2].trim().replace(/^["']|["']$/g, "");
          if (SECRET_KEY_RE.test(m[1]) && v) vals.add(v);
        } else if (isSecret && t.length >= 16) vals.add(t);
      }
    }
    for (const v of vals) if (v.length >= MIN_SECRET_LEN && !v.startsWith("/")) out.push({ name, value: v });
  }
  // 长的先换：一个值是另一个值的子串时，别让短的先把长的劈开
  return out.sort((a, b) => b.value.length - a.value.length);
}

class HistoryWriter {
  /**
   * @param {object} o
   * @param {string} o.dir                 全本目录
   * @param {string} [o.secretsDir]        已知密钥在哪（默认 /root/.secrets；测试传隔离目录）
   * @param {function} [o.log]
   */
  constructor({ dir, secretsDir = process.env.GATE_HISTORY_SECRETS_DIR || require("../core/paths").secretsDir(), log = () => {} } = {}) {
    if (!String(dir || "").trim()) throw new Error("全本要一个目录（history dir），不猜");
    this.dir = dir;
    this.log = log;
    fs.mkdirSync(path.join(dir, "opaque"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(dir, "blobs"), { recursive: true, mode: 0o700 });
    this.secrets = loadSecretValues(secretsDir);
    this.seen = new Set();
    this.seenOpaque = new Set();
    const months = this.#recentMonths();
    for (const m of months) {
      this.#loadIds(path.join(dir, `items-${m}.jsonl`), this.seen);
      this.#loadIds(path.join(dir, "opaque", `items-${m}.jsonl`), this.seenOpaque);
    }
  }

  #recentMonths() {
    const now = new Date();
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    return [prev.toISOString().slice(0, 7), now.toISOString().slice(0, 7)];
  }

  #loadIds(file, set) {
    let raw;
    try { raw = fs.readFileSync(file, "utf8"); } catch { return; }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); if (o && o.id) set.add(o.id); } catch { /* 半截行跳过 */ }
    }
  }

  /** 深拷贝的同时把已知密钥值换掉，返回 [新值, 替换次数]。 */
  scrubSecrets(value) {
    let count = 0;
    const walk = (v) => {
      if (typeof v === "string") {
        let s = v;
        for (const { name, value: secret } of this.secrets) {
          if (!s.includes(secret)) continue;
          const parts = s.split(secret);
          count += parts.length - 1;
          s = parts.join(`«secret:${name}»`);
        }
        return s;
      }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") {
        const o = {};
        for (const [k, x] of Object.entries(v)) o[k] = walk(x);
        return o;
      }
      return v;
    };
    return [walk(value), count];
  }

  #appendLine(file, obj) {
    fs.appendFileSync(file, JSON.stringify(obj) + "\n", { encoding: "utf8", mode: 0o600 });
  }

  /** 主文件追加一条。同一 id 只落一次。 */
  append(item) {
    if (!item || item.v !== ITEM_VERSION) throw new Error("全本记录要 v:1");
    if (!String(item.id || "").trim()) throw new Error("全本记录要一个确定性 id");
    if (this.seen.has(item.id)) return { written: false, id: item.id };
    const [clean, n] = this.scrubSecrets(item);
    const total = n + (Number(item.secretsScrubbed) || 0);
    if (total) { clean.secretsScrubbed = total; this.log(`[全本] ${item.id} 里换掉 ${total} 处已知密钥`); }
    this.#appendLine(path.join(this.dir, `items-${monthOf(item.at)}.jsonl`), clean);
    this.seen.add(item.id);
    return { written: true, id: item.id };
  }

  /** opaque/ 追加一条（thinking+signature、codex 加密 reasoning）。 */
  appendOpaque(rec) {
    if (!String(rec && rec.id || "").trim()) throw new Error("opaque 记录要 id");
    if (this.seenOpaque.has(rec.id)) return { written: false, id: rec.id };
    const [clean] = this.scrubSecrets(rec);
    this.#appendLine(path.join(this.dir, "opaque", `items-${monthOf(rec.at)}.jsonl`), clean);
    this.seenOpaque.add(rec.id);
    return { written: true, id: rec.id };
  }

  /** 存一个 blob（Buffer 或字符串），返回 sha256。同内容只存一份。字符串先脱敏。 */
  putBlob(data) {
    let buf = data;
    if (typeof data === "string") buf = Buffer.from(this.scrubSecrets(data)[0], "utf8");
    if (!Buffer.isBuffer(buf)) throw new Error("blob 只收 Buffer 或字符串");
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    const file = path.join(this.dir, "blobs", sha);
    if (!fs.existsSync(file)) {
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, buf, { mode: 0o600 });
      fs.renameSync(tmp, file);
    }
    return sha;
  }

  /** 工具结果正文：≤16KB 内联；超了内联前 16KB、全文进 blob。 */
  inlineOrBlob(text) {
    // 先脱敏再量长度：换完的 «secret:…» 比原值长，后量会超 16KB
    const [s, scrubbed] = this.scrubSecrets(String(text == null ? "" : text));
    if (Buffer.byteLength(s, "utf8") <= INLINE_TEXT_MAX) return { text: s, blob: null, scrubbed };
    const head = Buffer.from(s, "utf8").subarray(0, INLINE_TEXT_MAX).toString("utf8").replace(/\uFFFD+$/, "");
    return { text: head, blob: this.putBlob(s), truncated: true, scrubbed };
  }

  appendEpoch(rec) { this.#appendLine(path.join(this.dir, "epochs.jsonl"), rec); }
  appendRedaction(rec) { this.#appendLine(path.join(this.dir, "redactions.jsonl"), this.scrubSecrets(rec)[0]); }

  readJsonl(name) {
    let raw;
    try { raw = fs.readFileSync(path.join(this.dir, name), "utf8"); } catch { return []; }
    const out = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
    }
    return out;
  }

  readEpochs() { return this.readJsonl("epochs.jsonl"); }
  readRedactions() { return this.readJsonl("redactions.jsonl"); }
}

/** 读一个全本目录里的所有主文件（按月份顺序，文件内按行序）。读到不认识的 v 就停，不猜。 */
function readHistoryItems(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const files = names.filter((n) => /^items-\d{4}-\d{2}\.jsonl$/.test(n)).sort();
  const out = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(dir, f), "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.v !== ITEM_VERSION) throw new Error(`全本里有不认识的版本 v=${o.v}（${f}），停，不猜`);
      out.push(o);
    }
  }
  return out;
}

function readHistoryRedactions(dir) {
  try {
    return fs.readFileSync(path.join(dir, "redactions.jsonl"), "utf8").split("\n").filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

module.exports = { HistoryWriter, ITEM_VERSION, INLINE_TEXT_MAX, loadSecretValues, readHistoryItems, readHistoryRedactions, monthOf };
