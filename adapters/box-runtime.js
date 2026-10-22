'use strict';

/**
 * 薄适配：把 im_bridge 的新运行时（runtime/，官方 SDK）套成老盒子认得的样子。
 *
 * 2026-09-20 Alice：「只是拆 cli 外面的线」。所以这里**只换 CLI 那一层**
 * （老的 process-client.js 856 行 + claudecode/index.js 里起进程那半），
 * CLI 外面的东西原样插过来、一行不重写：
 *
 *   · 会话存储   src/box/session-store.js（9-20 重写，**sessions.json 磁盘格式没变**）
 *   · forge      scripts/forge.js（换舱时把冷层原话当真实轮塞回新舱，原样搬过来的）
 *   · 开场注入   本来就在盒子 + 人格里（box-build 关掉了运行时那一包），这里不碰
 *
 * 对外的样子跟 `createClaudeCodeRuntimeAdapter` 一样 —— 盒子（gate-box-claudecode.js）
 * 和 box-host.js 实际用到的那几个口：
 *   initialize / onEvent / sendTurn / startFreshSharedSession / setModelForWorkspace /
 *   cancelTurn / respondApproval / describe / getTurnCapabilities / getSessionStore / close
 * 事件名和字段也照老的（runtime.reply.candidate / runtime.turn.completed / …），
 * 盒子一行不用改。
 *
 * ⚠️ 老代码顺手干的几件事，**逐条搬过来了**（「搬逻辑要连过滤条件一起搬」）：
 *   1. 每轮把她的话喂给脉（8770 心跳）                    → sendTurn
 *   2. 图片读成 base64 塞进消息，>4.5MB 跳过              → buildMessageContent
 *   3. 旁白块当正文候选（签名标签 + 官方 narration 索引）  → mapEvent
 *   4. CLI 造的消息（<synthetic> / refusal）标出来        → isSyntheticMessage
 *   5. 工具许可交给盒子应答（盒子一律放行）                → canUseTool
 *   6. turn timing / first token / model requested/actual 三种日志（电话延迟靠它们）
 *   7. 过滤掉会让子 CLI 以为自己嵌在别的 CLI 里的环境变量
 * 没搬的（查过没人用）：/tmp/cyberboss-thinking.txt（只写不读）、
 * claudecode-runtime.sock 的 IPC（盒子模式下零连接）、nova_system_send 标记（工具已退）。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createRemoteRuntime } = require('../cli-host/client');

/**
 * 2026-09-20 Alice：「再拆一层 现在拆」。CLI 住在 `nova-cli` 里，盒子通过 cli.sock 连过去，
 * **重启盒子不打断他**。
 *
 * 当天晚上：切换期的 `NOVA_CLI_REMOTE` 开关和「CLI 长在盒子进程树上」那条本地路删了
 * （她的规矩：「我们的新版那么好 干嘛要退回旧版」）。要本地起 CLI 只有 `runtime/` 本身，
 * 由 nova-cli 用；这一层只认远端。
 */

// 2026-09-20 起这三样都在 im-bridge 自己家里（会话存储是重写的，另两个是原样搬过来的）。
const { SessionStore } = require('../src/box/session-store');
const { buildForgeBaseText, describeForgeBase } = require('../src/box/instructions');
const trimmer = require('../src/box/trim-transcript');
const forge = require('../scripts/forge');
const scrubber = require('../src/box/transcript-scrub');
const { cutHallucinatedTail } = require('../src/core/hallucination-cut');
const { claudeToNeutral, NEUTRAL } = require('../src/box/history-claude');
const { forgeSwitch, boxEngine } = require('../src/box/forge-switch');
const tailExclude = require('../src/box/tail-exclude');
const modelRegistry = require('../src/box/model-registry');
const { personaConfigPath, readPersonaSpec } = require('../src/host/persona-file');

/** 换引擎（/engine）的几个数，都能用 env 调。 */
const SWITCH_WAIT_MS = () => Number(process.env.GATE_ENGINE_SWITCH_WAIT_MS) || 120_000;
const SWITCH_TAIL_RATIO = () => {
  const r = Number(process.env.GATE_ENGINE_SWITCH_TAIL_RATIO);
  return r > 0 && r < 1 ? r : 0.25;
};
const SWITCH_MIN_TAIL_TOKENS = () => Number(process.env.GATE_ENGINE_SWITCH_MIN_TAIL_TOKENS) || 8_000;
const SWITCH_MIN_TURNS = () => Number(process.env.GATE_ENGINE_SWITCH_MIN_TURNS) || 20;
/** 这个模型没接工具时，人格包后面加的那句（§5.4）。 */
const NO_TOOLS_NOTE = '（这个模型没接工具：清单里什么都没有，就别假装调用过。）';

/** 换引擎卡在哪一步：错误带上步骤名，回执照实说。 */
function stepError(step, reason) {
  const e = new Error(`卡在「${step}」：${reason}`);
  e.step = step;
  return e;
}

/**
 * 续写幻觉擦 transcript 的开关（2026-10-21）。off（默认）/ dry（只记要擦什么）/ on。
 * 每轮现读，改了 env 重启盒子就生效，不碰 nova-cli。
 */
function scrubMode() {
  const v = String(process.env.GATE_HALLUC_SCRUB || '').trim().toLowerCase();
  if (['on', '1', 'true', 'yes', 'legacy'].includes(v)) return 'on';
  if (['dry', 'dry-run', 'dryrun'].includes(v)) return 'dry';
  return 'off';
}

/**
 * S4（2026-10-21）：全本开着时，擦幻觉**先删全本里那份**（redactions.jsonl 写 cut_tail，原文还在主文件），
 * 再照旧擦引擎那份（transcript 外科手术）。`GATE_HALLUC_SCRUB=legacy` = 只擦引擎那份、不写全本（回滚用）。
 */
function scrubLegacy() {
  return String(process.env.GATE_HALLUC_SCRUB || '').trim().toLowerCase() === 'legacy';
}

/** 盒子模式只有一个收件方（桥），路由在桥那头按 trace_id 做。 */
const ORIGIN = { channel: 'box', threadId: 'box', recipient: 'gate' };
const SESSION_WAIT_MS = 30_000;
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;

const FILTERED_ENV = new Set(['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH', 'CLAUDE_EFFORT', 'AI_AGENT']);

const log = (m) => console.log(`[engine-client] ${m}`);
const warn = (m) => console.warn(`[engine-client] ${m}`);
const text = (v) => (typeof v === 'string' ? v.trim() : '');

// 合成判据 / 旁白判据搬到 src/box/claude-judges.js（2026-10-21 S2b）：引擎宿主里的 Claude 插头翻通用事件也要用，
// 两头用同一份，别抄（「搬逻辑要连判据一起搬，抄一份就会两头漂」）。这里照旧导出，老调用点不用改。
const { isSyntheticMessage, isNarration } = require('../src/box/claude-judges');

function hasClaudeImageFileRead(model) {
  const n = text(model).toLowerCase();
  if (!n) return false;
  return n === 'sonnet' || n === 'opus' || n === 'haiku'
    || /\b(?:sonnet|opus|haiku)\b/.test(n) || /^claude-(?:3|4)(?:\b|-)/.test(n);
}

function normalizeImageMediaType(contentType) {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  return ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(ct) ? ct : 'image/jpeg';
}

async function buildMessageContent(body, attachments) {
  const images = (Array.isArray(attachments) ? attachments : []).filter((item) =>
    Boolean(item?.isImage)
    || String(item?.contentType || '').toLowerCase().startsWith('image/')
    || String(item?.kind || '').toLowerCase() === 'image');
  const blocks = [];
  for (const image of images) {
    const abs = text(image?.absolutePath);
    if (!abs) continue;
    try {
      const bytes = await fsp.readFile(abs);
      if (bytes.length > MAX_IMAGE_BYTES) { warn(`图太大跳过 ${abs} (${bytes.length} bytes)`); continue; }
      blocks.push({ type: 'image', source: { type: 'base64',
        media_type: normalizeImageMediaType(image.contentType), data: bytes.toString('base64') } });
    } catch { /* 读不到就跳过；路径还在正文里 */ }
  }
  if (!blocks.length) return body;
  blocks.push({ type: 'text', text: body });
  return blocks;
}

function whichClaude(command) {
  if (path.isAbsolute(command)) return command;
  for (const dir of String(process.env.PATH || '').split(':')) {
    const p = path.join(dir, command);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* 下一个 */ }
  }
  // 2026-10-21：不再当场抛。只跑 codex / deepseek 的机器上根本没装 claude，原来盒子一起来就炸。
  // 找不到 = 不给路径（cli-host 用它自己的 NOVA_CLI_PATH 兜底）；真要起 claude 时那边会说清楚找不到。
  console.error(`[盒子] PATH 里找不到 ${command} —— 只有换到 claude 引擎时才用得上它`);
  return '';
}

/** box-build 给的是 CLI 参数数组；SDK 要的是选项。只认盒子实际会给的三种，别的原样透传。 */
function parseExtraArgs(args) {
  const out = { systemPromptFile: '', fallbackModel: '', mcpConfigs: [], passthrough: {} };
  const list = Array.isArray(args) ? args : [];
  for (let i = 0; i < list.length; i += 1) {
    const flag = list[i];
    const value = list[i + 1];
    if (flag === '--system-prompt-file') { out.systemPromptFile = value; i += 1; }
    else if (flag === '--fallback-model') { out.fallbackModel = value; i += 1; }
    else if (flag === '--mcp-config') { out.mcpConfigs.push(value); i += 1; }
    else if (typeof flag === 'string' && flag.startsWith('--')) {
      const hasValue = typeof value === 'string' && !value.startsWith('--');
      out.passthrough[flag.slice(2)] = hasValue ? value : null;
      if (hasValue) i += 1;
    }
  }
  return out;
}

function readMcpServers(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers || {}; }
  catch (e) { warn(`MCP 配置读不了 ${file}: ${e.message}`); return {}; }
}

function createImBridgeRuntimeAdapter(config) {
  const sessionStore = new SessionStore({ filePath: config.sessionsFile, runtimeId: 'claudecode' });
  const configuredModel = text(config.claudeModel);
  const extra = parseExtraArgs(config.claudeExtraArgs);
  const fallbackModel = text(extra.fallbackModel) || text(process.env.CC_FALLBACK_MODEL);
  const claudePath = whichClaude(config.claudeCommand || 'claude');
  const ingressPath = path.join(config.stateDir, 'im-bridge-ingress.json');
  /** 全本记账员（S1，GATE_HISTORY=on 才有；关着是 null，下面所有 `if (history)` 一行都不走）。 */
  const history = config.history || null;

  let listener = null;
  /** 当前那个 CLI。null = 没起 / 已停，下一轮 sendTurn 再起。 */
  let live = null;            // { rt, workspaceRoot, threadId, model, stopping }
  let launching = null;
  let seq = 0;
  /** uuid -> 这一轮的账（turnId、计时、有没有 CLI 造的消息） */
  const turns = new Map();
  /** requestId -> resolve(decision) */
  const approvals = new Map();
  const auditKeys = new Set();
  /** 正在 sendTurn 里、还没进 turns 表的轮数（擦之前要等它们落地，别把刚递进去的那条腰斩）。 */
  let inflight = 0;
  /** 等着擦的假尾巴（这一轮/之前几轮在正文里看见的 cut 原文）。 */
  let scrubCuts = [];
  /** 正在擦 + 重起 CLI。ensureRuntime 先等它 —— 她这期间来的话就排在这儿，起好了再递。 */
  let scrubbing = null;
  const gateRoot = process.env.GATE_ROOT || path.dirname(config.stateDir);
  const scrubBakDir = process.env.GATE_HALLUC_SCRUB_BAK_DIR || path.join(gateRoot, 'scrub-bak');

  /**
   * S3c（2026-10-21）Iris走桥换舱。codex 的 thread 归 cli 宿主管（codex-thread.json），盒子清掉 sessions.json 那条
   * 它并不知道 —— 原来 /new 之后 codex 插头照样 resume 旧 thread，等于没换。现在：
   *   换舱时盒子记一张「换舱单」（state/codex-rotate.json，带一次性 token，盒子重启也还在），
   *   下一次起引擎把 token 放进 sdkOptions.freshThread 递过去；codex 插头见到没用过的 token 就开新 thread + forge 垫尾巴，
   *   用过的 token 记在 codex-thread.json 里（重连时 client 会把同一份 ensure 再发一遍，不能换第二次）。
   *   起好了盒子就撕单。
   * 只有显式换舱才发 token —— 「sessions.json 里没号」不算（群里的隔离会话、首次起来都没号，不能拿他的主线程去换）。
   */
  /**
   * 模型登记表（S5，$GATE_ROOT/models.json，每次现读）。有登记表：现在是哪家引擎 = 当前模型在表里登记的引擎；
   * 没有登记表（或模型不在表里）：老样子靠 GATE_ENGINE / 模型名推（forge-switch.boxEngine）。
   */
  const loadRegistry = () => modelRegistry.loadModelRegistry({ file: config.modelsFile, env: process.env });
  /** 这个人格「本来」跑哪家（GATE_ENGINE / GATE_MODEL 推出来的）。决定 forge 带不带Nova私有的料（身体态、旧账本）。 */
  const homeEngine = modelRegistry.normalizeEngine(boxEngine({ model: configuredModel })) || 'claude-cli';
  function currentModel(workspaceRoot = '') {
    return resolveModel('', workspaceRoot || (live && live.workspaceRoot) || text(config.workspaceRoot));
  }
  function engineOf(model) {
    const reg = loadRegistry();
    const entry = reg.ok ? modelRegistry.lookup(reg, model) : null;
    if (entry) return entry.engine;
    return homeEngine;
  }
  const currentEngine = (workspaceRoot = '') => engineOf(currentModel(workspaceRoot));
  const isCodex = () => currentEngine() === 'codex-appserver';
  /** 引擎自己管 thread（codex-thread.json / deepseek-thread.json）：换舱要递换舱单。claude 的 thread 在 sessions.json。 */
  const needsTicket = () => currentEngine() !== 'claude-cli';
  const rotateTicketFile = path.join(config.stateDir, 'codex-rotate.json');
  function readRotateTicket() {
    try {
      const t = JSON.parse(fs.readFileSync(rotateTicketFile, 'utf8'));
      return t && typeof t.token === 'string' && t.token ? t : null;
    } catch { return null; }
  }
  function writeRotateTicket(reason) {
    const t = { token: randomUUID(), at: new Date().toISOString(), reason: text(reason) };
    fs.mkdirSync(path.dirname(rotateTicketFile), { recursive: true });
    const tmp = `${rotateTicketFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(t) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, rotateTicketFile);
    return t;
  }
  function tearRotateTicket(token) {
    const t = readRotateTicket();
    if (!t || t.token !== token) return;   // 中间又换了一次舱：新单留着
    try { fs.unlinkSync(rotateTicketFile); } catch { /* 已经没了 */ }
  }

  const emit = (type, payload) => {
    if (!listener) return;
    try { listener({ type, payload }, null); }
    catch (e) { warn(`事件回调炸了（${type}）：${e.message}`); }
  };

  function resolveModel(model = '', workspaceRoot = '') {
    if (configuredModel) return configuredModel;
    if (text(model)) return text(model);
    for (const b of sessionStore.listBindings()) {
      const stored = text(sessionStore.getRuntimeParamsForWorkspace(b.bindingKey, workspaceRoot).model);
      if (stored) return stored;
    }
    // S5：登记表的 default（Iris去掉 GATE_MODEL 之后，第一次起来靠它）
    const reg = loadRegistry();
    return reg.ok ? reg.default : '';
  }

  function turnOf(bindings) {
    const b = bindings && bindings[0];
    const uuid = b && b.uuid;
    if (!uuid) return { uuid: '', turn: null };
    let turn = turns.get(uuid);
    // 盒子重启过：这轮是旧进程发出去的，轮次表里没有。turnId 随 origin 落在 nova-cli 的台账里
    // （2026-09-20 晚起 enqueue 时带上），从那儿捡回来，桥才对得上号。
    if (!turn && b.origin && text(b.origin.turnId)) {
      turn = { turnId: b.origin.turnId, writtenAt: 0, firstOutputAt: 0, firstKind: '', firstTokenAt: 0, synthetic: false, orphan: true };
      turns.set(uuid, turn);
      log(`旧进程发出去的一轮回来了 turn=${turn.turnId}，按台账里的号接上`);
    }
    return { uuid, turn: turn || null };
  }

  /**
   * 全本（S1）：Claude 帧翻成通用事件记下来。**只读** turns 表、不建孤儿轮（那是下面 turnOf 的事），
   * 不改下面老路径的任何行为。不许抛。
   */
  function recordClaudeEvent(event, bindings) {
    try {
      const b = bindings && bindings[0];
      const uuid = (b && b.uuid) || '';
      const t = uuid ? turns.get(uuid) : null;
      const turnId = (t && t.turnId) || (b && b.origin && text(b.origin.turnId)) || '';
      const raw = (event && event.raw) || {};
      const threadId = (live && live.threadId) || raw.session_id || '';
      for (const ev of claudeToNeutral(event, { isNarration, isSyntheticMessage })) history.onNeutral(ev, { uuid, turnId, threadId });
    } catch (e) { warn(`[全本] 记账出错（不影响他说话）：${e.message}`); }
  }

  /**
   * S2a 盒子双认：认得通用事件（imb.event.v1，设计稿 §2.1）。两种包法都认：
   *   { event: {v:'imb.event.v1', …}, bindings }   跟 Claude 帧同一个信封，只是 event 换了形状
   *   { v:'imb.event.v1', turn, origin?, … }         裸事件，归属看 turn（= cli 台账里这一轮的 uuid）
   * 不是这两种就返回 null，走下面原来的 Claude 帧路径（一行没动）。
   */
  function asNeutral(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (payload.v === NEUTRAL) {
      const bindings = Array.isArray(payload.bindings) ? payload.bindings
        : (payload.turn ? [{ uuid: payload.turn, origin: payload.origin || {} }] : []);
      return { ev: payload, bindings };
    }
    if (payload.event && payload.event.v === NEUTRAL) {
      const ev = payload.event;
      const bindings = Array.isArray(payload.bindings) && payload.bindings.length ? payload.bindings
        : (ev.turn ? [{ uuid: ev.turn, origin: ev.origin || {} }] : []);
      return { ev, bindings };
    }
    return null;
  }

  /**
   * 通用事件 → 老盒子认得的事件（设计稿 §2.2 那张表）。跟 Claude 帧那条路**同一套**轮次账、计时日志、
   * 幻觉检测、擦 transcript 的排队，只是读的字段换成中性的。不许抛。
   */
  function onNeutralEvent(ev, bindings) {
    try {
      const { uuid, turn } = turnOf(bindings);
      const turnId = turn ? turn.turnId : '';
      const threadId = (live && live.threadId) || ev.threadId || '';
      if (history) history.onNeutral(ev, { uuid, turnId, threadId });
      if (ev.sidechain) return;                     // 子代理 / 后台任务：只记账，不投
      const n = (v) => (Number.isFinite(Number(v)) && v !== null ? Number(v) : 0);
      const firstOutput = (kind) => {
        if (turn && !turn.firstOutputAt) { turn.firstOutputAt = Date.now(); turn.firstKind = kind; }
      };
      switch (ev.kind) {
        case 'text.delta':
          if (ev.end) { emit('runtime.reply.delta', { threadId, turnId, end: true }); return; }
          if (turn && !turn.firstTokenAt && ev.text) {
            turn.firstTokenAt = Date.now();
            console.log(`[nova] first token turnId=${turnId} write→token=${turn.firstTokenAt - turn.writtenAt}ms kind=text_delta`);
          }
          if (ev.text) emit('runtime.reply.delta', { threadId, turnId, text: ev.text });
          return;
        case 'usage': {
          if (ev.model) auditModel(ev.model, turnId, threadId);
          // runtimeId 这个标签值故意没改名：box-golden-9a332e7.json 金标准逐字节钉着它，桥那头也不读它（S6 改名时一起换）
          const payload = { runtimeId: 'claudecode', threadId, model: text(ev.model),
            inputTokens: n(ev.input), cacheCreationInputTokens: n(ev.cacheWrite),
            cacheReadInputTokens: n(ev.cacheRead), outputTokens: n(ev.output) };
          // 水位只认插头算好的 context（§2.3）；没给才退回四个数相加（跟 Claude 帧那条路同一个口径）
          payload.currentTokens = Number.isFinite(Number(ev.context)) && ev.context !== null ? Number(ev.context)
            : payload.inputTokens + payload.cacheCreationInputTokens + payload.cacheReadInputTokens + payload.outputTokens;
          emit('runtime.context.updated', payload);
          return;
        }
        case 'reasoning': firstOutput('thinking'); return;
        case 'tool.call': firstOutput('tool_use'); return;
        case 'tool.result': return;
        case 'engine.notice':
          log(`[引擎] ${ev.what || '?'} turn=${turnId || '(无)'}${ev.what === 'compacted' ? ' ⚠️ 引擎自己压缩了上下文' : ''}`);
          return;
        case 'text': {
          const synthetic = ev.generatedBy === 'engine';
          if (synthetic && turn) turn.synthetic = true;
          if (ev.model) auditModel(ev.model, turnId, threadId);
          const narration = ev.deliverHint === 'narration';
          firstOutput(narration ? 'thinking' : 'text');
          const body = text(ev.text);
          if (!body) return;
          // codex 的 commentary：不当正文候选，整轮没有正文时才拿它兜底（codex-appserver.js 同一条规矩）
          if (ev.deliverHint === 'commentary') {
            if (turn) turn.commentary = (turn.commentary ? turn.commentary + '\n' : '') + body;
            return;
          }
          if (narration) {
            log(`narration block promoted to text turn=${turnId} chars=${body.length} preview=${JSON.stringify(body.slice(0, 60))}`);
          } else if (turn) turn.lastText = body;
          if (!turn) log(`没有轮在跑时他开口了（${body.length} 字），照老规矩按空 turnId 交给盒子`);
          noteHallucination(body, turnId);
          emit('runtime.reply.candidate', { threadId, turnId, text: body, narration, synthetic });
          return;
        }
        case 'turn.end': {
          if (turn && turn.writtenAt) {
            const now = Date.now();
            const toFirst = turn.firstOutputAt ? turn.firstOutputAt - turn.writtenAt : -1;
            const gen = turn.firstOutputAt ? now - turn.firstOutputAt : -1;
            const queued = live ? live.rt.list('pending').length : 0;
            console.log(`[nova] turn timing turnId=${turnId} write→first=${toFirst}ms first→result=${gen}ms `
              + `total=${now - turn.writtenAt}ms firstKind=${turn.firstKind || 'none'} queuedBehind=${queued}`);
          }
          const status = ev.status || 'ok';
          const errors = Array.isArray(ev.errors) ? ev.errors : [];
          if (status !== 'ok' || ev.synthetic === true) {
            warn(`这一轮引擎报 ${status} turn=${turnId} ${JSON.stringify(errors.length ? errors : (ev.text || '')).slice(0, 200)}`);
          }
          if (status === 'error' || status === 'interrupted') {
            if (uuid) turns.delete(uuid);
            maybeScrub();
            emit('runtime.turn.failed', { threadId, turnId,
              text: `引擎中断（${ev.subtype || status}）` + (errors.length ? '：' + errors.join('；') : '') });
            return;
          }
          const finalText = (typeof ev.text === 'string' && ev.text.trim()) ? ev.text.trim()
            : ((turn && turn.lastText) || (turn && turn.commentary) || '').trim();
          if (uuid) turns.delete(uuid);
          maybeScrub();
          emit('runtime.turn.completed', {
            threadId, turnId, coldLayerExempt: false,
            synthetic: Boolean(turn && turn.synthetic) || ev.synthetic === true || status === 'refused',
            text: finalText,
          });
          return;
        }
        default: return;
      }
    } catch (e) {
      warn(`通用事件翻译出错（不影响引擎）：${e.message}`);
    }
  }

  /** 新运行时的事件 → 老盒子认得的事件。**不许抛**：抛了新运行时会把 CLI 停掉。 */
  async function onRuntimeEvent(payload) {
    // 断线补不全的标记（client 在事件缺口被挤掉时发的 {__incomplete}）不是普通事件。
    // ⚠️ 2026-09-20 踩过：当普通事件处理会读 event.raw 崩掉、把那一轮卡成 unknown、
    //    堵死整个队列，重启Nova就再也起不来。这里认出它、记一笔、直接返回，别当事件。
    //    未完成的轮次交给 watch（CLI done 时清 uncertain）收尾，不在这里对账。
    if (payload && payload.__incomplete) {
      warn(`断线补不全 lastSeq=${payload.lastSeq}→${payload.serverLastSeq}；不当事件处理，未完成轮次留给 watch`);
      if (history) history.noteGap(payload);
      return;
    }
    const neutral = asNeutral(payload);
    if (neutral) { onNeutralEvent(neutral.ev, neutral.bindings); return; }
    const { event, bindings } = payload || {};
    if (history) recordClaudeEvent(event, bindings);
    try {
      const raw = (event && event.raw) || {};
      const { uuid, turn } = turnOf(bindings);
      const turnId = turn ? turn.turnId : '';
      const threadId = (live && live.threadId) || raw.session_id || '';
      if (event.isSubagent) return;               // 子代理的话不是他的话

      if (raw.type === 'stream_event') {
        if (turn && !turn.firstTokenAt && raw.event?.type === 'content_block_delta') {
          turn.firstTokenAt = Date.now();
          console.log(`[nova] first token turnId=${turnId} write→token=${turn.firstTokenAt - turn.writtenAt}ms `
            + `kind=${raw.event?.delta?.type || '?'}`);
        }
        // 2026-10-21 电话边写边念：正文的字往盒子递，盒子只对来路是 phone 的那轮用（phone-stream.js）
        const ev = raw.event || {};
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          emit('runtime.reply.delta', { threadId, turnId, text: ev.delta.text });
        } else if (ev.type === 'content_block_stop') {
          emit('runtime.reply.delta', { threadId, turnId, end: true });
        }
        return;
      }

      if (raw.type === 'assistant') {
        const message = raw.message || {};
        const synthetic = event.cliGenerated || isSyntheticMessage(message);
        if (synthetic && turn) turn.synthetic = true;
        // 一个 assistant 帧拆成几块事件，usage / 模型只在第一块处理一次
        if (!event.blockIndex) {
          if (message.model) auditModel(message.model, turnId, threadId);
          if (message.usage && typeof message.usage === 'object') {
            const u = message.usage;
            const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
            const payload = { runtimeId: 'claudecode', threadId, model: text(message.model),
              inputTokens: n(u.input_tokens), cacheCreationInputTokens: n(u.cache_creation_input_tokens),
              cacheReadInputTokens: n(u.cache_read_input_tokens), outputTokens: n(u.output_tokens) };
            payload.currentTokens = payload.inputTokens + payload.cacheCreationInputTokens
              + payload.cacheReadInputTokens + payload.outputTokens;
            emit('runtime.context.updated', payload);
          }
        }
        const kind = event.kind;
        if (turn && !turn.firstOutputAt && (kind === 'text' || kind === 'thinking' || kind === 'narration'
          || event.block?.type === 'tool_use')) {
          turn.firstOutputAt = Date.now();
          turn.firstKind = event.block?.type || kind;
        }
        const narration = isNarration(event);
        const body = kind === 'text' ? text(event.text)
          : narration ? text(event.text || event.block?.thinking) : '';
        if (!body) return;
        if (narration) {
          log(`narration block promoted to text turn=${turnId} chars=${body.length} preview=${JSON.stringify(body.slice(0, 60))}`);
        }
        if (!turn) log(`没有轮在跑时他开口了（${body.length} 字），照老规矩按空 turnId 交给盒子`);
        noteHallucination(body, turnId);
        emit('runtime.reply.candidate', { threadId, turnId, text: body, narration, synthetic });
        return;
      }

      if (event.kind === 'result') {
        if (turn && turn.writtenAt) {
          const now = Date.now();
          const toFirst = turn.firstOutputAt ? turn.firstOutputAt - turn.writtenAt : -1;
          const gen = turn.firstOutputAt ? now - turn.firstOutputAt : -1;
          const queued = live ? live.rt.list('pending').length : 0;
          console.log(`[nova] turn timing turnId=${turnId} write→first=${toFirst}ms first→result=${gen}ms `
            + `total=${now - turn.writtenAt}ms firstKind=${turn.firstKind || 'none'} queuedBehind=${queued}`);
        }
        if (raw.is_error === true || raw.subtype !== 'success') {
          warn(`这一轮 CLI 报失败 turn=${turnId} subtype=${raw.subtype} ${JSON.stringify(raw.errors || raw.result || '').slice(0, 200)}`);
        }
        // 执行中断（作废 / 被打断）：老代码这时是进程关了 → turn.failed，照旧报失败
        if (raw.subtype !== 'success') {
          if (uuid) turns.delete(uuid);
          maybeScrub();
          emit('runtime.turn.failed', { threadId, turnId,
            text: `CLI 中断（${raw.subtype}）` + (Array.isArray(raw.errors) ? '：' + raw.errors.join('；') : '') });
          return;
        }
        // ⚠️ 擦 transcript 必须在发 completed **之前**排上：桥收到 completed 才递下一条，
        // 那一条进 ensureRuntime 时 scrubbing 已经在了，会排队等擦完、CLI 重起好再递。
        if (uuid) turns.delete(uuid);
        maybeScrub();
        // 正常收尾（含 is_error 的 API 报错）发 completed：报错那段文字也要让她看到，只是不算他说的话
        emit('runtime.turn.completed', {
          threadId, turnId, coldLayerExempt: false,
          synthetic: Boolean(turn && turn.synthetic) || raw.is_error === true,
          text: typeof raw.result === 'string' ? raw.result.trim() : '',
        });
      }
    } catch (e) {
      warn(`事件翻译出错（不影响 CLI）：${e.message}`);
    }
  }

  // ——— 续写幻觉：擦 transcript（2026-10-21）———
  // 出闸那头（outbound.js）只切冷层；他自己的 CLI 历史里那条假入站还在，下一轮他会照着学
  // （10-20 夜一晚升级三次）。这里：看见了就记下，这一轮完、他静下来，停 CLI → 擦 → resume 同一条会话。
  // 不往里写任何「你幻觉了」的话。发给她的那份照旧原文（Alice要看）。

  function noteHallucination(body, turnId) {
    const mode = scrubMode();
    if (mode === 'off') return;
    const r = cutHallucinatedTail(body);
    if (!r.cut) return;
    const cut = r.cut.trimEnd();
    if (!scrubCuts.includes(cut)) scrubCuts.push(cut);
    // S4：先删桥里那份（只在真擦的时候；干跑只记日志）。引擎那份等他静下来再擦（maybeScrub）。
    if (history && mode === 'on' && !scrubLegacy()) {
      const reds = history.redactHallucination({ turnId, body, newText: r.text, cut, kind: r.kind }) || [];
      log(`[擦幻觉] 全本先删：覆盖层写了 ${reds.length} 条 cut_tail turn=${turnId || '(无)'}`);
    }
    log(`[擦幻觉] 正文里看见 ${r.kind}（${r.cut.length} 字）turn=${turnId || '(无)'}，这轮完了${mode === 'dry' ? '干跑' : '擦'}`);
  }

  /** 他是不是静下来了：没有在跑/排着的轮、没有半路的 sendTurn、CLI 台账里也没有排着的。 */
  function idle() {
    if (turns.size > 0 || inflight > 0) return false;
    if (live) {
      try { if (live.rt.list('pending').length || live.rt.list('started').length) return false; }
      catch { /* 台账读不到就按空闲算：CLI 都停了 */ }
    }
    return true;
  }

  function appendGateEvent(ev) {
    // 跟 undo.js 一样直接追加：O_APPEND 一行，不碰 state.json 的计数（那归 nova-gate 进程）
    try {
      fs.appendFileSync(path.join(gateRoot, 'events.jsonl'),
        JSON.stringify({ kind: 'transcript.hallucination_scrub', at: new Date().toISOString(), ...ev }) + '\n', { mode: 0o600 });
    } catch (e) { warn(`[擦幻觉] 账本写不进去：${e.message}`); }
  }

  /** 每轮收尾（和 sendTurn 收尾）调一次。条件够了就排上；不够就等下一次。 */
  function maybeScrub() {
    if (!scrubCuts.length || scrubbing) return null;
    const mode = scrubMode();
    if (mode === 'off') { scrubCuts = []; return null; }
    if (!idle()) { log(`[擦幻觉] 他还没静下来（turns=${turns.size} inflight=${inflight}），等下一轮收尾`); return null; }
    const cuts = scrubCuts;
    scrubCuts = [];
    const entry = live;
    const workspaceRoot = entry ? entry.workspaceRoot : '';
    let threadId = entry ? entry.threadId : '';
    if (!threadId) {
      for (const b of sessionStore.listBindings()) {
        const ws = workspaceRoot || text(b.activeWorkspaceRoot);
        const t = sessionStore.getThreadIdForWorkspace(b.bindingKey, ws);
        if (t) { threadId = t; break; }
      }
    }
    if (!workspaceRoot || !threadId) { warn('[擦幻觉] 找不到在跑的会话，这次不擦'); return null; }
    const file = trimmer.transcriptPath(workspaceRoot, threadId);
    if (mode === 'dry') {
      // 干跑不停 CLI：只读文件算一遍。等一小会儿让 CLI 把最后几行写完。
      setTimeout(() => {
        const r = scrubber.applyScrub({ file, cuts, dryRun: true });
        log(`[擦幻觉·干跑] thread=${threadId.slice(0, 8)} ok=${r.ok} 会擦 ${r.hits ? r.hits.length : 0} 处正文、`
          + `${r.echoes ? r.echoes.length : 0} 处复述、拿掉 ${r.removedLines || 0} 行${r.reason ? ' ' + r.reason : ''}`);
        appendGateEvent({ dryRun: true, threadId, ok: r.ok, hits: r.hits || [], echoes: r.echoes || [],
          removedLines: r.removedLines || 0, reason: r.reason || '' });
      }, 1500).unref?.();
      return null;
    }
    const model = entry ? entry.model : resolveModel('', workspaceRoot);
    scrubbing = (async () => {
      const t0 = Date.now();
      await stopLive({ reason: '擦续写幻觉（resume 同一条会话）' });
      const r = scrubber.applyScrub({ file, cuts, backupDir: scrubBakDir });
      if (r.ok && r.changed) {
        log(`[擦幻觉] thread=${threadId.slice(0, 8)} 擦了 ${r.hits.length} 处正文、${r.echoes.length} 处复述、拿掉 ${r.removedLines} 行；`
          + `${r.bytesBefore}→${r.bytesAfter}B 备份 ${r.backup}`);
      } else if (r.ok) warn(`[擦幻觉] transcript 里没对上（正文里看见过 ${cuts.length} 处），没动文件`);
      else warn(`[擦幻觉] 没擦成，原文件一字不动：${r.reason}`);
      appendGateEvent({ threadId, ok: r.ok, changed: Boolean(r.changed), hits: r.hits || [], echoes: r.echoes || [],
        removedLines: r.removedLines || 0, backup: r.backup || '', reason: r.reason || '' });
      // 马上把 CLI 起回来（resume 同一条），她下一条不用再等冷启动
      try { await launchRuntime(workspaceRoot, threadId, model); }
      catch (e) { warn(`[擦幻觉] 重起 CLI 失败，下一轮 sendTurn 再起：${e.message}`); }
      log(`[擦幻觉] 完事，用时 ${Date.now() - t0}ms`);
    })().catch((e) => warn(`[擦幻觉] 出错：${e.message}`)).finally(() => { scrubbing = null; });
    return scrubbing;
  }

  function auditModel(actual, turnId, threadId) {
    const key = `${threadId}\0${turnId}\0${actual}`;
    if (auditKeys.has(key)) return;
    auditKeys.add(key);
    if (auditKeys.size > 500) auditKeys.clear();
    const requested = (live && live.model) || configuredModel || '';
    console.log(`[engine-client] model requested_model=${requested || '(default)'} actual_model=${actual} `
      + `fallback=${Boolean(requested && actual && requested !== actual)}`);
  }

  async function canUseTool(toolName, input, options = {}) {
    const requestId = options.toolUseID || randomUUID();
    if (!listener) return { behavior: 'allow', updatedInput: input };
    const decision = await new Promise((resolve) => {
      approvals.set(requestId, resolve);
      options.signal?.addEventListener?.('abort', () => { approvals.delete(requestId); resolve('decline'); });
      emit('runtime.approval.requested', {
        requestId, toolName, input,
        commandTokens: toolName === 'Bash' && typeof input?.command === 'string' ? [input.command] : undefined,
        threadId: live ? live.threadId : '',
      });
    });
    return decision === 'accept'
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: "The user denied this tool use. Stop and wait for the user's instructions." };
  }

  /** CLI 自己没了（不是我们叫停的）：在跑的那轮报失败，下一轮再起。 */
  function watch(entry) {
    entry.rt.done.then(
      () => { if (!entry.stopping) warn('CLI 自己退出了'); },
      (e) => { if (!entry.stopping) warn(`CLI 中断：${e.message}`); },
    ).finally(() => {
      if (live === entry) live = null;
      if (entry.stopping) return;
      for (const [uuid, turn] of turns) {
        const row = entry.rt.get(uuid);
        if (row && row.state === 'uncertain') {
          emit('runtime.turn.failed', { threadId: entry.threadId, turnId: turn.turnId, text: row.error || 'CLI 中断' });
          turns.delete(uuid);
        }
      }
      try { entry.rt.close().catch(() => {}); } catch { /* 已关 */ }
      // 还有排着没发出去的：马上接着起，别让她那几条干等下一条消息
      let pending = 0;
      try { pending = entry.rt.list('pending').length; } catch { /* 已关 */ }
      if (pending && entry.threadId) {
        warn(`还有 ${pending} 条排着，3 秒后接着起`);
        setTimeout(() => {
          if (!live && !launching) ensureRuntime(entry.workspaceRoot, entry.threadId, entry.model)
            .catch((e) => warn(`接着起失败：${e.message}`));
        }, 3000).unref?.();
      }
    });
  }

  async function stopLive({ reason = '' } = {}) {
    const entry = live;
    if (!entry) return;
    entry.stopping = true;
    live = null;
    log(`停 CLI：${reason}`);
    try { await entry.rt.close(); } catch (e) { warn(`停的时候报错（已停）：${e.message}`); }
  }

  /**
   * 连 nova-cli 的那条线。**一个进程只开一条**：它自带退避重连和断线补发，
   * 每次换 CLI 都新建一条会把事件号（游标）搞乱，等于重复投递。
   */
  let remoteRuntime = null;
  function remote() {
    if (remoteRuntime) return remoteRuntime;
    remoteRuntime = createRemoteRuntime({
      // ⚠️ socket 跟 box.sock / tools.sock 一样住 GATE_ROOT，**不是** config.stateDir
      //    （后者是 GATE_ROOT/state，台账在那儿）。两头算错一个就永远连不上。
      socketPath: process.env.NOVA_CLI_SOCKET
        || path.join(process.env.GATE_ROOT || config.stateDir, 'cli.sock'),
      ingressPath,
      cursorPath: path.join(config.stateDir, 'cli-cursor.json'),
      onEvent: onRuntimeEvent,
      callbacks: {
        canUseTool,
        stderr: (t) => { if (t) console.error(`[engine-client] stderr: ${t}`); },
      },
    });
    // 盒子正常退出时把游标补齐，下次起来一条都不重放
    const flush = () => { try { remoteRuntime.flushCursor(); } catch {} };
    process.once('SIGTERM', flush);
    process.once('SIGINT', flush);
    process.once('exit', flush);
    return remoteRuntime;
  }

  /** 擦 transcript 期间来的都在这儿排着，擦完、CLI 起回来再往下走（不丢、也不递给旧 CLI）。 */
  async function ensureRuntime(workspaceRoot, threadId, model) {
    while (scrubbing) await scrubbing.catch(() => {});
    return launchRuntime(workspaceRoot, threadId, model);
  }

  /**
   * 起（或复用）引擎。opts（S5 换引擎用）：{ engine, freshToken, rebuild } —— 不给就按登记表推引擎、按换舱单走（老路）。
   * 登记表里有这个模型：want.engine 跟着它，宿主不一样就换芯；没有：不带 engine（宿主用它默认那家，跟原来一样）。
   */
  async function launchRuntime(workspaceRoot, threadId, model, opts = {}) {
    if (launching) await launching.catch(() => {});
    const reg = loadRegistry();
    const entry = reg.ok ? modelRegistry.lookup(reg, model) : null;
    const engine = opts.engine || (entry ? entry.engine : '');
    if (live && live.workspaceRoot === workspaceRoot
      && (!threadId || !live.threadId || live.threadId === threadId)
      && (!model || live.model === model)
      && (!engine || !live.engine || live.engine === engine)
      && !opts.freshToken) return live;
    await stopLive({ reason: '会话/模型变了，换一个' });
    // 换舱单（见 readRotateTicket 那段）：只在「没号可续」时才用 —— 有号就是续，单子留给真正开新舱那次
    const ticket = !opts.freshToken && !threadId && (engine ? engine !== 'claude-cli' : needsTicket()) ? readRotateTicket() : null;
    const freshToken = opts.freshToken || (ticket ? ticket.token : '');
    // 2026-10-22 Iris /new 也带底子（Alice：「Iris的 forge 肯定要跟Nova一样」）。
    // claude 的底子在 sendTurn 里由 forgeOpening 合成进 transcript；codex 的 thread 归 cli 宿主，
    // 盒子只能把**同一个** buildForgeBaseText 拼出来的料递过去（sdkOptions.forgeBase），插头开新 thread 时
    // 把它当第一条（她那一侧的）消息垫在暖尾巴前面 —— 跟 claude 合成的新舱同一个形状。
    // 只在「可能开新 thread」时拼（没号可续）；/engine 换引擎自己带底子（opts.rebuild），这里不再递第二份。
    // 开关跟 claude 同一个（forgeSwitch：$GATE_ROOT/tools.json 的 forge）。
    let forgeBase = '';
    if (!threadId && !opts.rebuild && (engine || engineOf(model)) === 'codex-appserver' && forgeSwitch({ log }).on) {
      try { forgeBase = buildForgeBaseText(config) || ''; }
      catch (e) { warn(`底子拼不出来（这次新舱只垫尾巴）：${e.message}`); }
    }
    launching = (async () => {
      // 台账修剪归 nova-cli（cli-host/server.js）：台账只能有一个活着的拥有者，盒子这头只读。
      // 工作目录里的 .mcp.json 由 CLI 自己读（实测：不传它也会自动加载），这里不碰、也不再写回。
      // 2026-09-20 删：原来每次起 CLI 都调 ensureClaudeProjectMcpConfig，把老 nova_tools
      // 写回 .mcp.json —— 删了又回来就是它干的。Alice：「不是不加载 而是拿掉」。
      let mcpServers = {};
      for (const f of extra.mcpConfigs) mcpServers = { ...mcpServers, ...readMcpServers(f) };
      // 登记表说这个模型没接工具（§5.4）：不挂 MCP，人格包后面加一句
      const noTools = Boolean(entry && !entry.tools);
      if (noTools) mcpServers = {};
      let systemPrompt = extra.systemPromptFile ? fs.readFileSync(extra.systemPromptFile, 'utf8') : undefined;
      if (noTools) systemPrompt = [systemPrompt, NO_TOOLS_NOTE].filter(Boolean).join('\n\n');
      const env = {};
      for (const [k, v] of Object.entries(process.env)) if (!FILTERED_ENV.has(k)) env[k] = v;
      const sdkOptions = {
        env,
        mcpServers,
        permissionMode: config.claudePermissionMode || 'default',
        canUseTool,
        includePartialMessages: String(process.env.GATE_CLAUDE_PARTIAL || '').toLowerCase() === 'on',
        stderr: (chunk) => { const t = String(chunk).trim(); if (t) console.error(`[engine-client] stderr: ${t}`); },
        ...(model ? { model } : {}),
        ...(fallbackModel && fallbackModel !== model ? { fallbackModel } : {}),
        ...(threadId ? { resume: threadId } : {}),
        ...(freshToken ? { freshThread: freshToken } : {}),
        ...(opts.rebuild ? { rebuild: opts.rebuild } : {}),
        ...(forgeBase ? { forgeBase } : {}),
        // 登记表里引擎那一家要的东西（只给对应的插头用；Claude 那根在宿主里会剥掉）
        ...(entry && entry.codexConfig ? { codexConfig: entry.codexConfig } : {}),
        ...(entry && entry.engine === 'openai-chat' ? { engineCreds: { secret: entry.secret || '', baseUrl: entry.baseUrl || '' } } : {}),
        // ⚠️ 必须显式给：SDK 不给时会在初始化里塞一份**空**系统提示（sdk.mjs: s===void 0 → p=""）
        ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        ...(Object.keys(extra.passthrough).length ? { extraArgs: extra.passthrough } : {}),
      };
      log(`launching engine=${engine || '(宿主默认)'} cwd=${workspaceRoot} resume=${threadId || '(新会话)'} model=${model || '(默认)'} `
        + `mcp=${Object.keys(mcpServers).join(',') || (noTools ? '(这个模型没接工具)' : '')}${freshToken ? ` 换舱单=${freshToken.slice(0, 8)}` : ''}`);
      // 函数过不了 socket：canUseTool / stderr 留在这头，由 nova-cli 那边回头调过来。
      const { canUseTool: _c, stderr: _s, ...wire } = sdkOptions;
      const rt = remote();
      await rt.ensure({ workspaceRoot, threadId: threadId || '', model, claudePath, ingressPath,
        ...(engine ? { engine } : {}), sdkOptions: wire });
      const liveEntry = { rt, workspaceRoot, threadId: threadId || '', model, stopping: false,
        engine: engine || text(rt.status().engine) };
      live = liveEntry;
      // ⚠️ watch 必须在 start 之后：start 之前 rt.done 是个现成的已完成 Promise，
      // 先挂上去会立刻判「CLI 自己退出了」把它关掉（冒烟测试第一次就栽在这）。
      try { await rt.start(); }
      catch (e) { if (live === liveEntry) live = null; throw e; }
      watch(liveEntry);
      if (freshToken) {
        // 起好了 = 插头已经开了新 thread 并把 token 记进自己的 thread 文件，撕单（/engine 的 token 不在单子上，撕不到也没事）
        tearRotateTicket(freshToken);
        const sid = text(rt.status().sessionId);
        if (sid) liveEntry.threadId = sid;
        log(`换舱单 ${freshToken.slice(0, 8)} 已用：新 thread=${sid ? sid.slice(0, 13) : '(还没报)'}`);
      }
      // codex 插头报回来它这次真垫了底子（开了新 thread 才会垫；续上旧的就没用上）：点一遍名，跟 claude 那条日志同一个口径
      const forged = (() => { try { return rt.status().forged || null; } catch { return null; } })();
      if (forgeBase && forged && forged.base) {
        try {
          const d = describeForgeBase(config);
          log(`forge/codex 底子 ${d.sections.length} 段 ${d.total} 字（实交 ${forged.baseChars} 字${forged.omitted && forged.omitted.length ? `，${forged.omitted.join('/')} 已在开发者指令里、没再带` : ''}，${forged.via}）：`
            + d.sections.map((x) => `${x.name}(${x.chars})`).join(' · '));
        } catch { /* 点名失败不挡 */ }
      }
      return liveEntry;
    })();
    try { return await launching; } finally { launching = null; }
  }

  async function waitForSessionId(entry) {
    const deadline = Date.now() + SESSION_WAIT_MS;
    while (Date.now() < deadline) {
      const sid = entry.rt.status().sessionId;
      if (sid) return sid;
      if (live !== entry) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    return '';
  }

  /** 换引擎进行中：sendTurn 先在这儿排着（她这期间来的话等新引擎起好再递，跟擦幻觉同一个排法）。 */
  let switching = null;

  /** 人格包大概多大（token，按 UTF-8 字节/2 估，跟 forge capTail 一个口径）：系统提示 + 人格文件 + 底子。 */
  function personaTokens(baseText) {
    let bytes = Buffer.byteLength(String(baseText || ''), 'utf8');
    try { if (extra.systemPromptFile) bytes += fs.statSync(extra.systemPromptFile).size; } catch { /* 没有就不算 */ }
    try {
      const spec = readPersonaSpec(personaConfigPath());
      if (spec && spec.personaFile) bytes += fs.statSync(spec.personaFile).size;
    } catch { /* 没有就不算 */ }
    return Math.ceil(bytes / 2);
  }

  /**
   * /engine：跨厂商换引擎（设计稿 §5.3，Alice 10-21 定成「一次正规换舱」）。gate 那头已经送过收尾轮、等过这一轮说完。
   *   1. 查表、钱闸、钉没钉、新窗口装不装得下人格包 + 最低尾巴 —— 不过就拒，什么都不动
   *   2. 等他静下来（idle）；这期间进来的话排着
   *   3. 尾巴：全本（过对账）或冷层，按**新窗口**预算整轮装（forge.selectTail，跟换舱同一套）
   *   4. 新插头的版本闸 + 重建：claude = 合成 transcript 逐条核对；codex = 新 thread + inject + 回读；DeepSeek = 新对话本
   *   5. 宿主换芯（ensure 带 want.engine），人格包按新插头重交；盒子这头下一轮重注身份
   *   6. 成功才改 sessions.json（模型 + 新舱号）、记 state/engine-switches.jsonl、出回执；
   *      任何一步失败 → 把原引擎原舱起回来，抛「卡在哪一步」
   */
  async function switchEngine({ workspaceRoot, reason = '', target }) {
    const ws = text(workspaceRoot) || text(config.workspaceRoot);
    const reg = loadRegistry();
    if (!reg.exists) throw stepError('查登记表', `没有模型登记表（${reg.file || '$GATE_ROOT/models.json'}），不能换引擎`);
    if (!reg.ok) throw stepError('查登记表', reg.errors[0] || '读不了');
    const to = modelRegistry.lookup(reg, target.model);
    if (!to) throw stepError('查登记表', `登记表里没有「${target.model}」—— 不猜`);
    if (configuredModel) throw stepError('查配置', `GATE_MODEL 钉死了 ${configuredModel}，换了也是白换 —— 先把它从 env 里去掉（默认模型改由 models.json 的 default 给）`);
    const fromModel = currentModel(ws);
    const from = modelRegistry.lookup(reg, fromModel);
    const fromEngine = engineOf(fromModel);
    if (to.engine === fromEngine) throw stepError('查登记表', `「${to.id}」跟现在一样是 ${to.engine} 的 —— 同一家换模型用 /model ${to.id}`);
    const money = modelRegistry.billingAllowed(to, process.env);
    if (!money.ok) throw stepError('钱闸', money.why);
    let baseText = '';
    try { baseText = buildForgeBaseText(config) || ''; } catch (e) { warn(`[换引擎] 底子拼不出来（照换，只是没有底子）：${e.message}`); }
    const pTok = personaTokens(baseText);
    const budget = Math.floor(to.window * SWITCH_TAIL_RATIO()) - pTok;
    if (budget < SWITCH_MIN_TAIL_TOKENS()) {
      throw stepError('算窗口', `${to.id} 的窗口 ${to.window.toLocaleString()} × ${SWITCH_TAIL_RATIO()} 减掉人格包约 ${pTok.toLocaleString()} token，`
        + `只剩 ${Math.max(0, budget).toLocaleString()}，装不下最低的尾巴（${SWITCH_MIN_TAIL_TOKENS().toLocaleString()}）`);
    }

    // 干跑（gate 在送收尾轮之前先问一句「能不能换」）：前面这些闸都过了就回，什么都不动
    if (target.dryRun) {
      return { dryRun: true, engineSwitch: { dryRun: true, model: to.id, label: to.label, engine: to.engine,
        window: to.window, verified: to.verified, budget, from: { model: fromModel, engine: fromEngine } } };
    }
    if (switching) throw stepError('排队', '上一次换引擎还没完');
    let release;
    switching = new Promise((r) => { release = r; });
    const t0 = Date.now();
    try {
      // 2. 等他静下来
      const deadline = Date.now() + SWITCH_WAIT_MS();
      while (!idle() || scrubbing) {
        if (Date.now() > deadline) throw stepError('等这一轮说完', `等了 ${Math.round(SWITCH_WAIT_MS() / 1000)} 秒他还没静下来`);
        await new Promise((r) => setTimeout(r, 100));
      }
      // 3. 尾巴
      const privateMaterial = homeEngine === 'claude-cli';   // 身体态 / 旧账本是Nova一个人的，别垫进别人的舱
      let picked;
      try {
        picked = forge.selectTail({ conversationSourceFile: config.conversationSourceFile, workspaceRoot: ws,
          historyDir: history && history.dir ? history.dir : '', maxTokens: budget,
          withBody: privateMaterial, oldOutboxDb: privateMaterial, log });
      } catch (e) { throw stepError('挑尾巴', e.message); }
      const cap = picked.cap || {};
      if (cap.droppedTurns > 0 && cap.keptTurns < Math.min(SWITCH_MIN_TURNS(), cap.turns || 0)) {
        throw stepError('算窗口', `${to.id} 的窗口只装得下最近 ${cap.keptTurns} 轮（最少要 ${Math.min(SWITCH_MIN_TURNS(), cap.turns)} 轮）`);
      }
      const oldThread = (() => {
        if (live && live.threadId) return live.threadId;
        for (const b of sessionStore.listBindings()) { const t = sessionStore.getThreadIdForWorkspace(b.bindingKey, ws); if (t) return t; }
        return '';
      })();

      // 4. 新插头的版本闸 + 重建
      let threadId = '';
      let launchOpts = { engine: to.engine };
      let synth = null;
      let tailRecords = picked.tail.length;
      if (to.engine === 'claude-cli') {
        try { await forge.ensureVersionPinned({ model: to.id, log, force: true }); }
        catch (e) { throw stepError('Claude 版本闸', e.message); }
        const r = forge.forgeOpening({ baseText, conversationSourceFile: config.conversationSourceFile, workspace: ws,
          model: to.id, notify: null, force: true, picked,
          ...(history && history.dir ? { historyDir: history.dir } : {}) });
        if (!r.ok) throw stepError('Claude 版本闸 / 合成新舱', r.reason);
        const v = forge.verifySynth({ jsonlPath: r.jsonlPath, tail: [{ role: 'user', text: baseText }, ...picked.tail], sid: r.sid });
        if (!v.ok) { try { fs.unlinkSync(r.jsonlPath); } catch {} throw stepError('核对合成的新舱', v.reason); }
        synth = r;
        threadId = r.sid;
      } else {
        const tail = [...(baseText ? [{ role: 'user', text: baseText }] : []), ...picked.tail];
        launchOpts = { engine: to.engine, freshToken: randomUUID(), rebuild: { tail, strict: true } };
      }

      // 5. 宿主换芯
      await stopLive({ reason: `换引擎 ${fromEngine} → ${to.engine}` });
      let started;
      try { started = await launchRuntime(ws, threadId, to.id, launchOpts); }
      catch (e) {
        if (synth) { try { fs.unlinkSync(synth.jsonlPath); } catch {} }
        let back = '';
        try {
          await stopLive({ reason: '换引擎没成，回原引擎' });
          await launchRuntime(ws, oldThread, fromModel, { engine: fromEngine });
          back = `已回到 ${fromModel || fromEngine}（原来那一舱 ${oldThread ? oldThread.slice(0, 8) : '(没号)'}）`;
        } catch (e2) { back = `⚠️ 原引擎也没起回来（${e2.message}），她下一句会再起一次`; }
        warn(`[换引擎] 失败：${e.message}；${back}`);
        throw stepError('起新引擎', `${e.message}；${back}`);
      }
      const st = (() => { try { return started.rt.status() || {}; } catch { return {}; } })();
      const sid = threadId || text(st.sessionId);
      if (!sid) throw stepError('起新引擎', '新引擎没报会话号');
      started.threadId = sid;

      // 6. 落账
      let clearedBindings = 0;
      for (const b of sessionStore.listBindings()) {
        const had = sessionStore.getThreadIdForWorkspace(b.bindingKey, ws);
        if (had) { sessionStore.clearThreadIdForWorkspace(b.bindingKey, ws); clearedBindings += 1; }
        sessionStore.setRuntimeParamsForWorkspace(b.bindingKey, ws, { model: to.id, modelProvider: '' });
        if (had || text(b.activeWorkspaceRoot) === ws) sessionStore.setThreadIdForWorkspace(b.bindingKey, ws, sid);
      }
      turns.clear();
      const old = readRotateTicket(); if (old) tearRotateTicket(old.token);
      const rebuilt = st.rebuilt || null;
      const receipt = {
        from: { model: fromModel, engine: fromEngine },
        model: to.id, label: to.label, engine: to.engine, window: to.window, verified: to.verified,
        threadId: sid, turns: cap.keptTurns || 0, records: tailRecords, droppedTurns: cap.droppedTurns || 0,
        source: picked.source, injected: rebuilt ? rebuilt.injected : tailRecords + (baseText ? 1 : 0),
        base: Boolean(baseText), budget, degraded: modelRegistry.degradations(from, to, cap),
        fullRecompute: true, ms: Date.now() - t0,
      };
      try {
        fs.appendFileSync(path.join(config.stateDir, 'engine-switches.jsonl'), JSON.stringify({
          at: new Date().toISOString(), reason: text(reason), from: { ...receipt.from, threadId: oldThread },
          to: { model: to.id, engine: to.engine, threadId: sid }, turns: receipt.turns, records: receipt.records,
          droppedTurns: receipt.droppedTurns, source: receipt.source, degraded: receipt.degraded }) + '\n', { mode: 0o600 });
      } catch (e) { warn(`[换引擎] 流水写不进去（不挡）：${e.message}`); }
      log(`[换引擎] ${fromEngine}/${fromModel} → ${to.engine}/${to.id} 新舱 ${sid.slice(0, 13)}，垫了 ${receipt.turns} 轮（${receipt.source}），用时 ${receipt.ms}ms`);
      { const c = tailExclude.consumeTailExclude(undefined, { usedBy: `engine-switch/${to.engine}`, threadId: sid });
        if (c.used) log(`[换引擎] 用掉了排除名单（${c.used} 条），已清空`); }
      let base = null;
      try { base = describeForgeBase(config); } catch { /* 点名失败不挡 */ }
      return { workspaceRoot: ws, clearedBindings, base, threadId: sid, engineSwitch: receipt };
    } finally {
      switching = null;
      release();
    }
  }

  const api = {
    describe() {
      // 没钉死（GATE_MODEL 空）时报 sessions.json 里存的那个 —— /model 热切写的就是它；
      // 原来只报 configuredModel，一解钉就成了「(默认)」，/model 选单上的 ✓ 也打不上（2026-09-23）。
      let model = configuredModel;
      if (!model) {
        for (const b of sessionStore.listBindings()) {
          const ws = (live && live.workspaceRoot) || text(b.activeWorkspaceRoot);
          model = text(sessionStore.getRuntimeParamsForWorkspace(b.bindingKey, ws).model);
          if (model) break;
        }
      }
      // S5：报现在是哪家引擎、登记表里这个模型的窗口（/model /engine 的按钮、/status 的分母靠它）
      const reg = loadRegistry();
      const cur = model || (reg.ok ? reg.default : '');
      const entry = reg.ok ? modelRegistry.lookup(reg, cur) : null;
      return { id: 'engine', kind: 'runtime', command: claudePath, sessionsFile: config.sessionsFile,
        model: model || cur, engine: (live && live.engine) || engineOf(cur),
        window: entry ? entry.window : null, registered: Boolean(entry), pinned: Boolean(configuredModel) };
    },
    onEvent(fn) {
      if (typeof fn !== 'function') return () => {};
      listener = fn;
      return () => { if (listener === fn) listener = null; };
    },
    getSessionStore() { return sessionStore; },
    getTurnCapabilities({ model = '' } = {}) {
      return { nativeImageInput: false, toolImageRead: hasClaudeImageFileRead(resolveModel(model)) };
    },
    async initialize() {
      fs.mkdirSync(config.stateDir, { recursive: true });
      // ⚠️ 起来就连 nova-cli，别等她下一条消息。2026-09-20 17:39 踩过：盒子在一轮被接收之后
      // 重启，CLI 照常把那轮跑完、结果进 nova-cli 的缓冲；新盒子只在 sendTurn 时才连过去，
      // 而桥要等这轮结束才发下一条 —— 两头互等，他明明答了她却收不到。
      // 连上就 attach，缓冲里欠的事件当场补回来。
      remote();
      return { command: claudePath, models: [] };
    },

    async sendTurn({ bindingKey, workspaceRoot, text: body, attachments = [], metadata = {}, model = '' }) {
      const desiredModel = resolveModel(model, workspaceRoot);
      let threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
      if (desiredModel) {
        sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, { model: desiredModel, modelProvider: '' });
      }
      // forge：开新舱那一轮，把冷层原话当真实轮接进新 jsonl 再 resume（跟老代码同一套）
      if (!threadId && metadata?.isolatedGroupSession !== true) {
        let applied = false;
        try {
          const taken = forge.takePrepared({ workspace: workspaceRoot, bindingKey });
          if (taken.ok) { threadId = taken.sid; applied = true; log(`forge 领用预备仓 sid=${taken.sid.slice(0, 8)} tail=${taken.tailCount}`); }
          else if (taken.reason !== 'no prepared session') warn(`forge 预备仓作废: ${taken.reason}`);
        } catch (e) { warn(`forge 领用预备仓出错: ${e.message}`); }
        // 开关按人（$GATE_ROOT/tools.json 的 forge），没写才认旧的 FORGE_ENABLED=true（src/box/forge-switch.js）
        // 盒子里只有 claude 那半（合成 transcript）；codex 的在 cli 宿主里（rebuild-codex.js），这里不碰
        if (!applied && engineOf(desiredModel) === 'claude-cli' && forgeSwitch({ log }).on) {
          // 2026-09-25：CC 自动升级会让版本闸落下来，他下一次换舱静默空降（两天犯了两次）。
          // 开舱前先过一次自动验版：版本没变就是一次字符串比对；变了才放金丝雀，
          // PASS 当场钉上、这次换舱照常注入。失败不拦换舱（照旧回落，跟以前一样）。
          try {
            await forge.ensureVersionPinned({ model: desiredModel || 'claude-opus-4-6', log });
          } catch (e) { warn(`forge 自动验版出错（不拦换舱）: ${e.message}`); }
          try {
            const r = forge.forgeOpening({
              baseText: buildForgeBaseText(config), conversationSourceFile: config.conversationSourceFile,
              handoffStateFile: config.enableSessionHandoff === false ? '' : config.sessionHandoffStateFile,
              workspace: workspaceRoot, model: desiredModel || 'claude-opus-4-6', notify: forge.notify,
              // S3：全本开着就把全本目录递过去，forge 自己决定料源（FORGE_SOURCE=cold 一键回去）、过对账才用
              ...(history && history.dir ? { historyDir: history.dir } : {}),
            });
            if (r.ok) {
              threadId = r.sid;
              // 她在面板上勾掉的那几轮这次已经没带进来 → 名单用掉了，清空（只对下一次生效），记一笔
              { const c = tailExclude.consumeTailExclude(undefined, { usedBy: 'forge/claude', threadId: r.sid });
                if (c.used) log(`forge 用掉了排除名单（${c.used} 条），已清空`); else if (c.error) warn(`排除名单清不掉: ${c.error}`); }
              const d = describeForgeBase(config);
              const inj = d.injection ? ` 注入 ${d.injection.sha256.slice(0, 12)}(${d.injection.bytes}B ${d.injection.mtime.slice(0, 10)})` : ' 注入 无';
              log(`forge opening sid=${r.sid.slice(0, 8)} tail=${r.tailCount}${r.tailSource && r.tailSource !== 'cold' ? ` 料源=${r.tailSource}` : ''} 底子 ${d.sections.length} 段 ${d.total} 字：`
                + d.sections.map((x) => `${x.name}(${x.chars})`).join(' · ') + inj);
              // 会话注入 manifest（2026-09-21）：这一舱真装进去的 IB 注入是哪个版本，落盘给 IB 发布那头对账。
              // 只在 forge 真拼了底子这条路上写 —— 领用预备仓那条路装的是预备时那份，不在这儿冒充。
              if (config.injectionManifestFile) {
                try {
                  const manifest = { schema: 'im-bridge.injection-loaded.v1', at: new Date().toISOString(), threadId: r.sid,
                    workspace: workspaceRoot, injection: d.injection, sections: d.sections, total: d.total };
                  const tmp = config.injectionManifestFile + '.tmp-' + process.pid;
                  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), { encoding: 'utf8', mode: 0o600 });
                  fs.renameSync(tmp, config.injectionManifestFile);
                } catch (e) { warn(`注入 manifest 没写出去: ${e.message}`); }
              }
            }
            else log(`forge fallback: ${r.reason}`);
          } catch (e) { warn(`forge opening errored, fallback: ${e.message}`); }
        }
      }

      const entry = await ensureRuntime(workspaceRoot, threadId, desiredModel);

      // 脉·身体感知：她的话喂给脉，让聊天牵动心跳（失败不挡主流程）
      try {
        await fetch('http://127.0.0.1:8770/bedside/heart-rate/emotion', { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: body }),
          signal: AbortSignal.timeout(2000) });
      } catch { /* 脉不在就算了 */ }

      // 登记表说这个模型看不见图（§5.4）：图不塞进去，正文里说一声（路径还在正文里）
      const visionEntry = (() => { const reg = loadRegistry(); return reg.ok ? modelRegistry.lookup(reg, desiredModel) : null; })();
      const blind = Boolean(visionEntry && !visionEntry.vision);
      const imageCount = (Array.isArray(attachments) ? attachments : []).filter((a) => a && (a.isImage
        || String(a.contentType || '').toLowerCase().startsWith('image/') || String(a.kind || '').toLowerCase() === 'image')).length;
      const content = blind
        ? (imageCount ? `${body}\n\n（她发了 ${imageCount} 张图：[图片]。这个模型看不见图。）` : body)
        : await buildMessageContent(body, attachments);
      const uuid = randomUUID();
      const turnId = `turn-${Date.now()}-${seq += 1}`;
      const turn = { turnId, writtenAt: Date.now(), firstOutputAt: 0, firstKind: '', firstTokenAt: 0, synthetic: false };
      turns.set(uuid, turn);
      if (history) history.linkTurn({ traceId: (metadata && metadata.traceId) || '', turnId, uuid });
      try {
        // ⚠️ 2026-09-20 踩过：这句 list() 原来在 try 外面。CLI 刚崩、live 还没被 watch 清掉时，
        //    nova-cli 那头 requireLive 抛「现在没有活着的 CLI」，没打 notAccepted → 桥记成 unknown
        //    → pump 见 unknown 不开新轮 → 她后面所有话都排死。落盘（enqueue）之前抛的任何错
        //    都是「确定没送进去」，一律打 notAccepted 让桥放心重投。
        const queued = entry.rt.list('pending').length + entry.rt.list('started').length;
        if (queued) console.log(`[nova] turn queued turnId=${turnId} waitingBehind=${queued}`);
        // ⚠️ 必须 await：这是跨进程调用，不等就捕不到下面那个 catch，她的话会静默掉在地上。
        // turnId 跟着 origin 进台账：盒子重启后补发的事件靠它认回这一轮（见 turnOf）
        await entry.rt.enqueue({ uuid, origin: { ...ORIGIN, turnId },
          message: { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, origin: { kind: 'human' } } });
      } catch (e) {
        turns.delete(uuid);
        // 没落盘 = 确定没送进去，盒子可以放心重试。
        // 2026-10-22 例外：请求已经写出去、等回话时超时/断线（client.js 打的 maybeAccepted）——
        // 对面可能已经落盘，不打 notAccepted，让桥记 unknown、推给她用 /pending 决定，
        // 免得桥的自动重投让他把同一句回两遍（生产死信里 10-09 那 3 条就是这种）。
        if (!e || e.maybeAccepted !== true) e.notAccepted = true;
        throw e;
      }

      // codex：thread 号以 cli 宿主报的为准（它自己管 codex-thread.json）。原来这里只认 sessions.json 里那个，
      // 换过 thread 之后标签一直是旧号，日志里「resume=旧 id」是假象（S3c 第 5 条）。claude 那条路不变。
      const reported = (entry.engine ? entry.engine !== 'claude-cli' : needsTicket()) ? text(entry.rt.status().sessionId) : '';
      if (reported && threadId && reported !== threadId) log(`引擎实际在 thread=${reported.slice(0, 13)}，sessions.json 记的是 ${threadId.slice(0, 13)}，改过来`);
      const sid = reported || threadId || await waitForSessionId(entry);
      if (!sid) throw new Error('引擎没报会话号（session id）');
      if (!entry.threadId || reported) entry.threadId = sid;
      sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, sid, metadata);
      emit('runtime.turn.started', { threadId: sid, turnId, telegramInbound: null, channelInbound: null });
      return { threadId: sid, turnId };
    },

    async startFreshSharedSession({ workspaceRoot, reason = '', engine = null }) {
      while (scrubbing) await scrubbing.catch(() => {});   // 擦幻觉正动着同一份文件，等它完
      // S5 /engine：跨厂商 = 一次正规换舱，但**当场**把新舱造好、新引擎起好（失败就留在原引擎），不等下一轮
      if (engine && typeof engine === 'object' && text(engine.model)) return switchEngine({ workspaceRoot, reason, target: engine });
      const ws = text(workspaceRoot);
      await stopLive({ reason: '开新舱' });
      turns.clear();
      let clearedBindings = 0;
      for (const b of sessionStore.listBindings()) {
        if (!sessionStore.getThreadIdForWorkspace(b.bindingKey, ws)) continue;
        sessionStore.clearThreadIdForWorkspace(b.bindingKey, ws);
        clearedBindings += 1;
      }
      // codex / DeepSeek：光清 sessions.json 不够，它们的 thread 在 cli 宿主手里 —— 开一张换舱单，下次起引擎递过去
      if (needsTicket()) {
        try { const t = writeRotateTicket(reason); log(`换舱单 ${t.token.slice(0, 8)} 开好了（${currentEngine()}），下一轮开新 thread`); }
        catch (e) { warn(`换舱单写不出去（这次换舱不会生效）：${e.message}`); }
      }
      // 底子点名单（2026-09-21）：新舱第一轮才真拼，但料就是现在这份 —— 先点一遍名交给她看，
      // 少一段当场看见，不用等他醒来自己报（他自己说体感永远报满员）。
      let base = null;
      try { base = describeForgeBase(config); } catch (e) { warn(`底子点名失败: ${e.message}`); }
      return { workspaceRoot: ws, clearedBindings, base };
    },

    /**
     * 裁工具链（2026-09-21，老桥 app.js maybeAutoRotateThread 那半搬过来）。
     * 决定权在桥（守护看水位），这里只管：找 threadId → 干跑估 → 停 CLI → 落刀。
     * 裁完不清 binding，下一轮 ensureRuntime 照旧 resume 同一条 threadId，读到的就是裁过的文件。
     * 干跑失败按老规矩**保守裁一次**（gain 未知不等于没收益）。
     */
    async trimTranscript({ workspaceRoot, currentTokens = 0, minGain = 80_000, keepRecent = 10 } = {}) {
      while (scrubbing) await scrubbing.catch(() => {});   // 擦幻觉正动着同一份文件，等它完
      const ws = text(workspaceRoot);
      let threadId = '';
      for (const b of sessionStore.listBindings()) {
        const t = sessionStore.getThreadIdForWorkspace(b.bindingKey, ws);
        if (t) { threadId = t; break; }
      }
      if (!threadId) return { trimmed: false, noSession: true, reason: '这个工作目录没有在跑的会话' };
      if (turns.size > 0) return { trimmed: false, busy: true, reason: '他正在说话', threadId };
      // codex 没有 transcript 可裁（历史在 codex 服务端的 rollout 里）。原来这里会干跑失败 →「保守裁一次」→ 白停一次引擎。
      // 直接说裁不了，桥接着走换舱（S3c）。
      if (needsTicket()) return { trimmed: false, threadId, reason: `${currentEngine()} 没有工具链可裁（codex 是这样）` };
      const file = trimmer.transcriptPath(ws, threadId);
      const est = trimmer.estimateTrimGain({ file, currentTokens, keepRecent });
      if (est.ok) log(`[裁剪] 干跑：能裁约 ${(est.ratio * 100).toFixed(1)}% ≈ ${Math.round(est.gain / 1000)}k（水位 ${Math.round(currentTokens / 1000)}k）`);
      else warn(`[裁剪] 干跑失败，保守起见照旧裁一次：${est.reason}`);
      if (est.ok && est.gain < minGain) {
        return { trimmed: false, gain: est.gain, ratio: est.ratio, minGain, threadId, reason: `干跑只能省 ${Math.round(est.gain / 1000)}k < ${Math.round(minGain / 1000)}k` };
      }
      if (turns.size > 0) return { trimmed: false, busy: true, reason: '他正在说话', threadId };
      await stopLive({ reason: '裁工具链' });
      const r = trimmer.applyTrim({ file, keepRecent });
      if (r.ok) log(`[裁剪] ${(r.before / 1048576).toFixed(1)}MB → ${(r.after / 1048576).toFixed(1)}MB，备份 ${path.basename(r.backup)}；不换舱，thread=${threadId.slice(0, 8)} 保留`);
      else warn(`[裁剪] 没成功，原文件保留：${r.reason}`);
      return { trimmed: r.ok, gain: est.ok ? est.gain : null, ratio: est.ok ? est.ratio : null, minGain, threadId,
        before: r.before, after: r.after, backup: r.backup, reason: r.ok ? '' : r.reason };
    },

    /**
     * 重连 CLI（2026-09-21，修 undo 断链根因）。
     * undo 从 transcript 删了行、也把文件内部的链接好了，但**活着的 CLI 内存里还记着
     * 被删那行当「叶子」**，他下一轮写的新行会接到被删的行上 → 断链（今天 447edb59 / 8939e060
     * 两次都是 undo 之后进来的行接到被删行上）。停一下 CLI，下轮 ensureRuntime 照旧 resume
     * 同一条 threadId、从磁盘重读叶子，新行就接对了。不清 binding、不换舱、不裁。
     * 他正在说话就不动（腰斩比断链糟），回 busy 让调用方稍后再来。
     */
    async reloadCli({ workspaceRoot } = {}) {
      while (scrubbing) await scrubbing.catch(() => {});   // 擦幻觉正动着同一份文件，等它完
      const ws = text(workspaceRoot);
      if (turns.size > 0) return { reloaded: false, busy: true, reason: '他正在说话' };
      if (!live || (ws && live.workspaceRoot !== ws)) return { reloaded: false, reason: '没有在跑的 CLI，下轮自然会重读' };
      await stopLive({ reason: 'undo 后重认叶子' });
      return { reloaded: true };
    },

    /**
     * /usage：现在这家引擎的订阅额度 / 余额（引擎宿主去查：codex 问活着的 app-server，claude 读 OAuth 凭据，DeepSeek 查余额）。
     * 查不到就照实说查不到。
     */
    async usage() {
      const model = currentModel();
      const engine = currentEngine();
      const reg = loadRegistry();
      const entry = reg.ok ? modelRegistry.lookup(reg, model) : null;
      const rt = remote();
      if (!rt.connected) return { ok: false, engine, model, why: '引擎宿主没连上（nova-cli / iris-cli 在跑吗）' };
      let r;
      try {
        r = await rt.usage({ engine,
          ...(entry && entry.engine === 'openai-chat' ? { engineCreds: { secret: entry.secret || '', baseUrl: entry.baseUrl || '' } } : {}) });
      } catch (e) {
        const old = /不认识的方法/.test(e.message) ? '（引擎宿主还是老版本，要重启它才认 /usage）' : '';
        r = { ok: false, engine, why: `问引擎宿主没成：${e.message}${old}` };
      }
      return { ...(r && typeof r === 'object' ? r : { ok: false, why: '引擎宿主回了个空' }), engine: (r && r.engine) || engine, model };
    },

    async setModelForWorkspace({ workspaceRoot, model }) {
      const ws = text(workspaceRoot);
      const m = text(model);
      if (!ws || !m) throw new Error('workspaceRoot 和 model 都必填');
      if (configuredModel) {
        throw new Error(`配置钉死了模型 ${configuredModel}（GATE_MODEL），换了也是白换 —— 先改配置`);
      }
      // S5：有登记表就按表来 —— 查不到拒绝；别家的拒绝（/model 只管同一家热切，跨厂商是 /engine = 换舱）；按量计费过钱闸
      const reg = loadRegistry();
      if (reg.exists) {
        if (!reg.ok) throw new Error(`模型登记表读不了：${reg.errors[0] || '?'}`);
        const to = modelRegistry.lookup(reg, m);
        if (!to) throw new Error(`登记表里没有「${m}」—— 不猜，没换。`);
        const cur = currentEngine(ws);
        if (to.engine !== cur) throw new Error(`「${m}」是 ${to.engine} 的，现在跑的是 ${cur}。跨厂商要换舱：/engine ${m}`);
        const money = modelRegistry.billingAllowed(to, process.env);
        if (!money.ok) throw new Error(money.why);
      }
      for (const b of sessionStore.listBindings()) sessionStore.setRuntimeParamsForWorkspace(b.bindingKey, ws, { model: m });
      if (!live || live.workspaceRoot !== ws) return { model: m, applied: 'next-launch' };
      await live.rt.setModel(m);
      live.model = m;
      log(`set_model workspace=${ws} model=${m}`);
      return { model: m, applied: 'live' };
    },

    /** 老代码是直接关进程；这里一样。在跑的那轮留 uncertain（可能已提交，不自动重放）。 */
    async cancelTurn({ threadId, turnId, workspaceRoot }) {
      const entry = live;
      if (!entry || (workspaceRoot && entry.workspaceRoot !== text(workspaceRoot))) return { threadId, turnId };
      await stopLive({ reason: `作废当前这一轮 ${turnId || ''}` });
      for (const [uuid, turn] of turns) {
        const row = entry.rt.get(uuid);
        if (row && row.state !== 'completed') {
          emit('runtime.turn.failed', { threadId: entry.threadId, turnId: turn.turnId, text: '这一轮被作废了' });
        }
        turns.delete(uuid);
      }
      return { threadId, turnId };
    },

    async respondApproval({ requestId, decision }) {
      const resolve = approvals.get(requestId);
      if (!resolve) throw new Error('现在没有在等批准的工具调用');
      approvals.delete(requestId);
      resolve(decision === 'accept' ? 'accept' : 'decline');
      return { requestId, decision: decision === 'accept' ? 'accept' : 'decline' };
    },

    async close() { await stopLive({ reason: '关门' }); },

    /** 测试 / 体检用：现在有没有在擦、排着几处。 */
    _scrubState: () => ({ mode: scrubMode(), scrubbing: Boolean(scrubbing), pending: scrubCuts.length, inflight }),
    /** 测试 / 体检用：现在是哪家、在不在换。 */
    _engineState: () => ({ engine: currentEngine(), model: currentModel(), switching: Boolean(switching), live: live ? { engine: live.engine, model: live.model, threadId: live.threadId } : null }),
  };

  // sendTurn 从进门到落进 turns 表之间有好几个 await（forge、脉、读图），这段时间 turns 里还没它。
  // 记个数：擦之前要等它们都落地，不然刚递进去的那条会被停 CLI 腰斩。
  const rawSendTurn = api.sendTurn;
  api.sendTurn = async function sendTurn(args) {
    // 换引擎期间来的话先排着（不计进 inflight，不然 switchEngine 等 idle 会跟它互等）
    while (switching) await switching.catch(() => {});
    inflight += 1;
    try { return await rawSendTurn.call(api, args); }
    finally { inflight -= 1; maybeScrub(); }
  };
  return api;
}

module.exports = { createImBridgeRuntimeAdapter, parseExtraArgs, isSyntheticMessage, isNarration };
