"use strict";

/**
 * 面板的 HTML。服务端渲染、零外部资源（图只走本机 /assets/，CSS / SVG 内联），零脚本。
 *
 * 视觉（第三轮，2026-10-22）：照一份 Duomo 设计稿换皮 ——
 *   白天：暖白大理石 + 哑光金、左侧栏、大教堂立面大图头图（圆形花窗）、古典衬线大标题和大数字、
 *         数字卡片后衬尖拱线条；
 *   夜间（设计稿没有，跟随系统 prefers-color-scheme）：教堂内部夜景 —— 深石色底、烛光暖金、
 *         彩窗光晕，立面压暗、圆形花窗像被里面的烛光点亮。
 * 手机单列（侧栏收成顶上一排可横滑的导航），电脑左侧栏。没有 JS（CSP 禁脚本）。
 */

const i18n = require("./i18n");
const { L, tzLabel } = i18n;
const esc = (v) => String(v === undefined || v === null ? "" : v)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const isEn = () => i18n.lang() === "en";

/** 角色的点缀色（只用在名字旁的小色点 / 卡片上沿那道细线）。 */
const GEMS = ["sapphire", "ruby", "emerald", "amber"];

// ——— 术语一律中文（表里存中文原句，用的时候过 L）———
const INGRESS_STATE = { uncertain: "没确认", pending: "排队中", dispatching: "发送中", started: "处理中", completed: "已完成" };
const PM2_STATE = { online: "运行中", stopped: "停着", stopping: "正在停", errored: "出错", launching: "启动中", "waiting restart": "等重启", "one-launch-status": "跑完即停" };
const RUNTIME = { claudecode: "Claude", codex: "Codex", deepseek: "DeepSeek" };
const SECTION_CN = { "执行规则": "执行规则", "身份底座": "身份底座", "SESSION HANDOFF": "换舱交接", "LONG-TERM MEMORY": "长期记忆",
  "PENDING PROMISES": "笔记本 · 手上的事", "RECENT DIARY": "最近的日记", "BODY STATE": "身体状态" };
/** 查表：查得到就译，查不到原样（数据本身不进翻译表）。 */
const T = (table, k) => (!Object.prototype.hasOwnProperty.call(table, k) ? k : /[\u3000-\u9fff\uff00-\uffef]/.test(table[k]) ? L(table[k]) : table[k]);
const ingressCn = (s) => T(INGRESS_STATE, s);
const secCn = (n) => (Object.prototype.hasOwnProperty.call(SECTION_CN, n) ? L(SECTION_CN[n]) : n);
const sectionLabel = (n) => (SECTION_CN[n] && SECTION_CN[n] !== n ? `${secCn(n)}（${n}）` : n);
/** 改文件清单里的「节」：底子的节名，或者 files.js 给的「人格 · 人格文件」「他写的东西」。 */
const ROLE_CN = new Set(["人格文件", "工作目录里引擎自己读的"]);
function fileSecCn(n) {
  const m = /^人格 · (.*)$/.exec(String(n));
  if (m) return L("人格 · {0}", ROLE_CN.has(m[1]) ? L(m[1]) : m[1]);
  if (n === "他写的东西") return L("他写的东西");
  return secCn(n);
}
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

// ——— 时间（默认北京时间；PANEL_TZ 可换）———
function bjParts(ms) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: i18n.tz(), year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
}
function fmtTime(ms) {
  if (!ms) return "—";
  const p = bjParts(ms);
  return `${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
function fmtDur(ms) {
  if (!(ms > 0)) return "—";
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  if (isEn()) {
    if (m < 1) return "under a minute";
    if (m < 60) return m + " min";
    if (h < 48) return h + (h === 1 ? " hour" : " hours") + (m % 60 && h < 10 ? " " + (m % 60) + " min" : "");
    return Math.floor(h / 24) + " days";
  }
  if (m < 1) return "不到 1 分钟";
  if (m < 60) return m + " 分钟";
  if (h < 48) return h + " 小时" + (m % 60 && h < 10 ? " " + (m % 60) + " 分" : "");
  return Math.floor(h / 24) + " 天";
}
const ago = (ms, now) => (ms ? (isEn() ? fmtDur(now - ms) + " ago" : fmtDur(now - ms) + "前") : "");
/** 284000 → 28.4 万（英文：284k / 1M） */
function wan(n) {
  if (isEn()) {
    if (n >= 1e6) return (Math.round(n / 1e5) / 10).toString() + "M";
    if (n >= 10000) return Math.round(n / 1000) + "k";
    return String(n);
  }
  return n >= 10000 ? (Math.round(n / 1000) / 10).toString() + " 万" : String(n);
}
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// ——— 图标（线条，currentColor）———
const ico = (d, cls = "") => `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const I = {
  overview: ico(`<rect x="3.5" y="3.5" width="7" height="7" rx="1"/><rect x="13.5" y="3.5" width="7" height="7" rx="1"/><rect x="3.5" y="13.5" width="7" height="7" rx="1"/><rect x="13.5" y="13.5" width="7" height="7" rx="1"/>`),
  persona: ico(`<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20.5c1.2-4 4.1-6 7.5-6s6.3 2 7.5 6"/>`),
  pending: ico(`<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>`),
  errors: ico(`<path d="M12 3.5 21.5 20h-19Z"/><path d="M12 10v4.2"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>`),
  base: ico(`<path d="M6 3.5h10.5A2.5 2.5 0 0 1 19 6v14.5H8.5A2.5 2.5 0 0 1 6 18Z"/><path d="M6 18a2.5 2.5 0 0 1 2.5-2.5H19"/><path d="M10 8h5M10 11h5"/>`),
  chip: ico(`<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/><rect x="9.5" y="9.5" width="5" height="5"/><path d="M9.5 3v3.5M14.5 3v3.5M9.5 17.5V21M14.5 17.5V21M3 9.5h3.5M3 14.5h3.5M17.5 9.5H21M17.5 14.5H21"/>`),
  chat: ico(`<path d="M20 11.5a7.5 7.5 0 0 1-11.1 6.6L4 19.5l1.5-4.4A7.5 7.5 0 1 1 20 11.5Z"/>`),
  arrow: ico(`<path d="M5 12h14M13.5 6.5 19 12l-5.5 5.5"/>`, "arr"),
  back: ico(`<path d="M19 12H5M10.5 6.5 5 12l5.5 5.5"/>`, "arr"),
  rotate: ico(`<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.8 4.2v4.3h-4.3"/>`),
  quill: ico(`<path d="M20 4c-7 1-11.5 6-13 13l-1.5 3.5"/><path d="M20 4c-.5 5-3.5 9-9 10.5"/><path d="M7 17h5"/>`),
  ledger: ico(`<path d="M6.5 3.5h11v17h-11z"/><path d="M9.5 8h5M9.5 11.5h5M9.5 15h3"/>`),
  history: ico(`<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.2 4.2v4.3h4.3"/><path d="M12 8v4.5l3 1.8"/>`),
};
const SEAL = `<svg class="seal" viewBox="0 0 36 42" fill="none" stroke="currentColor" stroke-width="1.25" aria-hidden="true"><path d="M4 40.5V18Q4 8.5 18 2Q32 8.5 32 18v22.5"/><path d="M8.5 40.5V20Q8.5 12.5 18 7.5Q27.5 12.5 27.5 20v20.5"/><circle cx="18" cy="21" r="5.2"/><circle cx="18" cy="21" r="1.6"/><path d="M18 15.8v10.4M12.8 21h10.4M14.3 17.3l7.4 7.4M21.7 17.3l-7.4 7.4"/><path d="M13 40.5V31a5 5 0 0 1 10 0v9.5"/><path d="M1.5 40.5h33"/><path d="M18 2V0"/></svg>`;

const CSS = `
:root{color-scheme:light dark;
--paper:#f7f3eb;--paper2:#f2ece1;--panel:#fffdf8;--panel2:rgba(255,253,248,.92);--panel-solid:#fffcf9;--side:linear-gradient(165deg,rgba(255,254,251,.98),rgba(251,246,235,.93));
--ink:#2d2a28;--ink2:#5c5147;--muted:#8e857a;--quiet:#aea393;--line:#e8d9c3;--line2:#efe7da;--line-dark:#d6bd98;
--gold:#aa8150;--gold-deep:#86603c;--gold-text:#987246;--gold-soft:rgba(214,178,126,.30);--eyebrow:#ab7c41;
--ok:#6f9479;--warn:#b98446;--bad:#a8544d;--ok-bg:rgba(111,148,121,.11);--warn-bg:rgba(185,132,70,.12);--bad-bg:rgba(168,84,77,.10);
--sapphire:#5d7aa6;--ruby:#a4505f;--emerald:#5f9077;--amber:#b88a45;
--shadow:0 6px 22px rgba(117,83,46,.075);--shadow-lg:0 12px 30px rgba(111,81,46,.11);
--hero-veil:linear-gradient(90deg,#fffaf0 0%,rgba(255,249,239,.97) 27%,rgba(255,250,242,.77) 40%,rgba(253,249,240,.06) 70%);
--hero-bg:radial-gradient(ellipse at 80% 28%,#fffdf5 0,transparent 46%),linear-gradient(100deg,#fffdf8 1%,#f9f2e8 55%,#eee4d4 100%);
--hero-img-filter:saturate(.91);--hero-h1:#282423;--hero-shadow:0 1px 0 #fff;
--serif:'Iowan Old Style','Baskerville','Songti SC','Noto Serif CJK SC','Source Han Serif SC','STSong',Georgia,serif;
--latin:'Iowan Old Style','Baskerville',Georgia,'Times New Roman','Liberation Serif',serif;
--ui:'SF Pro Display','PingFang SC','Microsoft YaHei','Noto Sans CJK SC',system-ui,sans-serif;
--mono:ui-monospace,'SF Mono',Menlo,Consolas,'Noto Sans Mono CJK SC',monospace}
@media (prefers-color-scheme:dark){:root{
--paper:#141417;--paper2:#1b1a1e;--panel:rgba(35,32,33,.90);--panel2:rgba(27,26,29,.90);--panel-solid:#221f20;--side:linear-gradient(170deg,rgba(26,24,26,.97),rgba(18,18,21,.97));
--ink:#efe6d6;--ink2:#d4c6b1;--muted:#a69b8a;--quiet:#857b6e;--line:#43392d;--line2:#2f2a25;--line-dark:#6b5639;
--gold:#d4a862;--gold-deep:#b0843f;--gold-text:#e3b96f;--gold-soft:rgba(214,171,102,.20);--eyebrow:#d9a85c;
--ok:#94bd9f;--warn:#e3b264;--bad:#ec8f86;--ok-bg:rgba(148,189,159,.12);--warn-bg:rgba(227,178,100,.13);--bad-bg:rgba(236,143,134,.13);
--sapphire:#8fb0e6;--ruby:#e48aa0;--emerald:#8fcfae;--amber:#e8bb72;
--shadow:0 8px 26px rgba(0,0,0,.45);--shadow-lg:0 14px 40px rgba(0,0,0,.55);
--hero-veil:linear-gradient(90deg,rgba(17,17,20,.98) 0%,rgba(19,18,21,.94) 30%,rgba(22,20,22,.55) 50%,rgba(20,19,22,.05) 76%);
--hero-bg:radial-gradient(ellipse at 66% 40%,rgba(255,196,120,.16) 0,transparent 40%),linear-gradient(100deg,#151417 1%,#1d1a1b 60%,#231f1d 100%);
--hero-img-filter:brightness(.50) sepia(.35) saturate(1.25) contrast(1.08);--hero-h1:#f3e9d8;--hero-shadow:0 2px 14px rgba(0,0,0,.6)}}
*{box-sizing:border-box}
html{scroll-behavior:smooth;background:var(--paper)}
body{margin:0;min-width:320px;color:var(--ink);font:14px/1.6 var(--ui);-webkit-font-smoothing:antialiased;
 background-color:var(--paper);background-image:radial-gradient(ellipse at 80% 2%,rgba(255,255,255,.94),transparent 30%),radial-gradient(ellipse at 16% 63%,rgba(227,214,194,.16),transparent 49%),repeating-linear-gradient(132deg,rgba(140,112,78,.018) 0,rgba(140,112,78,.018) 1px,transparent 1px,transparent 55px)}
@media (prefers-color-scheme:dark){body{background-image:
 radial-gradient(ellipse 60% 40% at 88% 0%,rgba(227,185,111,.13),transparent 70%),
 radial-gradient(ellipse 40% 50% at 8% 42%,rgba(84,118,196,.17),transparent 70%),
 radial-gradient(ellipse 36% 36% at 70% 78%,rgba(170,58,84,.13),transparent 70%),
 radial-gradient(ellipse 30% 30% at 34% 96%,rgba(70,150,120,.07),transparent 70%),
 repeating-linear-gradient(132deg,rgba(214,171,102,.022) 0,rgba(214,171,102,.022) 1px,transparent 1px,transparent 55px)}}
a{color:inherit;text-decoration:none}
.ico{width:18px;height:18px;flex:none}
.latin{font-family:var(--latin)}
/* —— 骨架：侧栏 + 主区 —— */
.shell{min-height:100vh;display:flex}
.side{width:246px;flex:none;position:sticky;top:0;height:100vh;display:flex;flex-direction:column;padding:36px 19px 19px;z-index:5;isolation:isolate;
 background:var(--side);border-right:2px solid var(--line);box-shadow:inset -4px 0 12px rgba(136,107,63,.035);overflow-y:auto}
.side:before{content:"";position:absolute;pointer-events:none;z-index:-1;inset:0 7px;border-left:1px solid rgba(191,151,96,.17);border-right:1px solid rgba(191,151,96,.17)}
.side:after{content:"";position:absolute;pointer-events:none;z-index:-1;left:0;right:0;bottom:96px;height:230px;background:url(/assets/cathedral.svg) center bottom/150% auto no-repeat;opacity:.34;
 -webkit-mask-image:linear-gradient(to bottom,transparent 1%,#000 55%);mask-image:linear-gradient(to bottom,transparent 1%,#000 55%)}
@media (prefers-color-scheme:dark){.side:after{background:linear-gradient(180deg,rgba(18,18,21,.2),rgba(18,18,21,.55)),url(/assets/duomo-interior.webp) center/cover no-repeat;opacity:.55;height:300px;bottom:90px}}
.brand{display:flex;align-items:center;gap:13px;padding:0 8px 40px;color:var(--gold)}
.seal{width:34px;height:40px;flex:none;filter:drop-shadow(0 2px 1px rgba(201,166,117,.24))}
.brand b{display:block;font:600 17px var(--latin);letter-spacing:3.4px;color:var(--ink)}
.brand b.cn{font:600 19px var(--serif);letter-spacing:5px}
.brand small{display:block;font:9px var(--latin);color:var(--gold);letter-spacing:2.3px;margin-top:5px}
.overline{font:9px var(--latin);letter-spacing:2.3px;color:#b69e82;margin:0 0 14px 14px}
.overline.s2{margin-top:26px}
.nav{display:flex;flex-direction:column;gap:5px}
.nl{position:relative;display:flex;align-items:center;gap:12px;min-height:49px;padding:4px 12px;border:1px solid transparent;border-radius:8px;color:var(--ink2);transition:background .2s,border-color .2s}
.nl:hover{background:rgba(242,236,224,.6);border-color:var(--line2)}
@media (prefers-color-scheme:dark){.nl:hover{background:rgba(214,171,102,.06)}}
.nl .ico{color:var(--gold);opacity:.9}
.nl .t{display:flex;flex-direction:column;gap:3px;line-height:1.16;min-width:0}
.nl .t b{font:500 14px var(--serif);letter-spacing:.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nl .t small{font:9.5px var(--latin);color:var(--quiet);letter-spacing:.8px}
.nl .n{margin-left:auto;font:12px var(--latin);color:var(--bad);background:var(--bad-bg);border-radius:20px;padding:0 8px}
.nl.on{border-color:#e5ccb0;background:linear-gradient(105deg,#fffdf8 5%,#f4e7d2 100%);box-shadow:0 3px 16px rgba(158,126,85,.13),inset 0 0 0 3px rgba(255,255,255,.33)}
.nl.on .t b{font-weight:600;color:var(--ink)}
.nl.on:after{content:"";position:absolute;right:13px;top:50%;width:5px;height:5px;margin-top:-2.5px;border-radius:50%;background:#bf8c4d;box-shadow:0 0 0 2px rgba(233,209,174,.33)}
.nl.on .n{margin-right:12px}
@media (prefers-color-scheme:dark){.nl.on{border-color:#5d4a33;background:linear-gradient(105deg,rgba(214,171,102,.05) 5%,rgba(214,171,102,.16) 100%);box-shadow:0 3px 16px rgba(0,0,0,.4),0 0 18px rgba(227,185,111,.08)}}
.sep{height:1px;background:var(--line);margin:24px 14px 0}
.side-bottom{margin-top:auto;padding-top:24px}
.mark{display:flex;justify-content:center;gap:12px;font:8px var(--latin);letter-spacing:1.5px;color:var(--quiet);margin-bottom:20px;white-space:nowrap}
.idc{display:flex;align-items:center;gap:11px;border:1px solid #dcbf9d;background:#fbf4e9;padding:10px;border-radius:8px;box-shadow:0 5px 16px rgba(145,107,70,.10)}
@media (prefers-color-scheme:dark){.idc{border-color:#56462f;background:rgba(30,27,27,.92);box-shadow:0 5px 16px rgba(0,0,0,.4)}}
.idc .av{width:35px;height:35px;flex:none;background:#e8e0d4;border-radius:50% 50% 5px 5px;display:grid;place-items:center;color:#89745a;font:19px var(--serif)}
@media (prefers-color-scheme:dark){.idc .av{background:#3a3128;color:var(--gold)}}
.idc b{display:block;font-size:12px;font-weight:600;margin-bottom:3px}
.idc small{display:block;font-size:10px;color:var(--quiet)}
.main{flex:1;min-width:0;display:flex;flex-direction:column}
.top{height:72px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 48px;position:relative;
 background:linear-gradient(90deg,rgba(255,253,248,.72),rgba(248,240,228,.79));border-bottom:1px solid var(--line)}
@media (prefers-color-scheme:dark){.top{background:linear-gradient(90deg,rgba(24,23,26,.85),rgba(30,27,27,.85))}}
.top:after{content:"";position:absolute;bottom:3px;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,rgba(215,184,138,.3) 40%,rgba(215,184,138,.3) 60%,transparent);pointer-events:none}
.top .l,.top .r{display:flex;align-items:center;gap:14px;min-width:0}
.crumb{font:9px var(--latin);letter-spacing:2px;color:var(--quiet);white-space:nowrap}
.cdiv{color:#c6bfb3;font-size:16px}
.top strong{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.date{font:10px var(--latin);letter-spacing:1.4px;color:var(--muted);white-space:nowrap}
.vline{width:1px;height:16px;background:var(--line-dark);opacity:.6}
.mode{display:flex;align-items:center;gap:8px;font-size:11px;letter-spacing:1.5px;color:var(--ink2);white-space:nowrap}
.mode i{width:6px;height:6px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 3px var(--ok-bg)}
.top .mseal{display:none;color:var(--gold)}.top .mseal .seal{width:24px;height:28px}
.mnav{display:none}
.page{padding:32px 48px 20px;max-width:1500px;width:100%;margin:0 auto;flex:1}
.foot{display:flex;justify-content:space-between;gap:16px;padding:22px 48px 28px;color:var(--quiet);font:9px var(--latin);letter-spacing:1.65px;max-width:1500px;width:100%;margin:0 auto}
.foot .cn{font:11px var(--ui);letter-spacing:1px}
/* —— 首页抬头 —— */
.welcome{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:18px}
.eyebrow{font:10px var(--latin);letter-spacing:2.4px;color:var(--eyebrow);white-space:nowrap}
.eyebrow.r{color:var(--quiet)}
.hero{position:relative;height:325px;overflow:hidden;border:1px solid #d9bc90;border-radius:9px 9px 17px 9px;background:var(--hero-bg);
 box-shadow:var(--shadow-lg),inset 0 0 0 4px rgba(255,255,255,.54)}
@media (prefers-color-scheme:dark){.hero{border-color:#6b5639;box-shadow:var(--shadow-lg),inset 0 0 0 4px rgba(255,255,255,.02)}}
.hero-img{position:absolute;right:-4px;bottom:-2px;width:72%;height:104%;background:url(/assets/duomo-facade.webp) 50% 50%/cover no-repeat;filter:var(--hero-img-filter);
 -webkit-mask-image:linear-gradient(to right,transparent 0%,#000 19%);mask-image:linear-gradient(to right,transparent 0%,#000 19%)}
.hero-glow{display:none}
@media (prefers-color-scheme:dark){.hero-glow{display:block;position:absolute;z-index:1;right:calc(36% - 150px);top:50%;width:300px;height:300px;margin-top:-150px;border-radius:50%;pointer-events:none;mix-blend-mode:screen;
 background:radial-gradient(closest-side,rgba(255,206,130,.42),rgba(130,160,235,.18) 55%,transparent 75%)}}
.hero:before{content:"";position:absolute;inset:0;z-index:1;pointer-events:none;background:var(--hero-veil)}
.hero:after{content:"";position:absolute;inset:11px;z-index:4;pointer-events:none;border:1px solid rgba(209,170,111,.48);border-radius:4px 4px 10px 4px}
.hero-copy{position:relative;z-index:5;width:60%;padding:44px 0 20px 50px}
.hero-label{display:flex;align-items:center;gap:11px;font:10px var(--latin);letter-spacing:2.2px;color:var(--eyebrow)}
.hero-label:before{content:"";width:26px;height:1px;background:currentColor;opacity:.7}
.hero h1{font:500 40px/1.42 var(--serif);letter-spacing:2px;margin:14px 0 8px;color:var(--hero-h1);text-shadow:var(--hero-shadow)}
.hero h1 span{color:var(--gold-text)}
@media (prefers-color-scheme:dark){.hero h1 span{text-shadow:0 0 22px rgba(227,185,111,.28)}}
.hero p{margin:0;color:var(--ink2);font-size:13px;line-height:2}
.hero-actions{display:flex;gap:11px;margin-top:20px;flex-wrap:wrap}
.hero-bottom{position:absolute;z-index:5;right:30px;bottom:24px;font:600 8px var(--latin);letter-spacing:2px;color:#7e6043;text-shadow:0 1px 4px #fff}
@media (prefers-color-scheme:dark){.hero-bottom{color:#b9955c;text-shadow:0 1px 6px #000}}
.btn{display:inline-flex;align-items:center;gap:9px;height:40px;padding:0 18px;border:1px solid #cbb089;border-radius:4px;background:rgba(255,253,248,.82);color:var(--ink);font-size:13px;letter-spacing:.5px;white-space:nowrap;transition:.2s}
.btn:hover{border-color:var(--gold);background:var(--panel-solid)}
.btn .arr{width:15px;height:15px}
.btn.primary{color:#fff8ec;background:linear-gradient(125deg,#a37d49,#86603c);border-color:#9b7747;box-shadow:0 5px 14px rgba(108,66,26,.19)}
.btn.primary:hover{background:linear-gradient(125deg,#b68b51,#8b6540)}
@media (prefers-color-scheme:dark){.btn{background:rgba(30,27,27,.8);border-color:#6b5639;color:var(--ink)}
 .btn.primary{color:#1d1610;background:linear-gradient(125deg,#e2b56c,#b88845);border-color:#e0b46c;box-shadow:0 5px 18px rgba(227,185,111,.22)}
 .btn.primary:hover{background:linear-gradient(125deg,#f0c57f,#c4924c)}}
/* —— 小节标题 —— */
.sh{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin:34px 0 16px}
.sh h2{display:flex;align-items:center;gap:12px;font:500 22px var(--serif);letter-spacing:1.5px;margin:0}
.sh h2:before{content:"✥";font-size:18px;color:#c38d44}
.sh .aside{font-size:12px;color:var(--muted);text-align:right}
/* —— 数字卡片（尖拱线条）—— */
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:17px}
.stat{position:relative;overflow:hidden;min-height:132px;padding:19px 21px 18px 26px;border:1px solid #e2cdb0;border-radius:7px;background:linear-gradient(140deg,#fffcf8,rgba(255,253,248,.92));box-shadow:var(--shadow);display:block}
.stat:before{content:"";position:absolute;right:20px;bottom:-24px;width:80px;height:120px;pointer-events:none;opacity:.45;border:1px solid #ceb28e;border-radius:48% 48% 0 0;
 box-shadow:inset 0 0 0 7px var(--panel-solid),inset 0 0 0 8px #dfc8a9,inset 0 0 0 15px var(--panel-solid),inset 0 0 0 16px #e5ccab}
.stat:after{content:"";position:absolute;top:0;right:0;width:53px;height:53px;border:1px solid #d9b889;border-left:0;border-bottom:0;opacity:.55;transform:translate(23px,-22px) rotate(45deg)}
@media (prefers-color-scheme:dark){.stat{border-color:#4d4030;background:linear-gradient(140deg,rgba(40,36,36,.94),rgba(28,27,29,.92))}
 .stat:before{border-color:#7a6242;box-shadow:inset 0 0 0 7px var(--panel-solid),inset 0 0 0 8px #5e4c35,inset 0 0 0 15px var(--panel-solid),inset 0 0 0 16px #54442f;opacity:.55}
 .stat:after{border-color:#7a6242}}
.stat-top{display:flex;justify-content:space-between;align-items:center;color:var(--muted);font-size:12.5px;position:relative}
.stat-top .ico{color:var(--gold)}
.stat-num{position:relative;font:35px/1.25 var(--latin);margin-top:12px;color:var(--ink);font-variant-numeric:lining-nums}
.stat-num small{font:14px var(--ui);color:var(--muted);margin-left:4px}
.stat-num.alarm{color:var(--bad)}
.stat-sub{position:relative;margin-top:4px;font-size:11.5px;color:var(--muted)}
.stat-sub b{font-weight:600;color:var(--ok)}.stat-sub b.w{color:var(--bad)}
a.stat:hover{border-color:var(--line-dark)}
/* —— 面板 —— */
.panel{position:relative;border:1px solid #e2cdb0;border-radius:7px;background:linear-gradient(140deg,#fffcf8,rgba(255,253,248,.92));box-shadow:var(--shadow)}
.panel:before{content:"";position:absolute;pointer-events:none;inset:5px;border:1px solid rgba(214,178,126,.22);border-radius:4px}
@media (prefers-color-scheme:dark){.panel{border-color:#4d4030;background:linear-gradient(140deg,rgba(38,35,35,.93),rgba(26,25,28,.92))}.panel:before{border-color:rgba(214,171,102,.13)}}
.pad{padding:24px 26px 20px}
.ph{display:flex;justify-content:space-between;align-items:flex-start;gap:14px}
.pt{font:500 19px var(--serif);margin:0 0 5px;letter-spacing:1px}
.ps{font:10px var(--latin);letter-spacing:1.4px;color:#a48d73}
@media (prefers-color-scheme:dark){.ps{color:#a8916f}}
.hint{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:30px;padding:7px 14px;color:var(--ink2);font-size:12px;white-space:nowrap;background:var(--panel-solid)}
.hint code{font:12px var(--mono);color:var(--gold-text)}
.note{font-size:12px;color:var(--muted);line-height:1.8}
/* —— 角色卡 —— */
.chars{display:grid;grid-template-columns:1fr;gap:20px}
@media (min-width:1150px){.chars{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (min-width:760px) and (max-width:999px){.chars{grid-template-columns:repeat(2,minmax(0,1fr))}}
.ch{position:relative;border:1px solid #e2cdb0;border-radius:8px;overflow:hidden;background:linear-gradient(140deg,#fffcf8,rgba(255,253,248,.94));box-shadow:var(--shadow);display:flex;flex-direction:column}
@media (prefers-color-scheme:dark){.ch{border-color:#5a4932;background:linear-gradient(140deg,rgba(38,35,35,.95),rgba(26,25,28,.94))}}
.ch-top{position:relative;color:#f3f0e9;padding:22px 26px 22px;min-height:252px;border-bottom:1px solid #867156;
 background:linear-gradient(90deg,rgba(23,28,32,.98) 0%,rgba(31,33,37,.88) 50%,rgba(36,34,36,.20) 100%),url(/assets/duomo-interior.webp) right center/auto 100% no-repeat,#252930}
.ch-top:before{content:"";position:absolute;top:-60px;right:-90px;width:300px;height:300px;border:1px solid rgba(209,191,155,.10);border-radius:50%;pointer-events:none}
.ch-top:after{content:"";position:absolute;left:0;right:0;top:0;height:3px;background:var(--acc)}
.ch-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;position:relative;z-index:2}
.ch-name{font:500 30px/1.2 var(--serif);letter-spacing:3px;margin:0;color:#f7f1e6}
.ch-id{font:10px var(--latin);letter-spacing:2px;color:#c5b99e;margin-top:6px}
.st{display:inline-flex;align-items:center;gap:7px;font-size:12px;letter-spacing:1px;color:#e8dfcf;white-space:nowrap;padding:4px 11px;border-radius:20px;background:rgba(0,0,0,.25);border:1px solid rgba(209,191,155,.22)}
.st i{width:7px;height:7px;border-radius:50%;background:#aabf9a;box-shadow:0 0 0 3px rgba(170,191,154,.18)}
.st.warn i{background:#e3b264;box-shadow:0 0 0 3px rgba(227,178,100,.2)}.st.bad i{background:#ef8a80;box-shadow:0 0 0 3px rgba(239,138,128,.2)}
.st.idle i{background:#9aa9c4}
.ml{position:relative;z-index:2;margin-top:24px;font:9.5px var(--latin);letter-spacing:1.8px;color:#9faeaa}
.model{position:relative;z-index:2;font:400 31px/1.3 var(--latin);letter-spacing:.3px;margin:6px 0 4px;overflow-wrap:anywhere;color:#fbf6ec}
.model.none{font:400 26px var(--serif);color:#cfc5b4;letter-spacing:2px}
.msub{position:relative;z-index:2;color:#e3b96f;font:12px var(--latin);letter-spacing:.4px;overflow-wrap:anywhere}
.msub .q{color:#b8b0a2;font-family:var(--ui)}
.fb{position:relative;z-index:2;display:inline-flex;align-items:center;gap:7px;margin-top:12px;padding:5px 12px;border-radius:5px;font-size:12px;color:#ffe3b0;background:rgba(227,178,100,.16);border:1px solid rgba(227,178,100,.35);overflow-wrap:anywhere}
.fb .ico{width:15px;height:15px}
.ch-body{padding:20px 26px 22px;display:flex;flex-direction:column;gap:0;flex:1}
.lbl{font-size:12px;color:var(--muted);letter-spacing:.5px}
.lvl{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
.lvl .big{font:42px/1.1 var(--latin);color:var(--ink)}
.lvl .big small{font:16px var(--latin);color:var(--muted);margin-left:2px}
.lvl .big.hi{color:var(--bad)}
.bar{position:relative;height:10px;margin-top:10px;border-radius:1px;background:var(--line2);border:1px solid var(--line);overflow:hidden}
.bar>span{position:relative;display:block;height:100%;background:linear-gradient(90deg,#e2c8a6,#aa8150 60%,#86603c)}
.bar>span:after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(90deg,transparent 0 22px,rgba(255,255,255,.55) 22px 23px)}
.bar.hi>span{background:linear-gradient(90deg,#d9a39a,#a8544d)}
@media (prefers-color-scheme:dark){.bar>span{background:linear-gradient(90deg,#7a5a32,#d4a862 70%,#f0cf8a);box-shadow:0 0 12px rgba(227,185,111,.35)}.bar>span:after{background:repeating-linear-gradient(90deg,transparent 0 22px,rgba(0,0,0,.35) 22px 23px)}
 .bar.hi>span{background:linear-gradient(90deg,#8a4640,#ec8f86)}}
.lvl-sub{display:flex;justify-content:space-between;gap:10px;margin-top:7px;font-size:12px;color:var(--muted)}
.lvl-sub .stale{color:var(--bad)}
.kv2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:18px;padding-top:16px;border-top:1px solid var(--line2)}
.kv2 b{display:block;font:500 19px var(--latin);margin-top:4px;color:var(--ink);font-variant-numeric:lining-nums}
.kv2 small{display:block;font-size:11.5px;color:var(--muted);margin-top:1px}
.procs{margin-top:16px;border-top:1px solid var(--line2)}
.proc{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid var(--line2)}
.proc:last-child{border-bottom:0}
.proc .pl{display:flex;align-items:center;gap:12px;min-width:0}
.rn{width:29px;height:29px;flex:none;border:1px solid var(--line);border-radius:50%;display:grid;place-items:center;font:11px var(--latin);color:var(--gold-text)}
.proc b{display:block;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.proc small{display:block;font-size:11px;color:var(--quiet)}
.ps-t{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--ok);white-space:nowrap}
.ps-t:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.ps-t.off{color:var(--warn)}.ps-t.bad{color:var(--bad)}
.minis{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px}
.mini{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 14px;border:1px solid var(--line);border-radius:6px;background:var(--panel-solid);font-size:12.5px;color:var(--ink2)}
.mini b{font:22px var(--latin);color:var(--ink)}
.mini.alarm{border-color:rgba(168,84,77,.35);background:var(--bad-bg)}.mini.alarm b{color:var(--bad)}
.acts{display:flex;gap:10px;margin-top:18px;flex-wrap:wrap}
.acts .btn{flex:1;justify-content:center;min-width:140px}
.err{padding:12px 14px;border-radius:6px;background:var(--bad-bg);color:var(--bad);font-size:13px;overflow-wrap:anywhere;border:1px solid rgba(168,84,77,.25)}
.muted{color:var(--muted)}.small{font-size:12px}
.mono{font-family:var(--mono);font-size:12px;overflow-wrap:anywhere}
.gem-sapphire{--acc:var(--sapphire)}.gem-ruby{--acc:var(--ruby)}.gem-emerald{--acc:var(--emerald)}.gem-amber{--acc:var(--amber)}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--acc);margin-right:7px;vertical-align:1px}
details.more{margin-top:14px;border-top:1px solid var(--line2)}
details.more>summary{cursor:pointer;list-style:none;padding:10px 0 0;color:var(--muted);font-size:12px;letter-spacing:1px}
details.more>summary::-webkit-details-marker{display:none}
details.more>summary:after{content:" ›";color:var(--gold)}
details.more[open]>summary:after{content:" ‹"}
details.more .inner{padding-top:6px;font-size:12px;color:var(--muted);line-height:1.8}
/* —— 卡住的消息 / 出过的错：列表 —— */
.tally{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0 4px}
.tl{display:flex;align-items:baseline;gap:8px;padding:8px 14px;border:1px solid var(--line);border-radius:6px;background:var(--panel-solid);font-size:12.5px;color:var(--ink2)}
.tl b{font:22px var(--latin);color:var(--ink)}
.tl.alarm b{color:var(--bad)}
.rows{margin-top:14px;border-top:1px solid var(--line)}
.r{display:grid;grid-template-columns:92px 150px 1fr auto;gap:16px;align-items:start;padding:13px 4px;border-bottom:1px solid var(--line2)}
.r:last-child{border-bottom:0}
.r .tm{font:12.5px var(--latin);color:var(--ink2);white-space:nowrap;padding-top:1px}
.r .tm small{display:block;font:11px var(--ui);color:var(--quiet)}
.r .who{font-size:12.5px;color:var(--ink2);min-width:0}
.r .who b{display:block;font:500 14px var(--serif)}
.r .what{min-width:0;font-size:13px}
.r .what .pv{color:var(--ink);overflow-wrap:anywhere}
.r .what .why{display:block;font-size:12px;color:var(--muted);overflow-wrap:anywhere;margin-top:2px}
.r .cd{font:12px var(--mono);color:var(--gold-text);white-space:nowrap}
.tag{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:1px 10px;border-radius:20px;white-space:nowrap;margin-bottom:4px;background:var(--warn-bg);color:var(--warn)}
.tag:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.tag.bad{background:var(--bad-bg);color:var(--bad)}.tag.ok{background:var(--ok-bg);color:var(--ok)}.tag.idle{background:var(--line2);color:var(--muted)}
.empty{padding:40px 20px 30px;text-align:center;color:var(--muted)}
.empty .em{display:block;font:30px var(--latin);color:#b4a284;margin-bottom:8px}
.empty b{display:block;font:400 17px var(--serif);color:var(--ink2)}
.empty p{font-size:12px;margin:8px 0 0}
.more-link{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--gold-text)}
.more-link .arr{width:14px;height:14px}
.links{display:flex;gap:18px;flex-wrap:wrap;margin-top:14px}
/* —— 二级页抬头 —— */
.vh{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;margin:6px 0 24px;position:relative;padding:30px 34px;border:1px solid #d9bc90;border-radius:9px 9px 17px 9px;overflow:hidden;background:var(--hero-bg);box-shadow:var(--shadow-lg)}
@media (prefers-color-scheme:dark){.vh{border-color:#6b5639}}
.vh .hero-img{width:55%;opacity:.9}
.vh:before{content:"";position:absolute;inset:0;z-index:1;pointer-events:none;background:var(--hero-veil)}
.vh:after{content:"";position:absolute;inset:9px;z-index:4;pointer-events:none;border:1px solid rgba(209,170,111,.42);border-radius:4px 4px 10px 4px}
.vh>.vt{position:relative;z-index:5;min-width:0}
.vh small{font:10px var(--latin);letter-spacing:2px;color:var(--eyebrow)}
.vh h1{font:400 32px/1.3 var(--serif);margin:10px 0 8px;letter-spacing:1.5px;color:var(--hero-h1);text-shadow:var(--hero-shadow)}
.vh p{font-size:13px;color:var(--ink2);line-height:1.9;margin:0;max-width:640px}
.vh .btn{position:relative;z-index:5}
/* —— 底子页 —— */
.srcs{margin:8px 0 0;padding:0;list-style:none}
.srcs li{font:11.5px/1.6 var(--mono);color:var(--muted);overflow-wrap:anywhere;padding:1px 0}
.srcs li.x{color:var(--bad);font-weight:600}
.srcs .k{font:11px var(--ui);padding:0 7px;border-radius:4px;background:var(--line2);margin-right:6px;color:var(--muted);font-weight:normal}
.srcs li.x .k{background:var(--bad-bg);color:var(--bad)}
.secs{display:grid;gap:14px}
details.sec{position:relative;border:1px solid #e2cdb0;border-radius:7px;background:linear-gradient(140deg,#fffcf8,rgba(255,253,248,.92));box-shadow:var(--shadow)}
@media (prefers-color-scheme:dark){details.sec{border-color:#4d4030;background:linear-gradient(140deg,rgba(38,35,35,.93),rgba(26,25,28,.92))}}
details.sec>summary{list-style:none;cursor:pointer;padding:18px 22px 16px;display:block}
details.sec>summary::-webkit-details-marker{display:none}
.sec-t{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
.sec-t b{font:500 17px var(--serif);letter-spacing:1px}
.sec-t b .en{display:block;font:10px var(--latin);letter-spacing:1.5px;color:var(--quiet);margin:3px 0 0 20px}
.sec-t .n{font:22px var(--latin);color:var(--gold-text);white-space:nowrap}
.sec-t .n small{font:12px var(--ui);color:var(--muted);margin-left:3px}
.chev{display:inline-block;width:7px;height:7px;border-right:1.5px solid var(--gold);border-bottom:1.5px solid var(--gold);transform:rotate(-45deg);margin:0 11px 2px 2px;transition:transform .3s}
details[open] .chev{transform:rotate(45deg)}
.body{padding:0 22px 18px}
.body pre{margin:0;max-height:60vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:12.5px/1.7 var(--mono);color:var(--ink2);background:var(--paper2);border:1px solid var(--line2);border-radius:6px;padding:12px 14px}
details.sec.cross{border:1.5px solid var(--bad);background:repeating-linear-gradient(45deg,var(--bad-bg) 0 6px,transparent 6px 14px),linear-gradient(140deg,#fffcf8,rgba(255,253,248,.92));box-shadow:0 0 0 4px var(--bad-bg),var(--shadow)}
@media (prefers-color-scheme:dark){details.sec.cross{background:repeating-linear-gradient(45deg,var(--bad-bg) 0 6px,transparent 6px 14px),linear-gradient(140deg,rgba(44,32,33,.95),rgba(30,25,28,.94))}}
details.sec.cross .sec-t b,details.sec.cross .sec-t .n{color:var(--bad)}
.xwarn{display:inline-flex;align-items:center;gap:7px;margin-top:9px;padding:3px 13px;border-radius:4px;background:var(--bad);color:#fff;font-size:12.5px;font-weight:600;letter-spacing:.5px}
@media (prefers-color-scheme:dark){.xwarn{color:#2a1414}}
.xwarn .ico{width:14px;height:14px}
.missing{color:var(--muted);font-size:12.5px;text-align:center;margin-top:14px}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:12px}
td,th{padding:9px 6px;border-bottom:1px solid var(--line2);text-align:left;vertical-align:top}
th{font-weight:normal;color:var(--quiet);font-size:11px;letter-spacing:1px}
td.r,th.r{text-align:right;font-variant-numeric:tabular-nums}
.up{color:var(--ok)}.down{color:var(--bad)}
.kv{margin:10px 0 0;display:grid;grid-template-columns:auto 1fr;gap:4px 14px;font-size:12.5px}
.kv dt{color:var(--muted)}.kv dd{margin:0;font-family:var(--mono);overflow-wrap:anywhere}
.fl{display:grid;gap:14px}
.fi{padding:18px 22px 16px}
.fi .h{display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap}
.fi pre{margin:10px 0 0;max-height:40vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 var(--mono);background:var(--paper2);border:1px solid var(--line2);border-radius:6px;padding:10px 12px;color:var(--ink2)}
.stack{display:grid;gap:18px}
/* —— 门 —— */
.gate{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:28px 18px}
.gate-card{width:min(440px,100%);overflow:hidden;text-align:center;padding:0 0 30px;background:var(--panel-solid)}
.gate-img{height:170px;position:relative}
.gate-img:before{content:"";position:absolute;inset:0;background:url(/assets/duomo-facade.webp) 50% 45%/cover no-repeat;filter:var(--hero-img-filter)}
.gate-img:after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,transparent 40%,var(--panel-solid) 100%)}
.gate-card .brand{justify-content:center;padding:12px 0 0;margin-top:-26px;position:relative;z-index:2}
.gate-card .seal{width:42px;height:48px;background:var(--panel-solid);border-radius:50% 50% 6px 6px;padding:6px}
.gate-card h1{font:500 26px var(--serif);letter-spacing:3px;margin:16px 24px 6px}
.gate-card .eyebrow{display:block;margin-top:10px}
.gate-card p{color:var(--ink2);margin:6px 28px;font-size:13.5px}
.gate-card form{margin-top:22px}
.gate-card button{font:16px var(--serif);letter-spacing:.5em;padding:0 34px 0 40px;height:46px;cursor:pointer}
.codeform{display:flex;flex-direction:column;align-items:center;gap:14px;margin:22px 28px 0}
.codeform input{width:100%;max-width:260px;height:52px;text-align:center;font:600 24px/1 var(--mono);letter-spacing:4px;text-transform:uppercase;color:var(--ink);background:var(--panel-solid);border:1px solid var(--line-dark);border-radius:6px}
.codeform input:focus{outline:none;border-color:var(--gold);box-shadow:0 0 0 3px var(--gold-soft)}
.codeform input::placeholder{color:var(--quiet);letter-spacing:4px}
.codeerr{color:var(--bad)!important;font-size:13px;margin:0!important}
/* —— 动手的地方：换舱 / 改文件 —— */
.acts2{margin-top:10px}
.btn{cursor:pointer;font-family:var(--ui)}
button.btn{appearance:none;-webkit-appearance:none}
.btn .ico{width:16px;height:16px;color:var(--gold)}
.btn.primary .ico,.btn.danger .ico{color:currentColor}
.btn.rot{border-color:#c79a83;color:#8a3f35}
.btn.rot .ico{color:#a8544d}
.btn.danger{color:#fff6f0;background:linear-gradient(125deg,#b0625a,#8c4038);border-color:#93463e;box-shadow:0 5px 14px rgba(120,40,30,.18)}
.btn.danger:hover{background:linear-gradient(125deg,#bd6c63,#97483f)}
@media (prefers-color-scheme:dark){.btn.rot{border-color:#7a4a40;color:#f0a79c}.btn.rot .ico{color:#ec8f86}
 .btn.danger{color:#2a1414;background:linear-gradient(125deg,#f0a097,#cf776d);border-color:#e8968c;box-shadow:0 5px 18px rgba(236,143,134,.2)}}
.confirm{max-width:760px}
.confirm ul{margin:14px 0 6px;padding:0;list-style:none;display:grid;gap:10px}
.confirm li{position:relative;padding:12px 14px 12px 42px;border:1px solid var(--line);border-radius:6px;background:var(--panel-solid);font-size:13.5px;line-height:1.75;color:var(--ink2)}
.confirm li:before{content:"✥";position:absolute;left:15px;top:11px;color:var(--gold)}
.confirm li b{color:var(--ink);font-weight:600}
.formrow{display:flex;gap:10px;flex-wrap:wrap;margin-top:20px;align-items:center}
.flash{padding:14px 16px;border-radius:6px;font-size:13.5px;line-height:1.8;border:1px solid var(--line);background:var(--panel-solid)}
.flash.ok{border-color:rgba(111,148,121,.4);background:var(--ok-bg);color:var(--ink)}
.flash.warn{border-color:rgba(185,132,70,.4);background:var(--warn-bg)}
.flash.bad{border-color:rgba(168,84,77,.35);background:var(--bad-bg);color:var(--bad)}
.flash b{font-weight:600}
.eff{display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;padding:14px 18px;border:1px dashed var(--line-dark);border-radius:7px;background:var(--panel-solid);font-size:13px;color:var(--ink2);margin-bottom:18px}
.eff b{color:var(--gold-text);font-weight:600}
.panel+.eff,.flash+.eff{margin-top:18px}
.files{margin-top:6px;border-top:1px solid var(--line)}
.fr{display:grid;grid-template-columns:1fr auto;gap:6px 16px;align-items:center;padding:13px 4px;border-bottom:1px solid var(--line2)}
.fr .fn{min-width:0}
.fr .fn b{display:block;font:500 15px var(--serif);letter-spacing:.5px;overflow-wrap:anywhere}
.fr .fn small{display:block;font:11.5px/1.6 var(--mono);color:var(--muted);overflow-wrap:anywhere}
.fr .sec-k{display:inline-block;font-size:11px;padding:0 8px;border-radius:4px;background:var(--line2);color:var(--muted);margin:4px 6px 0 0}
.fr.no .fn b{color:var(--muted)}
.fr.no.x .fn b,.fr.no.x .why{color:var(--bad)}
.fr .why{font-size:12px;color:var(--muted)}
.fr .go{display:flex;gap:8px}
.fr .go .btn{height:34px;padding:0 13px;font-size:12.5px}
.editor{display:block}
.editor .bar2{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;font-size:12px;color:var(--muted)}
.tog{display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none;font-size:12.5px;color:var(--ink2)}
.tog i{position:relative;width:34px;height:20px;border-radius:20px;background:var(--line);border:1px solid var(--line-dark);transition:.2s}
.tog i:after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--panel-solid);box-shadow:0 1px 2px rgba(0,0,0,.2);transition:.2s}
.sr{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.sr:checked+.bar2 .tog i{background:var(--gold);border-color:var(--gold-deep)}
.sr:checked+.bar2 .tog i:after{left:16px}
.sr:focus-visible+.bar2 .tog i{outline:2px solid var(--gold);outline-offset:2px}
textarea.ta{display:block;width:100%;min-height:62vh;resize:vertical;padding:16px 18px;border:1px solid var(--line-dark);border-radius:6px;background:var(--panel-solid);color:var(--ink);
 font:16px/1.75 var(--serif);letter-spacing:.2px;tab-size:4;box-shadow:inset 0 1px 4px rgba(117,83,46,.06)}
textarea.ta:focus{outline:none;border-color:var(--gold);box-shadow:0 0 0 3px var(--gold-soft)}
.sr:checked~textarea.ta{font:14px/1.7 var(--mono)}
textarea.ta[readonly]{min-height:30vh;color:var(--ink2)}
.diff{margin-top:12px;border:1px solid var(--line);border-radius:6px;overflow:auto;max-height:70vh;background:var(--panel-solid);font:12.5px/1.65 var(--mono)}
.dl{display:grid;grid-template-columns:44px 44px 18px 1fr;min-width:0}
.dl span{padding:0 6px;white-space:pre-wrap;overflow-wrap:anywhere}
.dl .ln{color:var(--quiet);text-align:right;user-select:none;border-right:1px solid var(--line2)}
.dl .sg{color:var(--quiet);text-align:center;user-select:none}
.dl.add{background:rgba(111,148,121,.16)}.dl.add .sg,.dl.add .tx{color:#3f6b4b}
.dl.del{background:rgba(168,84,77,.13)}.dl.del .sg,.dl.del .tx{color:#8f3e37;text-decoration:line-through;text-decoration-color:rgba(143,62,55,.35)}
@media (prefers-color-scheme:dark){.dl.add{background:rgba(148,189,159,.14)}.dl.add .sg,.dl.add .tx{color:#a9d9b5}.dl.del{background:rgba(236,143,134,.13)}.dl.del .sg,.dl.del .tx{color:#f2aaa2}}
.dl.skip{background:var(--paper2);color:var(--quiet);font:11.5px var(--ui);letter-spacing:1px}
.dl.skip span{grid-column:1 / 5;text-align:center;padding:4px}
.dsum{display:flex;gap:14px;align-items:baseline;flex-wrap:wrap;font-size:13px;color:var(--ink2)}
.dsum .up,.dsum .down{font:20px var(--latin)}
.hidden{display:none}
.audit td{font-size:12.5px}
.audit td.m{font-family:var(--mono);font-size:11.5px;overflow-wrap:anywhere;color:var(--muted)}
.state-big{font:500 26px var(--serif);letter-spacing:2px;margin:4px 0 8px}
.state-big.ok{color:var(--ok)}.state-big.bad{color:var(--bad)}.state-big.warn{color:var(--warn)}
pre.receipt{margin:12px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;font:12.5px/1.7 var(--mono);color:var(--ink2);background:var(--paper2);border:1px solid var(--line2);border-radius:6px;padding:12px 14px}
@media (max-width:740px){
 .fr{grid-template-columns:1fr}.fr .go{justify-content:flex-start}
 .dl{grid-template-columns:34px 34px 14px 1fr;font-size:12px}
 textarea.ta{min-height:58vh;padding:12px 12px;font-size:16px}
 .sr:checked~textarea.ta{font-size:13.5px}
 .formrow .btn{flex:1;justify-content:center}
 .eff{padding:12px 14px}
}
.asm-sum{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.asm-sum .tl{flex-direction:column;align-items:flex-start;gap:2px}
.asm-sum .tl small{font-size:11px;color:var(--muted)}
.asm{margin-top:18px;border:1px solid var(--line);border-radius:8px;background:var(--panel-solid);overflow:hidden}
.asm details{border-top:1px solid var(--line2)}
.asm details:first-child{border-top:0}
.asm summary{list-style:none;cursor:pointer;padding:12px 16px;display:flex;justify-content:space-between;gap:10px;align-items:baseline}
.asm summary::-webkit-details-marker{display:none}
.asm summary b{font:500 15px var(--serif);letter-spacing:.5px}
.asm summary .src{display:block;font:11px/1.5 var(--mono);color:var(--quiet);overflow-wrap:anywhere;margin-top:2px}
.asm summary .n{font:13px var(--latin);color:var(--gold-text);white-space:nowrap}
.asm .seg{margin:0;padding:12px 16px 14px;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.75 var(--serif);color:var(--ink2);border-top:1px dashed var(--line2);background:var(--paper2)}
.asm .tag-s{display:inline-block;font:10.5px var(--ui);letter-spacing:.5px;padding:0 7px;border-radius:4px;background:var(--gold-soft);color:var(--gold-deep);margin-right:6px;vertical-align:1px}
@media (prefers-color-scheme:dark){.asm .tag-s{color:var(--gold-text)}}
.asm .turn{padding:10px 16px;border-top:1px solid var(--line2)}
.asm .turn .who{font:11.5px var(--ui);color:var(--muted);margin-bottom:3px}
.asm .turn .who b{color:var(--gold-text);font-weight:600}
.asm .turn pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.7 var(--serif);color:var(--ink2)}
.tails{margin-top:10px;border-top:1px solid var(--line)}
.tt{display:grid;grid-template-columns:30px 1fr;gap:4px 12px;padding:12px 4px;border-bottom:1px solid var(--line2);align-items:start}
.tt input[type=checkbox]{width:20px;height:20px;margin:2px 0 0;accent-color:var(--gold-deep)}
.tt .meta{font:11.5px var(--ui);color:var(--muted)}
.tt .meta b{color:var(--ink2);font-weight:600}
.tt .pv{font-size:14px;color:var(--ink);overflow-wrap:anywhere;margin-top:2px}
.tt.off .pv{color:var(--quiet);text-decoration:line-through;text-decoration-color:var(--line-dark)}
.tt.drop .pv{color:var(--muted)}
.tt details{grid-column:2}
.tt details summary{cursor:pointer;font-size:12px;color:var(--gold-text);list-style:none;margin-top:4px}
.tt details summary::-webkit-details-marker{display:none}
.tt details pre{margin:6px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;font:12.5px/1.7 var(--serif);color:var(--ink2);background:var(--paper2);border:1px solid var(--line2);border-radius:6px;padding:8px 10px}
.wgrp{border-top:1px solid var(--line2)}
.wgrp>summary{list-style:none;cursor:pointer;padding:12px 4px;display:flex;justify-content:space-between;gap:10px;align-items:baseline}
.wgrp>summary::-webkit-details-marker{display:none}
.wgrp>summary b{font:500 14.5px var(--serif);overflow-wrap:anywhere}
.wgrp>summary small{font:11px var(--latin);color:var(--quiet);white-space:nowrap}
.wgrp .fr{padding-left:16px}
@media (max-width:740px){.asm-sum{grid-template-columns:1fr 1fr}.asm summary{flex-direction:column}.wgrp .fr{padding-left:4px}}
.mopt{display:flex;gap:12px;align-items:flex-start;padding:12px 14px;margin-top:10px;border:1px solid var(--line);border-radius:6px;background:var(--panel-solid);cursor:pointer;font-size:14px;line-height:1.6}
.mopt input{width:18px;height:18px;margin:3px 0 0;accent-color:var(--gold-deep);flex:none}
.mopt small{display:block;font-size:12px;color:var(--muted)}
.mopt .mid{font:11.5px var(--mono);color:var(--quiet);margin-left:6px;overflow-wrap:anywhere}
.mopt:has(input:checked){border-color:var(--gold);box-shadow:0 0 0 3px var(--gold-soft)}
.mopt.dis{opacity:.5;cursor:not-allowed}
.mgrp{margin:18px 0 0;font-size:12px;letter-spacing:1px;color:var(--eyebrow)}
.confirm+.confirm{margin-top:16px}
/* —— 窄屏 —— */
@media (max-width:1280px){.page{padding:30px 32px 20px}.top{padding:0 32px}.foot{padding:22px 32px 26px}.side{width:226px}
 .hero h1{font-size:34px}.hero-copy{padding-left:38px}.stats{gap:12px}}
@media (max-width:1180px){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:999px){.side{display:none}
 .top .mseal{display:block}.crumb.hide-m{display:none}
 .mnav{display:flex;gap:8px;overflow-x:auto;padding:10px 16px;border-bottom:1px solid var(--line);background:linear-gradient(90deg,rgba(255,253,248,.6),rgba(248,240,228,.6));scrollbar-width:none}
 .mnav::-webkit-scrollbar{display:none}
 .mnav a{display:inline-flex;align-items:center;gap:6px;flex:none;padding:6px 13px;border:1px solid var(--line);border-radius:30px;font-size:13px;color:var(--ink2);background:var(--panel-solid)}
 .mnav a .ico{width:15px;height:15px;color:var(--gold)}
 .mnav a.on{border-color:#d9bc90;background:linear-gradient(105deg,#fffdf8 5%,#f4e7d2 100%);color:var(--ink);font-weight:600}
 .mnav a .n{font:11px var(--latin);color:var(--bad)}}
@media (prefers-color-scheme:dark) and (max-width:999px){.mnav{background:rgba(22,21,24,.7)}.mnav a.on{border-color:#6b5639;background:rgba(214,171,102,.13)}}
@media (max-width:740px){
 .top{height:58px;padding:0 16px}.top .date,.top .vline{display:none}
 .page{padding:18px 14px 10px}
 .welcome{margin-bottom:12px}.welcome .eyebrow{font-size:9px;letter-spacing:1.6px}
 .hero{height:auto;min-height:300px}
 .hero-copy{width:100%;padding:30px 22px 24px}
 .hero h1{font-size:29px;letter-spacing:1px}
 .hero p{font-size:12.5px;max-width:270px}
 .hero-img{width:100%;right:-26%;background-position:39% center;opacity:.55}
 @media (prefers-color-scheme:dark){.hero-img{opacity:.7}.hero-glow{right:-110px;width:260px;height:260px}}
 .hero:before{background:linear-gradient(90deg,rgba(255,250,242,.97) 0%,rgba(255,250,242,.86) 54%,rgba(255,250,242,.15) 100%)}
 @media (prefers-color-scheme:dark){.hero:before{background:linear-gradient(90deg,rgba(17,17,20,.96) 0%,rgba(19,18,21,.82) 56%,rgba(20,19,22,.25) 100%)}}
 .hero-bottom{display:none}
 .btn{height:38px;padding:0 14px}
 .sh{margin:26px 0 12px}.sh h2{font-size:19px}.sh .aside{font-size:11px}
 .stat{min-height:116px;padding:15px}.stat:before{opacity:.22}.stat-num{font-size:31px}
 .ch-top{padding:20px 20px;min-height:0}.ch-body{padding:18px 20px 20px}
 .ch-name{font-size:26px}.model{font-size:25px}
 .lvl .big{font-size:36px}
 .pad{padding:20px 18px 16px}
 .ph{flex-direction:column}
 .hint{white-space:normal}
 .r{grid-template-columns:1fr auto;gap:4px 12px;padding:12px 2px}
 .r .tm{grid-column:1;grid-row:1}.r .cd{grid-column:2;grid-row:1}
 .r .who{grid-column:1 / 3;grid-row:2;display:flex;gap:8px;align-items:baseline}.r .who b{display:inline;font-size:13.5px}
 .r .what{grid-column:1 / 3;grid-row:3}
 .vh{padding:24px 20px;flex-direction:column;align-items:flex-start}.vh h1{font-size:25px}.vh .hero-img{width:100%;opacity:.35}
 .foot{padding:18px 16px 24px;font-size:8px}.foot span:last-child{display:none}
 .minis{grid-template-columns:1fr 1fr}
 .kv{grid-template-columns:1fr}.kv dd{margin-bottom:6px}
}
@media (prefers-reduced-motion:reduce){*,*:before,*:after{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
`;

function page(title, body, { refresh = null } = {}) {
  return `<!doctype html><html lang="${isEn() ? "en" : "zh-CN"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">`
    + (refresh ? `<meta http-equiv="refresh" content="${Number(refresh.secs) || 5};url=${esc(refresh.url)}">` : "")
    + `<meta name="robots" content="noindex"><meta name="referrer" content="same-origin"><meta name="color-scheme" content="light dark">`
    // 主屏幕（2026-10-22）：图标、名字「圣所」、全屏、白天 / 夜间的状态栏颜色
    + `<link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32.png"><link rel="icon" type="image/svg+xml" href="/assets/icon.svg">`
    + `<link rel="apple-touch-icon" sizes="180x180" href="/assets/apple-touch-icon.png"><link rel="manifest" href="/manifest.webmanifest">`
    + `<meta name="apple-mobile-web-app-title" content="${esc(L("圣所"))}"><meta name="application-name" content="${esc(L("圣所"))}">`
    + `<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default">`
    + `<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f7f3eb"><meta name="theme-color" media="(prefers-color-scheme: dark)" content="#141417">`
    + `<title>${esc(title)}</title><style>${CSS}</style></head><body>`
    + body + `</body></html>`;
}

// ——— 骨架 ———
/**
 * @param {object} o
 * @param {string} o.active    "home" | "base:<id>" | "failures:<id>"
 * @param {{id,displayName}[]} o.nav
 * @param {number} o.stuck     卡住的总数（导航上的小红数）
 */
function shell({ title, crumb, active = "home", nav = [], stuck = 0, now = Date.now(), content, refresh = null }) {
  const p = bjParts(now);
  const dateLatin = `${Number(p.day)} ${MONTHS[Number(p.month) - 1]} ${p.year}`;
  const link = (href, icon, cn, en, on, n = 0) => `<a class="nl${on ? " on" : ""}" href="${esc(href)}">${icon}<span class="t"><b>${esc(cn)}</b>${en ? `<small>${esc(en)}</small>` : ""}</span>${n ? `<span class="n">${n}</span>` : ""}</a>`;
  const mlink = (href, icon, cn, on, n = 0) => `<a class="${on ? "on" : ""}" href="${esc(href)}">${icon}${esc(cn)}${n ? ` <span class="n">${n}</span>` : ""}</a>`;
  const homeOn = active === "home";
  const side = `<aside class="side"><a class="brand" href="/">${SEAL}<span><b class="cn">${esc(L("桥 · 圣所"))}</b><small>THE SANCTUARY</small></span></a>`
    + `<div class="overline">THE CONTROL CHAPEL · 01</div><nav class="nav">`
    + link("/#top", I.overview, L("总览"), "Overview", homeOn)
    + link("/#chars", I.persona, L("两位"), "Persona", false)
    + link("/#stuck", I.pending, L("卡住的消息"), "Held", false, stuck)
    + link("/#errors", I.errors, L("最近出过的错"), "Errors", false)
    + `</nav><div class="sep"></div><div class="overline s2">${esc(L("这一舱装了什么"))}</div><nav class="nav">`
    + nav.map((c) => link(`/c/${encodeURIComponent(c.id)}/base`, I.base, c.displayName || c.id, "", active === "base:" + c.id)).join("")
    + nav.filter((c) => active === "failures:" + c.id).map((c) => link(`/c/${encodeURIComponent(c.id)}/failures`, I.errors, L("{0} · 出错详情", c.displayName || c.id), "", true)).join("")
    + `</nav><div class="sep"></div><div class="overline s2">${esc(L("动手的地方"))}</div><nav class="nav">`
    + nav.map((c) => link(`/c/${encodeURIComponent(c.id)}/files`, I.quill, L("{0} · 改文件", c.displayName || c.id), "", active === "files:" + c.id)).join("")
    + link("/audit", I.ledger, L("操作记录"), "Ledger", active === "audit")
    + `</nav><div class="side-bottom"><div class="mark"><span>✧</span>THE QUIET ARCHIVE<span>✧</span></div>`
    + `<div class="idc"><span class="av">${esc(L("桥"))}</span><span><b>${esc(L("桥的面板"))}</b><small>${esc(L("看为主 · 换舱和改文件都要先确认"))}</small></span></div></div></aside>`;
  const mnav = `<nav class="mnav">` + mlink("/#top", I.overview, L("总览"), homeOn) + mlink("/#chars", I.persona, L("两位"), false)
    + mlink("/#stuck", I.pending, L("卡住的"), false, stuck) + mlink("/#errors", I.errors, L("出过的错"), false)
    + nav.map((c) => mlink(`/c/${encodeURIComponent(c.id)}/base`, I.base, L("{0}的这一舱", c.displayName || c.id), active === "base:" + c.id)).join("")
    + nav.map((c) => mlink(`/c/${encodeURIComponent(c.id)}/files`, I.quill, L("{0} · 改文件", c.displayName || c.id), active === "files:" + c.id)).join("")
    + mlink("/audit", I.ledger, L("操作记录"), active === "audit") + `</nav>`;
  const top = `<header class="top" id="top"><div class="l"><a class="mseal" href="/">${SEAL}</a><span class="crumb hide-m">THE SANCTUARY</span><span class="cdiv">/</span><strong>${esc(crumb)}</strong></div>`
    + `<div class="r"><span class="date">${esc(dateLatin)}</span><span class="vline"></span><span class="mode"><i></i>${esc(L("值守中"))}</span></div></header>`;
  const foot = `<footer class="foot"><span>THE SANCTUARY <span class="cn">${esc(L("· 桥的面板 · 时间一律{0}", tzLabel()))}</span></span><span>FOR EVERY VOICE, A PLACE TO RETURN</span></footer>`;
  return page(title, `<div class="shell">${side}<div class="main">${top}${mnav}<main class="page">${content}</main>${foot}</div></div>`, { refresh });
}

// ——— 首页 ———
function overallState(c) {
  if (c.error) return ["bad", L("读不到配置")];
  const procs = (c.pm2 && c.pm2.procs) || [];
  if (c.pm2 && !c.pm2.ok) return ["warn", L("看不到进程")];
  if (!procs.length) return ["warn", L("没有进程")];
  if (procs.some((p) => p.status !== "online")) return ["bad", L("有进程不在线")];
  if (c.pending && c.pending.total) return ["warn", L("在线 · 有卡住的")];
  const fails = Object.values(c.failureByType || {}).reduce((a, b) => a + b, 0);
  if (fails) return ["warn", L("在线 · 有出错")];
  return ["ok", L("在线")];
}
const failTotal = (c) => Object.values(c.failureByType || {}).reduce((a, b) => a + b, 0);

function engineBlock(c) {
  const e = c.engine || {};
  const rt = RUNTIME[e.runtime] || e.runtime || "";
  let html = `<div class="ml">${esc(L("此刻真正在用的模型"))} · THE MIND WITHIN</div>`;
  if (e.actual) {
    const src = e.source === "heartbeat" ? L("盒子实测") : L("掉档告警里记的实测");
    html += `<div class="model">${esc(e.actual)}</div><div class="msub">${esc([rt, src].filter(Boolean).join(" · "))}`
      + (e.requested && e.requested !== e.actual ? ` <span class="q">· ${esc(L("请求的是 {0}", e.requested))}</span>` : "")
      + (e.stale && e.at ? ` <span class="q">· ${esc(L("心跳停在 {0}", fmtTime(e.at)))}</span>` : "") + `</div>`;
  } else {
    html += `<div class="model none">${esc(L("未确认"))}</div><div class="msub"><span class="q">${esc(e.requested ? L("盒子还没报实测模型；请求的是 {0}", e.requested) : L("盒子还没报实测模型"))}</span></div>`;
  }
  if (e.fallback) html += `<div class="fb">${I.errors}${esc(e.requested ? L("掉档了：实际答话的是 {0}，请求的是 {1}", e.fallbackActual || "?", e.requested) : L("掉档了：实际答话的是 {0}", e.fallbackActual || "?"))}</div>`;
  return html;
}

function charCard(c, gem, now) {
  const [scls, stext] = overallState(c);
  const top = `<div class="ch-top"><div class="ch-head"><div><h3 class="ch-name">${esc(c.displayName || c.id)}</h3><div class="ch-id">PERSONA · ${esc(String(c.id).toUpperCase())}</div></div>`
    + `<span class="st ${scls}"><i></i>${esc(stext)}</span></div>${c.error ? "" : engineBlock(c)}</div>`;
  if (c.error) {
    return `<section class="ch gem-${gem}" id="c-${esc(c.id)}">${top}<div class="ch-body"><div class="err">${esc(L("这张卡片读不出来：{0}", c.error))}</div></div></section>`;
  }
  const parts = [];
  const f = c.fullness;
  if (f.ok && f.hasThread) {
    const pct = Math.min(100, f.ratio * 100);
    const hi = pct >= 80;
    parts.push(`<div class="lvl"><span class="lbl">${esc(L("上下文水位"))}</span><span class="big${hi ? " hi" : ""}">${pct.toFixed(pct < 10 ? 1 : 0)}<small>%</small></span></div>`
      + `<div class="bar${hi ? " hi" : ""}"><span style="width:${Math.max(2, pct).toFixed(1)}%"></span></div>`
      + `<div class="lvl-sub"><span>${wan(f.used)} / ${wan(f.limit)} tokens</span>${f.stale ? `<span class="stale">${esc(L("心跳停在 {0}", fmtTime(f.at)))}</span>` : `<span>${esc(L("{0}更新", ago(f.at, now)))}</span>`}</div>`);
  } else {
    parts.push(`<div class="lvl"><span class="lbl">${esc(L("上下文水位"))}</span><span class="big" style="font-size:24px;color:var(--muted)">—</span></div>`
      + `<div class="bar"><span style="width:0"></span></div><div class="lvl-sub"><span>${esc(f.ok ? L("盒子这一舱还没报水位") : L("暂无数据源"))}</span></div>`);
  }
  const ev = c.events;
  const when = (ms) => (ms ? `<b>${esc(fmtTime(ms))}</b><small>${esc(ago(ms, now))}</small>` : `<b class="muted">—</b><small>${esc(ev.exists ? L("还没有记录") : L("暂无数据源"))}</small>`);
  parts.push(`<div class="kv2"><div><span class="lbl">${esc(L("最后收到她"))}</span>${when(ev.lastIn)}</div><div><span class="lbl">${esc(L("最后发出去"))}</span>${when(ev.lastOut)}</div></div>`);
  const procs = c.pm2.procs || [];
  parts.push(`<div class="procs">${c.pm2.ok
    ? (procs.length ? procs.map((p, i) => {
      const short = p.name.startsWith(c.id + "-") ? p.name.slice(c.id.length + 1) : p.name;
      const cls = p.status === "online" ? "" : p.status === "stopped" ? " off" : " bad";
      const st = p.status === "online" ? `${L("运行中")} · ${fmtDur(p.uptimeMs)}` : T(PM2_STATE, p.status);
      return `<div class="proc"><div class="pl"><span class="rn">${ROMAN[i] || i + 1}</span><span><b>${esc(short)}</b><small>${esc(p.name)} · ${esc(L("重启 {0} 次", p.restarts))}</small></span></div><span class="ps-t${cls}">${esc(st)}</span></div>`;
    }).join("") : `<div class="proc"><span class="muted small">${esc(L("pm2 里没有 {0}-* 进程", c.id))}</span></div>`)
    : `<div class="proc"><span class="muted small">${esc(c.pm2.error)}</span></div>`}</div>`);
  const pend = c.pending || { total: 0 };
  const ft = failTotal(c);
  parts.push(`<div class="minis"><a class="mini${pend.total ? " alarm" : ""}" href="#stuck"><span>${esc(L("卡住的消息"))}</span><b>${pend.ok === false ? "?" : pend.total}</b></a>`
    + `<a class="mini${ft ? " alarm" : ""}" href="/c/${encodeURIComponent(c.id)}/failures"><span>${esc(L("24 小时出错"))}</span><b>${ft}</b></a></div>`);
  // 细节：入站悬着、日志基线、数据源缺口
  const notes = [];
  const ig = c.ingress;
  if (ig && ig.ok && ig.count) notes.push(L("入站记录里悬着 {0} 条（{1}）", ig.count, Object.entries(ig.byState).map(([k, v]) => `${ingressCn(k)} ${v}`).join(L("、"))) + (ig.oldestAt ? L("，最老一条悬了 {0}", fmtDur(now - ig.oldestAt)) : ""));
  const noBase = (c.errlogs || []).filter((l) => l.ok && !l.baseline);
  if (noBase.length) notes.push(L("错误日志没有时间戳，面板从现在开始记基线；{0} 个进程的日志暂时只能看尾部", noBase.length));
  if (!(f.ok && f.hasThread)) notes.push(f.ok ? L("水位：盒子这一舱没有线程号，心跳里用量是 0") : f.exists === false ? L("水位：没有心跳文件") : L("水位：{0}", f.why ? L(f.why) : L("心跳读不了")));
  if (!c.alert.ok) notes.push(L("掉档告警：{0}", c.alert.exists ? L("读不了") : L("暂无数据源")));
  if (c.engine && c.engine.others && c.engine.others.length) notes.push(L("会话记录里还有：{0}", c.engine.others.map((m) => `${m.model}（${RUNTIME[m.runtime] || m.runtime}）`).join(L("、"))));
  if (pend.ok === false) notes.push(L("卡住的消息读不了：{0}", pend.error));
  if (notes.length) parts.push(`<details class="more"><summary>${esc(L("说明（{0}）", notes.length))}</summary><div class="inner">${notes.map(esc).join("<br>")}</div></details>`);
  const cid = encodeURIComponent(c.id);
  parts.push(`<div class="acts"><a class="btn primary" href="/c/${cid}/base">${esc(L("这一舱装了什么"))} ${I.arrow}</a><a class="btn" href="/c/${cid}/failures">${esc(L("出错详情"))}</a></div>`
    + `<div class="acts acts2"><a class="btn rot" href="/c/${cid}/rotate">${I.rotate}${esc(L("换舱"))}</a><a class="btn" href="/c/${cid}/files">${I.quill}${esc(L("改文件"))}</a></div>`
    + `<div class="links"><a class="more-link" href="/c/${cid}/assembled">${esc(L("整舱拼好的全文"))} ${I.arrow}</a><a class="more-link" href="/c/${cid}/tail">${esc(L("暖尾巴挑选"))} ${I.arrow}</a><a class="more-link" href="/c/${cid}/writings">${esc(L("他写的东西"))} ${I.arrow}</a></div>`);
  return `<section class="ch gem-${gem}" id="c-${esc(c.id)}">${top}<div class="ch-body">${parts.join("")}</div></section>`;
}

function stuckPanel(cards, gems) {
  const sum = { stuck: 0, rejected: 0, dead: 0, check: 0 };
  const rows = [];
  const broken = [];
  for (const c of cards) {
    if (c.error || !c.pending) continue;
    if (c.pending.ok === false) { broken.push(`${c.displayName || c.id}：${c.pending.error}`); continue; }
    for (const k of Object.keys(sum)) sum[k] += c.pending.counts[k] || 0;
    for (const it of c.pending.items) rows.push({ c, it });
  }
  rows.sort((a, b) => (a.it.at || 0) - (b.it.at || 0));
  const total = rows.length;
  const tl = (n, label) => `<span class="tl${n ? " alarm" : ""}"><b>${n}</b>${esc(label)}</span>`;
  const tagCls = (it) => (it.kind === "dead" || it.state === "unknown" ? "bad" : "");
  const list = total ? `<div class="rows">${rows.map(({ c, it }) => `<div class="r"><span class="tm">${esc(fmtTime(it.at))}</span>`
    + `<span class="who"><b><span class="dot gem-${gems[c.id] || "sapphire"}"></span>${esc(c.displayName || c.id)}</b>${esc(it.who)}${it.channel ? " · " + esc(it.channel) : ""}</span>`
    + `<span class="what"><span class="tag ${tagCls(it)}">${esc(it.label)}</span><br><span class="pv">「${esc(it.preview) || esc(L("（空）"))}」</span>${it.reason ? `<span class="why">${esc(L("原因：{0}", it.reason))}</span>` : ""}</span>`
    + `<span class="cd">#${esc(it.code)}</span></div>`).join("")}</div>`
    : `<div class="empty"><span class="em">✧</span><b>${esc(L("没有卡住的消息"))}</b><p>${esc(L("拒收、卡住、死信、待核对的，都清了。"))}</p></div>`;
  return `<section class="panel pad" id="stuck"><div class="ph"><div><h3 class="pt">${esc(L("卡住的消息"))}</h3><div class="ps">STILL IN THE NAVE · ${esc(L("跟 /pending 同一张表"))}</div></div>`
    + `<span class="hint">${I.chat}${L("在 Telegram 发 <code>/pending</code> 处理")}</span></div>`
    + `<div class="tally">${tl(total, L("条一共"))}${tl(sum.stuck, L("卡住"))}${tl(sum.rejected, L("拒收"))}${tl(sum.dead, L("死信"))}${tl(sum.check, L("待核对"))}</div>`
    + list
    + (broken.length ? `<div class="err" style="margin-top:12px">${broken.map(esc).join("<br>")}</div>` : "")
    + `<p class="note" style="margin:14px 0 0">${esc(L("面板只读，不在这里重投。处理请在 Telegram 里发 /pending，右边的编号就是那里的编号（retry 重来 / drop 放弃）。正文只露前 20 字。"))}</p></section>`;
}

function failSummary(f) {
  if (f.type === "errlog") return L("{0} 行新错误", f.lineCount);
  const d = f.detail || {};
  const s = d.error || d.reason || d.why || d.verdict || d.detail || (d.modelStatus ? L("实际 {0}", d.lastActual || "?") : "") || d.state || "";
  const t = typeof s === "object" ? JSON.stringify(s) : String(s);
  return t.length > 80 ? t.slice(0, 80) + "…" : t;
}

function errorsPanel(cards, gems) {
  const rows = [];
  for (const c of cards) {
    if (c.error) continue;
    for (const f of c.failures || []) if (!f.noBaseline) rows.push({ c, f });
  }
  rows.sort((a, b) => b.f.at - a.f.at);
  const shown = rows.slice(0, 12);
  const list = rows.length ? `<div class="rows">${shown.map(({ c, f }) => `<div class="r"><span class="tm">${esc(fmtTime(f.at))}<small>${esc(f.detail && f.detail.channel ? f.detail.channel : "")}</small></span>`
    + `<span class="who"><b><span class="dot gem-${gems[c.id] || "sapphire"}"></span>${esc(c.displayName || c.id)}</b></span>`
    + `<span class="what"><span class="tag bad">${esc(f.label)}</span>${failSummary(f) ? `<span class="why">${esc(failSummary(f))}</span>` : ""}</span>`
    + `<a class="cd more-link" href="/c/${encodeURIComponent(c.id)}/failures">${esc(L("详情"))} ${I.arrow}</a></div>`).join("")}</div>`
    : `<div class="empty"><span class="em">✧</span><b>${esc(L("这 24 小时没有出过错"))}</b><p>${esc(L("账本、错误日志、掉档告警都是安静的。"))}</p></div>`;
  const live = cards.filter((c) => !c.error);
  return `<section class="panel pad" id="errors"><div class="ph"><div><h3 class="pt">${esc(L("最近 24 小时出过的错"))}</h3><div class="ps">EVENT LOG · ${esc(L("新的在上"))}</div></div>`
    + `<span class="hint">${esc(L("共 {0} 次", rows.reduce((a, r) => a + (r.f.type === "errlog" ? r.f.lineCount : 1), 0)))}</span></div>${list}`
    + (rows.length > shown.length ? `<p class="note">${esc(L("只列最近 {0} 条，其余去各自的出错详情看。", shown.length))}</p>` : "")
    + `<div class="links">${live.map((c) => `<a class="more-link" href="/c/${encodeURIComponent(c.id)}/failures">${esc(L("{0}的出错详情", c.displayName || c.id))} ${I.arrow}</a>`).join("")}</div></section>`;
}

function homePage(cards, { now = Date.now(), gems = {} } = {}) {
  const gemOf = (c, i) => gems[c.id] || GEMS[i % GEMS.length];
  const gmap = Object.fromEntries(cards.map((c, i) => [c.id, gemOf(c, i)]));
  const live = cards.filter((c) => !c.error);
  const procs = live.flatMap((c) => (c.pm2 && c.pm2.procs) || []);
  const online = procs.filter((p) => p.status === "online").length;
  const stuck = live.reduce((a, c) => a + ((c.pending && c.pending.total) || 0), 0);
  const fails = live.reduce((a, c) => a + failTotal(c), 0);
  const lastIn = live.reduce((m, c) => (c.events && c.events.lastIn > m.at ? { at: c.events.lastIn, c } : m), { at: 0, c: null });
  const down = cards.filter((c) => overallState(c)[0] === "bad").map((c) => c.displayName || c.id);
  const names = cards.map((c) => c.displayName || c.id);

  const line1 = down.length ? L("{0}那边有进程不在线，或者配置读不出来 —— 往下看。", down.join(L("、")))
    : names.length ? L("{0}都在，桥一直亮着灯。", names.join(L("和"))) : L("还没找到任何角色。");
  const hero = `<div class="welcome"><span class="eyebrow">✦ A PLACE BETWEEN WORLDS</span><span class="eyebrow r">${esc(tzLabel())} ${esc(fmtTime(now))}</span></div>`
    + `<section class="hero"><div class="hero-img"></div><div class="hero-glow"></div><div class="hero-copy"><div class="hero-label">IM-BRIDGE · ${esc(L("面板"))}</div>`
    + `<h1>${L("让每一句话，<br><span>都被好好接住。</span>")}</h1><p>${esc(line1)}<br>${esc(L("卡住 {0} 条 · 24 小时出过 {1} 次错", stuck, fails))}</p>`
    + `<div class="hero-actions"><a class="btn primary" href="#stuck">${esc(L("看卡住的消息"))} ${I.arrow}</a><a class="btn" href="#errors">${esc(L("最近出过的错"))}</a></div></div>`
    + `<div class="hero-bottom">DUOMO DI MILANO · ARCHITECTURAL STUDY</div></section>`;

  const stat = (href, label, icon, num, sub, alarm = false) => `<a class="stat" href="${href}"><div class="stat-top"><span>${esc(label)}</span>${icon}</div>`
    + `<div class="stat-num${alarm ? " alarm" : ""}">${num}</div><div class="stat-sub">${sub}</div></a>`;
  const sumK = (k) => live.reduce((a, c) => a + ((c.pending && c.pending.counts && c.pending.counts[k]) || 0), 0);
  const stats = `<div class="sh"><h2>${esc(L("总览"))}</h2><span class="aside">${esc(L("每次刷新重新读"))}</span></div><div class="stats">`
    + stat("#chars", L("在线进程"), I.chip, `${online}<small>/ ${procs.length}</small>`, online === procs.length && procs.length ? `<b>${esc(L("全部运行中"))}</b>` : `<b class="w">${esc(L("{0} 个不在线", procs.length - online))}</b>`)
    + stat("#stuck", L("卡住的消息"), I.pending, String(stuck), esc(L("卡住 {0} · 拒收 {1} · 死信 {2} · 待核对 {3}", sumK("stuck"), sumK("rejected"), sumK("dead"), sumK("check"))), stuck > 0)
    + stat("#errors", L("24 小时出错"), I.errors, String(fails), esc(L("账本、错误日志、掉档告警")), fails > 0)
    + stat("#chars", L("最后收到她"), I.chat, lastIn.at ? esc(bjParts(lastIn.at).hour + ":" + bjParts(lastIn.at).minute) : "—",
      lastIn.at ? `${esc(ago(lastIn.at, now))} · ${esc(lastIn.c.displayName || lastIn.c.id)}` : esc(L("还没有记录")))
    + `</div>`;

  const chars = `<div class="sh" id="chars"><h2>${esc(L("两位"))}</h2><span class="aside">PERSONA · ${esc(L("同一页并排"))}</span></div>`
    + (cards.length ? `<div class="chars">${cards.map((c, i) => charCard(c, gemOf(c, i), now)).join("")}</div>`
      : `<div class="panel pad">${esc(L("没有找到任何角色（PANEL_CHARACTERS 没给，~/.*-gate/*-env.sh 也没扫到）。"))}</div>`);

  const body = hero + stats + chars + `<div class="sh"><h2>${esc(L("要留意的"))}</h2><span class="aside">${esc(L("只看不动"))}</span></div><div class="stack">${stuckPanel(cards, gmap)}${errorsPanel(cards, gmap)}</div>`;
  return shell({ title: L("桥 · 面板"), crumb: L("总览"), active: "home", nav: cards.map((c) => ({ id: c.id, displayName: c.displayName })), stuck, now, content: body });
}

// ——— 底子页 ———
function srcList(sources) {
  if (!sources || !sources.length) return `<ul class="srcs"><li>${esc(L("（代码里固定的文字，没有来源文件）"))}</li></ul>`;
  return `<ul class="srcs">${sources.map((s) => {
    const k = esc(s.kind === "module" ? L("代码模块") : s.kind === "dir" ? L("目录") : L("文件"));
    const x = s.cross && s.kind !== "module";
    const tag = x ? (s.foreign && s.foreign.length ? L("属于 {0}", s.foreign.join(" / ")) : L("不在本角色目录下")) : "";
    return `<li class="${x ? "x" : ""}"><span class="k">${k}</span>${esc(s.path)}${s.exists === false ? ` <span class="k">${esc(L("不存在"))}</span>` : ""}${tag ? ` <span class="k">${esc(tag)}</span>` : ""}</li>`;
  }).join("")}</ul>`;
}

function secCard(s) {
  const cn = SECTION_CN[s.name];
  return `<details class="sec${s.cross ? " cross" : ""}"><summary>`
    + `<div class="sec-t"><b><span class="chev"></span>${esc(secCn(s.name))}${cn && cn !== s.name ? `<small class="en">${esc(s.name)}</small>` : ""}</b><span class="n">${s.chars.toLocaleString()}<small>${esc(L("字"))}</small></span></div>`
    + (s.cross ? `<span class="xwarn">${I.errors}${esc(L("来自别的角色"))}</span>` : "")
    + srcList(s.sources) + `</summary><div class="body"><pre>${esc(s.text)}</pre></div></details>`;
}

function viewHead(eyebrow, title, sub, back = true) {
  return `<section class="vh"><div class="hero-img"></div><div class="vt"><small>${esc(eyebrow)}</small><h1>${esc(title)}</h1>${sub ? `<p>${sub}</p>` : ""}</div>`
    + (back ? `<a class="btn" href="/">${I.back} ${esc(L("回到总览"))}</a>` : "") + `</section>`;
}

function basePage(ch, base, loaded, { gem = "sapphire", now = Date.now(), nav = [] } = {}) {
  const parts = [];
  const name = ch.displayName || ch.id;
  parts.push(viewHead("THE CHAPEL OF RECORDS · " + L("这一舱"), L("{0} · 这一舱装了什么", name),
    esc(L("下次换舱会拼进去的底子，逐节列出、标明来源文件。来源落在别的角色目录里的，整节标红。{0} {1}。", tzLabel(), fmtTime(now)))));
  const done = () => shell({ title: L("{0} · 底子", ch.id), crumb: L("{0} · 这一舱", name), active: "base:" + ch.id, nav, now, content: `<div class="gem-${gem}">${parts.join("")}</div>` });
  if (ch.error) {
    parts.push(`<div class="err">${esc(L("这个角色的配置读不出来：{0}", ch.error))}</div>`);
    return done();
  }
  parts.push(`<section class="panel pad"><h3 class="pt">${esc(L("本角色的目录"))}</h3><div class="note">${esc(L("判断依据：来源路径必须落在下面这些目录之下（都来自 {0}）。不在里面、或落进别的角色目录的，整节标红。", ch.envFile))}</div>`
    + `<ul class="srcs">${(ch.roots || []).map((r) => `<li><span class="k">${esc(r.key)}</span>${esc(r.dir)}</li>`).join("") || `<li>${esc(L("（env 里一个目录都没声明）"))}</li>`}</ul></section>`);

  parts.push(`<div class="formrow" style="margin:0 0 6px"><a class="btn primary" href="/c/${encodeURIComponent(ch.id)}/assembled">${esc(L("整舱拼好的全文"))} ${I.arrow}</a>`
    + `<a class="btn" href="/c/${encodeURIComponent(ch.id)}/tail">${esc(L("暖尾巴挑选"))}</a><a class="btn" href="/c/${encodeURIComponent(ch.id)}/files">${I.quill}${esc(L("改文件"))}</a></div>`);
  parts.push(`<div class="sh"><h2>${esc(L("下次换舱会拼进去的底子"))}</h2><span class="aside">${esc(L("点开看全文"))}</span></div>`);
  if (!base || !base.ok) {
    parts.push(`<div class="err">${esc(L("拼不出来：{0}", (base && base.error) || L("子进程没有结果")))}</div>`);
  } else {
    const crossN = base.sections.filter((s) => s.cross).length;
    parts.push(`<p class="note" style="margin:-6px 0 14px">${esc(L("共 {0} 字，{1} 节", base.total.toLocaleString(), base.sections.length))}${crossN ? ` · <b class="down">${esc(L("{0} 节来自本角色目录之外", crossN))}</b>` : ""}${esc(L("。"))}</p>`);
    parts.push(`<div class="secs">${base.sections.map(secCard).join("")}</div>`);
    // SESSION HANDOFF 在 box-build 里是关着的（enableSessionHandoff:false），空着是常态，不点名
    const missing = (base.expected || []).filter((h) => h !== "SESSION HANDOFF" && !base.sections.some((s) => s.name === h));
    if (missing.length) parts.push(`<p class="missing">${esc(L("这几节这次是空的（读不到料就不拼，不报错）："))}${missing.map((m) => esc(sectionLabel(m))).join(L("、"))}</p>`);
    const pers = base.persona || [];
    parts.push(`<div class="sh"><h2>${esc(L("人格文件"))}</h2><span class="aside">${esc(L("不在底子里，同样是开舱时读一次"))}</span></div>`
      + `<section class="panel pad">${pers.length ? srcList(pers) : `<p class="note">${esc(L("人格配置里没写人格文件，工作目录里也没有 CLAUDE.md / AGENTS.md。"))}</p>`}`
      + `<div class="formrow"><a class="btn primary" href="/c/${encodeURIComponent(ch.id)}/files">${I.quill}${esc(L("改这些文件"))} ${I.arrow}</a></div></section>`);
  }

  parts.push(`<div class="sh"><h2>${esc(L("当前这一舱实际注入的"))}</h2><span class="aside">${esc(L("只对字数"))}</span></div>`);
  if (!loaded || !loaded.ok) {
    parts.push(`<div class="panel pad note">${esc(loaded && loaded.exists ? L("注入记录（injection-loaded.json）读不了") : L("暂无记录（这一舱开舱时没写 injection-loaded.json —— 只有 forge 开新舱才会写）"))}</div>`);
  } else {
    const j = loaded.data;
    const inj = j.injection || null;
    const nextBy = Object.fromEntries(((base && base.sections) || []).map((s) => [s.name, s.chars]));
    const names = [...new Set([...(j.sections || []).map((s) => s.name), ...Object.keys(nextBy)])];
    const curBy = Object.fromEntries((j.sections || []).map((s) => [s.name, s.chars]));
    parts.push(`<section class="panel pad"><dl class="kv">`
      + `<dt>${esc(L("开舱时间"))}</dt><dd>${esc(fmtTime(Date.parse(j.at || "")))}</dd>`
      + `<dt>${esc(L("线程"))}</dt><dd>${esc(String(j.threadId || "—").slice(0, 8))}</dd>`
      + `<dt>${esc(L("工作目录"))}</dt><dd class="${loaded.workspace && loaded.workspace.cross ? "down" : ""}">${esc(j.workspace || "—")}${loaded.workspace && loaded.workspace.cross ? " · " + esc(L("不在本角色目录下")) : ""}</dd>`
      + (inj ? `<dt>${esc(L("身份底座文件"))}</dt><dd class="${loaded.injection && loaded.injection.cross ? "down" : ""}">${esc(inj.file)}${loaded.injection && loaded.injection.cross ? ` · ${esc(loaded.injection.foreign.length ? L("属于 {0}", loaded.injection.foreign.join(" / ")) : L("不在本角色目录下"))}` : ""}</dd>`
        + `<dt>${esc(L("指纹"))}</dt><dd>${esc(String(inj.sha256 || "").slice(0, 16))}… · ${esc(L("{0} 字节", inj.bytes))} · ${esc(fmtTime(Date.parse(inj.mtime || "")))}${loaded.injectionNow ? (loaded.injectionNow.same ? ` · <span class="up">${esc(L("跟现在的文件一致"))}</span>` : ` · <span class="down">${esc(L("文件已经变了，下次换舱才生效"))}</span>`) : ""}</dd>` : `<dt>${esc(L("身份底座"))}</dt><dd>${esc(L("这一舱没有"))}</dd>`)
      + `</dl>`
      + `<table><tr><th>${esc(L("节"))}</th><th class="r">${esc(L("当前这一舱"))}</th><th class="r">${esc(L("下次换舱"))}</th></tr>`
      + names.map((n) => {
        const a = curBy[n], b = nextBy[n];
        const d = a !== undefined && b !== undefined ? b - a : null;
        return `<tr><td>${esc(secCn(n))}</td><td class="r">${a === undefined ? "—" : a.toLocaleString()}</td><td class="r">${b === undefined ? "—" : b.toLocaleString()}${d ? ` <span class="small ${d > 0 ? "up" : "down"}">${d > 0 ? "+" : ""}${d}</span>` : ""}</td></tr>`;
      }).join("")
      + `<tr><td><b>${esc(L("合计"))}</b></td><td class="r">${(j.total || 0).toLocaleString()}</td><td class="r">${base && base.ok ? base.total.toLocaleString() : "—"}</td></tr></table>`
      + `<p class="note" style="margin:10px 0 0">${esc(L("注入记录只存了各节字数和身份底座文件的指纹，没存当时的全文 —— 当时的原文看不到，只能对字数。"))}</p></section>`);
  }
  return done();
}

// ——— 出错详情 ———
function failItem(tagCls, label, at, inner) {
  return `<div class="panel fi"><div class="h"><span class="tag ${tagCls}">${esc(label)}</span><span class="small muted latin">${esc(at)}</span></div>${inner}</div>`;
}

function failuresPage(ch, c, { gem = "sapphire", now = Date.now(), hours = 24, nav = [] } = {}) {
  const name = ch.displayName || ch.id;
  const parts = [viewHead("EVENT LOG · " + L("新的在上"), L("{0} · 出错详情", name),
    `${esc(L("最近 {0} 小时", hours))} · ${esc(tzLabel())} · <a class="more-link" href="?h=${hours === 24 ? 168 : 24}">${esc(hours === 24 ? L("看最近 7 天") : L("看最近 24 小时"))} ${I.arrow}</a>`)];
  const done = () => shell({ title: L("{0} · 出错", ch.id), crumb: L("{0} · 出错详情", name), active: "failures:" + ch.id, nav, now, content: `<div class="gem-${gem}">${parts.join("")}</div>` });
  if (c.error) { parts.push(`<div class="err">${esc(c.error)}</div>`); return done(); }
  const list = c.failures || [];
  if (c.events && c.events.coveredSince && c.events.coveredSince > c.sinceMs) parts.push(`<p class="note">${esc(L("账本只读到了 {0} 为止。", fmtTime(c.events.coveredSince)))}</p>`);
  const KEY = { since: "基线起点", newBytes: "新增字节", channel: "渠道", chatType: "会话类型", turnId: "轮次", outputId: "输出", state: "状态",
    error: "错误", reason: "原因", why: "为什么", detail: "细节", verdict: "判定", verifyReasons: "核对理由", capability: "能力",
    modelStatus: "模型状态", lastActual: "实际用的模型", sessionLimitAlerted: "撞线提醒过", 最后修改: "最后修改" };
  parts.push(list.length ? `<div class="fl">${list.map((f) => {
    const kv = Object.entries(f.detail || {}).map(([k, v]) => {
      const val = (k === "since" || k === "最后修改") ? fmtTime(v) : k === "modelStatus" ? String(T({ fallback: "掉档中", normal: "正常" }, v)) : typeof v === "boolean" ? (v ? L("是") : L("否")) : typeof v === "object" ? JSON.stringify(v) : String(v);
      return `<dt>${esc(T(KEY, k))}</dt><dd>${esc(val.length > 600 ? val.slice(0, 600) + "…" : val)}</dd>`;
    }).join("");
    return failItem(f.noBaseline ? "" : "bad", f.label, fmtTime(f.at),
      `<ul class="srcs"><li>${esc(f.source)}</li></ul>${kv ? `<dl class="kv">${kv}</dl>` : ""}`
      + (f.lines ? `<pre>${esc(f.lines.join("\n"))}</pre>${f.lineCount > f.lines.length ? `<div class="small muted">${esc(L("共 {0} 行，只显示最后 {1} 行", f.lineCount, f.lines.length))}</div>` : ""}` : ""));
  }).join("")}</div>` : `<div class="panel"><div class="empty"><span class="em">✧</span><b>${esc(L("这段时间里没有出过错"))}</b></div></div>`);

  const ig = c.ingress;
  if (ig && ig.ok && ig.count) {
    parts.push(`<div class="sh"><h2>${esc(L("悬着的入站（{0}）", ig.count))}</h2><span class="aside">${esc(L("入站记录里还没走完的"))}</span></div><div class="fl">${ig.hanging.slice().sort((a, b) => b.at - a.at).map((h) =>
      failItem("", ingressCn(h.state), h.at ? fmtTime(h.at) + " · " + L("悬了 {0}", fmtDur(now - h.at)) : L("看不出时间"),
        `<dl class="kv"><dt>${esc(L("渠道"))}</dt><dd>${esc(h.channel || "—")}</dd><dt>${esc(L("轮次"))}</dt><dd>${esc(h.turnId || "—")}</dd>${h.error ? `<dt>${esc(L("原因"))}</dt><dd>${esc(h.error)}</dd>` : ""}</dl>`)).join("")}</div>`);
  }
  return done();
}

// ——— 门 ———
function gatePage(title, lines, { form = "" } = {}) {
  return page(title, `<div class="gate"><div class="panel gate-card"><div class="gate-img"></div><div class="brand">${SEAL}</div>`
    + `<span class="eyebrow">THE SANCTUARY · ${esc(L("桥的面板"))}</span><h1>${esc(title)}</h1>${lines.map((l) => `<p>${esc(l)}</p>`).join("")}${form}</div></div>`);
}
/** 输登录码的表单（主屏幕 App 里没有地址栏，点不了链接）。 */
const codeForm = (error = "") => `<form method="post" action="/login" class="codeform">`
  + (error ? `<p class="codeerr">${esc(error)}</p>` : "")
  + `<input name="code" inputmode="text" autocapitalize="characters" autocomplete="one-time-code" spellcheck="false" maxlength="12" placeholder="XXXX-XXXX" aria-label="${esc(L("登录码"))}" required>`
  + `<button class="btn primary" type="submit">${esc(L("进 门"))}</button></form>`;
const unauthorizedPage = () => gatePage(L("这扇门需要钥匙"), [L("灯还亮着，只是要先认一认你。"), L("点 Telegram 里的登录链接，或者把登录码填在下面。")], { form: codeForm() });
const codeLoginPage = ({ error = "" } = {}) => gatePage(L("输入登录码"), [L("登录码跟登录链接一起发，十分钟内有效，只能用一次。")], { form: codeForm(error) });
const loginPage = (token) => gatePage(L("欢迎回来"), [L("门已经为你开好了。")],
  { form: `<form method="post" action="/login"><input type="hidden" name="t" value="${esc(token)}"><button class="btn primary" type="submit">${esc(L("进 门"))}</button></form>` });
const linkDeadPage = () => gatePage(L("这把钥匙已经用过了"), [L("登录链接只能用一次，十分钟后也会作废。"), L("再要一个新的就好。")]);
const notFoundPage = () => gatePage(L("这里什么都没有"), [L("回总览看看吧。")], { form: `<p><a class="btn" href="/">${esc(L("回到总览"))}</a></p>` });


// ——— 动手的地方（2026-10-22）：换舱、改文件、操作记录 ———
const enc = encodeURIComponent;
const short = (h) => (h ? String(h).slice(0, 10) : "—");
const hidden = (name, value) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
/** 文本框开头的换行会被 HTML 吃掉一个 —— 多垫一个。 */
const taBody = (text) => "\n" + esc(text);
const EFFECT_NOTE = "改动<b>下次换舱才生效</b> —— 人格、CLAUDE.md、底子这些只在开舱时读一次，他现在这一舱看到的还是旧的。";
function effectBar(ch) {
  return `<div class="eff"><span>${L(EFFECT_NOTE)}</span><a class="btn rot" href="/c/${enc(ch.id)}/rotate">${I.rotate}${esc(L("现在换舱"))}</a></div>`;
}
function actShell(ch, { title, crumb, active, nav, now, gem = "sapphire", content, refresh = null }) {
  return shell({ title, crumb, active, nav, now, refresh, content: `<div class="gem-${gem}">${content}</div>` });
}

const ROTATE_STATE = {
  queued: ["warn", "在排队", "等他把正在说的这一句说完，再收尾、开新舱。"],
  running: ["warn", "正在换", "收尾轮 → 开新舱，这一步可能要一两分钟。"],
  done: ["ok", "换好了", "他下一句就在新舱里说。Telegram 里也发了同样的回执。"],
  failed: ["bad", "没换成", "原因在下面；他还在原来的舱里。"],
};

const ENGINE_NAME = { "claude-cli": "Claude", "codex-appserver": "Codex", "openai-chat": "OpenAI 兼容接口" };
const winCn = (n) => (n >= 10000 ? wan(n) : String(n));
function modelLine(m) {
  return `${esc(m.label || m.id)} <span class="mid">${esc(m.id)}</span><small>${esc(T(ENGINE_NAME, m.engine))} · ${esc(L("上下文 {0}", winCn(m.window)))}`
    + `${m.billing === "api" ? ` · ${esc(L("按量计费"))}${m.money && m.money.ok ? "" : esc(L("（钱闸没开，桥会拒）"))}` : ""}${m.vision === false ? " · " + esc(L("看不见图")) : ""}${m.tools === false ? " · " + esc(L("没接工具")) : ""}</small>`;
}

function rotateConfirmPage(ch, { gem, now, nav, csrf, card = null, choices = null } = {}) {
  const name = ch.displayName || ch.id;
  const f = card && card.fullness;
  const facts = [];
  if (f && f.ok && f.hasThread) facts.push(L("现在这一舱的水位 {0}%（{1} / {2}）", (f.ratio * 100).toFixed(0), wan(f.used), wan(f.limit)));
  if (card && card.events && card.events.lastIn) facts.push(L("最后收到她：{0}（{1}）", fmtTime(card.events.lastIn), ago(card.events.lastIn, now)));
  const c = choices || { models: [], current: "", reg: { ok: false } };
  const cur = c.currentEntry;
  const curName = cur ? (cur.label || cur.id) : (c.current || L("现在这个"));
  const others = c.models.filter((m) => !m.isCurrent);
  const same = others.filter((m) => m.sameEngine), cross = others.filter((m) => !m.sameEngine);
  const radio = (value, html, checked = false, disabled = false) => `<label class="mopt${disabled ? " dis" : ""}"><input type="radio" name="model" value="${esc(value)}"${checked ? " checked" : ""}${disabled ? " disabled" : ""}><span>${html}</span></label>`;
  let picker = `<section class="panel pad confirm"><h3 class="pt">${esc(L("换舱后用哪个模型"))}</h3>`
    + radio("", `${esc(L("不换，还用 {0}", curName))}${cur ? `<small>${esc(T(ENGINE_NAME, cur.engine))} · ${esc(L("上下文 {0}", winCn(cur.window)))} · ${esc(L("现在在用的"))}</small>` : ""}`, true);
  if (same.length) picker += `<div class="mgrp">${esc(L("同一家（{0}）· 换舱后热切", T(ENGINE_NAME, c.engine)))}</div>` + same.map((m) => radio(m.id, modelLine(m), false, !!c.pinned)).join("");
  if (cross.length) picker += `<div class="mgrp">${esc(L("别家 · 一次完整的换引擎"))}</div>` + cross.map((m) => radio(m.id, modelLine(m), false, !!c.pinned)).join("");
  if (!c.reg.ok) picker += `<p class="note">${esc(L("模型登记表读不了（{0}），只能不换模型。", (c.reg.errors && c.reg.errors[0]) || ""))}</p>`;
  else if (!others.length) picker += `<p class="note">${esc(L("登记表里只有这一个模型。要加别的，改 {0}（跟 Telegram 里 /model 弹的是同一份）。", c.reg.file))}</p>`;
  if (c.pinned) picker += `<p class="note">${esc(L("env 里 GATE_MODEL 钉死了 {0}，换不了模型。", c.pinned))}</p>`;
  picker += `<p class="note">${esc(L("清单就是这一位的模型登记表（{0}），跟 Telegram 里 /model、/engine 弹出来的同一份。", c.reg.file || "models.json"))}</p></section>`;
  const conseq = `<section class="panel pad confirm"><h3 class="pt">${esc(L("按下去之后会发生什么"))}</h3><ul>`
    + `<li>${L("<b>会打断他正在说的那一句。</b>桥先等他这一轮说完，然后让他收个尾（笔记本、你这一舱说过的要求、对你近况的判断），再关掉旧舱。")}</li>`
    + `<li>${L("<b>换完他下一句就开新舱。</b>新舱重新拼底子、重新读人格和 CLAUDE.md —— 你刚改的文件这时候才生效。")}</li>`
    + `<li>${L("<b>不换模型 = 跟在 Telegram 发 <code class=\"mono\">/new</code> 完全一样。</b>同一张命令表、同一条排队的路；Telegram 里也会收到同样的回执。")}</li>`
    + (same.length ? `<li>${L("<b>同一家换个模型 = 先 <code class=\"mono\">/new</code> 再 <code class=\"mono\">/model</code>。</b>收尾那一轮还用现在的模型跑（缓存是热的，不白白重算旧舱），新舱从第一句起就是新模型。两条连着跑，中间插不进别的话；换舱没成就不换模型。")}</li>` : "")
    + (cross.length ? `<li>${L("<b>换到别家 = 跟 Telegram 发 <code class=\"mono\">/engine</code> 一样，本身就是一次换舱。</b>")}`
      + L("带过去的：最近的真实对话（按新模型的窗口整轮装，装不下的最旧几轮丢掉；你在「暖尾巴挑选」里勾掉的照样不带）、底子、人格（按新引擎自己读文件的习惯重交）。")
      + `${L("带不过去的：旧舱本身（切回来也是重建，不续旧舱）、工具调用的来回、思考过程、缓存（新舱第一句全量重算）。新模型看不见图 / 没接工具的，回执里会写降级。任何一步不成就留在原来的模型上。")}</li>` : "")
    + `</ul>${facts.length ? `<p class="note">${facts.map(esc).join(" · ")}</p>` : ""}</section>`;
  const content = viewHead("THE CHAPEL OF PASSAGE · " + L("换舱"), L("给{0}换舱？", name), esc(L("不换模型就跟在 Telegram 里发 /new 完全一样 —— 走的就是同一条路。")), true)
    + `<form method="post" action="/c/${enc(ch.id)}/rotate">${hidden("csrf", csrf)}${picker}${conseq}`
    + `<div class="formrow"><button class="btn danger" type="submit">${I.rotate}${esc(L("确认换舱"))}</button><a class="btn" href="/#c-${esc(ch.id)}">${esc(L("算了"))}</a></div></form>`;
  return actShell(ch, { title: L("{0} · 换舱", ch.id), crumb: L("{0} · 换舱", name), active: "", nav, now, gem, content });
}

function rotateResultPage(ch, { gem, now, nav, job = null, error = "" } = {}) {
  const name = ch.displayName || ch.id;
  let body;
  let refresh = null;
  if (error || !job) {
    body = `<div class="state-big bad">${esc(L("没发出去"))}</div><div class="flash bad">${esc(error || L("桥没有回任务"))}</div>`
      + `<p class="note">${esc(L("什么都没动。可以稍后再试，或者直接在 Telegram 里发 /new。"))}</p>`;
  } else {
    const rs = ROTATE_STATE[job.state];
    const [cls, label, sub] = rs ? [rs[0], L(rs[1]), L(rs[2])] : ["warn", job.state, ""];
    const live = job.state === "queued" || job.state === "running";
    if (live) refresh = { secs: 4, url: `/c/${enc(ch.id)}/rotate/job?j=${enc(job.id)}` };
    body = `<div class="state-big ${cls}">${esc(label)}</div><p class="note">${esc(sub)}</p>`
      + ((job.texts || []).length ? `<p class="note">${esc(L("发给桥的："))}${job.texts.map((x) => `<code class="mono">${esc(x.split(" ").slice(0, x.startsWith("/new") ? 1 : 2).join(" "))}</code>`).join(" → ")}</p>` : "")
      + ((job.steps || []).length > 1 ? job.steps.map((st) => `<pre class="receipt">${esc("/" + st.command)} · ${esc(st.skipped ? L("没跑（前一条没成）") : st.ok ? L("成了") : L("没成"))}
${esc(st.text)}</pre>`).join("")
        : (job.text ? `<pre class="receipt">${esc(job.text)}</pre>` : ""))
      + `<dl class="kv"><dt>${esc(L("编号"))}</dt><dd>${esc(job.id)}</dd><dt>${esc(L("以谁的身份"))}</dt><dd>${esc(L("主人（{0}）", job.as || "—"))}</dd><dt>${esc(L("按下的时间"))}</dt><dd>${esc(fmtTime(Date.parse(job.at || "")))}</dd></dl>`
      + (live ? `<p class="note">${esc(L("这一页每 4 秒自己刷新一次。"))}<a class="more-link" href="${esc(refresh.url)}">${esc(L("现在刷新"))} ${I.arrow}</a></p>` : "");
  }
  const content = viewHead("THE CHAPEL OF PASSAGE · " + L("换舱"), L("{0} · 换舱", name), "", true)
    + `<section class="panel pad confirm">${body}<div class="formrow"><a class="btn" href="/#c-${esc(ch.id)}">${esc(L("回到总览"))}</a><a class="btn" href="/c/${enc(ch.id)}/base">${esc(L("这一舱装了什么"))}</a></div></section>`;
  return actShell(ch, { title: L("{0} · 换舱", ch.id), crumb: L("{0} · 换舱", name), active: "", nav, now, gem, content, refresh });
}

function filesPage(ch, { gem, now, nav, list = [], base = null, audit = [] } = {}) {
  const name = ch.displayName || ch.id;
  const parts = [viewHead("THE SCRIPTORIUM · " + L("改文件"), L("{0} · 改文件", name),
    esc(L("能改的只有「这一舱装了什么」里、落在他自己目录里的文件；别人目录里的、凭据类的一律不给改。")), true)];
  parts.push(effectBar(ch));
  parts.push(`<div class="formrow" style="margin:0 0 18px"><a class="btn" href="/c/${enc(ch.id)}/writings">${esc(L("他写的东西（笔记本、日记、备忘…）"))}${I.arrow}</a></div>`);
  if (ch.error) parts.push(`<div class="err">${esc(L("这个角色的配置读不出来：{0}", ch.error))}</div>`);
  else if (!base || !base.ok) parts.push(`<div class="err">${esc(L("列不出来：{0}", (base && base.error) || L("子进程没有结果")))}</div>`);
  else {
    const ok = list.filter((r) => r.editable), no = list.filter((r) => !r.editable);
    const row = (r) => {
      const x = !r.editable && (r.foreign.length || !r.own);
      return `<div class="fr${r.editable ? "" : " no"}${x ? " x" : ""}"><div class="fn"><b>${esc(r.path.split("/").pop())}</b><small>${esc(r.path)}</small>`
        + r.sections.map((sname) => `<span class="sec-k">${esc(fileSecCn(sname))}</span>`).join("")
        + (r.editable ? "" : `<div class="why">${esc(r.why)}</div>`) + `</div>`
        + (r.editable ? `<div class="go"><a class="btn primary" href="/c/${enc(ch.id)}/files/edit?f=${enc(r.path)}">${I.quill}${esc(L("打开"))}</a><a class="btn" href="/c/${enc(ch.id)}/files/history?f=${enc(r.path)}">${I.history}${esc(L("历史版本"))}</a></div>` : "")
        + `</div>`;
    };
    parts.push(`<section class="panel pad"><div class="ph"><div><h3 class="pt">${esc(L("能改的（{0}）", ok.length))}</h3><div class="ps">HIS OWN PAGES</div></div><a class="more-link" href="/c/${enc(ch.id)}/files/history">${esc(L("全部历史版本"))} ${I.arrow}</a></div>`
      + (ok.length ? `<div class="files">${ok.map(row).join("")}</div>` : `<div class="empty"><b>${esc(L("没有能改的文件"))}</b></div>`) + `</section>`);
    if (no.length) parts.push(`<div class="sh"><h2>${esc(L("不能改的（{0}）", no.length))}</h2><span class="aside">${esc(L("只列出来，打不开"))}</span></div><section class="panel pad"><div class="files">${no.map(row).join("")}</div></section>`);
  }
  parts.push(auditBlock(audit, { title: L("这位最近的操作"), more: true }));
  return actShell(ch, { title: L("{0} · 改文件", ch.id), crumb: L("{0} · 改文件", name), active: "files:" + ch.id, nav, now, gem, content: parts.join("") });
}

function editPage(ch, { gem, now, nav, csrf, file, text, sha, mono = false, draft = false, note = "" } = {}) {
  const name = ch.displayName || ch.id;
  const content = viewHead("THE SCRIPTORIUM · " + L("改文件"), `${name} · ${file.split("/").pop()}`, esc(file), false)
    + effectBar(ch)
    + (note ? `<div class="flash warn" style="margin-bottom:14px">${note}</div>` : "")
    + `<section class="panel pad"><form class="editor" method="post" action="/c/${enc(ch.id)}/files/preview">`
    + hidden("csrf", csrf) + hidden("f", file) + hidden("base", sha)
    + `<input class="sr" type="checkbox" id="mono" name="mono" value="1"${mono ? " checked" : ""}>`
    + `<div class="bar2"><label class="tog" for="mono"><i></i>${esc(L("等宽字体"))}</label><span>${draft ? esc(L("接着改你刚才那一版 · ")) : ""}${esc(L("打开时的版本 {0}", short(sha)))}</span></div>`
    + `<textarea class="ta" name="text" spellcheck="false" autocapitalize="off" autocomplete="off">${taBody(text)}</textarea>`
    + `<div class="formrow"><button class="btn primary" type="submit">${esc(L("看改动"))} ${I.arrow}</button>`
    + `<a class="btn" href="/c/${enc(ch.id)}/files/history?f=${enc(file)}">${I.history}${esc(L("历史版本"))}</a><a class="btn" href="/c/${enc(ch.id)}/files">${esc(L("不改了"))}</a></div>`
    + `<p class="note">${esc(L("先给你看改动对比，确认了才写进去。写之前会核对：你打开之后要是他（或者别人）改过这个文件，就不写，让你重新打开 —— 不会盖掉他的改动。旧版会先存一份。"))}</p>`
    + `</form></section>`;
  return actShell(ch, { title: L("{0} · 改文件", ch.id), crumb: L("{0} · 改文件", name), active: "files:" + ch.id, nav, now, gem, content });
}

function diffBlock(lines) {
  const ln = (n) => (n === undefined ? "" : String(n));
  return `<div class="diff">${lines.map((l) => {
    if (l.op === "…") return `<div class="dl skip"><span>${esc(L("…… 中间 {0} 行没变 ……", l.skip))}</span></div>`;
    const cls = l.op === "+" ? "add" : l.op === "-" ? "del" : "ctx";
    return `<div class="dl ${cls}"><span class="ln">${ln(l.a)}</span><span class="ln">${ln(l.b)}</span><span class="sg">${l.op === " " ? "" : l.op === "-" ? "−" : "+"}</span><span class="tx">${esc(l.text) || " "}</span></div>`;
  }).join("")}</div>`;
}

/**
 * 改动对比 + 确认。mode = "save"（编辑页来的）| "restore"（恢复历史版本）。
 */
function diffPage(ch, { gem, now, nav, csrf, file, sha, text = "", lines, stat, mono = false, mode = "save", backup = null } = {}) {
  const name = ch.displayName || ch.id;
  const restore = mode === "restore";
  const title = restore ? L("恢复到 {0} 那一版？", fmtTime(Date.parse(backup.at))) : L("确认这些改动？");
  const sub = restore ? esc(L("下面是「现在的文件 → 那一版」会变成的样子。")) + esc(file) : esc(file);
  const action = restore ? `/c/${enc(ch.id)}/files/restore` : `/c/${enc(ch.id)}/files/save`;
  const fields = hidden("csrf", csrf) + hidden("f", file) + hidden("base", sha) + (mono ? hidden("mono", "1") : "")
    + (restore ? hidden("b", backup.id) : `<textarea class="hidden" name="text" aria-hidden="true" tabindex="-1">${taBody(text)}</textarea>`);
  const content = viewHead("THE SCRIPTORIUM · " + L("改动对比"), `${name} · ${title}`, sub, false)
    + `<section class="panel pad"><div class="dsum"><span class="up">+${stat.add}</span><span>${esc(L("行加上"))}</span><span class="down">−${stat.del}</span><span>${esc(L("行去掉"))}</span>`
    + `<span class="muted small">${esc(L("绿色是加上的，红色划掉的是去掉的；没变的只留改动前后各 3 行。"))}</span></div>`
    + diffBlock(lines)
    + `<form method="post" action="${action}">${fields}<div class="formrow">`
    + `<button class="btn primary" type="submit">${restore ? I.history + esc(L("确认恢复")) : esc(L("确认写入"))}</button>`
    + (restore ? `<a class="btn" href="/c/${enc(ch.id)}/files/history?f=${enc(file)}">${esc(L("回到历史版本"))}</a>`
      : `<button class="btn" type="submit" formaction="/c/${enc(ch.id)}/files/edit">${I.back} ${esc(L("回去接着改"))}</button>`)
    + `<a class="btn" href="/c/${enc(ch.id)}/files">${esc(L("都不要了"))}</a></div>`
    + `<p class="note">${esc(L("写之前会再核对一次版本（{0}）：这期间文件要是被改过，就不写。旧版会先存进历史版本。", short(sha)))}</p></form></section>`
    + effectBar(ch);
  return actShell(ch, { title: L("{0} · 改动对比", ch.id), crumb: L("{0} · 改动对比", name), active: "files:" + ch.id, nav, now, gem, content });
}

/** 写完 / 写不进去 / 冲突 —— 一页说清。冲突时把她刚才那一版原样留着给她复制，不让她白改。 */
function writeResultPage(ch, { gem, now, nav, file, result, text = "", mode = "save" } = {}) {
  const name = ch.displayName || ch.id;
  const restore = mode === "restore";
  let body;
  if (result.ok) {
    body = `<div class="state-big ok">${esc(restore ? L("恢复好了") : L("写进去了"))}</div>`
      + `<dl class="kv"><dt>${esc(L("文件"))}</dt><dd>${esc(file)}</dd><dt>${esc(L("改之前"))}</dt><dd>${esc(short(result.before))}</dd><dt>${esc(L("改之后"))}</dt><dd>${esc(short(result.after))}</dd>`
      + `<dt>${esc(L("旧版存在"))}</dt><dd>${esc(L("历史版本 {0}", result.backup.id))}</dd></dl>`;
  } else if (result.conflict) {
    body = `<div class="state-big bad">${esc(L("没写：文件被改过了"))}</div><div class="flash bad">${esc(result.why)}</div>`
      + (text ? `<p class="note">${esc(L("你刚才改的那一版在下面，原样留着，可以复制出来再贴回去："))}</p><textarea class="ta" readonly>${taBody(text)}</textarea>` : "");
  } else {
    body = `<div class="state-big ${result.unchanged ? "warn" : "bad"}">${esc(result.unchanged ? L("没有改动") : L("没写"))}</div><div class="flash ${result.unchanged ? "warn" : "bad"}">${esc(result.why)}</div>`;
  }
  const content = viewHead("THE SCRIPTORIUM · " + L("改文件"), `${name} · ${file.split("/").pop()}`, esc(file), false)
    + (result.ok ? effectBar(ch) : "")
    + `<section class="panel pad confirm">${body}<div class="formrow">`
    + `<a class="btn primary" href="/c/${enc(ch.id)}/files/edit?f=${enc(file)}">${esc(result.conflict ? L("重新打开（看最新的）") : L("再打开"))}</a>`
    + `<a class="btn" href="/c/${enc(ch.id)}/files/history?f=${enc(file)}">${I.history}${esc(L("历史版本"))}</a><a class="btn" href="/c/${enc(ch.id)}/files">${esc(L("回到文件列表"))}</a></div></section>`;
  return actShell(ch, { title: L("{0} · 改文件", ch.id), crumb: L("{0} · 改文件", name), active: "files:" + ch.id, nav, now, gem, content });
}

const REASON_CN = { save: "保存前的旧版", restore: "恢复前的旧版" };
function historyPage(ch, { gem, now, nav, file = "", rows = [] } = {}) {
  const name = ch.displayName || ch.id;
  const list = rows.length ? `<div class="files">${rows.map((r) => `<div class="fr"><div class="fn"><b>${esc(fmtTime(Date.parse(r.at)))} · ${esc(T(REASON_CN, r.reason))}</b>`
    + `<small>${esc(r.path)}</small><small>${esc(L("{0} 字节 · 指纹 {1}", r.bytes, short(r.sha256)))}</small></div>`
    + `<div class="go"><a class="btn" href="/c/${enc(ch.id)}/files/backup?b=${enc(r.id)}">${esc(L("查看 / 恢复"))}</a></div></div>`).join("")}</div>`
    : `<div class="empty"><span class="em">✧</span><b>${esc(L("还没有历史版本"))}</b><p>${esc(L("每次在面板上保存或恢复之前，旧版都会先存一份到这里。"))}</p></div>`;
  const content = viewHead("THE ARCHIVE · " + L("历史版本"), L("{0} · 历史版本", name), file ? esc(file) : esc(L("这位所有文件的旧版（新的在上）")), false)
    + `<section class="panel pad">${list}<div class="formrow">${file ? `<a class="btn primary" href="/c/${enc(ch.id)}/files/edit?f=${enc(file)}">${esc(L("打开现在的"))}</a>` : ""}<a class="btn" href="/c/${enc(ch.id)}/files">${esc(L("回到文件列表"))}</a></div>`
    + `<p class="note">${esc(L("只留每个文件最近的若干份（PANEL_BACKUP_KEEP，默认 20），存在面板自己的状态目录里。"))}</p></section>`;
  return actShell(ch, { title: L("{0} · 历史版本", ch.id), crumb: L("{0} · 历史版本", name), active: "files:" + ch.id, nav, now, gem, content });
}

function backupPage(ch, { gem, now, nav, csrf, backup, currentSha = "", lines = [], stat = { add: 0, del: 0 }, why = "" } = {}) {
  const name = ch.displayName || ch.id;
  const same = currentSha && currentSha === backup.sha256;
  const content = viewHead("THE ARCHIVE · " + L("历史版本"), L("{0} · {1} 那一版", name, fmtTime(Date.parse(backup.at))), esc(backup.path), false)
    + `<section class="panel pad"><dl class="kv"><dt>${esc(L("存下的时间"))}</dt><dd>${esc(fmtTime(Date.parse(backup.at)))}</dd><dt>${esc(L("为什么存"))}</dt><dd>${esc(T(REASON_CN, backup.reason))}</dd>`
    + `<dt>${esc(L("指纹"))}</dt><dd>${esc(short(backup.sha256))}${esc(L("（现在的文件 {0}）", short(currentSha)))}</dd></dl>`
    + `<details class="more"><summary>${esc(L("那一版的全文"))}</summary><div class="inner"><textarea class="ta" readonly>${taBody(backup.text)}</textarea></div></details></section>`
    + (why ? `<div class="flash bad" style="margin-top:16px">${esc(L("恢复不了：{0}", why))}</div>`
      : same ? `<div class="flash ok" style="margin-top:16px">${esc(L("现在的文件跟这一版一模一样，不用恢复。"))}</div>`
        : `<div class="sh"><h2>${esc(L("恢复的话会改成这样"))}</h2><span class="aside">${esc(L("现在的文件 → 那一版"))}</span></div>`
        + `<section class="panel pad"><div class="dsum"><span class="up">+${stat.add}</span><span>${esc(L("行加上"))}</span><span class="down">−${stat.del}</span><span>${esc(L("行去掉"))}</span></div>${diffBlock(lines)}`
        + `<form method="post" action="/c/${enc(ch.id)}/files/restore">${hidden("csrf", csrf)}${hidden("f", backup.path)}${hidden("b", backup.id)}${hidden("base", currentSha)}`
        + `<div class="formrow"><button class="btn primary" type="submit">${I.history}${esc(L("确认恢复这一版"))}</button><a class="btn" href="/c/${enc(ch.id)}/files/history?f=${enc(backup.path)}">${esc(L("回到历史版本"))}</a></div>`
        + `<p class="note">${esc(L("恢复也走同一套：核对现在的版本（{0}）没被改过、先把现在的存一份、再整份换掉。", short(currentSha)))}</p></form></section>`)
    + effectBar(ch);
  return actShell(ch, { title: L("{0} · 历史版本", ch.id), crumb: L("{0} · 历史版本", name), active: "files:" + ch.id, nav, now, gem, content });
}

const ACTION_CN = { rotate: "按了换舱", "rotate.result": "换舱结果", save: "保存", restore: "恢复历史版本",
  "tail.exclude": "挑暖尾巴", "tail.used": "换舱用掉排除名单" };
const RESULT_CN = { ok: "成功", conflict: "冲突，没写", refused: "拒绝", failed: "失败", queued: "在排队", running: "正在换", done: "换好了", error: "出错", unchanged: "没有改动" };
function auditBlock(rows, { title = L("最近的操作"), more = false, names = {} } = {}) {
  const body = rows.length ? `<table class="audit"><tr><th>${esc(L("时间"))}</th><th>${esc(L("谁"))}</th><th>${esc(L("做了什么"))}</th><th>${esc(L("文件 / 说明"))}</th><th>${esc(L("前 → 后"))}</th><th>${esc(L("结果"))}</th></tr>${rows.map((r) => `<tr>`
    + `<td>${esc(fmtTime(Date.parse(r.at)))}</td><td>${esc(names[r.role] || r.role)}</td><td>${esc(T(ACTION_CN, r.action))}</td>`
    + `<td class="m">${esc(r.file || r.detail || "")}</td><td class="m">${r.before || r.after ? `${esc(short(r.before))} → ${esc(short(r.after))}` : "—"}</td>`
    + `<td>${esc(r.result ? T(RESULT_CN, r.result) : "")}</td></tr>`).join("")}</table>`
    : `<div class="empty"><b>${esc(L("还没有记录"))}</b><p>${esc(L("换舱、保存、恢复，每一次都会记一行。"))}</p></div>`;
  return `<div class="sh"><h2>${esc(title)}</h2>${more ? `<a class="more-link aside" href="/audit">${esc(L("全部操作记录"))} ${I.arrow}</a>` : `<span class="aside">${esc(L("新的在上"))}</span>`}</div><section class="panel pad">${body}</section>`;
}
function auditPage({ now, nav, rows = [], names = {} } = {}) {
  const content = viewHead("THE LEDGER · " + L("操作记录"), L("面板上动过的手"), esc(L("每一次换舱、保存、恢复都记一行：时间、哪一位、做了什么、哪个文件、改之前和改之后的指纹。只追加，不改不删。")), true)
    + auditBlock(rows, { title: L("最近 {0} 条", rows.length), names });
  return shell({ title: L("操作记录"), crumb: L("操作记录"), active: "audit", nav, now, content });
}

/** 拒绝（没登录之外的：令牌不对、方法不对、文件不让改）。 */
const refusedPage = (title, why) => gatePage(title, [why], { form: `<p><a class="btn" href="/">${esc(L("回到总览"))}</a></p>` });

// ——— 整舱拼好的全文（2026-10-22）———
const WHO = { user: "她", assistant: "他" };
const ENGINE_CN = { claude: "Claude", codex: "Codex", deepseek: "DeepSeek" };
const PERSONA_MODE_CN = { bridge: "桥交人格文件", "skip-identical": "工作目录里有同内容的一份，引擎自己读，桥不重复交",
  "bridge+engine-dup": "桥交人格文件，引擎还会自己读工作目录里另一份（两份不一样）", "engine-legacy": "人格文件读不到，退回引擎自己读旧文件",
  "bridge-legacy": "人格文件读不到，桥读旧文件交进去", unconfigured: "没配人格文件", missing: "找不到人格（开不了舱）" };
const TAIL_SRC_CN = { cold: "冷层", history: "全本" };
/** 整舱预演每段的标题 / 说明是子进程（base-child.js）给的中文：认得的过 L，认不得的原样。 */
const SEG_TITLES = new Set(["系统提示", "人格", "人格（引擎自己读）", "身份底座", "底子"]);
const SEG_NOTES = new Set(["盒子交给引擎的系统提示（GATE_SYSTEM_PROMPT_FILE）。", "桥已经交了人格文件，引擎还会自己从工作目录再读这一份（两份内容不一样，他会同时看到）。",
  "桥这次不交人格，引擎开舱时自己从工作目录读这份。", "codex 把它接在开发者指令最后（engines.js joinInstructions）。", "forge 把它写成新舱里的第一条（她那一侧的）消息。"]);
const segTitle = (t) => (SEG_TITLES.has(t) ? L(t) : t);
function segNote(n) {
  if (SEG_NOTES.has(n)) return L(n);
  if (n === "开新 thread 时经 thread/inject_items 当第一条（她那一侧的）消息垫进去，在暖尾巴前面。") return L(n);
  if (n === "开新 thread 时经 thread/inject_items 当第一条（她那一侧的）消息垫进去，在暖尾巴前面。身份底座已经在开发者指令里，底子里那一段拿掉了（不让他看见两份）。") return L("开新 thread 时经 thread/inject_items 当第一条（她那一侧的）消息垫进去，在暖尾巴前面。") + L("身份底座已经在开发者指令里，底子里那一段拿掉了（不让他看见两份）。");
  const m = /^桥交给引擎的人格（(.*)），接在系统提示后面。$/.exec(String(n));
  return m ? L("桥交给引擎的人格（{0}），接在系统提示后面。", m[1]) : n;
}

function assembledPage(ch, { gem, now, nav, a } = {}) {
  const name = ch.displayName || ch.id;
  const parts = [viewHead("THE WHOLE VOLUME · " + L("整舱预演"), L("{0} · 下次开舱读到的全文", name),
    esc(L("按开新舱时真实的顺序拼成一整篇：系统提示 → 人格 → 底子 → 暖尾巴，然后才是她的下一句。每一段都是换舱那几处真正在用的代码当场算的。")), true)];
  if (!a || !a.ok) {
    parts.push(`<div class="err">${esc(L("拼不出来：{0}", (a && a.error) || L("子进程没有结果")))}</div>`);
    return actShell(ch, { title: L("{0} · 整舱预演", ch.id), crumb: L("{0} · 整舱预演", name), active: "base:" + ch.id, nav, now, gem, content: parts.join("") });
  }
  const tail = a.tail || {};
  const ex = (a.exclude && a.exclude.entries) || [];
  parts.push(`<div class="asm-sum">`
    + `<span class="tl"><b>${a.totalChars.toLocaleString()}</b><small>${esc(L("总字数"))}</small></span>`
    + `<span class="tl"><b>≈ ${wan(a.tokens)}</b><small>${esc(L("估算 token（字节 ÷ 2，跟 forge 裁尾巴同一个算法）"))}</small></span>`
    + `<span class="tl"><b>${esc(T(ENGINE_CN, a.engine))}</b><small>${esc(L("引擎"))}</small></span>`
    + `<span class="tl"><b>${(tail.items || []).length}</b><small>${esc(tail.source ? L("条暖尾巴（料源：{0}）", T(TAIL_SRC_CN, tail.source)) : L("条暖尾巴"))}</small></span></div>`);
  const notes = [];
  if (!a.forge.on) notes.push(esc(L("forge 关着（{0}）：新舱不垫底子、也不垫暖尾巴。", a.forge.from)));
  if (a.engine === "codex") notes.push(esc(L("Codex 的换舱（/new）：底子作为第一条消息经 thread/inject_items 垫进新 thread，然后才是暖尾巴；身份底座接在开发者指令最后，已经在那里的话底子里不再重复。")));
  if (ex.length) notes.push(esc(L("排除名单里有 {0} 条（你在「暖尾巴挑选」里勾掉的），下面已经按排除之后的样子拼。", ex.length)));
  if (tail.reconcile && !tail.reconcile.ok) notes.push(esc(L("全本跟冷层对不上（{0}），这次垫的是冷层。", tail.reconcile.reason)));
  if (tail.cap && tail.cap.droppedTurns) notes.push(esc(L("暖尾巴超上限，最旧的 {0} 轮装不下。", tail.cap.droppedTurns)));
  for (const w of (a.persona && a.persona.warnings) || []) notes.push(esc(w));
  notes.push(esc(L("引擎自己还会加它的工具说明等（Claude Code / Codex 内部的东西），面板看不到原文，没算进字数。")));
  parts.push(`<p class="note" style="margin:14px 0 0">${notes.join("<br>")}</p>`);
  const where = { system: "开舱 · 系统提示", persona: "开舱 · 系统提示（接在后面）", "persona-engine": "开舱 · 引擎自己从工作目录读",
    identity: "开舱 · 开发者指令最后", base: "新舱第一条（她那一侧）" };
  const seg = (x, i) => `<details${i < 2 ? "" : ""}><summary><span><b><span class="tag-s">${ROMAN[i] || i + 1}</span>${esc(segTitle(x.title))}</b>`
    + `<span class="src">${esc(where[x.key] ? L(where[x.key]) : "")}${x.source ? " · " + esc(x.source) : ""}</span></span><span class="n">${esc(L("{0} 字", x.chars.toLocaleString()))}</span></summary>`
    + `${x.note ? `<p class="note" style="margin:0;padding:8px 16px 0">${esc(segNote(x.note))}</p>` : ""}<pre class="seg">${esc(x.text)}</pre></details>`;
  const items = tail.items || [];
  const tailChars = items.reduce((n, t) => n + String(t.text || "").length, 0);
  const tailSeg = `<details open><summary><span><b><span class="tag-s">${ROMAN[a.sections.length] || a.sections.length + 1}</span>${esc(L("暖尾巴"))}</b>`
    + `<span class="src">${esc(L("新舱里接在后面的真实对话 · 料源 {0}", tail.source ? T(TAIL_SRC_CN, tail.source) : "—"))}</span></span><span class="n">${esc(L("{0} 条 · {1} 字", items.length, tailChars.toLocaleString()))}</span></summary>`
    + (items.length ? items.map((t) => `<div class="turn"><div class="who"><b>${esc(T(WHO, t.role))}</b> · ${esc(fmtTime(Date.parse(t.timestamp || "")))}</div><pre>${esc(t.text)}</pre></div>`).join("")
      : `<p class="note" style="padding:8px 16px">${esc(L("这次没有暖尾巴。"))}</p>`)
    + `<div class="formrow" style="padding:0 16px 14px"><a class="btn" href="/c/${enc(ch.id)}/tail">${esc(L("挑哪几轮不带"))} ${I.arrow}</a></div></details>`;
  parts.push(`<div class="asm">${a.sections.map(seg).join("")}${tailSeg}`
    + `<details><summary><span><b><span class="tag-s">✦</span>${esc(L("她的下一句"))}</b><span class="src">${esc(L("换舱之后她发的第一条，接在最后"))}</span></span><span class="n">—</span></summary></details></div>`);
  parts.push(`<div class="formrow"><a class="btn rot" href="/c/${enc(ch.id)}/rotate">${I.rotate}${esc(L("现在换舱"))}</a><a class="btn" href="/c/${enc(ch.id)}/base">${esc(L("分段看这一舱"))}</a></div>`);
  return actShell(ch, { title: L("{0} · 整舱预演", ch.id), crumb: L("{0} · 整舱预演", name), active: "base:" + ch.id, nav, now, gem, content: parts.join("") });
}

function tailPage(ch, { gem, now, nav, csrf, a, turns = [], saved = "" } = {}) {
  const name = ch.displayName || ch.id;
  const parts = [viewHead("THE WARM TAIL · " + L("暖尾巴"), L("{0} · 下次换舱带哪几轮", name),
    esc(L("换舱时会把最近的真实对话垫进新舱。勾着的会带进去；取消勾选的这次不带。只对下一次换舱有效，用掉之后名单自动清空。冷层原文一个字都不动。")), true)];
  if (saved) parts.push(`<div class="flash ok" style="margin-bottom:14px">${esc(L("记下了。下次换舱按这个来；整舱预演已经变了。"))}</div>`);
  if (!a || !a.ok) {
    parts.push(`<div class="err">${esc(L("算不出尾巴：{0}", (a && a.error) || L("子进程没有结果")))}</div>`);
    return actShell(ch, { title: L("{0} · 暖尾巴", ch.id), crumb: L("{0} · 暖尾巴", name), active: "base:" + ch.id, nav, now, gem, content: parts.join("") });
  }
  if (!a.forge.on) parts.push(`<div class="flash warn" style="margin-bottom:14px">${esc(L("forge 关着（{0}）：换舱不垫暖尾巴，这里的勾选不起作用。", a.forge.from))}</div>`);
  const off = turns.filter((t) => t.excluded).length;
  const rows = turns.slice().reverse().map((t) => {
    const head = t.items[0];
    const first = String(head.rawText || head.text || "");
    const pv = first.length > 60 ? first.slice(0, 60) + "…" : first;
    const whoLine = t.orphan ? L("接着上一轮（他）") : L("她 → 他 {0} 段", t.items.length - 1);
    const flag = t.excluded ? " · " + L("这次不带") : t.dropped ? " · " + L("超上限，这次本来就装不下") : "";
    return `<div class="tt${t.excluded ? " off" : ""}${t.dropped ? " drop" : ""}">`
      + `<input type="hidden" name="shown" value="${esc(t.key)}"><input type="checkbox" name="keep" value="${esc(t.key)}" id="k-${esc(t.key)}"${t.excluded ? "" : " checked"} aria-label="${esc(L("带进新舱"))}">`
      + `<label for="k-${esc(t.key)}"><div class="meta"><b>${esc(fmtTime(t.at))}</b> · ${esc(whoLine)}${esc(flag)}</div><div class="pv">${esc(pv) || esc(L("（空）"))}</div></label>`
      + `<details><summary>${esc(L("展开全文 ›"))}</summary>${t.items.map((it) => `<pre><b>${esc(T(WHO, it.role))}</b> · ${esc(fmtTime(Date.parse(it.timestamp || "")))}\n${esc(it.rawText || it.text)}</pre>`).join("")}</details></div>`;
  }).join("");
  parts.push(`<section class="panel pad"><div class="ph"><div><h3 class="pt">${esc(L("候选 {0} 轮 · 这次不带 {1} 轮", turns.length, off))}</h3><div class="ps">${esc(L("新的在上 · 料源 {0}", a.tail.candidateSource ? T(TAIL_SRC_CN, a.tail.candidateSource) : "—"))}</div></div>`
    + `<a class="more-link" href="/c/${enc(ch.id)}/assembled">${esc(L("看整舱拼好的样子"))} ${I.arrow}</a></div>`
    + (turns.length ? `<form method="post" action="/c/${enc(ch.id)}/tail">${hidden("csrf", csrf)}${hidden("ver", a.exclude.updatedAt || "")}<div class="tails">${rows}</div>`
      + `<div class="formrow"><button class="btn primary" type="submit">${esc(L("保存勾选"))}</button><a class="btn" href="/c/${enc(ch.id)}/tail">${esc(L("不保存，重新看"))}</a></div>`
      + `<p class="note">${esc(L("存在 {0}（桥根里，换舱那一处会读它）。按对话记录的编号记，不按第几条记 —— 期间他又说了话也不会勾错。", a.exclude.file))}</p></form>`
      : `<div class="empty"><b>${esc(L("现在没有可垫的对话"))}</b></div>`)
    + `</section>`);
  const used = (a.exclude && a.exclude.used) || [];
  if (used.length) parts.push(`<div class="sh"><h2>${esc(L("之前用掉的名单"))}</h2><span class="aside">${esc(L("换舱用掉一次记一笔"))}</span></div><section class="panel pad"><table class="audit"><tr><th>${esc(L("时间"))}</th><th>${esc(L("用在哪"))}</th><th>${esc(L("排掉几条"))}</th><th>${esc(L("新舱"))}</th></tr>`
    + used.map((u) => `<tr><td>${esc(fmtTime(Date.parse(u.at)))}</td><td>${esc(u.usedBy)}</td><td>${esc(u.count)}</td><td class="m">${esc(String(u.threadId || "").slice(0, 8))}</td></tr>`).join("") + `</table></section>`);
  return actShell(ch, { title: L("{0} · 暖尾巴", ch.id), crumb: L("{0} · 暖尾巴", name), active: "base:" + ch.id, nav, now, gem, content: parts.join("") });
}

// ——— 他写的东西 ———
function fmtSize(n) {
  if (n < 1024) return L("{0} 字节", n);
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}
function writingsPage(ch, { gem, now, nav, w } = {}) {
  const name = ch.displayName || ch.id;
  const parts = [viewHead("THE SCRIPTORIUM · " + L("他写的东西"), L("{0} · 他写的东西", name),
    esc(L("他自己目录里的文字文件（笔记本、日记、备忘、执行规则……），新改的在前。规矩跟改文件一样：先看改动、他改过就不写、写前存旧版。")), true)];
  parts.push(effectBar(ch));
  const groups = new Map();
  for (const r of w.rows) { if (!groups.has(r.dir)) groups.set(r.dir, []); groups.get(r.dir).push(r); }
  const list = [...groups.entries()].sort((x, y) => y[1][0].mtimeMs - x[1][0].mtimeMs);
  const row = (r) => `<div class="fr${r.editable ? "" : " no"}${r.foreign.length ? " x" : ""}"><div class="fn"><b>${esc(r.name)}${r.symlink ? ` <span class="sec-k">${esc(L("软链接"))}</span>` : ""}</b>`
    + `<small>${esc(fmtSize(r.size))} · ${esc(L("{0} 改的", fmtTime(r.mtimeMs)))}</small>${r.editable ? "" : `<div class="why">${esc(r.why)}</div>`}</div>`
    + (r.editable ? `<div class="go"><a class="btn primary" href="/c/${enc(ch.id)}/files/edit?f=${enc(r.path)}">${I.quill}${esc(L("打开"))}</a><a class="btn" href="/c/${enc(ch.id)}/files/history?f=${enc(r.path)}">${I.history}${esc(L("历史"))}</a></div>` : "") + `</div>`;
  parts.push(`<section class="panel pad"><div class="ph"><div><h3 class="pt">${esc(L("{0} 个文件 · {1} 个目录", w.rows.length, list.length))}</h3><div class="ps">HIS OWN HAND · ${esc(L("点目录展开"))}</div></div></div>`
    + (list.length ? list.map(([dir, rs], i) => `<details class="wgrp"${i < 3 ? " open" : ""}><summary><b>${esc(dir)}</b><small>${esc(L("{0} 个 · 最近 {1}", rs.length, fmtTime(rs[0].mtimeMs)))}</small></summary>${rs.map(row).join("")}</details>`).join("")
      : `<div class="empty"><b>${esc(L("没找到他写的文字文件"))}</b></div>`)
    + (w.truncated ? `<p class="note">${esc(L("文件太多，只列了最近的一部分。"))}</p>` : "")
    + `<p class="note">${esc(L("找的目录：{0}。桥根整个不列（那是桥的运行账本）；凭据类不列；依赖、浏览器配置、媒体收发件箱这些目录不进。", w.roots.join(L("、")) || L("（没有）")))}</p></section>`);
  return actShell(ch, { title: L("{0} · 他写的东西", ch.id), crumb: L("{0} · 他写的东西", name), active: "files:" + ch.id, nav, now, gem, content: parts.join("") });
}

module.exports = { codeLoginPage, assembledPage, tailPage, writingsPage, homePage, basePage, failuresPage, unauthorizedPage, loginPage, linkDeadPage, notFoundPage, fmtTime, fmtDur, esc, GEMS,
  rotateConfirmPage, rotateResultPage, filesPage, editPage, diffPage, writeResultPage, historyPage, backupPage, auditPage, refusedPage };
