#!/usr/bin/env bash
set -euo pipefail

umask 077

# auth.sqlite 不上云,本机 Time Machine 兜底,失败时同事重新登录即可。

HERMES_DATA_DIR="${HERMES_DATA_DIR:-$HOME/.hermes/data}"
BACKUP_DIR="$HERMES_DATA_DIR/backups"
LOG_DIR="${HERMES_LOG_DIR:-/tmp/hermes-logs}"
LARK_CLI="${LARK_CLI:-/opt/homebrew/bin/lark-cli}"
# Feishu Drive folder/root token. Override with AIHOTBOARD_BACKUP_FOLDER_TOKEN
# after dedicating another folder for ai-hotboard backups.
FOLDER_TOKEN="${AIHOTBOARD_BACKUP_FOLDER_TOKEN:-nodcnvDEIBZTozpbbzJFaPShmFd}"
DATE="$(date +%Y-%m-%d)"
STAGING="$BACKUP_DIR/$DATE"
TARBALL="$BACKUP_DIR/aihotboard-$DATE.tar.gz"
BUSINESS_DBS=(hotboard.sqlite hotboard-zara.sqlite)

mkdir -p "$STAGING" "$LOG_DIR"
chmod 700 "$BACKUP_DIR" "$LOG_DIR" 2>/dev/null || true

for db in "${BUSINESS_DBS[@]}"; do
  if [ -f "$HERMES_DATA_DIR/$db" ]; then
    sqlite3 "$HERMES_DATA_DIR/$db" ".backup '$STAGING/$db'"
    chmod 600 "$STAGING/$db"
  fi
done

tar czf "$TARBALL" -C "$BACKUP_DIR" "$DATE"
chmod 600 "$TARBALL"
rm -rf "$STAGING"

(
  cd "$BACKUP_DIR"
  "$LARK_CLI" drive +upload --file "./$(basename "$TARBALL")" --folder-token "$FOLDER_TOKEN" >> "$LOG_DIR/aihotboard-backup.out.log"
)

find "$BACKUP_DIR" -name 'aihotboard-*.tar.gz' -mtime +7 -type f -delete

echo "backup uploaded: $TARBALL"
