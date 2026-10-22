# im-bridge panel (English summary)

> **Try it first:**
>
> ```bash
> node src/panel/server.js --demo
> ```
>
> Starts the full panel on `http://127.0.0.1:8790` with fake data (two made-up characters), no login, read-only. No running bridge needed; nothing on your machine is read.

Full documentation (Chinese): [panel.md](panel.md). The UI defaults to Chinese; set `PANEL_LANG=en` (or `auto` to follow the browser) for English.

![Overview (phone, light / dark)](panel-img/home.png)

## What it is

A web panel for the owner of an im-bridge setup: see how each character is doing at a glance, and do a few hands-on things — rotate the session, edit his files, choose which recent turns get carried into the next session. Every change goes through a confirmation page.

Server-rendered, no external resources, no JavaScript (strict CSP), phone-friendly, light/dark. Listens on `127.0.0.1` only. No new dependencies.

## Features

Overview cards (actual model from the box, context fill, last in/out, pm2 processes) · stuck messages (same view as Telegram `/pending`, read-only) · failures · what the next session will be built from (sources outside the character's own directories are flagged red) · full assembled preview of the next session (system prompt → persona → base → warm tail, using the same functions the rotation uses) · warm-tail picker (untick turns to leave them out of the next session only; the cold log is never modified) · rotate with optional model choice (from the character's model registry; "keep model" = exactly Telegram `/new`) · file editor with diff → confirm → write, backups and one-click restore · "his writings" browser · audit log.

## Security model

- **Login**: `--issue-link` prints a one-time link **and** an 8-character code (same record, 10 minutes, either one consumes both). The code is for home-screen web apps, which don't share cookies with the browser. Code attempts are rate-limited (5 failures per source IP → 15-minute lock; 30 failures site-wide in 10 minutes → 15-minute lock; `CF-Connecting-IP` is used behind Cloudflare).
- **Sessions**: `PANEL_SESSION_DAYS` (default 3650), sliding renewal on every visit. Revoke all: `node src/panel/server.js --revoke-all`. Only sha256 hashes are stored; state dir 0700, files 0600; cookies `HttpOnly; SameSite=Strict` (+`Secure` when `PANEL_PUBLIC_URL` is https).
- **Changes**: POST only, session-bound CSRF token, `Sec-Fetch-Site`/`Origin` checks, PRG after every action.
- **Rotation** goes through the gate's local control socket `$GATE_ROOT/control.sock` (0600) and runs through the very same command table as Telegram, as the owner. It accepts only `/new`, `/model <id>`, `/engine <id>` (ids must exist in the registry) and the sequence `/new` → `/model`. Any process of the same OS user can reach the socket.
- **Editable files**: only files inside the character's own declared directories, persona files, and text files under "his writings". Never: other characters' directories, `.env`/`*.secret`/`*-env.sh`/credential-like names, the bridge's runtime ledgers (the gate root is not listed at all), binaries, files over 2 MB. Paths must match the freshly computed list exactly; `..` is rejected; symlinks are re-checked after `realpath`.
- **Writes**: optimistic lock on the sha256 seen when opening (checked again right before rename), backup of the old version, atomic write preserving mode/owner, audit line in `audit.jsonl`.

## Running

Node ≥ 22. Copy `examples/panel.env.example`, then start it with a clean environment (`env -i …`) so variables from another character's env in your shell can't leak into the panel. pm2 and systemd examples are in [panel.md](panel.md). pm2 processes named `<id>-…` are attributed to that character.

To expose it, put a tunnel/reverse proxy in front (Cloudflare Tunnel example in panel.md) — first check locally that every page returns 401 without a cookie, and set `PANEL_PUBLIC_URL` to the https URL.

## Configuration

`PANEL_PORT`, `PANEL_STATE_DIR`, `PANEL_CHARACTERS`, `PANEL_NAMES`, `PANEL_ACCENTS`, `PANEL_PUBLIC_URL`, `PANEL_SESSION_DAYS`, `PANEL_BACKUP_KEEP`, `PANEL_LANG`, `PANEL_COPY_FILE`, `PANEL_TZ`, `PANEL_HERO_IMAGE`, `PANEL_NIGHT_IMAGE`, `PM2_HOME` — see the table in panel.md.

## Known limitations

The Codex engine doesn't report the model actually used; the control socket can't keep out same-user processes; a few-millisecond window remains between the last lock check and rename; error logs have no timestamps (the panel keeps its own baseline).

## Assets

The header and night background images were made by the project maintainer with an AI image generator and are released under this repository's license. `cathedral.svg` and `icon.svg` are original vector art of this project.
