"use strict";

/**
 * 按行比两段文字（Myers 最短编辑），给面板的「改动对比」用。
 * 先削掉首尾相同的行，再在中间跑 Myers；中间段太大（> 2 万行且改得面目全非）就退成「整段删 + 整段加」，不卡死面板。
 */

function splitLines(s) {
  const t = String(s || "");
  if (!t) return [];
  const a = t.split("\n");
  if (a[a.length - 1] === "") a.pop();       // 结尾换行不算一行
  return a;
}

/** @returns {{op:" "|"-"|"+", a?:number, b?:number, text:string}[]}  a/b 是旧/新文件里的行号（从 1 起） */
function diffLines(oldText, newText) {
  const A = splitLines(oldText), B = splitLines(newText);
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a = A.slice(pre, A.length - suf), b = B.slice(pre, B.length - suf);
  const out = [];
  for (let i = 0; i < pre; i++) out.push({ op: " ", a: i + 1, b: i + 1, text: A[i] });
  const mid = myers(a, b);
  let ia = pre, ib = pre;
  for (const op of mid) {
    if (op === " ") { out.push({ op, a: ia + 1, b: ib + 1, text: A[ia] }); ia++; ib++; }
    else if (op === "-") { out.push({ op, a: ia + 1, text: A[ia] }); ia++; }
    else { out.push({ op, b: ib + 1, text: B[ib] }); ib++; }
  }
  for (let i = 0; i < suf; i++) out.push({ op: " ", a: ia + 1 + i, b: ib + 1 + i, text: A[ia + i] });
  return out;
}

function myers(a, b) {
  const n = a.length, m = b.length;
  if (!n) return Array(m).fill("+");
  if (!m) return Array(n).fill("-");
  const max = n + m;
  const BUDGET = 2e7;                 // trace 最多存这么多个整数（约 80MB 以内），超了退成整段替换
  const off = max;
  const v = new Int32Array(2 * max + 2);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    if ((d + 1) * v.length > BUDGET) return [...Array(n).fill("-"), ...Array(m).fill("+")];
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, v, a, b, off, d);
    }
  }
  return [];
}

function backtrack(trace, _v, a, b, off, dEnd) {
  const ops = [];
  let x = a.length, y = b.length;
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d];          // 第 d 轮开始前的 v
    const k = x - y;
    const prevK = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? k + 1 : k - 1;
    const prevX = v[off + prevK], prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push(" "); x--; y--; }
    if (x === prevX) { ops.push("+"); y--; } else { ops.push("-"); x--; }
  }
  while (x > 0 && y > 0) { ops.push(" "); x--; y--; }
  return ops.reverse();
}

/**
 * 只留改动附近的行（前后各 ctx 行），中间的用 {op:"…", skip:n} 占位。
 */
function hunks(lines, ctx = 3) {
  const keep = new Uint8Array(lines.length);
  lines.forEach((l, i) => {
    if (l.op !== " ") for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j++) keep[j] = 1;
  });
  const out = [];
  let skip = 0;
  lines.forEach((l, i) => {
    if (keep[i]) { if (skip) { out.push({ op: "…", skip }); skip = 0; } out.push(l); }
    else skip++;
  });
  if (skip) out.push({ op: "…", skip });
  return out;
}

function stats(lines) {
  let add = 0, del = 0;
  for (const l of lines) { if (l.op === "+") add++; else if (l.op === "-") del++; }
  return { add, del };
}

module.exports = { diffLines, hunks, stats, splitLines };
