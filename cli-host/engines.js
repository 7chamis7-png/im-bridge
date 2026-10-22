'use strict';

/**
 * 引擎宿主的插头表（设计稿 §5.1，2026-10-21 S5）。
 *
 * 每个人格只有**一个**引擎宿主进程（nova-cli / iris-cli，pm2 名不改）。宿主里登记三根插头，
 * 盒子 ensure 时带 want.engine，跟活着的那根不一样就停旧插头、起新插头 —— 宿主进程不重启。
 * 原来是三个入口各绑一根插头（cli-host/main.js、codex-main.js、deepseek-main.js），换引擎 = 换进程，
 * 还容易「两只抢一个插座」（10-03 DeepSeek 那次）。
 *
 * 凭据按插头分开，**只从固定的地方读**：
 *   claude-cli       OAuth（~/.claude，CLI 自己读；runtime/index.js 见 apiKeySource≠none 当场停）
 *   codex-appserver  $CODEX_HOME/auth.json（ChatGPT 订阅；codex-runtime assertSubscription 硬闸）
 *   openai-chat      /root/.secrets/<secret>.secret（名字来自 models.json 的 secret）
 *                    —— 不再学原来 deepseek-main.js 去 /proc/<pid>/environ、~/.pm2/dump.pm2 里借钥匙。
 */

const fs = require('node:fs');
const path = require('node:path');
const { createRuntime } = require('../runtime');
const { createCodexRuntime } = require('./codex-runtime');
const { createDeepseekRuntime } = require('./deepseek-runtime');
const { joinInstructions } = require('../src/host/persona-file');
const usage = require('./usage');
const { wrapClaudeOnEvent } = require('./neutral');

const { secretsDir, homeDir, homePath } = require('../src/core/paths');

// 钥匙柜：~/.secrets（生产 HOME=/root → /root/.secrets，跟原来写死的一样）；IM_BRIDGE_SECRETS_DIR 可换
const SECRETS_DIR = secretsDir();
const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** sdkOptions 里只给桥自己看的键：别递给 Claude SDK（它不认）。 */
const BRIDGE_ONLY_KEYS = ['freshThread', 'codexConfig', 'engineCreds', 'rebuild', 'toolsNote'];

function envStr(env, name, fallback = '') {
  const v = env[name];
  return (typeof v === 'string' && v.trim()) ? v.trim() : fallback;
}

/**
 * 读一把钥匙：只认 `<dir>/<名字>.secret`。名字不像名字（带斜杠、..）、不是普通文件、是空的 → 抛错。
 * 钥匙的值不进日志、不进错误信息。
 */
function readSecret(name, { dir = SECRETS_DIR } = {}) {
  const n = String(name || '').trim();
  if (!SECRET_NAME.test(n)) throw new Error(`钥匙名「${n}」不合法：只写名字，对应 ${dir}/<名字>.secret`);
  const file = path.join(dir, `${n}.secret`);
  let st;
  try { st = fs.statSync(file); } catch { throw new Error(`没有钥匙文件 ${file}（不猜、不从别的进程借）`); }
  if (!st.isFile()) throw new Error(`${file} 不是普通文件`);
  const value = fs.readFileSync(file, 'utf8').trim();
  if (!value) throw new Error(`${file} 是空的`);
  return value;
}

function stripBridgeKeys(sdkOptions) {
  const out = { ...(sdkOptions || {}) };
  for (const k of BRIDGE_ONLY_KEYS) delete out[k];
  return out;
}

/**
 * @param {object} o
 * @param {string} o.stateDir     这个人格桥的 state 目录（codex-thread.json / deepseek-thread.json 住这儿）
 * @param {string} [o.workspace]  盒子没给 cwd 时的工作目录
 * @param {boolean} [o.requireCodexHome]  true = 没设 CODEX_HOME 就不许起 codex（Nova：不能跟Iris共用 /root/.codex）
 * @param {string} [o.identityInjectionFile]  codex 的 developerInstructions 要拼上的 IB 身份底座（Iris）
 * @param {string} [o.secretsDir] 只给测试换；生产就是 /root/.secrets
 * @param {object} [o.overrides]  测试换插头构造函数：{ claude, codex, deepseek }
 */
function createEngineFactories({ env = process.env, stateDir, workspace = '', requireCodexHome = false,
  identityInjectionFile = '', secretsDir = SECRETS_DIR, overrides = {}, fetchImpl = undefined, claudeCredentialsFile = undefined } = {}) {
  if (!stateDir) throw new Error('插头表要 stateDir，不猜 thread 文件放哪。');
  const makeClaude = overrides.claude || createRuntime;
  const makeCodex = overrides.codex || createCodexRuntime;
  const makeDeepseek = overrides.deepseek || createDeepseekRuntime;

  function identityText() {
    if (!identityInjectionFile) return '';
    try { return fs.readFileSync(identityInjectionFile, 'utf8'); }
    catch (e) { console.error(`[engine-host] 身份底座读不到（${identityInjectionFile}）：${e.message}`); return ''; }
  }

  const factories = {
    // S2b：Claude 插头的 SDK 帧在这儿翻成通用事件 imb.event.v1 再交给盒子（跟盒子全本记账同一个翻译 claudeToNeutral）。
    // 回滚：IMB_CLAUDE_EVENTS=frames → 照旧送 Claude 帧（盒子双认，重启 nova-cli 生效）。
    'claude-cli': (cfg) => {
      const frames = String(env.IMB_CLAUDE_EVENTS || '').trim().toLowerCase() === 'frames';
      return makeClaude({ ...cfg, ...(frames ? {} : { onEvent: wrapClaudeOnEvent(cfg.onEvent) }),
        sdkOptions: stripBridgeKeys(cfg.sdkOptions) });
    },

    'codex-appserver': (cfg) => {
      const given = cfg.sdkOptions || {};
      const codexHome = envStr(env, 'CODEX_HOME');
      if (requireCodexHome && !codexHome) {
        throw new Error('这个人格没有自己的 CODEX_HOME —— 不许拿 ~/.codex 起 codex（会跟Iris的 thread 混在一起）。'
          + '先按迁移步骤建好 CODEX_HOME 再换。');
      }
      return makeCodex({
        ...cfg,
        cwd: cfg.cwd || workspace,
        threadFile: path.join(stateDir, 'codex-thread.json'),
        authFile: envStr(env, 'CODEX_AUTH_FILE', codexHome ? path.join(codexHome, 'auth.json') : homePath('.codex', 'auth.json')),
        codexPath: envStr(env, 'CODEX_COMMAND', envStr(env, 'GATE_CODEX_COMMAND', '/usr/local/bin/codex')),
        home: envStr(env, 'CODEX_HOME_DIR', homeDir(env)),
        codexHome,
        // developerInstructions = 盒子给的（宣言 + 人格文件）+ IB 身份底座，两样都要（原 codex-main.js 的做法）
        sdkOptions: { ...given, systemPrompt: joinInstructions(given.systemPrompt, identityText()) },
      });
    },

    'openai-chat': (cfg) => {
      const given = cfg.sdkOptions || {};
      const creds = (given.engineCreds && typeof given.engineCreds === 'object') ? given.engineCreds : {};
      const secret = creds.secret || envStr(env, 'DEEPSEEK_SECRET', 'deepseek');
      const apiKey = readSecret(secret, { dir: secretsDir });   // 钥匙读不到 = 起不来（盒子留在原引擎）
      return makeDeepseek({
        ...cfg,
        cwd: cfg.cwd || workspace,
        threadFile: path.join(stateDir, 'deepseek-thread.json'),
        credentials: {
          apiKey,
          baseUrl: creds.baseUrl || envStr(env, 'NOVA_DEEPSEEK_BASE_URL', 'https://api.deepseek.com'),
          model: given.model || envStr(env, 'NOVA_DEEPSEEK_MODEL', 'deepseek-chat'),
        },
        sdkOptions: given,
      });
    },
  };

  // /usage 在插头没起的时候怎么查（起着的话宿主先问活着的那根：codex 只能这样）
  factories['claude-cli'].usage = () => usage.claudeUsage({
    ...(claudeCredentialsFile ? { credentialsFile: claudeCredentialsFile } : {}), ...(fetchImpl ? { fetchImpl } : {}) });
  factories['codex-appserver'].usage = () => usage.codexUsage({});
  factories['openai-chat'].usage = (args = {}) => {
    const creds = (args.engineCreds && typeof args.engineCreds === 'object') ? args.engineCreds : {};
    let apiKey = '';
    try { apiKey = readSecret(creds.secret || envStr(env, 'DEEPSEEK_SECRET', 'deepseek'), { dir: secretsDir }); }
    catch (e) { return { ok: false, engine: 'openai-chat', kind: 'api', why: e.message }; }
    return usage.deepseekBalance({ apiKey, baseUrl: creds.baseUrl || envStr(env, 'NOVA_DEEPSEEK_BASE_URL', 'https://api.deepseek.com'),
      ...(fetchImpl ? { fetchImpl } : {}) });
  };
  return factories;
}

module.exports = { createEngineFactories, readSecret, stripBridgeKeys, SECRETS_DIR, BRIDGE_ONLY_KEYS };
