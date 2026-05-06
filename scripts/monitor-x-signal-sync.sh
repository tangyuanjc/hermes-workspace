#!/usr/bin/env bash
set -uo pipefail

umask 077

STATE_FILE="${X_SIGNAL_MONITOR_STATE_FILE:-$HOME/.hermes/data/.x-signal-monitor-state}"
LOG_DIR="${HERMES_LOG_DIR:-/tmp/hermes-logs}"
LARK_CLI="${LARK_CLI:-/opt/homebrew/bin/lark-cli}"
ALERT_USER_ID="${X_SIGNAL_ALERT_USER_ID:-ou_a06ae3d7885f83839917ac0f44e46247}"
SERVICE_LABEL="${X_SIGNAL_SERVICE_LABEL:-ai.hermes.x-signal-sync}"
LATEST_PATH="${X_SIGNAL_LATEST_PATH:-$HOME/.hermes/tmp/x_signal_sync_latest.json}"
SCRIPT_PATH="${X_SIGNAL_SCRIPT_PATH:-$HOME/.hermes/hermes-agent/scripts/x_signal_sync.py}"
MIN_BYTES="${X_SIGNAL_MIN_BYTES:-300000}"
THROTTLE_SECONDS="${X_SIGNAL_ALERT_THROTTLE_SECONDS:-3600}"

mkdir -p "$(dirname "$STATE_FILE")" "$LOG_DIR"
chmod 700 "$(dirname "$STATE_FILE")" "$LOG_DIR" 2>/dev/null || true

case "$MIN_BYTES" in ''|*[!0-9]*) MIN_BYTES=300000 ;; esac
case "$THROTTLE_SECONDS" in ''|*[!0-9]*) THROTTLE_SECONDS=3600 ;; esac

file_size() {
  local file_path="$1"
  if [ ! -f "$file_path" ]; then
    echo 0
    return
  fi
  stat -f %z "$file_path" 2>/dev/null || stat -c %s "$file_path" 2>/dev/null || echo 0
}

send_message() {
  local body="$1"
  "$LARK_CLI" im +messages-send --as bot --user-id "$ALERT_USER_ID" --text "$body" >> "$LOG_DIR/x-signal-monitor.out.log"
}

write_state() {
  printf '%s,%s,%s\n' "$1" "$2" "$3" > "$STATE_FILE"
  chmod 600 "$STATE_FILE"
}

ALERT=""
DETAIL=""

LAUNCHD_PRINT="$(launchctl print "gui/$(id -u)/$SERVICE_LABEL" 2>/dev/null || true)"
ACTUAL_SCRIPT="$(printf '%s\n' "$LAUNCHD_PRINT" | awk '/x_signal_sync\.py/ { gsub(/^[ \t]+|[ \t]+$/, ""); print; exit }')"

if [ -z "$ACTUAL_SCRIPT" ]; then
  ALERT="launchd script missing"
  DETAIL="label=$SERVICE_LABEL expected=$SCRIPT_PATH"
elif [ "$ACTUAL_SCRIPT" != "$SCRIPT_PATH" ]; then
  ALERT="launchd script mismatch"
  DETAIL="expected=$SCRIPT_PATH actual=$ACTUAL_SCRIPT"
elif [ ! -f "$LATEST_PATH" ]; then
  ALERT="latest.json missing"
  DETAIL="path=$LATEST_PATH"
else
  SIZE="$(file_size "$LATEST_PATH")"
  case "$SIZE" in ''|*[!0-9]*) SIZE=0 ;; esac
  if [ "$SIZE" -lt "$MIN_BYTES" ]; then
    ALERT="latest.json too small"
    DETAIL="size=$SIZE min=$MIN_BYTES path=$LATEST_PATH"
  fi
fi

RAW_STATE="$(cat "$STATE_FILE" 2>/dev/null || echo "ok,0,0")"
IFS=',' read -r PREV_STATE PREV_FAILURE_COUNT PREV_WINDOW_START <<EOF
$RAW_STATE
EOF
PREV_STATE="${PREV_STATE:-ok}"
PREV_FAILURE_COUNT="${PREV_FAILURE_COUNT:-0}"
PREV_WINDOW_START="${PREV_WINDOW_START:-0}"
case "$PREV_FAILURE_COUNT" in ''|*[!0-9]*) PREV_FAILURE_COUNT=0 ;; esac
case "$PREV_WINDOW_START" in ''|*[!0-9]*) PREV_WINDOW_START=0 ;; esac
PREV_TIME="$(stat -f %m "$STATE_FILE" 2>/dev/null || stat -c %Y "$STATE_FILE" 2>/dev/null || echo 0)"
NOW="$(date +%s)"

if [ $((NOW - PREV_WINDOW_START)) -gt 3600 ]; then
  FAILURE_COUNT=1
  WINDOW_START="$NOW"
else
  FAILURE_COUNT=$((PREV_FAILURE_COUNT + 1))
  WINDOW_START="$PREV_WINDOW_START"
  [ "$WINDOW_START" -gt 0 ] || WINDOW_START="$NOW"
fi

if [ -n "$ALERT" ]; then
  EXTRA=""
  if [ "$FAILURE_COUNT" -gt 3 ]; then
    EXTRA="
🔴 持续抖动 ${FAILURE_COUNT}x in 1h"
  fi

  if [ "$PREV_STATE" = "ok" ] || [ $((NOW - PREV_TIME)) -ge "$THROTTLE_SECONDS" ]; then
    if send_message "🚨 X signal sync 异常
$ALERT: $DETAIL${EXTRA}
时间: $(date)"; then
      write_state "alert" "$FAILURE_COUNT" "$WINDOW_START"
    else
      echo "alert send failed: $ALERT: $DETAIL" >&2
      write_state "ok" "$FAILURE_COUNT" "$WINDOW_START"
    fi
  fi
  echo "alert: $ALERT: $DETAIL"
else
  if [ "$PREV_STATE" = "alert" ]; then
    if ! send_message "✅ X signal sync 已恢复
latest_size=$(file_size "$LATEST_PATH") path=$LATEST_PATH
时间: $(date)"; then
      echo "recovery send failed" >&2
    fi
  fi
  write_state "ok" "0" "$NOW"
  echo "ok: script=$ACTUAL_SCRIPT latest_size=$(file_size "$LATEST_PATH") min=$MIN_BYTES"
fi
