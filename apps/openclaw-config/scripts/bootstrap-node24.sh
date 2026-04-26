#!/bin/zsh
set -euo pipefail

if command -v node >/dev/null 2>&1; then
  node -v
  exit 0
fi

echo "Node.js not found. Install Node 24 before running the stack."
echo "Recommended: use nvm or fnm, then install pnpm via corepack."

