"use strict";
/**
 * 微信文字发送后端 —— 走微信内部 RPC（不再点屏幕）。
 *
 * 2026-09-19 Keeper建。逆向出微信自带的 `message::send_text_message`（见记忆
 * project-wechat-frida-send-reverse）。真正调 RPC 的活在独立引擎 `wx-rpc-sender`
 * 里（frida 挂微信 + unix socket）；这个文件只是**把消息递给那个引擎的一根线**。
 *
 * 只管**文字**。图片/语音/贴纸/拨号没有 RPC，仍走 a11y（见 a11y-send.js）。
 *
 * ⚠️ 过渡文件：将来整体迁去 im_bridge 时，这个文件原样搬走即可（不依赖 gate 内部）。
 */
const net = require("net");

function makeRpcSender(env, log = () => {}) {
  const sockPath = env.GATE_WECHAT_RPC_SOCK || require("path").join(require("../../../core/paths").gateRoot(env), "wx-rpc.sock");
  const timeoutMs = Number(env.GATE_WECHAT_RPC_TIMEOUT_MS || 15000);

  /** 连引擎 socket，递一行 JSON，等一行 JSON 回来。 */
  function call(chatId, content) {
    return new Promise((resolve, reject) => {
      let buf = "";
      let done = false;
      const c = net.createConnection(sockPath);
      const finish = (fn, arg) => {
        if (done) return;
        done = true;
        try { c.destroy(); } catch (_) {}
        fn(arg);
      };
      const timer = setTimeout(
        () => finish(reject, new Error(`微信RPC引擎超时(${timeoutMs}ms) —— 引擎(wx-rpc-sender)没起或没挂上微信`)),
        timeoutMs
      );
      c.on("connect", () => {
        c.write(JSON.stringify({ chat_id: chatId, content }) + "\n");
      });
      c.on("data", (d) => {
        buf += d.toString();
        if (!buf.includes("\n")) return;
        clearTimeout(timer);
        let r;
        try { r = JSON.parse(buf.trim()); }
        catch (e) { return finish(reject, new Error("微信RPC引擎返回不是JSON：" + buf.slice(0, 200))); }
        if (r && r.ok) finish(resolve, r);
        else finish(reject, new Error("微信RPC发送失败：" + (r && r.err ? r.err : JSON.stringify(r))));
      });
      c.on("error", (e) => { clearTimeout(timer); finish(reject, e); });
    });
  }

  return {
    // 形状对齐 a11y 的 sender：({ chatId, text, operationId }) -> nativeId
    sender: async ({ chatId, text }) => {
      if (!chatId) throw new Error("微信RPC: chatId 为空 —— 出闸应先解析目标");
      const r = await call(chatId, String(text));
      log(`[微信RPC] 发出 chat=${chatId} ${String(text).length}字 -> ${JSON.stringify(r.result || r)}`);
      // server_id 是异步回执，这里拿不到；跟 a11y 一样返回 null nativeId
      return null;
    },
  };
}

module.exports = { makeRpcSender };
