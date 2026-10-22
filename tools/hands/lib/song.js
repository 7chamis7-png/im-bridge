'use strict';

/**
 * 唱歌 —— 词 → ElevenLabs Music 出歌 → 存成本地 mp3。**发给她归桥**，这里不发。
 *
 * 照老 /root/cyberboss/scripts/sing.js 重写（2026-09-20）。那份顶上记着的来历要留着：
 *   · 2026-09-12 走过死路：speech-to-speech（eleven_multilingual_sts_v2）是**说话转说话**，
 *     不是歌声转换。把歌套上他说话的音色，Alice原话「elevenlabs自己的嗓子比Nova的音色好太多太多」。
 *     真正对口的是 RVC / so-vits-svc（要 GPU，这台没有）。
 *   · 所以现在：让 Music 自己生成歌手，但**把风格描述钉死**，于是每次是同一把嗓子。
 *     描述存在 song-config.json —— 唯一真相，改它就换嗓子，**每次调用现读，不用重启**。
 *
 * 规矩清单（老脚本里每一条都在，顺序也照旧 —— 花钱的那步放在所有检查之后）：
 *   1. lyrics：去掉空白行（只筛不修剪，保留他写的样子）；一行都不剩 → 拒绝
 *   2. 读歌喉配置；读不了 / 没有默认音色 → 拒绝
 *   3. 没 ELEVENLABS_API_KEY → 拒绝
 *   4. 时长：duration_ms 没给 → 配置里的 defaults.duration_ms（>0 才算）→ **按歌词行数算**（7 秒/行，至少 25 秒）；
 *      最后夹到 10 秒..120 秒（越长越贵）
 *   5. style_note 有值才追加到正向风格末尾（只改编曲，嗓子是她选的）
 *   6. 只出一段，段名 "Verse"；全局和段内用同一套正/负风格
 *   7. HTTP 非 200 → "出歌失败: HTTP <码>: <前 220 字>"；300 秒没动静 → "出歌超时"
 *   8. 出来的音频不到 5000 字节 → 不对劲，**不发**
 *   9. 存成 <songDir>/song-<毫秒>.mp3（生产 = /tmp）
 *
 * ⚠️ 仓库里另有一份 sing.js.NEW-songstruct-hold（主歌副歌必须齐全、75 秒那版）——
 *    那是**暂扣没上线**的，生产跑的是上面这套。song-config.json 里的 structure 段
 *    同理，现役不读它。
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { spawn } = require('node:child_process');

const MIN_MS = 10_000;
const MAX_MS = 120_000;
const FALLBACK_MS = 30_000;
const MIN_AUDIO_BYTES = 5_000;
const IDLE_TIMEOUT_MS = 300_000;   // 老 sing.js 的 https timeout（连接闲着多久算超时）
const HARD_TIMEOUT_MS = 330_000;   // 老 handler 给子进程的死线，这里改成整次请求的总死线

function pickLines(lyrics) {
  return Array.isArray(lyrics) ? lyrics.map(String).filter((s) => s.trim()) : [];
}

/**
 * 没给时长就**按歌词算**（2026-09-20 Alice：「歌不要默认30s」）。
 *
 * 在这之前不给就是 30 秒，不管他写了 4 行还是 14 行 —— 行数一多就是唱到一半被掐掉。
 * 现在：每行约 7 秒，夹到 25..120 秒。显式给了 duration_ms 还是听他的（下限照旧 10 秒）。
 * 想钉死一个数：song-config.json 的 defaults.duration_ms 填个大于 0 的值就行（填 0 = 按行数算）。
 */
const MS_PER_LINE = 7_000;
const DERIVED_MIN_MS = 25_000;

function clampDuration(durationMs, conf, lineCount = 0) {
  const asked = Number(durationMs) || Number(conf?.defaults?.duration_ms) || 0;
  const ms = asked || Math.max(DERIVED_MIN_MS, lineCount * MS_PER_LINE);
  return Math.max(MIN_MS, Math.min(ms, MAX_MS));
}

function readSongConfig(file) {
  let conf;
  try {
    conf = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`读不到歌喉配置 ${file}: ${e.message}`);
  }
  const name = conf && conf.default;
  const voice = conf && conf.voices && conf.voices[name];
  if (!voice) throw new Error(`song-config.json 里没有音色 ${name}`);
  return { conf, name, voice };
}

function buildPlan({ lines, voice, durationMs, styleNote }) {
  const pos = styleNote ? voice.positive.concat(String(styleNote)) : voice.positive;
  return {
    composition_plan: {
      positive_global_styles: pos,
      negative_global_styles: voice.negative,
      sections: [{
        section_name: 'Verse',
        positive_local_styles: pos,
        negative_local_styles: voice.negative,
        duration_ms: durationMs,
        lines,
      }],
    },
  };
}

/** 真打 ElevenLabs /v1/music。回 mp3 字节。测试里整个换掉，不花钱。 */
function postMusic({ apiKey, plan }) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(plan));
    const req = https.request({
      method: 'POST', hostname: 'api.elevenlabs.io', path: '/v1/music',
      headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
      timeout: IDLE_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(hard);
        const buf = Buffer.concat(chunks);
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${buf.toString('utf8').slice(0, 220)}`));
        resolve(buf);
      });
      res.on('error', (e) => { clearTimeout(hard); reject(e); });
    });
    const hard = setTimeout(() => req.destroy(new Error('出歌超时')), HARD_TIMEOUT_MS);
    req.on('timeout', () => req.destroy(new Error('出歌超时')));
    req.on('error', (e) => { clearTimeout(hard); reject(e); });
    req.end(body);
  });
}

/**
 * 给 mp3 写上标题标签（老的走 Telegram sendAudio 的 title 参数；现在交给桥发文件，
 * 桥不收 title，只能把标题写进文件本身）。**写不上就算了，歌照发** —— 不为一个标题丢歌。
 * @returns {Promise<boolean>} 写上了没有
 */
function tagTitle(file, title, { ffmpeg = 'ffmpeg', timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    const tmp = `${file}.tag.mp3`;
    let child;
    try {
      child = spawn(ffmpeg, ['-y', '-loglevel', 'error', '-i', file, '-map', '0', '-c', 'copy',
        '-metadata', `title=${title}`, '-id3v2_version', '3', tmp], { stdio: 'ignore' });
    } catch {
      return resolve(false);
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退 */ } }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); try { fs.unlinkSync(tmp); } catch { /* 没有 */ } resolve(false); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        if (code === 0 && fs.statSync(tmp).size >= MIN_AUDIO_BYTES) {
          fs.renameSync(tmp, file);
          return resolve(true);
        }
      } catch { /* 落空就当没写上 */ }
      try { fs.unlinkSync(tmp); } catch { /* 没有 */ }
      resolve(false);
    });
  });
}

/**
 * 出一首歌，存到本地。**不发。**
 * @param {object} a { lyrics, duration_ms, title, style_note }
 * @param {object} config loadConfig() 的结果
 * @param {object} [deps] { postMusic, now } —— 测试替身
 * @returns {Promise<{file, bytes, seconds, voice, lines, titleTagged}>}
 */
async function makeSong(a = {}, config = {}, deps = {}) {
  const lines = pickLines(a.lyrics);
  if (!lines.length) throw new Error('lyrics 不能为空（一行一句，数组）');

  const { conf, name, voice } = readSongConfig(config.songConfigFile);

  const apiKey = String(config.elevenLabsApiKey || '').trim();
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY 没配');

  const durationMs = clampDuration(a.duration_ms, conf, lines.length);
  const plan = buildPlan({ lines, voice, durationMs, styleNote: a.style_note });

  let audio;
  try {
    audio = await (deps.postMusic || postMusic)({ apiKey, plan });
  } catch (e) {
    throw new Error(`出歌失败: ${e.message}`);
  }
  if (!audio || audio.length < MIN_AUDIO_BYTES) {
    throw new Error(`出来的音频只有 ${audio ? audio.length : 0} 字节，不对劲，没敢发`);
  }

  fs.mkdirSync(config.songDir, { recursive: true });
  const file = path.join(config.songDir, `song-${(deps.now || Date.now)()}.mp3`);
  fs.writeFileSync(file, audio);

  const title = typeof a.title === 'string' ? a.title.trim() : '';
  const titleTagged = title ? await tagTitle(file, title, { ffmpeg: config.ffmpeg }) : false;

  return { file, bytes: fs.statSync(file).size, seconds: Math.round(durationMs / 1000), voice: name, lines, titleTagged };
}

module.exports = {
  makeSong, pickLines, clampDuration, buildPlan, readSongConfig, tagTitle, postMusic,
  MIN_MS, MAX_MS, MIN_AUDIO_BYTES,
};
