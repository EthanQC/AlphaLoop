#!/bin/zsh
set -euo pipefail

KEY_PATH="${HOME}/.ssh/id_ed25519_openclaw_trading"

if [ -f "${KEY_PATH}" ]; then
  echo "Key already exists at ${KEY_PATH}"
else
  ssh-keygen -t ed25519 -f "${KEY_PATH}" -C "openclaw-trading" -N ""
fi

echo "Public key:"
cat "${KEY_PATH}.pub"

