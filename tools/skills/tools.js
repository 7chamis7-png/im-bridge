'use strict';

/**
 * 技能包（2026-10-21，第 3 步：技能搬进桥）。
 *
 * 以前技能住在 /root/nova/.claude/skills/，只有 Claude CLI 自己的 Skill 工具认 —— 换个引擎就没了。
 * 现在：技能目录由人格配置指过去（tools.json 的 vars.SKILLS_DIRS，默认 ${STATE_DIR}/skills），
 * 这一包谁挂上谁就能用：`list_skills` 看有哪些，`read_skill` 按名字读出说明书（或包里的某个文件）。
 * 开不开跟别的工具一样走 tools.json（servers.skills.enabled / exclude）。
 *
 * 一个技能 = 目录 <技能名>/SKILL.md（开头可以有 --- name / description --- 头），
 * 旁边的脚本、素材原样放着。**只读**：这一包不写任何文件、不执行任何脚本 ——
 * 说明书里叫跑脚本，他用自己的手（Bash / shell）跑，路径按 read_skill 给的「技能目录」拼。
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_FILE_BYTES = 200_000;

function splitDirs(raw) {
  return String(raw || '').split(':').map((s) => s.trim()).filter(Boolean);
}

/** --- 头里的 name / description（只认最简单的 key: value 和 `>` 折叠块）。 */
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(String(text));
  if (!m) return { meta: {}, body: String(text) };
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v === '>' || v === '|' || v === '>-' || v === '|-') {
      const block = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) { block.push(lines[i + 1].trim()); i += 1; }
      v = block.join(v.startsWith('>') ? ' ' : '\n');
    }
    meta[kv[1]] = v.replace(/^["']|["']$/g, '');
  }
  return { meta, body: String(text).slice(m[0].length) };
}

/** 扫一遍所有技能目录。同名的先到先得（目录顺序 = 优先级），后面的记进 shadowed。 */
function scanSkills(dirs) {
  const skills = new Map();
  const problems = [];
  for (const dir of dirs) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { problems.push(`技能目录读不到：${dir}（${e.code || e.message}）`); continue; }
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (ent.name.startsWith('.')) continue;
      const linkOrDir = path.join(dir, ent.name);
      let real;
      try { real = fs.realpathSync(linkOrDir); if (!fs.statSync(real).isDirectory()) continue; }
      catch (e) { problems.push(`技能 ${ent.name} 打不开（${e.code || e.message}）`); continue; }
      const skillMd = path.join(real, 'SKILL.md');
      let text;
      try { text = fs.readFileSync(skillMd, 'utf8'); }
      catch { problems.push(`技能 ${ent.name} 没有 SKILL.md，跳过`); continue; }
      const { meta } = parseFrontmatter(text);
      const name = (meta.name || ent.name).trim();
      if (skills.has(name)) { problems.push(`技能 ${name} 重名：${real} 被 ${skills.get(name).dir} 挡住`); continue; }
      skills.set(name, { name, description: meta.description || '', dir: real, skillMd });
    }
  }
  return { skills, problems };
}

function listFiles(dir, limit = 200) {
  const out = [];
  const walk = (d, rel) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= limit) return;
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(r);
    }
  };
  walk(dir, '');
  return out;
}

function makeTools({ dirs = splitDirs(process.env.SKILLS_DIRS) } = {}) {
  const lookup = () => scanSkills(dirs);   // 每次现扫：他往目录里丢一个新技能，不用重启

  const startup = lookup();
  const catalog = [...startup.skills.values()]
    .map((s) => `- ${s.name}：${s.description.replace(/\s+/g, ' ').slice(0, 160)}`).join('\n');

  return [
    {
      name: 'list_skills',
      description: '列出你的技能包（做某类事的成套做法 / 标准）。碰到对得上的事，先 read_skill 读说明书再动手。'
        + (catalog ? `\n现有：\n${catalog}` : '\n（现在一个技能都没有）'),
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const { skills, problems } = lookup();
        const rows = [...skills.values()].map((s) => ({ name: s.name, description: s.description }));
        return {
          text: rows.length ? `${rows.length} 个技能` : '一个技能都没有',
          data: { skills: rows, ...(problems.length ? { problems } : {}) },
        };
      },
    },
    {
      name: 'read_skill',
      description: '按名字读一个技能的说明书（SKILL.md）。给 file 就读技能包里的那个文件（相对技能目录）。'
        + '说明书里提到的 scripts/... 等相对路径，按返回的「技能目录」拼成绝对路径再用。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '技能名（list_skills 里的 name）' },
          file: { type: 'string', description: '可选：技能包里的文件，相对路径，比如 scripts/gen.js' },
        },
        required: ['name'],
      },
      handler: async ({ name, file } = {}) => {
        const { skills } = lookup();
        const s = skills.get(String(name || '').trim());
        if (!s) throw new Error(`没有叫「${name}」的技能；现有：${[...skills.keys()].join(' / ') || '(无)'}`);
        let target = s.skillMd;
        if (file) {
          const want = path.resolve(s.dir, String(file));
          let real;
          try { real = fs.realpathSync(want); } catch { throw new Error(`技能 ${s.name} 里没有 ${file}`); }
          if (real !== s.dir && !real.startsWith(s.dir + path.sep)) throw new Error(`${file} 不在技能目录里，不读`);
          target = real;
        }
        const st = fs.statSync(target);
        if (!st.isFile()) throw new Error(`${file} 不是文件`);
        if (st.size > MAX_FILE_BYTES) throw new Error(`${file} 太大（${st.size} 字节），不整个读`);
        const content = fs.readFileSync(target, 'utf8');
        const head = `技能：${s.name}\n技能目录：${s.dir}\n文件：${path.relative(s.dir, target)}\n`
          + (file ? '' : `包里的文件：${listFiles(s.dir).join(', ')}\n`);
        return `${head}\n${content}`;
      },
    },
  ];
}

module.exports = { makeTools, scanSkills, parseFrontmatter, splitDirs };
