"use strict";
/**
 * 2026-10-21「拉下来就能用」：写死的 /root 路径和名字改成配置之后，
 *   · 不给 env = 跟生产原来一模一样（HOME=/root → /root/...；名字 = Alice / Nova / Nova）
 *   · 给了 env = 换成给的
 * 子进程跑，env 干净，不碰生产任何文件。
 */
const { execFileSync } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
let pass = 0, fail = 0;
const check = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log("  " + (ok ? "OK  " : "FAIL") + " " + n + (ok ? "" : "  got=" + JSON.stringify(got) + " want=" + JSON.stringify(want)));
  ok ? pass++ : fail++;
};

function probe(env) {
  const code = `
    const R = ${JSON.stringify(ROOT)};
    const p = require(R + "/src/core/paths"); const n = require(R + "/src/core/names");
    const fa = require(R + "/src/host/model-fallback-alert");
    const reg = require(R + "/src/toolbox/registry");
    const eng = require(R + "/cli-host/engines");
    console.log(JSON.stringify({
      secrets: p.secretsDir(), state: p.personaStateDir(), gate: p.gateRoot(),
      proj: p.claudeProjectDir("/root/nova"), notebook: reg.CODE_DEFAULTS.NOVA_NOTEBOOK_HOME, engSecrets: eng.SECRETS_DIR,
      owner: n.ownerDisplayName(), agent: n.agentDisplayName(), alert: n.agentAlertName(),
      wake: require(R + "/src/gate/group").WAKE_NAMES,
      alertText: fa.composeAlertText({ kind: "session_limit", at: "2026-10-21T00:00:00Z" }).split("\\n")[0],
      guard: require(R + "/tools/daily/tools").GUARD.includes(n.ownerDisplayName()),
    }));`;
  return JSON.parse(execFileSync(process.execPath, ["-e", code], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" }));
}

console.log("\n[1] 不给 env：跟生产原来写死的一样");
const a = probe({ HOME: "/root" });
check("钥匙柜", a.secrets, "/root/.secrets");
check("插头表的钥匙柜", a.engSecrets, "/root/.secrets");
check("人格数据目录", a.state, "/root/.nova");
check("桥目录兜底", a.gate, "/root/.nova-gate");
check("会话记录目录", a.proj, "/root/.claude/projects/-root-nova");
check("笔记本代码", a.notebook, "/root/nova-notebook");
check("主人", a.owner, "Alice");
check("他", a.agent, "Nova");
check("告警里的他", a.alert, "Nova");
check("群叫醒词", a.wake, ["Nova", "Alice"]);
check("告警首行", a.alertText, "🈳 Nova这一轮额度用完了");
check("网页护栏里是主人的名字", a.guard, true);

console.log("\n[2] 给了 env：换成给的");
const b = probe({ HOME: "/home/x", IM_BRIDGE_SECRETS_DIR: "/srv/keys", NOVA_STATE_DIR: "/home/x/.ah7", GATE_ROOT: "/home/x/.ah7-gate",
  GATE_OWNER_DISPLAY_NAME: "小A", GATE_AGENT_DISPLAY_NAME: "阿七" });
check("钥匙柜", b.secrets, "/srv/keys");
check("人格数据目录", b.state, "/home/x/.ah7");
check("桥目录", b.gate, "/home/x/.ah7-gate");
check("代码默认跟 HOME 走", b.notebook, "/home/x/nova-notebook");
check("主人", b.owner, "小A");
check("告警名没单给 = 他的名字", b.alert, "阿七");
check("群叫醒词", b.wake, ["阿七", "小A"]);
check("告警首行", b.alertText, "🈳 阿七这一轮额度用完了");
check("网页护栏里是主人的名字", b.guard, true);

console.log(`\n${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
