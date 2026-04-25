#!/bin/zsh
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: sync-private-notes.sh <git@github.com:owner/repo.git>"
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TARGET="${REPO_ROOT}/knowledge/notes/private-repo"

if [ -d "${TARGET}/.git" ]; then
  git -C "${TARGET}" pull --ff-only
else
  git clone "$1" "${TARGET}"
fi

