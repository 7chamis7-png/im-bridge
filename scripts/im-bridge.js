#!/usr/bin/env node
"use strict";
/**
 * im-bridge 的命令行入口。
 *   node scripts/im-bridge.js init [角色id] [--answers a.json | --yes …]   新建一个角色
 *   node scripts/im-bridge.js doctor [角色id | --env <env文件>]            体检
 */
const sub = process.argv[2];
const rest = process.argv.slice(3);
const table = {
  init: () => require("./init").main(rest),
  doctor: () => require("./doctor").main(rest),
};
if (!table[sub]) {
  console.log("用法：\n  im-bridge init [角色id]      新建一个角色（交互问；--answers 文件 / --yes 不问）\n  im-bridge doctor [角色id]    体检（node / 引擎 / 凭据 / socket / 配置 / TG token）");
  process.exit(sub ? 2 : 0);
}
Promise.resolve(table[sub]()).then((code) => process.exit(code || 0), (e) => { console.error(e); process.exit(1); });
