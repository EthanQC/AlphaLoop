#!/bin/zsh
set -euo pipefail

export PATH="${HOME}/.local/node-v24/bin:${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DEST="${HOME}/Library/LaunchAgents"
mkdir -p "${DEST}" "${REPO_ROOT}/logs"

if [ -f "${REPO_ROOT}/.env.local" ]; then
  set -a
  source "${REPO_ROOT}/.env.local"
  set +a
fi

for template in "${REPO_ROOT}"/apps/openclaw-config/launchd/*.plist; do
  if [ "$(basename "${template}")" = "com.openclaw.gateway.plist" ]; then
    continue
  fi
  output="${DEST}/$(basename "${template}")"
  sed "s#__REPO_ROOT__#${REPO_ROOT}#g" "${template}" > "${output}"
  launchctl unload "${output}" >/dev/null 2>&1 || true
  launchctl load "${output}"
  echo "Loaded ${output}"
done

if [ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  openclaw gateway install --force --runtime node --token "${OPENCLAW_GATEWAY_TOKEN}"
else
  openclaw gateway install --force --runtime node
fi
