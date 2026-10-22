"use strict";

/**
 * 造一个盒子（运行时 + 五条口 + 人格注入）
 *
 * 2026-09-18 从 `main.js` 摘出来的。摘的原因：盒子要搬进**自己的进程**
 * （Alice：「别的都是盒子外面的插头 插头坏了拔下来重新插就可以 没必要动盒子」）。
 * 2026-09-20 晚起只有 `box-host.js`（nova-box）一个用户 —— 桥自带盒子那条路
 * （`GATE_BOX=claudecode` 走 main.js）删了，没有回滚路是故意的。
 *
 * 这个文件不属于桥（在 `src/host/` 下），所以可以认识 claude。
 */

const fs = require("fs");
const path = require("path");
const { createHistory } = require("../box/history");

/** 冷层尾巴 —— 人格编排开场白要的料。**只读**，绝不回写。 */
function readColdTail(file, n) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 坏行跳过，不让一行挡住整包 */ }
  }
  return out.slice(-n);
}

/**
 * 底子那份 config（forge 开新舱拼在最前面的料：buildForgeBaseText 要读的全部路径）。
 * 2026-10-22 摘出来：面板（src/panel）要在子进程里用**同一份**口径预演「下次换舱拼什么」，
 * 不许另抄一份路径表 —— 抄一份迟早漂。buildBox 照旧把它摊进 runtime 的 config。
 */
function forgeBaseConfig(cfg) {
  const stateDir = path.join(cfg.root, "state");
  return {
    // ⚠️ forge 就靠这份料（换舱时把最近冷层原话当真实轮塞回新舱）。
    // 这个文件对 runtime 是**只读**的，不会拿老格式回写污染四字段。
    conversationSourceFile: cfg.coldFile,
    sessionHandoffStateFile: path.join(stateDir, "handoff.json"),
    enableSessionHandoff: false,
    workspaceRoot: cfg.workspaceRoot,
    // ——— 底子：forge 开新舱时拼在最前面的那六段（`src/box/instructions.js` buildForgeBaseText）———
    // 老桥 config.js 是按状态目录自动拼这几条；9-18 搬进盒子时漏了，2026-09-20 补回。
    // 一条都别省：少一条他换舱就少一段记忆，而且不报错（读不到路径 = 那段静默不拼）。
    // 2026-09-21 relationship.yaml 退役（笔记本 + CLAUDE.md 接手），七段变六段。
    memoryFile: path.join(cfg.memoryDir, "memory.md"),
    bodyStateFile: path.join(cfg.memoryDir, "body-state.txt"),
    operationsFile: path.join(cfg.memoryDir, "operations.md"),          // 全渠道执行规则（2026-09-21 从 weixin-operations.md 改名）
    channelsDir: path.join(cfg.memoryDir, "channels"),                  // 渠道专属：channels/*.md 按文件名排序拼在后面
    diaryDir: path.join(cfg.memoryDir, "diary"),
    identityInjectionFile: cfg.identityInjectionFile,
    // 这一舱真装进去的 IB 注入指纹落这儿（2026-09-21）：IB 发布闭环拿它当「会话注入 manifest」对账
    injectionManifestFile: path.join(stateDir, "injection-loaded.json"),
    // 笔记本（PENDING PROMISES 那段的料）。不传就让 store 走它自己的默认文件 ——
    // 测试必须传隔离文件，否则底子测试会读到生产 notebook.json（9-21 真撞上过：他刚写的一条把断言弄红）。
    notebookModule: cfg.notebookModule || process.env.NOVA_NOTEBOOK_MODULE || "",
    notebookFile: cfg.notebookFile || process.env.NOVA_NOTEBOOK_FILE || "",
  };
}

/**
 * @param {object} o
 * @param {object} o.cfg      `main.js` 的 readConfig 产物
 * @param {object} o.backend  BOXES[kind]
 * @param {object} o.persona  loadPersona 产物
 * @param {function} o.log
 * @returns {Promise<{runtime, box}>}
 */
async function buildBox({ cfg, backend, persona, log = () => {} }) {
  // 运行时会在 stateDir 底下开一个 unix socket，**它假定这个目录已经存在**
  // （生产里 ~/.nova 一直都在，所以这个洞从没暴露过；换个新家第一次起就炸：
  //  ENOENT chmod …/claudecode-runtime.sock）。这儿先把家建好。
  const stateDir = path.join(cfg.root, "state");
  fs.mkdirSync(stateDir, { recursive: true });

  // 全本（S1）：GATE_HISTORY=on 才有，关着是 null —— 运行时和盒子拿到 null 就是原来的行为。
  const history = createHistory({ root: cfg.root, persona: cfg.personaName || "", log });

  const runtime = backend.runtime({
    stateDir,
    sessionsFile: path.join(stateDir, "sessions.json"),
    ...forgeBaseConfig(cfg),
    // 开场注入归**盒子 + 人格**管（见 persona.js）。运行时自带的那一包必须关掉，
    // 否则它会把人格那一段裹进 `Current user message:`，标成她说的话。
    disableOpeningPack: true,
    claudeCommand: cfg.claudeCommand,
    claudeModel: cfg.model,
    claudeConfigDir: "",
    claudeExtraArgs: [
      ...(cfg.systemPromptFile ? ["--system-prompt-file", cfg.systemPromptFile] : []),
      ...(cfg.fallbackModel ? ["--fallback-model", cfg.fallbackModel] : []),
      // 屋顶 mod（2026-10-03）：改 Claude Code 自己塞给他的系统提示和英文提醒。
      // 空着就等于没装，不用改代码。见 /root/nova-roof/。
      ...(process.env.GATE_PLUGIN_DIR ? ["--plugin-dir", process.env.GATE_PLUGIN_DIR] : []),
      // 桥自己的工具（tools/ 目录那些）——**另给一份 config**，不动运行时管的那份
      "--mcp-config", path.join(cfg.root, "mcp-im-bridge.json"),
    ],
    // ⚠️ 必须跟生产同一挡。"bypassPermissions" 会让 CLI 带 --dangerously-skip-permissions，
    // claude 在 root 下**拒绝启动**（2026-09-18 实测 code 1）。
    claudePermissionMode: cfg.claudePermissionMode,
    claudeDisableVerbose: false,
    history,
  });
  if (typeof runtime.initialize === "function") await runtime.initialize();

  const box = backend.make({
    runtime, bindingKey: cfg.bindingKey, workspaceRoot: cfg.workspaceRoot,
    model: cfg.model, persona, log, history,
    // 供料：人格要编排就得有东西可排。**冷层从这儿递过去**，
    // 别让人格自己去摸文件 —— 那就又变成「各处各抄一份」了。
    personaContext: async () => ({ coldTail: (n = 40) => readColdTail(cfg.coldFile, n) }),
  });

  return { runtime, box };
}

module.exports = { buildBox, readColdTail, forgeBaseConfig };
