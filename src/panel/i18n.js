"use strict";

/**
 * 界面文案（2026-10-22）：中文默认，另有英文。gettext 式 —— 中文原句就是键：
 *   L("改文件")、L("最老一条悬了 {0}", dur)
 * 英文表在 ./i18n-en.js；查不到就原样用中文（不会空着）。
 *
 * 选哪种：PANEL_LANG=zh | en | auto（默认 auto：看浏览器的 Accept-Language，en 排在 zh 前面就用英文，否则中文）。
 * 覆盖文案：PANEL_COPY_FILE 指一个 JSON：{ "zh": { "原句": "改成这句" }, "en": { "原句": "Your copy" } }
 *   —— 比如登录页那句「门已经为你开好了。」想换个说法，不用改代码。
 *
 * 每个请求的语言放在 AsyncLocalStorage 里（同时进来两个不同语言的请求也不会串）。
 * 时区：PANEL_TZ（默认 Asia/Shanghai）；页面上「北京时间」字样按它换。
 */

const fs = require("fs");
const { AsyncLocalStorage } = require("async_hooks");

const als = new AsyncLocalStorage();
let EN = null;
const copyCache = new Map();
const misses = new Set();

function en() { if (!EN) EN = require("./i18n-en"); return EN; }

function readCopy(file) {
  if (!file) return {};
  if (!copyCache.has(file)) {
    let j = {};
    try { j = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch { j = {}; }
    copyCache.set(file, j);
  }
  return copyCache.get(file);
}

/** 这个请求用哪种语言。 */
function pickLang(env = {}, headers = {}) {
  const want = String(env.PANEL_LANG || "auto").trim().toLowerCase();
  if (want === "zh" || want === "en") return want;
  const al = String(headers["accept-language"] || "").toLowerCase();
  const iEn = al.search(/(^|,)\s*en\b/), iZh = al.search(/(^|,)\s*zh\b/);
  if (iEn >= 0 && (iZh < 0 || iEn < iZh)) return "en";
  return "zh";
}

function ctx() { return als.getStore() || { lang: "zh", copy: {}, tz: "Asia/Shanghai" }; }
const lang = () => ctx().lang;
const tz = () => ctx().tz || "Asia/Shanghai";

/** 译一句。{0} {1} 换成参数。 */
function L(s, ...args) {
  const c = ctx();
  const over = (c.copy && c.copy[c.lang]) || {};
  let t;
  if (Object.prototype.hasOwnProperty.call(over, s)) t = over[s];
  else if (c.lang === "en") {
    const d = en();
    if (Object.prototype.hasOwnProperty.call(d, s)) t = d[s];
    else { t = s; misses.add(s); }
  } else t = s;
  return args.length ? String(t).replace(/\{(\d+)\}/g, (m, i) => (args[Number(i)] !== undefined ? String(args[Number(i)]) : m)) : t;
}

/** 不翻译、只换占位符 —— 落盘的东西（审计账）用它，永远是中文原句。 */
function zh(s, ...args) {
  return args.length ? String(s).replace(/\{(\d+)\}/g, (m, i) => (args[Number(i)] !== undefined ? String(args[Number(i)]) : m)) : s;
}

/** 页面上写的时区名。 */
function tzLabel() {
  const z = tz();
  return z === "Asia/Shanghai" ? L("北京时间") : z;
}

/** 在一个请求的语言里跑 fn。 */
function run({ env = {}, headers = {} } = {}, fn) {
  const c = { lang: pickLang(env, headers), copy: readCopy(String(env.PANEL_COPY_FILE || "").trim()), tz: String(env.PANEL_TZ || "").trim() || "Asia/Shanghai" };
  return als.run(c, fn);
}

module.exports = { L, zh, run, lang, tz, tzLabel, pickLang, misses };
