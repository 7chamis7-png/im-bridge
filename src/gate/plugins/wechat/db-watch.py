#!/usr/bin/env python3
"""微信入站采集器 —— 读 Linux 微信的 SQLCipher 库（新桥的插头调它）

⚠️ 这份是 2026-09-18 从 `src/adapters/channel/android-wechat/linux-db-watch.py`
**原样抄过来的**，不是重写。抄的理由（Alice当场叫停我重写）：
  · 那 400 行在跑着，四条过滤条件是被真实事故打磨出来的，重写一遍只会把踩过的坑重踩
  · 但它必须跟插头**抱在一起** —— 看门狗离了桥没有存在意义，而且铁律 1 要求
    「把 src/gate/ 拷到干净机器就能跑」，它住在 src/adapters/ 下就拷不走
  · 先例在同一个目录：`wx-voice-decode.py`（9-17 地基整改时同样处理）

**老桥那份还在原地跑（pm2 42），切换那天才删。** 两份会漂移，所以有一条测试盯着
它们的核心逻辑一致（test/gate/wechat-dbwatch-parity.js）。

抄过来只改三处，别的一个字没动：
  ① **路径从参数来**（铁律 1：代码里不许有写死的路径）
  ② **产出交给调用方**，不再自己写 inbox.log
  ③ **游标吃进来、吐出去，自己不落盘** —— 新桥的规矩是「消化完了才算数」
     （共用层确认这批进了盒子、落了冷层才存游标）。老桥那份读完就推进，
     崩在中间那几条就没了。

用法（插头这么调）：
    db-watch.py --once --keys <all_keys.json> --whitelist <file> --cursor <json>
出：一行 JSON `{"items": [...], "cursor": {...}}`，不写任何文件。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ① 路径**全从参数来**，一个默认值都不留（铁律 1：代码里不许有写死的路径）。
# 第一版我留了 `/root/wxkey/...` 当默认，自查当场抓出来 —— 留默认值等于
# 「拷到别的机器上它会去读一个不存在的路径」，那正是铁律 1 想防的。
KEYS_FILE = None        # --keys（必填）
WHITELIST = None        # --whitelist（必填）
POLL_S = float(os.environ.get("LINUX_WX_POLL_S", "1"))
CST = timezone(timedelta(hours=8))

TYPE_LABEL = {
    1: None,  # 纯文本
    3: "[图片]",
    34: "[语音]",
    42: "[名片]",
    43: "[视频]",
    47: "[动画表情]",
    48: "[位置]",
    49: None,  # appmsg，从 xml 抽
    50: "[通话]",
    10000: None,
    10002: "[系统消息]",
}


def load_keys() -> tuple[str, dict[str, str]]:
    if KEYS_FILE is None:
        raise SystemExit("要 --keys <all_keys.json> —— 不许用默认值猜")
    data = json.loads(KEYS_FILE.read_text(encoding="utf-8"))
    db_dir = data["_db_dir"]
    keys = {k: v["enc_key"] for k, v in data.items() if not k.startswith("_") and "enc_key" in v}
    return db_dir, keys


def load_whitelist() -> set[str]:
    if WHITELIST is None:
        raise SystemExit("要 --whitelist <file> —— 空名单是 fail-closed，路径更不许猜")
    try:
        return {ln.strip() for ln in WHITELIST.read_text(encoding="utf-8").splitlines() if ln.strip()}
    except OSError:
        return set()


def sqlcipher(db: Path, key: str, sql: str, timeout: int = 30) -> list[str]:
    script = (
        f'PRAGMA key = "x\'{key}\'";\n'
        "PRAGMA cipher_compatibility = 4;\n"
        ".headers off\n"
        ".mode list\n"
        ".separator |\n"
        f"{sql}\n"
    )
    r = subprocess.run(
        ["sqlcipher", "-batch", str(db)],
        input=script,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    out = (r.stdout or "").splitlines()
    lines = [ln for ln in out if ln and ln != "ok"]
    if r.returncode != 0:
        err = (r.stderr or "").strip().splitlines()
        err = [e for e in err if "ERROR CORE" not in e]
        raise RuntimeError(f"sqlcipher {db.name}: {err[-1] if err else r.returncode}")
    return lines


# appmsg 的 type → 人能看懂的来路标签。
# 关键是标明「这是她转发过来的东西」，不是她自己说的话 —— Nova分不清谁说的
# 是一类反复出现的病（2026-09-16 他还自己续写过她的下一句）。
APPMSG_LABEL = {
    "5": "[微信转发的链接]",
    "6": "[微信转发的文件]",
    "19": "[微信转发的聊天记录]",
    "33": "[微信转发的小程序]",
    "36": "[微信转发的小程序]",
    "51": "[微信转发的视频号]",
    "57": "[微信引用的消息]",
    "63": "[微信视频号直播]",
    "2000": "[微信转账]",
    "2001": "[微信红包]",
}
# 一条卡片最多给他这么多字。正文本身很短（实测那条 1 万字的卡片里，
# 真正的人话只有约 250 字），超长的部分全是头像链接、哈希和时间戳。
APPMSG_MAX = 600
# 认不出类型的消息给他的上限。她自己打的纯文本不走这条、不封顶。
PLAIN_MAX = 2000


def parse_appmsg(xml_text: str) -> str:
    """把微信的卡片 XML 翻译成一行人话。

    2026-09-17 修：以前这里对聊天记录只返回「[聊天记录]」四个字（内容全丢，
    等于白转），而且真正出事的是 format_body 的兜底分支 —— 认不出类型时
    把原始 XML 原样吐出去。9-17 16:25 她转了一条「聊天记录」卡片，
    10,711 字原文直接注进Nova上下文，撞上游安全层，他连着十分钟整段拒答，
    桥被迫自动换舱。Alice定的口径：留摘要、标明来路、扔壳。
    """
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return "[微信卡片]"
    title = (root.findtext(".//title") or "").strip()
    desc = (root.findtext(".//des") or "").strip()
    typ = (root.findtext(".//type") or "").strip()
    label = APPMSG_LABEL.get(typ, "[微信卡片]")
    body = "：".join(p for p in (title, desc) if p)
    if not body:
        return label
    return clip(f"{label} {body}", APPMSG_MAX)


def clip(text: str, limit: int) -> str:
    """超长就截断并说明截了 —— 别让他以为自己看到的是全文。"""
    text = text.strip()
    if len(text) <= limit:
        return text
    return f"{text[:limit]}…（原文共 {len(text)} 字，已截断）"


def looks_like_xml(text: str) -> bool:
    """微信的卡片不一定落在 local_type=49 上。

    9-17 那三条卡片（含闯祸那条）都没走 49 分支 —— 具体落在哪个 type 还没查
    （库是加密的），所以这里改成看内容不看类型：像 XML 就按卡片解析。
    """
    head = text.lstrip()[:200].lower()
    return head.startswith("<?xml") or head.startswith("<msg")


def looks_binary(text: str) -> bool:
    """这段文本是不是二进制被硬当 UTF-8 解出来的垃圾。

    2026-09-17：未知类型的消息（语音、某些表情包）原始字节直接当文本返回，
    结果是 `(\ufffd/\ufffd ...` 这种天书，既投给了Nova也写进了冷层——他当场
    跟她说"你刚发的那条到我这儿变成一整坨乱码"。宁可显示成 [消息类型N]，
    也不要把一坨字节喂给他。
    """
    if not text:
        return False
    bad = sum(1 for ch in text if ord(ch) == 0xFFFD or (ord(ch) < 32 and ch not in "\n\r\t"))
    return bad >= 3 or bad / len(text) > 0.05


ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"


def zstd_unpack(raw: bytes):
    """微信把长文本消息 zstd 压缩后存进 message_content。

    不是 zstd 就返回 None，解不开也返回 None —— 调用方按原样处理。
    2026-09-17：她那段 185 字节的长消息被原样 utf-8 解码成 169 个乱码字符
    投给了Nova，他"解析不出来"。根因就是这里少了一步解压。
    """
    if not raw.startswith(ZSTD_MAGIC):
        return None
    try:
        r = subprocess.run(
            ["zstd", "-d", "-c"], input=raw, capture_output=True, timeout=10
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout if r.returncode == 0 and r.stdout else None


def format_body(local_type: int, raw: bytes) -> str:
    unpacked = zstd_unpack(raw)
    if unpacked is not None:
        raw = unpacked
    text = raw.decode("utf-8", errors="replace").replace("\x00", "")
    text = text.replace("\t", " ").replace("\r", " ").replace("\n", " ").strip()
    if local_type == 1:
        # 解不出来的别冒充她的原话 —— 乱码正文比丢消息更毒
        if looks_binary(text):
            return "[未解码内容]"
        # 纯文本不封顶 —— 她的长消息一个字都不许丢。封顶只管认不出来的类型。
        return text
    # 卡片按内容认，不按 local_type 认（见 looks_like_xml 的说明）。
    if looks_like_xml(text):
        return parse_appmsg(text)
    if looks_binary(text):
        return TYPE_LABEL.get(local_type) or f"[消息类型{local_type}]"
    label = TYPE_LABEL.get(local_type)
    if label:
        return label if not text else clip(f"{label} {text}", 200)
    # 兜底：认不出类型的一律不原样吐。9-17 就是这一行把 10,711 字 XML 放了出去。
    if not text:
        return f"[消息类型{local_type}]"
    return clip(f"[消息类型{local_type}] {text}", PLAIN_MAX)


def fmt_ts(unix_ts: int) -> str:
    return datetime.fromtimestamp(int(unix_ts), CST).strftime("%Y-%m-%d %H:%M:%S")


def file_mtime_key(paths: list[Path]) -> str:
    parts = []
    for p in paths:
        try:
            st = p.stat()
            parts.append(f"{p.name}:{st.st_mtime_ns}:{st.st_size}")
        except OSError:
            parts.append(f"{p.name}:missing")
    return "|".join(parts)


def nick_map(db_dir: str, keys: dict[str, str]) -> dict[str, str]:
    rel = "contact/contact.db"
    key = keys.get(rel)
    path = Path(db_dir) / rel
    if not key or not path.exists():
        return {}
    try:
        rows = sqlcipher(path, key, "SELECT username, nick_name, alias, remark FROM contact;")
    except Exception as e:
        log(f"contact 读失败: {e}")
        return {}
    out = {}
    for row in rows:
        parts = row.split("|")
        if len(parts) < 2:
            continue
        username = parts[0]
        nick, alias, remark = (parts + ["", "", ""])[1:4]
        out[username] = remark or nick or alias or username
    return out


def self_wxid(db_dir: str) -> str:
    base = Path(db_dir).parent.name  # wxid_xxx_de0d
    return re.sub(r"_de[0-9a-f]+$", "", base)


def iter_message_dbs(db_dir: str) -> list[Path]:
    msg_dir = Path(db_dir) / "message"
    if not msg_dir.is_dir():
        return []
    return sorted(p for p in msg_dir.glob("message_[0-9]*.db") if p.is_file())


def query_new_messages(db: Path, key: str, since: dict[str, int]) -> tuple[list[dict], dict[str, int]]:
    tables = sqlcipher(db, key, "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%';")
    name_rows = sqlcipher(db, key, "SELECT rowid, user_name, ifnull(is_session,0) FROM Name2Id;")
    id_to_user = {}
    for row in name_rows:
        parts = row.split("|")
        if len(parts) >= 2:
            id_to_user[int(parts[0])] = parts[1]
    found: list[dict] = []
    new_since = dict(since)
    for table in tables:
        if not re.fullmatch(r"Msg_[0-9a-f]{32}", table):
            continue
        digest = table[4:]
        last_id = int(since.get(table, 0))
        sql = (
            # ⚠️ server_id 必须查出来：语音的字节不在这张表里，在 media_0.db/VoiceInfo，
            # 靠 server_id 对上（唯一）。漏了它，语音一路走到 fetchMedia 才报
            # voice_no_serverid —— 2026-09-18 Nova说"还是听不见"查出来的。
            f"SELECT local_id, local_type, real_sender_id, create_time, hex(ifnull(message_content,'')), "
            f"ifnull(server_id,0) "
            f"FROM {table} WHERE local_id > {last_id} ORDER BY local_id;"
        )
        rows = sqlcipher(db, key, sql)
        max_id = last_id
        for row in rows:
            parts = row.split("|")
            if len(parts) < 6:
                continue
            local_id = int(parts[0])
            local_type = int(parts[1])
            sender_id = int(parts[2])
            create_time = int(parts[3])
            raw = bytes.fromhex(parts[4]) if parts[4] else b""
            max_id = max(max_id, local_id)
            found.append({
                "table": table,
                "digest": digest,
                "local_id": local_id,
                "local_type": local_type,
                "sender": id_to_user.get(sender_id, ""),
                "create_time": create_time,
                "body": format_body(local_type, raw),
                # 原始字节也带出去：插头的 toDelivery 自己解 zstd/appmsg/表情/图片，
                # 比这儿的 format_body 认得全。老桥那条路不看这个字段。
                "raw_hex": parts[4] or "",
                # 语音靠它去 media_0.db 取字节（见插头 fetchMedia 的 voice 分支）
                "server_id": parts[5] or "",
            })
        new_since[table] = max_id
    return found, new_since


def session_wxid_for_table(digest: str, nicks: dict[str, str]) -> str | None:
    for wxid in nicks:
        if hashlib.md5(wxid.encode()).hexdigest() == digest:
            return wxid
    return None


def poll_once(db_dir: str, keys: dict[str, str], state: dict, nicks: dict[str, str],
              allow: set[str], me: str, sink=None) -> dict:
    """sink 不给就还是写 inbox.log（老行为）；给了就交给调用方（--once 模式）。"""
    cursors: dict[str, dict[str, int]] = state.setdefault("cursors", {})
    mtimes: dict[str, str] = state.setdefault("mtimes", {})
    for db in iter_message_dbs(db_dir):
        rel = f"message/{db.name}"
        key = keys.get(rel)
        if not key:
            continue
        stamp = file_mtime_key([db, Path(str(db) + "-wal")])
        prev = mtimes.get(rel)
        if prev == stamp and rel in cursors:
            continue
        try:
            msgs, new_since = query_new_messages(db, key, cursors.get(rel, {}))
        except Exception as e:
            # ⚠️ 这里原来写的是 log()，但这个文件里根本没有 log —— 一个库读不了
            # 就在错误处理里再抛 NameError，把整个采集器带崩、别的库一起停。
            # 2026-10-20 微信"修复"新建 message_1.db（当时还没 Name2Id 表）时实际踩到。
            print(f"读 {rel} 失败: {e}", file=sys.stderr)
            continue
        mtimes[rel] = stamp
        cursors[rel] = new_since
        for m in msgs:
            if m["sender"] == me:
                continue
            wxid = session_wxid_for_table(m["digest"], nicks) or m["sender"]
            from_name = nicks.get(wxid) or nicks.get(m["sender"]) or wxid
            # 2026-09-17：原来是 `if allow and ...`——白名单为空时整个条件短路成 False，
            # 谁发都放行，而 bridge.js 又把 from_name 硬写成 Alice，等于别人的话被
            # 标成她说的。去掉 `allow and`：空白名单 = 谁都不放行（fail-closed）。
            if from_name not in allow and wxid not in allow:
                continue
            if not m["body"]:
                continue
            if sink is None:
                append_inbox("android-wechat", fmt_ts(m["create_time"]), from_name, m["body"])
                log(f"入站 {from_name} local_id={m['local_id']} type={m['local_type']} {len(m['body'])}字")
            else:
                # --once：把**原始字段**交出去，正文的解析归插头的 toDelivery
                #（它认 zstd / appmsg / 表情 / 图片，比这儿的 format_body 全）
                sink({
                    "db": rel,
                    "table": m["table"],
                    "local_id": m["local_id"],
                    "local_type": m["local_type"],
                    "sender": wxid,
                    "from_name": from_name,
                    "create_time": m["create_time"],
                    "raw_hex": m.get("raw_hex", ""),
                    # 语音靠它去 media_0.db/VoiceInfo 取字节。**这一层投影漏了它**，
                    # 上面查出来也白查 —— 2026-09-18「他说还是听不见」的最后一道坎。
                    "server_id": m.get("server_id", ""),
                    "body": m["body"],
                })
    return state


def run_once(argv: list[str]) -> int:
    """跑一次就退。**不写任何文件** —— 游标吃进来、吐出去，归调用方存。"""
    def arg(name, default=None):
        return argv[argv.index(name) + 1] if name in argv else default

    global KEYS_FILE, WHITELIST
    if arg("--keys"):
        KEYS_FILE = Path(arg("--keys"))
    if arg("--whitelist"):
        WHITELIST = Path(arg("--whitelist"))

    cursor_raw = arg("--cursor", "{}") or "{}"
    try:
        state = json.loads(cursor_raw)
    except Exception:
        state = {}
    if not isinstance(state, dict):
        state = {}

    db_dir, keys = load_keys()
    me = self_wxid(db_dir)
    nicks = nick_map(db_dir, keys)
    allow = load_whitelist()

    # **白名单为空 = 配置故障，停止采集且不推进游标**（原样搬自主循环）。
    # 消息留在微信库里，修好白名单后会照常采上来，不会丢。
    if not allow:
        print(json.dumps({"items": [], "cursor": state,
                          "error": f"白名单为空或不可读（{WHITELIST}）——不采集、不推进游标"},
                         ensure_ascii=False))
        return 0

    items: list[dict] = []
    state = poll_once(db_dir, keys, state, nicks, allow, me, sink=items.append)
    print(json.dumps({"items": items, "cursor": state, "me": me}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    # **只有 --once**。常驻循环那半是老桥的活（pm2 42），抄过来留着就是
    # 「没人走的路」—— 今晚已经因为这种路踩过一次坑（forCold 零调用）。
    if "--once" not in sys.argv:
        raise SystemExit("用法: db-watch.py --once --keys <all_keys.json> --whitelist <file> [--cursor <json>]")
    sys.exit(run_once(sys.argv))
