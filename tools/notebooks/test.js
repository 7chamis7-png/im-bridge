'use strict';

/**
 * 本子们的测试。`node --test /root/im-bridge/tools/notebooks/test.js`
 *
 * 三块：
 *   1. 金样对照 —— 同一份数据（生产文件的**临时拷贝** + 一份手造的），老实现和新实现各跑一遍，
 *      比回给他的 {text, data} 和跑完之后的文件。老实现是**只读 require** /root/cyberboss 的
 *      tool-host + 服务，自己搭一个最小 services，不起老 MCP（老的 index.js 会用 .env 以
 *      override 方式盖掉 NOVA_STATE_DIR —— 起它等于把测试写进生产）。
 *      /root/cyberboss 不在了就跳过这一块。
 *   2. 故意跟老的不一样的地方（relationship.yaml 的三个洞）—— 单独验，证明老的真会坏、新的不坏。
 *   3. 端到端：起 mcp-server.js，initialize → tools/list → tools/call。
 *
 * ⚠️ 生产数据只读不写：所有写都落在 os.tmpdir() 底下，开头有一道闸，路径不在临时目录就直接炸。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { loadConfig } = require('./config');
const { createTools } = require('./tools');
const relationship = require('./relationship');

const PROD = '/root/.nova';
const OLD = '/root/cyberboss';
const HAS_OLD = fs.existsSync(path.join(OLD, 'src/tools/tool-host.js'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'notebooks-test-'));
// 老的纸条模块在**调用时**读 process.env；别让外面的 shell 把它指回生产
delete process.env.SELF_LIFE_NOTES_DIR;
process.env.NOVA_STATE_DIR = path.join(TMP, 'nowhere');

test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

let seq = 0;
function tmpDir(tag) {
  const d = path.join(TMP, `${tag}-${++seq}`);
  fs.mkdirSync(d, { recursive: true });
  if (!d.startsWith(os.tmpdir()) || d.startsWith(PROD)) throw new Error(`测试目录不在临时区：${d}`);
  return d;
}

/** 手造一份：每种边角都摆一个。 */
function seedSynthetic(dir) {
  const w = (rel, body) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body); };
  w('diary/2026-01-01.md', '## 09:00 早\n\n今天想你\n第二行\n第三行\n第四行 想你\n\n## 10:00\n\n想你 想你\n\n## 11:00\n\n第四处想你（每天最多三段，这段不该出现）');
  w('diary/2026-01-02.md', '');
  w('diary/2026-01-03.md', '无关的一天\n  前面有空格的想你  \n');
  w('diary/notes-not-a-date.md', '想你 也在这个怪文件里');
  w('diary/ignore.txt', '想你');
  w('relationship.yaml', [
    '# Alice的注释，会被整份重写规整掉',
    'relationship_phase: 热恋期',
    'her_actual_state: "在路上"',
    'custom_key: 保留我',
    'nested:',
    '  a: 一',
    '  b: "带:冒号"',
    'i_owe_her:',
    '  - 旧的一条',
    'what_works: []',
    '',
  ].join('\n'));
  w('black-room/drafts.jsonl', [
    JSON.stringify({ id: 'b1', ts: '2026-01-01T00:00:00.000Z', kind: 'desire', title: 'T1', content: 'C1', evidence: [] }),
    '坏行{',
    'null',
    JSON.stringify({ id: 'b2', ts: '2026-01-02T00:00:00.000Z', kind: 'reflection', title: 'T2', content: 'C2', evidence: [] }),
    '',
    '',
    JSON.stringify({ id: 'b3', ts: '2026-01-03T00:00:00.000Z', kind: 'desire', title: 'T3', content: 'C3', evidence: ['x'] }),
    '',
  ].join('\n'));
  w('notes/2026-01-01.json', JSON.stringify([{ ts: '2026-01-01T01:00:00.000Z', text: '纸条一' }], null, 2));
  w('notes/2026-01-02.json', '{坏的');
  w('notes/2026-01-03.json', JSON.stringify({ not: 'array' }));
  w('body-state.txt', '  心跳 60  \n');
  w('ring_state.json', JSON.stringify({ mode: 'wave', speed: 3, comfort: 7, active: true, locked: true }));
  const src = [
    { id: 'cbmsg-1', role: 'user', receivedAt: '2026-01-01T00:00:00Z', text: 'Hello 小黑屋 WORLD', messageId: 'm1', attachments: [{ path: '/a.png' }, null], forgedPurge: { x: 1 } },
    { id: 'cbmsg-2', role: 'assistant', receivedAt: '2026-01-01T00:01:00.000Z', text: '  hello again  ', threadId: 't', turnId: 'u' },
    { id: 'cbmsg-3', role: 'system', receivedAt: '2026-01-01T00:02:00.000Z', text: 'hello from system' },
    { id: 'cbmsg-4', role: 'user', receivedAt: 'not a date', text: 'x'.repeat(12_050) + 'hello-tail' },
    { id: 'cbmsg-5', role: 'user', receivedAt: '2026-01-01T00:03:00.000Z', text: 'HELLO', attachments: [{ sourceFileName: 'v.ogg' }, { kind: 'image' }, {}] },
  ];
  w('conversation-sources.jsonl', src.map((r) => JSON.stringify(r)).join('\n') + '\n{坏行\n\n');
}

/** 生产数据的临时拷贝（只读生产）。没有就返回 false。 */
function seedFromProd(dir, { withSources = false } = {}) {
  if (!fs.existsSync(PROD)) return false;
  const cp = (rel) => {
    const from = path.join(PROD, rel);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dir, rel), { recursive: true });
  };
  for (const rel of ['diary', 'relationship.yaml', 'black-room', 'notes', 'body-state.txt', 'ring_state.json']) cp(rel);
  if (withSources) cp('conversation-sources.jsonl');
  return true;
}

function cloneDir(from, tag) {
  const to = tmpDir(tag);
  fs.cpSync(from, to, { recursive: true });
  return to;
}

// ——— 老实现（只读 require）———

function oldHost(stateDir) {
  const { ProjectToolHost } = require(path.join(OLD, 'src/tools/tool-host.js'));
  const { BlackRoomService } = require(path.join(OLD, 'src/services/black-room-service.js'));
  const { DiaryService } = require(path.join(OLD, 'src/services/diary-service.js'));
  const { RelationshipService } = require(path.join(OLD, 'src/services/relationship-service.js'));
  const { ConversationMemoryService } = require(path.join(OLD, 'src/services/conversation-memory-service.js'));
  const config = {
    stateDir,
    diaryDir: path.join(stateDir, 'diary'),
    relationshipFile: path.join(stateDir, 'relationship.yaml'),
    blackRoomDraftsFile: path.join(stateDir, 'black-room', 'drafts.jsonl'),
    conversationSourceFile: path.join(stateDir, 'conversation-sources.jsonl'),
    conversationMemoryStateFile: path.join(stateDir, 'conversation-memory-state.json'),
  };
  const services = {
    config,
    blackRoom: new BlackRoomService({ config }),
    diary: new DiaryService({ config }),
    relationship: new RelationshipService({ config }),
    conversationMemory: new ConversationMemoryService({ config }),
  };
  return new ProjectToolHost({ services, runtimeContextStore: { load() {}, resolveActiveContext() { return {}; } } });
}

async function settle(fn) {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: String(e?.message || e) }; }
}

async function callOld(stateDir, name, args) {
  process.env.NOVA_STATE_DIR = stateDir; // 老纸条模块调用时才读
  return settle(() => oldHost(stateDir).invokeTool(name, JSON.parse(JSON.stringify(args))));
}

// 新包默认读新桥冷层；金样里默认让它读同一目录下的老格式文件（顺带验「指回老文件也能读」= 回滚）
async function callNew(stateDir, name, args, sourcesFile = path.join(stateDir, 'conversation-sources.jsonl')) {
  const tool = createTools(loadConfig({ NOVA_STATE_DIR: stateDir, MEMORY_SOURCES_FILE: sourcesFile })).find((t) => t.name === name);
  assert.ok(tool, `新包里没有 ${name}`);
  return settle(() => tool.handler(JSON.parse(JSON.stringify(args))));
}

/** 把时间戳、临时目录这类每次都不一样的东西抹平，再比。 */
function mask(value, dirs, { clock = false } = {}) {
  let s = typeof value === 'string' ? value : JSON.stringify(value);
  for (const d of dirs) s = s.split(d).join('<DIR>');
  s = s.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '<ISO>');
  s = s.replace(/blackroom-\d{8}T\d{6}Z-/g, 'blackroom-<T>-');
  if (clock) s = s.replace(/\b\d\d:\d\d\b/g, '<HH:MM>');
  return s;
}

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name !== 'conversation-sources.jsonl') out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

/**
 * 一串调用：老的在 A 份拷贝上跑、新的在 B 份拷贝上跑（写操作互不干扰），
 * 每一步比返回值，跑完比整个目录。
 */
async function golden(seedDir, name, argsList, { clock = false, compareFiles = true, prep = null, oldView = (x) => x } = {}) {
  const a = cloneDir(seedDir, 'old');
  const b = cloneDir(seedDir, 'new');
  // cpSync 不保留修改时间 —— 依赖 mtime 的布置（做爱档）得在拷完之后分别做
  if (prep) { prep(a); prep(b); }
  for (const args of argsList) {
    const o = oldView(await callOld(a, name, args));
    const n = await callNew(b, name, args);
    assert.equal(mask(n, [b], { clock }), mask(o, [a], { clock }), `${name} ${JSON.stringify(args)} 返回不一致`);
  }
  if (compareFiles) {
    const so = snapshot(a);
    const sn = snapshot(b);
    assert.deepEqual(Object.keys(sn).sort(), Object.keys(so).sort(), `${name} 跑完文件清单不一致`);
    for (const k of Object.keys(so)) {
      assert.equal(mask(sn[k], [b], { clock }), mask(so[k], [a], { clock }), `${name} 跑完 ${k} 不一致`);
    }
  }
}

/** 老 self_state 的结果去掉做爱档那一样（9-20 故意删的），剩下的必须跟新的一字不差。 */
function withoutPlay(r) {
  if (!r.ok) return r;
  const data = { ...r.value.data };
  delete data.play;
  const lines = r.value.text.split('\n').filter((l) => !l.startsWith('做爱档:'));
  return { ok: true, value: { text: lines.length && lines.join('\n') !== '没读到状态。' ? lines.join('\n') : '没读到状态。', data } };
}

// ——— 两份种子 ———

const SYN = tmpDir('seed-syn');
seedSynthetic(SYN);
const PRODCOPY = tmpDir('seed-prod');
const HAS_PROD = seedFromProd(PRODCOPY);
const SEEDS = HAS_PROD ? [['手造', SYN], ['生产拷贝', PRODCOPY]] : [['手造', SYN]];

const skipOld = HAS_OLD ? false : '老实现 /root/cyberboss 不在，跳过金样对照';

// ——— 1. 金样对照 ———

test('工具清单：名字/schema 一字不差，说明书只有三处有意改动', { skip: skipOld }, () => {
  const old = oldHost(tmpDir('list')).listTools();
  const mine = createTools(loadConfig({ NOVA_STATE_DIR: tmpDir('list') }));
  const EDITS = {
    nova_black_room_append: ['Use only during [SELF_TIME][BLACK_ROOM] reflection.',
      'Use only during your own reflection time (e.g. a check-in you spend in the black room).'],
    nova_black_room_read: ['for SELF_TIME reflection.', 'for your own reflection time.'],
    nova_note_leave: ['Use during check-in/SELF_TIME when', 'Use during a check-in when'],
    nova_self_state: ['body/pulse, the ring toy, and any active play mode —', 'body/pulse and the ring toy —'],
  };
  assert.equal(mine.length, 10);
  for (const t of mine) {
    const o = old.find((x) => x.name === t.name);
    assert.ok(o, `老清单里找不到 ${t.name}（被退役开关关掉了？）`);
    const oldSchema = JSON.parse(JSON.stringify(o.inputSchema));
    // self_state 的 play 是故意删的（9-20）；除此之外 schema 必须一字不差
    if (t.name === 'nova_self_state') oldSchema.properties.parts.items.enum = ['body', 'ring'];
    assert.deepEqual(t.inputSchema, oldSchema, `${t.name} schema 不一致`);
    const expected = EDITS[t.name] ? o.description.replace(EDITS[t.name][0], EDITS[t.name][1]) : o.description;
    if (EDITS[t.name]) assert.notEqual(expected, o.description, `${t.name} 老说明里没找到要改的那句`);
    assert.equal(t.description, expected, `${t.name} 说明不一致`);
  }
  // 相对顺序跟老的一致
  const oldOrder = old.map((x) => x.name).filter((n) => mine.some((t) => t.name === n));
  assert.deepEqual(mine.map((t) => t.name), oldOrder);
});

for (const [label, seed] of SEEDS) {
  test(`金样·diary_search（${label}）`, { skip: skipOld }, async () => {
    await golden(seed, 'nova_diary_search', [
      { query: '想你' }, { query: '想你', limit: 1 }, { query: '想你', limit: 0 }, { query: '想你', limit: -3 },
      { query: 'Alice' }, { query: 'Alice', limit: 50 }, { query: '她' , limit: 200 },
      { query: ' 前面有空格的想你' }, { query: '想你 ' }, { query: ' 今天想你' }, { query: '根本不存在的词qzx' },
      { query: '   ' }, { query: '\n' }, {}, { query: 5 }, { query: 'a', limit: '5' }, { query: 'a', limit: 1.5 },
      { query: 'a', extra: 1 },
    ], { compareFiles: true });
  });

  test(`金样·diary_read（${label}）`, { skip: skipOld }, async () => {
    await golden(seed, 'nova_diary_read', [
      {}, { dates: [] }, { dates: [''] },
      { dates: ['2026-01-01', '2026-01-02', '1999-01-01', '2026-01-01'] },
      { dates: ['2026-09-17', '2026-09-18', '2026-05-25'] },
      { dates: [1] }, { dates: '2026-01-01' }, { date: '2026-01-01' },
    ]);
  });

  test(`金样·black_room_read（${label}）`, { skip: skipOld }, async () => {
    await golden(seed, 'nova_black_room_read', [
      {}, { kind: 'desire' }, { kind: ' Reflection ' }, { kind: 'bogus' }, { kind: '' },
      { limit: 1 }, { limit: 0 }, { limit: -1 }, { limit: 1000 }, { limit: 2.5 }, { kind: 3 }, { x: 1 },
    ]);
  });

  test(`金样·black_room_append（${label}）`, { skip: skipOld }, async () => {
    await golden(seed, 'nova_black_room_append', [
      { kind: 'desire', title: '标题', content: '正文' },
      { kind: ' Persona ', title: '  前后空格  ', content: '  正文  ', evidence: [' e1 ', '', '   ', 'e2'] },
      { kind: 'closure', title: 'T'.repeat(200), content: 'C'.repeat(9000), evidence: Array.from({ length: 60 }, (_, i) => `ev${i}`) },
      { kind: 'anger', title: 't', content: 'c' }, { kind: 'desire', title: '  ', content: 'c' },
      { kind: 'desire', title: 't', content: '' }, { kind: 'desire', title: 't' },
      { kind: 'desire', title: 't', content: 'c', evidence: 'nope' }, { kind: 'desire', title: 't', content: 'c', evidence: [1] },
    ]);
  });

  test(`金样·note_read（${label}）`, { skip: skipOld }, async () => {
    await golden(seed, 'nova_note_read', [
      {}, { date: '' }, { date: '2026-01-01' }, { date: '2026-01-02' }, { date: '2026-01-03' },
      { date: '2026-09-17' }, { date: '2026-09-16' }, { date: '1999-01-01' }, { date: 1 },
    ]);
  });

  test(`金样·note_leave（${label}）`, { skip: skipOld }, async () => {
    await golden(seed, 'nova_note_leave', [
      { text: '今天的纸条' }, { text: '  再一张  ' },
      { text: '指定日子', date: '2026-01-01' }, { text: '坏文件那天', date: '2026-01-02' },
      { text: '不是数组那天', date: '2026-01-03' }, { text: '新的一天', date: '2030-12-31' },
      { text: '   ' }, { text: '' }, {}, { text: 1 }, { text: 'x', date: 5 },
    ]);
  });

  test(`金样·diary_append（${label}）`, { skip: skipOld }, async () => {
    await golden(seed, 'nova_diary_append', [
      { text: '第一条', time: '12:00', title: '标题', date: '2026-01-01' },
      { text: '空文件那天', time: '08:00', date: '2026-01-02' },
      { text: '全新一天\r\n第二行\r\n', time: '23:59', date: '2031-01-01' },
      { text: '  两头空白  ', title: '   ', time: '01:02', date: '2031-01-01' },
      { text: '不给时间', date: '2031-01-02' },
      { text: '   ' }, { text: '' }, {}, { text: 'x', title: 3 }, { text: 'x', textFile: '/etc/hostname' },
    ], { clock: true });
  });

  test(`金样·relationship_write（${label}）`, { skip: skipOld }, async () => {
    await golden(seed, 'nova_relationship_write', [
      { my_read_of_her_state: '  她今天累了  ' },
      { i_owe_her: [' 不后撤 ', '', '   ', '少总结多感觉'], what_works: [] },
      { watch_out: ['含:冒号', "含'单引号'", '含#井号', '[方括号]', '普通'], last_updated: '' },
      { last_updated: '2026-09-20T00:00:00.000Z' },
      { my_read_of_her_state: '' },
      {}, { open_threads: ['x'] }, { i_owe_her: 'str' }, { her_actual_state: 'x' }, { i_owe_her: [1] },
    ]);
  });

  test(`金样·self_state（${label}，老的去掉做爱档再比）`, { skip: skipOld }, async () => {
    const cases = [{}, { parts: [] }, { parts: ['ring'] }, { parts: ['body', 'ring'] }, { parts: ['bogus'] },
      { parts: 'body' }, { parts: [1] }];
    await golden(seed, 'nova_self_state', cases, { oldView: withoutPlay });
    // 环关着 / 坏 JSON / active 是真值但不是 true / 两样都没有；flag 在不在都不该有影响
    const variants = [
      (d) => fs.writeFileSync(path.join(d, 'play_mode.flag'), ''),
      (d) => fs.writeFileSync(path.join(d, 'ring_state.json'), JSON.stringify({ mode: 'off', speed: 0, comfort: 0, active: false })),
      (d) => fs.writeFileSync(path.join(d, 'ring_state.json'), '{坏'),
      (d) => fs.writeFileSync(path.join(d, 'ring_state.json'), JSON.stringify({ mode: 'x', speed: 1, comfort: 2, active: 'yes', locked: 1 })),
      (d) => { fs.rmSync(path.join(d, 'body-state.txt'), { force: true }); fs.rmSync(path.join(d, 'ring_state.json'), { force: true }); },
    ];
    for (const v of variants) {
      await golden(seed, 'nova_self_state', [{}, { parts: ['ring'] }, { parts: ['body'] }], { prep: v, oldView: withoutPlay });
    }
  });
}

test('金样·memory_sources_search（手造）', { skip: skipOld }, async () => {
  await golden(SYN, 'nova_memory_sources_search', [
    { query: 'hello' }, { query: 'HELLO', limit: 1 }, { query: '  小黑屋  ' }, { query: 'hello-tail' },
    { query: '...' }, { query: 'hello', limit: 0 }, { query: 'hello', limit: 999 }, { query: '   ' },
    { query: 'system' }, {}, { query: 'x', limit: 'a' },
  ]);
});

test('金样·memory_sources_search（生产拷贝 conversation-sources.jsonl，新包指回老文件 = 回滚）', { skip: skipOld || (!fs.existsSync(path.join(PROD, 'conversation-sources.jsonl')) && '没有生产原话文件') }, async () => {
  const d = tmpDir('src-prod');
  seedFromProd(d, { withSources: true });
  for (const args of [{ query: '小黑屋' }, { query: 'Telegram', limit: 3 }, { query: '老婆', limit: 200 },
    { query: '根本不存在的词qzx' }, { query: '想你', limit: 0 }]) {
    const o = await callOld(d, 'nova_memory_sources_search', args);
    const n = await callNew(d, 'nova_memory_sources_search', args);
    assert.equal(mask(n, [d]), mask(o, [d]), JSON.stringify(args));
  }
});

test('金样·relationship 服务层：非可写栏静默跳过（经工具时 schema 先挡，这里绕过 schema 直接比）', { skip: skipOld }, async () => {
  const { RelationshipService } = require(path.join(OLD, 'src/services/relationship-service.js'));
  for (const fields of [
    { her_actual_state: '她那栏', relationship_phase: '改不动', my_read_of_her_state: '我这栏' },
    { her_actual_state: '只有她那栏' },
    { i_owe_her: undefined, watch_out: ['a'] },
    { what_works: 'not array' },
  ]) {
    const a = cloneDir(SYN, 'old');
    const b = cloneDir(SYN, 'new');
    const o = await settle(() => new RelationshipService({ config: { relationshipFile: path.join(a, 'relationship.yaml') } }).write(fields));
    const n = await settle(() => relationship.write(path.join(b, 'relationship.yaml'), fields));
    assert.equal(mask(n, [b]), mask(o, [a]), JSON.stringify(fields));
    assert.equal(mask(fs.readFileSync(path.join(b, 'relationship.yaml'), 'utf8'), [b]),
      mask(fs.readFileSync(path.join(a, 'relationship.yaml'), 'utf8'), [a]));
  }
});

/** 老格式一行 → 冷层一行（冷层只有 id/role/at/text 四个字段）。 */
function toCold(r) { return { id: r.id, role: r.role, at: r.receivedAt, text: r.text }; }
function toOld(c) { return { id: c.id, role: c.role, receivedAt: c.at, text: c.text }; }

const SOURCE_QUERIES = [
  { query: 'hello' }, { query: 'HELLO', limit: 1 }, { query: '  小黑屋  ' }, { query: 'hello-tail' },
  { query: '...' }, { query: 'hello', limit: 0 }, { query: 'hello', limit: 999 }, { query: '   ' },
  { query: 'system' }, { query: 'tool' }, {}, { query: 'x', limit: 'a' },
];

test('金样·memory_sources_search：老代码读老格式 = 新代码读等价的冷层格式', { skip: skipOld }, async () => {
  // 只放冷层也有的字段，两边才等价；边角：system/tool 行、坏行、超长、坏时间、微秒时间、没 text
  const rows = [
    { id: 'cbmsg-1', role: 'user', receivedAt: '2026-05-16T05:16:47.980442Z', text: 'Hello 小黑屋 WORLD' },
    { id: 'cbmsg-2', role: 'assistant', receivedAt: '2026-05-16T05:17:00.000Z', text: '  hello again  ' },
    { id: 'cbmsg-3', role: 'system', receivedAt: '2026-05-16T05:18:00.000Z', text: 'hello from system' },
    { id: 'cbmsg-3b', role: 'tool', receivedAt: '2026-05-16T05:18:30.000Z', text: 'hello from tool' },
    { id: 'cbmsg-4', role: 'user', receivedAt: '2026-05-16T05:19:00.000Z', text: 'x'.repeat(12_050) + 'hello-tail' },
    { id: 'cold-ev-abc-1-user', role: 'user', receivedAt: '2026-09-19T20:35:03.000Z', text: 'HELLO 新桥' },
    { id: 'cold-ev-abc-1-reply-1-assistant', role: 'assistant', receivedAt: '2026-09-19T20:35:16.419Z', text: '[图片]' },
    { id: 'cbmsg-6', role: 'user', receivedAt: '2026-09-19T20:36:00.000Z' },
  ];
  const a = tmpDir('src-old');
  const b = tmpDir('src-cold');
  const tail = '\n{坏行\n\n';
  fs.writeFileSync(path.join(a, 'conversation-sources.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + tail);
  fs.writeFileSync(path.join(b, 'cold.jsonl'), rows.map((r) => JSON.stringify(toCold(r))).join('\n') + tail);
  for (const args of SOURCE_QUERIES) {
    const o = await callOld(a, 'nova_memory_sources_search', args);
    const n = await callNew(b, 'nova_memory_sources_search', args, path.join(b, 'cold.jsonl'));
    assert.equal(mask(n, [b]), mask(o, [a]), JSON.stringify(args));
  }
  const n = await callNew(b, 'nova_memory_sources_search', { query: 'hello' }, path.join(b, 'cold.jsonl'));
  assert.ok(n.value.data.results.every((r) => r.role === 'user' || r.role === 'assistant'), 'system/tool 行被滤掉');
  assert.equal(n.value.data.results[0].receivedAt, '2026-05-16T05:16:47.980Z', 'at → receivedAt，规整成毫秒');
  assert.equal(n.value.data.results[0].accountId, '', '冷层没有的栏填空串');
});

const REAL_COLD = '/root/.nova-gate/cold.jsonl';
test('金样·memory_sources_search（真冷层的临时拷贝 vs 老代码读同一批转成老格式）', { skip: skipOld || (!fs.existsSync(REAL_COLD) && '没有真冷层') }, async () => {
  const b = tmpDir('cold-real');
  const coldCopy = path.join(b, 'cold.jsonl');
  fs.copyFileSync(REAL_COLD, coldCopy);
  // 真数据体检：只有四个字段、role 只有 user/assistant —— 不是的话这里先报出来
  const lines = fs.readFileSync(coldCopy, 'utf8').split('\n').filter((l) => l.trim());
  const roles = new Set();
  for (const l of lines) {
    const r = JSON.parse(l);
    assert.deepEqual(Object.keys(r).sort(), ['at', 'id', 'role', 'text'], `冷层出现了别的字段：${l.slice(0, 120)}`);
    roles.add(r.role);
  }
  assert.deepEqual([...roles].sort(), ['assistant', 'user']);
  const a = tmpDir('cold-real-as-old');
  fs.writeFileSync(path.join(a, 'conversation-sources.jsonl'), lines.map((l) => JSON.stringify(toOld(JSON.parse(l)))).join('\n') + '\n');
  for (const args of [{ query: '小黑屋' }, { query: 'Telegram', limit: 3 }, { query: '老婆', limit: 200 },
    { query: '现在是啥姿势呢' }, { query: '根本不存在的词qzx' }, { query: '想你', limit: 0 }]) {
    const o = await callOld(a, 'nova_memory_sources_search', args);
    const n = await callNew(b, 'nova_memory_sources_search', args, coldCopy);
    assert.equal(mask(n, [b]), mask(o, [a]), JSON.stringify(args));
  }
});

test('日期/时间：只认 YYYY-MM-DD / HH:MM，别的一律报错且不落盘（故意比老的严）', async () => {
  const d = tmpDir('dates');
  seedSynthetic(d);
  const before = JSON.stringify(snapshot(path.dirname(d)));
  const bad = ['../x', '../../etc/passwd', '2026-1-1', '2026-02-30', '2026-13-01', '20260101', ' 2026-01-01', '2026-01-01/..', 'notes-not-a-date'];
  for (const date of bad) {
    for (const [name, args] of [
      ['nova_diary_read', { dates: ['2026-01-01', date] }],
      ['nova_diary_append', { text: 'x', date }],
      ['nova_note_leave', { text: 'x', date }],
      ['nova_note_read', { date }],
    ]) {
      const r = await callNew(d, name, args);
      assert.equal(r.ok, false, `${name} 放过了 ${date}`);
      assert.match(r.error, /Invalid date .*YYYY-MM-DD/, `${name} ${date}: ${r.error}`);
    }
  }
  for (const time of ['24:00', '9:05', '12:60', '12:00:00', '../x']) {
    const r = await callNew(d, 'nova_diary_append', { text: 'x', date: '2026-01-01', time });
    assert.match(r.error, /Invalid time .*HH:MM/, time);
  }
  assert.equal(JSON.stringify(snapshot(path.dirname(d))), before, '报错的调用不许留下任何文件');
  // 合法的照常：闰日、空串 = 今天
  assert.equal((await callNew(d, 'nova_note_read', { date: '2028-02-29' })).ok, true);
  assert.equal((await callNew(d, 'nova_diary_read', { dates: [''] })).ok, true);
  assert.equal((await callNew(d, 'nova_diary_append', { text: 'x', date: '2026-01-01', time: '00:00' })).ok, true);
  // 老的在同样的输入上确实会走出目录（证明这个洞是真的）
  if (HAS_OLD) {
    const o = tmpDir('dates-old');
    fs.mkdirSync(path.join(o, 'notes'));
    await callOld(o, 'nova_note_leave', { text: 'x', date: '../escaped' });
    assert.ok(fs.existsSync(path.join(o, 'escaped.json')), '老代码把纸条写到了 notes 目录外面');
  }
});

// ——— 2. 故意跟老的不一样的地方 ———

test('relationship.yaml：带引号/反斜杠的值，老的每写一次转义翻倍，新的稳定', { skip: skipOld }, async () => {
  const seed = tmpDir('rel-esc');
  fs.writeFileSync(path.join(seed, 'relationship.yaml'), 'relationship_phase: 热恋期\n');
  const a = cloneDir(seed, 'old');
  const b = cloneDir(seed, 'new');
  const first = { watch_out: ['她说"好"就是好', 'C:\\路径'] };
  for (const [dir, call] of [[a, callOld], [b, callNew]]) {
    await call(dir, 'nova_relationship_write', first);
    await call(dir, 'nova_relationship_write', { my_read_of_her_state: '别的栏' });
    await call(dir, 'nova_relationship_write', { my_read_of_her_state: '再写一次' });
  }
  const oldData = relationship.parseYaml(fs.readFileSync(path.join(b, 'relationship.yaml'), 'utf8'));
  assert.deepEqual(oldData.watch_out, first.watch_out, '新的：三次整份重写之后原样');
  const oldFile = fs.readFileSync(path.join(a, 'relationship.yaml'), 'utf8');
  assert.match(oldFile, /\\\\\\"/, '老的：反斜杠已经在翻倍（证明这个洞是真的）');
});

test('relationship.yaml：数字栏老的写成空串，新的原样保留', { skip: skipOld }, async () => {
  const seed = tmpDir('rel-num');
  fs.writeFileSync(path.join(seed, 'relationship.yaml'), 'relationship_phase: 热恋期\ntrust: 8\nnested:\n  x: 3\n');
  const a = cloneDir(seed, 'old');
  const b = cloneDir(seed, 'new');
  await callOld(a, 'nova_relationship_write', { my_read_of_her_state: 'x' });
  const n = await callNew(b, 'nova_relationship_write', { my_read_of_her_state: 'x' });
  assert.match(fs.readFileSync(path.join(a, 'relationship.yaml'), 'utf8'), /^trust: ""$/m);
  assert.match(fs.readFileSync(path.join(b, 'relationship.yaml'), 'utf8'), /^trust: 8$/m);
  assert.match(fs.readFileSync(path.join(b, 'relationship.yaml'), 'utf8'), /^ {2}x: 3$/m);
  assert.equal(n.value.data.data.trust, 8); // {text, data: {filePath, updatedFields, data}}
});

test('relationship.yaml：多行值老的丢续行，新的整段保留；新写的文件老代码照样读得动', { skip: skipOld }, async () => {
  const seed = tmpDir('rel-nl');
  const a = cloneDir(seed, 'old');
  const b = cloneDir(seed, 'new');
  const v = '第一行\n第二行';
  await callOld(a, 'nova_relationship_write', { my_read_of_her_state: v });
  await callNew(b, 'nova_relationship_write', { my_read_of_her_state: v });
  const { parseSimpleYaml } = require(path.join(OLD, 'src/services/relationship-service.js'));
  assert.equal(parseSimpleYaml(fs.readFileSync(path.join(a, 'relationship.yaml'), 'utf8')).my_read_of_her_state, '第一行');
  assert.equal(relationship.parseYaml(fs.readFileSync(path.join(b, 'relationship.yaml'), 'utf8')).my_read_of_her_state, v);
  // 回滚：老代码读新写的文件，不丢字（换行变成字面 \n，但不丢）
  assert.equal(parseSimpleYaml(fs.readFileSync(path.join(b, 'relationship.yaml'), 'utf8')).my_read_of_her_state, '第一行\\n第二行');
});

test('self_state：做爱档整个没了 —— flag 新鲜也不报，parts:["play"] 静默忽略', async () => {
  const d = tmpDir('noplay');
  fs.writeFileSync(path.join(d, 'play_mode.flag'), '');
  const all = await callNew(d, 'nova_self_state', {});
  assert.equal(all.value.text, '没读到状态。');
  assert.deepEqual(all.value.data, {});
  const p = await callNew(d, 'nova_self_state', { parts: ['play'] });
  assert.equal(p.ok, true);
  assert.equal(p.value.text, '没读到状态。');
  const tool = createTools(loadConfig({ NOVA_STATE_DIR: d })).find((t) => t.name === 'nova_self_state');
  assert.doesNotMatch(tool.description, /play/);
  assert.deepEqual(tool.inputSchema.properties.parts.items.enum, ['body', 'ring']);
});

// ——— 不依赖老代码的几条 ———

test('open_threads 撞上时报的是老原文（schema 那层先挡）；服务层自己也认得它', async () => {
  const d = tmpDir('ot');
  const n = await callNew(d, 'nova_relationship_write', { open_threads: ['x'] });
  assert.equal(n.error, 'nova_relationship_write input.open_threads is not allowed.');
  assert.throws(() => relationship.write(path.join(d, 'r.yaml'), { open_threads: [] }), /notebook_open/);
  assert.equal(fs.existsSync(path.join(d, 'r.yaml')), false);
});

test('配置：家目录必须给（2026-10-21 起不默认 ~/.nova），纸条目录可以单独指', () => {
  assert.throws(() => loadConfig({}), /NOVA_STATE_DIR/);
  const c = loadConfig({ NOVA_STATE_DIR: '/x/s' });
  assert.equal(c.notesDir, path.join(c.stateDir, 'notes'));
  assert.equal(c.conversationSourceFile, '');
  const c2 = loadConfig({ NOVA_STATE_DIR: ' /x/y ', SELF_LIFE_NOTES_DIR: '/n', MEMORY_SOURCES_FILE: '/s.jsonl' });
  assert.equal(c2.conversationSourceFile, '/s.jsonl');
  assert.equal(c2.stateDir, '/x/y');
  assert.equal(c2.relationshipFile, '/x/y/relationship.yaml');
  assert.equal(c2.notesDir, '/n');
});

test('不 require 任何 /root/cyberboss 的东西', () => {
  for (const f of ['mcp-server.js', 'tools.js', 'config.js', 'schema.js', 'diary.js', 'sources.js', 'relationship.js', 'black-room.js', 'notes.js', 'self-state.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.doesNotMatch(src, /require\([^)]*cyberboss/, f);
  }
});

// ——— 3. 端到端 ———

test('端到端：起 mcp-server.js，initialize → tools/list → tools/call', async () => {
  const d = tmpDir('e2e');
  const child = spawn(process.execPath, [path.join(__dirname, 'mcp-server.js')], {
    env: { PATH: process.env.PATH, HOME: d, NOVA_STATE_DIR: d, MEMORY_SOURCES_FILE: path.join(d, 'cold.jsonl') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const replies = new Map();
  let buf = '';
  child.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.trim()) { const m = JSON.parse(line); replies.set(m.id, m); }
    }
  });
  const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  const wait = async (id) => {
    for (let k = 0; k < 200 && !replies.has(id); k++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(replies.has(id), `等不到 id=${id} 的回话`);
    return replies.get(id);
  };
  try {
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    assert.equal((await wait(1)).result.serverInfo.name, 'notebooks');
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/list' });
    const names = (await wait(2)).result.tools.map((t) => t.name);
    assert.equal(names.length, 10);
    // 9-20：他看到的名字去掉了 cyberboss_ 前缀；老名字调用照样认
    assert.ok(names.includes('note_leave') && names.includes('self_state') && !names.some((n) => n.startsWith('cyberboss_')));
    send({ id: 3, method: 'tools/call', params: { name: 'nova_note_leave', arguments: { text: '端到端的纸条', date: '2026-02-02' } } });
    const r3 = await wait(3);
    assert.equal(r3.result.isError, undefined);
    assert.match(r3.result.content[0].text, /^Note left for 2026-02-02 \(1 today\)\.\n\{/);
    const saved = JSON.parse(fs.readFileSync(path.join(d, 'notes', '2026-02-02.json'), 'utf8'));
    assert.equal(saved[0].text, '端到端的纸条');
    send({ id: 4, method: 'tools/call', params: { name: 'nova_note_leave', arguments: { text: '   ' } } });
    const r4 = await wait(4);
    assert.equal(r4.result.isError, true);
    assert.equal(r4.result.content[0].text, 'Note text cannot be empty.');
  } finally {
    child.kill();
  }
});
