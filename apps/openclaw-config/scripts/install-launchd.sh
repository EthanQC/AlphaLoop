#!/bin/zsh
set -euo pipefail

export PATH="${HOME}/.local/node-v24/bin:${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DEST="${HOME}/Library/LaunchAgents"
OWNERSHIP_FILE="${OWNERSHIP_FILE:-${REPO_ROOT}/apps/openclaw-config/scripts/install-launchd-ownership.txt}"
mkdir -p "${DEST}" "${REPO_ROOT}/logs"

if [ -f "${REPO_ROOT}/.env.local" ]; then
  set -a
  source "${REPO_ROOT}/.env.local"
  set +a
fi

if [ ! -f "${OWNERSHIP_FILE}" ]; then
  echo "install-launchd: ownership manifest not found at ${OWNERSHIP_FILE}" >&2
  exit 1
fi

# Installs both ready-to-load `.plist` files and `.plist.template` files (the
# latter still carry the __REPO_ROOT__ placeholder, same as the former - the
# `.template` suffix is only a naming convention for "not directly droppable
# into LaunchAgents yet", not a different rendering format). Both go through
# the identical sed-render-then-load path below; a `.template` source only
# differs in its destination filename (the suffix is stripped so launchd
# sees the plain com.alphaloop.<job>.plist name it expects). The `(N)` glob
# qualifier makes each pattern expand to nothing (rather than erroring under
# `set -e`) if no files match it.
#
# Task 9 (2026-07-28): which of those templates may actually be installed HERE
# is now decided by install-launchd-ownership.txt, not by the glob. Everything
# unattended moved to /Library/LaunchDaemons (see install-system-daemons.sh) -
# rendering a second, user-level copy of one of those labels would give the
# machine two owners for the same job. An unlisted template is a hard error
# rather than a silent skip: silently not installing a new job is the exact
# H2 regression (`*.plist` glob missing `.plist.template`) this script already
# had once.
for template in "${REPO_ROOT}"/apps/openclaw-config/launchd/*.plist(N) "${REPO_ROOT}"/apps/openclaw-config/launchd/*.plist.template(N); do
  output_name="$(basename "${template}")"
  output_name="${output_name%.template}"
  label="${output_name%.plist}"
  # `/^[[:space:]]*#/ {next}` matters: the manifest's prose explains each
  # decision and therefore MENTIONS labels inside comments (e.g. why rsshub
  # stays user-level). Without it the first comment naming a label wins and
  # the scope comes back as "#".
  scope="$(awk -v label="${label}" '/^[[:space:]]*#/ { next } $2 == label { print $1 }' "${OWNERSHIP_FILE}" | head -n 1)"

  if [ -z "${scope}" ]; then
    echo "install-launchd: ${label} has no row in ${OWNERSHIP_FILE}." >&2
    echo "install-launchd: add 'user <label>' to install it here, or 'system <label>' plus a daemon in install-system-daemons.sh." >&2
    exit 1
  fi

  if [ "${scope}" != "user" ]; then
    echo "Skipped ${label} (owned by: ${scope})"
    continue
  fi

  output="${DEST}/${output_name}"
  sed "s#__REPO_ROOT__#${REPO_ROOT}#g" "${template}" > "${output}"
  launchctl unload "${output}" >/dev/null 2>&1 || true
  launchctl load "${output}"
  echo "Loaded ${output}"
done

# The gateway is repo-owned in the system domain and is installed exclusively
# by install-system-daemons.sh. Do not call `openclaw gateway install` here:
# that command creates a conflicting gui/<uid> LaunchAgent, and on a cold,
# headless boot the GUI domain does not exist at all, so the standard deploy
# would fail before it reached the system installer.
