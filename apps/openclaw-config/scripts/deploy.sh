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
# EXIT CODES (round 7, finding K9 - a controller has to be able to tell a
# configuration gap from a deploy regression without reading Chinese prose):
#   0  every step this run was asked to execute exited 0, doctor included
#   1  a step failed; the machine is half-deployed and the ledger says so
#   2  called wrong, or the gateway restart was never acknowledged - NOTHING ran
#   3  配置未就绪: a required variable is unset, refused BEFORE step 0 - NOTHING ran
#   4  a step's receipt could not be written; the acceptance gate cannot see
#      this deploy at all, so nothing it says about it can be trusted
#
# Test seams (used by the sandbox suite, never in production): REPO_ROOT,
# DEPLOY_RUNTIME_ROOT, DEPLOY_SUDO, DEPLOY_LOGIN_SHELL, DEPLOY_NODE.

SCRIPT_DIR="${SCRIPT_DIR:-$(cd "$(dirname "$0")" && pwd)}"
# Round-7 finding K4. `$0` is captured HERE, at the top level, and never read
# again inside a function: this file's shebang is zsh, zsh's FUNCTION_ARGZERO
# makes `$0` the FUNCTION NAME inside a function body, and the one place that
# read it was report_and_exit - so every failing run handed the operator
# `... zsh report_and_exit` as the command to resume with, at the exact moment
# they most needed something pasteable. The `:A` modifier makes it absolute, so
# the printed command works from any working directory.
SCRIPT_PATH="${0:A}"
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

# ---------------------------------------------------------------------------
# Round-7 finding K3. run_step's skip test was `number < FROM_STEP` with no
# upper bound, and report_and_exit printed its all-passed line whenever no step
# had failed. MEASURED against the version at HEAD, in the sandbox suite's own
# fake machine: `DEPLOY_FROM_STEP=9` and `=99` each skipped all nine steps -
# nothing pulled, nothing built, no installer, no doctor, one command run in
# total (the `git rev-parse` for HEAD_SHA above), zero receipts written - and
# then exited 0 printing 「0-8 全部通过……上面已经跑过了」. One typo after a
# step-8 failure was enough to manufacture a successful deploy out of nothing.
#
# A non-numeric value was worse than useless too: `[ 0 -lt abc ]` makes zsh
# abort mid-run rather than refuse up front.
# ---------------------------------------------------------------------------
LAST_STEP=8
case "${FROM_STEP}" in
  ""|*[!0-9]*)
    echo "deploy: DEPLOY_FROM_STEP 必须是 0-${LAST_STEP} 之间的整数，收到的是「${FROM_STEP}」。什么都还没做。" >&2
    exit 2
    ;;
esac
if [ "${FROM_STEP}" -gt "${LAST_STEP}" ]; then
  echo "deploy: DEPLOY_FROM_STEP=${FROM_STEP} 超出范围——最后一步是第 ${LAST_STEP} 步（验收 doctor）。" >&2
  echo "deploy: 什么都还没做。要只跑验收，用 DEPLOY_FROM_STEP=${LAST_STEP}；要重跑整条流程，去掉这个变量。" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# ⚙ 配置预检（round 7, finding K9）。
#
# 读只读实测（mini，2026-07-29）：FEISHU_GROUP_CHAT_ID / PLATFORM_PUBLIC_BASE_URL /
# FEISHU_NOTIFY_CHAT_ID / FEISHU_NOTIFY_OPEN_ID 四个变量全都没配，而这台机器已经
# 有很重的部署痕迹。也就是说：第 0-7 步可以全部成功，第 8 步 doctor 仍然会以
# notification-routing.no_group_chat / no_public_base_url 两条 error 退出 1。
#
# 那个退出 1 语义上是对的（这台机器确实发不出圈子公共报告），但读日志的人——尤其
# 是自动化控制器——会把它读成「部署回退了」。所以这里在第 0 步之前就把它分开：缺配置
# 是 exit 3、并且【一步都不跑】；部署失败是 exit 1、并且机器已经被改了一半。
#
# 检查的这两个变量，正是 doctor 会因之报 error 的那两个（见
# openclaw-runtime-doctor-core.mjs 的 checkNotificationRouting）——不多检也不少检。
# 解析规则镜像 packages/shared-types/src/runtime.ts 的 loadLocalEnv：整行 trim、
# `#` 开头跳过、`KEY=VALUE`、成对的首尾引号去掉、同名后出现的覆盖先出现的；进程环境
# 优先于文件，和 doctor 里 `{...loadLocalEnv, ...process.env}` 同序。
# ---------------------------------------------------------------------------
ENV_FILE="${REPO_ROOT}/.env.local"

config_value() {
  local name="$1"
  local from_env
  from_env="$(printenv "${name}" 2>/dev/null || true)"
  if [ -n "${from_env}" ]; then
    printf "%s" "${from_env}"
    return 0
  fi
  [ -f "${ENV_FILE}" ] || return 0
  awk -v key="${name}" '
    {
      line = $0
      sub(/^[ \t\r]+/, "", line)
      sub(/[ \t\r]+$/, "", line)
      if (line == "" || substr(line, 1, 1) == "#") next
      eq = index(line, "=")
      if (eq < 2) next
      if (substr(line, 1, eq - 1) != key) next
      v = substr(line, eq + 1)
      n = length(v)
      if (n >= 2) {
        first = substr(v, 1, 1); last = substr(v, n, 1)
        if ((first == "\"" && last == "\"") || (first == "'"'"'" && last == "'"'"'")) v = substr(v, 2, n - 2)
      }
      found = v
    }
    END { printf "%s", found }
  ' "${ENV_FILE}"
}

MISSING_CONFIG=""
for required in FEISHU_GROUP_CHAT_ID PLATFORM_PUBLIC_BASE_URL; do
  if [ -z "$(config_value "${required}")" ]; then
    MISSING_CONFIG="${MISSING_CONFIG}${required}
"
  fi
done

if [ -n "${MISSING_CONFIG}" ]; then
  {
    echo "================================================================================"
    echo "配置未就绪 —— 这【不是部署失败】，这台机器上什么都还没有动。"
    echo ""
    echo "下面这些变量在 ${ENV_FILE} 和当前环境里都是空的："
    printf "%s" "${MISSING_CONFIG}" | sed 's/^/  · /'
    echo ""
    echo "它们各自的后果（第 8 步 doctor 会原样报出来）："
    echo "  · FEISHU_GROUP_CHAT_ID —— 圈子群的 chat id。没有它，日报/周报/个股分析这些"
    echo "    公共报告会被投递层直接拒发（sent:false），群里一张卡都收不到。"
    echo "  · PLATFORM_PUBLIC_BASE_URL —— 报告卡上「查看完整报告」按钮的落地地址。没有它，"
    echo "    卡片发出去也点不进任何页面（mini 上填 cloudflared 那条对外地址）。"
    echo ""
    echo "补进 ${ENV_FILE} 之后重跑本脚本即可。"
    echo "确实想先把服务装上、稍后再补配置，就显式写出来："
    echo "  DEPLOY_ALLOW_MISSING_CONFIG=yes DEPLOY_ACK_GATEWAY_RESTART=yes zsh ${SCRIPT_PATH}"
    echo "那样第 0-7 步照跑，第 8 步仍然会红——但它红的是配置，不是部署。"
    echo "================================================================================"
  } >&2
  case "${DEPLOY_ALLOW_MISSING_CONFIG:-}" in
    yes|YES|1|true)
      echo "deploy: 已按 DEPLOY_ALLOW_MISSING_CONFIG 继续——第 8 步预计会因为上面这些变量报 error。" >&2
      ;;
    *)
      exit 3
      ;;
  esac
fi

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
LEDGER_FAILED_STEP=""
LEDGER_FAILED_REASON=""
EXECUTED_STEPS=""
SKIPPED_STEPS=""
SUMMARY=""

# Round-7 finding K1. This used to end in `>/dev/null 2>&1 || true`: the
# writer's stdout, its stderr and its exit code were all discarded.
#
# The reasoning was that bookkeeping must never change a deploy's exit code -
# and that part is still honoured, because the STEP's own exit code has already
# been captured by run_step before this is called. What the old form actually
# did was make "this deploy could not record anything" look exactly like "this
# deploy recorded success". MEASURED (real scripts, real doctor, real writer):
# clean deploy -> `chmod 444 runtime/deploy/steps.jsonl` -> re-run with step 1
# failing -> deploy exits 1 and promises the operator 「验收门（第 8 步）现在也会
# 因为这条失败记录而报错」, and then the doctor exits 0, ok=true, zero errors,
# reading last deploy's nine green rows. The script made a promise it could not
# keep.
#
# So a receipt that cannot be written aborts the deploy with its own exit code
# (4) and its own report - see report_and_exit.
record_step() {
  local ledger_output=""
  local ledger_status=0
  ledger_output="$("${NODE_FOR_LEDGER}" "${SCRIPT_DIR}/deploy-ledger.mjs" record \
    --runtime-root "${RUNTIME_ROOT}" \
    --attempt "${ATTEMPT_ID}" \
    --step "$1" \
    --exit "$2" \
    --head "$3" \
    --started-at "$4" \
    --detail "$5" 2>&1)" || ledger_status=$?
  if [ "${ledger_status}" -ne 0 ]; then
    LEDGER_FAILED_STEP="$1"
    LEDGER_FAILED_REASON="${ledger_output:-deploy-ledger.mjs 退出码 ${ledger_status}，没有输出}"
    return 1
  fi
  return 0
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
    SKIPPED_STEPS="${SKIPPED_STEPS}${number} "
    SUMMARY="${SUMMARY}  第 ${number} 步 ${name}：跳过（本次没有跑，收据还是上一次那份）
"
    return 0
  fi

  echo ""
  echo "── 第 ${number} 步 ${name} ─────────────────────────────────────"
  # NOT `status`: that is a read-only special parameter in zsh (an alias for
  # $?), and this script's shebang is zsh - assigning to it aborted run_step
  # with "read-only variable: status" before any step could be judged.
  local step_status=0
  "$@" || step_status=$?
  EXECUTED_STEPS="${EXECUTED_STEPS}${number} "

  # The receipt first: a step whose outcome was not recorded is worse than a
  # step that failed, because the gate then judges this machine on the PREVIOUS
  # deploy's receipts (finding K1).
  if ! record_step "${number}" "${step_status}" "${HEAD_SHA}" "${started}" "${name}"; then
    SUMMARY="${SUMMARY}  第 ${number} 步 ${name}：退出码 ${step_status}，但这条收据【没能写进部署账本】
"
    if [ "${step_status}" -ne 0 ]; then
      FAILED_STEP="${number}"
      FAILED_NAME="${name}"
    fi
    return 4
  fi

  if [ "${step_status}" -ne 0 ]; then
    FAILED_STEP="${number}"
    FAILED_NAME="${name}"
    SUMMARY="${SUMMARY}  第 ${number} 步 ${name}：退出码 ${step_status} ← 失败，后面的步骤没有执行
"
    return 1
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

  # The ledger failure is reported FIRST and on its own, because it changes what
  # every other line here is worth: with no receipt, the acceptance gate is
  # judging this machine on the previous deploy's rows.
  if [ -n "${LEDGER_FAILED_STEP}" ]; then
    echo ""
    echo "部署第 ${LEDGER_FAILED_STEP} 步的执行结果【没能写进部署账本】：" >&2
    echo "  ${LEDGER_FAILED_REASON}" >&2
    echo "" >&2
    echo "账本文件：${RUNTIME_ROOT}/deploy/steps.jsonl" >&2
    echo "后果：验收门读到的是【上一次部署】留下的那些收据——很可能全是退出码 0。" >&2
    echo "在这个文件重新可写之前，doctor 关于「这次部署」说的任何话都不作数。" >&2
    echo "常见成因是某次 sudo 跑把它变成了 root 属主：" >&2
    echo "  ls -l ${RUNTIME_ROOT}/deploy/steps.jsonl" >&2
    echo "  sudo chown -R \"\$(id -un)\":staff ${RUNTIME_ROOT}/deploy" >&2
    echo "修好之后从这一步继续：" >&2
    echo "  DEPLOY_ACK_GATEWAY_RESTART=yes DEPLOY_FROM_STEP=${LEDGER_FAILED_STEP} zsh ${SCRIPT_PATH}" >&2
    echo "（doctor 自己也会报 deploy-ledger.unwritable —— 账本写不进去的机器不会拿到绿灯。）" >&2
    echo "════════════════════════════════════════════════════════════════"
    exit 4
  fi

  if [ -n "${FAILED_STEP}" ]; then
    echo ""
    echo "部署在第 ${FAILED_STEP} 步（${FAILED_NAME}）失败，后面的步骤【一步都没有执行】。" >&2
    echo "这台机器现在处于半完成状态：请照上面那一步自己打印的原因修掉，然后从该步继续：" >&2
    echo "  DEPLOY_ACK_GATEWAY_RESTART=yes DEPLOY_FROM_STEP=${FAILED_STEP} zsh ${SCRIPT_PATH}" >&2
    echo "验收门（第 8 步）现在也会因为这条失败记录而报错，不会给出绿灯：" >&2
    echo "  pnpm openclaw:runtime:doctor" >&2
    echo "════════════════════════════════════════════════════════════════"
    exit 1
  fi

  # Round-7 finding K3: say what actually ran. The old wording was the constant
  # string 「0-8 全部通过」, printed whenever no step had failed - including the
  # run where every step was skipped, and every legitimate resume from step N.
  echo ""
  if [ -z "${EXECUTED_STEPS}" ]; then
    echo "本次运行【一步都没有执行】，因此没有任何东西可以说是通过了。" >&2
    echo "════════════════════════════════════════════════════════════════"
    exit 2
  fi
  echo "本次执行的步骤：第 ${EXECUTED_STEPS%% } 步 —— 全部退出 0。"
  if [ -n "${SKIPPED_STEPS}" ]; then
    echo "按 DEPLOY_FROM_STEP=${FROM_STEP} 跳过的步骤：第 ${SKIPPED_STEPS%% } 步 —— 这些【本次没有跑】，"
    echo "账本里留的是它们上一次的收据；第 8 步 doctor 会拿当前 commit 去核对那些收据。"
  fi
  echo "验收以第 8 步（doctor）的退出码为准，它刚刚以 0 结束。"
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
