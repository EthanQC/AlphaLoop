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

# Round-3 finding F1: TARGET_USER used to default to the literal string
# "abble" - the laptop this repo was written on. On the mini (user
# `qingchang`) `id -u abble` fails, and with `set -e` the installer aborted on
# its third line, so the ONLY script that installs the unattended services
# could not be run there with its documented arguments at all. The default is
# now derived: under `sudo` the operator is SUDO_USER (plain `id -un` would be
# root, which is exactly the wrong answer - the repo checkout, ~/.openclaw
# credentials and the node install all live in the operator's home), otherwise
# it is whoever is running the script.
if [ -z "${TARGET_USER:-}" ]; then
  TARGET_USER="${SUDO_USER:-$(id -un)}"
fi
if [ "${TARGET_USER}" = "root" ]; then
  echo "install-system-daemons: refusing to install daemons that run as root." >&2
  echo "install-system-daemons: run this as 'sudo zsh $0' from the operator's shell," >&2
  echo "install-system-daemons: or pass TARGET_USER=<operator> explicitly." >&2
  exit 1
fi
if ! id -u "${TARGET_USER}" >/dev/null 2>&1; then
  echo "install-system-daemons: no such user '${TARGET_USER}' on this machine." >&2
  echo "install-system-daemons: pass TARGET_USER=<operator> to install for someone else." >&2
  exit 1
fi
# Ask the directory service where that user's home actually is instead of
# assuming /Users/<name>; the fallback keeps the previous behaviour for the
# (rare) case dscl is unavailable.
if [ -z "${TARGET_HOME:-}" ]; then
  TARGET_HOME="$(dscl . -read "/Users/${TARGET_USER}" NFSHomeDirectory 2>/dev/null | awk '{ print $2 }')"
  if [ -z "${TARGET_HOME}" ]; then
    TARGET_HOME="/Users/${TARGET_USER}"
  fi
fi
TARGET_UID="$(id -u "${TARGET_USER}")"
TARGET_GID="$(id -g "${TARGET_USER}")"
NODE_BIN="${TARGET_HOME}/.local/node-v24/bin/node"
OPENCLAW_ENTRY="${TARGET_HOME}/.local/node-v24/lib/node_modules/openclaw/dist/index.js"
PATH_ENV="${TARGET_HOME}/.local/node-v24/bin:${TARGET_HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
OPENCLAW_PROXY_URL="${OPENCLAW_PROXY_URL:-http://127.0.0.1:7897}"
OPENCLAW_NO_PROXY="${OPENCLAW_NO_PROXY:-localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,*.local}"

# Round-3 finding F3: which daemons get HTTP_PROXY/HTTPS_PROXY/... in their
# EnvironmentVariables, decided PER LABEL instead of inherited by everything
# this script happens to render.
#
# Before the ac741d8 promotion this block only ever reached the two labels
# below. The six services that moved here from ~/Library/LaunchAgents
# (platform-app / market-alerts / daily-backup / cron-runner / official-paper
# poll+pnl) came from templates that exported PATH and NOTHING else - see
# apps/openclaw-config/launchd/*.plist.template and the pre-ac741d8
# install-openclaw-cron.mjs / install-user-schedules.mjs - so making them
# inherit the proxy silently changed the egress path of six working services.
#
# Measured on the mini (2026-07-28, read-only). The decisive fact is that ONE
# mihomo process (`verge-mihomo`, pid 1411, spawned by the clash-verge
# privileged helper) serves BOTH paths from one config: that config has
# `tun.enable: true` with `fake-ip-range: 198.18.0.1/16` - matching the
# utun1024 interface at 198.18.0.1 that carries the 1/8, 2/7, 4/6, 8/5 ...
# split default route in `netstat -rn` - AND `mixed-port: 7897`. The TUN and
# the proxy port therefore come up and go down together, which collapses the
# choice into two cases:
#
#   mihomo up   -> TUN already intercepts egress at the network layer, so the
#                  env vars add nothing. `curl --noproxy '*'` and `curl -x
#                  http://127.0.0.1:7897` returned identical status for
#                  news.google.com (302), query1.finance.yahoo.com (429),
#                  finnhub.io (200), open.feishu.cn (404) and
#                  openapi.longportapp.com (404).
#   mihomo down -> 127.0.0.1:7897 is refused AND the TUN route is gone. With
#                  the env vars set, EVERY outbound call fails on connect.
#                  Without them the daemon still reaches the destinations that
#                  are not blocked from this network - which for these six is
#                  the ones they actually use (see below).
#
# So the env var can never help these daemons and can turn a partial outage
# into a total one. launchd offers no ordering between a RunAtLoad daemon and
# whenever mihomo binds 7897, so "boot before mihomo" is a real window.
#
# What the six actually talk to, from the code: daily-backup makes no network
# call at all (backup-trading-data.mjs is a local sqlite copy); market-alerts
# and official-paper poll+pnl reach Longbridge via the local CLI
# (openapi.longportapp.com) and Feishu (open.feishu.cn), both of which the
# curl runs above show reachable without a proxy; platform-app serves a local
# HTTP port; cron-runner talks to the gateway over 127.0.0.1 (which NO_PROXY
# excluded anyway), so the Anthropic-bound traffic exits through the gateway
# process, not through cron-runner. cron-runner's own jobs do fetch
# news.google.com and finnhub.io via stock-analysis.mjs - the one blocked
# destination in the set - and those ride the TUN default route, which is
# present in exactly the case where 7897 would have been too.
#
# The two labels below KEEP the proxy: this is unchanged, currently-running
# behaviour (verified on the mini: /Library/LaunchDaemons/
# ai.openclaw.system.gateway.plist has all eight keys today), and the gateway
# is the one service whose destination (api.anthropic.com) is blocked here.
# broker-executor's own destination is Longbridge, which the curl runs show is
# reachable directly - so by the argument above it is a candidate for `direct`
# too, but it is the order-submission path and that switch needs a live test
# on the mini which this change did not run. Left as-is on purpose.
#
# A deploy machine WITHOUT a transparent proxy can opt more labels in,
# space-separated:
#
#   OPENCLAW_PROXY_LABELS="ai.openclaw.system.gateway com.openclaw.trading.cron-runner" \
#     sudo -E zsh apps/openclaw-config/scripts/install-system-daemons.sh
OPENCLAW_PROXY_LABELS="${OPENCLAW_PROXY_LABELS:-ai.openclaw.system.gateway com.openclaw.system.trading.broker-executor}"
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
# TMP_DIR is deliberately NOT created here: the PRINT_CONFIG_ONLY preflight and
# the "needs root" refusal below both exit before it, and both promise to leave
# nothing behind. `mktemp -d` on this line would have made that promise false.

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

daemon_uses_proxy() {
  # POSIX membership test rather than word-splitting a variable: this script
  # is run under both zsh (its shebang) and bash (the pnpm alias), and the two
  # disagree about splitting unquoted parameters.
  case " ${OPENCLAW_PROXY_LABELS} " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

# Preflight: print everything this run resolved and stop, WITHOUT creating a
# directory, writing a plist or calling launchctl. Documented in both READMEs
# as the thing to run before the real `sudo` invocation, because every value
# below is derived rather than typed and getting TARGET_USER wrong installs
# eight daemons pointing at a home directory that isn't yours.
if [ -n "${PRINT_CONFIG_ONLY:-}" ]; then
  echo "target_user=${TARGET_USER}"
  echo "target_home=${TARGET_HOME}"
  echo "repo_root=${REPO_ROOT}"
  echo "system_dir=${SYSTEM_DIR}"
  echo "pnpm_bin=${PNPM_BIN}"
  echo "gateway_port=${GATEWAY_PORT}"
  echo "proxy_url=${OPENCLAW_PROXY_URL}"
  echo "proxy_labels=${OPENCLAW_PROXY_LABELS}"
  if [ "$(id -u)" -eq 0 ]; then
    echo "running_as_root=yes"
  else
    echo "running_as_root=no"
  fi
  exit 0
fi

# /Library/LaunchDaemons is root-owned, and so is the system launchd domain
# this script bootstraps into. Failing here with the exact command to re-run
# beats failing halfway through with a bare "Permission denied" after some of
# the plists have already been replaced. SYSTEM_DIR being overridden means a
# test harness (or a dry run into a scratch directory), where root is neither
# needed nor wanted.
if [ "${SYSTEM_DIR}" = "/Library/LaunchDaemons" ] && [ "$(id -u)" -ne 0 ]; then
  echo "install-system-daemons: writing ${SYSTEM_DIR} and bootstrapping the system launchd domain needs root." >&2
  echo "install-system-daemons: re-run as: sudo zsh $0" >&2
  echo "install-system-daemons: (the daemons themselves still run as ${TARGET_USER}, via UserName in each plist)." >&2
  exit 1
fi

# Past this point the script does write. The staging directory is created here
# rather than at the top so the two exits above leave the machine untouched,
# and the trap removes it on every path out - including the manifest-drift
# abort below, which used to leak one directory per failed run.
# An explicit template rather than a bare `mktemp -d`: BSD mktemp ignores
# TMPDIR unless it is given one (it goes to the opaque /var/folders/.../T),
# which both hides the staging directory from an operator debugging a failed
# run and makes "the preflight creates nothing" untestable.
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/install-system-daemons.XXXXXX")"
trap 'rm -rf "${TMP_DIR}"' EXIT

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
  local label_xml command_xml stdout_xml stderr_xml repo_root_xml target_user_xml target_home_xml path_env_xml proxy_url_xml no_proxy_xml proxy_xml

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

  # Finding F3: the proxy block is emitted only for the labels named in
  # OPENCLAW_PROXY_LABELS (see its declaration above for why, and for the
  # measurements behind the default). Deriving it from the label here rather
  # than from a per-call-site argument means a daemon added below cannot
  # accidentally inherit - or accidentally lose - the wrong egress path.
  proxy_xml=""
  if daemon_uses_proxy "${label}"; then
    proxy_xml="      <key>HTTP_PROXY</key>
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
"
  fi

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
${proxy_xml}    </dict>
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

echo "Installed system daemons under ${SYSTEM_DIR} (running as ${TARGET_USER}):"
while IFS= read -r installed_label; do
  [ -n "${installed_label}" ] || continue
  if daemon_uses_proxy "${installed_label}"; then
    echo "  ${installed_label}  egress=proxy(${OPENCLAW_PROXY_URL})"
  else
    echo "  ${installed_label}  egress=direct"
  fi
done <<EOF
${EXPECTED_SYSTEM_LABELS}
EOF
echo "Backed up user launch agents under ${BACKUP_DIR}"
