#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${SCRIPT_DIR:-$(cd "$(dirname "$0")" && pwd)}"
TARGET_HOME="${TARGET_HOME:-${HOME}}"
INSTALL_ROOT="${MEMORYD_INSTALL_ROOT:-${TARGET_HOME}/.local/share/alphaloop-memoryd}"
SOURCE_DIR="${INSTALL_ROOT}/source"
DATA_ROOT="${MEMORYD_DATA_ROOT:-${TARGET_HOME}/Library/Application Support/AlphaLoop/memoryd}"
SOURCE_URL="${MEMORYD_SOURCE_URL:-git@github.com:EthanQC/memory-system.git}"
SOURCE_REV="${MEMORYD_SOURCE_REV:-$(sed -n '1p' "${SCRIPT_DIR}/memoryd-revision.txt")}"
GIT_BIN="${GIT_BIN:-git}"
UV_BIN="${UV_BIN:-${TARGET_HOME}/.local/bin/uv}"

if [ -z "${SOURCE_REV}" ]; then
  echo "install-memoryd-runtime: pinned revision is empty." >&2
  exit 1
fi
if [ ! -x "${UV_BIN}" ]; then
  echo "install-memoryd-runtime: uv is not executable at ${UV_BIN}." >&2
  exit 1
fi

mkdir -p "${INSTALL_ROOT}" "${DATA_ROOT}"
if [ ! -e "${SOURCE_DIR}" ]; then
  "${GIT_BIN}" clone --no-checkout "${SOURCE_URL}" "${SOURCE_DIR}"
elif [ ! -d "${SOURCE_DIR}/.git" ]; then
  echo "install-memoryd-runtime: ${SOURCE_DIR} exists but is not a managed git checkout." >&2
  exit 1
fi

"${GIT_BIN}" -C "${SOURCE_DIR}" fetch --depth 1 origin "${SOURCE_REV}"
"${GIT_BIN}" -C "${SOURCE_DIR}" checkout --detach --force "${SOURCE_REV}"
ACTUAL_REV="$("${GIT_BIN}" -C "${SOURCE_DIR}" rev-parse HEAD)"
if [ "${ACTUAL_REV}" != "${SOURCE_REV}" ]; then
  echo "install-memoryd-runtime: expected ${SOURCE_REV}, checked out ${ACTUAL_REV}." >&2
  exit 1
fi

if [ ! -f "${SOURCE_DIR}/memoryd/uv.lock" ]; then
  echo "install-memoryd-runtime: pinned source has no memoryd/uv.lock." >&2
  exit 1
fi
(cd "${SOURCE_DIR}/memoryd" && "${UV_BIN}" sync --frozen --no-dev)

MEMORYD_BIN="${SOURCE_DIR}/memoryd/.venv/bin/memoryd-mcp"
if [ ! -x "${MEMORYD_BIN}" ]; then
  echo "install-memoryd-runtime: sync completed but ${MEMORYD_BIN} is not executable." >&2
  exit 1
fi

echo "memoryd_runtime=${MEMORYD_BIN}"
echo "memoryd_revision=${ACTUAL_REV}"
echo "memoryd_data_root=${DATA_ROOT}"
