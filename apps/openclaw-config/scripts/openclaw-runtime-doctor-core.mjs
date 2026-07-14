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
  const gatewayPids = distinctPids(snapshot.gatewayListeners);
  const runnerPids = distinctPids(snapshot.cronRunnerListeners);
  const gatewayErrorLines = Array.isArray(snapshot.gatewayErrorLines) ? snapshot.gatewayErrorLines : [];
  const recentRunnerResults = Array.isArray(snapshot.recentRunnerResults) ? snapshot.recentRunnerResults : [];
  const nowMs = Number(snapshot.nowMs ?? Date.now());
  const gatewayErrorWindowMs = Math.max(1, Number(snapshot.gatewayErrorWindowMs ?? 2 * 60_000));

  // task H2 fix round (this task, CRITICAL finding): the doctor is this
  // system's only external observer - if it dies partway through, the
  // operator gets NOTHING (not even the findings already computed), which
  // is strictly worse than an incomplete report. Every check below now runs
  // failure-isolated via runChecksFailureIsolated: a throw from any ONE
  // check becomes an `error` finding scoped to just that check, and every
  // other check still runs and gets reported. Found the hard way:
  // checkAlertsPollerHealth used to call isUsRegularMarketHours unguarded,
  // which throws whenever the current year isn't in the hardcoded NYSE
  // calendar (trading-schedule.mjs) - that alone used to take the whole
  // doctor process down with it, printing nothing at all, at exactly the
  // moment (a genuinely stopped poller) this doctor most needs to speak up.
  const checks = [
    { name: "gateway-listeners", run: () => checkGatewayListeners(gatewayPids) },
    { name: "gateway-restart-storm", run: () => checkGatewayRestartStorm(gatewayErrorLines, nowMs, gatewayErrorWindowMs) },
    { name: "runner-listeners", run: () => checkRunnerListeners(runnerPids) },
    { name: "runner-recent-failures", run: () => checkRecentRunnerFailures(recentRunnerResults) },
    { name: "launchd-jobs", run: () => checkLaunchdJobs(snapshot) },
    { name: "alerts-poller-health", run: () => checkAlertsPollerHealth(snapshot, nowMs) }
  ];

  const findings = runChecksFailureIsolated(checks);

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

// See analyzeOpenClawRuntimeSnapshot's own doc comment above for why this
// exists. Each `check.run()` is expected to return an array of findings (an
// empty array is a legitimate "nothing to report"); if it throws instead,
// that throw becomes its own `error` finding (code
// `doctor.check_failed.<name>`) instead of propagating - propagating even
// once would kill the ENTIRE report, including every finding already
// collected from checks that already ran successfully, and every finding
// from checks still queued after it.
function runChecksFailureIsolated(checks) {
  const findings = [];
  for (const check of checks) {
    try {
      findings.push(...check.run());
    } catch (checkError) {
      findings.push(error(
        `doctor.check_failed.${check.name}`,
        `"${check.name}" 检查项自身抛出异常，已跳过（其余检查项仍照常执行）：${describeError(checkError)}`
      ));
    }
  }
  return findings;
}

function checkGatewayListeners(gatewayPids) {
  const findings = [];
  if (gatewayPids.length === 0) {
    findings.push(error("gateway.not_listening", "18789 没有 OpenClaw gateway 监听进程。"));
  } else if (gatewayPids.length > 1) {
    findings.push(error("gateway.duplicate_listener", `18789 出现多个 gateway 监听 PID：${gatewayPids.join("、")}。`));
  }
  return findings;
}

function checkGatewayRestartStorm(gatewayErrorLines, nowMs, gatewayErrorWindowMs) {
  const findings = [];
  const eaddrinuseLines = gatewayErrorLines
    .filter((line) => /EADDRINUSE|address already in use|Port 18789 is already in use/iu.test(line))
    .filter((line) => isRecentLogLine(line, nowMs, gatewayErrorWindowMs));
  if (eaddrinuseLines.length >= 2) {
    findings.push(error("gateway.restart_storm", `gateway 日志最近仍有 ${eaddrinuseLines.length} 条端口占用/重复启动记录。`));
  }
  return findings;
}

function checkRunnerListeners(runnerPids) {
  const findings = [];
  if (runnerPids.length === 0) {
    findings.push(error("runner.not_listening", "18792 没有 openclaw-cron-runner 监听进程。"));
  } else if (runnerPids.length > 1) {
    findings.push(error("runner.duplicate_listener", `18792 出现多个 runner 监听 PID：${runnerPids.join("、")}。`));
  }
  return findings;
}

function checkRecentRunnerFailures(recentRunnerResults) {
  const findings = [];
  for (const result of latestRunnerResultsByJob(recentRunnerResults).filter((entry) => entry && entry.ok === false).slice(0, 5)) {
    findings.push(error(
      "runner.recent_failure",
      `${result.job ?? "unknown"} 最近失败：${result.error || result.stderrTail || result.file || "未提供错误摘要"}`
    ));
  }
  return findings;
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
// task H2 fix round (this task, install-path unification finding): a pnpm
// alias for install-launchd.sh now exists (`launchd:install-backup-alerts`,
// see package.json and both READMEs' Launchd sections) - the hint below
// names that pnpm command instead of the raw `bash .../install-launchd.sh`
// invocation, for the same reason and consistency with the
// `launchd:install-user` hint an operator would already know.
function checkLaunchdJobs(snapshot) {
  const loaded = new Set(
    (Array.isArray(snapshot.launchdJobLabels) ? snapshot.launchdJobLabels : []).map(String)
  );
  const findings = [];
  for (const job of REQUIRED_LAUNCHD_JOBS) {
    if (!loaded.has(job.label)) {
      findings.push(warn(
        `launchd-jobs.${job.slug}.not_loaded`,
        `launchd 任务 ${job.label} 未加载（launchctl list 未命中）。部署机器上请执行 pnpm launchd:install-backup-alerts 安装；开发机上可以忽略。`
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
      if (isStale) {
        findings.push(...checkStaleHeartbeatMarketHours(lastRun, nowMs));
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

// task H2 fix round (this task, CRITICAL finding): isUsRegularMarketHours
// throws (via trading-schedule.mjs's assertCalendarCoverage) instead of
// returning a boolean whenever `now`'s year isn't in the hardcoded NYSE
// calendar - inevitable at every calendar-year rollover until that table is
// updated for the new year. Left unguarded here, this crashed the ENTIRE
// doctor process (see analyzeOpenClawRuntimeSnapshot's own doc comment) at
// exactly the moment - a stale heartbeat - this check most needs to speak
// up. Isolated into its own helper so the stale-heartbeat finding itself is
// reported (not silently swallowed) even when the market-hours qualifier
// can't be evaluated at all.
function checkStaleHeartbeatMarketHours(lastRun, nowMs) {
  const findings = [];
  let isMarketHours;
  try {
    isMarketHours = isUsRegularMarketHours(new Date(nowMs));
  } catch (calendarError) {
    const year = describeError(calendarError).match(/year (\d{4})/u)?.[1] ?? "当前";
    findings.push(warn(
      "alerts-poller-health.calendar_uncovered",
      `无法判断当前是否处于交易时段：交易日历未覆盖 ${year} 年，请更新 trading-schedule.mjs 中的交易日历。`
    ));
    findings.push(warn(
      "alerts-poller-health.stale_heartbeat_unknown_market_hours",
      `提醒器最近一次运行是 ${lastRun}，距今已超过 30 分钟没有新的 run_log 记录；由于交易日历无法覆盖当前年份，无法判断当前是否处于交易时段来确认这是否异常，请人工核实提醒器状态。`
    ));
    return findings;
  }

  if (isMarketHours) {
    findings.push(warn(
      "alerts-poller-health.stale_heartbeat",
      `提醒器最近一次运行是 ${lastRun}，距今已超过 30 分钟没有新的 run_log 记录，且当前正处于美股常规交易时段——poller 可能已停止运行（launchd 未加载、进程崩溃或系统休眠）。`
    ));
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
