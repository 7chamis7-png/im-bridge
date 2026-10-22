"use strict";

/**
 * 主进程 —— 新桥当进程跑起来的那个文件（2026-09-18）
 *
 * **这个文件不属于桥**（住在 `src/host/`）。桥是零件，这里是「把零件通上电、
 * 一直开着」的那个开关。在这之前 `src/gate/` 只能靠 `scripts/gate-*.js` 那些
 * 跑几十秒就退出的脚本碰一下亮一下。
 *
 * ⚠️ **从第一天就按「将来要当Nova」写。** 指向测试 bot 它是玩具，指向Nova的
 * token 和会话号它就是Nova —— **切换那天改的是配置，不是代码**。所以这里
 * 一个路径、一个 id、一个 token 都不许写死，全从环境变量来；缺了当场说清楚
 * 缺哪一样，不猜、不给默认值（铁律 1）。
 *
 * **一份代码，一个人格一个进程**（2026-09-18 Alice问「为啥不做个公用的主进程呢」）。
 * 代码这层本来就是公用的 —— 换一套环境变量就是另一个人格。唯一不公用的是盒子，
 * 原来这儿写死了 `makeClaudeCodeBox`；现在按 `GATE_BOX` 选（见下面 BOXES）。
 * Iris要接进来 = 加一个 `gate-box-codex.js` + 在这张表里登记一行，main.js 一行不用改。
 *
 * ⚠️ **但不把几个人格塞进同一个进程**，两条理由：
 *   · **故障隔离** —— 一个人格的盒子挂死会拖垮另一个；Nova掉档和Iris掉档是两回事
 *   · **重启粒度** —— 改Nova的配置要重启，Iris跟着被打断。「动 pm2 先问Alice」
 *     那条规矩的成因就是重启会打断他；公用一个进程 = 每次重启打断所有人
 *
 * 用法：
 *   node src/host/main.js          跑起来
 *   node src/host/main.js --check  只体检不跑（pm2 拉起来之前先验一遍）
 */

const fs = require("fs");
const path = require("path");

const { buildGate } = require("../gate/wire");
const { makeWatch } = require("./watch");
const { buildSharedCapabilities } = require("./gate-capabilities");
const { buildClosingNote } = require("../producers/closing-turn");
const { loadLegs } = require("../gate/plugins");
const { makeToolSocket } = require("../gate/tool-socket");
const { renderToolServers } = require("../toolbox/render");
const { readPersonaSpec } = require("./persona-file");
const { homePath, secretsDir, personaStateDir } = require("../core/paths");
const { groupWakeNames, ownerKey } = require("../core/names");

/**
 * 他的人格文件叫什么（给换舱收尾那段话用）。人格配置写了 personaFile 就用它的文件名，
 * 没写 = 老样子 CLAUDE.md。每次现读：切换那天改了配置不用重启桥。
 */
function selfFileName(cfg) {
  try {
    const spec = readPersonaSpec(cfg.toolsConfigFile);
    if (spec && spec.personaFile) return path.basename(spec.personaFile);
  } catch { /* 读不了就按老名字说 */ }
  return "CLAUDE.md";
}

/**
 * 盒子登记表 —— **底座换人只动这张表，桥和主进程一行不改。**
 *
 * 每个登记项给两样：怎么起一个盒子（`make`），和这个底座**自己那包命令**
 * （`commands`，不属于桥）。加Iris = 写一个 `gate-box-codex.js`，这儿加一行。
 */
/**
 * ⚠️ **每一项都得是「用到才加载」**（2026-09-19，Alice：「cyberboss 是别人的项目
 * 不脱钩我怎么做自己的开源」）。
 *
 * 原来这张表在文件顶上就 `require` 了 claude 那一整套。后果是：桥跑在
 * `GATE_BOX=remote`（盒子在别的进程里、这边一行 claude 代码都用不上）时，
 * 启动**照样**把 cyberboss 别处的 6,080 行装进内存 ——
 * `adapters/runtime` 3,888 + `services` 1,318 + `scripts/forge.js` 690 + `core` 184。
 * 那等于把「桥能不能单独拷出去开源」这件事，堵在一行 require 上。
 *
 * 所以：**函数包着，选中哪一挡才拉哪一挡。** 没选 claudecode，claude 那套一个字节都不进来。
 */
const BOXES = {
  claudecode: {
    make: (...a) => require("./gate-box-claudecode").makeClaudeCodeBox(...a),
    commands: (...a) => require("./gate-commands-claudecode").registerClaudeCodeCommands(...a),
    // ⚠️ 没有 `runtime`：CLI 那一层归 im_bridge（`host/box-host.js` 起盒子时自己装上）。
    //    2026-09-20 搬家时**删掉了**老 cyberboss 的 process-client 那条退路 ——
    //    Alice：「我们的新版那么好 干嘛要退回旧版」。
    //    桥自己一挡（remote）根本不造 runtime，这一项只有「盒子跟桥同进程」时才轮得到。
  },
  /**
   * 盒子在**另一个进程**里（`box-host.js`），这儿只连过去。
   * 2026-09-18 Alice：「别的都是盒子外面的插头 插头坏了拔下来重新插就可以
   * 没必要动盒子」—— 用这一挡，重启桥**不打断他**。
   *
   * 命令那包照旧是 claude 的（桥不认识 claude，但命令本来就不属于桥）。
   * `remote: true` 是给 `buildEverything` 看的：别在这个进程里造 runtime。
   */
  remote: {
    remote: true,
    // 命令那包也是懒的 —— 它是 claude 特有的，将来换底座就换这一行
    commands: (...a) => require("./gate-commands-claudecode").registerClaudeCodeCommands(...a),
  },
};

const log = (m) => console.log(
  new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 19) + " 京时 | " + m,
);

/** 必须给的，缺一个就别启动 —— 不许拿默认值糊过去（铁律 1）。 */
const REQUIRED = [
  ["GATE_ROOT", "桥自己的存储目录（账本/游标/死信/冷层都长在它底下）"],
  // ⚠️ 这里只放**桥自己**要的。腿要什么配置由插头自己说（见 gate/plugins/index.js），
  //    缺了在装配那一步点名 —— 加一条腿不该来动这张表。
  ["GATE_BINDING_KEY", "接哪条会话（sessions.json 里的绑定键）"],
  ["GATE_WORKSPACE_ROOT", "那条会话的工作目录"],
  ["GATE_PREFERRED_CHAT_ID", "他主动说话时发去哪（路由第 4 档）"],
];

/**
 * 认她是谁：每条腿上她的身份键。
 *
 * 渠道怎么收发归插头，**「谁是她」不归**（那是这座桥服务谁的问题）。
 * 形状：`GATE_OWNER_<渠道大写>_ID`，比如 GATE_OWNER_TELEGRAM_ID / GATE_OWNER_WECHAT_ID。
 */
/** 声带：ElevenLabs。没配 key 就给 null —— 那样 synthesize_voice 干脆不注册，
 *  他调 send_voice 会被明确挡下（「缺 synthesize_voice」），而不是发出一段静音。 */
function makeTts(outputDir) {
  if (!String(process.env.ELEVENLABS_API_KEY || "").trim()) return null;
  try {
    const { TtsService } = require("../services/tts-service");
    return new TtsService({ config: { ttsOutputDir: outputDir } });
  } catch (e) {
    log("声带装不上（synthesize_voice 不会注册）：" + ((e && e.message) || e));
    return null;
  }
}

/** 生图。同理：没 key 就不注册，不假装能画。 */
function makeImageGen() {
  const key = process.env.NOVA_IMAGE_API_KEY || process.env.OPENAI_API_KEY || "";
  if (!String(key).trim()) return null;
  try {
    const { ImageGenerationService } = require("../services/image-generation-service");
    return new ImageGenerationService({ config: {
      imageApiKey: key,
      imageModel: process.env.NOVA_IMAGE_MODEL || "",
    } });
  } catch (e) {
    log("画笔装不上（generate_image 不会注册）：" + ((e && e.message) || e));
    return null;
  }
}

/**
 * 认人：每条腿上她的身份键。值可以是**逗号分隔的多个 id**。
 *
 * 一个人在一条腿上有好几个号是常态，不是特例 —— iMessage 上她既可能从手机号
 * 来、也可能从 Apple ID 邮箱来（2026-09-19 接 iMessage 时撞上的）。只认一个，
 * 另一个来的消息就是 `unknown`，私聊直接被挡在门外，而且**两头都没有提示**。
 *
 * @returns {Object<string, string[]>} 渠道 → 她在这条腿上的所有 id
 */
function readOwners(env) {
  const owners = {};
  for (const [k, v] of Object.entries(env)) {
    const m = /^GATE_OWNER_([A-Z0-9_]+)_ID$/.exec(k);
    if (!m || !String(v || "").trim()) continue;
    const ids = String(v).split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length) owners[m[1].toLowerCase().replace(/_/g, "-")] = ids;
  }
  return owners;
}

function readConfig(env = process.env) {
  const kind = String(env.GATE_BOX || "claudecode");
  if (!BOXES[kind]) {
    throw new Error("不认识这个底座：GATE_BOX=" + kind
      + "\n  认识的：" + Object.keys(BOXES).join(" / ")
      + "\n  加一个 = 写 src/host/gate-box-<名字>.js，在 main.js 的 BOXES 里登记一行");
  }
  const missing = REQUIRED.filter(([k]) => !String(env[k] || "").trim());
  if (missing.length) {
    const lines = missing.map(([k, why]) => "  " + k + "  —— " + why);
    throw new Error("主进程缺配置，一个都不许猜：\n" + lines.join("\n"));
  }
  const root = env.GATE_ROOT;
  const list = (k) => String(env[k] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    root,
    ownerId: String(env.GATE_OWNER_TELEGRAM_ID),
    ownerName: ownerKey(env),
    bindingKey: env.GATE_BINDING_KEY,
    workspaceRoot: env.GATE_WORKSPACE_ROOT,
    preferredChatId: String(env.GATE_PREFERRED_CHAT_ID),
    botId: env.GATE_BOT_ID || "",
    botUsername: env.GATE_BOT_USERNAME || "",
    model: env.GATE_MODEL || "",
    // 群：白名单键是 `渠道:群id`（跨平台不撞，见 gate/group.js）
    groupsAllowed: list("GATE_GROUPS_ALLOWED"),
    groupsAlwaysWake: list("GATE_GROUPS_ALWAYS_WAKE"),
    // 群里叫醒他的词（GATE_GROUP_WAKE_NAMES，没给 = [他的名字, 她的名字]，见 core/names.js）
    groupWakeNames: groupWakeNames(env),
    // 群轮挂在群名下，配置键 `telegram:group:<id>`
    groupNames: parseGroupNames(env.GATE_GROUP_NAMES || ""),
    coldFile: env.GATE_COLD_FILE || path.join(root, "cold.jsonl"),
    // 他记着的东西住哪（memory.md / relationship.yaml / last-scene.md / body-state.txt /
    // operations.md / channels/ / diary/）。forge 开新舱拼底子从这儿读。
    // ⚠️ 2026-09-20 发现：9-18 切盒子时这几条路径没搬过来，他换舱等于裸着醒（底子只剩承诺一段）。
    memoryDir: env.GATE_MEMORY_DIR || personaStateDir(env),
    // IB 身份注入那份文本（老桥 CYBERBOSS_IDENTITY_INJECTION_FILE 的默认值）
    identityInjectionFile: env.GATE_IDENTITY_INJECTION_FILE || homePath("identity-brain-v02", "injection.txt"),
    gateEnabledFile: env.GATE_ENABLED_FILE || path.join(root, ".gate-enabled"),
    heartbeatFile: env.GATE_HEARTBEAT_FILE || path.join(root, "heartbeat.json"),
    heartbeatMs: Number(env.GATE_HEARTBEAT_MS || 15_000),
    // 守护：看「还在干活吗」。**只推不动**，绝不自动重启（见 watch.js）。
    // 0 = 不自己守（交给外面的进程守，比如另起一个只跑 watch 的）
    watchMs: Number(env.GATE_WATCH_MS ?? 30_000),
    pollTimeoutSec: Number(env.GATE_POLL_TIMEOUT_SEC || 25),
    producersDir: env.GATE_PRODUCERS_DIR || path.join(root, "producers"),
    // 「注入 + api = Nova」：api 是底座，注入是人格。**两样都从配置来，代码不动。**
    boxKind: env.GATE_BOX || "claudecode",
    owners: readOwners(env),               // 每条腿上「谁是她」
    // 身份宣言那一半（2026-09-18）：Nova的「# 我」那节按他自己投的 B 案搬进了
    // system prompt（e9ca82b），老桥一直用 `--system-prompt-file` 喂。新桥原来
    // 没有这条通道 —— 不补就等于切过去他少了半个自己。人格目录（GATE_PERSONA）
    // 管的是**每轮开场注入**，跟这一层不是一回事：宣言上 system 才不会变成安检门。
    systemPromptFile: env.GATE_SYSTEM_PROMPT_FILE || "",
    // 额外的 MCP 包（住在桥外面的独立工具包，像 /root/nova-notebook）。
    // 一份跟 mcp-im-bridge.json 同格式的 JSON，起盒子时合并进去。
    // ⚠️ 为什么需要这条：`mcp-im-bridge.json` 是**每次起盒子整份重写**的
    //    （见下面 writeFileSync，重写它的是**桥自己**=nova-gate，不是盒子 —— 9-23 更正），
  //    手工往里加的条目活不过一次重启，而且**不报错** ——
    //    2026-09-19 实测：06:23 手工加进去的 notebook，15:11 重启就没了，
    //    症状只是他手上凭空少四个工具，日志一个字都没有。
    extraMcpFile: env.GATE_EXTRA_MCP || "",
    // 2026-10-21 工具跟人走：这个人有哪些工具 = 登记表（src/toolbox/registry.js）+ 他的
    // tools.json（目录 / 钥匙文件 / 关哪几包）。没有这份文件 = 老样子，只认 GATE_EXTRA_MCP。
    toolsConfigFile: env.GATE_TOOLS_CONFIG || path.join(root, "tools.json"),
    // 兜底模型：安全层 flag 掉一轮时没有兜底 = 整轮空掉，她那头什么都收不到，
    // 而且 /new 换线程治不了（不是上下文的问题）。老桥一直带着它。
    fallbackModel: env.GATE_FALLBACK_MODEL || "",
    persona: env.GATE_PERSONA || "",       // 一个目录，或一个导出 {name,opening} 的 .js
    personaName: env.GATE_PERSONA_NAME || "",
    claudeCommand: env.GATE_CLAUDE_COMMAND || "claude",
    claudePermissionMode: env.GATE_CLAUDE_PERMISSION_MODE || "default",
  };
}

/**
 * 读「额外的 MCP 包」那份配置（`GATE_EXTRA_MCP`）。
 *
 * 格式跟 mcp-im-bridge.json 一样：`{ "mcpServers": { "<名字>": {command, args, env} } }`。
 *
 * **坏了就当没有，绝不拦住起盒子** —— 一个工具包的配置写错，不该让他整个人起不来。
 * 但**必须把话说清楚**：静默吞掉正是 9-19 那个坑的形状（他少了四个工具，日志一个字没有）。
 */
function readExtraMcp(file, log = () => {}) {
  if (!file) return {};
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    log("[mcp] ⚠️ GATE_EXTRA_MCP 指的文件读不到，这批工具他这一舱都没有：" + file
      + "（" + String(e.message).split("\n")[0] + "）");
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    log("[mcp] ⚠️ GATE_EXTRA_MCP 不是合法 JSON，这批工具他这一舱都没有：" + file
      + "（" + String(e.message).split("\n")[0] + "）");
    return {};
  }
  const servers = parsed && typeof parsed === "object" ? parsed.mcpServers : null;
  if (!servers || typeof servers !== "object") {
    log("[mcp] ⚠️ GATE_EXTRA_MCP 里没有 mcpServers 这一节，什么也没挂上：" + file);
    return {};
  }
  const out = {};
  for (const [name, spec] of Object.entries(servers)) {
    // 两种形状都收：本地 stdio 包（有 command）和远程 MCP（有 url，如 {"type":"http",...}）。
    // 2026-09-23 补 url 这一支：小镇（crotown）是远程 http MCP，原来这道门只认 command，
    // 把它静默跳过了 —— 症状就是他进不了自己的院子，而清单里一个字都看不出来。
    if (!spec || typeof spec !== "object" || (!spec.command && !spec.url)) {
      log("[mcp] ⚠️ 跳过 " + name + " —— 既没有 command 也没有 url，这条挂不上");
      continue;
    }
    out[name] = spec;
  }
  return out;
}

/**
 * 登记表 + 人格配置 → mcpServers（2026-10-21）。没有 tools.json 返回 {}（老样子）。
 * 配置坏了 = 这一舱只有 im_bridge + GATE_EXTRA_MCP，**大声说**，不拦起桥。
 */
function buildToolServers(cfg, toolSocketFile, log = () => {}) {
  let out;
  try {
    out = renderToolServers({
      gateRoot: cfg.root,
      toolSocket: toolSocketFile,
      coldFile: cfg.coldFile,
      workspace: cfg.workspaceRoot || "",
      configFile: cfg.toolsConfigFile,
      log,
    });
  } catch (e) {
    log("[tools] ⚠️ 工具配置坏了，这一舱登记表的工具一个都没有：" + String(e.message).split("\n")[0]);
    return {};
  }
  if (!out) {
    log("[tools] 没有 " + cfg.toolsConfigFile + " —— 只挂 im_bridge + GATE_EXTRA_MCP（老样子）");
    return {};
  }
  log(`[tools] ${out.persona}：挂上 ${Object.keys(out.servers).length} 包，不挂 ${out.omitted.length} 包`);
  return out.servers;
}

/** `-1000000002=全家群,-1000000003=老群` → { "telegram:group:-1000000002": "全家群", ... } */
function parseGroupNames(raw) {
  const out = {};
  for (const part of String(raw).split(",")) {
    const [id, name] = part.split("=").map((s) => (s || "").trim());
    if (id && name) out["telegram:group:" + id] = name;
  }
  return out;
}

async function buildEverything(cfg) {
  // ——— 盒子（那个底座的脏活全关在里面，桥不认识它）———
  const backend = BOXES[cfg.boxKind];

  // 盒子在另一个进程：这儿不造 runtime、不 spawn CLI，只连过去。
  // 桥重启 = 换根网线，他那头一点感觉都没有。
  if (backend.remote) {
    const { makeRemoteBox } = require("./box-remote");
    const remote = makeRemoteBox({
      socketFile: process.env.GATE_BOX_SOCKET || path.join(cfg.root, "box.sock"),
      cursorFile: path.join(cfg.root, "cursor-box.json"),
      log,
    });
    log("盒子在别的进程里（nova-box），这儿只连过去 —— 重启桥不打断他");
    return assemble({ cfg, backend, runtime: remote.runtime, box: remote.box, remoteBox: remote });
  }

  // 2026-09-20 晚：桥自带盒子那条路删了。BOXES.claudecode 没有 `runtime`（那是
  // `host/box-host.js` 起盒子时才装上的），走到这儿只会在 buildBox 里炸得莫名其妙。
  // 桥只有一种活法：连去 nova-box。要在一个进程里跑盒子，起 nova-box，不是改这儿。
  throw new Error("桥不再自带盒子：GATE_BOX 只能是 remote（现在是 " + cfg.boxKind + "）。盒子在 nova-box 里，桥连 box.sock 过去。");
}

/**
 * 装配桥的其余部分 —— 盒子已经有了（自带的，或者连去 `nova-box` 的那个）。
 *
 * 从 `buildEverything` 里切出来的（2026-09-18）：两种盒子来路不同，
 * **后面这一整套完全一样**。切开就是为了不让它们各写一遍。
 */
async function assemble({ cfg, backend, runtime, box, remoteBox = null }) {

  // ——— 插头：扫目录，配置齐了就插上（Alice 2026-09-18：「不用了就取下来 用就插上」）———
  // **加一条腿不用动这个文件。** 要什么配置、怎么造出来，插头自己说。
  const { legs, idle } = loadLegs({ env: process.env, log });
  for (const it of idle) {
    if (it.lacks && it.lacks.length && it.why === "配置只填了一半") {
      log("⚠️ " + it.name + " 这条腿没插上：缺 " + it.lacks.map(([k]) => k).join(" "));
    }
  }
  const pluginSlots = {};
  for (const l of legs) pluginSlots[l.slot] = l.plugin;

  // ——— 装配 ———
  const gate = buildGate({
    root: cfg.root,
    coldFile: cfg.coldFile,
    box,
    // ⚠️ 嘴型和声带要一起给（2026-09-18 Nova报的：「桥有嘴型没声带」）。
    //    `buildSharedCapabilities` 的 ttsService / imageGeneration 是**参数**，
    //    老桥从 app.js 传进来；新桥不传的话，`synthesize_voice` 和 `generate_image`
    //    根本不注册 —— 他调 send_voice 会被出闸挡在 capability_not_registered。
    capabilities: buildSharedCapabilities({
      fileStoreRoot: path.join(cfg.root, "files"),
      runtimeAdapter: runtime,
      config: {
        ttsOutputDir: path.join(cfg.root, "voice"),
        imageApiKey: process.env.NOVA_IMAGE_API_KEY || process.env.OPENAI_API_KEY || "",
        imageModel: process.env.NOVA_IMAGE_MODEL || "",
      },
      ttsService: makeTts(path.join(cfg.root, "voice")),
      imageGeneration: makeImageGen(),
    }),
    producersDir: cfg.producersDir,
    // 段间间隔：默认全渠道 700ms 不变。**微信例外**——2026-09-20 因 Frida 被处罚后
    // Alice要它段间随机 1~3 秒（0.7 秒定值太机器，同秒连发 3 条是被风控盯上的特征之一）。
    // 只覆盖微信，不动 Telegram/iMessage（它们没这问题）。开关走 env，改完重启 nova-gate 生效。
    sendGapByChannel: {
      wechat: {
        min: Number(process.env.GATE_WECHAT_GAP_MIN_MS || 1000),
        max: Number(process.env.GATE_WECHAT_GAP_MAX_MS || 3000),
      },
    },
    // 关舱前那一轮（2026-09-19 Alice拍板）：让他自己把笔记本、她这一舱说过的要求、
    // 对她近况的判断过一遍 —— 换舱之后只有这几样跟得过去。桥只管 push，文案在这儿。
    closingNote: ({ reason }) => buildClosingNote({ reason, selfFile: selfFileName(cfg) }),
    enforceEnabled: true,
    plugins: pluginSlots,
    identities: {
      // 每条腿上她的身份键。**认人只认平台真实 id，不认昵称**
      //（影子 9-17 栽过：原来按昵称认，等于谁说的都算她说的）
      ...Object.fromEntries(
        Object.entries(cfg.owners).flatMap(([ch, ids]) => ids.map((id) => [ch + ":" + id, cfg.ownerName]))),
      ...cfg.groupNames,
    },
    files: { gateEnabled: cfg.gateEnabledFile },
    preferredRoute: { platform: "telegram", chat_id: cfg.preferredChatId },
    groups: cfg.groupsAllowed.length
      ? { allowed: cfg.groupsAllowed, alwaysWake: cfg.groupsAlwaysWake, wakeNames: cfg.groupWakeNames }
      : null,
    owner: cfg.ownerName,
    log,
  });

  // ——— 工具口：他调工具时，桥替他发（渠道/能力/冷层/账本全在出闸那边）———
  // 老桥那套工具是**自己直连平台发**的，所以渠道靠猜、桥也不知道他说过话。
  // 现在工具只说「我想发这个」，怎么发归桥。
  const toolSocketFile = path.join(cfg.root, "tools.sock");
  const toolSocket = makeToolSocket({
    file: toolSocketFile,
    outbound: gate.outbound,
    binding: gate.binding,
    activeTurn: () => gate.pipe.activeTurn(),
    addressOn: (ch) => gate.router.addressOn(ch),
    log,
  });

  // 让 claude 认识这层壳：**另给一份 mcp-config**，不动运行时自己那份
  // （2026-10-21 起花园/lmc5/浏览器那些也从登记表渲染进这份，工作目录的 .mcp.json 该清空）。
  // ⚠️ **这份文件每次起桥（nova-gate，就是这个文件）整份重写** —— 9-23 更正：原来写的是
  //    「起盒子」，但 assemble() 只有 nova-gate 会跑。别手工往里加东西，加了活不过一次重启，
  //    而且不报错（2026-09-19 栽过）。要加工具包：登记进 src/toolbox/registry.js，
  //    人的那一半写 $GATE_ROOT/tools.json（2026-10-21）；`GATE_EXTRA_MCP` 只留作兼容/临时顶替。
  const mcpFile = path.join(cfg.root, "mcp-im-bridge.json");
  const mcpServers = {
    im_bridge: {
      command: process.execPath,
      args: [path.join(__dirname, "..", "gate", "tools", "mcp-server.js")],
      env: { GATE_TOOL_SOCKET: toolSocketFile },
      // ⚠️ **常驻，不进「按需取件」**（2026-09-20）。
      // CLI 默认把 MCP 工具延迟加载：说明书一超过上下文的 10% 就全体转成
      // 「先 ToolSearch 查目录、再用」。Nova 9-20 报的第一条意见就是这个 ——
      // 核过他那条会话：一条会话里 ToolSearch 调了 58 次。
      // 这包是**他的嘴**（reply/react/send_voice/send_image/send_sticker/call…），
      // 每一轮都要用，让他每次先查一趟纯属白烧。
      // 代价：这包的说明书常占上下文 + 起盒子时会等它连上（上限 5 秒，本地 socket 很快）。
      // 其余几十个冷门工具照旧按需取，那才是延迟加载该管的事。
      alwaysLoad: true,
    },
  };
  // 2026-10-21：登记表 + 他的 tools.json 渲染出全套工具（remote 的包成本地代理，钥匙从他自己的
  // secrets 文件现读）。坏了只少工具、不拦起桥 —— 但必须喊出来。
  const toolsOut = buildToolServers(cfg, toolSocketFile, log);
  for (const [name, spec] of Object.entries(toolsOut)) mcpServers[name] = spec;
  // GATE_EXTRA_MCP 照旧认（兼容 + 临时顶替）：同名的以它为准
  for (const [name, spec] of Object.entries(readExtraMcp(cfg.extraMcpFile, log))) {
    if (name === "im_bridge") {                  // 自己那条不许被顶掉
      log("[mcp] 跳过 extra 里的 im_bridge —— 这条归盒子管");
      continue;
    }
    if (toolsOut[name]) log("[mcp] ⚠️ GATE_EXTRA_MCP 顶掉了登记表渲染的 " + name);
    mcpServers[name] = spec;
    log("[mcp] 额外挂上：" + name);
  }
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers }, null, 2) + "\n", { mode: 0o600 });

  // 这个底座自己那包命令（模型 / 水位 / 换舱 / 批准）——**不属于桥**，装配好再挂上去
  // 撤销那条命令要能**先把入站停住**（她的规格：停止在途，防止删完又写回来），
  // 停的是「腿还捞不捞」这一个开关 —— 不动 killswitch（那是她的一键回退，
  // 让 /undo 去改它，等于把她的退路和一条命令绑在一起）。
  const intake = { paused: false };
  const pauseIntake = async ({ timeoutMs = 30000, stepMs = 200 } = {}) => {
    intake.paused = true;
    const t0 = Date.now();
    for (;;) {
      let pending = 0;
      try { pending = Number((gate.pipe.progress() || {}).pending) || 0; } catch { pending = 0; }
      if (!pending) return { ok: true, waitedMs: Date.now() - t0 };
      if (Date.now() - t0 > timeoutMs) {
        intake.paused = false;                       // 停不干净就**原样恢复**，什么都不动
        return { ok: false, why: `等了 ${Math.round(timeoutMs / 1000)} 秒，还有 ${pending} 轮在途` };
      }
      await new Promise((r) => setTimeout(r, stepMs));
    }
  };
  const resumeIntake = () => { intake.paused = false; };

  const added = backend.commands(gate.pipe.commands, {
    runtime, box, workspaceRoot: cfg.workspaceRoot,
    gateRoot: cfg.root, pauseIntake, resumeIntake,
    // ⚠️ 2026-09-18 补：原来没传这个，于是 `/undo` 和 `/stop` 拿到的会话号永远是空串
    //（默认值 `() => ""`），按下去只会回「现在没有在跑的会话」。命令本身没错，
    // 是装配这儿漏了一个参数 —— 又一次「形状对得上、就是没人接线」。
    threadId: () => { try { return (box && box.fullness() || {}).threadId || ""; } catch { return ""; } },
  });

  return { gate, box, runtime, remoteBox, commandsAdded: added, legs, idle, toolSocket, mcpFile, intake };
}

/**
 * 心跳 —— 给守护件看的「我现在好不好」。
 *
 * ⚠️ 判据是**有没有真的走完一轮**，不是「连接在不在」。
 * 东京那台 QQ 的教训：WS 还通但 sendMsg 超时，看连接一切正常，消息全丢
 *（见记忆 `project-tokyo-napcat-qq`）。所以这里摆的是数，不是状态灯。
 */
function writeHeartbeat(cfg, { gate, box, startedAt }) {
  const s = gate.pipe.stats();
  const body = {
    at: new Date().toISOString(),
    pid: process.pid,
    upSec: Math.round((Date.now() - startedAt) / 1000),
    enabled: gate.enabled(),
    stats: s,
    progress: gate.pipe.progress(),
    held: gate.pipe.held().length,
    undelivered: gate.undelivered ? gate.undelivered.summary() : null,
    fullness: (() => { try { return box.fullness(); } catch { return null; } })(),
  };
  const tmp = cfg.heartbeatFile + ".tmp-" + process.pid;
  fs.mkdirSync(path.dirname(cfg.heartbeatFile), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2), "utf8");
  fs.renameSync(tmp, cfg.heartbeatFile);   // 换 inode，读的那头不会读到半截
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const cfg = readConfig();

  log("桥的家在 " + cfg.root);
  log("注入 + api = 谁：人格 " + (cfg.persona || "（没给，他醒来会是空的）")
    + "   底座 " + cfg.boxKind);
  // ⚠️ 切换纪律是「停老桥 → 起新桥」（两个进程 resume 同一条会话会把会话文件写乱）。
  // 这里**只大声说接的是哪条**，不拿 ps 去猜老桥在不在 —— 判据匹配歪了会把新桥拦在门外，
  // 那比它防的那件事更糟（2026-09-18 Alice：「没必要吧 我们肯定是要先把老桥关上的」）。
  log("接会话 " + cfg.bindingKey + "  工作目录 " + cfg.workspaceRoot);
  log("认人：" + (Object.entries(cfg.owners).map(([c, ids]) => c + ":" + ids.join("/")).join("  ") || "（一条腿都没认人）")
    + " = " + cfg.ownerName);
  log("群：" + (cfg.groupsAllowed.length ? cfg.groupsAllowed.join(" ") : "（没配，不收群消息）"));

  const { gate, commandsAdded, box, runtime, legs, idle, toolSocket, intake } = await buildEverything(cfg);
  log("腿：" + (legs.map((l) => l.name).join(" + ") || "（一条都没插上）")
    + (idle.length ? "   没插上：" + idle.map((i) => i.name + "(" + i.why + ")").join(" ") : ""));
  const pre = gate.preflight();
  log("点名：" + JSON.stringify(pre.插头 || pre));
  log("命令：" + gate.pipe.commands.names().join(" /"));
  {
    // TG 菜单跟命令表同一份（2026-10-21）。没插 TG 腿就不设。
    const tg = legs.find((l) => l.name === "telegram");
    if (tg && tg.plugin && typeof tg.plugin.call === "function") {
      require("../gate/telegram-menu").syncTelegramMenu({ commands: gate.pipe.commands, call: tg.plugin.call, log });
    }
  }
  log("开关：" + (gate.enabled() ? "**开着，会接管**" : "关着（暂停接收，游标不前进）"));

  // ——— 掉档提醒（2026-09-21）：他被路由到别的模型（容量满 / 安全层拒答自动切档）
  // 或额度用完时，推一条给Alice。挂在盒子已经推的 onReply/onTurnDone 上，
  // 不用另起一个轮询进程（老桥的 fable-guard 是独立 pm2，见 project-fable-guard）。
  // 桥（src/gate）不认识 telegram token，这层（宿主/`nova-gate` 进程）才认识——
  // 挂哪儿、说给谁，详见 model-fallback-alert.js 文件头。
  // ⚠️ 「请求的模型」不写死成 GATE_MODEL：她会用 TG /model 热切模型，那条命令
  // 写的是 sessions.json、不改 GATE_MODEL（也不重启）。这儿每次比对都现读
  // sessions.json，读不到才退回 GATE_MODEL —— 所以哪怕 GATE_MODEL 没配也照样装，
  // 只要 sessions.json 里有过 /model 存的那一条就够比。
  try {
    const { makeModelFallbackAlert } = require("./model-fallback-alert");
    const { makeTelegramPush } = require("./push-notify");
    const stateFile = process.env.GATE_MODEL_ALERT_STATE_FILE || path.join(cfg.root, "model-fallback-alert.json");
    const push = makeTelegramPush({
      secretFile: process.env.GATE_NOTIFY_BOT_SECRET || path.join(secretsDir(), "ib-notify-bot.secret"),
      chatId: process.env.GATE_NOTIFY_CHAT_ID || "",
      log,
    });
    const alerter = makeModelFallbackAlert({
      getSessionsFile: () => { try { return (runtime.describe() || {}).sessionsFile || ""; } catch { return ""; } },
      bindingKey: cfg.bindingKey,
      workspaceRoot: cfg.workspaceRoot,
      fallbackModel: cfg.model,
      stateFile,
      notify: push,
      log,
    });

    // /model 命令是她自己动的手，跟盒子的实测轮次无关 —— 挂在 runtime.setModelForWorkspace
    // 上（gate-commands-claudecode.js 的 /model 就是调这条口），不改那个文件本身。
    // 这个 runtime 对象是 box-remote 造的那个共享单例，方法在调用那一刻才做属性查找，
    // 所以只要在这儿（她还没来得及敲 /model 之前）换掉这个方法就一定接得上。
    if (typeof runtime.setModelForWorkspace === "function") {
      const rawSetModel = runtime.setModelForWorkspace;
      runtime.setModelForWorkspace = async (args) => {
        const r = await rawSetModel(args);
        try { alerter.onModelCommand({ toModel: args && args.model }); }
        catch (err) { log("[掉档提醒] onModelCommand 挂钩出错（不挡这次切换）：" + ((err && err.message) || err)); }
        return r;
      };
    }

    // turnId -> 这一轮见没见过「真答上来的」那句话。没见过就没有实测模型可比——
    // 要么是他没说话（silent），要么整轮是合成消息（额度用完 / 解析失败那种），
    // 拿 fullness().model 去比会读到上一轮的旧值，把这轮错怪成掉档（见文件头「两种不对」）。
    const genuineSeenByTurn = new Set();
    box.onReply((e) => {
      try {
        if (!e || !e.turnId) return;
        if (e.genuine === false) alerter.onReplyObserved({ genuine: false, text: e.text, turnId: e.turnId, at: e.at });
        else genuineSeenByTurn.add(e.turnId);
      } catch (err) { log("[掉档提醒] onReply 处理出错（不挡这一轮）：" + ((err && err.message) || err)); }
    });
    box.onTurnDone((e) => {
      try {
        const turnId = e && e.turnId;
        if (turnId && !e.failed && genuineSeenByTurn.has(turnId)) {
          const actual = (box.fullness() || {}).model || "";
          alerter.onModelObserved({ actual, turnId, at: e.at });
        }
        if (turnId) genuineSeenByTurn.delete(turnId);
      } catch (err) { log("[掉档提醒] onTurnDone 处理出错（不挡这一轮）：" + ((err && err.message) || err)); }
    });
    log("[掉档提醒] 已挂上：请求模型优先读 sessions.json，读不到退回 GATE_MODEL="
      + (cfg.model || "(没配)") + "，状态存 " + stateFile);
  } catch (e) { log("[掉档提醒] 装不上（不挡起桥）：" + ((e && e.message) || e)); }

  if (checkOnly) {
    // 运行时开着 IPC 服务，事件循环不会自己空 —— 体检完就明确退出，别吊着。
    log("--check 只体检，不跑。");
    process.exit(0);
  }

  await toolSocket.start();
  log("工具口：" + [...toolSocket.tools.keys()].join(" ") + "（他调工具时，桥替他发）");

  const startedAt = Date.now();
  // 每条插上的腿各挂一个收信循环。**怎么捞由插头自己说**（poll）：
  // 长轮询自己阻塞，读库那种要歇一下、不然空转吃满 CPU。
  const running = legs.map(({ name, poll }) => {
    const run = {};
    if (poll && poll.idleMsKey) run.idleMs = Number(process.env[poll.idleMsKey] || poll.idleMsDefault || 0);
    else if (poll && poll.idleMs) run.idleMs = poll.idleMs;
    if (poll && poll.timeoutSecKey) run.timeoutSec = Number(process.env[poll.timeoutSecKey] || poll.timeoutSecDefault || 25);
    // `intake.paused` 是 /undo 撤销期间的临时闸：停捞、等在途归零、动手、恢复。
    // killswitch 那一层照旧（她的一键回退），两者互不影响。
    return { name, leg: gate.attach({ channel: name, enabled: () => gate.enabled() && !intake.paused }), run };
  });
  if (gate.enabled()) await gate.pipe.recover();
  let maintenanceBusy = false;
  const maintenance = setInterval(async () => {
    if (maintenanceBusy || !gate.enabled()) return;
    maintenanceBusy = true;
    try {
      await gate.pipe.recover();
      await gate.drainProducers();
    } catch (e) { log("队列处理失败：" + e.message); }
    finally { maintenanceBusy = false; }
  }, 1000);
  const beat = setInterval(() => {
    try { writeHeartbeat(cfg, { gate, box, startedAt }); } catch (e) { log("心跳写不出去：" + e.message); }
  }, cfg.heartbeatMs);
  writeHeartbeat(cfg, { gate, box, startedAt });

  // ——— 守护：读自己写的心跳，看还在不在干活 ———
  // ⚠️ 它**只说话**。重启是Alice的决定权（2026-07-15 对 fable-guard 定的），
  // 而且重启 = 盒子重开 = 可能把他正在说的那轮腰斩。
  let watchTimer = null;
  if (cfg.watchMs > 0) {
    const watch = makeWatch({
      heartbeatFile: cfg.heartbeatFile,
      // 水位线收尾（2026-09-21 Alice定）：舱到 85% 就让他先收一次尾（笔记本 / 她最近 / 认下的要求），
      // 不等 /new —— /new 常常是拒答逼出来的，那时旧舱什么都跑不了。每个会话只推一次。
      highWaterRatio: Number(process.env.GATE_HIGH_WATER_RATIO || 0.85),
      // 30% 撞线（2026-09-21 从老桥搬回）：先让盒子裁工具链；裁不动（省不到 80k）就走 /new 那条路
      //（收尾轮 + 换舱 + 回执），跟她手按 /new 一模一样。GATE_AUTO_ROTATE_RATIO=0 关掉。
      // 2026-09-21 默认先关（0）：这套首触就撞上历史里的断链（她 undo 删行留的），
      // 要明天手工验过「真落刀能干净通过链检查」再开 —— 设 GATE_AUTO_ROTATE_RATIO=0.3 打开。
      waterlineRatio: Number(process.env.GATE_AUTO_ROTATE_RATIO ?? 0),
      waterlineCooldownMs: Number(process.env.GATE_AUTO_ROTATE_COOLDOWN_MS || 30 * 60_000),
      onWaterline: async ({ ratio, used, threadId }) => {
        const pct = Math.round(ratio * 100);
        const busy = gate.pipe.busy();
        if (busy.busy) { log(`[水位] ${pct}% 撞线，${busy.why}，5 分钟后再看`); return { retrySoon: true }; }
        const minGain = Number(process.env.GATE_TRIM_MIN_GAIN_TOKENS) || 80_000;
        let r = null;
        try { r = await box.trim({ currentTokens: used, minGain }); }
        catch (e) { log(`[水位] 裁工具链那条口出错：${(e && e.message) || e}`); r = { trimmed: false, reason: (e && e.message) || String(e) }; }
        if (r && r.busy) { log(`[水位] ${pct}% 撞线，${r.reason}，5 分钟后再看`); return { retrySoon: true }; }
        // 2026-10-21：刚换完舱（她 /new）会话已清、心跳里的水位还是旧舱的 → 别再换一次（那天收尾推了两遍）
        if (r && r.noSession) { log(`[水位] ${pct}% 是旧舱的读数，现在没有在跑的会话（刚换过舱），不换`); return; }
        if (r && r.trimmed) {
          const mb = (n) => (Number(n) / 1048576).toFixed(1);
          const line = `✂️ 水位 ${pct}% 撞线，裁了工具链：估省 ${Math.round((r.gain || 0) / 1000)}k，文件 ${mb(r.before)}MB → ${mb(r.after)}MB。没换舱，他接着说。备份 ${path.basename(r.backup || "")}`;
          log("[水位] " + line);
          try { await gate.pipe.tellOwner(line, { by: "waterline" }); } catch (e) { log("[水位] 回执发不出去：" + ((e && e.message) || e)); }
          return;
        }
        const why = `水位 ${pct}%，${(r && r.reason) || "裁不了"}`;
        log(`[水位] ${why} → 自动换舱`);
        const cmd = gate.pipe.commands.match("/new " + why);
        const out = cmd ? await gate.pipe.commands.run(cmd) : { text: "（/new 命令不在）" };
        try { await gate.pipe.tellOwner(`🔄 ${why}，自动换舱。${(out && out.text) || ""}`, { by: "waterline" }); }
        catch (e) { log("[水位] 回执发不出去：" + ((e && e.message) || e)); }
      },
      onHighWater: ({ ratio, threadId }) => {
        const pct = Math.round(ratio * 100);
        log("[守护] 水位 " + pct + "%，先推一轮收尾（会话 " + String(threadId).slice(0, 8) + "）");
        gate.pipe.push({ text: buildClosingNote({ reason: "水位 " + pct + "%", mode: "highwater", selfFile: selfFileName(cfg) }), producer: "换舱收尾·水位" })
          .catch((e) => log("[守护] 水位线收尾没推出去：" + ((e && e.message) || e)));
      },
      // 说给谁是宿主的事。现在先落日志；接她的 TG 是下一步。
      notify: (m) => log(m.replace(/\n/g, " | ")),
      log,
    });
    watchTimer = setInterval(() => {
      try { watch.tick(); } catch (e) { log("[守护] 自己出错了：" + ((e && e.message) || e)); }
    }, cfg.watchMs);
    log("守护：每 " + Math.round(cfg.watchMs / 1000) + " 秒看一次（只推不动，不会自动重启）");
  }

  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    log("收到 " + sig + "，停腿，不再捞新的。");
    for (const { leg } of running) { try { leg.stop(); } catch { /* 停不掉也要往下走 */ } }
    try { await toolSocket.stop(); } catch { /* 关不掉也要往下走 */ }
    clearInterval(maintenance);
    if (watchTimer) clearInterval(watchTimer);
    // 正在说的那一轮让它说完 —— 腰斩比晚几秒糟得多
    try {
      await gate.pipe.stop();
      if (typeof runtime.close === "function") await runtime.close();
      clearInterval(beat);
      process.exit(0);
    } catch (e) { log("停机收尾失败，任务已保留：" + e.message); }
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log("起来了。" + running.map((l) => l.name).join(" + ") + " 开始自己捞消息。");
  // 每条腿一个循环，谁也别等谁：微信读库 0.7 秒回来，TG 长轮询要挂 25 秒。
  // 一条腿自己炸了不许拖垮另一条 —— 它的 run 内部已经「出错歇一下重来」，
  // 真跳出来只可能是 stop()，这里把它当正常收工。
  await Promise.all(running.map(({ name, leg, run }) => leg.run(run)
    .catch((e) => log("[" + name + "] 这条腿退出了：" + ((e && e.message) || e)))));
}

if (require.main === module) {
  main().catch((e) => { console.error("\n" + (e && e.message ? e.message : e) + "\n"); process.exit(1); });
}

module.exports = { readConfig, parseGroupNames, readOwners, readExtraMcp, buildToolServers, BOXES };
