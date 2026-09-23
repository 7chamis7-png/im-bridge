#!/usr/bin/env python3
"""WeChat inbound reader: reads the Linux WeChat client's SQLCipher databases.

Called by the wechat plugin (index.js). Design rules:
  1. All paths come from arguments; no defaults.
  2. Output goes to the caller (stdout JSON); nothing is written to disk.
  3. The cursor is taken in and handed back; the caller persists it only after
     the batch has been fully processed, so a crash never loses messages.

Usage:
    db-watch.py --once --keys <all_keys.json> --whitelist <file> --cursor <json>
Output: one JSON line `{"items": [...], "cursor": {...}}`.
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

# All paths come from arguments; no defaults.
KEYS_FILE = None        # --keys (required)
WHITELIST = None        # --whitelist (required)
POLL_S = float(os.environ.get("LINUX_WX_POLL_S", "1"))
CST = timezone(timedelta(hours=8))

TYPE_LABEL = {
    1: None,  # plain text
    3: "[图片]",
    34: "[语音]",
    42: "[名片]",
    43: "[视频]",
    47: "[动画表情]",
    48: "[位置]",
    49: None,  # appmsg, parsed from XML
    50: "[通话]",
    10000: None,
    10002: "[系统消息]",
}


def log(msg: str) -> None:
    sys.stderr.write(f"[db-watch] {msg}\n")


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


# appmsg type -> source label. Marks forwarded content as forwarded, so it is
# never mistaken for the sender's own words.
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
# Cap per card. Real text in card XML is short; the rest is avatars, hashes, timestamps.
APPMSG_MAX = 600
# Cap for unrecognized types. Plain text is never capped.
PLAIN_MAX = 2000


def parse_appmsg(xml_text: str) -> str:
    """Render WeChat card XML as one readable line: keep a summary, label the
    source, drop the wrapper. Raw card XML can be >10k chars and must never be
    injected as-is.
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
    """Truncate and say so, so the reader never mistakes it for the full text."""
    text = text.strip()
    if len(text) <= limit:
        return text
    return f"{text[:limit]}…（原文共 {len(text)} 字，已截断）"


def looks_like_xml(text: str) -> bool:
    """Cards don't always have local_type=49, so detect by content: XML-looking text is a card."""
    head = text.lstrip()[:200].lower()
    return head.startswith("<?xml") or head.startswith("<msg")


def looks_binary(text: str) -> bool:
    """Is this binary data force-decoded as UTF-8? Better to show a [type N]
    placeholder than to deliver garbage text.
    """
    if not text:
        return False
    bad = sum(1 for ch in text if ord(ch) == 0xFFFD or (ord(ch) < 32 and ch not in "\n\r\t"))
    return bad >= 3 or bad / len(text) > 0.05


ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"


def zstd_unpack(raw: bytes):
    """WeChat stores long text messages zstd-compressed in message_content.

    Returns None if not zstd or not decodable; the caller handles the raw bytes.
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
        # never pass garbage off as the sender's text
        if looks_binary(text):
            return "[未解码内容]"
        # plain text is never capped; caps apply only to unrecognized types
        return text
    # detect cards by content, not local_type (see looks_like_xml)
    if looks_like_xml(text):
        return parse_appmsg(text)
    if looks_binary(text):
        return TYPE_LABEL.get(local_type) or f"[消息类型{local_type}]"
    label = TYPE_LABEL.get(local_type)
    if label:
        return label if not text else clip(f"{label} {text}", 200)
    # fallback: never emit unrecognized content unbounded
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
        log(f"reading contact db failed: {e}")
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
    base = Path(db_dir).parent.name  # e.g. wxid_xxxx_de0d
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
            # server_id is required: voice bytes live in media_0.db/VoiceInfo keyed by it.
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
                # raw bytes: the plugin's toDelivery does the full decoding
                "raw_hex": parts[4] or "",
                # used to fetch voice bytes from media_0.db (plugin fetchMedia)
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
              allow: set[str], me: str, sink) -> dict:
    """Collect new whitelisted inbound messages and hand each to `sink`."""
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
            log(f"reading {rel} failed: {e}")
            continue
        mtimes[rel] = stamp
        cursors[rel] = new_since
        for m in msgs:
            if m["sender"] == me:
                continue
            wxid = session_wxid_for_table(m["digest"], nicks) or m["sender"]
            from_name = nicks.get(wxid) or nicks.get(m["sender"]) or wxid
            # Fail-closed: an empty whitelist lets nobody through.
            if from_name not in allow and wxid not in allow:
                continue
            if not m["body"]:
                continue
            # hand over raw fields; content decoding belongs to the plugin's toDelivery
            sink({
                "db": rel,
                "table": m["table"],
                "local_id": m["local_id"],
                "local_type": m["local_type"],
                "sender": wxid,
                "from_name": from_name,
                "create_time": m["create_time"],
                "raw_hex": m.get("raw_hex", ""),
                # needed to fetch voice bytes from media_0.db/VoiceInfo
                "server_id": m.get("server_id", ""),
                "body": m["body"],
            })
    return state


def run_once(argv: list[str]) -> int:
    """Run once and exit. Writes no files: the cursor goes in and comes back out."""
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

    # Empty whitelist = configuration error: collect nothing, don't advance the cursor.
    # Messages stay in the WeChat DB and are picked up once the whitelist is fixed.
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
    # Only --once mode is supported; the plugin drives the polling loop.
    if "--once" not in sys.argv:
        raise SystemExit("用法: db-watch.py --once --keys <all_keys.json> --whitelist <file> [--cursor <json>]")
    sys.exit(run_once(sys.argv))
