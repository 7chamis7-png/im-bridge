"use strict";

/**
 * 本机控制口（2026-10-22）—— 面板怎么替她按一下 /new
 *
 * ## 为什么不复用现成的两个口
 *
 *   · tools.sock（工具口）是**他**的嘴：claude 拉起来的 MCP 子进程连它，替他往外发话。
 *     往那儿加一个「下命令」，等于让他自己的工具也能给自己换舱 —— 不行。
 *   · producers/（生产者投递口）投进去的是**一轮话**，进盒子给他看；命令不进盒子。
 *
 * 所以单开一个：`$GATE_ROOT/control.sock`，0600，只认本机 unix socket。
 *
 * ## 只做一件事：以主人身份跑**白名单里的**命令（一条，或者一串）
 *
 * 跑法 = `pipe.runOwnerCommand`：跟她在 TG 里发同一张命令表、同一条串行道（见 pipeline.js）。
 * 白名单（2026-10-22 起）：new / model / engine。认不出的、不在白名单的、参数没过校验的，直接回错，不进盒子、不猜。
 *   new     理由：一行、≤80 字
 *   model   只收**一个**模型 id，必须在这个人的登记表里（validate 钩子由宿主给，读 models.json）
 *   engine  同上（跨厂商换引擎）；不收 now 之类的附加词
 * 一串（texts）最多 2 条：面板「换舱 + 同一家换模型」= ["/new …", "/model <id>"]。
 *
 * ## 协议（一行一个 JSON，跟工具口一样）
 *
 *   → {"id":"1","op":"command","text":"/new 面板手动换舱","by":"panel","waitMs":3000}
 *   ← {"id":"1","ok":true,"job":{"id":"j-…","state":"queued|running|done|failed","command":"new","as":"alice","text":"…"}}
 *   → {"id":"3","op":"command","texts":["/new 她在面板上按的","/model claude-opus-5-5[1m]"],"by":"panel"}
 *   → {"id":"2","op":"status","job":"j-…"}
 *   ← {"id":"2","ok":true,"job":{…}}
 *
 * /new 要等这一轮说完、跑收尾轮，可能要好几分钟 —— 所以先回「排上了」，结果另问（status）。
 * 任务表只在内存里：桥一重启就没了（那种时候她在 TG 里也会收到结果或者根本没换）。
 */

const fs = require("fs");
const net = require("net");
const path = require("path");
const crypto = require("crypto");

const MAX_JOBS = 30;
const MAX_WAIT_MS = 10_000;

/**
 * @param {object} o
 * @param {string} o.file            socket 路径（GATE_ROOT 底下）
 * @param {function} o.run           (text, {by, onStart}) => Promise<{ok, command, text}> —— pipe.runOwnerCommand
 * @param {function} [o.parse]       (text) => {name}|null —— 只用来查白名单（不给就按斜杠后第一个词）
 * @param {string}  [o.owner]        主人的身份名（回执里写给面板看）
 * @param {string[]} [o.allow]       白名单命令名
 * @param {function} [o.log]
 */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\[\]\/-]{0,79}$/;
const MAX_SEQ = 2;

/**
 * 参数的格式关（内容关——id 在不在登记表——由宿主的 validate 钩子管）。
 * @returns {string} 错误说明；空串 = 过了
 */
function checkArgs(name, rest) {
  const r = String(rest || "");
  if (name === "new") {
    if (/[\r\n]/.test(r)) return "换舱理由只能一行";
    if (r.length > 80) return "换舱理由太长（≤80 字）";
    return "";
  }
  if (name === "model" || name === "engine") {
    if (!r) return `/${name} 要给一个模型 id`;
    if (!MODEL_ID.test(r)) return `/${name} 只收一个模型 id（字母数字和 . _ : [ ] / -），不收别的字`;
    return "";
  }
  return "";
}

function makeControlSocket({ file, run, parse = null, validate = null, owner = "", allow = ["new", "model", "engine"], log = () => {} }) {
  if (!String(file || "").trim()) throw new Error("控制口要一个 socket 路径 —— 不许用默认值猜");
  if (typeof run !== "function") throw new Error("控制口要一个跑命令的函数（pipe.runOwnerCommand）");
  const allowed = new Set(allow.map((s) => String(s).toLowerCase()));
  const jobs = new Map();

  const nameOf = (text) => {
    if (parse) { const p = parse(text); return p ? p.name : ""; }
    const m = /^\/([A-Za-z][A-Za-z0-9_-]*)/.exec(String(text || "").trim());
    return m ? m[1].toLowerCase() : "";
  };
  const view = (j) => ({ id: j.id, state: j.state, command: j.command, as: j.as, by: j.by, texts: j.texts || [],
    at: j.at, startedAt: j.startedAt || "", doneAt: j.doneAt || "", text: j.text || "", steps: j.steps || [] });

  function remember(j) {
    jobs.set(j.id, j);
    while (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value);
  }

  async function handle(req) {
    const op = String((req && req.op) || "");
    if (op === "status") {
      const j = jobs.get(String(req.job || ""));
      return j ? { ok: true, job: view(j) } : { ok: false, error: "不认识这个编号（桥可能重启过）" };
    }
    if (op !== "command") return { ok: false, error: "不认识的操作：" + (op || "(空)") };
    const texts = Array.isArray(req.texts) ? req.texts.map((t) => String(t || "").trim()) : [String(req.text || "").trim()];
    if (!texts.length || texts.length > MAX_SEQ) return { ok: false, error: `一次最多 ${MAX_SEQ} 条命令` };
    const names = [];
    for (const text of texts) {
      const name = nameOf(text);
      if (!name) return { ok: false, error: "不是命令" };
      if (!allowed.has(name)) return { ok: false, error: `控制口不收 /${name}（只收 ${[...allowed].map((x) => "/" + x).join(" ")}）` };
      const m = /^\/[A-Za-z][A-Za-z0-9_-]*\s*([\s\S]*)$/.exec(text);
      const rest = m ? m[1].trim() : "";
      const why = checkArgs(name, rest) || (typeof validate === "function" ? String(validate(name, rest) || "") : "");
      if (why) return { ok: false, error: why };
      names.push(name);
    }
    // 只认这几种形状：/new · /model · /engine 单条；/new 再 /model（换舱 + 同一家换模型）
    const shape = names.join("+");
    if (texts.length > 1 && shape !== "new+model") return { ok: false, error: `不认这串命令：${names.map((n) => "/" + n).join(" → ")}（只认 /new → /model）` };
    const name = shape;
    const text = texts.length > 1 ? texts : texts[0];
    const by = String(req.by || "control").replace(/[^\w-]/g, "").slice(0, 20) || "control";
    const j = { id: "j-" + crypto.randomBytes(6).toString("hex"), state: "queued", command: name, as: owner, by, texts,
      at: new Date().toISOString(), text: "" };
    remember(j);
    log(`[控制口] ${by} 以主人身份下 /${name}（${j.id}）`);
    const p = Promise.resolve()
      .then(() => run(text, { by, onStart: () => { j.state = "running"; j.startedAt = new Date().toISOString(); } }))
      .then((r) => { j.state = r && r.ok !== false ? "done" : "failed"; j.text = String((r && r.text) || ""); j.steps = (r && r.steps) || []; },
        (e) => { j.state = "failed"; j.text = String((e && e.message) || e); })
      .then(() => { j.doneAt = new Date().toISOString(); log(`[控制口] ${j.id} ${j.state}`); });
    const waitMs = Math.max(0, Math.min(MAX_WAIT_MS, Number(req.waitMs) || 0));
    if (waitMs) await Promise.race([p, new Promise((r) => setTimeout(r, waitMs).unref())]);
    return { ok: true, job: view(j) };
  }

  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (buf.length > 64 * 1024) { sock.destroy(); return; }
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let req = null;
        try { req = JSON.parse(line); }
        catch { sock.write(JSON.stringify({ ok: false, error: "不是 JSON" }) + "\n"); continue; }
        Promise.resolve()
          .then(() => handle(req))
          .catch((e) => ({ ok: false, error: String((e && e.message) || e) }))
          .then((res) => {
            try { sock.write(JSON.stringify({ id: req && req.id, ...res }) + "\n"); }
            catch (e) { log("[控制口] 回不去：" + ((e && e.message) || e)); }
          });
      }
    });
    sock.on("error", (e) => log("[控制口] 连接出错：" + ((e && e.message) || e)));
  });

  return {
    handle,
    jobs: () => [...jobs.values()].map(view),
    async start() {
      try { fs.unlinkSync(file); } catch { /* 没有就算了 */ }
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      // 收紧 umask 只包住 listen 这一句（unix socket 是同步 bind 的），不跨 await ——
      // 否则这段时间里别的代码建的文件也会被收紧。之后再 chmod 一次兜底。
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        const old = process.umask(0o177);
        try { server.listen(file, () => { server.removeListener("error", reject); resolve(); }); }
        finally { process.umask(old); }
      });
      fs.chmodSync(file, 0o600);
      log("[控制口] 开在 " + file + "（只收 " + [...allowed].map((x) => "/" + x).join(" ") + "）");
      return file;
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      try { fs.unlinkSync(file); } catch { /* 已经没了 */ }
    },
  };
}

module.exports = { makeControlSocket, checkArgs, MODEL_ID };
