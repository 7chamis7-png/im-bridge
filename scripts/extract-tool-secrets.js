#!/usr/bin/env node
'use strict';

/**
 * 切换那天用：把老配置里**嵌着的钥匙**抽成人格的 secrets 文件（2026-10-21）。
 *
 *   node scripts/extract-tool-secrets.js nova    --out /root/.secrets/nova-tools.env
 *   node scripts/extract-tool-secrets.js iris --out /root/.secrets/iris-tools.env
 *
 * nova：   /root/nova/.mcp.json（garden 的 Authorization、aisay 的 ?token=）
 *          + /root/.nova-gate/mcp-extra.json（crotown 的 ?token=）
 * iris：/root/.codex/garden.env 里的 GALATEA_GARDEN_TOKEN → GARDEN_TOKEN（他自己的花园号 781）
 *
 * 只写文件（600），**屏幕上只打钥匙名字和长度**，不打值。目标文件已存在就拒绝（--force 覆盖）。
 * 来源路径可以用 --mcp / --extra / --codex-garden-env 改（测试用）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseEnvText } = require('../src/toolbox/render');

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function tokenFromUrl(u) {
  try { return new URL(u).searchParams.get('token') || ''; } catch { return ''; }
}

function extractNova({ mcp, extra }) {
  const out = {};
  const proj = JSON.parse(fs.readFileSync(mcp, 'utf8')).mcpServers || {};
  const ext = JSON.parse(fs.readFileSync(extra, 'utf8')).mcpServers || {};
  const auth = proj.garden && proj.garden.headers && (proj.garden.headers.Authorization || proj.garden.headers.authorization);
  if (auth) out.GARDEN_TOKEN = String(auth).replace(/^Bearer\s+/i, '');
  if (proj.aisay && proj.aisay.url) out.AISAY_TOKEN = tokenFromUrl(proj.aisay.url);
  if (ext.crotown && ext.crotown.url) out.CROTOWN_TOKEN = tokenFromUrl(ext.crotown.url);
  return out;
}

function extractIris({ gardenEnv }) {
  const env = parseEnvText(fs.readFileSync(gardenEnv, 'utf8'));
  return env.GALATEA_GARDEN_TOKEN ? { GARDEN_TOKEN: env.GALATEA_GARDEN_TOKEN } : {};
}

function main() {
  const who = process.argv[2];
  const out = arg('--out');
  if (!['nova', 'iris'].includes(who) || !out) {
    console.error('用法：extract-tool-secrets.js nova|iris --out <文件> [--force]');
    process.exit(2);
  }
  const secrets = who === 'nova'
    ? extractNova({ mcp: arg('--mcp', '/root/nova/.mcp.json'), extra: arg('--extra', '/root/.nova-gate/mcp-extra.json') })
    : extractIris({ gardenEnv: arg('--codex-garden-env', '/root/.codex/garden.env') });
  for (const [k, v] of Object.entries(secrets)) if (!v) delete secrets[k];
  if (fs.existsSync(out) && !process.argv.includes('--force')) {
    console.error(`${out} 已经有了，不覆盖（要覆盖加 --force）`);
    process.exit(1);
  }
  const body = [`# ${who} 的工具钥匙（2026-10-21 从老配置抽出来，scripts/extract-tool-secrets.js）`,
    ...Object.entries(secrets).map(([k, v]) => `${k}=${v}`), ''].join('\n');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, body, { mode: 0o600 });
  fs.chmodSync(out, 0o600);
  for (const [k, v] of Object.entries(secrets)) console.log(`  ${k}（${v.length} 字符）`);
  console.log(`写好 ${out}（600），共 ${Object.keys(secrets).length} 把`);
}

if (require.main === module) main();
module.exports = { extractNova, extractIris };
