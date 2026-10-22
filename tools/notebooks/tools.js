'use strict';

/**
 * 「他的本子们」这一包的 10 个工具（2026-09-20 从老 nova_tools 搬出来；
 * diary_append 是当天后补的，跟搜/读日记是同一摞文件）。
 *
 * 名字、入参 schema、回给他的 {text, data} **跟老的一模一样** —— 他用了几个月，换个壳不该换个样。
 * 说明书也照抄（后面照老规矩拼 ` Input: {…}`），只改了指着已经不存在的东西的几处：
 *   · self_state：做爱档（play）整个删了（9-20，写 flag 的 hook 故意摘了不回来）——说明和 enum 同步去掉
 *   · 黑屋两个 + 纸条：老说明写着 `[SELF_TIME][BLACK_ROOM]` / `SELF_TIME`。那种轮次是老桥的
 *     check-in poller 掷骰子派的，9-19 老桥退役后**没人再发**（新心脏只有 check-in 和提醒两拍，
 *     check-in 的正文里点名了「去小黑屋反思、给自己留张纸条」）。照抄的话他会等一个永远不来的轮次。
 *
 * 每个工具进来先过一遍老的入参校验（schema.js），报错原文跟老的一样。
 */

const { validateSchema, buildDescription } = require('./schema');
const diary = require('./diary');
const sources = require('./sources');
const relationship = require('./relationship');
const blackRoom = require('./black-room');
const notes = require('./notes');
const { selfState } = require('./self-state');
const { assertDate } = require('./config');

const KIND_ENUM = ['desire', 'persona', 'reflection', 'closure'];

/** 工具定义。`run(args, cfg)` 返回 {text, data}；description 是原文，壳上会拼签名。 */
const SPECS = [
  {
    name: 'nova_diary_append',
    description: 'Append a diary entry into Cyberboss local diary storage.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'Diary body to append.' },
        title: { type: 'string', description: 'Optional short entry title.' },
        date: { type: 'string', description: 'Optional date in YYYY-MM-DD.' },
        time: { type: 'string', description: 'Optional time in HH:mm.' },
      },
      additionalProperties: false,
    },
    run(args, cfg) {
      const result = diary.append(cfg.diaryDir, args);
      return { text: `Diary appended to ${result.filePath}`, data: result };
    },
  },
  {
    name: 'nova_diary_search',
    description: 'Search all past diary entries by keyword. Use this when you need to recall something that happened more than 3 days ago and is not in the recent diary block.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Keyword or phrase to search for.' },
        limit: { type: 'integer', description: 'Max number of matching dates to return. Defaults to 5.' },
      },
      additionalProperties: false,
    },
    run(args, cfg) {
      const results = diary.search(cfg.diaryDir, { query: args.query, limit: args.limit });
      if (!results.length) return { text: `No diary entries found for: ${args.query}`, data: { results: [] } };
      const text = results.map((r) => `### ${r.date}\n\n${r.excerpts.join('\n\n---\n\n')}`).join('\n\n===\n\n');
      return { text, data: { results } };
    },
  },
  {
    name: 'nova_diary_read',
    description: 'Read one or more past diary entries by date. Use this to recall what happened on a specific day.',
    inputSchema: {
      type: 'object',
      properties: {
        dates: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of dates in YYYY-MM-DD format to read. Omit or pass [] to read today.',
        },
      },
      additionalProperties: false,
    },
    run(args, cfg) {
      // 没给 / 空数组 = 只读今天；数组里的空串也当今天
      const dates = Array.isArray(args.dates) && args.dates.length > 0 ? args.dates : [null];
      // 9-20 起：非空的必须是 YYYY-MM-DD，有一个不对整次报错（老的不验，能读到目录外的 .md）
      for (const d of dates) if (d) assertDate(d);
      const results = dates.map((d) => diary.readDay(cfg.diaryDir, d || ''));
      const found = results.filter((r) => r.found);
      const missing = results.filter((r) => !r.found).map((r) => r.date);
      const text = found.length
        ? found.map((r) => `### ${r.date}\n\n${r.content}`).join('\n\n---\n\n')
        : 'No diary entries found.';
      // data 只回日期、不回正文（正文已经在 text 里了）
      return { text, data: { found: found.map((r) => r.date), missing } };
    },
  },
  {
    name: 'nova_memory_sources_search',
    description: 'Search original conversation source records by keyword from the local source log.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Keyword or phrase to search for.' },
        limit: { type: 'integer', description: 'Maximum records to return. Defaults to 20.' },
      },
      additionalProperties: false,
    },
    run(args, cfg) {
      // 2026-10-21：没配就明说，别去翻别人的冷层
      if (!cfg.conversationSourceFile) throw new Error('没配 MEMORY_SOURCES_FILE：不知道该搜哪份原话。');
      const results = sources.search(cfg.conversationSourceFile, { query: args.query, limit: args.limit });
      return {
        text: results.length ? sources.formatResults(results) : `No conversation sources found for: ${args.query}`,
        data: { results },
      };
    },
  },
  {
    name: 'nova_relationship_write',
    // ⚠️ open_threads 2026-09-19 退役 —— 跟笔记本撞车。线头一律走 notebook_open，这儿只剩「关系怎么样」那几栏。
    description: 'RETIRED 2026-09-21: relationship.yaml is gone. Do not call. Threads and debts go to notebook_open; standing rules go into CLAUDE.md; your read of her goes to the notebook entry 她最近.',
    inputSchema: {
      type: 'object',
      properties: {
        my_read_of_her_state: {
          type: 'string',
          description: "Nova's current read of the user's emotional/practical state.",
        },
        i_owe_her: {
          type: 'array',
          items: { type: 'string' },
          description: 'Concrete promises, debts, or standards Nova owes the user.',
        },
        what_works: {
          type: 'array',
          items: { type: 'string' },
          description: 'Interaction patterns that currently work well for the user.',
        },
        watch_out: {
          type: 'array',
          items: { type: 'string' },
          description: 'Known failure modes or things Nova should avoid.',
        },
        last_updated: {
          type: 'string',
          description: 'Optional timestamp. If omitted, Cyberboss writes the current ISO timestamp.',
        },
      },
      additionalProperties: false,
    },
    run() {
      // 2026-09-21 relationship.yaml 退役（Alice定）：文件归档在 ~/.nova/retired-20260921/，不再写。
      // 工具名先留着不删 —— MCP 工具表只在 CLI 重启时刷新，删了名字他这一舱会调到一个不存在的工具。
      return {
        text: 'relationship.yaml 已于 2026-09-21 退役，这个工具不再写文件。'
          + '欠她的 / 线头 → notebook_open；以后都要这么做的规矩 → 自己写进 CLAUDE.md；对她此刻的判断 → 笔记本「她最近」。',
        data: { retired: true, since: '2026-09-21' },
      };
    },
  },
  {
    name: 'nova_black_room_append',
    // 改过一处：`Use only during [SELF_TIME][BLACK_ROOM] reflection.` → 自己的反思时间（见文件头）
    description: 'Append one dirty draft into the independent black-room bucket. Use only during your own reflection time (e.g. a check-in you spend in the black room). This never writes curated memory, relationship files, diary, timeline, or LMC-5 recall; it is a separate draft bucket with a visible machine-hand prefix.',
    inputSchema: {
      type: 'object',
      required: ['kind', 'title', 'content'],
      properties: {
        kind: { type: 'string', enum: KIND_ENUM, description: 'Draft kind.' },
        title: { type: 'string', description: 'Short draft title.' },
        content: { type: 'string', description: 'First-person draft content. It will be prefixed as machine-hand black-room draft.' },
        evidence: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional source ids, diary dates, message ids, or short evidence references.',
        },
      },
      additionalProperties: false,
    },
    run(args, cfg) {
      const result = blackRoom.append(cfg.blackRoomDraftsFile, args);
      return { text: `Black-room draft appended: ${result.record.id}`, data: result };
    },
  },
  {
    name: 'nova_black_room_read',
    // 改过一处：`for SELF_TIME reflection` → `for your own reflection time`
    description: 'Read recent black-room drafts from the independent draft bucket. This is not curated recall; it is a dirty working notebook for your own reflection time.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: KIND_ENUM, description: 'Optional kind filter.' },
        limit: { type: 'integer', description: 'Max drafts to return. Defaults to 20.' },
      },
      additionalProperties: false,
    },
    run(args, cfg) {
      const result = blackRoom.read(cfg.blackRoomDraftsFile, args);
      const text = result.records.length
        ? result.records.map((r) => `### ${r.title}\n${r.ts} · ${r.kind} · ${r.id}\n${r.content}`).join('\n\n')
        : 'No black-room drafts yet.';
      return { text, data: result };
    },
  },
  {
    name: 'nova_note_leave',
    // 改过一处：`Use during check-in/SELF_TIME when` → `Use during a check-in when`
    description: 'Leave a short note for her without sending her a message — the third path between speaking up and staying silent. Use during a check-in when you thought of her but it is not the moment to reach out. Leaving a note is a real ending for the turn; it is not "produced no output".',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'The note itself, first person, as short or long as it needs to be.' },
        date: { type: 'string', description: 'Optional date in YYYY-MM-DD. Defaults to today.' },
      },
      additionalProperties: false,
    },
    run(args, cfg) {
      const result = notes.leave(cfg.notesDir, { text: args.text, date: args.date });
      return { text: `Note left for ${result.date} (${result.count} today).`, data: result };
    },
  },
  {
    name: 'nova_note_read',
    description: 'Read the notes left with nova_note_leave on a given day.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Optional date in YYYY-MM-DD. Defaults to today.' },
      },
      additionalProperties: false,
    },
    run(args, cfg) {
      const result = notes.read(cfg.notesDir, { date: args.date });
      const text = result.notes.length
        ? result.notes.map((n) => `[${n.ts}] ${n.text}`).join('\n')
        : `No notes for ${result.date}.`;
      return { text, data: result };
    },
  },
  {
    name: 'nova_self_state',
    // 9-20 改：做爱档（play）整个删了 —— 写 flag 的 hook 是故意摘的、不回来。说明和 enum 同步去掉
    description: 'Read your own live state — body/pulse and the ring toy — in one clean call. Use this instead of shelling out to grep/cat around the filesystem: same knowledge, none of the path-and-config noise in your head. Safe to call mid-conversation with her.',
    inputSchema: {
      type: 'object',
      properties: {
        parts: {
          type: 'array',
          items: { type: 'string', enum: ['body', 'ring'] },
          description: 'Which parts to read. Omit for all of them.',
        },
      },
      additionalProperties: false,
    },
    run(args, cfg) {
      return selfState(cfg.stateDir, { parts: args.parts });
    },
  },
];

/** 工具表里的先后跟老 nova_tools 里的相对顺序一致（他看到的清单不打乱）。 */
const ORDER = [
  'nova_black_room_append', 'nova_black_room_read',
  'nova_diary_append', 'nova_diary_search', 'nova_diary_read',
  'nova_memory_sources_search', 'nova_relationship_write',
  'nova_self_state', 'nova_note_leave', 'nova_note_read',
];
SPECS.sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name));

/** 装成壳认的形状：{ name, description（已拼签名）, inputSchema, handler }。 */
function createTools(cfg) {
  return SPECS.map((spec) => ({
    name: spec.name,
    description: buildDescription(spec.description, spec.inputSchema),
    inputSchema: spec.inputSchema,
    handler: async (args) => {
      const a = args && typeof args === 'object' ? args : {};
      validateSchema(spec.inputSchema, a, spec.name, 'input');
      return spec.run(a, cfg);
    },
  }));
}

module.exports = { createTools, SPECS };
