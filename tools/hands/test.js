'use strict';

/**
 * 「他的手」的测试（2026-09-20）。跑法：`node --test /root/im-bridge/tools/hands/test.js`
 *
 * 铁律：
 *   · **一个字节都不碰生产**：出图 / 歌 / 名单 / profile 全在临时目录；
 *     桥一律用假 socket（录下收到了什么），绝不连 /root/.nova-gate/tools.sock。
 *   · **不花钱**：ElevenLabs、出图 API 全换成替身；知乎不开真浏览器（假 chromium）。
 *   · 兴趣源的「跟老实现对答案」用同一份输入喂新旧两边；老代码只读地 require。
 *   · 真网络那一条（真抓四个源再对答案）失败就跳过 —— 绿不绿不该取决于别人的服务器。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const feeds = require('./lib/feeds');
const image = require('./lib/image');
const song = require('./lib/song');
const flow = require('./lib/zhihu-flow');
const zhihu = require('./lib/zhihu');
const { validateSchema } = require('./lib/schema');
const { loadConfig } = require('./lib/config');
const { makeTools, CAPTION_MAX } = require('./tools');

const OLD_FEED_SERVICE = '/root/cyberboss/src/services/feed-service.js';
const PROD_SOCKET = '/root/.nova-gate/tools.sock';

// ————————————————————————— 小工具 —————————————————————————

// 所有临时目录记账，进程退出时统一收拾 —— 测试中途挂了也不留垃圾
const TMP_DIRS = [];
process.on('exit', () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 已删 */ } } });

function tmpdir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `hands-${tag}-`));
  TMP_DIRS.push(d);
  return d;
}

function tool(tools, name) {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, `没有工具 ${name}`);
  return t;
}

/** 假的 fetch 响应 */
function resp({ status = 200, body = '', statusText = 'OK' } = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300, status, statusText,
    async text() { return buf.toString('utf8'); },
    async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length); },
  };
}

/**
 * 假桥：一个 unix socket，记下每一条收到的请求，按 reply(req) 回。
 * 路径在临时目录里 —— 断言里再核一遍不是生产那个。
 */
async function fakeGate(reply = (req) => ({ ok: true, outcome: 'sent', intent: 'x', channel: 'telegram' })) {
  const dir = tmpdir('gate');
  const file = path.join(dir, 'tools.sock');
  assert.notEqual(file, PROD_SOCKET);
  const received = [];
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (c) => {
      buf += c.toString('utf8');
      const i = buf.indexOf('\n');
      if (i < 0) return;
      const req = JSON.parse(buf.slice(0, i));
      received.push(req);
      sock.write(JSON.stringify({ id: req.id, ...reply(req) }) + '\n');
    });
  });
  await new Promise((r) => server.listen(file, r));
  return {
    file, received,
    close: () => new Promise((r) => server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); r(); })),
  };
}

/** 用假桥的 askGate（走真的 _lib/gate.js，只是 socket 换成假的） */
function gateVia(file) {
  const { askGate } = require('../_lib/gate');
  return (payload) => askGate(payload, { socket: file, timeoutMs: 5000 });
}

const RSS = (n, prefix = 'r') => `<?xml version="1.0"?><rss><channel><title>ch</title>${
  Array.from({ length: n }, (_, i) => `<item><title>${prefix}${i} &amp; <b>t</b></title><description><![CDATA[<p>sum ${i}</p>]]></description><link>https://e.x/${prefix}/${i}</link></item>`).join('')
}</channel></rss>`;
const ATOM = (n) => `<feed xmlns="http://www.w3.org/2005/Atom">${
  Array.from({ length: n }, (_, i) => `<entry><title type="html">a${i}</title><summary>s${i}</summary><link rel="alternate" href="https://a.x/${i}"/></entry>`).join('')
}</feed>`;

// ————————————————————————— schema 闸 —————————————————————————

test('schema：required / 多给的键 / 类型 / 数组元素，报错原文照老的', () => {
  const s = { type: 'object', required: ['a'], properties: { a: { type: 'string' }, n: { type: 'integer' },
    x: { type: 'number' }, b: { type: 'boolean' }, arr: { type: 'array', items: { type: 'string' } } }, additionalProperties: false };
  assert.throws(() => validateSchema(s, {}, 'T', 'input'), { message: 'T input.a is required.' });
  assert.throws(() => validateSchema(s, { a: 'x', z: 1 }, 'T', 'input'), { message: 'T input.z is not allowed.' });
  assert.throws(() => validateSchema(s, { a: 1 }, 'T', 'input'), { message: 'T input.a must be a string.' });
  assert.throws(() => validateSchema(s, { a: 'x', n: 1.5 }, 'T', 'input'), { message: 'T input.n must be an integer.' });
  assert.throws(() => validateSchema(s, { a: 'x', x: Infinity }, 'T', 'input'), { message: 'T input.x must be a number.' });
  assert.throws(() => validateSchema(s, { a: 'x', b: 'true' }, 'T', 'input'), { message: 'T input.b must be a boolean.' });
  assert.throws(() => validateSchema(s, { a: 'x', arr: 'no' }, 'T', 'input'), { message: 'T input.arr must be an array.' });
  assert.throws(() => validateSchema(s, { a: 'x', arr: ['ok', 2] }, 'T', 'input'), { message: 'T input.arr[1] must be a string.' });
  assert.doesNotThrow(() => validateSchema(s, { a: 'x', n: 3, x: 1.5, b: false, arr: [] }, 'T', 'input'));
});

test('schema：每个工具进门都过闸（去掉的 chat_id / userId 现在会被拒）', async () => {
  const tools = makeTools({ env: {}, askGate: async () => { throw new Error('不该走到桥'); } });
  await assert.rejects(tool(tools, 'nova_sing').handler({ lyrics: ['a'], chat_id: '1' }),
    { message: 'nova_sing input.chat_id is not allowed.' });
  await assert.rejects(tool(tools, 'nova_image_generate').handler({ prompt: 'p', userId: 'u' }),
    { message: 'nova_image_generate input.userId is not allowed.' });
  await assert.rejects(tool(tools, 'nova_sing').handler({}), { message: 'nova_sing input.lyrics is required.' });
  await assert.rejects(tool(tools, 'nova_zhihu_post').handler({ title: 't', content: 'c', publish: 'true' }),
    { message: 'nova_zhihu_post input.publish must be a boolean.' });
  await assert.rejects(tool(tools, 'nova_feed_read').handler({ limit: 2.5 }),
    { message: 'nova_feed_read input.limit must be an integer.' });
  await assert.rejects(tool(tools, 'nova_sing').handler({ lyrics: ['a'], duration_ms: '30000' }),
    { message: 'nova_sing input.duration_ms must be a number.' });
});

test('schema：名字和入参跟老的一致，只动了投递那两处', () => {
  const tools = makeTools({ env: {} });
  assert.deepEqual(tools.map((t) => t.name),
    ['nova_feed_read', 'nova_image_generate', 'nova_zhihu_post', 'nova_sing']);
  const keys = (n) => Object.keys(tool(tools, n).inputSchema.properties).sort();
  assert.deepEqual(keys('nova_feed_read'), ['limit', 'source']);
  assert.deepEqual(keys('nova_image_generate'), ['background', 'channel', 'model', 'n', 'prompt', 'quality', 'send', 'size']);
  assert.deepEqual(keys('nova_zhihu_post'), ['content', 'publish', 'title', 'topics']);
  assert.deepEqual(keys('nova_sing'), ['caption', 'channel', 'duration_ms', 'lyrics', 'style_note', 'title']);
  assert.deepEqual(tool(tools, 'nova_sing').inputSchema.required, ['lyrics']);
  assert.deepEqual(tool(tools, 'nova_image_generate').inputSchema.required, ['prompt']);
  assert.deepEqual(tool(tools, 'nova_zhihu_post').inputSchema.required, ['title', 'content']);
  for (const t of tools) assert.equal(t.inputSchema.additionalProperties, false);
  // 描述里不许再出现「发去 Telegram / 微信」这种写死渠道的话
  // 9-20 改：歌默认发 TG（只有那条腿放得出来），说明里要写明
  assert.match(tool(tools, 'nova_sing').description, /voice message/);
  assert.doesNotMatch(tool(tools, 'nova_image_generate').description, /WeChat/);
  assert.match(tool(tools, 'nova_feed_read').inputSchema.properties.source.description,
    /Available: 少数派, 36氪, HackerNews, TheVerge\./);
});

// ————————————————————————— 配置 —————————————————————————

test('配置：家目录必须给（2026-10-21）；其余默认跟家目录拼，回退顺序照老 config.js', () => {
  assert.throws(() => loadConfig({}), /NOVA_STATE_DIR/);
  const home = '/x/home';
  const c = loadConfig({ NOVA_STATE_DIR: home });
  assert.equal(c.stateDir, home);
  assert.equal(c.imageApiBaseUrl, 'https://api.openai.com/v1');
  assert.equal(c.imageModel, 'gpt-image-2');
  assert.equal(c.imageOutputDir, path.join(home, 'generated-images'));
  assert.equal(c.imageTimeoutMs, 120000);
  assert.equal(c.songConfigFile, path.join(home, 'song-config.json'));
  assert.equal(c.songDir, os.tmpdir());
  assert.equal(c.zhihuProfile, path.join(home, 'browser-profile'));
  assert.equal(c.playwrightModule, require('node:path').join(require('node:os').homedir(), 'browser-mcp/node_modules/playwright'));
  assert.equal(c.display, ':99');
  assert.equal(c.elevenLabsApiKey, '');

  const r = loadConfig({ OPENAI_API_KEY: ' r8_abc ', OPENAI_BASE_URL: 'https://o/v1', NOVA_IMAGE_TIMEOUT_MS: '0', NOVA_STATE_DIR: '/s' });
  assert.equal(r.imageApiKey, 'r8_abc');
  assert.equal(r.imageModel, 'black-forest-labs/flux-schnell', 'r8_ 开头默认 flux-schnell');
  assert.equal(r.imageApiBaseUrl, 'https://o/v1');
  assert.equal(r.imageTimeoutMs, 120000, '0 回到 120 秒');
  assert.equal(r.imageOutputDir, '/s/generated-images');
  const p = loadConfig({ NOVA_IMAGE_API_KEY: 'sk-1', OPENAI_API_KEY: 'r8_2', NOVA_IMAGE_API_BASE_URL: 'https://c', OPENAI_BASE_URL: 'https://o',
    NOVA_IMAGE_MODEL: 'm', NOVA_IMAGE_TIMEOUT_MS: '5000abc', NOVA_STATE_DIR: '/p' });
  assert.equal(p.imageApiKey, 'sk-1', 'NOVA_IMAGE_API_KEY 优先');
  assert.equal(p.imageApiBaseUrl, 'https://c');
  assert.equal(p.imageModel, 'm');
  assert.equal(p.imageTimeoutMs, 5000, 'parseInt 语义');
});

// ————————————————————————— 兴趣源 —————————————————————————

test('兴趣源：stripTags 的每一步（含 &amp;lt; 解两层的老毛病）', () => {
  assert.equal(feeds.stripTags('<![CDATA[<p>a  b</p>]]>'), 'a b');
  assert.equal(feeds.stripTags('x&nbsp;&amp;&lt;&gt;&quot;&#39;y'), 'x &<>"\'y');
  assert.equal(feeds.stripTags('&amp;lt;'), '<', '先解 &amp; 再解 &lt;');
  assert.equal(feeds.stripTags('  \n a\t\tb \n'), 'a b');
  assert.equal(feeds.stripTags(null), '');
});

test('兴趣源：pickLink 先认 href 再认 <link> 文本；pickTag 大小写不敏感', () => {
  assert.equal(feeds.pickLink('<link rel="x" href=" https://h/1 "/>'), 'https://h/1');
  assert.equal(feeds.pickLink("<link href='https://h/2'/>"), 'https://h/2');
  assert.equal(feeds.pickLink('<link>https://l/1</link>'), 'https://l/1');
  assert.equal(feeds.pickTag('<TITLE a="1">Hi</TITLE>', 'title'), 'Hi');
  assert.equal(feeds.pickTag('<x/>', 'title'), '');
});

test('兴趣源：parseItems —— RSS / Atom 判定、空条目跳过、摘要 280 字、回退 summary/content', () => {
  const r = feeds.parseItems(RSS(2));
  assert.deepEqual(r[0], { title: 'r0 & t', summary: 'sum 0', link: 'https://e.x/r/0' });
  const a = feeds.parseItems(ATOM(2));
  assert.deepEqual(a[1], { title: 'a1', summary: 's1', link: 'https://a.x/1' });
  // 两种都有 → 按 RSS 走
  const mixed = feeds.parseItems(`<rss><item><title>i</title></item><entry><title>e</title></entry></rss>`);
  assert.deepEqual(mixed.map((x) => x.title), ['i']);
  // 标题摘要都没有的跳过；只有摘要的留下
  const sparse = feeds.parseItems('<rss><item><link>l</link></item><item><description>d</description></item></rss>');
  assert.deepEqual(sparse, [{ title: '', summary: 'd', link: '' }]);
  const long = feeds.parseItems(`<rss><item><title>t</title><description>${'字'.repeat(400)}</description></item></rss>`);
  assert.equal(long[0].summary.length, 280);
  const content = feeds.parseItems('<feed><entry><title>t</title><content>c</content></entry></feed>');
  assert.equal(content[0].summary, 'c');
  assert.deepEqual(feeds.parseItems(''), []);
});

test('兴趣源：source 大小写不敏感；认不出就读全部', () => {
  const list = feeds.SELF_FEEDS;
  assert.deepEqual(feeds.resolveFeeds(list, 'hackernews').map((f) => f.label), ['HackerNews']);
  assert.deepEqual(feeds.resolveFeeds(list, ' 少数派 ').map((f) => f.label), ['少数派']);
  assert.equal(feeds.resolveFeeds(list, 'nope').length, 4);
  assert.equal(feeds.resolveFeeds(list, '').length, 4);
});

test('兴趣源：每源取 ceil(limit/源数)、至少 1；拿不到的记 failed；整体截到 limit', async () => {
  const bodies = {
    'https://sspai.com/feed': RSS(5, 's'),
    'https://www.36kr.com/feed': '<rss></rss>',            // 0 条 → failed
    'https://hnrss.org/frontpage': null,                    // 网络错 → failed
    'https://www.theverge.com/rss/index.xml': RSS(5, 'v'),
  };
  const fetchImpl = async (url) => {
    if (bodies[url] === null) throw new Error('boom');
    return resp({ body: bodies[url] });
  };
  const r = await feeds.readFeeds({ limit: 10, fetchImpl });
  // perFeed = ceil(10/4) = 3
  assert.equal(r.items.filter((x) => x.feed === '少数派').length, 3);
  assert.equal(r.items.filter((x) => x.feed === 'TheVerge').length, 3);
  assert.deepEqual(r.failed.sort(), ['36氪', 'HackerNews'].sort());
  const one = await feeds.readFeeds({ limit: 1, fetchImpl });
  assert.equal(one.items.length, 1, 'perFeed 至少 1，最后截到 limit');
  const bad = await feeds.readFeeds({ source: '少数派', limit: 8, fetchImpl: async () => resp({ status: 403, body: RSS(3) }) });
  assert.deepEqual(bad, { items: [], failed: ['少数派'] }, '非 2xx 当拿不到');
});

test('兴趣源：8 秒超时（这里压成 50ms）、带浏览器头、跟随跳转', async () => {
  let seen;
  const hang = (url, opts) => { seen = opts; return new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(new Error('aborted')))); };
  const t0 = Date.now();
  assert.equal(await feeds.fetchText('https://x', { fetchImpl: hang, timeoutMs: 50 }), '');
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(seen.redirect, 'follow');
  assert.match(seen.headers['User-Agent'], /Chrome\/120/);
  assert.match(seen.headers.Accept, /application\/rss\+xml/);
  assert.equal(feeds.FETCH_TIMEOUT_MS, 8000);
});

test('兴趣源：工具层 limit 规矩（正整数、最多 20、否则 8）和回给他的文字', async () => {
  const seenLimits = [];
  const fetchImpl = async () => resp({ body: RSS(30) });
  const only = [{ label: 'L', url: 'https://l' }];
  const run = async (limit) => {
    const r = await feeds.feedRead(limit === undefined ? {} : { limit }, { feeds: only, fetchImpl });
    seenLimits.push(r.data.items.length);
    return r;
  };
  await run(undefined); await run(0); await run(-3); await run(25); await run(5);
  assert.deepEqual(seenLimits, [8, 8, 8, 20, 5]);
  const r = await feeds.feedRead({ limit: 1 }, { feeds: only, fetchImpl });
  assert.equal(r.text, '【L】r0 & t\nsum 0\nhttps://e.x/r/0');
  const two = await feeds.feedRead({ limit: 2 }, { feeds: only, fetchImpl });
  assert.equal(two.text.split('\n\n').length, 2, '条目之间空一行');
  const noSummary = await feeds.feedRead({}, { feeds: only, fetchImpl: async () => resp({ body: '<rss><item><title>T</title></item></rss>' }) });
  assert.equal(noSummary.text, '【L】T', '没摘要没链接就不带那两行');
  const empty = await feeds.feedRead({}, { feeds: only, fetchImpl: async () => resp({ body: '' }) });
  assert.equal(empty.text, 'No feed items available right now (failed: L).');
  assert.deepEqual(empty.data, { items: [], failed: ['L'] });
});

test('兴趣源：HANDS_FEEDS_FILE 名单 —— 好的能用，坏的明说', () => {
  const dir = tmpdir('feeds');
  const good = path.join(dir, 'g.json');
  fs.writeFileSync(good, JSON.stringify([{ label: ' A ', url: ' https://a ' }]));
  assert.deepEqual(feeds.loadFeeds(good), [{ label: 'A', url: 'https://a' }]);
  const bad = path.join(dir, 'b.json');
  fs.writeFileSync(bad, '{nope');
  assert.throws(() => feeds.loadFeeds(bad), /兴趣源名单读不了/);
  fs.writeFileSync(bad, JSON.stringify([{ label: 'x' }]));
  assert.throws(() => feeds.loadFeeds(bad), /格式不对/);
  assert.throws(() => feeds.loadFeeds(path.join(dir, 'missing.json')), /读不了/);
  assert.equal(feeds.loadFeeds(''), feeds.SELF_FEEDS);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 同一份输入喂老 feed-service 和新的，结果必须一模一样 */
async function goldenCompare(bodies, cases) {
  const old = require(OLD_FEED_SERVICE);
  assert.deepEqual(old.SELF_FEEDS, feeds.SELF_FEEDS, '名单跟老的一致');
  assert.deepEqual(old.listFeedLabels(), feeds.SELF_FEEDS.map((f) => f.label));
  const fake = async (url) => (bodies[url] == null ? resp({ status: 500 }) : resp({ body: bodies[url] }));
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = fake; // 老的只认全局 fetch
    for (const c of cases) {
      const o = await old.readFeeds(c);
      const n = await feeds.readFeeds({ ...c, fetchImpl: fake });
      // 顺序取决于哪个源先回来：替身是同步回的，两边顺序应一致；failed 也比
      assert.deepEqual(n, o, `case ${JSON.stringify(c)}`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('兴趣源：跟老 feed-service 对答案（固定样本）', async () => {
  const bodies = {
    'https://sspai.com/feed': RSS(6, 's'),
    'https://www.36kr.com/feed': ATOM(4),
    'https://hnrss.org/frontpage': null,
    'https://www.theverge.com/rss/index.xml': `<rss><item><title><![CDATA[Big &amp;lt; news]]></title><description>${'x '.repeat(300)}</description><link>https://v/1</link></item></rss>`,
  };
  await goldenCompare(bodies, [
    { limit: 8 }, { limit: 1 }, { limit: 20 }, { source: 'thevergE', limit: 8 }, { source: '不存在', limit: 3 }, { source: 'HackerNews', limit: 5 },
  ]);
});

test('兴趣源：跟老 feed-service 对答案（真抓四个源一次，两边吃同一份；网不通就跳过）', async (t) => {
  const bodies = {};
  let got = 0;
  await Promise.all(feeds.SELF_FEEDS.map(async (f) => {
    const txt = await feeds.fetchText(f.url);
    bodies[f.url] = txt || null;
    if (txt) got += 1;
  }));
  if (!got) return t.skip('四个源一个都没抓到（网络问题），跳过');
  t.diagnostic(`抓到 ${got}/4 个源`);
  await goldenCompare(bodies, [{ limit: 8 }, { limit: 20 }, { source: 'HackerNews', limit: 3 }]);
});

// ————————————————————————— 出图 —————————————————————————

function imgConfig(extra = {}) {
  const dir = tmpdir('img');
  return { imageApiKey: 'sk-test', imageApiBaseUrl: 'https://img.example/v1///', imageModel: 'cfg-model',
    imageOutputDir: path.join(dir, 'out'), imageTimeoutMs: 1000, ...extra, _root: dir };
}
const PNG_B64 = Buffer.from('fake-png-bytes').toString('base64');
const FIXED_NOW = () => Date.parse('2026-09-20T01:02:03.456Z');

test('出图：没 prompt / 没 key 的原话', async () => {
  await assert.rejects(image.generateImages({ prompt: '  ' }, imgConfig()), { message: 'Missing image prompt.' });
  await assert.rejects(image.generateImages({ prompt: 'p' }, imgConfig({ imageApiKey: '' })),
    { message: 'Missing image API key. Set NOVA_IMAGE_API_KEY or OPENAI_API_KEY.' });
});

test('出图：n 夹到 1..4；size / ratio / 模型名这些小规矩', () => {
  assert.equal(image.clampInteger(undefined, 1, 4, 1), 1);
  assert.equal(image.clampInteger(0, 1, 4, 1), 1);
  assert.equal(image.clampInteger(9, 1, 4, 1), 4);
  assert.equal(image.clampInteger('3', 1, 4, 1), 3);
  assert.equal(image.sizeToAspectRatio('1536x1024'), '3:2');
  assert.equal(image.sizeToAspectRatio('1024x1024'), '1:1');
  assert.equal(image.sizeToAspectRatio('0x10'), '');
  assert.equal(image.sizeToAspectRatio('big'), '');
  assert.equal(image.sizeToAspectRatio(''), '');
  assert.deepEqual(image.splitReplicateModel('a/b/c'), ['a', 'b/c']);
  assert.throws(() => image.splitReplicateModel('flux'), { message: 'Invalid Replicate model "flux". Expected format "owner/model".' });
  assert.equal(image.normalizeBaseUrl('https://x/v1//'), 'https://x/v1');
  assert.equal(image.normalizeBaseUrl(''), 'https://api.openai.com/v1');
  assert.equal(image.isReplicateApiKey('r8_x'), true);
});

test('出图（OpenAI）：请求形状、模型优先级、只收 b64、序号不补位', async () => {
  const cfg = imgConfig();
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return resp({ body: { data: [{ b64_json: PNG_B64 }, { url: 'no-b64' }, { b64_json: PNG_B64 }] } });
  };
  const r = await image.generateImages({ prompt: ' 画只猫 ', n: 7 }, cfg, { fetchImpl, now: FIXED_NOW });
  assert.equal(calls[0].url, 'https://img.example/v1/images/generations');
  assert.equal(calls[0].opts.headers.authorization, 'Bearer sk-test');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { model: 'cfg-model', prompt: '画只猫', n: 4, size: '1024x1024' });
  assert.deepEqual(r.files.map((f) => path.basename(f.filePath)), ['2026-09-20T01-02-03-456Z-1.png', '2026-09-20T01-02-03-456Z-3.png']);
  assert.equal(fs.readFileSync(r.files[0].filePath, 'utf8'), 'fake-png-bytes');
  assert.equal(r.files[0].bytes, 14);
  assert.deepEqual({ model: r.model, size: r.size, prompt: r.prompt }, { model: 'cfg-model', size: '1024x1024', prompt: '画只猫' });

  await image.generateImages({ prompt: 'p', model: 'arg-model', size: '1536x1024', quality: 'high', background: 'transparent' }, cfg, { fetchImpl, now: FIXED_NOW });
  assert.deepEqual(JSON.parse(calls[1].opts.body), { model: 'arg-model', prompt: 'p', n: 1, size: '1536x1024', quality: 'high', background: 'transparent' });
  await image.generateImages({ prompt: 'p' }, { ...cfg, imageModel: '' }, { fetchImpl, now: FIXED_NOW });
  assert.equal(JSON.parse(calls[2].opts.body).model, 'gpt-image-2');
  fs.rmSync(cfg._root, { recursive: true, force: true });
});

test('出图（OpenAI）：各种失败的原话；失败时不建目录', async () => {
  const cfg = imgConfig();
  const run = (body, status = 200, statusText = 'OK') =>
    image.generateImages({ prompt: 'p' }, cfg, { fetchImpl: async () => resp({ body, status, statusText }), now: FIXED_NOW });
  await assert.rejects(run({ data: [] }), { message: 'Image API returned no images.' });
  assert.equal(fs.existsSync(cfg.imageOutputDir), false, '没拿到图不建目录');
  await assert.rejects(run({ data: [{ url: 'x' }] }), { message: 'Image API response did not include b64_json images.' });
  await assert.rejects(run({ error: { message: 'bad key' } }, 401), { message: 'Image API failed (401): bad key' });
  await assert.rejects(run({ detail: 'nope' }, 422), { message: 'Image API failed (422): nope' });
  await assert.rejects(run('plain ' + 'x'.repeat(600), 500), (e) => e.message === `Image API failed (500): plain ${'x'.repeat(494)}`);
  await assert.rejects(run('', 503, 'Service Unavailable'), { message: 'Image API failed (503): Service Unavailable' });
  fs.rmSync(cfg._root, { recursive: true, force: true });
});

test('出图（OpenAI）：请求超时会中止', async () => {
  const cfg = imgConfig({ imageTimeoutMs: 30 });
  const hang = (url, opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(new Error('aborted by timeout'))));
  await assert.rejects(image.generateImages({ prompt: 'p' }, cfg, { fetchImpl: hang }), /aborted by timeout/);
  fs.rmSync(cfg._root, { recursive: true, force: true });
});

test('出图（Replicate）：建单 → 轮询 → 下载，入参只有 prompt/num_outputs/aspect_ratio', async () => {
  const cfg = imgConfig({ imageApiKey: 'r8_k', imageModel: 'black-forest-labs/flux-schnell' });
  const calls = [];
  const statuses = ['starting', 'processing', 'succeeded'];
  const sleeps = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url.endsWith('/predictions')) return resp({ status: 201, body: { urls: { get: 'https://rep/p/1' } } });
    if (url === 'https://rep/p/1') {
      const status = statuses.shift();
      return resp({ body: { status, output: status === 'succeeded' ? ['https://cdn/a.webp', '', 'https://cdn/b.webp'] : null } });
    }
    return resp({ body: Buffer.from(`img:${url}`) });
  };
  const r = await image.generateImages({ prompt: 'p', size: '1024x1536', quality: 'hd', background: 'x', n: 2 }, cfg,
    { fetchImpl, now: FIXED_NOW, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(calls[0].url, 'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions');
  assert.equal(calls[0].opts.headers.authorization, 'Token r8_k');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { input: { prompt: 'p', num_outputs: 2, aspect_ratio: '2:3' } });
  assert.equal(calls.filter((c) => c.url === 'https://rep/p/1').length, 3);
  assert.deepEqual(sleeps, [1000, 1000], '轮询间隔 1 秒');
  assert.deepEqual(r.files.map((f) => path.basename(f.filePath)), ['2026-09-20T01-02-03-456Z-1.png', '2026-09-20T01-02-03-456Z-3.png']);
  assert.equal(fs.readFileSync(r.files[1].filePath, 'utf8'), 'img:https://cdn/b.webp');
  assert.equal(r.size, '1024x1536');
  fs.rmSync(cfg._root, { recursive: true, force: true });
});

test('出图（Replicate）：failed / canceled / 超时 / 没 poll 地址 / 没输出 / 单个输出 / 下载失败', async () => {
  const cfg = imgConfig({ imageApiKey: 'r8_k', imageModel: '', imageTimeoutMs: 5000 });
  const mk = (pollBody, { created = { urls: { get: 'https://rep/p' } }, dl = 200 } = {}) => async (url) => {
    if (url.endsWith('/predictions')) return resp({ body: created });
    if (url === 'https://rep/p') return resp({ body: typeof pollBody === 'function' ? pollBody() : pollBody });
    return resp({ status: dl, body: 'bytes' });
  };
  const deps = (fetchImpl, now = FIXED_NOW) => ({ fetchImpl, now, sleep: async () => {} });
  await assert.rejects(image.generateImages({ prompt: 'p' }, cfg, deps(mk({ status: 'failed', error: 'NSFW' }))),
    { message: 'Replicate prediction failed: NSFW' });
  await assert.rejects(image.generateImages({ prompt: 'p' }, cfg, deps(mk({ status: 'canceled' }))),
    { message: 'Replicate prediction canceled: Replicate prediction canceled.' });
  await assert.rejects(image.generateImages({ prompt: 'p' }, cfg, deps(mk({}, { created: {} }))),
    { message: 'Replicate API response did not include a poll URL.' });
  await assert.rejects(image.generateImages({ prompt: 'p' }, cfg, deps(mk({ status: 'succeeded', output: [] }))),
    { message: 'Replicate prediction succeeded but returned no output images.' });
  await assert.rejects(image.generateImages({ prompt: 'p' }, cfg, deps(mk({ status: 'succeeded', output: [''] }))),
    { message: 'Replicate prediction output did not include any downloadable images.' });
  await assert.rejects(image.generateImages({ prompt: 'p' }, cfg, deps(mk({ status: 'succeeded', output: 'https://cdn/x' }, { dl: 404 }))),
    { message: 'Failed to download image (404): https://cdn/x' });
  // 时钟一直往前走 → 超时
  let t = 0;
  await assert.rejects(image.generateImages({ prompt: 'p' }, cfg, deps(mk({ status: 'processing' }), () => (t += 3000))),
    { message: 'Replicate prediction timed out after 5000ms (last status: processing).' });
  // 单个 URL 当一张；默认模型 flux-schnell
  const calls = [];
  const f = mk({ status: 'succeeded', output: 'https://cdn/one' });
  const r = await image.generateImages({ prompt: 'p' }, cfg, deps(async (u, o) => { calls.push(u); return f(u, o); }));
  assert.equal(r.files.length, 1);
  assert.equal(r.model, 'black-forest-labs/flux-schnell');
  assert.equal(r.size, '');
  assert.match(calls[0], /flux-schnell\/predictions$/);
  await assert.rejects(image.generateImages({ prompt: 'p', model: 'flux' }, cfg, deps(f)), /Invalid Replicate model "flux"/);
  fs.rmSync(cfg._root, { recursive: true, force: true });
});

test('出图工具：生成完把第一张交给桥（send_image + filePath），send:false 就不碰桥', async () => {
  const gate = await fakeGate(() => ({ ok: true, outcome: 'sent', intent: 'send_generated_image', channel: 'telegram' }));
  const dir = tmpdir('imgtool');
  const env = { NOVA_IMAGE_API_KEY: 'sk-x', NOVA_IMAGE_OUTPUT_DIR: dir, NOVA_STATE_DIR: dir };
  const fetchImpl = async () => resp({ body: { data: [{ b64_json: PNG_B64 }, { b64_json: PNG_B64 }] } });
  const tools = makeTools({ env, fetchImpl, now: FIXED_NOW, askGate: gateVia(gate.file) });
  const t = tool(tools, 'nova_image_generate');

  const r = await t.handler({ prompt: 'p', n: 2 });
  assert.equal(gate.received.length, 1);
  const req = gate.received[0];
  assert.equal(req.tool, 'send_image');
  assert.equal(req.text, '');
  assert.equal('channel' in req, false, '没给 channel 就不带 —— 桥按来路原路回');
  assert.deepEqual(req.args, { filePath: path.join(dir, '2026-09-20T01-02-03-456Z-1.png') });
  assert.match(r.text, /^Image generated: .*-1\.png, .*-2\.png \(first image sent\)$/);
  assert.equal(r.data.delivery.ok, true);

  await t.handler({ prompt: 'p', channel: 'wechat' });
  assert.equal(gate.received[1].channel, 'wechat');

  const quiet = await t.handler({ prompt: 'p', send: false });
  assert.equal(gate.received.length, 2, 'send:false 不连桥');
  assert.doesNotMatch(quiet.text, /sent/);
  assert.equal(quiet.data.delivery, null);
  await gate.close();

  // 桥说没发出去 → 报错，但路径一定在报错里（图已经花钱了）
  const blocked = await fakeGate(() => ({ ok: false, outcome: 'blocked', reason: 'platform_unsupported' }));
  const t2 = tool(makeTools({ env, fetchImpl, now: FIXED_NOW, askGate: gateVia(blocked.file) }), 'nova_image_generate');
  await assert.rejects(t2.handler({ prompt: 'p' }), (e) => /platform_unsupported/.test(e.message)
    && e.message.includes(path.join(dir, '2026-09-20T01-02-03-456Z-1.png')) && /send_image/.test(e.message));
  await blocked.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ————————————————————————— 唱歌 —————————————————————————

const SONG_CONF = {
  default: 'v1',
  voices: { v1: { positive: ['soft', 'airy'], negative: ['husky'] } },
  defaults: { duration_ms: 0 },   // 生产也是 0 = 按歌词行数算（9-20 起）
};

function songEnv(extra = {}) {
  const dir = tmpdir('song');
  const conf = path.join(dir, 'song-config.json');
  fs.writeFileSync(conf, JSON.stringify(SONG_CONF));
  return { dir, env: { NOVA_STATE_DIR: dir, ELEVENLABS_API_KEY: 'el-test', HANDS_SONG_CONFIG: conf, HANDS_SONG_DIR: path.join(dir, 'out'), ...extra } };
}

/** 真 mp3（ffmpeg 现造一段静音），拿来测标题标签；没有 ffmpeg 就用假字节 */
const HAVE_FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
function fakeMp3(dir) {
  if (!HAVE_FFMPEG) return Buffer.alloc(8000, 1);
  const f = path.join(dir, 'silence.mp3');
  spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '2', '-b:a', '128k', f]);
  return fs.readFileSync(f);
}

test('唱歌：歌词只筛空白行不修剪；时长按行数算、夹 10–120 秒；style_note 只追加到末尾', () => {
  assert.deepEqual(song.pickLines([' 你好 ', '', '   ', '再见']), [' 你好 ', '再见']);
  assert.deepEqual(song.pickLines('not array'), []);
  // 2026-09-20 Alice「歌不要默认30s」：没给时长 → 按行数（7 秒/行，至少 25 秒）
  assert.equal(song.clampDuration(undefined, {}, 4), 28000, '4 行 → 28 秒');
  assert.equal(song.clampDuration(undefined, {}, 2), 25000, '行少也不低于 25 秒');
  assert.equal(song.clampDuration(undefined, {}, 40), 120000, '行多顶到 120 秒');
  assert.equal(song.clampDuration(undefined, {}, 0), 25000, '没行数也不炸');
  assert.equal(song.clampDuration(0, { defaults: { duration_ms: 45000 } }, 4), 45000, '配置里钉死了就听配置');
  assert.equal(song.clampDuration(undefined, SONG_CONF, 4), 28000, '配置 defaults 是 0 → 还是按行数');
  assert.equal(song.clampDuration(5000, SONG_CONF), 10000);
  assert.equal(song.clampDuration(500000, SONG_CONF), 120000);
  assert.equal(song.clampDuration(61000, SONG_CONF), 61000);
  const plan = song.buildPlan({ lines: ['a'], voice: SONG_CONF.voices.v1, durationMs: 30000, styleNote: 'piano' });
  assert.deepEqual(plan, { composition_plan: {
    positive_global_styles: ['soft', 'airy', 'piano'], negative_global_styles: ['husky'],
    sections: [{ section_name: 'Verse', positive_local_styles: ['soft', 'airy', 'piano'], negative_local_styles: ['husky'], duration_ms: 30000, lines: ['a'] }],
  } });
  assert.deepEqual(song.buildPlan({ lines: ['a'], voice: SONG_CONF.voices.v1, durationMs: 1, styleNote: '' }).composition_plan.positive_global_styles, ['soft', 'airy']);
  assert.deepEqual(SONG_CONF.voices.v1.positive, ['soft', 'airy'], '不许改到配置本身');
});

test('唱歌：检查顺序 —— 歌词 → 配置 → key，全过了才花钱', async () => {
  const { dir, env } = songEnv();
  let paid = 0;
  const postMusic = async () => { paid += 1; return Buffer.alloc(8000); };
  const cfg = loadConfig(env);
  await assert.rejects(song.makeSong({ lyrics: ['  '] }, { ...cfg, songConfigFile: '/nope' }, { postMusic }),
    { message: 'lyrics 不能为空（一行一句，数组）' });
  await assert.rejects(song.makeSong({ lyrics: ['a'] }, { ...cfg, songConfigFile: path.join(dir, 'missing.json') }, { postMusic }),
    (e) => /^读不到歌喉配置 .*missing\.json: ENOENT/.test(e.message));
  const noVoice = path.join(dir, 'nv.json');
  fs.writeFileSync(noVoice, JSON.stringify({ default: 'ghost', voices: {} }));
  await assert.rejects(song.makeSong({ lyrics: ['a'] }, { ...cfg, songConfigFile: noVoice }, { postMusic }),
    { message: 'song-config.json 里没有音色 ghost' });
  await assert.rejects(song.makeSong({ lyrics: ['a'] }, { ...cfg, elevenLabsApiKey: '' }, { postMusic }),
    { message: 'ELEVENLABS_API_KEY 没配' });
  assert.equal(paid, 0, '前面任何一道没过都不许花钱');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('唱歌：出歌失败 / 音频太小都不发；成功落到 song-<毫秒>.mp3', async () => {
  const { dir, env } = songEnv();
  const cfg = loadConfig(env);
  await assert.rejects(song.makeSong({ lyrics: ['a'] }, cfg, { postMusic: async () => { throw new Error('HTTP 402: quota'); } }),
    { message: '出歌失败: HTTP 402: quota' });
  await assert.rejects(song.makeSong({ lyrics: ['a'] }, cfg, { postMusic: async () => Buffer.alloc(4999) }),
    { message: '出来的音频只有 4999 字节，不对劲，没敢发' });
  let sent;
  const r = await song.makeSong({ lyrics: ['a', '', 'b'], duration_ms: 12345, style_note: 'faster' }, cfg,
    { postMusic: async (x) => { sent = x; return Buffer.alloc(6000, 7); }, now: () => 1789000000000 });
  assert.equal(sent.apiKey, 'el-test');
  assert.deepEqual(sent.plan.composition_plan.sections[0].lines, ['a', 'b']);
  assert.equal(sent.plan.composition_plan.sections[0].duration_ms, 12345);
  assert.equal(r.file, path.join(env.HANDS_SONG_DIR, 'song-1789000000000.mp3'));
  assert.deepEqual({ bytes: r.bytes, seconds: r.seconds, voice: r.voice, titleTagged: r.titleTagged }, { bytes: 6000, seconds: 12, voice: 'v1', titleTagged: false });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('唱歌：title 写进 mp3 标签；ffmpeg 不在就不写、歌照样在', { skip: !HAVE_FFMPEG && 'ffmpeg 不在' }, async () => {
  const { dir, env } = songEnv();
  const mp3 = fakeMp3(dir);
  const r = await song.makeSong({ lyrics: ['a'], title: '给你的歌' }, loadConfig(env), { postMusic: async () => mp3 });
  assert.equal(r.titleTagged, true);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags=title', '-of', 'default=nw=1:nk=1', r.file], { encoding: 'utf8' });
  assert.equal(probe.stdout.trim(), '给你的歌');
  assert.equal(fs.existsSync(`${r.file}.tag.mp3`), false, '临时文件收拾掉');

  const r2 = await song.makeSong({ lyrics: ['a'], title: 't' }, loadConfig({ ...env, HANDS_FFMPEG: path.join(dir, 'no-ffmpeg') }),
    { postMusic: async () => mp3, now: () => 42 });
  assert.equal(r2.titleTagged, false);
  assert.deepEqual(fs.readFileSync(r2.file), mp3, '写不上标签，原歌一字节不动');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('唱歌工具：把歌交给假桥 —— send_voice + filePath，文字=歌词（冷层靠它记住）', async () => {
  const gate = await fakeGate(() => ({ ok: true, outcome: 'sent', intent: 'send_voice', channel: 'telegram' }));
  const { dir, env } = songEnv();
  const tools = makeTools({ env, askGate: gateVia(gate.file), postMusic: async () => Buffer.alloc(6000, 1), now: () => 1789000000001 });
  const t = tool(tools, 'nova_sing');

  const r = await t.handler({ lyrics: ['第一句', '  ', '第二句'], duration_ms: 20000 });
  assert.equal(r.text, '唱给她了（20 秒）。');
  assert.equal(gate.received.length, 1);
  const req = gate.received[0];
  assert.match(req.id, /^pkg-/);
  assert.equal(req.tool, 'send_voice');
  assert.equal(req.text, '第一句\n第二句');
  assert.equal('channel' in req, false, '不给 channel —— 跟着这一轮的来路（9-20 改成发语音条，微信也能收）');
  assert.deepEqual(req.args, { filePath: path.join(env.HANDS_SONG_DIR, 'song-1789000000001.mp3') });
  assert.ok(fs.statSync(req.args.filePath).size >= 5000, '递给桥的时候文件已经在盘上');
  assert.equal(r.data.sent, true);
  assert.equal(r.data.channel, 'telegram');
  assert.equal(r.data.file, req.args.filePath);

  // 他写了 caption 就用 caption；给了 channel 就带上
  await t.handler({ lyrics: ['a'], caption: ' 睡前听 ', channel: 'telegram' });
  assert.equal(gate.received[1].text, '睡前听');
  assert.equal(gate.received[1].channel, 'telegram');

  // 超过 Telegram caption 上限就截断（不然整首歌被拒）
  await t.handler({ lyrics: ['字'.repeat(700), '词'.repeat(700)] });
  const long = gate.received[2].text;
  assert.equal(long.length, CAPTION_MAX);
  assert.ok(long.endsWith('…'));
  await gate.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('唱歌工具：桥挡下 → 报错里带歌的路径、叫他别重唱；桥不在也一样', async () => {
  const { dir, env } = songEnv();
  const blocked = await fakeGate(() => ({ ok: false, outcome: 'blocked', reason: 'platform_unsupported', intent: 'send_voice', channel: 'imessage' }));
  const t = tool(makeTools({ env, askGate: gateVia(blocked.file), postMusic: async () => Buffer.alloc(6000), now: () => 7 }), 'nova_sing');
  await assert.rejects(t.handler({ lyrics: ['a'] }), (e) => e.message.includes('platform_unsupported')
    && e.message.includes(path.join(env.HANDS_SONG_DIR, 'song-7.mp3')) && e.message.includes('别重唱'));
  await blocked.close();

  const t2 = tool(makeTools({ env, askGate: gateVia(path.join(dir, 'no.sock')), postMusic: async () => Buffer.alloc(6000), now: () => 8 }), 'nova_sing');
  await assert.rejects(t2.handler({ lyrics: ['a'] }), (e) => /连不上桥/.test(e.message) && e.message.includes('song-8.mp3'));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ————————————————————————— 知乎 —————————————————————————

test('知乎：入参规矩 —— 标题/正文不能空、话题最多 5 个、publish 严格 true', () => {
  assert.deepEqual(flow.checkArgs({ title: ' ', content: 'c' }), { error: 'title 不能为空' });
  assert.deepEqual(flow.checkArgs({ title: 't', content: ' \n ' }), { error: 'content 不能为空' });
  const a = flow.checkArgs({ title: ' T ', content: ' body ', topics: ['1', '2', '3', '4', '5', '6'], publish: 'true' });
  assert.deepEqual(a, { title: 'T', content: ' body ', topics: ['1', '2', '3', '4', '5'], publish: false });
  assert.equal(flow.checkArgs({ title: 't', content: 'c', topics: 'x', publish: true }).publish, true);
  assert.deepEqual(flow.checkArgs({ title: 't', content: 'c', topics: 'x' }).topics, []);
});

test('知乎：SingletonLock 是悬空的符号链接也要认出来（lstat 不是 exists）', () => {
  const dir = tmpdir('prof');
  assert.equal(flow.profileLocked(dir), false);
  fs.symlinkSync('somehost-12345', path.join(dir, 'SingletonLock'));
  assert.equal(fs.existsSync(path.join(dir, 'SingletonLock')), false, '对照：exists 看不见它');
  assert.equal(flow.profileLocked(dir), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 假 chromium：记下所有动作，按剧本回。不开任何真浏览器。 */
function fakeChromium({ loggedIn = true, typed = null, urls = [], failTopic = '', launchError = null } = {}) {
  const log = { closed: 0, gotos: [], filled: [], inserted: '', clicks: [], topicsTried: [], waits: [] };
  let urlQueue = [...urls];
  let lastUrl = 'https://zhuanlan.zhihu.com/write';
  let pendingTopic = '';
  const loc = (sel, opts) => ({
    first() { return this; }, last() { return this; },
    async click() {
      log.clicks.push(opts?.hasText ? `button:${opts.hasText}` : sel);
      if (sel.startsWith('text="')) {
        const t = sel.slice(6, -1);
        if (t === failTopic) throw new Error(`Timeout 8000ms exceeded waiting for ${sel}`);
        log.topicsTried.push(t);
      }
    },
    async fill(v) { log.filled.push([sel, v]); if (sel.includes('搜索话题')) pendingTopic = v; },
    async innerText() { return typed == null ? log.inserted : typed; },
  });
  const page = {
    async goto(u) { log.gotos.push(u); },
    async waitForTimeout(ms) { log.waits.push(ms); },
    locator: loc,
    keyboard: { async insertText(t) { log.inserted = t; } },
    url() { if (urlQueue.length) lastUrl = urlQueue.shift(); return lastUrl; },
  };
  const ctx = {
    pages: () => [page],
    async newPage() { return page; },
    async cookies() { return loggedIn ? [{ name: 'z_c0', value: 'v' }] : [{ name: 'z_c0', value: '' }]; },
    async close() { log.closed += 1; },
  };
  return { log, chromium: { async launchPersistentContext(p, o) { log.launch = { p, o }; if (launchError) throw launchError; return ctx; } } };
}

test('知乎流程：存草稿 —— 登录 → 标题 → 一次灌正文 → 话题（加不上只记一笔）→ 不点发布', async () => {
  const dir = tmpdir('zh');
  const f = fakeChromium({ urls: ['https://zhuanlan.zhihu.com/p/123/edit'], failTopic: '冷门' });
  const r = await flow.runZhihuPost({ title: '拍品', content: '正文'.repeat(50), topics: ['原创小说', '冷门', '3', '4', '5', '6'] },
    { chromium: f.chromium, profile: dir });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'draft');
  assert.equal(r.id, '123');
  assert.equal(r.editUrl, 'https://zhuanlan.zhihu.com/p/123/edit');
  assert.equal(r.chars, 100);
  assert.deepEqual(f.log.launch.o, { headless: false, args: ['--no-sandbox'], viewport: { width: 1280, height: 900 } });
  assert.equal(f.log.launch.p, dir);
  assert.deepEqual(f.log.gotos, ['https://www.zhihu.com/', 'https://zhuanlan.zhihu.com/write']);
  assert.equal(f.log.inserted, '正文'.repeat(50), '正文一次塞进去');
  assert.deepEqual(f.log.topicsTried, ['原创小说', '3', '4', '5'], '第 6 个不试；冷门那个失败了');
  assert.ok(r.log.some((l) => l.startsWith('话题 冷门 没加上: ')));
  assert.ok(!f.log.clicks.some((c) => c.startsWith('button:')), '草稿不点发布');
  assert.equal(f.log.closed, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('知乎流程：没登录 / 正文没灌进去 / 被占用，都不往下走且关浏览器', async () => {
  const dir = tmpdir('zh');
  let f = fakeChromium({ loggedIn: false });
  assert.deepEqual(await flow.runZhihuPost({ title: 't', content: 'c' }, { chromium: f.chromium, profile: dir }),
    { ok: false, error: '知乎未登录（没有 z_c0）。让 Keeper 重新扫码。' });
  assert.equal(f.log.closed, 1);

  // 1000 字只进去 150 → 150 < min(500, 200) → 停
  f = fakeChromium({ typed: 'x'.repeat(150) });
  let r = await flow.runZhihuPost({ title: 't', content: 'y'.repeat(1000) }, { chromium: f.chromium, profile: dir });
  assert.equal(r.ok, false);
  assert.equal(r.error, '正文只进去 150 字（应为 1000），没敢往下走');
  // 短文按一半算：10 字进去 5 个刚好够
  f = fakeChromium({ typed: 'x'.repeat(5), urls: ['https://zhuanlan.zhihu.com/write'] });
  r = await flow.runZhihuPost({ title: 't', content: 'y'.repeat(10) }, { chromium: f.chromium, profile: dir });
  assert.equal(r.ok, true);
  assert.equal(r.id, '');
  assert.equal(r.editUrl, 'https://zhuanlan.zhihu.com/write', '没 id 就给原地址');

  f = fakeChromium({ launchError: new Error('Failed: The browser is already in use by another instance') });
  r = await flow.runZhihuPost({ title: 't', content: 'c' }, { chromium: f.chromium, profile: dir });
  assert.deepEqual({ ok: r.ok, busy: r.busy, error: r.error }, { ok: false, busy: true, error: flow.BUSY_MSG });
  f = fakeChromium({ launchError: new Error('net::ERR_NAME_NOT_RESOLVED') });
  r = await flow.runZhihuPost({ title: 't', content: 'c' }, { chromium: f.chromium, profile: dir });
  assert.deepEqual({ busy: r.busy, error: r.error }, { busy: false, error: 'net::ERR_NAME_NOT_RESOLVED' });

  fs.symlinkSync('host-1', path.join(dir, 'SingletonLock'));
  f = fakeChromium();
  r = await flow.runZhihuPost({ title: 't', content: 'c' }, { chromium: f.chromium, profile: dir });
  assert.deepEqual(r, { ok: false, busy: true, error: flow.BUSY_MSG });
  assert.equal(f.log.launch, undefined, '被占用就根本不启动');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('知乎流程：发布 —— 地址栏跳到 /p/<id> 算成功；40 秒没跳算 unknown', async () => {
  const dir = tmpdir('zh');
  let f = fakeChromium({ urls: ['https://zhuanlan.zhihu.com/p/9/edit', 'https://zhuanlan.zhihu.com/p/9/edit', 'https://zhuanlan.zhihu.com/p/9'] });
  let r = await flow.runZhihuPost({ title: 't', content: 'c', publish: true }, { chromium: f.chromium, profile: dir });
  assert.deepEqual({ ok: r.ok, state: r.state, id: r.id, url: r.url }, { ok: true, state: 'published', id: '9', url: 'https://zhuanlan.zhihu.com/p/9' });
  assert.ok(f.log.clicks.includes('button:/^发布$/'));

  f = fakeChromium({ urls: ['https://zhuanlan.zhihu.com/p/9/edit'] });
  r = await flow.runZhihuPost({ title: 't', content: 'c', publish: true }, { chromium: f.chromium, profile: dir });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'unknown');
  assert.equal(r.id, '9');
  assert.match(r.error, /40 秒内地址栏没跳走.*别重复发/);
  assert.equal(f.log.waits.filter((w) => w === 2000).length, 1 + 20, '草稿等 2 秒 + 发布轮询 20 次 × 2 秒');
  assert.equal(f.log.closed, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('知乎工具：子进程接线 —— 真起 scripts/zhihu-post.js，Playwright 换成假模块', async () => {
  const dir = tmpdir('zhw');
  const fakePw = path.join(dir, 'fake-playwright.js');
  // 假 Playwright：一次成功的草稿流程，并把 DISPLAY 写进结果好核对
  fs.writeFileSync(fakePw, `
    const page = { goto: async () => {}, waitForTimeout: async () => {}, keyboard: { insertText: async (t) => { page._t = t; } },
      locator: () => ({ first() { return this; }, last() { return this; }, click: async () => {}, fill: async () => {}, innerText: async () => page._t }),
      url: () => 'https://zhuanlan.zhihu.com/p/77/edit' };
    exports.chromium = { launchPersistentContext: async (p) => {
      require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'seen.json'))}, JSON.stringify({ p, display: process.env.DISPLAY }));
      return { pages: () => [page], cookies: async () => [{ name: 'z_c0', value: 'v' }], close: async () => {} }; } };
  `);
  const profile = path.join(dir, 'profile');
  fs.mkdirSync(profile);
  const env = { ...process.env, HANDS_PLAYWRIGHT: fakePw, HANDS_ZHIHU_PROFILE: profile, NOVA_STATE_DIR: dir };
  delete env.DISPLAY;
  const tools = makeTools({ env, zhihuOpts: { env } });
  const t = tool(tools, 'nova_zhihu_post');
  const r = await t.handler({ title: '标题', content: '一段正文' });
  assert.equal(r.text, '已存草稿（没发布）：https://zhuanlan.zhihu.com/p/77/edit（正文 4 字）');
  assert.equal(r.data.state, 'draft');
  const seen = JSON.parse(fs.readFileSync(path.join(dir, 'seen.json'), 'utf8'));
  assert.deepEqual(seen, { p: profile, display: ':99' }, 'profile 走配置；DISPLAY 默认 :99');

  // 子进程里的闸也生效：悬空锁 → 忙
  fs.symlinkSync('h-1', path.join(profile, 'SingletonLock'));
  await assert.rejects(t.handler({ title: 't', content: 'c' }), { message: flow.BUSY_MSG });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('知乎工具：子进程不给 JSON / 超时被杀 / ok=false 没 error', async () => {
  const dir = tmpdir('zhs');
  const junk = path.join(dir, 'junk.js');
  fs.writeFileSync(junk, "process.stdin.resume(); process.stdin.on('end', () => { console.error('Traceback: boom'); process.stdout.write('not json'); });");
  let r = await zhihu.runScript({}, { script: junk });
  assert.deepEqual(r, { ok: false, error: '脚本没给回 JSON: Traceback: boom\n' });

  const hang = path.join(dir, 'hang.js');
  fs.writeFileSync(hang, 'setInterval(() => {}, 1000);');
  const t0 = Date.now();
  r = await zhihu.runScript({}, { script: hang, killAfterMs: 200 });
  assert.equal(r.ok, false);
  assert.match(r.error, /^脚本没给回 JSON/);
  assert.ok(Date.now() - t0 < 5000, '到点被杀');
  assert.equal(zhihu.KILL_AFTER_MS, 300000);

  const silent = path.join(dir, 'silent.js');
  fs.writeFileSync(silent, "process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ ok: false })));");
  await assert.rejects(zhihu.zhihuPost({ title: 't', content: 'c' }, { display: ':1' }, { script: silent }), { message: '知乎发文失败' });

  const pub = path.join(dir, 'pub.js');
  fs.writeFileSync(pub, `let s=''; process.stdin.on('data', d => s += d); process.stdin.on('end', () => {
    const a = JSON.parse(s); console.log('noise'); console.log(JSON.stringify({ ok: true, state: 'published', url: 'https://z/p/1', chars: 3, echo: a })); });`);
  const ok = await zhihu.zhihuPost({ title: 't', content: 'c' }, { display: ':1' }, { script: pub });
  assert.equal(ok.text, '已发布：https://z/p/1（正文 3 字）');
  assert.deepEqual(ok.data.echo, { title: 't', content: 'c', topics: [], publish: false }, '递给子进程的形状照老的');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ————————————————————————— 端到端：真起 MCP 进程 —————————————————————————

function rpc(child) {
  let buf = '';
  const waiting = new Map();
  child.stdout.on('data', (c) => {
    buf += c;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) {
      if (!l.trim()) continue;
      const m = JSON.parse(l);
      waiting.get(m.id)?.(m);
    }
  });
  let n = 0;
  return (method, params) => new Promise((resolve, reject) => {
    const id = ++n;
    const timer = setTimeout(() => reject(new Error(`${method} 没回`)), 15000);
    waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

test('端到端：起 mcp-server.js → initialize → tools/list → tools/call feed_read（本地假源）', async () => {
  // 本地 HTTP 服务当兴趣源 —— 结果确定，不看外网脸色
  const server = http.createServer((req, res) => {
    if (req.url === '/a') { res.writeHead(200, { 'content-type': 'application/rss+xml' }); return res.end(RSS(3, 'a')); }
    if (req.url === '/b') { res.writeHead(200); return res.end(ATOM(3)); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = tmpdir('e2e');
  const feedsFile = path.join(dir, 'feeds.json');
  fs.writeFileSync(feedsFile, JSON.stringify([{ label: 'A', url: `${base}/a` }, { label: 'B', url: `${base}/b` }, { label: 'Dead', url: `${base}/x` }]));
  const gate = await fakeGate();

  const env = { ...process.env, HANDS_FEEDS_FILE: feedsFile, GATE_TOOL_SOCKET: gate.file, NOVA_STATE_DIR: dir,
    NOVA_IMAGE_API_KEY: '', OPENAI_API_KEY: '', ELEVENLABS_API_KEY: '' };
  const child = spawn(process.execPath, [path.join(__dirname, 'mcp-server.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  const call = rpc(child);
  try {
    const init = await call('initialize', { protocolVersion: '2024-11-05' });
    assert.equal(init.result.serverInfo.name, 'hands');
    assert.deepEqual(init.result.capabilities, { tools: {} });

    const list = await call('tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    // 9-20：去掉 cyberboss_ 前缀
    assert.deepEqual(names, ['feed_read', 'image_generate', 'zhihu_post', 'sing']);
    const feedTool = list.result.tools[0];
    assert.match(feedTool.inputSchema.properties.source.description, /Available: A, B, Dead\./);
    const sing = list.result.tools[3];
    assert.equal('chat_id' in sing.inputSchema.properties, false);
    assert.equal(sing.inputSchema.properties.channel.type, 'string');

    const r = await call('tools/call', { name: 'nova_feed_read', arguments: { limit: 4 } });
    assert.equal(r.result.isError, undefined);
    const text = r.result.content[0].text;
    // 壳的格式：text + 换行 + JSON 的 data
    const [head, ...rest] = text.split('\n{');
    const data = JSON.parse('{' + rest.join('\n{'));
    assert.deepEqual(data.failed, ['Dead']);
    assert.equal(data.items.length, 4);
    assert.deepEqual(data.items.map((i) => i.feed).sort(), ['A', 'A', 'B', 'B'], 'perFeed = ceil(4/3) = 2');
    assert.match(head, /【A】a0 & t\nsum 0\nhttps:\/\/e\.x\/a\/0/);
    assert.match(head, /【B】a0\ns0\nhttps:\/\/a\.x\/0/);

    const one = await call('tools/call', { name: 'nova_feed_read', arguments: { source: 'b', limit: 1 } });
    assert.match(one.result.content[0].text, /^【B】a0\ns0\nhttps:\/\/a\.x\/0\n/);

    // 闸在进程里也生效；没配密钥的工具说人话、不连桥
    const bad = await call('tools/call', { name: 'nova_sing', arguments: { lyrics: ['a'], chat_id: '1' } });
    assert.equal(bad.result.isError, true);
    assert.equal(bad.result.content[0].text, 'nova_sing input.chat_id is not allowed.');
    const nokey = await call('tools/call', { name: 'nova_image_generate', arguments: { prompt: 'p' } });
    assert.equal(nokey.result.content[0].text, 'Missing image API key. Set NOVA_IMAGE_API_KEY or OPENAI_API_KEY.');
    assert.equal(gate.received.length, 0, '什么都没造出来就不许碰桥');
    assert.match(stderr, /装上 4 个工具/);
  } finally {
    child.kill();
    server.close();
    await gate.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 9-20 Keeper：出图是 webp 冒充 .png → 原地转成真 PNG（微信插头按 PNG 粘贴）
test('出图：webp 冒充 .png 会被转成真 PNG；本来就是 PNG 的不动', () => {
  const { ensurePng } = require('./lib/image');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hands-png-'));
  try {
    const fake = path.join(dir, 'a.png');
    require('node:child_process').spawnSync('/usr/bin/convert', ['-size', '8x8', 'xc:blue', 'webp:' + fake]);
    assert.equal(fs.readFileSync(fake).toString('latin1', 8, 12), 'WEBP');
    ensurePng(fake);
    assert.equal(fs.readFileSync(fake).toString('latin1', 1, 4), 'PNG');
    const before = fs.readFileSync(fake);
    ensurePng(fake);
    assert.deepEqual(fs.readFileSync(fake), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
