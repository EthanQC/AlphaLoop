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

# Installs both ready-to-load `.plist` files and `.plist.template` files (the
# latter still carry the __REPO_ROOT__ placeholder, same as the former - the
# `.template` suffix is only a naming convention for "not directly droppable
# into LaunchAgents yet", not a different rendering format). Both go through
# the identical sed-render-then-load path below; a `.template` source only
# differs in its destination filename (the suffix is stripped so launchd
# sees the plain com.alphaloop.<job>.plist name it expects). The `(N)` glob
# qualifier makes each pattern expand to nothing (rather than erroring under
# `set -e`) if no files match it.
for template in "${REPO_ROOT}"/apps/openclaw-config/launchd/*.plist(N) "${REPO_ROOT}"/apps/openclaw-config/launchd/*.plist.template(N); do
  if [ "$(basename "${template}")" = "com.openclaw.gateway.plist" ]; then
    continue
  fi
  output_name="$(basename "${template}")"
  output_name="${output_name%.template}"
  output="${DEST}/${output_name}"
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
