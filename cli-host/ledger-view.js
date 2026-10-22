'use strict';

/**
 * 台账的**只读**视图 —— 盒子那头用。
 *
 * 为什么不直接 `createIngress()`：那东西有条硬假设，写在 runtime/ingress.js 头上 ——
 * 「每个 filePath 只有一个存活的拥有者」。CLI 宿主是那个拥有者，盒子再开一个
 * 就是两个拥有者，两份内存各写各的，台账当场分裂。
 *
 * 所以这里只做一件事：**读文件、不持有、不缓存**。
 * 安全性靠 ingress 自己的落盘方式：它是「写 .tmp → fsync → rename」，
 * rename 在同一个文件系统上是原子的，所以读方要么看见上一份完整快照、
 * 要么看见下一份完整快照，**不存在读到半截的情况**。
 *
 * 形状跟 `ingress.get()/list()` 一字不差（structuredClone 过的 row），
 * 因为盒子那边 `row.state`、`.length` 这些用法一行都没改。
 */

const fs = require('node:fs');

function readRecords(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return [];   // CLI 还没起过，台账是空的 —— 不是错
    throw e;
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) {
    // 理论上读不到半截（rename 原子），真碰上了宁可当空也别抛 ——
    // 这条路上抛错会把她那一轮打掉。
    throw new Error(`台账 ${filePath} 读出来不是完整 JSON：${e.message}`);
  }
  return Array.isArray(parsed?.records) ? parsed.records : [];
}

function createLedgerView({ filePath }) {
  if (!filePath) throw new Error('要给台账路径。');
  return {
    get(uuid) {
      return readRecords(filePath).find((r) => r.uuid === uuid);
    },
    list(state, scope) {
      return readRecords(filePath).filter((row) =>
        (state === undefined || row.state === state) &&
        (scope === undefined || row.scope === scope));
    },
  };
}

module.exports = { createLedgerView, readRecords };
