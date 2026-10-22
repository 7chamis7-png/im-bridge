'use strict';

/**
 * 进程之间的线上格式 —— nova-cli ↔ nova-box（cli.sock）和 nova-box ↔ nova-gate（box.sock）**共用这一份**。
 *
 * 2026-09-20 晚：box.sock 原来是另一套手写的 `{ok, error: "一句话"}`，错误一过线就只剩一句话，
 * `notAccepted` 这种标记掉在线上 → 桥记成 unknown → 队列堵死（16:35 那次）。补丁是一个字段一个字段
 * 手搬，下一个字段还会掉。所以两条 socket 统一用这里的 encode / createDecoder / packError / unpackError，
 * 错误要带过线的标记进 `ERROR_FLAGS` 白名单，两头都不用再手搬。
 *
 * 为什么有这一层（2026-09-20 Alice：「再拆一层 现在拆」）：
 * 在这之前 CLI 是 box-host 的孙子进程（box-host → SDK → spawn(claude)），
 * **改一行盒子代码就得把他打断一次**。拆开之后 CLI 住在自己的进程里，
 * box 只是个订阅者，随便重启。
 *
 * 帧 = 一行 JSON + "\n"。不用长度前缀：这条链路上的消息本来就都是 JSON，
 * 而且 jsonl 出了事能直接 `tail -f` 看，比二进制好查十倍。
 *
 * ⚠️ **一条铁律：CLI 那头的事件必须能补发。**
 * box 断线（重启、崩溃、升级）期间他照样在说话，那些事件如果只是
 * 「发出去没人收」就永久丢了 —— 她会少收东西，这是我们唯一的判准。
 * 所以 server 侧给每个事件编号、留一个环形缓冲；box 重连时报自己收到的
 * 最后一号，server 从那儿之后重放。9-18 那次「40 个测试全绿、一接管就吞」
 * 就是接线层没人测，这次先把补发写进协议里。
 */

/** 环形缓冲留多少条事件。一轮长回答大概 200~400 条（含 stream_event），留 2000 够覆盖几轮。 */
const EVENT_BUFFER = 2000;

/** box → cli：调方法。{ t:'call', id, method, args } */
const CALL = 'call';
/** 任一方向：回应一次 call / invoke。{ t:'reply', id, ok, value?, error? } */
const REPLY = 'reply';
/** cli → box：事件推送。{ t:'event', seq, kind, payload } */
const EVENT = 'event';
/** cli → box：反向调用（box 那头才有的回调，如 canUseTool）。{ t:'invoke', id, fn, args } */
const INVOKE = 'invoke';
/** cli → box：反向调用被取消（AbortSignal 过不来，用它代替）。{ t:'cancel', id } */
const CANCEL = 'cancel';

/** box 能调的方法。故意列白名单：别让线上消息点到 runtime 以外的东西。 */
const METHODS = new Set([
  'ensure',    // 装配/复用一个运行时（换 cwd/会话/模型才换 CLI）
  'attach',    // 重连：报 lastSeq，拿回状态 + 补发
  'enqueue',
  'start',
  'stop',
  'close',
  'get',
  'list',
  'status',
  'setModel',
  'usage',     // /usage：现在这家引擎的额度 / 余额
  'ping',
]);

/** cli 能反向调的回调。同样白名单。 */
const CALLBACKS = new Set(['canUseTool', 'stderr']);

function encode(frame) {
  return JSON.stringify(frame) + '\n';
}

/**
 * 把 socket 的字节流切成一行一帧。
 * 返回一个 push(chunk) 函数；每切出一帧就调一次 onFrame。
 * 坏行不抛：这条链路断一帧不该把整座桥带崩，交给调用方记一笔就过。
 */
function createDecoder(onFrame, onBadLine = () => {}) {
  let buf = '';
  return function push(chunk) {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let frame;
      try { frame = JSON.parse(line); }
      catch (e) { onBadLine(line, e); continue; }
      onFrame(frame);
    }
  };
}

/**
 * 错误上要**跟着过线**的标记。加一个标记 = 在这儿登记一行，两头自动带上。
 *   notAccepted  确定没送进 CLI（落盘前就抛了）→ 桥可以放心重投，而不是记 unknown 卡死
 */
const ERROR_FLAGS = ['notAccepted'];

/** Error → 可序列化。跨进程后对面要能看懂是什么炸了，白名单里的标记原样带上。 */
function packError(err) {
  if (!err) return { message: '未知错误' };
  const out = {
    message: String(err.message || err),
    name: err.name || 'Error',
    stack: typeof err.stack === 'string' ? err.stack.split('\n').slice(0, 6).join('\n') : undefined,
  };
  for (const k of ERROR_FLAGS) if (err[k] === true) out[k] = true;
  return out;
}

/** 反过来：线上的错误对象 → 本地 Error，保留原始名字、栈的头几行和白名单标记。
 *  也认纯字符串（老格式 / 对面没 pack 就发过来的），别因为格式不齐把错误本身弄丢。 */
function unpackError(payload) {
  if (typeof payload === 'string') return new Error(payload || '对端没给错误信息');
  const e = new Error((payload && payload.message) || '对端没给错误信息');
  if (payload && payload.name) e.name = payload.name;
  if (payload && payload.stack) e.remoteStack = payload.stack;
  for (const k of ERROR_FLAGS) if (payload && payload[k] === true) e[k] = true;
  return e;
}

/**
 * 事件环。server 侧用：每个事件拿一个单调号，box 重连时按号补发。
 * 满了就丢最老的 —— 但丢之前要让 attach 那头知道「你要的号已经没了」，
 * 不能假装补全（假装补全 = 静默丢消息，比明着报错难查得多）。
 */
function createEventRing(capacity = EVENT_BUFFER) {
  const items = [];
  let nextSeq = 1;
  return {
    push(kind, payload) {
      const frame = { t: EVENT, seq: nextSeq++, kind, payload };
      items.push(frame);
      if (items.length > capacity) items.shift();
      return frame;
    },
    /** 从 afterSeq 之后的全部事件。null = 那段已经被挤掉了，补不全。 */
    since(afterSeq) {
      if (!Number.isFinite(afterSeq) || afterSeq < 0) return null;
      if (afterSeq === nextSeq - 1) return [];          // 一条没落下
      if (!items.length) return afterSeq === 0 ? [] : null;
      if (items[0].seq > afterSeq + 1) return null;     // 缺口已被挤掉
      return items.filter((f) => f.seq > afterSeq);
    },
    get lastSeq() { return nextSeq - 1; },
    get size() { return items.length; },
  };
}

module.exports = {
  CALL, REPLY, EVENT, INVOKE, CANCEL,
  METHODS, CALLBACKS, EVENT_BUFFER, ERROR_FLAGS,
  encode, createDecoder, packError, unpackError, createEventRing,
};
