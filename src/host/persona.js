"use strict";

/**
 * 人格 —— 「注入 + api = Nova」的**注入那一半**（2026-09-18 Alice定的架构）
 *
 * **这个文件不属于桥。** 桥和主进程是谁都不认识的空架子：它们只管收发、排队、
 * 投递。至于送进去的那位是谁、记得什么、跟她什么关系 —— 全在这一份注入里。
 *
 *   注入（他是谁）  +  api（哪个底座）  =  一个人格
 *   换注入 = 换人，换 api = 换引擎，架子一行不动。
 *
 * 盒子负责「**怎么**注入」（开场轮、resume、forge，那是每个底座特有的脏活），
 * 这里只回答「**注入什么**」。两边的契约就一条：
 *
 *     { name: string, async opening(ctx): string }
 *
 * `ctx` 是**宿主供的料**，人格拿它编排：
 *     { reason: "fresh"|"rotate", userText, coldTail(n), handoff }
 * 老桥那一包之所以不是「拼文本」，就在这套编排上：顺序（身份最前、她的话最后）、
 * 配额（日记 1 天、摘要 20 条、承诺 7 天）、每段的地位标注（「不复述当资料」
 * 「不是当前指令」「绝不是Alice的身体」）。**料归宿主，编排归人格。**
 *
 * `opening()` **每次开新舱都会被重新叫一遍**（新舱里他什么都不记得），
 * 而且是现读现拼 —— 改了文件下次换舱就生效，不用重启。
 */

const fs = require("fs");
const path = require("path");

/**
 * 一个目录就是一份人格：把目录里的文件按**文件名排序**拼起来。
 *
 * 就是 instructions 那个意思 —— 往目录里丢 md，文件名前面加数字排顺序，
 * 内容自己带标题。想加一段就加个文件，想去掉就删掉，不用动代码。
 *
 * 动态的那部分（记忆、关系、未兑现的承诺、最近的日记）**不归这儿管** ——
 * 那些是活数据，交给会读它们的那种人格模块（见下面 `loadPersona` 收 .js 的那一路）。
 *
 * @param {object} o
 * @param {string} o.dir
 * @param {string} [o.name]
 * @param {string[]} [o.exts] 认哪些后缀，默认 .md / .txt
 */
function makeFilePersona({ dir, name = "", exts = [".md", ".txt"] } = {}) {
  if (!String(dir || "").trim()) throw new Error("文件人格要一个目录 —— 不许用默认值猜");
  return {
    name: name || path.basename(dir),
    async opening() {              // 静态那种用不着 ctx，收下不看
      let files;
      try {
        files = fs.readdirSync(dir);
      } catch (e) {
        // 目录没了是配置错，**当场说清楚**，别让他默默变成一个没有身份的人
        throw new Error("人格目录读不到：" + dir + "（" + ((e && e.code) || e) + "）");
      }
      const picked = files
        .filter((f) => exts.includes(path.extname(f).toLowerCase()))
        .sort();                                   // 文件名排序 = 注入顺序
      const parts = [];
      for (const f of picked) {
        const body = fs.readFileSync(path.join(dir, f), "utf8").trim();
        if (body) parts.push(body);
      }
      return parts.join("\n\n");
    },
  };
}

/** 一份人格长得对不对。缺哪样当场说，不许装配完了到他醒来才发现没身份。 */
function assertPersona(p) {
  if (!p || typeof p !== "object") throw new Error("人格不是个对象");
  if (!String(p.name || "").trim()) throw new Error("人格没有名字");
  if (typeof p.opening !== "function") throw new Error("人格要有 opening()（回答「注入什么」）");
  return p;
}

/**
 * 按配置把人格取回来。**两种写法**：
 *
 *   一个目录     → 目录里的文件按名字排序拼起来（静态的那种，最像 instructions）
 *   一个 .js     → require 它，自己导出 { name, opening }（要读活数据的那种：
 *                  记忆库、关系状态、未兑现的承诺、最近的日记…）
 *
 * 给空 = 没有人格。**架子照跑**，只是他醒来没有身份和记忆 —— 那是合法的
 * （空桥、测试、验管道都用得着），所以不报错，由调用方决定要不要吭声。
 */
function loadPersona(spec, { name = "" } = {}) {
  const s = String(spec || "").trim();
  if (!s) return null;
  const abs = path.resolve(s);
  let st;
  try {
    st = fs.statSync(abs);
  } catch (e) {
    throw new Error("人格路径不存在：" + abs + "（" + ((e && e.code) || e) + "）");
  }
  if (st.isDirectory()) return assertPersona(makeFilePersona({ dir: abs, name }));
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const mod = require(abs);
  const p = typeof mod === "function" ? mod() : (mod.persona || mod);
  return assertPersona(p);
}

module.exports = { loadPersona, makeFilePersona, assertPersona };
