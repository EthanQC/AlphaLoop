#!/bin/zsh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
WORKSPACE_ROOT="${HOME}/.openclaw/workspaces"
AGENT_ROOT="${HOME}/.openclaw/agents"

mkdir -p "${WORKSPACE_ROOT}/control" \
  "${WORKSPACE_ROOT}/live-advisor" \
  "${WORKSPACE_ROOT}/paper-trader" \
  "${WORKSPACE_ROOT}/evolution" \
  "${AGENT_ROOT}/control/agent" \
  "${AGENT_ROOT}/live-advisor/agent" \
  "${AGENT_ROOT}/paper-trader/agent" \
  "${AGENT_ROOT}/evolution/agent"

cp "${REPO_ROOT}/apps/openclaw-config/agents/control.md" "${WORKSPACE_ROOT}/control/AGENTS.md"
cp "${REPO_ROOT}/apps/openclaw-config/agents/live-advisor.md" "${WORKSPACE_ROOT}/live-advisor/AGENTS.md"
cp "${REPO_ROOT}/apps/openclaw-config/agents/paper-trader.md" "${WORKSPACE_ROOT}/paper-trader/AGENTS.md"
cp "${REPO_ROOT}/apps/openclaw-config/agents/evolution.md" "${WORKSPACE_ROOT}/evolution/AGENTS.md"

cat > "${WORKSPACE_ROOT}/control/HEARTBEAT.md" <<EOF
Check queue lag, broker auth, Feishu connectivity, and candidate rule versions.
EOF

cp "${WORKSPACE_ROOT}/control/HEARTBEAT.md" "${WORKSPACE_ROOT}/live-advisor/HEARTBEAT.md"
cp "${WORKSPACE_ROOT}/control/HEARTBEAT.md" "${WORKSPACE_ROOT}/paper-trader/HEARTBEAT.md"
cp "${WORKSPACE_ROOT}/control/HEARTBEAT.md" "${WORKSPACE_ROOT}/evolution/HEARTBEAT.md"

echo "Synced workspaces under ${WORKSPACE_ROOT}"
