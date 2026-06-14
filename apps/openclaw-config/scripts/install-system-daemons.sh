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
OPENCLAW_PROXY_URL="${OPENCLAW_PROXY_URL:-http://127.0.0.1:7897}"
OPENCLAW_NO_PROXY="${OPENCLAW_NO_PROXY:-localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,*.local}"
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

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  printf "%s" "${value}"
}

write_plist() {
  local plist_path="$1"
  local label="$2"
  local command="$3"
  local stdout_path="$4"
  local stderr_path="$5"
  local label_xml command_xml stdout_xml stderr_xml repo_root_xml target_user_xml target_home_xml path_env_xml proxy_url_xml no_proxy_xml

  label_xml="$(xml_escape "${label}")"
  command_xml="$(xml_escape "${command}")"
  stdout_xml="$(xml_escape "${stdout_path}")"
  stderr_xml="$(xml_escape "${stderr_path}")"
  repo_root_xml="$(xml_escape "${REPO_ROOT}")"
  target_user_xml="$(xml_escape "${TARGET_USER}")"
  target_home_xml="$(xml_escape "${TARGET_HOME}")"
  path_env_xml="$(xml_escape "${PATH_ENV}")"
  proxy_url_xml="$(xml_escape "${OPENCLAW_PROXY_URL}")"
  no_proxy_xml="$(xml_escape "${OPENCLAW_NO_PROXY}")"

  cat > "${plist_path}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${label_xml}</string>
    <key>UserName</key>
    <string>${target_user_xml}</string>
    <key>GroupName</key>
    <string>staff</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>${repo_root_xml}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>HOME</key>
      <string>${target_home_xml}</string>
      <key>PATH</key>
      <string>${path_env_xml}</string>
      <key>HTTP_PROXY</key>
      <string>${proxy_url_xml}</string>
      <key>HTTPS_PROXY</key>
      <string>${proxy_url_xml}</string>
      <key>ALL_PROXY</key>
      <string>${proxy_url_xml}</string>
      <key>http_proxy</key>
      <string>${proxy_url_xml}</string>
      <key>https_proxy</key>
      <string>${proxy_url_xml}</string>
      <key>all_proxy</key>
      <string>${proxy_url_xml}</string>
      <key>NO_PROXY</key>
      <string>${no_proxy_xml}</string>
      <key>no_proxy</key>
      <string>${no_proxy_xml}</string>
    </dict>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/zsh</string>
      <string>-lc</string>
      <string>${command_xml}</string>
    </array>
    <key>StandardOutPath</key>
    <string>${stdout_xml}</string>
    <key>StandardErrorPath</key>
    <string>${stderr_xml}</string>
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
  "${TMP_DIR}/com.openclaw.system.trading.broker-executor.plist" \
  "com.openclaw.system.trading.broker-executor" \
  "export PATH='${PATH_ENV}'; export HOME='${TARGET_HOME}'; cd '${REPO_ROOT}' && exec pnpm --filter @apps/broker-executor start" \
  "${LOG_DIR}/broker-executor.system.log" \
  "${LOG_DIR}/broker-executor.system.err.log"

mkdir -p "${SYSTEM_DIR}"

for plist in "${TMP_DIR}"/*.plist; do
  install -m 644 -o root -g wheel "${plist}" "${SYSTEM_DIR}/$(basename "${plist}")"
done

for retired_label in \
  com.openclaw.system.trading.event-bus \
  com.openclaw.system.trading.event-ingestor \
  com.openclaw.system.trading.live-advisor \
  com.openclaw.system.trading.options-shadow \
  com.openclaw.system.trading.paper-trader; do
  launchctl bootout "system/${retired_label}" >/dev/null 2>&1 || true
  launchctl disable "system/${retired_label}" >/dev/null 2>&1 || true
  rm -f "${SYSTEM_DIR}/${retired_label}.plist"
done

for system_plist in \
  "${SYSTEM_DIR}/ai.openclaw.system.gateway.plist" \
  "${SYSTEM_DIR}/com.openclaw.system.trading.broker-executor.plist"; do
  system_label="$(basename "${system_plist}" .plist)"
  launchctl bootout "system/${system_label}" >/dev/null 2>&1 || true
  for attempt in {1..20}; do
    if ! launchctl print "system/${system_label}" >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
  done
  sleep 2
  launchctl bootstrap system "${system_plist}"
  launchctl enable "system/${system_label}"
  launchctl kickstart -k "system/${system_label}"
done

for user_label in \
  ai.openclaw.gateway \
  com.openclaw.trading.broker-executor; do
  launchctl bootout "gui/${TARGET_UID}/${user_label}" >/dev/null 2>&1 || true
done

for user_plist in \
  "${TARGET_HOME}/Library/LaunchAgents/ai.openclaw.gateway.plist" \
  "${TARGET_HOME}/Library/LaunchAgents/com.openclaw.trading.broker-executor.plist"; do
  if [ -f "${user_plist}" ]; then
    mv "${user_plist}" "${BACKUP_DIR}/"
  fi
done

echo "Installed system daemons under ${SYSTEM_DIR}"
echo "Backed up user launch agents under ${BACKUP_DIR}"
