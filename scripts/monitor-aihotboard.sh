#!/usr/bin/env bash
set -uo pipefail

umask 077

STATE_FILE="${AIHOTBOARD_MONITOR_STATE_FILE:-$HOME/.hermes/data/.aihotboard-monitor-state}"
LOG_DIR="${HERMES_LOG_DIR:-/tmp/hermes-logs}"
LARK_CLI="${LARK_CLI:-/opt/homebrew/bin/lark-cli}"
ALERT_USER_ID="${AIHOTBOARD_ALERT_USER_ID:-ou_a06ae3d7885f83839917ac0f44e46247}"
SERVICE_LABEL="${AIHOTBOARD_SERVICE_LABEL:-ai.hermes.aihotboard}"
HEALTH_URL="${AIHOTBOARD_HEALTH_URL:-http://localhost:3000/ai-hotboard}"
THROTTLE_SECONDS="${AIHOTBOARD_ALERT_THROTTLE_SECONDS:-3600}"
X_SIGNAL_MONITOR_ENABLED="${X_SIGNAL_MONITOR_ENABLED:-1}"
X_SIGNAL_MONITOR_INTERVAL_SECONDS="${X_SIGNAL_MONITOR_INTERVAL_SECONDS:-1800}"
X_SIGNAL_MONITOR_LAST_RUN_FILE="${X_SIGNAL_MONITOR_LAST_RUN_FILE:-$HOME/.hermes/data/.x-signal-monitor-last-run}"
X_SIGNAL_MONITOR_SCRIPT="${X_SIGNAL_MONITOR_SCRIPT:-/Users/tangyuanjc/hermes-workspace/scripts/monitor-x-signal-sync.sh}"

mkdir -p "$(dirname "$STATE_FILE")" "$LOG_DIR"
chmod 700 "$(dirname "$STATE_FILE")" "$LOG_DIR" 2>/dev/null || true

case "$X_SIGNAL_MONITOR_INTERVAL_SECONDS" in ''|*[!0-9]*) X_SIGNAL_MONITOR_INTERVAL_SECONDS=1800 ;; esac

run_x_signal_monitor_if_due() {
  [ "$X_SIGNAL_MONITOR_ENABLED" = "1" ] || return 0
  [ -x "$X_SIGNAL_MONITOR_SCRIPT" ] || return 0

  local now last_run
  now="$(date +%s)"
  last_run="$(stat -f %m "$X_SIGNAL_MONITOR_LAST_RUN_FILE" 2>/dev/null || stat -c %Y "$X_SIGNAL_MONITOR_LAST_RUN_FILE" 2>/dev/null || echo 0)"
  case "$last_run" in ''|*[!0-9]*) last_run=0 ;; esac
  if [ $((now - last_run)) -lt "$X_SIGNAL_MONITOR_INTERVAL_SECONDS" ]; then
    return 0
  fi

  mkdir -p "$(dirname "$X_SIGNAL_MONITOR_LAST_RUN_FILE")"
  if "$X_SIGNAL_MONITOR_SCRIPT" >> "$LOG_DIR/x-signal-monitor.out.log" 2>> "$LOG_DIR/x-signal-monitor.err.log"; then
    touch "$X_SIGNAL_MONITOR_LAST_RUN_FILE"
    chmod 600 "$X_SIGNAL_MONITOR_LAST_RUN_FILE" 2>/dev/null || true
  else
    echo "x-signal monitor failed" >&2
  fi
}

run_x_signal_monitor_if_due

STATUS="$(launchctl print "gui/$(id -u)/$SERVICE_LABEL" 2>/dev/null | awk '$1 == "state" && $2 == "=" { print $3; exit }')"
[ -n "$STATUS" ] || STATUS="missing"

HTTP="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" 2>/dev/null || echo "fail")"

ALERT=""
if [ "$STATUS" != "running" ]; then
  ALERT="ai-hotboard launchd state=$STATUS (期望 running)"
elif [ "$HTTP" != "200" ]; then
  ALERT="ai-hotboard HTTP probe failed: $HTTP"
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
PREV_TIME="$(stat -f %m "$STATE_FILE" 2>/dev/null || echo 0)"
NOW="$(date +%s)"
if [ $((NOW - PREV_WINDOW_START)) -gt 3600 ]; then
  FAILURE_COUNT=1
  WINDOW_START="$NOW"
else
  FAILURE_COUNT=$((PREV_FAILURE_COUNT + 1))
  WINDOW_START="$PREV_WINDOW_START"
  [ "$WINDOW_START" -gt 0 ] || WINDOW_START="$NOW"
fi

send_message() {
  local body="$1"
  "$LARK_CLI" im +messages-send --as bot --user-id "$ALERT_USER_ID" --text "$body" >> "$LOG_DIR/aihotboard-monitor.out.log"
}

write_state() {
  printf '%s,%s,%s
' "$1" "$2" "$3" > "$STATE_FILE"
  chmod 600 "$STATE_FILE"
}

if [ -n "$ALERT" ]; then
  EXTRA=""
  if [ "$FAILURE_COUNT" -gt 3 ]; then
    EXTRA="
🔴 持续抖动 ${FAILURE_COUNT}x in 1h"
  fi

  if [ "$PREV_STATE" = "ok" ] || [ $((NOW - PREV_TIME)) -ge "$THROTTLE_SECONDS" ]; then
    if send_message "🚨 ai-hotboard 异常
$ALERT${EXTRA}
时间: $(date)"; then
      write_state "alert" "$FAILURE_COUNT" "$WINDOW_START"
    else
      echo "alert send failed: $ALERT" >&2
      write_state "ok" "$FAILURE_COUNT" "$WINDOW_START"
    fi
  fi
  echo "alert: $ALERT"
else
  if [ "$PREV_STATE" = "alert" ]; then
    if ! send_message "✅ ai-hotboard 已恢复
时间: $(date)"; then
      echo "recovery send failed" >&2
    fi
  fi
  write_state "ok" "0" "$NOW"
  echo "ok: launchd=$STATUS http=$HTTP"
fi
