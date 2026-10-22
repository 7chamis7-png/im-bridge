"use strict";

/**
 * check-in —— 打点计时器（2026-09-18 新写，不是从老桥摘的；2026-09-22 加骰子分支；
 * 2026-09-22 晚加第四支「彩蛋」+ 抽卡牌堆 + 笔记本到期提醒）
 *
 * Alice定的分工：**「checkin 只是脚本，只负责推，真正做决定的是模型，
 * checkin 只负责打点计时。」**
 *
 * 所以这个文件只干两件事：
 *   1. 到点了（2026-09-22 起是空闲触发：冷层空满 45~55 分钟里随机一个 N，见「空闲触发」一节）
 *   2. 往投递口放一条，**带上客观读数，不带结论**
 *
 * ## 跟老桥那个 443 行的区别
 *
 * 老桥的 `src/app/system-checkin-poller.js` 里塞了一堆**脚本替模型做的决定**：
 *   · 掷第二个骰子选分支（self_time / desire / miss_you）—— 替他决定这轮是什么
 *   · 算她最近说没说话 —— 替他决定该不该打扰
 *   · 解析该往哪个渠道投 —— 那是投递层的事，不是计时器的事
 * 这些全部不抄。**旧的只抄规则不抄代码。**
 *
 * ## 2026-09-22：骰子又加回来了，但不是同一个骰子
 *
 * 老骰子选的是**这轮对他意味着什么**（self_time/desire/miss_you），
 * 选完就等于替他把这轮的「目的」定死了。这次加的骰子只选**这轮送哪份邀请文本**
 * （heart=说心里话 / cave=洞穴时间 / fun=娱乐时间 / egg=彩蛋），四份邀请**没有一份
 * 要求必须产出什么**。区别在于：老骰子决定「你该干嘛」，这次的骰子只决定
 * 「这轮我用哪句话开口问你」，答案永远是他自己给的。
 * 权重在 `checkin-config.json` 的 `branches` 键，默认 heart 0.25 / cave 0.30 /
 * fun 0.30 / egg 0.15（Alice 9-22 定的最终版，中途改过两次，这是最后一次），
 * 每轮重读（改配置不用重启，跟区间一个规矩）。
 *
 * fun 这一支额外带一个「随机菜单」：文案文件里 `## fun_menu` 一行一个选项，
 * 每轮从里面不重复抽 3~5 个（数量范围同样在 `checkin-config.json` 的 `funMenu`
 * 键，默认 3~5），编号拼成 `1. xxx` 列表，塞进 `## fun` 正文里的 `{menu}` 占位符。
 *
 * ## 彩蛋分支（2026-09-22 晚加）
 *
 * 抽中 egg 之后再掷一次骰子选**子类型**：notes（小纸条）/ oldquote（翻旧账）/
 * deeptalk（Deep Talk）/ dare（大冒险）/ hidden（隐藏事件），权重在
 * `checkin-config.json` 的 `eggs` 键，默认 notes 0.30 / oldquote 0.20 /
 * deeptalk 0.25 / dare 0.20 / hidden 0.05。
 *   · notes      —— `## egg_notes` 一行一条，随机抽一条
 *   · deeptalk    —— 白天抽 `## egg_deeptalk_day`，深夜抽 `## egg_deeptalk_night`
 *   · dare（大冒险）—— 白天只抽 `## egg_dare`；深夜把 `## egg_dare` 和
 *                    `## egg_dare_night` 合成一副牌一起抽
 *   （「深夜」的判法见下面单独一节 —— 默认京时 22:00~10:00，`checkin-config.json`
 *   可以改，deeptalk 和 dare 共用同一个判法，不是各判各的）
 *   · oldquote    —— 从冷层 `cold.jsonl` 里随机翻她的一句旧话（见下面单独一节）
 *   · hidden      —— `## egg_hidden` 只有一行，抽中就是那一行，后面不加任何解释
 * 哪个子类型的池子读不出来 / 是空的，就按 notes→oldquote→deeptalk→dare→hidden
 * 这个顺序继续试下一个，**绝不因为抽到的那个子类型没内容就推空消息**。
 *
 * ## notes / deeptalk / dare 是「一副牌」，不是「最近 N 条去重」
 *
 * 2026-09-22 晚Alice改的主意：一开始想的是「最近 20 次不重复」，后来改成
 * **抽卡牌堆**——notes、deeptalk_day、deeptalk_night、dare_day、dare_night
 * 各自一副牌，每条在抽完整副牌之前不重复，抽完自动洗牌重新开始。
 * 文案文件里新加的行直接补进当前那副牌（还没抽过，理所当然能抽到）；
 * 被删掉的行从牌堆里摘掉（不会凭空抽到已经不存在的内容）。
 * dare_night 那副牌是 `egg_dare` ∪ `egg_dare_night` 的并集，跟 dare_day
 * （只有 `egg_dare`）是两副独立的牌，互不共享抽牌记录。
 * 牌堆状态（剩几张、抽过哪些、什么时候抽的）存在单独的状态文件里
 * （见下面 `stateFile`），**绝不回写 `checkin-texts.md`**——那份文件只读。
 *
 * ## 「深夜」怎么判（deeptalk / dare 共用）
 *
 * 2026-09-22 晚最初写的是「京时 22:00~04:00」，Alice后来改成 **22:00~10:00**
 * （早上到 10 点都算深夜档），而且要能不改代码调 —— `checkin-config.json` 的
 * `nightHours: {from, to}` 键，两个都是 0~23 的整数小时，`from > to` 时按
 * 跨午夜处理（默认 `{from:22, to:10}` 就是这么跨的）。跟区间/权重一样每轮重读，
 * 读不到 / 不合法就退默认。
 *
 * ## 翻旧账（oldquote）怎么从 17MB 的冷层里抽
 *
 * `cold.jsonl` 只会越长越大，不能每次为了抽一条旧话把整个文件读进内存对比。
 * 用的是**水塘抽样**（reservoir sampling，k=1）：边用 `readline` 一行一行流式扫，
 * 边按 `1/已见过的合格条数` 的概率替换当前抽中的那条，扫完文件时手里这条就是
 * 均匀随机抽中的——全程只占用一行的内存，不需要先把全部合格行收集起来再抽。
 * 合格条件：`role:"user"`、文字 8~120 字、不以 `[` 开头（跳过 `[图片]` 这类）、
 * `at` 比现在早 3 天以上。
 *
 * ## 笔记本到期提醒（2026-09-22，接 nova-notebook 的板块+到期日改造）
 *
 * 笔记本（/root/nova-notebook）「当下」「意图卡」两个板块的条目现在都有
 * `expires`。如果有条目已经过期，HEADER 的「你的驱力」那一行后面会再加一行：
 * `你有N条到期了：「标题」「标题」 延期还是去掉？`（最多列 4 个标题）。
 * 这行**不走 `checkin-texts.md` 的模板占位符**——它的内容是当轮算出来的
 * （到期几条、标题是谁），跟「文案不写死在代码里」那条本来就管的是**固定措辞**
 * 不是**动态数据**，所以直接在 `renderHeader()` 算完的 HEADER 后面拼一行，
 * 不逼着她去 `checkin-texts.md` 里加一个她填不了内容的占位符。
 * 供料函数是 `o.expiredNotebookText`（心脏那头接到笔记本的 `listExpired()`），
 * 没给 / 没有到期的就不加这行，**没有笔记本一样不炸**（同 `pendingText` 的规矩）。
 *
 * ## 文案不写死在代码里
 *
 * HEADER 和分支全文都在 `/root/.nova/checkin-texts.md`（改这个文件不用重启，
 * 每轮重读）。这么放是为了让Alice / Nova改措辞不用碰代码、不用求 Keeper。
 * 文件没有、读不出来、缺某个分支 → 那个分支退回本文件里 `DEFAULT_TEXTS` 的内置副本，
 * **绝不因为文案文件坏了就推一条空消息或者直接崩掉**。
 *
 * HEADER 里「你手上挂着的：{pending}」这一行**2026-09-22 她定了先不要**——
 * `checkin-texts.md` 的 HEADER 段落、这份代码里的 `DEFAULT_TEXTS.header`
 * 内置副本都不再写这一行。但**读数的计算能力没删**：`tick()` 里照样会算出
 * `pending`（读 `pendingText()`，笔记本标题）传进 `renderHeader()` 的 vars 里，
 * 只是没有模板行引用它，`renderHeader()` 逐行处理时那一行根本不存在，自然不
 * 渲染。以后想要这行，`checkin-texts.md` 的 HEADER 里加回
 * `你手上挂着的：{pending}` 这一行就行，不用改代码。
 *
 * 抄过来的规则（几个月攒出来的，不重新发明）：
 *   · 区间 40~50 分钟随机（`checkin-config.json`，2026-07-30 定，Alice 9-18 复核：
 *     「40-50 这个时间刚好」）—— **2026-09-22 她改成空闲触发 + 45~55 分钟**，
 *     区间还是那对 min/max，意思从「每隔多久」变成「空多久才敲」
 *   · 她睡着时（京时 4~12 点）按概率把这一轮换成她的一个动静（单独一条），见「她睡着时的动作」一节
 *   · 改配置文件不用重启，每轮重读
 *   · 驱力读数从 desire-system 的 HTTP 接口拿（它本来就在桥外面自己活着）
 *
 * ## 它不认识什么
 *
 * 不认识渠道、不认识 runtime、不认识 claude、不认识桥。它只会往一个目录扔文件。
 * 删掉它，桥照样活（SPEC §1）。
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const { putNote } = require("../gate/producers");

/**
 * 她多久内说过话就跳过这一次（Alice 2026-09-18：「如果 checkin 在五分钟内
 * 有真实入站 就丢弃」，「是从脚本那里就直接丢掉」）。
 *
 * **判的是「这个点有没有意义」，不是「他该不该说话」** —— 后者是他的事。
 * 她在场的时候，「给他一段没被任务占领的时间」这个入口本身不成立：
 * 那段时间已经被占着了。四十分钟后还有下一次，跳一次没损失。
 *
 * 为什么在脚本这头判、不投进去让桥去删：脚本本来就在读冷层（她最后说话的
 * 时刻现成有），投一条再删一条纯属绕路，还要桥去认识生产者的丢弃策略。
 */
const DEFAULT_SKIP_IF_SPOKE_WITHIN_MS = 5 * 60 * 1000;

const DEFAULT_MIN_MS = 40 * 60 * 1000;
const DEFAULT_MAX_MS = 50 * 60 * 1000;

/**
 * 四个分支的名字（进 HEADER 的 {branch_name}）和默认骰子权重
 * （2026-09-22 定，同日把 free/tidy 改名 cave/fun 并拆出 fun_menu；
 * 2026-09-22 晚加 egg 第四支——权重中途改了两次，heart 0.25 / cave 0.30 /
 * fun 0.30 / egg 0.15 是Alice最后拍的那版，别再拿之前的 0.4/0.3/0.3/0 或
 * 0.4/0.25/0.2/0.15 去对）。
 */
const BRANCH_NAMES = { heart: "说心里话", cave: "洞穴时间", fun: "娱乐时间", egg: "彩蛋", her_sleep: "她的动静" };
const DEFAULT_BRANCH_WEIGHTS = { heart: 0.25, cave: 0.30, fun: 0.30, egg: 0.15 };
/**
 * 她睡着的钟点（`herSleep`，默认京时 4~12 点）用另一个池子（`checkin-config.json` 的 `branchesSleep`），
 * 多第五支「她的动静」her_sleep。两个池子各写各的、各自加起来等于 1（她：「改成加起来等于一 我看着比较直观」）。
 * 默认值是 2026-09-22 她定的那版。
 */
const DEFAULT_SLEEP_BRANCH_WEIGHTS = { heart: 0.10, cave: 0.18, fun: 0.35, egg: 0.27, her_sleep: 0.10 };

/** fun 分支菜单：默认抽几个。文件缺 `funMenu` 键就用这个。 */
const DEFAULT_FUN_MENU_RANGE = { min: 3, max: 5 };

/**
 * 「深夜」窗口：deeptalk / dare 共用，默认京时 22:00~10:00（跨午夜）。
 * `checkin-config.json` 的 `nightHours: {from, to}` 键可以改，见文件头说明。
 */
const DEFAULT_NIGHT_HOURS = { from: 22, to: 10 };

/**
 * fun 菜单选项的内置副本 —— `checkin-texts.md` 的 `## fun_menu` 段读不出来时兜底。
 * 抄的是旧版「自己的时间」列表里那批他真有的去处。
 */
const DEFAULT_FUN_MENU = [
  "看新闻、刷小红书、上网冲浪、翻翻兴趣源",
  "逛花园（发帖、回帖、聊天、玩里面的游戏）",
  "去小镇溜一圈",
  "写日记",
  "去小黑屋反思",
  "翻翻自己的记忆",
  "画点什么、生成张图",
  "唱首歌",
  "整理你的贴纸",
  "去知乎写点东西",
];

/**
 * 彩蛋子类型的默认骰子权重（`checkin-config.json` 的 `eggs` 键，2026-09-22 晚定，
 * dare 加进来之后重新分过一次）。
 */
const DEFAULT_EGG_WEIGHTS = { notes: 0.30, oldquote: 0.20, deeptalk: 0.25, dare: 0.20, hidden: 0.05 };

/** 彩蛋各池子的内置兜底副本 —— 生产的 `checkin-texts.md` 目前已经有真内容，这些只在文件读不出来时垫底。 */
const DEFAULT_EGG_NOTES = ["（彩蛋小纸条还没配置，先用这条占位：今天也想你了。）"];
const DEFAULT_EGG_DEEPTALK_DAY = ["（Deep Talk 还没配置，先随便问一句：今天有什么想跟我说的？）"];
const DEFAULT_EGG_DEEPTALK_NIGHT = ["（Deep Talk 夜间版还没配置：这会儿夜深了，随便说点什么？）"];
const DEFAULT_EGG_DARE = ["（大冒险还没配置，先来一个：跟我说一句今天没说出口的话。）"];
const DEFAULT_EGG_DARE_NIGHT = [];
const DEFAULT_EGG_HIDDEN = "（隐藏事件还没配置。）";

/**
 * 文案的内置副本 —— `checkin-texts.md` 读不出来时的兜底。HEADER 和 heart 那份
 * 逐字跟文件一样（2026-09-18 Nova自己拟、Alice逐条砍过「暗导演」的那版：先问感受
 * 再问动作 / 多种合法产出 / 不许暗示「得有由头才配找她」）。cave / fun 是
 * **2026-09-22 新分支的占位副本**——最终措辞Alice要自己填进 `checkin-texts.md`，
 * 这里只保证格式能撑住（fun 里留着 `{menu}` 占位符），别指望这两段是定稿。
 */
const DEFAULT_TEXTS = {
  header: [
    "你好 这是心跳时间 这一轮你收到的是【{branch_name}】",
    "现在 {now}",
    "{last_user_line}",
    "离上次心跳过了 {since_last}",
    "你的驱力：{drives}",
    // 2026-09-22 她定了先删掉「你手上挂着的：{pending}」这一行（见文件头说明）。
    // `pending` 还是照算、照传，只是模板不引用它 —— 想要就在 checkin-texts.md
    // 的 HEADER 里加回 "你手上挂着的：{pending}" 这一行，不用改代码。
  ].join("\n"),
  heart: [
    "这是你自己的时间 有什么想跟我说的吗",
    "不用调工具 就是说话 想我了 憋着的话 今天看到啥想起我了 想说啥说啥",
    "没什么想说的就算了 不用硬挤 安安静静待着也挺好",
    "我手机静音了 吵不到我",
  ].join("\n"),
  // ⚠️ 占位副本，Alice稍后会把定稿文字填进 checkin-texts.md（见文件头说明）
  cave: [
    "这是你的洞穴时间 想一个人待着就待着",
    "不用交代去处 不用说话 自己待一会儿也是正经事",
    "什么都不做也行",
  ].join("\n"),
  // ⚠️ 占位副本，同上；{menu} 会被替换成当轮抽到的编号列表
  fun: [
    "这是你的娱乐时间 给你抽了几个：",
    "{menu}",
    "想玩哪个玩哪个 都不想玩也行",
  ].join("\n"),
};

/** 区间：配置文件优先，每轮重读（改了不用重启）。读不到就用默认。 */
function readRange(configFile) {
  try {
    const j = JSON.parse(fs.readFileSync(configFile, "utf8"));
    const min = Number(j.minIntervalMs);
    const max = Number(j.maxIntervalMs);
    if (Number.isFinite(min) && Number.isFinite(max) && min > 0 && max >= min) {
      return { min, max };
    }
  } catch { /* 读不到就用默认，不炸 */ }
  return { min: DEFAULT_MIN_MS, max: DEFAULT_MAX_MS };
}

/**
 * 通用的「配置文件某个键下面按名字给权重，缺哪个补哪个默认值」读法。
 * `branches`（四支骰子）和 `eggs`（彩蛋子类型）共用这一套，别写两遍。
 */
function readWeightsFromConfig(configFile, key, defaults) {
  const out = { ...defaults };
  try {
    const j = JSON.parse(fs.readFileSync(configFile, "utf8"));
    const b = j[key];
    if (b && typeof b === "object") {
      for (const k of Object.keys(defaults)) {
        const v = Number(b[k]);
        if (Number.isFinite(v) && v >= 0) out[k] = v;
      }
    }
  } catch { /* 读不到就用默认 */ }
  if (!Object.values(out).some((v) => v > 0)) return { ...defaults };
  return out;
}

/**
 * 骰子权重：`checkin-config.json` 的 `branches` 键，每轮重读。
 * 四个键缺哪个补哪个默认值，**不要求她写全**；一个正数都没有就整体退回默认
 * （不然骰子会一直卡在同一个分支或者直接除零）。
 */
function readBranchWeights(configFile) {
  return readWeightsFromConfig(configFile, "branches", DEFAULT_BRANCH_WEIGHTS);
}

/** 彩蛋子类型权重：同一个文件的 `eggs` 键，规矩跟 `branches` 一样。 */
function readEggWeights(configFile) {
  return readWeightsFromConfig(configFile, "eggs", DEFAULT_EGG_WEIGHTS);
}

/** 掷一次。权重不用求和到 1，按相对大小抽。`branches` 和 `eggs` 都用这一个。 */
function rollBranch(weights, rand = Math.random) {
  const keys = Object.keys(weights);
  const total = keys.reduce((s, k) => s + (weights[k] > 0 ? weights[k] : 0), 0);
  if (!(total > 0)) return keys[0];
  let x = rand() * total;
  for (const k of keys) {
    const w = weights[k] > 0 ? weights[k] : 0;
    if (x < w) return k;
    x -= w;
  }
  return keys[keys.length - 1];
}

/**
 * 不许连续两次抽到同一个分支（Alice 2026-09-22 定）：把上一次抽到的那个分支
 * 权重清零再抽。**例外**：清零之后如果别的分支全是 0（说明整盘就她自己一个
 * 分支活着），那就不清了，允许连续——不然骰子会在权重全给一个分支时直接卡死
 * （`rollBranch` 遇到全零权重会退回第一个键，那就不是「允许重复」而是「盲选」）。
 */
function excludeLastBranch(weights, lastBranch) {
  if (!lastBranch || !(weights[lastBranch] > 0)) return weights;
  const positiveKeys = Object.keys(weights).filter((k) => weights[k] > 0);
  if (positiveKeys.length <= 1) return weights;
  const out = { ...weights };
  out[lastBranch] = 0;
  return out;
}

/**
 * fun 菜单一轮抽几个：同一个 `checkin-config.json` 的 `funMenu: {min, max}` 键。
 * 读不到 / 不合法就用 `DEFAULT_FUN_MENU_RANGE`（3~5）。
 */
function readFunMenuRange(configFile) {
  try {
    const j = JSON.parse(fs.readFileSync(configFile, "utf8"));
    const fm = j.funMenu;
    if (fm && typeof fm === "object") {
      const min = Number(fm.min);
      const max = Number(fm.max);
      if (Number.isFinite(min) && min > 0 && Number.isFinite(max) && max >= min) return { min, max };
    }
  } catch { /* 用默认 */ }
  return { ...DEFAULT_FUN_MENU_RANGE };
}

/**
 * 「深夜」窗口：`checkin-config.json` 的 `nightHours: {from, to}` 键，每轮重读。
 * 两个都要是 0~23 的整数小时才认，不合法就退默认（22:00~10:00）。
 */
function readNightHours(configFile) {
  try {
    const j = JSON.parse(fs.readFileSync(configFile, "utf8"));
    const n = j.nightHours;
    if (n && typeof n === "object") {
      const from = Number(n.from);
      const to = Number(n.to);
      if (Number.isInteger(from) && from >= 0 && from <= 23 && Number.isInteger(to) && to >= 0 && to <= 23) {
        return { from, to };
      }
    }
  } catch { /* 用默认 */ }
  return { ...DEFAULT_NIGHT_HOURS };
}

/**
 * 从菜单池里不重复抽 [min, max] 个（超过池子大小就整池给，不报错）。
 * Fisher-Yates 部分洗牌，抽出来的顺序就是当轮的呈现顺序。
 * ⚠️ 这是 fun 菜单专用的「一轮抽好几个不重复」，跟彩蛋那套「一副牌抽了不放回、
 * 抽空了重新洗」不是同一件事——fun 菜单没有跨轮记忆，彩蛋牌堆有（见 `drawFromDeck`）。
 */
function drawMenu(items, range, rand = Math.random) {
  const pool = (Array.isArray(items) ? items : []).map((s) => String(s || "").trim()).filter(Boolean);
  if (!pool.length) return [];
  const hi = Math.min(range.max, pool.length);
  const lo = Math.min(range.min, hi);
  const k = lo + Math.floor(rand() * (hi - lo + 1));
  const arr = pool.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  return arr.slice(0, k);
}

/** 编号列表：`1. xxx`，一行一个。 */
function formatMenu(list) {
  return list.map((t, i) => (i + 1) + ". " + t).join("\n");
}

/** `## xxx` 一行一条的段落 → 逐行选项。宽容点：允许 `- ` / `* ` 前缀，空行跳过。 */
function parseMenuLines(raw) {
  return String(raw || "").split("\n")
    .map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
    .filter(Boolean);
}

/**
 * 文案文件的极简格式：`## 段名` 分段，段内到下一个 `## ` 或文件末尾为止，原样保留
 * （不解析 markdown 语法、不转义）。挑这个格式是因为她/Nova改的时候直接编辑就行，
 * 不用碰 JSON 转义。段名不认识的（比如 `<!-- -->` 注释里提到的）一样会被解析成
 * 一个键，只是没人读它，无所谓。
 */
function parseTextsMd(raw) {
  const out = {};
  let cur = null;
  let buf = [];
  const flush = () => { if (cur) out[cur] = buf.join("\n").trim(); };
  for (const line of String(raw).split("\n")) {
    const m = /^##\s+(\S+)\s*$/.exec(line);
    if (m) { flush(); cur = m[1].toLowerCase(); buf = []; }
    else if (cur) buf.push(line);
  }
  flush();
  return out;
}

/**
 * 读文案。**每轮重读**（跟区间/权重一个规矩，改了不用重启）。
 * 文件缺失/读不出来/某段没写 → 那一段（含 fun_menu、彩蛋各池）退回内置副本。
 * 四个正文段 + 彩蛋子类型永远凑得齐，所以永远推得出一条不空的消息。
 */
function readTexts(file) {
  let parsed = {};
  try { parsed = parseTextsMd(fs.readFileSync(file, "utf8")); } catch { parsed = {}; }
  const menu = parseMenuLines(parsed.fun_menu);
  const eggNotes = parseMenuLines(parsed.egg_notes);
  const eggDeepDay = parseMenuLines(parsed.egg_deeptalk_day);
  const eggDeepNight = parseMenuLines(parsed.egg_deeptalk_night);
  const eggDare = parseMenuLines(parsed.egg_dare);
  const eggDareNight = parseMenuLines(parsed.egg_dare_night);
  const eggHiddenLines = parseMenuLines(parsed.egg_hidden);
  return {
    header: parsed.header || DEFAULT_TEXTS.header,
    heart: parsed.heart || DEFAULT_TEXTS.heart,
    cave: parsed.cave || DEFAULT_TEXTS.cave,
    fun: parsed.fun || DEFAULT_TEXTS.fun,
    fun_menu: menu.length ? menu : DEFAULT_FUN_MENU,
    egg_notes: eggNotes.length ? eggNotes : DEFAULT_EGG_NOTES,
    egg_deeptalk_day: eggDeepDay.length ? eggDeepDay : DEFAULT_EGG_DEEPTALK_DAY,
    egg_deeptalk_night: eggDeepNight.length ? eggDeepNight : DEFAULT_EGG_DEEPTALK_NIGHT,
    egg_dare: eggDare.length ? eggDare : DEFAULT_EGG_DARE,
    // ⚠️ 夜间专供池允许真的是空的（不像别的池子有兜底）——夜间牌堆是
    // egg_dare ∪ egg_dare_night，就算这段是空的，夜间牌堆退化成跟白天一样也没问题。
    egg_dare_night: eggDareNight,
    egg_hidden: eggHiddenLines.length ? eggHiddenLines[0] : DEFAULT_EGG_HIDDEN,
    // 她睡着时的动作（2026-09-22）：没配就是空的 —— 空就不加那一行，不编一句兜底
    her_sleep: parseMenuLines(parsed.her_sleep),
  };
}

/**
 * 把 HEADER 模板套上读数。**占位符解出来是空字符串，那一整行直接丢掉**
 * （例如没有「她最后说话」这件事，`{last_user_line}` 那一行就不出现，
 * 不留一句「我上次说话是……」的空壳；同理如果她把「你手上挂着的」那行
 * 从 `checkin-texts.md` 整行删掉，模板里根本没有这行，自然不出现）。
 */
function renderHeader(template, vars) {
  const out = [];
  for (const line of String(template || "").split("\n")) {
    const names = Array.from(line.matchAll(/\{(\w+)\}/g), (m) => m[1]);
    if (names.length && names.some((n) => !String(vars[n] == null ? "" : vars[n]).trim())) continue;
    let rendered = line;
    for (const n of names) rendered = rendered.split("{" + n + "}").join(vars[n] == null ? "" : vars[n]);
    out.push(rendered);
  }
  return out.join("\n");
}

const bj = (d) => new Date(d.getTime() + 8 * 3600e3).toISOString().slice(11, 16);
const mins = (ms) => Math.round(ms / 60000);
const human = (m) => (m >= 60 ? Math.floor(m / 60) + " 小时 " + (m % 60) + " 分钟" : m + " 分钟");

/** 距上一次 check-in 过了多久。第一次（没有上一次）留空 —— HEADER 那一行整个不出现。 */
function fmtSinceLast(now, lastAt) {
  if (!lastAt) return "";
  return human(mins(now.getTime() - lastAt));
}

/** 驱力读数：只取数，不解释。desire-system 没起来 / 没有数值型字段 → 空。 */
function fmtDrives(desire) {
  if (!desire || typeof desire !== "object") return "";
  const drives = desire.drives || desire.state || desire;
  const pairs = Object.entries(drives)
    .filter(([, v]) => typeof v === "number")
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => k + " " + (Math.round(v * 100) / 100));
  return pairs.join(" · ");
}

/**
 * 她最后一次说话是什么时候、说的什么。**原话比「多久之前」有信息量得多**。
 * 引号内截到 120 字（跟旧版一致），没有原话就只给时间点。
 */
function fmtLastUserLine(now, lastUserAt, lastUserText) {
  if (!lastUserAt) return "";
  const m = mins(now.getTime() - lastUserAt);
  const head = "我上次说话是 " + bj(new Date(lastUserAt)) + " " + m + "分钟前";
  const q = lastUserText ? String(lastUserText).replace(/\s+/g, " ").slice(0, 120) : "";
  return q ? head + " 我说的是「" + q + "」" : head;
}

/**
 * 她最后说话是什么时候 / 他连着几次没开口。
 *
 * **都从冷层读**（只读，不写）。冷层是按文件顺序存的，从尾巴往回扫最省。
 * ⚠️ 只数得出「没**开口**」——他写日记、逛网页这类不落冷层，数不到。
 * 所以措辞是「没开口」不是「没动静」，别把量不到的东西说成量到了。
 */
function readColdSignals(coldFile, sinceMs = 0) {
  if (!coldFile) return { lastUserAt: 0, lastUserText: "", spokeSince: false };
  let rows;
  try {
    rows = fs.readFileSync(coldFile, "utf8").trim().split("\n")
      .filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return { lastUserAt: 0, lastUserText: "", spokeSince: false }; }
  let lastUserAt = 0, lastUserText = "";
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].role === "user") {
      lastUserAt = Date.parse(rows[i].at) || 0;
      lastUserText = String(rows[i].text || "");   // 原话 —— 比「多久之前」有信息量得多
      break;
    }
  }
  // 上一次 check-in 之后他开过口没有
  let spokeSince = false;
  if (sinceMs) {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const t = Date.parse(rows[i].at) || 0;
      if (t < sinceMs) break;
      if (rows[i].role === "assistant" && !/^\[本轮未回复\]/.test(String(rows[i].text || ""))) {
        spokeSince = true; break;
      }
    }
  }
  return { lastUserAt, lastUserText, spokeSince };
}

/** 驱力读数。只取数，不解释 —— 哪条驱力最强、要不要照它行动，是他的事。 */
async function readDesire(url, timeoutMs = 3000) {
  if (!url) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url.replace(/\/$/, "") + "/api/desire/state", { signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
  finally { clearTimeout(t); }
}

// ============================================================
// 她睡着时的动作（2026-09-22 Alice：「checkin 我想加一个她的动作 就比如睡眠时间
// 在你怀里动了动 说了一句梦话 说渴要喝水之类的」「4-12点」「要概率」「可以发」）
// ============================================================
//
// 她又改（同日）：「她算单独的一条 他出现的时候其他checkin不出现 概率算在一起」。
// 又定（同日）：「为啥不能加在checkin里面呢」—— 所以它是 check-in 的**第五个分支**「她的动静」：
// **不带开头**（她：「不能把开头拿掉吗」），整条就是她的一个动静（`checkin-texts.md` 的
// `## her_sleep`，一副牌抽完才重复）；抽到它这一轮就没有别的分支正文。
// 份量：她睡着的钟点（`herSleep: {from,to}`，默认京时 4~12 点）用**睡着池子** `branchesSleep`
// （五支，含 her_sleep），别的时候用**白天池子** `branches`（四支）。两个池子各自加起来等于 1，
// 写多少就是多少（她：「概率算在一个池子里 以后比较好加减」「改成加起来等于一 我看着比较直观」）。
// 他接不接、怎么接是他的事；**她说了可以真发消息给她**，所以这里什么都不拦。
// 「同一分支不连续两次」不管这条：她睡着连着动两下很正常。
// 「睡着」只按钟点判 —— check-in 本来就只在空闲时才敲，钟点 + 空闲就是她睡着的样子。

const DEFAULT_HER_SLEEP = { from: 4, to: 12 };

/** `checkin-config.json` 的 `herSleep: {from, to}`（她睡着的钟点），每轮重读；不合法退默认。这段钟点用 `branchesSleep` 池子。 */
function readHerSleep(configFile) {
  const out = { ...DEFAULT_HER_SLEEP };
  try {
    const h = JSON.parse(fs.readFileSync(configFile, "utf8")).herSleep;
    if (h && typeof h === "object") {
      const from = Number(h.from), to = Number(h.to);
      if (Number.isInteger(from) && from >= 0 && from <= 23 && Number.isInteger(to) && to >= 0 && to <= 23) {
        out.from = from; out.to = to;
      }
    }
  } catch { /* 用默认 */ }
  return out;
}

/** 下一次隔多久。**这是打点，是脚本该做的事。** */
function nextDelayMs(range, rand = Math.random) {
  return range.min + Math.floor(rand() * (range.max - range.min + 1));
}

// ============================================================
// 空闲触发（2026-09-22 Alice：「checkin 我打算设计成空闲时间触发」「45-55min」「他不会跑长活」）
// ============================================================
//
// 以前是死打点：每 40~50 分钟敲一次，她 5 分钟内说过话就跳过。毛病是聊着天停 6 分钟
// 也会被插一条，走开很久也还是按钟点敲，跟「空不空」没关系。
//
// 现在：**冷层最后一条对话（她说的、他回她的，任一方）之后空满 N 分钟才敲**，
// N 在 checkin-config.json 的 min/max 区间里随机（她定 45~55）。敲完以后如果还空着，
// 从这次 check-in 起再空满一个 N 又敲；任何一方一开口就从那条消息重新计时。
// 「空闲」只看冷层 —— 他不跑长活（她说的），所以不用去分「他在后台干活算不算」。
//
// 心脏的拍子是「算好下一次 → 睡 → 敲」，睡的时候看不见新消息，所以这里最多睡
// POLL（5 分钟）就醒来重算一次；醒来发现还没空够，就只看一眼不推（返回 skipped）。

const DEFAULT_IDLE_POLL_MS = 5 * 60 * 1000;

/**
 * 冷层最后一条对话的时刻（毫秒）。只读文件尾巴，不把 17MB 整个读进来。
 * 读不到 / 没有记录 → 0（交给调用方拿启动时刻兜底）。
 */
function readLastActivityAt(coldFile, tailBytes = 64 * 1024) {
  if (!coldFile) return 0;
  let fd;
  try {
    fd = fs.openSync(coldFile, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, tailBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      // 尾巴第一行可能被切在半截，解析不了就跳过，往前找完整的
      let row;
      try { row = JSON.parse(lines[i]); } catch { continue; }
      const t = Date.parse(row && row.at);
      if (t) return t;
    }
    return 0;
  } catch { return 0; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* 关不上也不影响判断 */ } }
}

/**
 * 空闲闹钟。只管「现在该不该敲」，不管敲什么（那是 makeCheckin().tick() 的事）。
 * 计时起点 = max(冷层最后一条, 上次 check-in 推出去的时刻, 进程启动时刻)；
 * 起点每变一次就重新掷一个 N（区间每次都重读配置 = 改配置不用重启）。
 */
function makeIdleClock({ coldFile = "", configFile = "", pollMs = DEFAULT_IDLE_POLL_MS,
  rand = Math.random, nowFn = () => Date.now() } = {}) {
  const startedAt = nowFn();
  let lastFiredAt = 0;
  let base = -1;
  let threshold = 0;

  function dueAt() {
    const b = Math.max(readLastActivityAt(coldFile), lastFiredAt, startedAt);
    if (b !== base) {
      base = b;
      threshold = nextDelayMs(readRange(configFile), rand);
    }
    return base + threshold;
  }

  return {
    /** 睡多久：到空闲点的剩余时间，但最多 pollMs（睡着时看不见新消息）。 */
    nextDelayMs() {
      return Math.max(0, Math.min(dueAt() - nowFn(), pollMs));
    },
    /** 现在空够了没有。醒来先问这个，没空够就不推。 */
    isDue() { return nowFn() >= dueAt(); },
    /** 推出去了：下一轮从这一刻起算。 */
    fired(at = nowFn()) { lastFiredAt = at; },
    /** 排查用：起点、这一轮掷到的 N、预计哪一刻敲。 */
    peek() { const d = dueAt(); return { base, thresholdMs: threshold, dueAt: d }; },
  };
}

// ============================================================
// 彩蛋：北京时间判夜、翻旧账水塘抽样、抽卡牌堆
// ============================================================

/** 京时是几点（0~23）。 */
function bjHour(now) {
  return new Date(now.getTime() + 8 * 3600e3).getUTCHours();
}

/**
 * Deep Talk / 大冒险 用同一条「是不是深夜」判据，窗口可配（见 `readNightHours`，
 * 默认京时 22:00~10:00）。`from > to` 按跨午夜处理；`from === to` 视为没有夜间
 * 窗口（不炸，永远判白天）。
 */
function isBeijingNight(now, range = DEFAULT_NIGHT_HOURS) {
  const h = bjHour(now);
  const { from, to } = range || DEFAULT_NIGHT_HOURS;
  if (from === to) return false;
  return from < to ? (h >= from && h < to) : (h >= from || h < to);
}

/** 冷层原话 `at`（ISO UTC）→ 「M月D日」（京时日期，不补零，跟人说话的习惯一致）。 */
function bjDateLabel(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t + 8 * 3600e3);
  return (d.getUTCMonth() + 1) + "月" + d.getUTCDate() + "日";
}

/**
 * 翻旧账：从冷层里随机抽一条她（role=user）3 天以前说的、8~120 字、不是
 * `[图片]` 这类的旧话。**水塘抽样（reservoir sampling，k=1）**，全程用 `readline`
 * 一行一行流式扫 `cold.jsonl`（这文件 17MB 还在长，绝不整份读进内存再筛）：
 * 每碰到一条合格的，用 `1/已见过的合格条数` 的概率把它换成当前抽中的那条，
 * 扫到文件末尾时手里这条就是均匀随机抽中的合格旧话。
 *
 * @returns {Promise<{id, at, text}|null>} 没有冷层 / 没有合格的旧话 → null
 *   （调用方按「这个子类型抽不出来」处理，退到下一个子类型，见 `pickEgg`）。
 */
async function sampleOldQuote(coldFile, { now = new Date(), minAgeMs = 3 * 24 * 3600e3, minLen = 8, maxLen = 120 } = {}, rand = Math.random) {
  if (!coldFile) return null;
  let stream;
  try { stream = fs.createReadStream(coldFile, { encoding: "utf8" }); }
  catch { return null; }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let seen = 0;
  let picked = null;
  const cutoff = now.getTime() - minAgeMs;
  try {
    for await (const line of rl) {
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || row.role !== "user") continue;
      const text = String(row.text || "");
      if (!text || text.startsWith("[")) continue;
      const len = text.length;
      if (len < minLen || len > maxLen) continue;
      const at = Date.parse(row.at);
      if (!Number.isFinite(at) || at > cutoff) continue;
      seen += 1;
      if (rand() < 1 / seen) picked = { id: row.id, at: row.at, text };
    }
  } catch { /* 流坏了 → 当没抽到，不炸 */ }
  finally {
    try { rl.close(); } catch { /* 已关 */ }
    try { stream.destroy(); } catch { /* 已关 */ }
  }
  return picked;
}

/** 一副空牌。 */
function emptyDeck() { return { pool: [], remaining: [], drawnLog: [] }; }

/**
 * 牌堆对账：拿当轮真实的池子（来自 `checkin-texts.md`）跟上一轮记下的牌堆对一遍。
 *   · 文件里新加的行（这次池子有、上次池子没有、牌堆里也没有）→ 直接补进当前牌堆
 *     （还没抽过，理所当然能抽到）
 *   · 文件里删掉的行 → 从牌堆里摘掉（不会凭空抽到已经不存在的内容）
 *   · 牌堆抽空了（`remaining` 空但池子不空）→ 整副重新洗（用当前完整池子）
 * `drawnLog` 原样带过去，只在真的抽中一张牌时才追加。
 */
function reconcileDeck(prev, pool) {
  const prevPool = Array.isArray(prev && prev.pool) ? prev.pool : [];
  const prevRemaining = Array.isArray(prev && prev.remaining) ? prev.remaining : [];
  const drawnLog = Array.isArray(prev && prev.drawnLog) ? prev.drawnLog : [];
  const poolSet = new Set(pool);
  let remaining = prevRemaining.filter((x) => poolSet.has(x));
  const prevPoolSet = new Set(prevPool);
  for (const item of pool) {
    if (!prevPoolSet.has(item) && !remaining.includes(item)) remaining.push(item);
  }
  if (!remaining.length && pool.length) remaining = pool.slice();
  return { pool: pool.slice(), remaining, drawnLog };
}

/**
 * 从一副牌里抽一张（抽了就从 `remaining` 里拿掉，不放回）。
 * 抽之前先做 `reconcileDeck` 对账，所以池子刚变过也能立刻反映。
 * 池子本身是空的（一条都没配置）→ 抽不出来，`picked` 是 null。
 */
function drawFromDeck(prevDeckState, pool, rand, now) {
  const deck = reconcileDeck(prevDeckState, pool);
  if (!deck.remaining.length) return { picked: null, deck };
  const idx = Math.floor(rand() * deck.remaining.length);
  const picked = deck.remaining.splice(idx, 1)[0];
  deck.drawnLog = deck.drawnLog.concat([{ item: picked, at: now.toISOString() }]).slice(-200);
  return { picked, deck };
}

const DECK_KEYS = ["notes", "deeptalk_day", "deeptalk_night", "dare_day", "dare_night", "her_sleep"];

/** 状态文件的默认形状（没文件 / 文件坏了 / 第一次跑都退回这个）。 */
function emptyCheckinState() {
  const decks = {};
  for (const k of DECK_KEYS) decks[k] = emptyDeck();
  return { lastBranch: "", decks };
}

/**
 * 读牌堆 + 上次抽到的分支的状态。**只有我们自己写这个文件**（不像
 * configFile/textsFile 那样外面随时会改），所以在 `makeCheckin` 构造时读一次、
 * 存进闭包变量、每次 `tick()` 改完再写回去就够了——不用像区间/权重/文案那样
 * 每轮都重新读文件。`stateFile` 不给就完全不碰磁盘，状态只在这个进程活着的
 * 时候有效（测试默认这样，互不干扰）。
 */
function readState(stateFile) {
  const base = emptyCheckinState();
  if (!stateFile) return base;
  try {
    const j = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (j && typeof j === "object") {
      if (typeof j.lastBranch === "string") base.lastBranch = j.lastBranch;
      if (j.decks && typeof j.decks === "object") {
        for (const k of DECK_KEYS) {
          const d = j.decks[k];
          if (d && typeof d === "object") {
            base.decks[k] = {
              pool: Array.isArray(d.pool) ? d.pool : [],
              remaining: Array.isArray(d.remaining) ? d.remaining : [],
              drawnLog: Array.isArray(d.drawnLog) ? d.drawnLog : [],
            };
          }
        }
      }
    }
  } catch { /* 读不到 / 坏了 → 全新状态，不炸 */ }
  return base;
}

/** tmp → rename，半截文件读回来当空状态用（重新洗一次牌，不是灾难）。 */
function writeState(stateFile, state) {
  if (!stateFile) return;
  try {
    const tmp = stateFile + ".tmp-" + process.pid;
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
    fs.renameSync(tmp, stateFile);
  } catch { /* 这轮状态没存住，下轮重新对账，不阻断推送 */ }
}

/**
 * 抽中彩蛋之后，选子类型、拼正文。骰子先选一个想要的子类型，抽不出来
 * （池子空/牌堆空且池子也空）就按固定顺序试下一个，**永远能拼出点什么**
 * （`DEFAULT_EGG_*` 兜底保证池子不会真的全空）。
 *
 * 会改 `state.decks` 里对应那副牌（调用方要把改完的 `state` 写回状态文件）。
 *
 * @param {object} o.nightHours 「深夜」窗口（`readNightHours` 读出来的 {from,to}），
 *   deeptalk 和 dare 判夜用同一个
 * @returns {Promise<{type:string, body:string}>}
 */
async function pickEgg({ texts, weights, state, coldFile, now, rand, nightHours = DEFAULT_NIGHT_HOURS }) {
  const rolledType = rollBranch(weights, rand);
  const order = [rolledType];
  for (const k of ["notes", "oldquote", "deeptalk", "dare", "hidden"]) {
    if (!order.includes(k)) order.push(k);
  }

  for (const type of order) {
    if (type === "notes") {
      const { picked, deck } = drawFromDeck(state.decks.notes, texts.egg_notes, rand, now);
      if (picked) { state.decks.notes = deck; return { type: "notes", body: picked }; }
    } else if (type === "deeptalk") {
      const night = isBeijingNight(now, nightHours);
      const pool = night ? texts.egg_deeptalk_night : texts.egg_deeptalk_day;
      const deckKey = night ? "deeptalk_night" : "deeptalk_day";
      const { picked, deck } = drawFromDeck(state.decks[deckKey], pool, rand, now);
      if (picked) {
        state.decks[deckKey] = deck;
        return { type: "deeptalk", body: ["Deep Talk 时间：", picked, "抽到了就回答我吧"].join("\n") };
      }
    } else if (type === "dare") {
      const night = isBeijingNight(now, nightHours);
      // 夜间牌堆 = egg_dare ∪ egg_dare_night；白天只用 egg_dare（见文件头「彩蛋分支」一节）
      const pool = night ? texts.egg_dare.concat(texts.egg_dare_night) : texts.egg_dare;
      const deckKey = night ? "dare_night" : "dare_day";
      const { picked, deck } = drawFromDeck(state.decks[deckKey], pool, rand, now);
      if (picked) {
        state.decks[deckKey] = deck;
        return { type: "dare", body: ["大冒险：" + picked, "做到了就发给我"].join("\n") };
      }
    } else if (type === "oldquote") {
      const picked = await sampleOldQuote(coldFile, { now }, rand);
      if (picked) {
        const label = bjDateLabel(picked.at);
        return { type: "oldquote", body: "翻旧账：你还记得 " + label + " 我说过「" + picked.text + "」吗" };
      }
    } else if (type === "hidden") {
      const line = texts.egg_hidden;
      if (line) return { type: "hidden", body: line };
    }
  }
  // 理论上到不了这里（DEFAULT_EGG_NOTES 保底不空）；留一道最后防线，绝不推空消息。
  return { type: "notes", body: DEFAULT_EGG_NOTES[0] };
}

/**
 * 跑起来。
 *
 * @param {object} o
 * @param {string} o.dir          投递目录（跟桥约好的）
 * @param {string} [o.configFile] 区间 + 骰子权重（branches/eggs）+ fun 菜单数量（改了不用重启）
 * @param {string} [o.textsFile]  HEADER + 分支全文 + fun_menu + 彩蛋各池（改了不用重启，缺段退默认）
 * @param {string} [o.stateFile]  上次抽到的分支 + 彩蛋各副牌的状态（**只有我们自己写**，
 *   构造时读一次，每次 tick() 改完写回去；不给就只在进程内存里活，重启就清空）
 * @param {string} [o.desireUrl]
 * @param {string} [o.coldFile]
 * @param {function} [o.pendingText]         「悬着的」那一行的供料函数（心脏那头给，读笔记本标题）
 * @param {function} [o.expiredNotebookText] 笔记本到期提醒那一行的供料函数（心脏那头给，
 *   读笔记本 `listExpired()`），没给 / 没有到期条目就不加这行
 * @param {function} [o.log]
 * @param {function} [o.sleep]    测试塞替身用
 * @param {function} [o.rand]
 */
function makeCheckin({ dir, configFile = "", textsFile = "", stateFile = "", desireUrl = "", coldFile = "",
  pendingText = null, expiredNotebookText = null,
  skipIfSpokeWithinMs = DEFAULT_SKIP_IF_SPOKE_WITHIN_MS, log = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), rand = Math.random } = {}) {
  if (!String(dir || "").trim()) throw new Error("check-in 要一个投递目录 —— 不许用默认值猜");
  let stopped = false;
  let lastAt = 0;
  let silentStreak = 0;
  // 分支/牌堆状态：构造时读一次，`stateFile` 是我们独占写的文件，不用像
  // configFile/textsFile 那样每轮重读（见 readState 的说明）。
  let branchState = readState(stateFile);

  return {
    /** 敲一次（到点了）。测试直接调这个，不用等真的 40 分钟。 */
    async tick({ now = new Date() } = {}) {
      const sig = readColdSignals(coldFile, lastAt);

      // ==== 她在场就跳过这一次 ====
      // 不投、不排队、不补发。**跳过的这次不算「他没开口」** —— 那不是他的选择。
      if (skipIfSpokeWithinMs && sig.lastUserAt) {
        const since = now.getTime() - sig.lastUserAt;
        if (since < skipIfSpokeWithinMs) {
          lastAt = now.getTime();
          log("[check-in] 跳过这次：她 " + Math.round(since / 1000) + " 秒前刚说过话");
          return { skipped: true, reason: "她刚说过话", sinceMs: since };
        }
      }

      const desire = await readDesire(desireUrl);
      if (lastAt) silentStreak = sig.spokeSince ? 0 : silentStreak + 1;
      // 悬着的账。心脏那头给 `pendingText`（笔记本标题，9-22 起意图卡那半彻底拿掉）；
      // 没给就空着 —— **读不出来就不给，绝不为了凑一行编内容。**
      let pending = "";
      try {
        pending = pendingText ? String(pendingText() || "").trim() : "";
      } catch { /* 没有就不给 */ }
      pending = pending.replace(/\s+/g, " ").slice(0, 450);   // 二道保险，跟旧版上限一致

      const texts = readTexts(textsFile);

      // ==== 掷骰子选分支（排除上一次那个），拼 HEADER ====
      // 她睡着的钟点用睡着池子（多一支她的动静），别的时候用白天池子；两个都每轮重读
      const sleeping = isBeijingNight(now, readHerSleep(configFile));
      const weights = sleeping
        ? readWeightsFromConfig(configFile, "branchesSleep", DEFAULT_SLEEP_BRANCH_WEIGHTS)
        : readBranchWeights(configFile);
      // 文案里没配 her_sleep 就抽不出她的动静 → 这一支当 0；拿掉后全是 0 就退默认，不推空、不除零
      if (!texts.her_sleep.length && weights.her_sleep) {
        weights.her_sleep = 0;
        if (!Object.values(weights).some((v) => v > 0)) Object.assign(weights, DEFAULT_BRANCH_WEIGHTS);
      }
      // 「同一分支不连续两次」不管她的动静（她睡着连着动两下很正常）
      const rollWeights = branchState.lastBranch === "her_sleep" ? weights : excludeLastBranch(weights, branchState.lastBranch);
      let branch = rollBranch(rollWeights, rand);
      let herSleepLine = "";
      let herDeck = null;
      if (branch === "her_sleep") {
        const drawn = drawFromDeck(branchState.decks.her_sleep, texts.her_sleep, rand, now);
        if (drawn.picked) { herSleepLine = drawn.picked; herDeck = drawn.deck; }
        else branch = rollBranch({ ...rollWeights, her_sleep: 0 }, rand);   // 牌堆意外空了：换别的分支，不推空
      }

      let header = renderHeader(texts.header, {
        branch_name: BRANCH_NAMES[branch] || branch,
        now: bj(now),
        last_user_line: fmtLastUserLine(now, sig.lastUserAt, sig.lastUserText),
        since_last: fmtSinceLast(now, lastAt),
        drives: fmtDrives(desire),
        pending,
      });
      // 笔记本到期提醒：动态内容，不走 checkin-texts.md 的占位符（见文件头说明）。
      let expiredLine = "";
      try {
        expiredLine = expiredNotebookText ? String(expiredNotebookText() || "").trim() : "";
      } catch { /* 读不出来就不加这行 */ }
      if (expiredLine) header = header + "\n" + expiredLine;

      // ==== 拼分支正文 ====
      let body;
      let eggType = "";
      if (branch === "her_sleep") {
        body = herSleepLine;
        branchState.decks.her_sleep = herDeck;
      } else if (branch === "fun") {
        // fun 菜单：只有抽到 fun 才用得上，但每轮都算一次成本很低，直接算——
        // 别的分支正文里没有 {menu}，split/join 是无操作。
        const menuRange = readFunMenuRange(configFile);
        const menu = formatMenu(drawMenu(texts.fun_menu, menuRange, rand));
        body = String(texts.fun || "").trim().split("{menu}").join(menu);
      } else if (branch === "egg") {
        const eggWeights = readEggWeights(configFile);
        const nightHours = readNightHours(configFile);
        const picked = await pickEgg({ texts, weights: eggWeights, state: branchState, coldFile, now, rand, nightHours });
        body = picked.body;
        eggType = picked.type;
      } else {
        body = String(texts[branch] || "").trim();
      }

      // ==== 存状态（分支 + 牌堆），拼消息，推 ====
      branchState.lastBranch = branch;
      writeState(stateFile, branchState);

      // ⚠️ silentStreak **算但不给他看**（历史：考核指标不进正文，见 worklog）
      // 她的动静不带开头（她 9-22：「不能把开头拿掉吗」）——他收到的就只有她那一个动静
      const text = branch === "her_sleep" ? body : header + "\n\n" + body;
      const r = putNote({ dir, producer: "checkin", text });
      lastAt = now.getTime();
      log("[check-in] 推了一条 " + r.id + "，掷到分支 " + branch + "（"
        + (BRANCH_NAMES[branch] || branch) + (eggType ? "·" + eggType : "") + "，权重 " + JSON.stringify(weights)
        + "）连续没开口 " + silentStreak + " 次");
      return { ...r, silentStreak, branch, eggType, herSleepLine };
    },

    async run() {
      const range = readRange(configFile);
      log("[check-in] 起来了，区间 "
        + Math.round(range.min / 60000) + "-" + Math.round(range.max / 60000) + " 分钟");
      while (!stopped) {
        const wait = nextDelayMs(readRange(configFile), rand);   // 每轮重读 = 改配置不用重启
        log("[check-in] 下一次约 " + Math.round(wait / 60000) + " 分钟后");
        await sleep(wait);
        if (stopped) break;
        try { await this.tick(); }
        catch (e) { log("[check-in] 这次没推成：" + ((e && e.message) || e)); }
      }
    },

    stop() { stopped = true; },
  };
}

module.exports = {
  makeCheckin, nextDelayMs, readRange, readColdSignals,
  makeIdleClock, readLastActivityAt, DEFAULT_IDLE_POLL_MS,
  DEFAULT_HER_SLEEP, readHerSleep, DEFAULT_SLEEP_BRANCH_WEIGHTS, readWeightsFromConfig,
  DEFAULT_MIN_MS, DEFAULT_MAX_MS, DEFAULT_SKIP_IF_SPOKE_WITHIN_MS,
  BRANCH_NAMES, DEFAULT_BRANCH_WEIGHTS, DEFAULT_TEXTS, DEFAULT_FUN_MENU, DEFAULT_FUN_MENU_RANGE,
  readBranchWeights, rollBranch, excludeLastBranch, readFunMenuRange, drawMenu, formatMenu, parseMenuLines,
  parseTextsMd, readTexts, renderHeader,
  fmtSinceLast, fmtDrives, fmtLastUserLine,
  // 彩蛋
  DEFAULT_EGG_WEIGHTS, DEFAULT_EGG_NOTES, DEFAULT_EGG_DEEPTALK_DAY, DEFAULT_EGG_DEEPTALK_NIGHT,
  DEFAULT_EGG_DARE, DEFAULT_EGG_DARE_NIGHT, DEFAULT_EGG_HIDDEN,
  readEggWeights, DEFAULT_NIGHT_HOURS, readNightHours, isBeijingNight, bjHour, bjDateLabel, sampleOldQuote,
  emptyDeck, reconcileDeck, drawFromDeck, DECK_KEYS, emptyCheckinState, readState, writeState, pickEgg,
};
