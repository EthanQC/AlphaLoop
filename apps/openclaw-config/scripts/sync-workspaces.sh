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

sync_agent_context() {
  local agent_id="$1"
  local agent_prompt="$2"
  local workspace_dir="${WORKSPACE_ROOT}/${agent_id}"
  local shared_context_dir="${REPO_ROOT}/apps/openclaw-config/context/shared"
  local agent_context_dir="${REPO_ROOT}/apps/openclaw-config/context/${agent_id}"

  cp "${agent_prompt}" "${workspace_dir}/AGENTS.md"

  if [[ -d "${shared_context_dir}" ]]; then
    cp "${shared_context_dir}"/*.md "${workspace_dir}/"
  fi

  if [[ -d "${agent_context_dir}" ]]; then
    cp "${agent_context_dir}"/*.md "${workspace_dir}/"
  fi
}

sync_agent_context "control" "${REPO_ROOT}/apps/openclaw-config/agents/control.md"
sync_agent_context "live-advisor" "${REPO_ROOT}/apps/openclaw-config/agents/live-advisor.md"
sync_agent_context "paper-trader" "${REPO_ROOT}/apps/openclaw-config/agents/paper-trader.md"
sync_agent_context "evolution" "${REPO_ROOT}/apps/openclaw-config/agents/evolution.md"

cat > "${WORKSPACE_ROOT}/control/HEARTBEAT.md" <<EOF
Check queue lag, broker auth, Feishu connectivity, model selection drift, candidate rule versions, context-memory health, and automation-inventory drift.
Use \`cd /Users/mashu/Documents/codex && node --no-warnings apps/openclaw-config/scripts/context-manager.mjs automation-summary\` when asked what scheduled automations exist; it includes OpenClaw cron plus relevant launchd jobs.
EOF

cp "${WORKSPACE_ROOT}/control/HEARTBEAT.md" "${WORKSPACE_ROOT}/live-advisor/HEARTBEAT.md"
cp "${WORKSPACE_ROOT}/control/HEARTBEAT.md" "${WORKSPACE_ROOT}/paper-trader/HEARTBEAT.md"
cp "${WORKSPACE_ROOT}/control/HEARTBEAT.md" "${WORKSPACE_ROOT}/evolution/HEARTBEAT.md"

"$(command -v node)" --no-warnings "${REPO_ROOT}/apps/openclaw-config/scripts/context-manager.mjs" refresh-docs >/dev/null

echo "Synced workspaces under ${WORKSPACE_ROOT}"
