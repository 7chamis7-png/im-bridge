'use strict';

/**
 * 出图 —— 照老 src/services/image-generation-service.js 的规矩重写（2026-09-20）。
 *
 * 两家供应商，**看 key 的样子分流**：`r8_` 开头是 Replicate，别的当 OpenAI 兼容。
 * （生产现在是 Replicate + black-forest-labs/flux-schnell。）
 *
 * 这里只管「生成 + 存到本地」，**不发**。发给她归桥（见 tools.js 里 image_generate
 * 怎么把第一张交给桥的 send_image）。
 *
 * 规矩清单（每条老代码里都有，别漏）：
 *   · prompt 去空白后为空 → "Missing image prompt."
 *   · 没 key → "Missing image API key. Set NOVA_IMAGE_API_KEY or OPENAI_API_KEY."
 *   · n：parseInt 后夹到 1..4，读不出来就是 1
 *   · 每个 HTTP 请求一个超时（默认 120 秒）；Replicate 轮询另有总截止时间（同一个数）
 *   · 出错信息：`<前缀> failed (<状态码>): <error.message | detail | 原文前 500 字 | statusText>`
 *   · 目录在**拿到结果之后**才建；文件名 `<ISO 时间, : 和 . 换成 ->-<序号>.png`
 *     —— 序号跟着供应商返回的原始位置走，空的那项跳过但**不补位**
 *   · OpenAI：model = 参数 > 配置 > gpt-image-2；size 默认 1024x1024；
 *     quality/background 有值才带；只收 b64_json，一张都没有就报错
 *   · Replicate：model 必须是 owner/model；size 形如 WxH 才换成约分后的 aspect_ratio；
 *     quality/background **不传**（Replicate 那边没有）；轮询间隔 1 秒；
 *     failed/canceled 直接报错；输出可以是数组也可以是单个 URL
 *   · ⚠️ Replicate 的 flux-schnell 实际出的是 webp，但文件名照旧叫 .png（老的就这样，
 *     生产目录里全是这种；改扩展名会让已经习惯这个目录的东西对不上，不在这次改）
 */

const fs = require('node:fs');
const path = require('node:path');

const REPLICATE_API_BASE = 'https://api.replicate.com/v1';
const REPLICATE_POLL_INTERVAL_MS = 1_000;

function norm(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function clampInteger(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeBaseUrl(v) {
  return (norm(v) || 'https://api.openai.com/v1').replace(/\/+$/, '');
}

function isReplicateApiKey(key) {
  return key.startsWith('r8_');
}

function splitReplicateModel(model) {
  const [owner, ...rest] = model.split('/');
  const name = rest.join('/');
  if (!owner || !name) throw new Error(`Invalid Replicate model "${model}". Expected format "owner/model".`);
  return [owner, name];
}

function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b);
}

function sizeToAspectRatio(size) {
  const m = /^(\d+)x(\d+)$/.exec(norm(size));
  if (!m) return '';
  const w = Number.parseInt(m[1], 10);
  const h = Number.parseInt(m[2], 10);
  if (!w || !h) return '';
  const g = gcd(w, h);
  return `${w / g}:${h / g}`;
}

// 超时只罩住「拿到响应头」这一段（老的就是这样：拿到响应就清掉计时器，再读正文）
async function fetchJson(fetchImpl, url, { method, headers, body, timeoutMs, errorPrefix }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { method, headers, body, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  const raw = await res.text();
  let json = {};
  try { json = raw ? JSON.parse(raw) : {}; } catch { json = {}; }
  if (!res.ok) {
    const msg = json?.error?.message || json?.detail || raw.slice(0, 500) || res.statusText;
    throw new Error(`${errorPrefix} failed (${res.status}): ${msg}`);
  }
  return json;
}

// 下载图：超时罩住整段（含读正文）
async function downloadBuffer(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Failed to download image (${res.status}): ${url}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function prepareOutputDir(dir, now) {
  fs.mkdirSync(dir, { recursive: true });
  return { outputDir: dir, createdAt: new Date(now()).toISOString().replace(/[:.]/g, '-') };
}

/**
 * @param {object} args  工具入参（prompt/size/quality/background/n/model）
 * @param {object} config loadConfig() 的结果
 * @param {object} [deps] { fetchImpl, sleep, now } —— 测试替身
 * @returns {Promise<{files:{filePath,bytes}[], model, size, prompt}>}
 */
async function generateImages(args = {}, config = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now || Date.now;

  const prompt = norm(args.prompt);
  if (!prompt) throw new Error('Missing image prompt.');
  const apiKey = norm(config.imageApiKey);
  if (!apiKey) throw new Error('Missing image API key. Set NOVA_IMAGE_API_KEY or OPENAI_API_KEY.');
  const n = clampInteger(args.n, 1, 4, 1);
  const timeoutMs = Number.isFinite(config.imageTimeoutMs) ? config.imageTimeoutMs : 120_000;
  const ctx = { args, prompt, apiKey, n, timeoutMs, config, fetchImpl, sleep, now };
  return isReplicateApiKey(apiKey) ? generateReplicate(ctx) : generateOpenAI(ctx);
}

async function generateOpenAI({ args, prompt, apiKey, n, timeoutMs, config, fetchImpl, now }) {
  const model = norm(args.model) || norm(config.imageModel) || 'gpt-image-2';
  const size = norm(args.size) || '1024x1024';
  const quality = norm(args.quality);
  const background = norm(args.background);
  const payload = { model, prompt, n, size };
  if (quality) payload.quality = quality;
  if (background) payload.background = background;

  const json = await fetchJson(fetchImpl, `${normalizeBaseUrl(config.imageApiBaseUrl)}/images/generations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    timeoutMs,
    errorPrefix: 'Image API',
  });
  const items = Array.isArray(json.data) ? json.data : [];
  if (!items.length) throw new Error('Image API returned no images.');

  const { outputDir, createdAt } = prepareOutputDir(config.imageOutputDir, now);
  const files = [];
  items.forEach((item, i) => {
    const b64 = norm(item.b64_json);
    if (!b64) return;
    const filePath = path.join(outputDir, `${createdAt}-${i + 1}.png`);
    fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));
    ensurePng(filePath);
    files.push({ filePath, bytes: fs.statSync(filePath).size });
  });
  if (!files.length) throw new Error('Image API response did not include b64_json images.');
  return { files, model, size, prompt };
}

async function generateReplicate({ args, prompt, apiKey, n, timeoutMs, config, fetchImpl, sleep, now }) {
  const model = norm(args.model) || norm(config.imageModel) || 'black-forest-labs/flux-schnell';
  const [owner, name] = splitReplicateModel(model);
  const size = norm(args.size);
  const input = { prompt, num_outputs: n };
  const ar = sizeToAspectRatio(size);
  if (ar) input.aspect_ratio = ar;
  const headers = { authorization: `Token ${apiKey}`, 'content-type': 'application/json' };

  const created = await fetchJson(fetchImpl, `${REPLICATE_API_BASE}/models/${owner}/${name}/predictions`, {
    method: 'POST', headers, body: JSON.stringify({ input }), timeoutMs, errorPrefix: 'Replicate API',
  });
  const getUrl = created?.urls?.get;
  if (!getUrl) throw new Error('Replicate API response did not include a poll URL.');

  // 轮询：总截止 = 开始轮询时刻 + timeoutMs
  const deadline = now() + timeoutMs;
  let prediction;
  for (;;) {
    prediction = await fetchJson(fetchImpl, getUrl, { method: 'GET', headers, timeoutMs, errorPrefix: 'Replicate API' });
    const status = prediction.status;
    if (status === 'succeeded') break;
    if (status === 'failed' || status === 'canceled') {
      const msg = prediction.error || `Replicate prediction ${status}.`;
      throw new Error(`Replicate prediction ${status}: ${msg}`);
    }
    if (now() >= deadline) {
      throw new Error(`Replicate prediction timed out after ${timeoutMs}ms (last status: ${status}).`);
    }
    await sleep(Math.min(REPLICATE_POLL_INTERVAL_MS, Math.max(0, deadline - now())));
  }

  const outputs = Array.isArray(prediction.output) ? prediction.output : prediction.output ? [prediction.output] : [];
  if (!outputs.length) throw new Error('Replicate prediction succeeded but returned no output images.');

  const { outputDir, createdAt } = prepareOutputDir(config.imageOutputDir, now);
  const files = [];
  for (let i = 0; i < outputs.length; i += 1) {
    const url = norm(outputs[i]);
    if (!url) continue;
    const buf = await downloadBuffer(fetchImpl, url, timeoutMs);
    const filePath = path.join(outputDir, `${createdAt}-${i + 1}.png`);
    fs.writeFileSync(filePath, buf);
    ensurePng(filePath);
    files.push({ filePath, bytes: fs.statSync(filePath).size });
  }
  if (!files.length) throw new Error('Replicate prediction output did not include any downloadable images.');
  return { files, model, size, prompt };
}


/**
 * 存下来的必须是**真 PNG**（9-20 Keeper 审时加）：Replicate 的 flux-schnell 实际给 webp，
 * 老代码照样叫 .png 存 —— 扩展名说谎。微信插头按 PNG 粘贴，webp 可能贴不出去。
 * 看文件头，不是 PNG 就用 ImageMagick 原地转；转失败就留原样（至少 TG 还能发），不让整轮失败。
 */
function ensurePng(filePath) {
  try {
    const head = Buffer.alloc(8);
    const fd = fs.openSync(filePath, 'r');
    try { fs.readSync(fd, head, 0, 8, 0); } finally { fs.closeSync(fd); }
    if (head[0] === 0x89 && head.toString('latin1', 1, 4) === 'PNG') return;
    const tmp = filePath + '.conv.png';
    const r = require('node:child_process').spawnSync(process.env.HANDS_CONVERT || '/usr/bin/convert',
      [filePath + '[0]', tmp], { encoding: 'utf8', timeout: 30000 });
    if (r.status === 0 && fs.existsSync(tmp)) fs.renameSync(tmp, filePath);
    else { try { fs.unlinkSync(tmp); } catch { /* 没有就算了 */ } }
  } catch { /* 转不了就留原样 */ }
}

module.exports = { ensurePng, generateImages, sizeToAspectRatio, splitReplicateModel, clampInteger, normalizeBaseUrl, isReplicateApiKey };
