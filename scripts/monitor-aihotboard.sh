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

mkdir -p "$(dirname "$STATE_FILE")" "$LOG_DIR"
chmod 700 "$(dirname "$STATE_FILE")" "$LOG_DIR" 2>/dev/null || true

STATUS="$(launchctl print "gui/$(id -u)/$SERVICE_LABEL" 2>/dev/null | awk '$1 == "state" && $2 == "=" { print $3; exit }')"
[ -n "$STATUS" ] || STATUS="missing"

HTTP="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" 2>/dev/null || echo "fail")"

ALERT=""
if [ "$STATUS" != "running" ]; then
  ALERT="ai-hotboard launchd state=$STATUS (期望 running)"
elif [ "$HTTP" != "200" ]; then
  ALERT="ai-hotboard HTTP probe failed: $HTTP"
fi

PREV_STATE="$(cat "$STATE_FILE" 2>/dev/null || echo "ok")"
PREV_TIME="$(stat -f %m "$STATE_FILE" 2>/dev/null || echo 0)"
NOW="$(date +%s)"

send_message() {
  local body="$1"
  "$LARK_CLI" im +messages-send --as bot --user-id "$ALERT_USER_ID" --text "$body" >> "$LOG_DIR/aihotboard-monitor.out.log"
}

if [ -n "$ALERT" ]; then
  if [ "$PREV_STATE" = "ok" ] || [ $((NOW - PREV_TIME)) -gt "$THROTTLE_SECONDS" ]; then
    send_message "🚨 ai-hotboard 异常
$ALERT
时间: $(date)"
    echo "alert" > "$STATE_FILE"
    chmod 600 "$STATE_FILE"
  elif [ ! -f "$STATE_FILE" ]; then
    echo "alert" > "$STATE_FILE"
    chmod 600 "$STATE_FILE"
  fi
  echo "alert: $ALERT"
else
  if [ "$PREV_STATE" = "alert" ]; then
    send_message "✅ ai-hotboard 已恢复
时间: $(date)"
  fi
  echo "ok" > "$STATE_FILE"
  chmod 600 "$STATE_FILE"
  echo "ok: launchd=$STATUS http=$HTTP"
fi
