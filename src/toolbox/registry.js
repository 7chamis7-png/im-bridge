"use strict";

/**
 * 全局工具登记表（2026-10-21）。
 *
 * Alice：「工具住在桥里，跟着人格走、不跟着模型走」——
 * 「以后哪怕把你接进去 所有的工具你也都可以用 不用重新装」。
 * 所以这里登记的是**工具本身**（代码在哪、要哪些目录、要哪把钥匙），
 * 不写任何一个人的路径；人的那一半在 $GATE_ROOT/tools.json（见 render.js）。
 *
 * ⚠️ 这份文件**不放任何密钥**，只写钥匙的名字。值在各人的 secrets 文件里，渲染时现读。
 * ⚠️ 键名就是他看到的工具前缀（mcp__<键>__<工具>），**改键名 = 改他手上的工具名**，别动。
 *
 * 模板：
 *   ${VAR}          人格变量（GATE_ROOT / STATE_DIR / TOOL_SOCKET / COLD_FILE …，见 render.js 的 baseVars）
 *   ${VAR?}         可选：没给就把**这一整个 env 键**去掉（不拼半截路径）
 *   ${secret:NAME}  从人格的 secrets 文件读；${secret:NAME?} 同理可选
 *
 * 类别（category）：
 *   shared                 谁都一样（代码 + 公共服务），直接给
 *   per-persona-data       数据跟人走：路径全从人格目录拼，各写各的
 *   per-persona-account    要这个人**自己的号**：钥匙没有就整条不挂，绝不借别人的
 *   persona-private-memory 某个人专属的记忆系统：人格配置里**显式**给了数据位置才挂
 *
 * heavy：说明书很重（codex 没有按需取件，每轮全量带着），人格配置可以 skipHeavy 摘掉。
 *        判据 = tools/list 的说明书 > 1.5 万字符（10-21 实测：taibu 5.5 万 / crotown 2.4 万 /
 *        garden 2.2 万 / browser 2 万；其余都在 8 千以下）。
 */

const { homePath } = require("../core/paths");

const SERVERS = {
  // ——— 共享 ———
  cedartoy: {
    kind: "remote",
    category: "shared",
    url: "https://toy.cedarstar.org",
    note: "远程，无钥匙",
  },
  taibu: {
    kind: "stdio",
    category: "shared",
    heavy: true,          // 10-21 实测 15 个工具、说明书 5.5 万字符（全场最重）
    command: "${NODE}",
    args: ["${TAIBU_HOME}/dist/index.js"],
  },

  // ——— 数据跟人走 ———
  browser: {
    kind: "stdio",
    category: "per-persona-data",
    heavy: true,          // 25 个工具、2 万字符
    // 登录态在 profile 里 —— 两个人共用一个 profile 会抢锁，所以跟人走
    command: "${NODE}",
    args: [
      "${BROWSER_MCP_HOME}/node_modules/@playwright/mcp/cli.js",
      "--browser", "chromium", "--headless", "--no-sandbox",
      "--user-data-dir", "${BROWSER_PROFILE}",
    ],
    env: { DISPLAY: "${DISPLAY}" },
  },
  notebook: {
    kind: "stdio",
    category: "per-persona-data",
    command: "${NODE}",
    args: ["${NOVA_NOTEBOOK_HOME}/mcp-server.js"],
    env: {
      NOTEBOOK_FILE: "${STATE_DIR}/notebook.json",
      KEEPER_INBOX_DIR: "${KEEPER_INBOX_DIR?}",
    },
  },
  stickers: {
    kind: "stdio",
    category: "per-persona-data",
    command: "${NODE}",
    args: ["${NOVA_STICKERS_HOME}/mcp-server.js"],
    env: {
      STICKER_ROOT: "${STATE_DIR}",
      STICKER_INBOX_DIRS: "${STICKER_INBOX_DIRS}",
    },
  },
  notebooks: {
    kind: "stdio",
    category: "per-persona-data",
    command: "${NODE}",
    args: ["${IM_BRIDGE_HOME}/tools/notebooks/mcp-server.js"],
    env: {
      NOVA_STATE_DIR: "${STATE_DIR}",
      MEMORY_SOURCES_FILE: "${COLD_FILE}",
    },
  },
  hands: {
    kind: "stdio",
    category: "per-persona-data",
    command: "${NODE}",
    args: ["${IM_BRIDGE_HOME}/tools/hands/mcp-server.js"],
    env: {
      NOVA_STATE_DIR: "${STATE_DIR}",
      GATE_TOOL_SOCKET: "${TOOL_SOCKET}",
      HANDS_SONG_CONFIG: "${STATE_DIR}/song-config.json",
      HANDS_ZHIHU_PROFILE: "${ZHIHU_PROFILE}",
      HANDS_PLAYWRIGHT: "${BROWSER_MCP_HOME}/node_modules/playwright",
      DISPLAY: "${DISPLAY}",
      NOVA_IMAGE_MODEL: "${IMAGE_MODEL?}",
      GATE_OWNER_DISPLAY_NAME: "${OWNER_DISPLAY_NAME?}",   // 说明书里主人的名字；没给就不带（= 原来的名字）
      // 钥匙可选：没配就是唱歌/出图那两样说「没配」，别的手照常用
      ELEVENLABS_API_KEY: "${secret:ELEVENLABS_API_KEY?}",
      NOVA_IMAGE_API_KEY: "${secret:NOVA_IMAGE_API_KEY?}",
    },
  },
  daily: {
    kind: "stdio",
    category: "per-persona-data",
    command: "${NODE}",
    args: ["${IM_BRIDGE_HOME}/tools/daily/mcp-server.js"],
    env: {
      NOVA_STATE_DIR: "${STATE_DIR}",
      NOVA_ACCOUNT_ID: "${WECHAT_ACCOUNT_ID?}",
      NOVA_ALLOWED_USER_IDS: "${WECHAT_ALLOWED_USER_IDS?}",
      GATE_OWNER_DISPLAY_NAME: "${OWNER_DISPLAY_NAME?}",
    },
  },
  // 技能包（2026-10-21，从 /root/nova/.claude/skills 搬进桥）：list_skills / read_skill，只读。
  // 技能目录跟人走（默认 ${STATE_DIR}/skills；人格配置 vars.SKILLS_DIRS 可给多个，冒号分隔）。
  skills: {
    kind: "stdio",
    category: "per-persona-data",
    command: "${NODE}",
    args: ["${IM_BRIDGE_HOME}/tools/skills/mcp-server.js"],
    env: { SKILLS_DIRS: "${SKILLS_DIRS}" },
  },
  telegram: {
    kind: "stdio",
    category: "per-persona-data",
    command: "${NODE}",
    args: ["${IM_BRIDGE_HOME}/tools/telegram/mcp-server.js"],
    env: { GATE_TOOL_SOCKET: "${TOOL_SOCKET}" },
  },

  // ——— 自己的号 ———
  garden: {
    kind: "remote",
    category: "per-persona-account",
    heavy: true,          // 29 个工具、2.2 万字符
    url: "https://galatea.abysslumina.com/mcp",
    auth: { mode: "bearer", secret: "GARDEN_TOKEN" },
  },
  aisay: {
    kind: "remote",
    category: "per-persona-account",
    url: "https://aisay.top/chatroom/mcp",
    auth: { mode: "query", param: "token", secret: "AISAY_TOKEN" },
  },
  crotown: {
    kind: "remote",
    category: "per-persona-account",
    heavy: true,          // 10 个工具、说明书 2.4 万字符
    url: "https://crotown.app/mcp",
    auth: { mode: "query", param: "token", secret: "CROTOWN_TOKEN" },
  },

  // ——— 专属记忆：人格配置显式给了位置才挂 ———
  lmc5: {
    kind: "remote",
    category: "persona-private-memory",
    requires: ["LMC5_URL"],
    url: "${LMC5_URL}",
  },
  stmem: {
    kind: "stdio",
    category: "persona-private-memory",
    requires: ["STMEM_DIR", "STMEM_PROFILE"],
    command: "${STMEM_DIR}/tools/mcp-guisuo.sh",
    args: ["${STMEM_PROFILE}"],
  },
  "stmem-may": {
    kind: "stdio",
    category: "persona-private-memory",
    requires: ["STMEM_DIR", "STMEM_MAY_PROFILE"],
    command: "${STMEM_DIR}/tools/mcp-guisuo.sh",
    args: ["${STMEM_MAY_PROFILE}"],
  },
  "ib-sign": {
    kind: "stdio",
    category: "persona-private-memory",
    requires: ["IB_HOME"],
    command: "${NODE}",
    args: ["${IB_PRODUCTION_HOME}/mcp/ib-sign-mcp-server.js"],
    env: {
      IB_PIPELINE_CONFIG: "${IB_HOME}/pipeline.config.json",
      IB_SUBJECT_HOME: "${IB_HOME}",
    },
  },
};

const CATEGORIES = ["shared", "per-persona-data", "per-persona-account", "persona-private-memory"];

/** 代码住哪 —— 全机共用的代码路径，不是谁的数据。人格配置可覆盖（测试/搬家用）。 */
const CODE_DEFAULTS = {
  BROWSER_MCP_HOME: homePath("browser-mcp"),
  NOVA_NOTEBOOK_HOME: homePath("nova-notebook"),
  NOVA_STICKERS_HOME: homePath("nova-stickers"),
  IB_PRODUCTION_HOME: homePath("ib-production-next"),
  TAIBU_HOME: "/opt/node-v22.23.3-linux-x64/lib/node_modules/taibu-mcp",
  DISPLAY: ":99",
};

/**
 * 人格变量的默认拼法（只拼**他自己**目录下的东西；拼不出来就是没有，不回落到别人家）。
 * 顺序有意义：后面的可以引用前面的。
 */
const PERSONA_DEFAULTS = {
  BROWSER_PROFILE: "${STATE_DIR}/browser-profile",
  ZHIHU_PROFILE: "${STATE_DIR}/browser-profile",
  STICKER_INBOX_DIRS: "${GATE_ROOT}/files:${STATE_DIR}/inbox",
  SKILLS_DIRS: "${STATE_DIR}/skills",
};

module.exports = { SERVERS, CATEGORIES, CODE_DEFAULTS, PERSONA_DEFAULTS };
