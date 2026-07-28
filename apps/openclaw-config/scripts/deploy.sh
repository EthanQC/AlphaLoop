#!/bin/zsh
set -euo pipefail

# Round-6 (2026-07-29): THE RUNBOOK, AS A PROGRAM.
#
# WHY THIS EXISTS
# ---------------
# README.md's steps 0-8 were a plain command sequence in a fenced block - no
# `&&`, no `set -e`, no guard, which is checkable in the block itself. Round 5
# measured the consequence: making `git pull --ff-only` abort (a dirty README on
# the deploy machine is enough) let steps 1 through 8 run to completion against
# the OLD checkout and finish on a green acceptance gate. The same shape covers
# every other step - a failed step 3 did not stop step 4 from running, and a
# controller who pasted the block saw the last command's output and nothing
# else.
#
# A block of shell that an operator pastes cannot be made fail-fast (`set -e`
# in an interactive shell kills their ssh session on the first non-zero exit),
# so the runbook stopped being a block and became this: one script, fail-fast,
# every step's exit code written to the deploy ledger, and a final summary that
# names the step that failed and what is true about the machine now.
#
# Every step is still individually runnable by hand - the README lists them -
# and re-running THIS script after fixing the cause is safe: every step is
# idempotent (see each step's own note below).
#
#   zsh apps/openclaw-config/scripts/deploy.sh          # asks for the gateway ack
#   DEPLOY_ACK_GATEWAY_RESTART=yes zsh .../deploy.sh    # unattended
#   DEPLOY_FROM_STEP=4 zsh .../deploy.sh                # resume after fixing step 3
#
# Test seams (used by the sandbox suite, never in production): REPO_ROOT,
# DEPLOY_RUNTIME_ROOT, DEPLOY_SUDO, DEPLOY_LOGIN_SHELL.

SCRIPT_DIR="${SCRIPT_DIR:-$(cd "$(dirname "$0")" && pwd)}"
REPO_ROOT="${REPO_ROOT:-$(cd "${SCRIPT_DIR}/../../.." && pwd)}"
RUNTIME_ROOT="${DEPLOY_RUNTIME_ROOT:-${REPO_ROOT}/runtime}"
SUDO="${DEPLOY_SUDO:-sudo}"
LOGIN_SHELL="${DEPLOY_LOGIN_SHELL:-zsh}"
NODE_FOR_LEDGER="${DEPLOY_NODE:-node}"
FROM_STEP="${DEPLOY_FROM_STEP:-0}"
ATTEMPT_ID="${DEPLOY_ATTEMPT_ID:-$(date +%Y%m%d-%H%M%S)-$$}"

# ---------------------------------------------------------------------------
# ⚠ THE GATEWAY WARNING. Step 3 restarts ai.openclaw.system.gateway, and on the
# deploy target that gateway is NOT ours alone.
#
# Measured read-only on the mini (2026-07-28/29):
#   · exactly one process listens on 18789 - node pid 21802, user qingchang,
#     on 127.0.0.1 and [::1]. There is no second gateway to fall back on.
#   · ~/.openclaw/openclaw.json configures 185 agents with a workspace, and
#     ~/.openclaw/agents holds 187 directories - the operator's personal
#     OpenClaw fleet, served by that same process on that same port.
#   · that process had a live descendant at the time of writing: pid 21802 ->
#     node 27714 -> .../@openai/codex-darwin-arm64/.../bin/codex. A running
#     codex session, i.e. somebody's work.
#
# Restarting the gateway therefore interrupts the operator's personal agents,
# not just AlphaLoop's. The runbook never said so before this round.
# ---------------------------------------------------------------------------
print_gateway_warning() {
  cat >&2 <<'WARNING'
================================================================================
⚠ 第 3 步会重启 ai.openclaw.system.gateway —— 那是这台机器上 18789 端口的唯一监听
   进程，同时也在给你【个人的 OpenClaw 全部 agent】提供服务。

   只读实测（mini，2026-07-28/29）：18789 上只有一个监听进程（node，用户
   qingchang）；~/.openclaw/openclaw.json 里配了 185 个带 workspace 的 agent，
   ~/.openclaw/agents 下有 187 个目录；写这段话的时候，这个 gateway 进程底下
   还挂着一个活着的 codex 子进程（21802 → node 27714 → codex）。

   也就是说：跑第 3 步 = 你个人正在跑的 agent 会话会被打断。

   跑之前请先做这三件事：
     1. `openclaw cron status` / 看一眼有没有正在跑的会话，等它跑完或手动停掉；
     2. 把重要的 codex 会话结果落盘（重启后子进程不会自己回来）；
     3. 挑一个你自己不在用 agent 的时间窗口。

   确认后用下面任一方式继续：
     DEPLOY_ACK_GATEWAY_RESTART=yes zsh apps/openclaw-config/scripts/deploy.sh
     zsh apps/openclaw-config/scripts/deploy.sh --ack-gateway-restart
================================================================================
WARNING
}

ACK="${DEPLOY_ACK_GATEWAY_RESTART:-}"
for arg in "$@"; do
  case "${arg}" in
    --ack-gateway-restart) ACK="yes" ;;
    --from-step=*) FROM_STEP="${arg#--from-step=}" ;;
    *)
      echo "deploy: unknown argument ${arg}" >&2
      exit 2
      ;;
  esac
done

print_gateway_warning
case "${ACK}" in
  yes|YES|1|true) ;;
  *)
    echo "deploy: 没有确认 gateway 重启影响，什么都还没做（这时候中止是安全的）。" >&2
    exit 2
    ;;
esac

HEAD_SHA="$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
FAILED_STEP=""
FAILED_NAME=""
SUMMARY=""

record_step() {
  # Bookkeeping must never change the deploy's own exit code, hence `|| true`.
  "${NODE_FOR_LEDGER}" "${SCRIPT_DIR}/deploy-ledger.mjs" record \
    --runtime-root "${RUNTIME_ROOT}" \
    --attempt "${ATTEMPT_ID}" \
    --step "$1" \
    --exit "$2" \
    --head "$3" \
    --started-at "$4" \
    --detail "$5" >/dev/null 2>&1 || true
}

# Runs one step, records its receipt, and ABORTS the whole deploy when it fails.
# That abort is the entire point of this file: the previous runbook let step 4
# run after step 3 had exited 1.
run_step() {
  local number="$1"
  local name="$2"
  shift 2
  local started
  started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  if [ "${number}" -lt "${FROM_STEP}" ]; then
    echo "── 第 ${number} 步 ${name}：按 DEPLOY_FROM_STEP=${FROM_STEP} 跳过"
    return 0
  fi

  echo ""
  echo "── 第 ${number} 步 ${name} ─────────────────────────────────────"
  # NOT `status`: that is a read-only special parameter in zsh (an alias for
  # $?), and this script's shebang is zsh - assigning to it aborted run_step
  # with "read-only variable: status" before any step could be judged.
  local step_status=0
  "$@" || step_status=$?
  record_step "${number}" "${step_status}" "${HEAD_SHA}" "${started}" "${name}"

  if [ "${step_status}" -ne 0 ]; then
    FAILED_STEP="${number}"
    FAILED_NAME="${name}"
    SUMMARY="${SUMMARY}  第 ${number} 步 ${name}：退出码 ${step_status} ← 失败，后面的步骤没有执行
"
    return "${step_status}"
  fi
  SUMMARY="${SUMMARY}  第 ${number} 步 ${name}：退出码 0
"
  return 0
}

report_and_exit() {
  local exit_status="$1"
  echo ""
  echo "════════════════════════════════════════════════════════════════"
  echo "本次部署 attempt=${ATTEMPT_ID}，commit=${HEAD_SHA}"
  printf "%s" "${SUMMARY}"
  if [ -n "${FAILED_STEP}" ]; then
    echo ""
    echo "部署在第 ${FAILED_STEP} 步（${FAILED_NAME}）失败，后面的步骤【一步都没有执行】。" >&2
    echo "这台机器现在处于半完成状态：请照上面那一步自己打印的原因修掉，然后从该步继续：" >&2
    echo "  DEPLOY_ACK_GATEWAY_RESTART=yes DEPLOY_FROM_STEP=${FAILED_STEP} zsh $0" >&2
    echo "验收门（第 8 步）现在也会因为这条失败记录而报错，不会给出绿灯：" >&2
    echo "  pnpm openclaw:runtime:doctor" >&2
  else
    echo ""
    echo "0-8 全部通过。第 8 步（doctor）退出 0 才算验收通过，上面已经跑过了。"
  fi
  echo "════════════════════════════════════════════════════════════════"
  exit "${exit_status}"
}

trap 'report_and_exit $?' ERR

# --- 0. the only step that brings new code to this machine -------------------
# Idempotent: `--ff-only` prints "Already up to date" and exits 0 when there is
# nothing to pull. The dirty-tree check is a pre-flight rather than letting git
# fail, because git's own message ("Your local changes would be overwritten")
# does not say which file or that the whole deploy is about to be pointless.
#
# EVERY command in a step body carries its own `|| return $?`, and it has to.
# `set -e` is suspended for any command whose failure is already being checked
# by the caller - and run_step calls these as `"$@" || step_status=$?`, which is
# exactly that. Caught by the sandbox suite: with a plain command list here, a
# `git pull` that exited 1 did NOT abort step_pull; the function ran on to its
# last `echo` and returned 0, i.e. the runbook driver reproduced, inside itself,
# the very defect it exists to fix. `&&` chains (step_build and friends below)
# are safe for the same reason - the chain itself propagates the failure.
step_pull() {
  local dirty
  dirty="$(git -C "${REPO_ROOT}" status --porcelain --untracked-files=no)" || return $?
  if [ -n "${dirty}" ]; then
    echo "deploy: 工作区有已跟踪文件的本地改动，git pull --ff-only 会中止：" >&2
    printf "%s\n" "${dirty}" >&2
    echo "deploy: 先处理掉（git checkout -- <file> 或 git stash），再重跑。" >&2
    return 1
  fi
  git -C "${REPO_ROOT}" fetch origin || return $?
  git -C "${REPO_ROOT}" pull --ff-only origin main || return $?
  HEAD_SHA="$(git -C "${REPO_ROOT}" rev-parse --short HEAD)" || return $?
  echo "deploy: 这台机器现在停在 ${HEAD_SHA}"
}

step_build() {
  (cd "${REPO_ROOT}" && pnpm install && pnpm build)
}

step_user_agents() {
  (cd "${REPO_ROOT}" && pnpm launchd:install-backup-alerts)
}

step_system_daemons() {
  (cd "${REPO_ROOT}" && "${SUDO}" zsh "${SCRIPT_DIR}/install-system-daemons.sh")
}

step_retire() {
  (cd "${REPO_ROOT}" && pnpm launchd:install-user)
}

step_cron() {
  (cd "${REPO_ROOT}" && pnpm openclaw:cron:install)
}

step_persona() {
  (cd "${REPO_ROOT}" && node "${SCRIPT_DIR}/render-openclaw-config.mjs")
}

# Login shell on purpose: docker is only on the PATH of one (measured on the
# mini - `ssh … 'command -v docker'` returns nothing, `ssh … zsh -lc …` returns
# /opt/homebrew/bin/docker). `docker start || docker run` rather than a bare
# `docker run`, which exits non-zero on "container name already in use".
step_rsshub() {
  "${LOGIN_SHELL}" -lc 'docker start rsshub 2>/dev/null || docker run -d --name rsshub -p 127.0.0.1:1200:1200 diygod/rsshub'
}

step_acceptance() {
  (cd "${REPO_ROOT}" && pnpm openclaw:runtime:doctor)
}

run_step 0 "拉取新代码" step_pull
run_step 1 "安装依赖并构建" step_build
run_step 2 "安装用户级 LaunchAgent" step_user_agents
run_step 3 "安装系统 daemon" step_system_daemons
run_step 4 "退役旧的用户级副本" step_retire
run_step 5 "注册 openclaw cron 任务" step_cron
run_step 6 "部署 control agent 人设" step_persona
run_step 7 "启动 rsshub 容器" step_rsshub
run_step 8 "验收 doctor" step_acceptance

trap - ERR
report_and_exit 0
