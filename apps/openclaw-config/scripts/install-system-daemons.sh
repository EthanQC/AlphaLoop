#!/bin/zsh
set -euo pipefail

# Task 9 (2026-07-28 spec-drift remediation): this script is now the SINGLE
# owner of every unattended AlphaLoop service. platform-app, cron-runner,
# market-alerts, daily-backup and the two official-paper jobs used to be
# user-level LaunchAgents, which launchd only bootstraps once a GUI login
# session exists - a reboot that stopped at the login window left them all
# down. They are LaunchDaemons here, with an explicit UserName so they still
# run as the operator (repo checkout, ~/.openclaw credentials, node install
# all live in that user's home) while being bootstrapped at boot with no
# session at all. See install-launchd-ownership.txt for the label->owner
# manifest this script is checked against at run time.

SCRIPT_DIR="${SCRIPT_DIR:-$(cd "$(dirname "$0")" && pwd)}"
REPO_ROOT="${REPO_ROOT:-$(cd "${SCRIPT_DIR}/../../.." && pwd)}"
TARGET_USER="${TARGET_USER:-abble}"
TARGET_HOME="${TARGET_HOME:-/Users/${TARGET_USER}}"
TARGET_UID="$(id -u "${TARGET_USER}")"
TARGET_GID="$(id -g "${TARGET_USER}")"
NODE_BIN="${TARGET_HOME}/.local/node-v24/bin/node"
OPENCLAW_ENTRY="${TARGET_HOME}/.local/node-v24/lib/node_modules/openclaw/dist/index.js"
PATH_ENV="${TARGET_HOME}/.local/node-v24/bin:${TARGET_HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
OPENCLAW_PROXY_URL="${OPENCLAW_PROXY_URL:-http://127.0.0.1:7897}"
OPENCLAW_NO_PROXY="${OPENCLAW_NO_PROXY:-localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,*.local}"
# `|| true` (and 2>/dev/null): with `set -euo pipefail` a missing .env.local
# made awk fail the whole assignment and abort the installer on line 1 - a
# fresh checkout could not run this script at all. The 18789 fallback below
# is the documented default port, not an invented value.
GATEWAY_PORT="${GATEWAY_PORT:-$(awk -F= '/^OPENCLAW_GATEWAY_PORT=/{print $2}' "${REPO_ROOT}/.env.local" 2>/dev/null | tail -n 1 || true)}"
if [ -z "${GATEWAY_PORT}" ]; then
  GATEWAY_PORT="18789"
fi

# Test seam: the suite points these at throwaway directories and a stub
# launchctl so the real installer runs end to end without ever writing to the
# real /Library/LaunchDaemons or touching the real launchd job table.
LAUNCHCTL="${LAUNCHCTL:-launchctl}"
SYSTEM_DIR="${SYSTEM_DIR:-/Library/LaunchDaemons}"
BOOTSTRAP_SETTLE_SECONDS="${BOOTSTRAP_SETTLE_SECONDS:-2}"
OWNERSHIP_FILE="${OWNERSHIP_FILE:-${SCRIPT_DIR}/install-launchd-ownership.txt}"

LOG_DIR="${TARGET_HOME}/.openclaw/system-logs"
OPENCLAW_LOG_DIR="${TARGET_HOME}/.openclaw/logs"
# The migrated jobs keep the exact log paths their LaunchAgent plists used, so
# an operator tailing logs/market-alerts.err.log (and every doc that names it)
# still points at the live file after the promotion.
REPO_LOG_DIR="${REPO_ROOT}/logs"
RUNTIME_LAUNCHD_DIR="${REPO_ROOT}/runtime/launchd"
AGENTS_DIR="${TARGET_HOME}/Library/LaunchAgents"
BACKUP_DIR="${TARGET_HOME}/Library/LaunchAgents.disabled/openclaw-system-backup-$(date +%Y%m%d%H%M%S)"
TMP_DIR="$(mktemp -d)"

if [ ! -f "${OWNERSHIP_FILE}" ]; then
  echo "install-system-daemons: ownership manifest not found at ${OWNERSHIP_FILE}" >&2
  exit 1
fi

# openclaw-cron-runner.mjs reads PNPM_BIN to spawn `pnpm ...` for each cron
# job. Resolve it at install time and fail loudly if it cannot be found -
# pinning a path that does not exist would produce a daemon that boots fine
# and then fails every single job with ENOENT.
if [ -z "${PNPM_BIN:-}" ]; then
  if [ -x "${TARGET_HOME}/.local/node-v24/bin/pnpm" ]; then
    PNPM_BIN="${TARGET_HOME}/.local/node-v24/bin/pnpm"
  else
    PNPM_BIN="$(PATH="${PATH_ENV}" command -v pnpm 2>/dev/null || true)"
  fi
fi
if [ -z "${PNPM_BIN}" ]; then
  echo "install-system-daemons: cannot resolve a pnpm binary under ${PATH_ENV}." >&2
  echo "install-system-daemons: install pnpm for ${TARGET_USER} or pass PNPM_BIN=/path/to/pnpm." >&2
  exit 1
fi

mkdir -p "${LOG_DIR}" "${OPENCLAW_LOG_DIR}" "${BACKUP_DIR}" "${AGENTS_DIR}" "${REPO_LOG_DIR}" "${RUNTIME_LAUNCHD_DIR}"
# Only root can hand these to another user; when the operator runs this
# unprivileged (or under the test harness) the directories are already theirs.
if [ "$(id -u)" -eq 0 ]; then
  chown -R "${TARGET_USER}:${TARGET_GID}" \
    "${LOG_DIR}" "${OPENCLAW_LOG_DIR}" "${BACKUP_DIR}" "${REPO_LOG_DIR}" "${RUNTIME_LAUNCHD_DIR}"
fi

manifest_labels() {
  awk -v want="$1" '/^[[:space:]]*#/ { next } $1 == want { print $2 }' "${OWNERSHIP_FILE}"
}

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  printf "%s" "${value}"
}

# `keep_alive` is "true" for the long-running services and "false" for the
# scheduled ones (a KeepAlive=true job with a StartInterval would be relaunched
# the instant it exits, i.e. a busy loop). `schedule_xml` carries the
# StartInterval / StartCalendarInterval block verbatim, or is empty.
# RunAtLoad is unconditionally true: that is what makes a daemon come back on
# its own after a reboot, which is the entire point of this script.
write_plist() {
  local plist_path="$1"
  local label="$2"
  local command="$3"
  local stdout_path="$4"
  local stderr_path="$5"
  local keep_alive="$6"
  local schedule_xml="${7:-}"
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
    <${keep_alive}/>
${schedule_xml}
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

COMMON_ENV="export PATH='${PATH_ENV}'; export HOME='${TARGET_HOME}';"

SCHEDULE_MARKET_ALERTS='    <key>StartInterval</key>
    <integer>300</integer>'
SCHEDULE_DAILY_BACKUP='    <key>StartCalendarInterval</key>
    <dict>
      <key>Hour</key>
      <integer>5</integer>
      <key>Minute</key>
      <integer>30</integer>
    </dict>'
SCHEDULE_OFFICIAL_PAPER_POLL='    <key>StartCalendarInterval</key>
    <dict>
      <key>Minute</key>
      <integer>30</integer>
    </dict>'
SCHEDULE_OFFICIAL_PAPER_PNL='    <key>StartCalendarInterval</key>
    <dict>
      <key>Minute</key>
      <integer>0</integer>
    </dict>'

write_plist \
  "${TMP_DIR}/ai.openclaw.system.gateway.plist" \
  "ai.openclaw.system.gateway" \
  "${COMMON_ENV} exec '${NODE_BIN}' '${OPENCLAW_ENTRY}' gateway --port ${GATEWAY_PORT}" \
  "${OPENCLAW_LOG_DIR}/gateway.system.log" \
  "${OPENCLAW_LOG_DIR}/gateway.system.err.log" \
  "true"

write_plist \
  "${TMP_DIR}/com.openclaw.system.trading.broker-executor.plist" \
  "com.openclaw.system.trading.broker-executor" \
  "${COMMON_ENV} cd '${REPO_ROOT}' && exec pnpm --filter @apps/broker-executor start" \
  "${LOG_DIR}/broker-executor.system.log" \
  "${LOG_DIR}/broker-executor.system.err.log" \
  "true"

# Promoted from com.alphaloop.platform-app.plist.template (command and log
# paths carried over verbatim).
write_plist \
  "${TMP_DIR}/com.alphaloop.platform-app.plist" \
  "com.alphaloop.platform-app" \
  "${COMMON_ENV} cd '${REPO_ROOT}' && exec pnpm --filter @apps/platform-app start" \
  "${REPO_LOG_DIR}/platform-app.log" \
  "${REPO_LOG_DIR}/platform-app.err.log" \
  "true"

# Promoted from install-openclaw-cron.mjs's installCronRunnerService(). That
# installer still owns the `openclaw cron add` jobs (they need the operator's
# own gateway session and ~/.openclaw config); only the long-running runner
# service moved here.
write_plist \
  "${TMP_DIR}/com.openclaw.trading.cron-runner.plist" \
  "com.openclaw.trading.cron-runner" \
  "${COMMON_ENV} export PNPM_BIN='${PNPM_BIN}'; cd '${REPO_ROOT}' && exec '${NODE_BIN}' '${REPO_ROOT}/apps/openclaw-config/scripts/openclaw-cron-runner.mjs'" \
  "${RUNTIME_LAUNCHD_DIR}/com.openclaw.trading.cron-runner.out.log" \
  "${RUNTIME_LAUNCHD_DIR}/com.openclaw.trading.cron-runner.err.log" \
  "true"

# Promoted from com.alphaloop.market-alerts.plist.template. KeepAlive=false:
# every tick is a one-shot `pnpm alerts:poll`, StartInterval is what re-runs it.
write_plist \
  "${TMP_DIR}/com.alphaloop.market-alerts.plist" \
  "com.alphaloop.market-alerts" \
  "${COMMON_ENV} cd '${REPO_ROOT}' && exec pnpm alerts:poll" \
  "${REPO_LOG_DIR}/market-alerts.log" \
  "${REPO_LOG_DIR}/market-alerts.err.log" \
  "false" \
  "${SCHEDULE_MARKET_ALERTS}"

# Promoted from com.alphaloop.daily-backup.plist.template. The template had
# RunAtLoad=false; as a daemon it is true (see write_plist), which means one
# extra backup runs right after a reboot. That is harmless-to-useful: a backup
# taken after an unclean shutdown is exactly when you want one.
write_plist \
  "${TMP_DIR}/com.alphaloop.daily-backup.plist" \
  "com.alphaloop.daily-backup" \
  "${COMMON_ENV} cd '${REPO_ROOT}' && exec pnpm backup:daily" \
  "${REPO_LOG_DIR}/daily-backup.log" \
  "${REPO_LOG_DIR}/daily-backup.err.log" \
  "false" \
  "${SCHEDULE_DAILY_BACKUP}"

# Promoted from install-user-schedules.mjs's two jobs (hourly at :30 / :00).
write_plist \
  "${TMP_DIR}/com.openclaw.trading.official-paper.poll.plist" \
  "com.openclaw.trading.official-paper.poll" \
  "${COMMON_ENV} cd '${REPO_ROOT}' && exec '${NODE_BIN}' '${REPO_ROOT}/apps/openclaw-config/scripts/official-paper-monitor.mjs' poll" \
  "${RUNTIME_LAUNCHD_DIR}/com.openclaw.trading.official-paper.poll.out.log" \
  "${RUNTIME_LAUNCHD_DIR}/com.openclaw.trading.official-paper.poll.err.log" \
  "false" \
  "${SCHEDULE_OFFICIAL_PAPER_POLL}"

write_plist \
  "${TMP_DIR}/com.openclaw.trading.official-paper.pnl.plist" \
  "com.openclaw.trading.official-paper.pnl" \
  "${COMMON_ENV} cd '${REPO_ROOT}' && exec '${NODE_BIN}' '${REPO_ROOT}/apps/openclaw-config/scripts/official-paper-monitor.mjs' pnl" \
  "${RUNTIME_LAUNCHD_DIR}/com.openclaw.trading.official-paper.pnl.out.log" \
  "${RUNTIME_LAUNCHD_DIR}/com.openclaw.trading.official-paper.pnl.err.log" \
  "false" \
  "${SCHEDULE_OFFICIAL_PAPER_PNL}"

# The manifest is authoritative at RUN time, not just in tests: if a daemon is
# added above without a "system" row (or a row is added without a daemon), the
# installer refuses to touch /Library/LaunchDaemons at all rather than leaving
# the other installers' skip lists silently out of date.
EXPECTED_SYSTEM_LABELS="$(manifest_labels system | sort)"
ACTUAL_SYSTEM_LABELS="$(for plist in "${TMP_DIR}"/*.plist; do basename "${plist}" .plist; done | sort)"
if [ "${EXPECTED_SYSTEM_LABELS}" != "${ACTUAL_SYSTEM_LABELS}" ]; then
  echo "install-system-daemons: rendered daemons do not match the 'system' rows of ${OWNERSHIP_FILE}" >&2
  echo "manifest: ${EXPECTED_SYSTEM_LABELS}" >&2
  echo "rendered: ${ACTUAL_SYSTEM_LABELS}" >&2
  exit 1
fi

mkdir -p "${SYSTEM_DIR}"

for plist in "${TMP_DIR}"/*.plist; do
  if [ "$(id -u)" -eq 0 ]; then
    install -m 644 -o root -g wheel "${plist}" "${SYSTEM_DIR}/$(basename "${plist}")"
  else
    install -m 644 "${plist}" "${SYSTEM_DIR}/$(basename "${plist}")"
  fi
done

for retired_label in \
  com.openclaw.system.trading.event-bus \
  com.openclaw.system.trading.event-ingestor \
  com.openclaw.system.trading.live-advisor \
  com.openclaw.system.trading.options-shadow \
  com.openclaw.system.trading.paper-trader; do
  "${LAUNCHCTL}" bootout "system/${retired_label}" >/dev/null 2>&1 || true
  "${LAUNCHCTL}" disable "system/${retired_label}" >/dev/null 2>&1 || true
  rm -f "${SYSTEM_DIR}/${retired_label}.plist"
done

# Retire the user-level copy of every label this script now owns, plus the
# labels nobody may own, BEFORE bootstrapping the daemons - otherwise a
# leftover LaunchAgent and the new LaunchDaemon would both be live for the
# window in between, which for broker-executor / cron-runner means two
# processes writing the same trading database.
while IFS= read -r label; do
  [ -n "${label}" ] || continue
  "${LAUNCHCTL}" bootout "gui/${TARGET_UID}/${label}" >/dev/null 2>&1 || true
  agent_plist="${AGENTS_DIR}/${label}.plist"
  if [ -f "${agent_plist}" ]; then
    mv "${agent_plist}" "${BACKUP_DIR}/"
    echo "Retired user LaunchAgent ${label} -> ${BACKUP_DIR}"
  fi
done <<EOF
$(manifest_labels system; manifest_labels retired)
EOF

# ai.openclaw.gateway is installed by the `openclaw` CLI, not by this repo
# (see install-launchd-ownership.txt's "external" rows). Booting it out here
# is unchanged pre-existing behaviour: ai.openclaw.system.gateway supersedes
# it and they would otherwise fight over the same port.
"${LAUNCHCTL}" bootout "gui/${TARGET_UID}/ai.openclaw.gateway" >/dev/null 2>&1 || true
if [ -f "${AGENTS_DIR}/ai.openclaw.gateway.plist" ]; then
  mv "${AGENTS_DIR}/ai.openclaw.gateway.plist" "${BACKUP_DIR}/"
fi

while IFS= read -r system_label; do
  [ -n "${system_label}" ] || continue
  system_plist="${SYSTEM_DIR}/${system_label}.plist"
  "${LAUNCHCTL}" bootout "system/${system_label}" >/dev/null 2>&1 || true
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if ! "${LAUNCHCTL}" print "system/${system_label}" >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
  done
  sleep "${BOOTSTRAP_SETTLE_SECONDS}"
  "${LAUNCHCTL}" bootstrap system "${system_plist}"
  "${LAUNCHCTL}" enable "system/${system_label}"
  "${LAUNCHCTL}" kickstart -k "system/${system_label}"
done <<EOF
${EXPECTED_SYSTEM_LABELS}
EOF

rm -rf "${TMP_DIR}"

echo "Installed system daemons under ${SYSTEM_DIR}:"
echo "${EXPECTED_SYSTEM_LABELS}"
echo "Backed up user launch agents under ${BACKUP_DIR}"
