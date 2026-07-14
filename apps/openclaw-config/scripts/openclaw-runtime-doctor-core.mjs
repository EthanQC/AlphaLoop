import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { openTradingDatabase } from "../../../packages/shared-types/dist/index.js";
import { consecutiveFailureCount, lastRunAt } from "./job-run-log.mjs";
import { CRON_JOB_MARKET_ALERTS } from "./openclaw-cron-runner-state.mjs";
import { isUsRegularMarketHours } from "./trading-schedule.mjs";

// task H2 (Phase 2.5 hardening): the two launchd jobs install-launchd.sh
// wires up (see that script) - a dev machine legitimately runs neither, so
// missing either is a warn, not a fail (see `warn()` below - only "error"
// severity flips `ok` to false).
const REQUIRED_LAUNCHD_JOBS = [
  { label: "com.alphaloop.daily-backup", slug: "daily-backup" },
  { label: "com.alphaloop.market-alerts", slug: "market-alerts" }
];

// How stale the market-alerts poller's run_log heartbeat can get before the
// doctor treats it as "stopped ticking" - only checked while
// isUsRegularMarketHours(now) is true (outside market hours the poller
// legitimately skips every tick, see market-alerts-poll.mjs's off-hours
// early return, so a long gap there is expected, not a symptom).
const ALERTS_STALE_HEARTBEAT_MS = 30 * 60_000;

// Mirrors market-alerts-poll.mjs's own ESCALATION_THRESHOLD - by the time the
// poller's own escalation card would have fired, the doctor should already
// be calling this a hard failure too (independent confirmation via a
// different read path, not just trusting the poller told someone).
const ALERTS_CONSECUTIVE_FAILURE_THRESHOLD = 3;

export function analyzeOpenClawRuntimeSnapshot(snapshot = {}) {
  const findings = [];
  const gatewayPids = distinctPids(snapshot.gatewayListeners);
  const runnerPids = distinctPids(snapshot.cronRunnerListeners);
  const gatewayErrorLines = Array.isArray(snapshot.gatewayErrorLines) ? snapshot.gatewayErrorLines : [];
  const recentRunnerResults = Array.isArray(snapshot.recentRunnerResults) ? snapshot.recentRunnerResults : [];
  const nowMs = Number(snapshot.nowMs ?? Date.now());
  const gatewayErrorWindowMs = Math.max(1, Number(snapshot.gatewayErrorWindowMs ?? 2 * 60_000));

  if (gatewayPids.length === 0) {
    findings.push(error("gateway.not_listening", "18789 没有 OpenClaw gateway 监听进程。"));
  } else if (gatewayPids.length > 1) {
    findings.push(error("gateway.duplicate_listener", `18789 出现多个 gateway 监听 PID：${gatewayPids.join("、")}。`));
  }

  const eaddrinuseLines = gatewayErrorLines
    .filter((line) => /EADDRINUSE|address already in use|Port 18789 is already in use/iu.test(line))
    .filter((line) => isRecentLogLine(line, nowMs, gatewayErrorWindowMs));
  if (eaddrinuseLines.length >= 2) {
    findings.push(error("gateway.restart_storm", `gateway 日志最近仍有 ${eaddrinuseLines.length} 条端口占用/重复启动记录。`));
  }

  if (runnerPids.length === 0) {
    findings.push(error("runner.not_listening", "18792 没有 openclaw-cron-runner 监听进程。"));
  } else if (runnerPids.length > 1) {
    findings.push(error("runner.duplicate_listener", `18792 出现多个 runner 监听 PID：${runnerPids.join("、")}。`));
  }

  for (const result of latestRunnerResultsByJob(recentRunnerResults).filter((entry) => entry && entry.ok === false).slice(0, 5)) {
    findings.push(error(
      "runner.recent_failure",
      `${result.job ?? "unknown"} 最近失败：${result.error || result.stderrTail || result.file || "未提供错误摘要"}`
    ));
  }

  findings.push(...checkLaunchdJobs(snapshot));
  findings.push(...checkAlertsPollerHealth(snapshot, nowMs));

  if (findings.length === 0) {
    findings.push({
      severity: "info",
      code: "runtime.steady",
      message: "gateway 与 cron-runner 均为单实例监听，最近 runner 结果没有失败。"
    });
  }

  return {
    ok: !findings.some((finding) => finding.severity === "error"),
    findings
  };
}

function distinctPids(list) {
  return Array.from(new Set((Array.isArray(list) ? list : [])
    .map((entry) => Number(entry?.pid))
    .filter((pid) => Number.isFinite(pid) && pid > 0)));
}

function latestRunnerResultsByJob(results) {
  const byJob = new Map();
  for (const result of results) {
    const job = String(result?.job ?? result?.file ?? "unknown");
    if (!byJob.has(job)) {
      byJob.set(job, result);
    }
  }
  return Array.from(byJob.values());
}

function isRecentLogLine(line, nowMs, windowMs) {
  const timestamp = String(line ?? "").match(/^(\d{4}-\d{2}-\d{2}T[^\s]+)/u)?.[1];
  if (!timestamp) {
    return true;
  }
  const parsed = Date.parse(timestamp);
  return !Number.isFinite(parsed) || nowMs - parsed <= windowMs;
}

function error(code, message) {
  return { severity: "error", code, message };
}

// A "warn" finding is reported to the operator but, unlike "error", never
// flips `ok` to false (see the `ok` computation above, which only looks for
// "error") - for conditions that are noteworthy but legitimately normal on
// some machines (a dev box with no launchd jobs installed at all; a fresh
// install whose poller has simply never run yet).
function warn(code, message) {
  return { severity: "warn", code, message };
}

// task H2 (Phase 2.5 hardening) - "launchd-jobs" check: is each job
// install-launchd.sh installs actually loaded (per `launchctl list`)? Missing
// either is only a warn (see REQUIRED_LAUNCHD_JOBS's own doc comment) with an
// actionable hint naming the real install command - NOT `pnpm
// launchd:install-user` (that pnpm script installs a completely different,
// unrelated set of report/stock-analysis jobs via install-user-schedules.mjs;
// pointing at it here would send an operator chasing the wrong script).
function checkLaunchdJobs(snapshot) {
  const loaded = new Set(
    (Array.isArray(snapshot.launchdJobLabels) ? snapshot.launchdJobLabels : []).map(String)
  );
  const findings = [];
  for (const job of REQUIRED_LAUNCHD_JOBS) {
    if (!loaded.has(job.label)) {
      findings.push(warn(
        `launchd-jobs.${job.slug}.not_loaded`,
        `launchd 任务 ${job.label} 未加载（launchctl list 未命中）。部署机器上请执行 bash apps/openclaw-config/scripts/install-launchd.sh 安装；开发机上可以忽略。`
      ));
    }
  }
  return findings;
}

// task H2 (Phase 2.5 hardening) - "alerts-poller-health" check, covering two
// independent signals for "is the market-alerts poller actually alive":
//
//   1. The out-of-band runtime/market-alerts/ALERTER-DOWN.json artifact (see
//      market-alerts-poll.mjs's markAlerterDown/clearAlerterDown) - its mere
//      EXISTENCE means a card escalation could not reach anyone AND the
//      poller has already confirmed it cannot report that through Feishu
//      itself (see that module's header). Checked first and with NO db
//      access at all, specifically so this still fires when snapshot.dbPath
//      is missing/unreachable - the artifact exists precisely to survive a
//      broken db.
//   2. run_log's own market-alerts history (heartbeat staleness during US
//      market hours, and the hard-failure streak) - requires opening the
//      trading db, so this half degrades to its own fail (not a throw) if
//      that open itself fails.
function checkAlertsPollerHealth(snapshot, nowMs) {
  const findings = [];

  const artifact = readAlerterDownArtifact(snapshot.runtimeRoot);
  if (artifact) {
    findings.push(error(
      "alerts-poller-health.alerter_down",
      `提醒器已确认失联（runtime/market-alerts/ALERTER-DOWN.json 存在）：`
        + `since=${artifact.since ?? "未知"}，reason=${artifact.reason ?? "未知"}，`
        + `连续失败次数=${artifact.consecutiveFailures ?? "未知"}。一次升级卡片投递失败且提醒器已确认无法通过飞书上报，请立即检查飞书通道与提醒器日志。`
    ));
  }

  if (!snapshot.dbPath) {
    // No db path was even supplied (e.g. a caller that only cares about the
    // artifact check above, or an existing test that predates this check) -
    // skip the run_log half entirely rather than report a false "unreachable".
    return findings;
  }

  let db;
  try {
    db = openTradingDatabase(snapshot.dbPath);
  } catch (openError) {
    findings.push(error(
      "alerts-poller-health.db_unreachable",
      `无法打开交易数据库以检查提醒器 run_log：${describeError(openError)}`
    ));
    return findings;
  }

  try {
    const lastRun = lastRunAt(db, CRON_JOB_MARKET_ALERTS);
    if (lastRun === null) {
      findings.push(warn("alerts-poller-health.never_ran", "提醒器从未运行过（run_log 中没有 market-alerts 记录）。"));
    } else {
      const lastRunMs = Date.parse(lastRun);
      const isStale = Number.isFinite(lastRunMs) && nowMs - lastRunMs > ALERTS_STALE_HEARTBEAT_MS;
      if (isStale && isUsRegularMarketHours(new Date(nowMs))) {
        findings.push(warn(
          "alerts-poller-health.stale_heartbeat",
          `提醒器最近一次运行是 ${lastRun}，距今已超过 30 分钟没有新的 run_log 记录，且当前正处于美股常规交易时段——poller 可能已停止运行（launchd 未加载、进程崩溃或系统休眠）。`
        ));
      }
    }

    const consecutiveFailures = consecutiveFailureCount(db, CRON_JOB_MARKET_ALERTS);
    if (consecutiveFailures >= ALERTS_CONSECUTIVE_FAILURE_THRESHOLD) {
      findings.push(error(
        "alerts-poller-health.consecutive_failures",
        `提醒器连续失败 ${consecutiveFailures} 次（阈值 ${ALERTS_CONSECUTIVE_FAILURE_THRESHOLD}）。`
      ));
    }
  } finally {
    db.close();
  }

  return findings;
}

function readAlerterDownArtifact(runtimeRoot) {
  if (!runtimeRoot) {
    return null;
  }
  const path = join(runtimeRoot, "market-alerts", "ALERTER-DOWN.json");
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Corrupt/unreadable artifact - still report it (its mere existence is
    // the signal), just without the fields a healthy artifact would carry.
    return { since: null, reason: "ALERTER-DOWN.json 存在但内容无法解析", consecutiveFailures: null };
  }
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}
