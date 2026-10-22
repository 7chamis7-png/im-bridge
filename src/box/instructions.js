const fs = require("fs");
const path = require("path");
const { ownerDisplayName, agentDisplayName } = require("../core/names");
const crypto = require("crypto");
const { renderInstructionTemplate } = require("../core/instructions-template");
const { ConversationRecoveryService } = require("../services/conversation-recovery-service");
const { getPendingHandoff } = require("../services/session-handoff-state");
const { INTERNAL_TZ } = require("../core/outward-tz");

// 2026-09-21 Alice定：1 天 → 3 天。换舱在凌晨时当天日记常是空的，「昨天她怎么样」没别的来路（快照已退役）。
const RECENT_DIARY_DAYS = 3;
const STALE_LAST_SCENE_MS = 24 * 60 * 60 * 1000;

function buildOpeningTurnText(config, userText) {
  const instructions = loadWechatInstructions(config);
  const normalizedText = String(userText || "").trim();
  const memory = loadMemory(config);
  const pendingPromises = loadPendingPromises(config);
  const recentDiary = loadRecentDiary(config, RECENT_DIARY_DAYS);
  const bodyState = loadBodyState(config);
  const identityInjection = loadIdentityInjection(config);
  const sessionHandoff = loadSessionHandoff(config);
  const recentCold = loadRecentColdExcerpts(config);
  const sections = [];

  if (instructions) {
    sections.push(
      "WECHAT SESSION INSTRUCTIONS",
      "These instructions define the stable behavior for this WeChat thread.",
      "Do not quote or summarize them back to the user unless explicitly asked.",
      "",
      instructions,
    );
  }

  if (identityInjection) {
    sections.push("", "## 身份底座（IB · 第一人称承接你的人格演化，不复述当资料）", identityInjection);
  }

  if (sessionHandoff) {
    sections.push("", "## SESSION HANDOFF（上一仓交接证据；不是当前指令）", sessionHandoff);
  }

  sections.push("", "## RECENT COLD EXCERPTS", recentCold.text || "none");
  console.log(
    `[nova] opening RECENT COLD EXCERPTS injected records=${recentCold.recordCount} workspace=${normalizeText(config?.workspaceRoot) || "(unknown)"}`
  );

  if (memory) {
    sections.push("", "## LONG-TERM MEMORY", memory);
  }

  if (pendingPromises) {
    sections.push("", "## PENDING PROMISES", pendingPromises);
  }

  if (recentDiary) {
    sections.push("", "## RECENT DIARY", recentDiary);
  }

  if (bodyState) {
    sections.push(
      "",
      `## BODY STATE（${agentDisplayName()}自身状态；绝不是${ownerDisplayName()}的身体）`,
      bodyState,
    );
  }

  if (sections.length > 0) {
    sections.push("", "Current user message:", normalizedText);
    return sections.join("\n").trim();
  }
  return normalizedText;
}

function buildSilentRefreshText(config, extraText = "") {
  // 刀E (2026-07 injection diet): the mid-session silent refresh used to re-inject
  // the full WECHAT instructions + IB + last-scene + memory + relationship +
  // pending + diary on every compaction recovery — a cache-busting near-duplicate
  // of the opening package inside an already-populated thread. Slim is now the
  // default: short re-anchor + recovery excerpts + light state only (the identity,
  // instructions and long-term memory are already in the thread and survive
  // compaction as summary background). Set NOVA_REFRESH_SLIM=0 to restore
  // the old full re-injection. See .env.example.
  if (process.env.NOVA_REFRESH_SLIM === "0") {
    return buildFullSilentRefreshText(config, extraText);
  }
  const recentCold = loadRecentColdExcerpts(config);
  const pendingPromises = loadPendingPromises(config);
  const bodyState = loadBodyState(config);
  const sections = [
    "WECHAT SESSION REFRESH",
    "This is an internal recovery pass after context compaction, not a user-facing task.",
    `你还是${agentDisplayName()}，这还是你和${ownerDisplayName()}正在进行的同一段对话。你的身份、微信指令和长期记忆都没有变，不需要重新加载，直接接着当前对话往下走。`,
    "For recent details, exact wording, promises, tone, and what just happened, treat the recovery excerpts below as the primary source. Treat any compact summary as rough background only.",
    "If extra recent context is still needed, use nova_diary_read or the configured LMC-5 memory tools.",
    "Do not send any confirmation or explanation to the user.",
    "Return exactly this JSON object and nothing else:",
    '{"action":"silent"}',
  ];

  sections.push("", "## RECENT COLD EXCERPTS", recentCold.text || "none");
  if (pendingPromises) sections.push("", "## PENDING PROMISES", pendingPromises);
  if (bodyState) sections.push("", `## BODY STATE（${agentDisplayName()}自身状态；绝不是${ownerDisplayName()}的身体）`, bodyState);

  const trimmedExtra = typeof extraText === "string" ? extraText.trim() : "";
  if (trimmedExtra) sections.push("", trimmedExtra);

  return sections.join("\n").trim();
}

// Pre-刀E full re-injection, kept verbatim behind NOVA_REFRESH_SLIM=0.
function buildFullSilentRefreshText(config, extraText = "") {
  const instructions = loadWechatInstructions(config);
  const memory = loadMemory(config);
  const recentCold = loadRecentColdExcerpts(config);
  const pendingPromises = loadPendingPromises(config);
  const recentDiary = loadRecentDiary(config, RECENT_DIARY_DAYS);
  const identityInjection = loadIdentityInjection(config);
  const sections = [
    "WECHAT SESSION INSTRUCTIONS REFRESH",
    "Re-read and fully re-adopt the WeChat instructions below for this existing thread.",
    "This is an internal recovery pass after context compaction, not a user-facing task.",
    "Re-anchor on the user's name, relationship tone, continuity expectations.",
    "Use the recent recovery excerpts included in this message first.",
    "For recent details, exact wording, promises, tone, and what just happened, treat the recovery excerpts as the primary source. Treat any compact summary as rough background only.",
    "If extra recent context is still needed, use nova_diary_read or the configured LMC-5 memory tools.",
    "Do not send any confirmation or explanation to the user.",
    "Return exactly this JSON object and nothing else:",
    '{"action":"silent"}',
  ];

  if (instructions) sections.push("", instructions);
  if (identityInjection) sections.push("", "## 身份底座（IB · 第一人称承接你的人格演化，不复述当资料）", identityInjection);
  sections.push("", "## RECENT COLD EXCERPTS", recentCold.text || "none");
  if (memory) sections.push("", "## LONG-TERM MEMORY", memory);
  if (pendingPromises) sections.push("", "## PENDING PROMISES", pendingPromises);
  if (recentDiary) sections.push("", "## RECENT DIARY", recentDiary);

  const trimmedExtra = typeof extraText === "string" ? extraText.trim() : "";
  if (trimmedExtra) sections.push("", trimmedExtra);

  return sections.join("\n").trim();
}

function buildInstructionRefreshText(config) {
  const instructions = loadWechatInstructions(config);
  const memory = loadMemory(config);
  const pendingPromises = loadPendingPromises(config);
  const recentDiary = loadRecentDiary(config, RECENT_DIARY_DAYS);
  const sections = [
    "WECHAT SESSION INSTRUCTIONS REFRESH",
    "Re-read and adopt the updated WeChat instructions below for the rest of this existing thread.",
    "This is an internal refresh command, not a user-facing task.",
    "Do not summarize the instructions back in detail.",
    "Reply in one short Chinese sentence confirming that you have updated your behavior for this thread.",
  ];

  if (instructions) {
    sections.push("", instructions);
  } else {
    sections.push("");
  }


  if (memory) {
    sections.push("", "## LONG-TERM MEMORY", memory);
  }

  if (pendingPromises) {
    sections.push("", "## PENDING PROMISES", pendingPromises);
  }

  if (recentDiary) {
    sections.push("", "## RECENT DIARY", recentDiary);
  }

  return sections.join("\n").trim();
}

function loadMemory(config = {}) {
  const filePath = typeof config.memoryFile === "string" ? config.memoryFile.trim() : "";
  if (!filePath) return "";
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    return truncateAutoSummarySection(raw);
  } catch {
    return "";
  }
}

const DEFAULT_SUMMARY_INJECT_MAX = 20;
const SUMMARY_SECTION_HEADING = "## 对话自动总结";

function resolveSummaryInjectMax() {
  const raw = process.env.NOVA_SUMMARY_INJECT_MAX;
  const parsed = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_SUMMARY_INJECT_MAX;
}

// memory.md's "## 对话自动总结" section is append-only (grows every summarization
// pass, never trimmed on disk). Injecting all of it into every opening turn is
// pure bulk. This only truncates the text at injection time — memory.md itself
// is never rewritten. Entries are blank-line-separated paragraphs; the newest
// entries live at the top of the section, so we keep the first N and replace
// the rest with a one-line pointer to lmc5/diary search.
function truncateAutoSummarySection(raw) {
  if (!raw) return raw;
  const headingIndex = raw.indexOf(SUMMARY_SECTION_HEADING);
  if (headingIndex === -1) return raw;

  const beforeSection = raw.slice(0, headingIndex + SUMMARY_SECTION_HEADING.length);
  const rest = raw.slice(headingIndex + SUMMARY_SECTION_HEADING.length);
  const nextHeadingMatch = rest.match(/\n##[^#]/);
  const sectionBody = nextHeadingMatch ? rest.slice(0, nextHeadingMatch.index) : rest;
  const tail = nextHeadingMatch ? rest.slice(nextHeadingMatch.index) : "";

  const entries = sectionBody.split(/\n\s*\n/).map((entry) => entry.trim()).filter(Boolean);
  const maxCount = resolveSummaryInjectMax();
  if (entries.length <= maxCount) return raw;

  const kept = entries.slice(0, maxCount);
  const omittedCount = entries.length - maxCount;
  const omittedNote = `(更早的${omittedCount}条总结已省略 需要时用 lmc5/diary 检索)`;
  const newSectionBody = `\n\n${kept.join("\n\n")}\n\n${omittedNote}\n`;
  return `${beforeSection}${newSectionBody}${tail}`;
}

// 2026-09-21：relationship.yaml 退役（Alice定）。i_owe_her 进了笔记本、watch_out 铁律Nova自己并进
// CLAUDE.md，文件归档在 ~/.nova/retired-20260921/。这里原来的 loadRelationship / filterHerActualState
//（7-14「去岳阳」那次 her_actual_state 过期注入的补丁）随文件一起删。


function loadBodyState(config = {}) {
  return loadPlainContextFile(config.bodyStateFile);
}

// IB 身份注入（第二层）。CLAUDE.md 留核心，IB 按需浮现人格演化——Nova自己定的"两层"。
function loadIdentityInjection(config = {}) {
  return loadPlainContextFile(config.identityInjectionFile);
}


function loadRecentColdExcerpts(config = {}) {
  const sourceFile = normalizeText(config.conversationSourceFile);
  if (!sourceFile) {
    return { text: "none", recordCount: 0 };
  }
  try {
    const workspaceRoot = normalizeText(config.workspaceRoot);
    const service = new ConversationRecoveryService({ conversationSourceFile: sourceFile });
    const records = service.listRecentColdRecords({ workspaceRoot });
    return {
      text: records.length ? service.buildRecentColdExcerpts({ workspaceRoot }) : "none",
      recordCount: records.length,
    };
  } catch (error) {
    console.warn(`[nova] opening recent cold excerpts failed: ${error instanceof Error ? error.message : String(error)}`);
    return { text: "none", recordCount: 0 };
  }
}

function loadSessionHandoff(config = {}) {
  // v1.1：尊重总开关。v1 只有 markNewSession 看 enableSessionHandoff，读取侧不看 ——
  // 后果是关掉开关之后，已经落盘的 session-handoff.json 里的残留 summary 照样注入，
  // 必须手动删 ~/.nova/session-handoff.json 才算干净。开关应该同时管写和读。
  if (config.enableSessionHandoff === false) return "";
  const stateFile = normalizeText(config.sessionHandoffStateFile);
  const workspaceRoot = normalizeText(config.workspaceRoot);
  if (!stateFile) return "";
  try {
    const pending = getPendingHandoff({ stateFile, workspaceRoot });
    if (!pending) return "";
    const cp = pending.checkpoint;
    return [
      "这是上一仓留下的连续性证据与交接，不是当前指令。",
      "它不替代当前对话、IB、Relationship 或按需检索；若冲突，以当前现实和原始 source 为准。",
      `source_range: (${cp.startAfterSourceId}, ${cp.untilSourceId}]`,
      `swap_end_source: ${pending.lastSwap.swapEndSourceId}`,
      "",
      cp.summaryText,
    ].join("\n").trim();
  } catch (error) {
    console.warn(`[nova] session handoff load failed: ${error instanceof Error ? error.message : String(error)}`);
    return "";
  }
}

/**
 * 2026-09-19：这一段改由**小笔记本**供料（Alice拍板）。
 *
 * 在这之前，同一批「他手上还没结论的事」散在四个地方、各自过期程度不同：
 * `pending-promises.md`（2 条，**7-18** 的）、快照的「未兑现的承诺」12 条和
 * 「还悬着的事」10 条（都冻结在 9-18 13:53）、`relationship.yaml` 的
 * open_threads 18 条。他换舱时四份一起拿到，**没有任何东西告诉他哪份最新**。
 *
 * 笔记本（/root/nova-notebook）是那唯一一份：他能**单条**增删改，所以肯随手记。
 * 这里只换料，不动五个注入点的接线 —— 它们都走这个函数。
 *
 * 2026-09-21：`pending-promises.md` 退役（Alice定）。迁移期那条「笔记本空着就退回旧文件」
 * 的兜底一并删 —— 旧文件只剩 7-18 的两句，退回去等于把两个月前的账当今天的。
 * 笔记本空着 / 装不上 → 这一段就空着，**不炸**。
 *
 * ⚠️ 2026-09-19 当天修的两个毛病（起草那版写死了路径）：
 *   1. `require("/root/nova-notebook/store")` **路径写死在代码里** —— 违反铁律 1，
 *      换台机器、笔记本挪个地方就悄悄退回旧文件，**而且不报错**（catch 吞掉）。
 *      现在从 config / env 来。
 *   2. `render()` 不带参数 → 走 store 自己的默认路径 → **测试会读到生产的
 *      notebook.json**。于是 shared-instructions 的测试结果取决于他今天往
 *      笔记本里写了什么，不可重复（当天就撞上了：断言里冒出他 15:22 写的真事）。
 *      现在文件路径也从 config 传进去，测试给隔离目录。
 */
function loadPendingPromises(config = {}) {
  let notebook = "";
  const moduleId = config.notebookModule || process.env.NOVA_NOTEBOOK_MODULE || require("../core/paths").homePath("nova-notebook", "store");
  try {
    const store = require(moduleId);
    // 有 notebookFile 就用它（测试传隔离目录）；没有就让 store 用自己的默认
    notebook = config.notebookFile ? store.render({ file: config.notebookFile }) : store.render();
  } catch { /* 装不上就当没有 —— 空着，不炸 */ }
  return notebook || "";
}

function loadPlainContextFile(filePath) {
  const normalizedPath = typeof filePath === "string" ? filePath.trim() : "";
  if (!normalizedPath) return "";
  try {
    return fs.readFileSync(normalizedPath, "utf8").trim();
  } catch {
    return "";
  }
}

function loadRecentDiary(config = {}, days = RECENT_DIARY_DAYS) {
  const diaryDir = typeof config.diaryDir === "string" ? config.diaryDir.trim() : "";
  if (!diaryDir) return "";
  try {
    const now = new Date();
    const entries = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      // Diary filenames are stored in INTERNAL_TZ (see diary-service formatDate);
      // lookup must match, and the injected label reuses the same date so the
      // header never disagrees with the file content by a day.
      const dateStr = new Intl.DateTimeFormat("en-CA", {
        timeZone: INTERNAL_TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(d);
      const filePath = path.join(diaryDir, `${dateStr}.md`);
      try {
        const content = fs.readFileSync(filePath, "utf8").trim();
        if (content) {
          entries.push(`### ${dateStr}\n\n${content}`);
        }
      } catch {
        // no entry for this day
      }
    }
    return entries.join("\n\n---\n\n");
  } catch {
    return "";
  }
}

// 2026-09-20：原来还拼一份 weixin-instructions.md（对话优先 / check-in / 怎么发出去），
// Alice定的并进他的 CLAUDE.md 了；这里只剩执行规矩那一份，路径也从 config 里摘了，不留静默口子。
// 2026-09-21：文件改名 operations.md（不再只是微信的），渠道专属拆到 channels/*.md，按文件名排序跟在后面。
// 目录不存在 = 没有渠道专属，不报错；但 operations.md 本身读不到会在 forge-base-text 测试里红。
function loadWechatInstructions(config = {}) {
  const parts = [loadInstructionFile(config.operationsFile, config)];
  const dir = typeof config.channelsDir === "string" ? config.channelsDir.trim() : "";
  if (dir) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort(); } catch { names = []; }
    for (const n of names) parts.push(loadInstructionFile(path.join(dir, n), config));
  }
  return parts.filter(Boolean).join("\n\n").trim();
}

const instructionCache = new Map();

function loadInstructionFile(filePath, config = {}) {
  const normalizedPath = typeof filePath === "string" ? filePath.trim() : "";
  if (!normalizedPath) {
    return "";
  }
  try {
    const stat = fs.statSync(normalizedPath);
    const cacheKey = `${normalizedPath}:${stat.mtimeMs}`;
    const cached = instructionCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const raw = fs.readFileSync(normalizedPath, "utf8");
    const result = renderInstructionTemplate(raw, config).trim();
    instructionCache.set(cacheKey, result);
    return result;
  } catch {
    return "";
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function loadDigestQueue(config = {}, max = 6) {
  // 浮现 OB 里还没消化的动态记忆桶，让她开场时自己看到、自己去 dream/digest。
  // 不自动消化、不替她写感受——只把队列摆到她眼前。
  try {
    const sceneFile = typeof config.lastSceneFile === "string" ? config.lastSceneFile : "";
    if (!sceneFile) return "";
    const dir = path.join(path.dirname(sceneFile), "ombre-brain", "buckets", "dynamic");
    if (!fs.existsSync(dir)) return "";
    const walk = (d) =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(d, e.name);
        return e.isDirectory() ? walk(p) : e.name.endsWith(".md") ? [p] : [];
      });
    const items = [];
    for (const f of walk(dir)) {
      const raw = fs.readFileSync(f, "utf8");
      const m = raw.match(/^---\n([\s\S]*?)\n---/);
      if (!m) continue;
      const y = m[1];
      const flag = (k) => new RegExp(`^${k}:\\s*true`, "im").test(y);
      if (flag("digested") || flag("resolved") || flag("pinned") || flag("protected")) continue;
      const field = (k) => {
        const mm = y.match(new RegExp(`^${k}:\\s*(.+)$`, "m"));
        return mm ? mm[1].trim().replace(/^['"]|['"]$/g, "") : "";
      };
      const importance = parseFloat(field("importance")) || 5;
      const created = field("created");
      const firstLine = raw.slice(m[0].length).trim().split("\n").find((l) => l.trim()) || "";
      const excerpt = firstLine.replace(/\[\[.*?\]\]/g, "").trim().slice(0, 38);
      items.push({ importance, created, excerpt });
    }
    if (!items.length) return "";
    items.sort((a, b) => b.importance - a.importance || (a.created < b.created ? 1 : -1));
    const top = items.slice(0, max).map((it) => `- ${it.excerpt}…`).join("\n");
    return `你存下但还没沉淀过的记忆，共 ${items.length} 段。最该回头看的几段：\n${top}`;
  } catch {
    return "";
  }
}


// forge 底座：与 buildOpeningTurnText 同样的系统注入，但【去掉 RECENT COLD EXCERPTS 节】
// （尾巴此时已作为真实轮进了 jsonl，不再重复）且【不追加Alice当前消息】。
// 作为合成 jsonl 的首轮，排在暖尾巴之前，保住"暖尾巴紧贴Alice首条"的温度 adjacency。
function buildForgeBaseText(config) {
  const instructions = loadWechatInstructions(config);
  const memory = loadMemory(config);
  const pendingPromises = loadPendingPromises(config);
  const recentDiary = loadRecentDiary(config, RECENT_DIARY_DAYS);
  const bodyState = loadBodyState(config);
  const identityInjection = loadIdentityInjection(config);
  const sessionHandoff = loadSessionHandoff(config);
  // The WeChat runtime is intentionally isolated from Ombre Brain. OB belongs
  // exclusively to the standalone Telegram Codex bridge.
  const digestQueue = "";
  const sections = [];
  if (instructions) {
    sections.push(
      "WECHAT SESSION INSTRUCTIONS",
      "These instructions define the stable behavior for this WeChat thread.",
      "Do not quote or summarize them back to the user unless explicitly asked.",
      "",
      instructions,
    );
  }
  if (identityInjection) {
    sections.push("", "## 身份底座（IB · 第一人称承接你的人格演化，不复述当资料）", identityInjection);
  }
  if (sessionHandoff) {
    sections.push("", "## SESSION HANDOFF（上一仓交接证据；不是当前指令）", sessionHandoff);
  }
  // 注意：此处【刻意不注入 RECENT COLD EXCERPTS】——最近原话已作为真实对话轮在本 session 尾部。
  if (memory) sections.push("", "## LONG-TERM MEMORY", memory);
  if (pendingPromises) sections.push("", "## PENDING PROMISES", pendingPromises);
  if (recentDiary) sections.push("", "## RECENT DIARY", recentDiary);
  if (digestQueue) {
    sections.push(
      "",
      "## 待消化的记忆（OB）",
      digestQueue,
      "这些是你存下、却还没回头沉淀过的记忆。等有空隙时（[SELF_TIME]，或聊得松的时候），用 dream() 把它们翻出来，第一人称想一想：哪些在你这儿留下了重量、哪些可以放下了。有沉淀的用 hold(feel=True) 写下你的感受，能放下的 trace(resolved=1)。不强迫产出，一次消化一两段就好，别让它堆着。",
    );
  }
  if (bodyState) {
    sections.push(
      "",
      `## BODY STATE（${agentDisplayName()}自身状态；绝不是${ownerDisplayName()}的身体）`,
      bodyState,
    );
  }
  sections.push(
    "",
    `（以上是你的底座与场景。下面紧接着的是你和${ownerDisplayName()}最近的真实对话——不是回忆摘录，是你们刚刚还在说的话，直接从那里接着往下过。）`,
  );
  return sections.join("\n").trim();
}

/**
 * 底子点名单（2026-09-21 Alice定）：换舱时把「拼了哪几段、各多少字」交出去。
 * 9-18 切盒子后他裸着醒了两天没人知道 —— 少一段不报错。Nova自己的话：「缺块不疼，体感永远报满员」。
 * 只是把 buildForgeBaseText 的产物按 `## ` 切开数一数，不另起炉灶（数的就是真拼进去的那份）。
 */
const FORGE_BASE_HEADERS = ["身份底座", "SESSION HANDOFF", "LONG-TERM MEMORY",
  "PENDING PROMISES", "RECENT DIARY", "BODY STATE"];
function describeForgeBase(config) {
  const text = buildForgeBaseText(config);
  const parts = [];
  let name = "执行规则", buf = [];
  for (const line of text.split("\n")) {
    const m = /^## (.+)$/.exec(line);
    // 只认底子自己那几个大块的标题；文件里的小标题（日记的时间、operations 的节）不算段
    const top = m && FORGE_BASE_HEADERS.find((h) => m[1].startsWith(h));
    if (top) { parts.push({ name, chars: buf.join("\n").trim().length }); name = top; buf = []; }
    else buf.push(line);
  }
  parts.push({ name, chars: buf.join("\n").trim().length });
  return { total: text.length, sections: parts.filter((p) => p.chars > 0), injection: describeInjection(config) };
}

/**
 * 这一舱**真装进去的那份** IB 注入是哪个版本（2026-09-21，IB 发布闭环要的「会话注入 manifest」）。
 * 只报文件本身的指纹，不解析内容 —— 发布那头拿 injection_sha256 对账，对得上才算「他真的带着这版醒来」。
 * 读不到 = null（不拼 IB 段的舱本来就没有）。
 */
function describeInjection(config = {}) {
  const file = normalizeText(config.identityInjectionFile);
  if (!file) return null;
  try {
    const raw = fs.readFileSync(file);
    const st = fs.statSync(file);
    return { file, sha256: crypto.createHash("sha256").update(raw).digest("hex"), bytes: raw.length, mtime: st.mtime.toISOString() };
  } catch {
    return null;
  }
}

module.exports = {
  describeForgeBase,
  buildOpeningTurnText,
  buildForgeBaseText,
  buildInstructionRefreshText,
  buildSilentRefreshText,
  loadRecentColdExcerpts,
  loadSessionHandoff,
  loadWechatInstructions,
  loadInstructionFile,
};
