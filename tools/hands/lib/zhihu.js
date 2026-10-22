'use strict';

/**
 * 知乎发文的父进程这半：起子进程、喂参数、收最后一行 JSON、到点杀掉。
 *
 * 规矩（照老 tool-host 的 nova_zhihu_post handler）：
 *   · 子进程 5 分钟没结束 → SIGKILL
 *   · DISPLAY 没给就是 :99（有头浏览器开在虚拟屏幕上）
 *   · stdout 最后一行不是 JSON → 「脚本没给回 JSON: <stderr 或 stdout 末尾 300 字>」
 *   · ok=false → 把脚本的 error 原样抛给他（没有就「知乎发文失败」）
 *   · 成功：「已发布 / 已存草稿（没发布）：<url>（正文 N 字）」
 */

const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'zhihu-post.js');
const KILL_AFTER_MS = 300_000;

function runScript(payload, { script = SCRIPT, display = ':99', env = process.env, killAfterMs = KILL_AFTER_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd: path.dirname(script),
      env: { ...env, DISPLAY: display },
    });
    let so = '';
    let se = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退 */ } }, killAfterMs);
    child.stdout.on('data', (d) => { so += d; });
    child.stderr.on('data', (d) => { se += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: `起不来子进程: ${e.message}` }); });
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(so.trim().split('\n').pop())); }
      catch { resolve({ ok: false, error: `脚本没给回 JSON: ${(se || so).slice(-300)}` }); }
    });
    child.stdin.on('error', () => { /* 子进程先退了，写不进去就算了，close 那边会收尾 */ });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function zhihuPost(args, config, opts = {}) {
  const payload = {
    title: args.title, content: args.content,
    topics: args.topics || [], publish: args.publish === true,
  };
  const res = await runScript(payload, { display: config.display, ...opts });
  if (!res || !res.ok) throw new Error((res && res.error) || '知乎发文失败');
  const where = res.state === 'published' ? '已发布' : '已存草稿（没发布）';
  return { text: `${where}：${res.url}（正文 ${res.chars} 字）`, data: res };
}

module.exports = { zhihuPost, runScript, SCRIPT, KILL_AFTER_MS };
