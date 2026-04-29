# AI Hotboard Ops

## SQLite backup

- `ai.hermes.aihotboard-backup` runs from `~/Library/LaunchAgents/ai.hermes.aihotboard-backup.plist` every day at 03:30.
- The tracked plist template lives at `launchd/ai.hermes.aihotboard-backup.plist`.
- The script is `scripts/backup-aihotboard-sqlite.sh` and must stay `chmod 700`.
- Source data is limited to business DBs: `~/.hermes/data/hotboard.sqlite` and `~/.hermes/data/hotboard-zara.sqlite`.
- `auth.sqlite` is intentionally excluded from cloud backup because it contains sessions, magic links, and email whitelist data. It stays local; Time Machine is the fallback, and users can re-login after auth DB loss.
- SQLite copies use `sqlite3 .backup`, not `cp`, so live database locks are handled safely.
- Local tarballs are written to `~/.hermes/data/backups/aihotboard-YYYY-MM-DD.tar.gz` with `chmod 600`.
- Local retention is 7 days via `find ~/.hermes/data/backups -name 'aihotboard-*.tar.gz' -mtime +7 -type f -delete`.
- Feishu upload uses `lark-cli drive +upload` and reads credentials from the local `lark-cli` config/keychain.
- The current default upload target token is `nodcnvDEIBZTozpbbzJFaPShmFd`, the Feishu Drive root folder token for the configured `lark-cli` user.
- Override the upload target without editing credentials: `AIHOTBOARD_BACKUP_FOLDER_TOKEN=<folder_token> scripts/backup-aihotboard-sqlite.sh`.

## Health monitor

- `ai.hermes.aihotboard-monitor` runs from `~/Library/LaunchAgents/ai.hermes.aihotboard-monitor.plist` every 300 seconds and at load.
- The tracked plist template lives at `launchd/ai.hermes.aihotboard-monitor.plist`.
- The script is `scripts/monitor-aihotboard.sh` and must stay `chmod 700`.
- It checks `launchctl print gui/$(id -u)/ai.hermes.aihotboard` for `state = running`.
- It probes `http://localhost:3000/ai-hotboard` and expects HTTP `200`.
- State is stored as `state,failure_count,window_start` at `~/.hermes/data/.aihotboard-monitor-state` with `chmod 600`.
- Alert transition: previous `ok` to current failure sends one Feishu IM.
- Recovery transition: previous `alert` to current healthy sends one Feishu IM.
- Sustained failure is rate-limited to one alert per hour by default; if send fails, state remains `ok` with a rolling failure count so the next 5-minute run retries instead of throttling.
- Feishu IM uses `lark-cli im +messages-send --as bot`; the default recipient is `ou_a06ae3d7885f83839917ac0f44e46247`, JC's open_id for this `lark-cli` app.
- Override the recipient without editing credentials: `AIHOTBOARD_ALERT_USER_ID=<open_id> scripts/monitor-aihotboard.sh`.

## Manual operations

Install or refresh launchd jobs:

```bash
mkdir -p /tmp/hermes-logs
cp launchd/ai.hermes.aihotboard-backup.plist ~/Library/LaunchAgents/ai.hermes.aihotboard-backup.plist
cp launchd/ai.hermes.aihotboard-monitor.plist ~/Library/LaunchAgents/ai.hermes.aihotboard-monitor.plist
chmod 600 ~/Library/LaunchAgents/ai.hermes.aihotboard-backup.plist ~/Library/LaunchAgents/ai.hermes.aihotboard-monitor.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.hermes.aihotboard-backup.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.hermes.aihotboard-monitor.plist
```

If a job is already loaded, unload first:

```bash
launchctl bootout gui/$(id -u)/ai.hermes.aihotboard-backup || true
launchctl bootout gui/$(id -u)/ai.hermes.aihotboard-monitor || true
```

Run a backup manually:

```bash
scripts/backup-aihotboard-sqlite.sh
ls -l ~/.hermes/data/backups/aihotboard-$(date +%Y-%m-%d).tar.gz
tail -40 /tmp/hermes-logs/aihotboard-backup.out.log
```

Check monitor state manually:

```bash
scripts/monitor-aihotboard.sh
cat ~/.hermes/data/.aihotboard-monitor-state
tail -40 /tmp/hermes-logs/aihotboard-monitor.out.log
```

Restart ai-hotboard safely:

```bash
launchctl bootout gui/$(id -u)/ai.hermes.aihotboard || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.hermes.aihotboard.plist || launchctl kickstart -k gui/$(id -u)/ai.hermes.aihotboard
curl -sS -o /dev/null -w 'http=%{http_code}\n' --max-time 5 http://localhost:3000/ai-hotboard
```

When `launchctl bootstrap` says the service is already loaded, use:

```bash
launchctl kickstart -k gui/$(id -u)/ai.hermes.aihotboard
```

When Feishu upload or IM fails, first verify local auth:

```bash
lark-cli doctor
lark-cli auth status
```

If the user token is expired or missing, refresh only the needed scopes:

```bash
lark-cli auth login --scope "drive:file:upload offline_access"
```

For IM alerts, bot identity must be able to message the target open_id. If `open_id cross app` appears, use the open_id from the same `lark-cli` app shown by `lark-cli auth status`, or set `AIHOTBOARD_ALERT_USER_ID` to a compatible recipient.

## Dedicated Feishu folder note

`lark-cli drive +upload` is verified on this machine, but this installed CLI build does not expose `drive +create-folder`. The raw `drive/v1/files/create_folder` call currently exits with no response from the CLI, so the first verified upload target is the configured user's Drive root token. To move uploads under a dedicated `ai-hotboard-backups` folder later:

1. Create the folder in Feishu Drive or upgrade `lark-cli` to a build that exposes `drive +create-folder`.
2. Copy the folder token from the folder URL.
3. Set `AIHOTBOARD_BACKUP_FOLDER_TOKEN=<folder_token>` in the launchd plist environment or replace the default token in `scripts/backup-aihotboard-sqlite.sh`.
4. Run `scripts/backup-aihotboard-sqlite.sh` and verify a new `aihotboard-YYYY-MM-DD.tar.gz` appears in that folder.

## Upgrade triggers

Move beyond this local-only patch when any of these become true:

- Pilot expands beyond 50 active users.
- Traffic exceeds 1000 requests per day.
- The team needs 24x7 monitoring, paging, or SLOs.
- Backup restore drills or audit requirements need immutable storage and retention beyond 7 local days.
- The Mac mini becomes a single point of failure for customer-facing usage.
