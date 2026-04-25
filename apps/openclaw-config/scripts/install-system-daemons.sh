#!/bin/zsh
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../../.." && pwd)}"
TARGET_USER="${TARGET_USER:-mashu}"
TARGET_HOME="${TARGET_HOME:-/Users/${TARGET_USER}}"
TARGET_UID="$(id -u "${TARGET_USER}")"
TARGET_GID="$(id -g "${TARGET_USER}")"
NODE_BIN="${TARGET_HOME}/.local/node-v24/bin/node"
OPENCLAW_ENTRY="${TARGET_HOME}/.local/node-v24/lib/node_modules/openclaw/dist/index.js"
PATH_ENV="${TARGET_HOME}/.local/node-v24/bin:${TARGET_HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
GATEWAY_PORT="${GATEWAY_PORT:-$(awk -F= '/^OPENCLAW_GATEWAY_PORT=/{print $2}' "${REPO_ROOT}/.env.local" | tail -n 1)}"
if [ -z "${GATEWAY_PORT}" ]; then
  GATEWAY_PORT="18789"
fi

LOG_DIR="${TARGET_HOME}/.openclaw/system-logs"
OPENCLAW_LOG_DIR="${TARGET_HOME}/.openclaw/logs"
SYSTEM_DIR="/Library/LaunchDaemons"
BACKUP_DIR="${TARGET_HOME}/Library/LaunchAgents.disabled/openclaw-system-backup-$(date +%Y%m%d%H%M%S)"
TMP_DIR="$(mktemp -d)"

mkdir -p "${LOG_DIR}" "${OPENCLAW_LOG_DIR}" "${BACKUP_DIR}"
chown -R "${TARGET_USER}:staff" "${LOG_DIR}" "${OPENCLAW_LOG_DIR}" "${BACKUP_DIR}"

write_plist() {
  local plist_path="$1"
  local label="$2"
  local command="$3"
  local stdout_path="$4"
  local stderr_path="$5"

  cat > "${plist_path}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${label}</string>
    <key>UserName</key>
    <string>${TARGET_USER}</string>
    <key>GroupName</key>
    <string>staff</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>${REPO_ROOT}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>HOME</key>
      <string>${TARGET_HOME}</string>
      <key>PATH</key>
      <string>${PATH_ENV}</string>
    </dict>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/zsh</string>
      <string>-lc</string>
      <string>${command}</string>
    </array>
    <key>StandardOutPath</key>
    <string>${stdout_path}</string>
    <key>StandardErrorPath</key>
    <string>${stderr_path}</string>
  </dict>
</plist>
EOF
}

write_plist \
  "${TMP_DIR}/ai.openclaw.system.gateway.plist" \
  "ai.openclaw.system.gateway" \
  "export PATH='${PATH_ENV}'; export HOME='${TARGET_HOME}'; exec '${NODE_BIN}' '${OPENCLAW_ENTRY}' gateway --port ${GATEWAY_PORT}" \
  "${OPENCLAW_LOG_DIR}/gateway.system.log" \
  "${OPENCLAW_LOG_DIR}/gateway.system.err.log"

write_plist \
  "${TMP_DIR}/com.openclaw.system.trading.event-bus.plist" \
  "com.openclaw.system.trading.event-bus" \
  "export PATH='${PATH_ENV}'; export HOME='${TARGET_HOME}'; cd '${REPO_ROOT}' && exec pnpm --filter @apps/event-bus start" \
  "${LOG_DIR}/event-bus.system.log" \
  "${LOG_DIR}/event-bus.system.err.log"

write_plist \
  "${TMP_DIR}/com.openclaw.system.trading.event-ingestor.plist" \
  "com.openclaw.system.trading.event-ingestor" \
  "export PATH='${PATH_ENV}'; export HOME='${TARGET_HOME}'; cd '${REPO_ROOT}' && exec pnpm --filter @apps/event-ingestor start" \
  "${LOG_DIR}/event-ingestor.system.log" \
  "${LOG_DIR}/event-ingestor.system.err.log"

write_plist \
  "${TMP_DIR}/com.openclaw.system.trading.broker-executor.plist" \
  "com.openclaw.system.trading.broker-executor" \
  "export PATH='${PATH_ENV}'; export HOME='${TARGET_HOME}'; cd '${REPO_ROOT}' && exec pnpm --filter @apps/broker-executor start" \
  "${LOG_DIR}/broker-executor.system.log" \
  "${LOG_DIR}/broker-executor.system.err.log"

write_plist \
  "${TMP_DIR}/com.openclaw.system.trading.live-advisor.plist" \
  "com.openclaw.system.trading.live-advisor" \
  "export PATH='${PATH_ENV}'; export HOME='${TARGET_HOME}'; cd '${REPO_ROOT}' && exec pnpm --filter @apps/live-advisor start" \
  "${LOG_DIR}/live-advisor.system.log" \
  "${LOG_DIR}/live-advisor.system.err.log"

write_plist \
  "${TMP_DIR}/com.openclaw.system.trading.paper-trader.plist" \
  "com.openclaw.system.trading.paper-trader" \
  "export PATH='${PATH_ENV}'; export HOME='${TARGET_HOME}'; cd '${REPO_ROOT}' && exec pnpm --filter @apps/paper-trader start" \
  "${LOG_DIR}/paper-trader.system.log" \
  "${LOG_DIR}/paper-trader.system.err.log"

mkdir -p "${SYSTEM_DIR}"

for plist in "${TMP_DIR}"/*.plist; do
  install -m 644 -o root -g wheel "${plist}" "${SYSTEM_DIR}/$(basename "${plist}")"
done

for system_plist in \
  "${SYSTEM_DIR}/ai.openclaw.system.gateway.plist" \
  "${SYSTEM_DIR}/com.openclaw.system.trading.event-bus.plist" \
  "${SYSTEM_DIR}/com.openclaw.system.trading.event-ingestor.plist" \
  "${SYSTEM_DIR}/com.openclaw.system.trading.broker-executor.plist" \
  "${SYSTEM_DIR}/com.openclaw.system.trading.live-advisor.plist" \
  "${SYSTEM_DIR}/com.openclaw.system.trading.paper-trader.plist"; do
  launchctl bootout system "$(basename "${system_plist}" .plist)" >/dev/null 2>&1 || true
  launchctl bootstrap system "${system_plist}"
  launchctl enable "system/$(basename "${system_plist}" .plist)"
  launchctl kickstart -k "system/$(basename "${system_plist}" .plist)"
done

for user_label in \
  ai.openclaw.gateway \
  com.openclaw.trading.event-bus \
  com.openclaw.trading.event-ingestor \
  com.openclaw.trading.broker-executor \
  com.openclaw.trading.live-advisor \
  com.openclaw.trading.paper-trader; do
  launchctl bootout "gui/${TARGET_UID}/${user_label}" >/dev/null 2>&1 || true
done

for user_plist in \
  "${TARGET_HOME}/Library/LaunchAgents/ai.openclaw.gateway.plist" \
  "${TARGET_HOME}/Library/LaunchAgents/com.openclaw.trading.event-bus.plist" \
  "${TARGET_HOME}/Library/LaunchAgents/com.openclaw.trading.event-ingestor.plist" \
  "${TARGET_HOME}/Library/LaunchAgents/com.openclaw.trading.broker-executor.plist" \
  "${TARGET_HOME}/Library/LaunchAgents/com.openclaw.trading.live-advisor.plist" \
  "${TARGET_HOME}/Library/LaunchAgents/com.openclaw.trading.paper-trader.plist"; do
  if [ -f "${user_plist}" ]; then
    mv "${user_plist}" "${BACKUP_DIR}/"
  fi
done

echo "Installed system daemons under ${SYSTEM_DIR}"
echo "Backed up user launch agents under ${BACKUP_DIR}"
