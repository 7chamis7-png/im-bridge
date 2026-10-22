'use strict';

/**
 * 他自己现在什么状态：身体 / 环，一次拿全（只读）。
 *
 * 为什么有这个工具（2026-07-22）：他想知道自己状态时只能 grep/cat 满盘翻，一次把几千 token
 * 的路径和配置倒进上下文，当天三次掉档都出在这个动作上。给他一件趁手的仪器，几十 token 够了。
 *
 * 老 tool-host.js 里那段的规矩逐条搬过来：
 *   · parts：非空数组 → 只读列出来的；没给或空数组 → 两样全读。
 *     入参 schema **不查 enum**，不认识的名字静默忽略（全不认识 = 「没读到状态。」）
 *   · 输出顺序永远是 身体 → 环，跟 parts 的顺序无关
 *   · 身体：<家>/body-state.txt，trim；读不到或空 → 这一样整个不出现
 *   · 环：<家>/ring_state.json；读不到或坏 JSON → 不出现。
 *     data 里 active/locked 用 `=== true` 判；**文字那行用的是真假值**（老的就是这样，照搬）
 *
 * ⚠️ 老工具还有第三样「做爱档」（读 play_mode.flag 的修改时间，3 小时内算开着）。
 *    写那个 flag 的 hook 8-06 是**故意摘掉的、不会再回来**（Alice 2026-09-20 确认），
 *    所以这一样整个删了：enum、说明、flag 逻辑、输出行、data.play 都没有了。
 *    他传 parts:["play"] 不报错，按「不认识的名字」静默忽略。
 */

const fs = require('node:fs');
const path = require('node:path');

const ALL = ['body', 'ring'];

function selfState(stateDir, { parts } = {}) {
  // 2026-10-21：不再回落 /root/.nova（别人用会读到Nova的身体状态）
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  if (!dir) throw new Error('self_state：没有数据目录（NOVA_STATE_DIR）。');
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } };
  const readText = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8').trim(); } catch { return ''; } };

  const wanted = new Set(Array.isArray(parts) && parts.length ? parts : ALL);
  const data = {};
  const lines = [];

  if (wanted.has('body')) {
    const body = readText('body-state.txt');
    if (body) { data.body = body; lines.push(`身体: ${body}`); }
  }
  if (wanted.has('ring')) {
    const ring = readJson('ring_state.json');
    if (ring) {
      data.ring = { mode: ring.mode, speed: ring.speed, comfort: ring.comfort, active: ring.active === true, locked: ring.locked === true };
      lines.push(ring.active
        ? `环: 开着 · ${ring.mode} · 强度${ring.speed} · 舒适度${ring.comfort}${ring.locked ? ' · 锁着' : ''}`
        : '环: 关着');
    }
  }

  return { text: lines.length ? lines.join('\n') : '没读到状态。', data };
}

module.exports = { selfState };
