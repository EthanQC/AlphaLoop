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
# Overridable for the same reason PNPM_BIN is: this path is BAKED INTO three
# plists (gateway, cron-runner, official-paper poll+pnl), so a machine whose
# node lives elsewhere would get three daemons that bootstrap fine and then
# fail with ENOENT forever. Round 6 also runs it (see verify_daemon below), so
# it has to be a real node, not a name that happens to be there.
NODE_BIN="${NODE_BIN:-${TARGET_HOME}/.local/node-v24/bin/node}"
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
# Round-6 finding S3e: how long a daemon has to stay alive after bootstrap
# before this script is willing to call the handover done and archive the old
# user-level copy. See verify_daemon() for exactly what that does and does not
# prove.
VERIFY_SETTLE_SECONDS="${VERIFY_SETTLE_SECONDS:-3}"
OWNERSHIP_FILE="${OWNERSHIP_FILE:-${SCRIPT_DIR}/install-launchd-ownership.txt}"
HEALTH_CHECKER="${HEALTH_CHECKER:-${SCRIPT_DIR}/launchd-health.mjs}"
DEPLOY_LEDGER="${DEPLOY_LEDGER:-${SCRIPT_DIR}/deploy-ledger.mjs}"
DEPLOY_RUNTIME_ROOT="${DEPLOY_RUNTIME_ROOT:-${REPO_ROOT}/runtime}"
DEPLOY_ATTEMPT_ID="${DEPLOY_ATTEMPT_ID:-install-system-daemons-$(date +%Y%m%d-%H%M%S)-$$}"
INSTALL_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

LOG_DIR="${TARGET_HOME}/.openclaw/system-logs"
OPENCLAW_LOG_DIR="${TARGET_HOME}/.openclaw/logs"
# The migrated jobs keep the exact log paths their LaunchAgent plists used, so
# an operator tailing logs/market-alerts.err.log (and every doc that names it)
# still points at the live file after the promotion.
REPO_LOG_DIR="${REPO_ROOT}/logs"
RUNTIME_LAUNCHD_DIR="${REPO_ROOT}/runtime/launchd"
AGENTS_DIR="${TARGET_HOME}/Library/LaunchAgents"
# Finding M7: BACKUP_DIR is only a NAME here. It used to be `mkdir -p`'d
# unconditionally alongside the log directories below, which meant every run
# after the migration - when there is by definition nothing left to retire -
# left one more empty `openclaw-system-backup-<ts>` directory behind forever.
# ensure_backup_dir() below creates it the first time something is actually
# moved into it, and nothing creates it otherwise.
BACKUP_PARENT="${TARGET_HOME}/Library/LaunchAgents.disabled"
BACKUP_DIR="${BACKUP_PARENT}/openclaw-system-backup-$(date +%Y%m%d%H%M%S)"
# TMP_DIR is deliberately NOT created here: the PRINT_CONFIG_ONLY preflight and
# the "needs root" refusal below both exit before it, and both promise to leave
# nothing behind. `mktemp -d` on this line would have made that promise false.

if [ ! -f "${OWNERSHIP_FILE}" ]; then
  echo "install-system-daemons: ownership manifest not found at ${OWNERSHIP_FILE}" >&2
  exit 1
fi

# Round 6: this script's own exit code becomes a deploy-ledger receipt for
# runbook step 3, so the acceptance gate (step 8) can fail on "step 3 said it
# failed" instead of only on whatever it can still observe minutes later. See
# deploy-ledger.mjs's header for the five confirmed cases that motivated it.
#
# Bookkeeping never changes the outcome: every call here is `|| true`, and a
# ledger that cannot be written is reported by the doctor as a missing receipt
# rather than pretended away.
#
# Not covered: the two refusals above (running as root, TARGET_USER does not
# exist) exit before this point and leave no receipt. They also change nothing
# on the machine, and `deploy.sh` records step 3's exit code itself whichever
# way this script exits.
INSTALL_RESULT_RECORDED=""
record_install_result() {
  [ -z "${PRINT_CONFIG_ONLY:-}" ] || return 0
  [ -z "${INSTALL_RESULT_RECORDED}" ] || return 0
  INSTALL_RESULT_RECORDED=1
  [ -x "${NODE_BIN}" ] || return 0
  [ -f "${DEPLOY_LEDGER}" ] || return 0
  "${NODE_BIN}" "${DEPLOY_LEDGER}" record \
    --runtime-root "${DEPLOY_RUNTIME_ROOT}" \
    --attempt "${DEPLOY_ATTEMPT_ID}" \
    --step 3 \
    --exit "$1" \
    --head "$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo unknown)" \
    --started-at "${INSTALL_STARTED_AT}" \
    --detail "install-system-daemons.sh" >/dev/null 2>&1 || true
  # Under sudo the ledger would end up root-owned inside the operator's own
  # repo, and the next unprivileged step could not append to it - the same
  # class of bug finding D3 fixed for the log directories.
  if [ "$(id -u)" -eq 0 ]; then
    chown -R "${TARGET_USER}:${TARGET_GID}" "${DEPLOY_RUNTIME_ROOT}/deploy" 2>/dev/null || true
  fi
  return 0
}

cleanup_tmp_dir() {
  if [ -n "${TMP_DIR:-}" ]; then
    rm -rf "${TMP_DIR}"
  fi
  return 0
}

on_exit() {
  # Same zsh caveat as verify_daemon's: `status` is read-only there.
  local exit_status=$?
  record_install_result "${exit_status}"
  cleanup_tmp_dir
  return 0
}

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
#
# ⚠ WHAT THIS SCRIPT INTERRUPTS THAT IS NOT OURS (round 6).
#
# The handover loop below boots out and re-bootstraps ai.openclaw.system.gateway
# like any other label. On the deploy target that gateway is not a private
# AlphaLoop service: measured read-only on the mini (2026-07-28/29) it is the
# SOLE listener on 18789 (one node process, on 127.0.0.1 and [::1] both), the
# operator's own ~/.openclaw/openclaw.json configures 185 agents with a
# workspace against that same port, ~/.openclaw/agents holds 187 directories,
# and at the time of writing the gateway process had a live codex session as a
# descendant. Restarting it stops the operator's personal agents too.
#
# Printed in the preflight (below) and again before the handover loop, because
# the whole point of the preflight is that it is what an operator runs BEFORE
# committing to the sudo run.
print_gateway_warning() {
  echo "" >&2
  echo "⚠ 这个脚本会重启 ai.openclaw.system.gateway。" >&2
  echo "  只读实测（mini，2026-07-28/29）：18789 上只有它一个监听进程；操作者自己的" >&2
  echo "  ~/.openclaw/openclaw.json 里配了 185 个带 workspace 的 agent、~/.openclaw/agents" >&2
  echo "  下有 187 个目录，全都由这一个 gateway 提供服务；写这段话时它底下还挂着一个活着的" >&2
  echo "  codex 子进程。也就是说：跑这一步 = 你个人正在跑的 agent 会话会被打断。" >&2
  echo "  跑之前请先确认没有正在跑的会话、把重要结果落盘，并挑一个你自己不用 agent 的时间窗口。" >&2
  echo "" >&2
}

if [ -n "${PRINT_CONFIG_ONLY:-}" ]; then
  print_gateway_warning
  echo "target_user=${TARGET_USER}"
  echo "target_home=${TARGET_HOME}"
  echo "repo_root=${REPO_ROOT}"
  echo "system_dir=${SYSTEM_DIR}"
  echo "pnpm_bin=${PNPM_BIN}"
  echo "node_bin=${NODE_BIN}"
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

# Same rule as PNPM_BIN, and for a stronger reason: NODE_BIN is written into
# three of the eight plists AND is what runs the health check that decides
# whether a service's fallback may be archived. A missing node used to produce
# three daemons that load and then ENOENT on every run; from round 6 it would
# additionally make every verification unrunnable.
if [ ! -x "${NODE_BIN}" ]; then
  echo "install-system-daemons: ${NODE_BIN} is not an executable node." >&2
  echo "install-system-daemons: three of the daemons run node by this exact path, so installing them now" >&2
  echo "install-system-daemons: would produce services that load and then fail every run with ENOENT." >&2
  echo "install-system-daemons: install node there for ${TARGET_USER}, or pass NODE_BIN=/path/to/node." >&2
  exit 1
fi
if [ ! -f "${HEALTH_CHECKER}" ]; then
  echo "install-system-daemons: health checker not found at ${HEALTH_CHECKER}." >&2
  echo "install-system-daemons: without it this script could only prove daemons are REGISTERED, not that they" >&2
  echo "install-system-daemons: are running - which is the exact check finding S3e added. Refusing to run." >&2
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
#
# Round-5 finding D6: `trap ... EXIT` alone did NOT cover "every path out", as
# the previous comment here claimed. Measured on this zsh: sending SIGTERM to a
# run sleeping in the bootstrap settle left the staging directory behind,
# because zsh (like bash) runs the EXIT trap only for exits it reaches - an
# untrapped fatal signal terminates the shell without ever getting there. The
# three signals an operator can actually deliver (^C, `kill`, closing the ssh
# session) are therefore trapped explicitly; each cleans up and then re-raises
# with the conventional 128+signo status so a caller still sees "killed by a
# signal" rather than a fabricated clean exit.
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/install-system-daemons.XXXXXX")"
trap 'on_exit' EXIT
trap 'record_install_result 130; cleanup_tmp_dir; trap - INT; kill -INT $$' INT
trap 'record_install_result 143; cleanup_tmp_dir; exit 143' TERM
trap 'record_install_result 129; cleanup_tmp_dir; exit 129' HUP
trap 'record_install_result 131; cleanup_tmp_dir; exit 131' QUIT

# Round-5 finding D3: `mkdir -p a/b/c` creates a, a/b AND a/b/c, but only the
# five leaf paths below were ever chowned back. Under `sudo` on a machine where
# they do not exist yet - a fresh checkout, or a first install for a different
# TARGET_USER - that left `${TARGET_HOME}/.openclaw` and `${REPO_ROOT}/runtime`
# owned by root:wheel INSIDE the operator's own home and repo, so the operator
# could no longer write their own directories and every unprivileged script
# that touches them (the doctor's runtime probes, backup-trading-data.mjs,
# the cron runner's result files) failed with EACCES.
#
# ensure_dir_owned walks up to the deepest ancestor that already exists,
# records every level this run is about to CREATE, and chowns exactly those
# afterwards. Directories that already existed are never chowned, so this can
# never take ownership of something that was already someone else's.
ensure_dir_owned() {
  local dir="$1"
  local created=""
  local probe="${dir}"
  local parent
  while [ ! -d "${probe}" ]; do
    created="${probe}
${created}"
    parent="$(dirname "${probe}")"
    if [ "${parent}" = "${probe}" ]; then
      break
    fi
    probe="${parent}"
  done
  mkdir -p "${dir}"
  if [ "$(id -u)" -ne 0 ]; then
    return 0
  fi
  while IFS= read -r new_dir; do
    [ -n "${new_dir}" ] || continue
    chown "${TARGET_USER}:${TARGET_GID}" "${new_dir}"
  done <<EOF
${created}
EOF
}

for owned_dir in "${LOG_DIR}" "${OPENCLAW_LOG_DIR}" "${AGENTS_DIR}" "${REPO_LOG_DIR}" "${RUNTIME_LAUNCHD_DIR}"; do
  ensure_dir_owned "${owned_dir}"
done
# Only root can hand these to another user; when the operator runs this
# unprivileged (or under the test harness) the directories are already theirs.
# -R here (unlike the ancestors above) because a previous root-run daemon may
# have left root-owned log FILES inside a directory the operator owns.
if [ "$(id -u)" -eq 0 ]; then
  chown -R "${TARGET_USER}:${TARGET_GID}" \
    "${LOG_DIR}" "${OPENCLAW_LOG_DIR}" "${REPO_LOG_DIR}" "${RUNTIME_LAUNCHD_DIR}"
  # Not -R: AGENTS_DIR also holds the operator's own personal-OpenClaw agents,
  # and this script has no business rewriting the ownership of plists it did
  # not create. ensure_dir_owned already handled the directory itself when this
  # run created it; this covers the case where it existed but as root:wheel
  # from a pre-D3 run of this same script.
  chown "${TARGET_USER}:${TARGET_GID}" "${AGENTS_DIR}"
fi

# Finding M7: `mkdir -p` under sudo creates BOTH the backup directory and its
# parent as root:wheel inside the operator's own home - on the mini
# ~/Library/LaunchAgents.disabled ended up `drwxr-xr-x root staff` inside a
# `drwx------ qingchang` home, so the operator could not clean up their own
# archived agents. The parent is chowned here alongside the directory itself.
#
# Returns non-zero rather than aborting the run when the directory cannot be
# created (measured on the mini: ~/Library/LaunchAgents.disabled is currently
# `drwxr-xr-x root staff`, left by a pre-M7 sudo run, so an unprivileged
# process cannot create anything inside it). archive_user_agent() turns that
# into "the plist stays where it is", which is the only safe answer for a
# label whose plist exists in no other copy.
ensure_backup_dir() {
  if [ -d "${BACKUP_DIR}" ]; then
    return 0
  fi
  mkdir -p "${BACKUP_DIR}" 2>/dev/null || return 1
  if [ "$(id -u)" -eq 0 ]; then
    chown "${TARGET_USER}:${TARGET_GID}" "${BACKUP_PARENT}" "${BACKUP_DIR}"
  fi
}

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

# Labels this script used to install and must now actively destroy. A variable
# rather than an inline list in the loop below so the collision guard can read
# it - and, like LAUNCHCTL / SYSTEM_DIR / OWNERSHIP_FILE above, overridable so
# the suite can drive that guard. A collision cannot be reached through the
# manifest (the drift check below already refuses when the manifest and the
# rendered set disagree), so the only real-world way in is a future edit that
# renames a write_plist call onto one of these labels AND updates the manifest
# to match - which is exactly the case the guard exists for, and exactly the
# case no test can construct without this seam.
OBSOLETE_SYSTEM_LABELS="${OBSOLETE_SYSTEM_LABELS:-com.openclaw.system.trading.event-bus
com.openclaw.system.trading.event-ingestor
com.openclaw.system.trading.live-advisor
com.openclaw.system.trading.options-shadow
com.openclaw.system.trading.paper-trader}"

# Finding C3, first half: the retire loop below runs `launchctl disable
# system/<label>` and `rm -f "${SYSTEM_DIR}/<label>.plist"`. launchd's
# disabled-services database survives reboots AND plist reinstalls, and
# bootstrap/kickstart on a disabled label fail - so if a daemon rendered above
# were ever renamed onto one of these five labels, this script would delete the
# plist it had just installed, disable the label, and then fail to bootstrap it
# on this run and on every re-run forever. Refuse before touching anything.
while IFS= read -r obsolete_label; do
  [ -n "${obsolete_label}" ] || continue
  if printf "%s\n" "${EXPECTED_SYSTEM_LABELS}" | grep -qxF "${obsolete_label}"; then
    echo "install-system-daemons: ${obsolete_label} is BOTH rendered as a daemon above and listed as obsolete." >&2
    echo "install-system-daemons: the retire step would delete the plist this run just installed and leave the" >&2
    echo "install-system-daemons: label in launchd's disabled database, which survives reboots and reinstalls." >&2
    echo "install-system-daemons: rename the daemon, or drop it from OBSOLETE_SYSTEM_LABELS." >&2
    exit 1
  fi
done <<EOF
${OBSOLETE_SYSTEM_LABELS}
EOF

mkdir -p "${SYSTEM_DIR}"

# Destroy the obsolete labels BEFORE installing the current ones: `rm -f
# "${SYSTEM_DIR}/<label>.plist"` below can then never delete a plist this run
# wrote, even if the guard above is ever weakened.
while IFS= read -r obsolete_label; do
  [ -n "${obsolete_label}" ] || continue
  "${LAUNCHCTL}" bootout "system/${obsolete_label}" >/dev/null 2>&1 || true
  "${LAUNCHCTL}" disable "system/${obsolete_label}" >/dev/null 2>&1 || true
  rm -f "${SYSTEM_DIR}/${obsolete_label}.plist"
done <<EOF
${OBSOLETE_SYSTEM_LABELS}
EOF

for plist in "${TMP_DIR}"/*.plist; do
  if [ "$(id -u)" -eq 0 ]; then
    install -m 644 -o root -g wheel "${plist}" "${SYSTEM_DIR}/$(basename "${plist}")"
  else
    install -m 644 "${plist}" "${SYSTEM_DIR}/$(basename "${plist}")"
  fi
done

# ---------------------------------------------------------------------------
# THE HANDOVER, one service at a time.
#
# History. Finding C2 (round 4) split what used to be one destructive loop into
# three phases: A stopped EVERY user-level agent, B bootstrapped the daemons one
# by one, C archived a user plist only once its replacement was verified loaded.
# That fixed the "abort halfway and the machine runs nothing" failure, and C's
# rule - never remove the fallback until its replacement is proven - is kept
# verbatim below. Two things about that shape were still wrong:
#
#   Finding D4 (round 5). The header here claimed the result was "safe to
#   interrupt anywhere: at every point the machine is either running the old
#   copy or the new one". It was not: phase A stopped all nine user labels up
#   front and phase B then brought the daemons up one at a time behind a settle
#   delay, so the LAST label was stopped and not yet replaced for the whole of
#   phase B. Measured by running the pre-round-5 script against a stub launchctl
#   that timestamps every call, default 2-second settle: the worst single-service
#   gap was 17.1s (official-paper.poll) on this laptop; the same measurement of
#   the loop below gives 2.1s. (Round 4's own report of this defect said 18.1s -
#   the number moves with machine load; the shape does not.)
#
#   Finding D1 (round 5). Phase C's care was undone one runbook step later:
#   `pnpm launchd:install-user` deleted, with rmSync and no backup, every plist
#   phase C had deliberately kept. Three of those labels (cron-runner,
#   official-paper.poll, official-paper.pnl) have no template anywhere in this
#   repo, so the deletion was unrecoverable. That is fixed in the two node
#   installers (they now archive, and only once the replacement daemon answers
#   `launchctl print`), and here by the restore step below.
#
# The loop is therefore per SERVICE, not per phase, and it is a transaction:
#
#   1. STOP   the user-level copies of THIS service only (and remember which
#             ones were actually running). A copy that survives bootout fails
#             this service HERE - see stop_user_agent.
#   2. START  its daemon: bootout, drain, enable, bootstrap, kickstart.
#   3. VERIFY what the job is DOING (verify_daemon, via launchd-health.mjs -
#             the doctor's own residency contract), never by trusting
#             bootstrap's exit code and never by treating a `launchctl print`
#             hit as proof the service came up. Round-6 finding S3e: three
#             daemons that were dead on arrival used to pass this step.
#   4a. up    -> archive that service's user plists (a MOVE into
#               ~/Library/LaunchAgents.disabled/openclaw-system-backup-<ts>/,
#               never a delete), and only that service's.
#   4b. down  -> put it back: bootstrap the user agents this run stopped, from
#               the plists it never removed. The fallback resumes now, not at
#               the next login, and stays on disk for the next attempt.
#
# What that does and does not promise. A service cannot be handed over without a
# gap - the old copy must stop before the new one starts, or two copies race on
# the same trading database and the same port. What is true: the gap belongs to
# ONE service, the other seven keep running through it, no service is ever
# running twice, a service whose daemon does not come up HEALTHY is left running
# the same copy it was running before this script started, and re-running from
# the top converges (every step is idempotent; each daemon is enabled and booted
# out before it is bootstrapped).
#
# What is NOT promised, and is not knowable from launchd: that a daemon this
# script reports as running is doing its job. Step 8 of the runbook
# (`pnpm openclaw:runtime:doctor`) is the gate for that, and this script's own
# exit code is written to the deploy ledger so that gate cannot ignore it.
# ---------------------------------------------------------------------------

print_gateway_warning

# Which daemon replaces a given user-level label. For the eight system labels
# the daemon has the same name; these two rows are the only places where the
# old user-level name and the daemon that replaces it differ.
# Single-sourced with the node installers: launchd-agent-archive.mjs holds the
# same two rows and install-launchd.test.ts asserts the two agree, because a
# label this script archives on the strength of a daemon being up must be the
# same label the node installers refuse to touch while that daemon is down.
supersedes() {
  case "$1" in
    com.openclaw.trading.broker-executor) printf "%s" "com.openclaw.system.trading.broker-executor" ;;
    ai.openclaw.gateway) printf "%s" "ai.openclaw.system.gateway" ;;
    *) printf "%s" "$1" ;;
  esac
}

# The inverse: every user-level label whose service is taken over by this
# daemon. Its own name always, plus any legacy name that supersedes() maps here.
user_labels_for() {
  case "$1" in
    com.openclaw.system.trading.broker-executor) printf "%s\n%s\n" "$1" "com.openclaw.trading.broker-executor" ;;
    ai.openclaw.system.gateway) printf "%s\n%s\n" "$1" "ai.openclaw.gateway" ;;
    *) printf "%s\n" "$1" ;;
  esac
}

LOADED_LABELS=""
FAILED_LABELS=""
FAILURE_DETAIL=""
KEPT_AGENTS=""
RESTORED_AGENTS=""

label_is_loaded() {
  printf "%s\n" "${LOADED_LABELS}" | grep -qxF "$1"
}

record_failure() {
  FAILED_LABELS="${FAILED_LABELS}$1
"
  FAILURE_DETAIL="${FAILURE_DETAIL}  ${1}
      $2
"
}

record_kept() {
  KEPT_AGENTS="${KEPT_AGENTS}  $1
      $2
"
}

# Every user-level label this script is responsible for retiring must be
# claimed by one of the daemons it installs, or it would silently never be
# stopped by the per-service loop below. A "retired" row whose supersedes()
# maps to no rendered daemon is an ORPHAN: nothing replaces it, so it is
# stopped and archived on its own after the loop instead of being forgotten.
ORPHAN_RETIRED_LABELS=""
while IFS= read -r retired_label; do
  [ -n "${retired_label}" ] || continue
  if printf "%s\n" "${EXPECTED_SYSTEM_LABELS}" | grep -qxF "$(supersedes "${retired_label}")"; then
    continue
  fi
  ORPHAN_RETIRED_LABELS="${ORPHAN_RETIRED_LABELS}${retired_label}
"
done <<EOF
$(manifest_labels retired)
ai.openclaw.gateway
EOF

# Stops one user-level agent if it is loaded, and echoes its label when it
# actually stopped something - the caller uses that to know what to put back.
# `|| true` here because bootout of a label that is not loaded exits non-zero
# and "not loaded" is the state this wants; the `print` guard above it already
# answered the only question the exit code could have answered.
#
# Round-5 finding D7: the comment that used to sit here claimed this construct
# was correct "HERE and only here". That was never true - `grep '|| true'` on
# this file has always returned several live sites (the .env.local read, the
# pnpm lookup, the obsolete-label bootout/disable, the system-domain bootout,
# the three `grep -c` counters in the summary), each defensible for its own
# reason. No count is quoted this time on purpose: a number in a comment is a
# claim that rots on the next edit, which is exactly how the false one got here.
# Round-6 finding S3f. This used to print a warning about a label that survived
# bootout, `return 0` with NOTHING on stdout, and let the caller carry on -
# so the loop bootstrapped the daemon anyway, archived the plist, and the run
# summary was clean at exit 0, while README:119 claimed "no service ever runs
# twice". Two copies of broker-executor on one trading database is the exact
# race install-launchd-ownership.txt exists to prevent.
#
# It now records the label in a per-service file that the caller reads. The
# caller refuses to bootstrap that service's daemon at all: with the old copy
# still holding the port/database, starting the new one is the collision, and
# the machine is strictly better off running only the old copy until a human
# looks.
stop_user_agent() {
  local user_label="$1"
  local system_label="${2:-}"
  if ! "${LAUNCHCTL}" print "gui/${TARGET_UID}/${user_label}" >/dev/null 2>&1; then
    return 0
  fi
  "${LAUNCHCTL}" bootout "gui/${TARGET_UID}/${user_label}" >/dev/null 2>&1 || true
  if "${LAUNCHCTL}" print "gui/${TARGET_UID}/${user_label}" >/dev/null 2>&1; then
    echo "install-system-daemons: ERROR: gui/${TARGET_UID}/${user_label} is STILL loaded after bootout." >&2
    if [ -n "${system_label}" ]; then
      printf "%s\n" "${user_label}" >> "${TMP_DIR}/still-loaded.${system_label}"
    fi
    return 0
  fi
  printf "%s\n" "${user_label}"
}

# Moves one user plist into the archive. NEVER deletes: if the archive cannot
# be created or the move fails, the plist stays exactly where it is and the
# label is reported as kept. Three of these labels exist in no other copy
# anywhere, so "could not archive" must mean "did not remove".
archive_user_agent() {
  local user_label="$1"
  local agent_plist="${AGENTS_DIR}/${user_label}.plist"
  [ -f "${agent_plist}" ] || return 0
  if ! ensure_backup_dir; then
    record_kept "${user_label}" "left in ${AGENTS_DIR}: cannot create the archive directory ${BACKUP_DIR} (nothing is ever deleted in its place)"
    return 0
  fi
  if mv "${agent_plist}" "${BACKUP_DIR}/" 2>/dev/null; then
    echo "Retired user LaunchAgent ${user_label} -> ${BACKUP_DIR}"
  else
    record_kept "${user_label}" "left in ${AGENTS_DIR}: moving it to ${BACKUP_DIR} failed (nothing is ever deleted in its place)"
  fi
}

# Puts back exactly what this run stopped, from the plist it never removed.
# Only labels this run actually booted out are restored: bootstrapping an agent
# that was already down would START something the machine was not running, and
# on a machine with no GUI session that call cannot succeed anyway.
restore_user_agents() {
  local stopped="$1"
  local user_label agent_plist restore_output
  while IFS= read -r user_label; do
    [ -n "${user_label}" ] || continue
    agent_plist="${AGENTS_DIR}/${user_label}.plist"
    if [ ! -f "${agent_plist}" ]; then
      record_kept "${user_label}" "was running before this run, but has no plist in ${AGENTS_DIR} - there is nothing to fall back to"
      continue
    fi
    if restore_output="$("${LAUNCHCTL}" bootstrap "gui/${TARGET_UID}" "${agent_plist}" 2>&1)"; then
      RESTORED_AGENTS="${RESTORED_AGENTS}  ${user_label} (running again from ${agent_plist})
"
    else
      record_kept "${user_label}" "plist kept at ${agent_plist}, but bootstrapping it back into gui/${TARGET_UID} failed: ${restore_output} - start it by hand with: launchctl bootstrap gui/${TARGET_UID} ${agent_plist}"
    fi
  done <<EOF
${stopped}
EOF
}

# --- 3. verify by asking launchd what the job is DOING, not whether it exists.
#
# Round-6 finding S3e. This step used to be `launchctl print system/<label>` and
# nothing else, i.e. proof of REGISTRATION. Measured 2026-07-29 by running the
# PREVIOUS version of this script (extracted from HEAD) and this one against the
# same sandboxed root and the same launchctl stub, with platform-app,
# broker-executor and market-alerts injected to bootstrap successfully and then
# be dead on arrival (state = not running, last exit code = 1): the previous
# version exited 0, printed every label as `loaded`, and archived both
# user-level fallbacks; this one exits 1, prints them as NOT RUNNING, and leaves
# the fallbacks on disk. The doctor learned "loaded is not working" in round
# 4; this is the same knowledge, from the same module (launchd-health.mjs), so
# the two can never disagree about what a healthy daemon looks like.
#
# What a pass here proves: the daemon was still alive VERIFY_SETTLE_SECONDS
# after bootstrap and launchd has recorded no abnormal termination for it (for
# a periodic job: its RunAtLoad run did not fail). What it does NOT prove: that
# the service works. Nothing launchd knows can prove that - the doctor's
# loopback probes are what do, which is why step 8 is still the gate.
verify_daemon() {
  local label="$1"
  # NOT named `status`: that is a read-only special parameter in zsh (an alias
  # for $?), and this script's shebang is zsh - assigning to it aborted the run
  # with "read-only variable: status" before any daemon was verified.
  local printed verdict verify_status
  printed="$("${LAUNCHCTL}" print "system/${label}" 2>/dev/null || true)"
  verify_status=0
  verdict="$(printf "%s" "${printed}" | "${NODE_BIN}" "${HEALTH_CHECKER}" verify "${label}")" || verify_status=$?
  if [ "${verify_status}" -eq 0 ]; then
    return 0
  fi
  if [ -z "${verdict}" ]; then
    verdict="${label}: could not run ${HEALTH_CHECKER} with ${NODE_BIN} (exit ${verify_status})"
  fi
  VERIFY_REASON="${verdict}"
  return 1
}

while IFS= read -r system_label; do
  [ -n "${system_label}" ] || continue
  system_plist="${SYSTEM_DIR}/${system_label}.plist"

  # --- 1. stop the user-level copies of THIS service -----------------------
  stopped_agents=""
  while IFS= read -r user_label; do
    [ -n "${user_label}" ] || continue
    stopped_agents="${stopped_agents}$(stop_user_agent "${user_label}" "${system_label}")
"
  done <<EOF
$(user_labels_for "${system_label}")
EOF

  # A user-level copy that survived bootout means this service is STILL RUNNING
  # under the old plist. Bootstrapping the daemon now would put two owners on
  # one port and one database - so this service is failed here, before anything
  # irreversible, and the machine keeps running the copy it already had.
  if [ -s "${TMP_DIR}/still-loaded.${system_label}" ]; then
    record_failure "${system_label}" "user-level $(tr '\n' ' ' < "${TMP_DIR}/still-loaded.${system_label}")is STILL loaded after bootout; refusing to bootstrap the daemon because both copies would then run on the same port/database. Stop it by hand (launchctl bootout gui/${TARGET_UID}/<label>) and re-run."
    restore_user_agents "${stopped_agents}"
    continue
  fi

  # --- 2. bring the daemon up ---------------------------------------------
  "${LAUNCHCTL}" bootout "system/${system_label}" >/dev/null 2>&1 || true
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if ! "${LAUNCHCTL}" print "system/${system_label}" >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
  done
  sleep "${BOOTSTRAP_SETTLE_SECONDS}"

  # Finding C3, second half: `enable` comes FIRST, before bootstrap and
  # kickstart, because both of those fail outright on a label that is in
  # launchd's disabled database - and that database survives reboots and plist
  # reinstalls, so nothing else in a re-run clears it. With the old
  # bootstrap -> enable -> kickstart order, any label that was ever disabled
  # (an operator debugging with `sudo launchctl disable`, or the retire loop
  # above after a rename) aborted the run before reaching the `enable` that
  # would have unwedged it, so every subsequent run failed identically.
  # Non-fatal on its own: on a label that was never disabled some macOS
  # versions still return non-zero, and bootstrap is the real test.
  enable_output=""
  if ! enable_output="$("${LAUNCHCTL}" enable "system/${system_label}" 2>&1)"; then
    echo "install-system-daemons: warning: launchctl enable system/${system_label} failed: ${enable_output}" >&2
  fi

  # FATAL FOR THIS LABEL, not for the run: record it, put this service's own
  # fallback back, and keep going so the other seven are still installed.
  bootstrap_output=""
  if ! bootstrap_output="$("${LAUNCHCTL}" bootstrap system "${system_plist}" 2>&1)"; then
    record_failure "${system_label}" "launchctl bootstrap system ${system_plist}: ${bootstrap_output}"
    restore_user_agents "${stopped_agents}"
    continue
  fi

  # Reportable, not fatal: the plists all carry RunAtLoad=true, so a successful
  # bootstrap has already started the job. `kickstart -k` only forces a restart
  # of an instance that may be mid-run; the load check below is what decides.
  kickstart_output=""
  if ! kickstart_output="$("${LAUNCHCTL}" kickstart -k "system/${system_label}" 2>&1)"; then
    echo "install-system-daemons: warning: launchctl kickstart -k system/${system_label} failed: ${kickstart_output}" >&2
    echo "install-system-daemons: warning: bootstrap succeeded and RunAtLoad started it; checking the job table." >&2
  fi

  # --- 3. verify (see verify_daemon above) --------------------------------
  sleep "${VERIFY_SETTLE_SECONDS}"
  VERIFY_REASON=""
  if ! verify_daemon "${system_label}"; then
    record_failure "${system_label}" "${VERIFY_REASON}"
    restore_user_agents "${stopped_agents}"
    continue
  fi

  LOADED_LABELS="${LOADED_LABELS}${system_label}
"

  # --- 4a. up: archive this service's user plists, and only this service's --
  while IFS= read -r user_label; do
    [ -n "${user_label}" ] || continue
    archive_user_agent "${user_label}"
  done <<EOF
$(user_labels_for "${system_label}")
EOF
done <<EOF
${EXPECTED_SYSTEM_LABELS}
EOF

# Retired labels that no daemon replaces: stop them and archive them. Nothing
# is waiting to take these over, so there is no "up" to wait for - but they are
# still moved rather than deleted, same as everything else here.
while IFS= read -r orphan_label; do
  [ -n "${orphan_label}" ] || continue
  stop_user_agent "${orphan_label}" >/dev/null
  archive_user_agent "${orphan_label}"
done <<EOF
${ORPHAN_RETIRED_LABELS}
EOF

echo "Installed system daemons under ${SYSTEM_DIR} (running as ${TARGET_USER}):"
while IFS= read -r installed_label; do
  [ -n "${installed_label}" ] || continue
  # Round-6 finding S3e: the word here used to be "loaded", which was true of a
  # dead daemon too. LOADED_LABELS now only carries labels that passed
  # verify_daemon, so the word can honestly be "running".
  if label_is_loaded "${installed_label}"; then
    state="running"
  else
    state="NOT RUNNING"
  fi
  if daemon_uses_proxy "${installed_label}"; then
    echo "  ${installed_label}  egress=proxy(${OPENCLAW_PROXY_URL})  ${state}"
  else
    echo "  ${installed_label}  egress=direct  ${state}"
  fi
done <<EOF
${EXPECTED_SYSTEM_LABELS}
EOF

if [ -d "${BACKUP_DIR}" ]; then
  echo "Backed up user launch agents under ${BACKUP_DIR}"
  echo "  (to fall back to one of them: launchctl bootstrap gui/${TARGET_UID} ${BACKUP_DIR}/<label>.plist)"
fi

if [ -n "${FAILED_LABELS}" ]; then
  failed_count="$(printf "%s" "${FAILED_LABELS}" | grep -c . || true)"
  total_count="$(printf "%s" "${EXPECTED_SYSTEM_LABELS}" | grep -c . || true)"
  loaded_count="$(printf "%s" "${LOADED_LABELS}" | grep -c . || true)"
  echo "" >&2
  echo "install-system-daemons: FAILED - ${failed_count} of ${total_count} daemons did not come up:" >&2
  printf "%s" "${FAILURE_DETAIL}" >&2
  echo "install-system-daemons: ${loaded_count} of ${total_count} ARE running; the machine is not idle." >&2
  if [ -n "${RESTORED_AGENTS}" ]; then
    echo "install-system-daemons: the old user-level copy of each failed service was started again," >&2
    echo "install-system-daemons: so those services are running the same code they were before this run:" >&2
    printf "%s" "${RESTORED_AGENTS}" >&2
  fi
  if [ -n "${KEPT_AGENTS}" ]; then
    echo "install-system-daemons: these user LaunchAgents were LEFT on disk and need a look:" >&2
    printf "%s" "${KEPT_AGENTS}" >&2
  fi
  echo "install-system-daemons: DO NOT run 'pnpm launchd:install-user' as a workaround: it retires" >&2
  echo "install-system-daemons: user-level copies, and it refuses to touch any label whose daemon is" >&2
  echo "install-system-daemons: down - so it cannot clean this up either. Fix the cause and re-run:" >&2
  echo "install-system-daemons:   sudo zsh $0" >&2
  echo "install-system-daemons: every step is idempotent, and each daemon is enabled and booted out" >&2
  echo "install-system-daemons: before it is bootstrapped, so a re-run converges rather than repeating." >&2
  exit 1
fi

if [ -n "${KEPT_AGENTS}" ]; then
  echo "" >&2
  echo "install-system-daemons: every daemon is loaded, but these user LaunchAgents could not be archived:" >&2
  printf "%s" "${KEPT_AGENTS}" >&2
  echo "install-system-daemons: they are still on disk (nothing was deleted). Until they are moved out of" >&2
  echo "install-system-daemons: ${AGENTS_DIR}, the next login starts a SECOND copy of those services next" >&2
  echo "install-system-daemons: to the daemon - the doctor reports that as launchd-jobs.<name>.wrong_domain." >&2
  exit 1
fi
