'use strict';

/**
 * 「他的手」这一包的配置 —— 全从 env 来。2026-10-21 起**数据目录必须给**（NOVA_STATE_DIR），
 * 不再默认Nova家；代码路径（playwright 那份）照旧有默认。
 *
 * 为什么变量名大多照抄老 cyberboss 的（NOVA_IMAGE_*、ELEVENLABS_API_KEY）：
 * 接线时可以原样沿用生产那份值，不用再造一套名字让人对照。
 * 新起的名字统一 HANDS_ 开头。
 *
 * ⚠️ 密钥**只认 env**。老 sing.js 找不到 env 会自己去翻 /root/cyberboss/.env ——
 * 这一包不翻任何文件：密钥由接线的人塞进 env，没塞就明说「没配」。
 *
 * 每次调用现读一遍（不在启动时缓存）：跟老 sing.js「改配置下一首立刻生效」一个规矩，
 * 测试也好换 env。
 */

const os = require('node:os');   // songDir 默认 os.tmpdir()
const path = require('node:path');

function text(env, name) {
  const v = env[name];
  return typeof v === 'string' ? v.trim() : '';
}

// 照老 config.js 的 readIntEnv：parseInt，读不出来算没给
function int(env, name) {
  const v = text(env, name);
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function loadConfig(env = process.env) {
  // 2026-10-21：NOVA_STATE_DIR **必须给**。原来没给就是 ~/.nova = Nova家，别人用会把图和歌写进去
  const stateDir = text(env, 'NOVA_STATE_DIR');
  if (!stateDir) throw new Error('hands：没配 NOVA_STATE_DIR（他自己的数据目录）。不再默认 ~/.nova —— 那是Nova家。');
  const imageApiKey = text(env, 'NOVA_IMAGE_API_KEY') || text(env, 'OPENAI_API_KEY');
  return {
    stateDir,

    // ——— 兴趣源 ———
    // 不给就用代码里那四个（老 feed-service.js 的 SELF_FEEDS）。给了就读这个 JSON：[{label,url}]
    feedsFile: text(env, 'HANDS_FEEDS_FILE'),

    // ——— 出图（老 config.js 113-118 行，一字不差的回退顺序）———
    imageApiKey,
    imageApiBaseUrl: text(env, 'NOVA_IMAGE_API_BASE_URL') || text(env, 'OPENAI_BASE_URL') || 'https://api.openai.com/v1',
    // Replicate 的 key（r8_…）默认 flux-schnell；OpenAI 兼容的默认 gpt-image-2
    imageModel: text(env, 'NOVA_IMAGE_MODEL') || (imageApiKey.startsWith('r8_') ? 'black-forest-labs/flux-schnell' : 'gpt-image-2'),
    imageOutputDir: text(env, 'NOVA_IMAGE_OUTPUT_DIR') || path.join(stateDir, 'generated-images'),
    // 老的是 `readIntEnv(...) || 120_000`：0 / 读不出来都回到 120 秒
    imageTimeoutMs: int(env, 'NOVA_IMAGE_TIMEOUT_MS') || 120_000,

    // ——— 唱歌 ———
    elevenLabsApiKey: text(env, 'ELEVENLABS_API_KEY'),
    // 歌喉配置：唯一真相，改它就换嗓子（老 sing.js 写死 ~/.nova/song-config.json；
    // 2026-10-21 起默认跟家目录走，Nova家目录就是 /root/.nova，值不变）
    songConfigFile: text(env, 'HANDS_SONG_CONFIG') || path.join(stateDir, 'song-config.json'),
    // 歌落在哪（老 sing.js 是 os.tmpdir()，生产 = /tmp/song-<毫秒>.mp3）
    songDir: text(env, 'HANDS_SONG_DIR') || os.tmpdir(),
    // 给歌写标题标签用；没有 ffmpeg 就不写标签，歌照发
    ffmpeg: text(env, 'HANDS_FFMPEG') || 'ffmpeg',

    // ——— 知乎 ———
    // 跟他自己的 browser MCP 共用一个 Chromium profile（登录态在里面）
    // 老脚本写死 /root/.nova/browser-profile；2026-10-21 起默认 <家>/browser-profile（Nova值不变）
    zhihuProfile: text(env, 'HANDS_ZHIHU_PROFILE') || path.join(stateDir, 'browser-profile'),
    // Playwright 借 browser-mcp 那份（老脚本也是 require 这个绝对路径）
    playwrightModule: text(env, 'HANDS_PLAYWRIGHT') || path.join(os.homedir(), 'browser-mcp', 'node_modules', 'playwright'),
    // 有头浏览器开在虚拟屏幕上：老 handler 是 `DISPLAY || ":99"`
    display: text(env, 'DISPLAY') || ':99',
  };
}

module.exports = { loadConfig };
