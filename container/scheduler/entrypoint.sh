#!/bin/sh
# Daily brief scheduler. Runs `npm run brief` once a day at BRIEF_SCHEDULE_TIME (HH:MM, container TZ = Asia/Shanghai, UTC+8).
# Runs in the foreground as PID under tini, so the job inherits the container environment (API keys, TZ).
set -u

TIME="${BRIEF_SCHEDULE_TIME:-09:00}"
LOG=/app/data/logs/scheduler.log
mkdir -p /app/data/logs

trap 'exit 0' TERM INT

while true; do
  now=$(date +%s)
  target=$(date -d "today $TIME" +%s)
  if [ "$target" -le "$now" ]; then
    target=$(date -d "tomorrow $TIME" +%s)
  fi
  echo "[scheduler] next brief at $(date -d "@$target" '+%Y-%m-%d %H:%M %Z')"
  sleep $((target - now)) &
  wait $!
  echo "[scheduler] $(date '+%Y-%m-%d %H:%M %Z') starting brief" >> "$LOG"
  if ! (cd /app && npm run brief) >> "$LOG" 2>&1; then
    echo "[scheduler] brief failed at $(date '+%Y-%m-%d %H:%M %Z')" >> "$LOG"
  fi
done
