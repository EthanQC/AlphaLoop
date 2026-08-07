import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { formatLocalDate, parseBackupFileDate } from "./backup-trading-data.mjs";
import {
  judgeDeployLedger,
  lastSuccessfulInstallAt,
  probeDeployLedgerWritable,
  readDeployLedgerResult,
  REQUIRED_DEPLOY_STEPS
} from "./deploy-ledger.mjs";
import { readLaunchdOwnership } from "./install-launchd-ownership.mjs";
import { consecutiveFailureCount, lastRunAt } from "./job-run-log.mjs";
import {
  describeLaunchdExit,
  judgeLaunchdRuntime,
  LAUNCHD_SERVICE_HEALTH,
  parseLaunchdPrint,
  RESIDENT_CRASH_LOOP_RUNS,
  RESIDENT_CRASH_LOOP_WINDOW_MS,
  toFiniteNumber
} from "./launchd-health.mjs";
import { newsEngineHealthStats } from "./news-store.mjs";
import {
  computeStockAnalysisFreshness,
  describeStockAnalysisFreshness
} from "./stock-analysis-freshness.mjs";
import { buildManagedOpenClawCronJobs } from "./openclaw-cron-jobs.mjs";
import { CRON_JOB_MARKET_ALERTS } from "./openclaw-cron-runner-state.mjs";
import {
  SCHEDULED_JOB_ESCALATION_THRESHOLD,
  SCHEDULED_LAUNCHD_JOBS
} from "./scheduled-job-heartbeat.mjs";
import { getZonedParts, isUsRegularMarketHours } from "./trading-schedule.mjs";

// Round 6 moved the residency contract and the judgement built on it into
// launchd-health.mjs so install-system-daemons.sh can run the SAME check before
// it archives a service's fallback (finding S3e: it used to verify with
// `launchctl print`, which proves registration, not work). Re-exported here
// because this module is the published surface the suite and the CLI read it
// from.
export { LAUNCHD_SERVICE_HEALTH, RESIDENT_CRASH_LOOP_RUNS, RESIDENT_CRASH_LOOP_WINDOW_MS };

// The command that actually installs each domain's jobs. Round-3 finding F2:
// the old hint named `pnpm launchd:install-backup-alerts` for every missing
// job, but after ac741d8 that script installs ONLY user-scoped labels (it
// filters on install-launchd-ownership.txt) - so for the six promoted
// services the doctor was printing a command that installs them nowhere.
const LAUNCHD_INSTALL_COMMAND = {
  system: "sudo zsh apps/openclaw-config/scripts/install-system-daemons.sh",
  user: "pnpm launchd:install-backup-alerts"
};

// task H2 (Phase 2.5 hardening), extended in Phase 3 Task 8 and Phase 4 Task
// 8, rebuilt for round-3 finding F2: which jobs must be loaded, and IN WHICH
// LAUNCHD DOMAIN, now comes straight from install-launchd-ownership.txt - the
// same manifest install-system-daemons.sh and install-launchd.sh are checked
// against - instead of a fourth hand-maintained copy of the list. The list
// used to name four labels and no domain at all, which is how it silently
// went wrong twice over: it missed cron-runner / official-paper poll+pnl /
// gateway / broker-executor entirely, and it compared the remaining ones
// against `launchctl list`, which only ever reports the caller's own
// gui/$UID domain.
//
// A dev machine legitimately runs none of these, so "not loaded anywhere" is
// a warn, not a fail (see `warn()` below - only "error" severity flips `ok`
// to false). Being loaded in the WRONG domain is a different matter and IS an
// error: that is the two-owners-for-one-label race the manifest exists to
// prevent (two broker-executors on one trading database), and no dev machine
// gets into that state by accident.
export const REQUIRED_LAUNCHD_JOBS = buildRequiredLaunchdJobs();

function buildRequiredLaunchdJobs(rows = readLaunchdOwnership()) {
  const jobs = rows
    .filter((row) => row.scope === "system" || row.scope === "user")
    .map((row) => ({ label: row.label, domain: row.scope, slug: launchdJobSlug(row.label) }));
  // A slug is only a display/finding-code convenience; if two labels ever
  // shortened to the same one, fall back to the full label for BOTH rather
  // than emitting two findings that look like one job reported twice.
  const slugCounts = new Map();
  for (const job of jobs) {
    slugCounts.set(job.slug, (slugCounts.get(job.slug) ?? 0) + 1);
  }
  return jobs.map((job) => (slugCounts.get(job.slug) > 1 ? { ...job, slug: job.label } : job));
}

// Strips the shared reverse-DNS prefixes so a finding code reads
// `launchd-jobs.platform-app.not_loaded` rather than
// `launchd-jobs.com.alphaloop.platform-app.not_loaded`. Longest prefix first:
// com.openclaw.system.trading. must win over com.openclaw. .
function launchdJobSlug(label) {
  return String(label)
    .replace(/^ai\.openclaw\.system\./u, "")
    .replace(/^com\.openclaw\.system\.trading\./u, "")
    .replace(/^com\.openclaw\.trading\./u, "")
    .replace(/^com\.openclaw\./u, "")
    .replace(/^com\.alphaloop\./u, "");
}

// Round-3 finding F2 - the launchd probe itself, living here (rather than in
// the CLI) purely so the test suite can run THIS function, the one the doctor
// actually calls, against a real `launchctl`.
//
// `launchctl list` answers only for the CALLER's own domain (gui/$UID).
// Verified on the mini and on this laptop: a /Library/LaunchDaemons job that
// is loaded and running does not appear in its output at all, while
// `launchctl print system/<label>` exits 0 and prints `state = running`, and
// exits 113 for a label that is not there. So each domain has to be asked
// separately.
//
// Both domains are probed for EVERY required label, not just the one the
// ownership manifest expects: "loaded, but in the wrong domain" is a real and
// dangerous state (two owners writing one trading database) and it is
// invisible to a probe that only looks where the label is supposed to be. It
// is also the state a machine sits in between running the retire step and the
// install step of the deploy runbook.
// Round-4 finding I5: this used to return only `state`, and nothing ever
// asserted on it - so eight bootstrapped-but-crash-looping daemons produced
// zero findings. It now returns the whole runtime picture `launchctl print`
// already hands us for free in the SAME call: `last exit code`, `last exit
// reason`, `pid`, `runs`, and the job's own `stderr path`. The stderr path
// especially: naming the log file in a finding by reading it back out of
// launchd means the doctor can never point at a stale path a later installer
// change moved, which a hardcoded per-label table here inevitably would.
export function readLaunchdJobStates(requiredJobs = REQUIRED_LAUNCHD_JOBS, launchctl = runLaunchctl) {
  const userLabels = readUserDomainLaunchdLabels(launchctl);
  const uid = process.getuid?.();
  return requiredJobs.map((job) => {
    const loadedDomains = [];
    let userDetail = null;
    let systemDetail = null;

    if (userLabels.has(job.label)) {
      loadedDomains.push("user");
      userDetail = uid === undefined
        ? {
          state: "unknown",
          lastExitCode: null,
          lastExitReason: null,
          lastTerminatingSignal: null,
          pid: null,
          runs: null,
          stderrPath: null
        }
        : readLaunchdJobDetail(`gui/${uid}/${job.label}`, launchctl);
    }
    systemDetail = readLaunchdJobDetail(`system/${job.label}`, launchctl);
    if (systemDetail !== null) {
      loadedDomains.push("system");
    }

    // Prefer the detail from the domain that is supposed to own the job, so
    // a correctly installed machine reports the state that matters.
    const detail = (job.domain === "system" ? systemDetail ?? userDetail : userDetail ?? systemDetail) ?? null;

    return {
      label: job.label,
      expectedDomain: job.domain,
      loadedDomains,
      state: detail?.state ?? null,
      lastExitCode: detail?.lastExitCode ?? null,
      lastExitReason: detail?.lastExitReason ?? null,
      // Round-6 finding S3c: the line launchd prints INSTEAD of `last exit
      // code` when the job died on a signal. Carried through the snapshot so
      // the runtime judgement can see it at all.
      lastTerminatingSignal: detail?.lastTerminatingSignal ?? null,
      pid: detail?.pid ?? null,
      runs: detail?.runs ?? null,
      stderrPath: detail?.stderrPath ?? null
    };
  });
}

// task H2 (Phase 2.5 hardening): labels of every launchd job currently loaded
// for THIS USER, per `launchctl list`. Its columns are PID\tStatus\tLabel
// (PID is "-" for a job that is loaded but not currently running) - the label
// has no internal whitespace, so grabbing the last whitespace-separated token
// off each line is enough; the header row ("PID Status Label") parses to a
// harmless "Label" entry that never matches a real job name.
function readUserDomainLaunchdLabels(launchctl) {
  return new Set(
    String(launchctl(["list"]) ?? "")
      .split(/\r?\n/u)
      .map((line) => line.trim().split(/\s+/u).at(-1))
      .filter(Boolean)
  );
}

// Returns the job's runtime detail when it exists in that domain, `null` when
// it does not - so "exists" and "is currently executing" stay distinguishable
// (a periodic job between runs is legitimately loaded and not running, which
// must not be reported as missing).
//
// The parsing itself lives in launchd-health.mjs (round 6), because
// install-system-daemons.sh now runs the same reader over the same output
// before it archives anything. `last exit code` is deliberately allowed to be
// ABSENT rather than defaulted to 0, and a signal death is read out of
// `last terminating signal` - see that module for both measurements.
function readLaunchdJobDetail(target, launchctl) {
  const output = launchctl(["print", target]);
  if (output === null) {
    return null;
  }
  return parseLaunchdPrint(output);
}

// Round-4 finding I5 (b): every db-backed check here used to call
// openTradingDatabase, which runs `migrate(db)` - i.e. a HEALTH CHECK could
// migrate the schema of the live trading database, and on a machine that had
// never run anything it CREATED runtime/trading.sqlite from scratch and then
// reported on the empty database it had just made. A doctor must observe the
// system, not change it.
//
// This opens the same file `readOnly: true`, which SQLite enforces at the
// engine level (an INSERT on this handle fails with "attempt to write a
// readonly database"), and refuses to open a path that does not exist rather
// than creating it. Verified on this Node build (v25.8.1, node:sqlite): the
// read-only handle reads a WAL database written by another process, blocks
// writes, and throws `unable to open database file` for a missing path.
//
// Honest limit, not fixable from here: reading a WAL database still makes
// SQLite materialise the `-shm`/`-wal` sidecar files if they are absent
// (they exist permanently on the mini, where the services hold the database
// open). That is inherent to every WAL reader; the database file itself, its
// schema and its rows are untouched.
const DOCTOR_DB_MISSING = "DOCTOR_DB_MISSING";

function openTradingDatabaseReadOnly(dbPath) {
  if (!existsSync(dbPath)) {
    const missing = new Error(`交易数据库文件不存在：${dbPath}`);
    missing.code = DOCTOR_DB_MISSING;
    throw missing;
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

// Runs `read(db)` against a read-only handle and turns every failure into a
// finding instead of a throw. The open itself is lazy in node:sqlite (a
// corrupt file opens fine and fails on first query), so the QUERY has to be
// inside the same try as the open - otherwise a garbage trading.sqlite would
// escape as an unhandled throw and only be caught by the outer per-check
// isolation, losing the specific `db_unreachable` code an operator greps for.
function withReadOnlyTradingDb(dbPath, codePrefix, subject, read) {
  let db;
  try {
    db = openTradingDatabaseReadOnly(dbPath);
    return read(db);
  } catch (dbError) {
    if (dbError?.code === DOCTOR_DB_MISSING) {
      // A machine where nothing has ever opened the trading database. Not an
      // error: the doctor used to CREATE the file here, which manufactured
      // the very "everything is fine, the table is just empty" answer it then
      // reported.
      return [warn(
        `${codePrefix}.db_missing`,
        `交易数据库尚未创建（${dbPath}），无法检查${subject}。部署机器上这说明所有服务都还没跑过；开发机上属正常。`
      )];
    }
    return [error(
      `${codePrefix}.db_unreachable`,
      `无法以只读方式读取交易数据库以检查${subject}：${describeError(dbError)}`
    )];
  } finally {
    db?.close();
  }
}

// `null` on a non-zero exit, which for `launchctl print` IS the answer ("no
// such job in this domain") and must not be flattened into an empty string.
function runLaunchctl(args) {
  try {
    return execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

// Phase 3 Task 8 - "platform-app-health" check: platform-app is a KeepAlive
// server (unlike the periodic backup/alerts jobs above), so "is it loaded"
// is a weaker signal than "does its /health endpoint actually answer" - this
// check hits that endpoint directly. Port mirrors src/index.ts's own
// `process.env.PLATFORM_APP_PORT ?? 4314` fallback exactly, so the doctor
// checks whatever port the real process would actually bind to.
const PLATFORM_APP_HEALTH_DEFAULT_PORT = 4314;
const PLATFORM_APP_HEALTH_TIMEOUT_MS = 1500;
const MEMORYD_MCP_DEFAULT_URL = "http://127.0.0.1:8766/mcp";
const MEMORYD_MCP_HEALTH_TIMEOUT_MS = 1500;

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

// Phase 4 Task 8 (news engine deployment wiring) - "rsshub-health" check:
// mirrors news-sources.mjs's own DEFAULT_RSSHUB_BASE_URL / .env.local.example's
// documented default (both `http://127.0.0.1:1200`) rather than importing
// that module directly - news-sources.mjs pulls in report-news.mjs/
// _longbridge.mjs's whole module graph (including _longbridge.mjs's
// module-load-time loadLocalEnv/mkdirSync side effects), which this doctor
// has no reason to trigger just to read one constant. Same reasoning as
// checkPlatformAppHealth's own PLATFORM_APP_HEALTH_DEFAULT_PORT above:
// mirror the value with a comment, don't import the module.
const RSSHUB_HEALTH_DEFAULT_BASE_URL = "http://127.0.0.1:1200";
const RSSHUB_HEALTH_TIMEOUT_MS = 1500;
// The real, one-time P10 ignition command that creates the container this
// check is probing (see apps/openclaw-config/launchd/com.alphaloop.rsshub.
// plist.template's own header comment) - named in the unreachable warning so
// an operator who has never run P10 yet gets the actual next step, not just
// "it's down".
const RSSHUB_P10_CONTAINER_COMMAND = "docker run -d --name rsshub -p 127.0.0.1:1200:1200 diygod/rsshub";

// Phase 4 Task 8 - "news-engine-health" check: news_events going quiet for
// this long, while the table genuinely already has data (source_count > 0
// rows exist), means the collection pipeline (RSSHub/Finnhub/openclaw cron)
// has silently stopped - as opposed to a fresh install that has simply never
// collected anything yet (eventCount === 0, handled as "nothing to report").
const NEWS_ENGINE_STALE_THRESHOLD_MS = 48 * 60 * 60_000;

// "login-delivery-health" (2026-07-30, J4 follow-up) --------------------------
//
// How far back the check compares login_send_log reservations against
// login_delivery_log outcomes. 24h mirrors routes/login.ts's PRUNE_AGE_MS -
// both tables are pruned on that horizon at the send sites, so a wider window
// would only compare against rows that may already be gone.
const LOGIN_DELIVERY_WINDOW_MS = 24 * 60 * 60_000;
// A reservation younger than this may simply still be in flight (the send is
// out of band and a slow Feishu call takes seconds, not minutes) - it is not
// yet "a reservation that never got an outcome".
const LOGIN_DELIVERY_SETTLE_GRACE_MS = 5 * 60_000;
// Mirrors routes/login.ts's LEGACY_SYSTEM_MEMBER_ID (itself mirroring
// identity.ts's, per that codebase's re-declare convention): the v7 migration
// placeholder is never a person and never logs in.
const LOGIN_LEGACY_SYSTEM_MEMBER_ID = "__legacy_system__";

// Mirrors shared-types database.ts's hashThrottleKey("email", ...) - a sha256
// of `email:<trimmed, lowercased address>` - rather than importing dist (this
// module deliberately imports only siblings and node builtins; same reasoning
// as PLATFORM_APP_HEALTH_DEFAULT_PORT above). The equivalence is not taken on
// faith: openclaw-runtime-doctor-login-delivery.test.ts seeds login_send_log
// through the REAL handleRequestCode and this check only finds those rows if
// this replica produces the same hash.
function loginEmailKeyHash(email) {
  return createHash("sha256").update(`email:${String(email).trim().toLowerCase()}`).digest("hex");
}

export async function analyzeOpenClawRuntimeSnapshot(snapshot = {}) {
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
  //
  // Phase 3 Task 8: "platform-app-health" is the first check that needs a
  // network round-trip (a GET against platform-app's /health), so it - and
  // therefore this whole function and runChecksFailureIsolated below - had
  // to become async. Every other check here is still a plain synchronous
  // function; `await`-ing a non-promise return value is a no-op, so mixing
  // sync and async check.run()s in the same loop is safe.
  const checks = [
    { name: "gateway-listeners", run: () => checkGatewayListeners(gatewayPids) },
    { name: "gateway-restart-storm", run: () => checkGatewayRestartStorm(gatewayErrorLines, nowMs, gatewayErrorWindowMs) },
    { name: "runner-listeners", run: () => checkRunnerListeners(runnerPids) },
    { name: "runner-recent-failures", run: () => checkRecentRunnerFailures(recentRunnerResults) },
    { name: "launchd-jobs", run: () => checkLaunchdJobs(snapshot, nowMs) },
    { name: "alerts-poller-health", run: () => checkAlertsPollerHealth(snapshot, nowMs) },
    { name: "scheduled-job-heartbeat", run: () => checkScheduledJobHeartbeats(snapshot, nowMs) },
    { name: "platform-app-health", run: () => checkPlatformAppHealth(snapshot) },
    { name: "memoryd-health", run: () => checkMemorydHealth(snapshot) },
    { name: "broker-executor-health", run: () => checkBrokerExecutorHealth(snapshot) },
    { name: "daily-backup-health", run: () => checkDailyBackupHealth(snapshot, nowMs) },
    { name: "official-paper-health", run: () => checkOfficialPaperHealth(snapshot, nowMs) },
    { name: "stock-analysis-health", run: () => checkStockAnalysisHealth(snapshot, nowMs) },
    { name: "rsshub-health", run: () => checkRsshubHealth(snapshot) },
    { name: "news-engine-health", run: () => checkNewsEngineHealth(snapshot, nowMs) },
    { name: "control-persona", run: () => checkControlPersona(snapshot) },
    // Round 6 - the deploy path's own four checks. The first two are about the
    // deploy that produced this machine (did every step succeed, is the code
    // here the code that was pushed); the last two are about product surfaces
    // that no launchd probe can see (the five report cron jobs, and where a
    // report card actually lands).
    { name: "deploy-ledger", run: () => checkDeployLedger(snapshot) },
    { name: "deploy-checkout", run: () => checkDeployCheckout(snapshot) },
    { name: "launchd-plists", run: () => checkStrayUserPlists(snapshot) },
    { name: "openclaw-cron", run: () => checkOpenClawCronJobs(snapshot) },
    { name: "notification-routing", run: () => checkNotificationRouting(snapshot) },
    // 2026-07-30 (J4 follow-up): a broken login-code delivery is invisible to
    // members BY DESIGN (anti-enumeration), and its Feishu alert can ride the
    // very channel that failed - this is the observer that needs neither.
    { name: "login-delivery-health", run: () => checkLoginDeliveryHealth(snapshot, nowMs) }
  ];

  const findings = await runChecksFailureIsolated(checks);

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
//
// Phase 3 Task 8: `await`-ed rather than plain-called so a check.run() that
// returns a Promise (platform-app-health) is resolved - and a REJECTED
// promise from one is caught by the same try/catch as a synchronous throw -
// before its findings are spread into the shared array.
async function runChecksFailureIsolated(checks) {
  const findings = [];
  for (const check of checks) {
    try {
      findings.push(...(await check.run()));
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

// "launchd-jobs" check, rewritten for round-3 finding F2 (verified on the
// mini and locally: a loaded, running system daemon is INVISIBLE to
// `launchctl list` - that command only reports the caller's own gui/$UID
// domain - while `launchctl print system/<label>` returns 0 and prints
// `state = running`; a label that does not exist there exits 113). The old
// check compared every required label against `launchctl list` alone, so
// after ac741d8 promoted six services to /Library/LaunchDaemons it reported
// them missing forever, on a correctly installed machine, and told the
// operator to run a script that no longer installs them.
//
// Input is `snapshot.launchdJobs`: one row per required job, carrying the
// domains it was ACTUALLY found loaded in (see readLaunchdJobStates in
// openclaw-runtime-doctor.mjs, which probes both domains). Three outcomes:
//
//   loaded in the expected domain              -> nothing (plus `state` is
//                                                 carried in the snapshot for
//                                                 the operator to eyeball)
//   loaded nowhere                             -> warn + the install command
//                                                 for ITS domain
//   loaded in the other domain (or in both)    -> error: two owners for one
//                                                 label is the exact race
//                                                 install-launchd-ownership.txt
//                                                 exists to prevent
function checkLaunchdJobs(snapshot, nowMs) {
  const rows = Array.isArray(snapshot.launchdJobs) ? snapshot.launchdJobs : [];
  const byLabel = new Map(rows.map((row) => [String(row?.label), row]));
  const findings = [];
  // Round-7 finding K6: a restart COUNT needs the window it happened in, and
  // the window starts at the install that reset the counter - the newest
  // successful step-3 receipt. Unknown here (no ledger) means the count cannot
  // be called a loop; see judgeLaunchdRuntime.
  const installedAt = lastSuccessfulInstallAt(readLedgerEntries(snapshot));

  for (const job of REQUIRED_LAUNCHD_JOBS) {
    const row = byLabel.get(job.label);
    if (!row) {
      // The probe never ran for this label (an older caller, or a launchctl
      // that could not be executed at all). Say so instead of silently
      // treating "we did not look" as "it is fine".
      findings.push(warn(
        `launchd-jobs.${job.slug}.unknown`,
        `未能探测 launchd 任务 ${job.label} 的加载状态（快照里没有这条记录），无法判断它是否在运行。`
      ));
      continue;
    }

    const loadedIn = (Array.isArray(row.loadedDomains) ? row.loadedDomains : []).map(String);
    const install = LAUNCHD_INSTALL_COMMAND[job.domain];
    const domainLabel = job.domain === "system" ? "系统域 /Library/LaunchDaemons" : "用户域 ~/Library/LaunchAgents";

    if (loadedIn.length === 0) {
      // Round-6 finding S3a - the reason this gate could not fail.
      //
      // "Installed nowhere" used to be a warn unconditionally, with the
      // reasoning "a dev machine legitimately runs none of these". That
      // reasoning is about the MACHINE, not about the check - and it was applied
      // to every machine. Measured: four labels held in no domain at all,
      // installers exiting 1 and saying so, and this gate answering ok=true,
      // exit 0.
      //
      // So the severity now follows the machine, exactly like the loopback
      // probes' does (see probeSeverityFor). On a box that has ever deployed -
      // it has a deploy ledger, or some of these labels ARE loaded, or a plist
      // for one of them is sitting on disk - "this service is installed
      // nowhere" is a deployment that did not finish, not a dev-box default.
      const severity = deployTargetSeverityFor(snapshot);
      findings.push(severity(
        `launchd-jobs.${job.slug}.not_loaded`,
        `launchd 任务 ${job.label} 未加载（${domainLabel} 与另一个域都没有命中）。`
          + (severity === error
            ? `这台机器已经部署过（${describeDeployFootprint(snapshot)}），所以这不是"开发机没装"，`
              + `而是这个服务此刻【一个都没在跑】。请执行 ${install}，并按它打印的失败原因修到它自己退出 0 为止。`
            : `部署机器上请执行 ${install} 安装；这台机器没有任何部署痕迹，开发机上可以忽略。`)
      ));
      continue;
    }

    const wrongDomains = loadedIn.filter((domain) => domain !== job.domain);
    if (wrongDomains.length > 0) {
      const both = loadedIn.includes(job.domain);
      findings.push(error(
        `launchd-jobs.${job.slug}.wrong_domain`,
        both
          ? `launchd 任务 ${job.label} 同时加载在系统域和用户域，两个实例会互相抢同一份数据库/端口。`
            + `请执行 ${install}（它会先 bootout 并归档用户域副本，再 bootstrap 系统域实例）。`
          : `launchd 任务 ${job.label} 加载在 ${describeDomains(wrongDomains)}，但它应当由 ${domainLabel} 拥有`
            + `（见 install-launchd-ownership.txt）。请执行 ${install} 完成迁移。`
      ));
    }

    // Round-4 finding I5: the domain checks above answer "is a record for
    // this label loaded". They are reported alongside, never instead of, the
    // runtime state below - a job in the wrong domain that is ALSO
    // crash-looping is two separate problems, and hiding the second until
    // the first is fixed is how a machine passes an acceptance gate while
    // every service on it is dead.
    findings.push(...checkLaunchdJobRuntime(job, row, { installedAt, now: nowMs }));
  }

  return findings;
}

// Round-4 finding I5, the whole point of it: `state` was collected by the
// probe and printed in the CLI snapshot, but NO check ever read it - so a
// machine with all eight labels bootstrapped and every one of them reporting
// `state = not running` / `last exit code = 1` produced zero launchd
// findings and passed the deploy runbook's acceptance step.
//
// What counts as broken depends on the service, which is why
// LAUNCHD_SERVICE_HEALTH exists: `state = not running` is a fault for a
// KeepAlive daemon and the ordinary steady state for a scheduled one, so a
// single uniform assertion would either miss the first or false-alarm on the
// second, every five minutes, forever.
//
// Round 6: the judgement itself moved to launchd-health.mjs and is now shared
// verbatim with install-system-daemons.sh, which runs it before it will archive
// a service's fallback. This function only maps a verdict to a finding. Two of
// those verdicts changed there, both measured:
//
//   · a resident daemon at runs >= 20 is worth reporting WHATEVER launchd says
//     about the last termination. `runs` resets on re-bootstrap (measured), so
//     it cannot accumulate across deploys, and the old rule - which required a
//     non-zero `last exit code` - was unreachable for a signal-killed daemon,
//     the shape the mini's platform-app prints right now.
//     Round 7 (K6) added the missing half: WHEN. `runs` does accumulate between
//     installs, and the deploy target is already at 10 for the gateway with a
//     process alive 10 days, so the count alone would eventually light a
//     permanent red on a machine that is simply old. A loop is 20 relaunches
//     inside a day of the install that reset the counter; the same count over
//     an unknown or much longer stretch is `restarted_many_times`, a warn that
//     says exactly that instead.
//   · a signal death is read out of `last terminating signal`, which is the
//     line launchd prints INSTEAD of `last exit code`. SIGTERM/SIGKILL are
//     excluded: those are what launchd itself sends on bootout and
//     `kickstart -k`, i.e. what the installer does to every daemon on every
//     run.
function checkLaunchdJobRuntime(job, row, { installedAt = null, now = Date.now() } = {}) {
  const contract = LAUNCHD_SERVICE_HEALTH[job.label];
  if (!contract) {
    return [error(
      `launchd-jobs.${job.slug}.no_health_contract`,
      `${job.label} 出现在 install-launchd-ownership.txt 里，但 LAUNCHD_SERVICE_HEALTH 没有它的健康定义，`
        + `因此只能判断它"有没有被 launchd 记住"，无法判断它是否真的在工作。`
        + `请在 launchd-health.mjs 的 LAUNCHD_SERVICE_HEALTH 里补上它的 residency 与探针。`
    )];
  }

  if (row.state === null || row.state === undefined) {
    // Not loaded anywhere (already reported above), or a snapshot from a
    // caller that predates this field. Either way there is no state to judge.
    return [];
  }

  const verdict = judgeLaunchdRuntime(job.label, row, contract, { installedAt, now });
  const where = verdict.evidence;
  const logs = row.stderrPath ? `错误日志：${row.stderrPath}。` : "";
  const install = LAUNCHD_INSTALL_COMMAND[job.domain];
  const kickstart = job.domain === "system"
    ? `sudo launchctl kickstart -k system/${job.label}`
    : `launchctl kickstart -k gui/$(id -u)/${job.label}`;

  switch (verdict.status) {
    case "state_unknown":
      return [warn(
        `launchd-jobs.${job.slug}.state_unknown`,
        `launchctl 认得 ${job.label}，但它的输出里没有 state 字段，无法判断它是否在运行（${contract.probe} 仍是判断它是否真的在工作的依据）。`
      )];
    case "not_running":
      return [error(
        `launchd-jobs.${job.slug}.not_running`,
        `launchd 任务 ${job.label} 已加载但当前没有在运行（state = ${verdict.state}${where}）——它是常驻服务（KeepAlive），`
          + `"已加载"不等于"在工作"。${logs}排查后可用 ${kickstart} 重启，或重跑 ${install}。`
      )];
    case "crash_looping":
      return [error(
        `launchd-jobs.${job.slug}.crash_looping`,
        `launchd 任务 ${job.label} 在反复崩溃重启（${where.replace(/^，/u, "")}）——它是常驻服务，而 runs 只在它死掉时才增加，`
          + `且每次重新 bootstrap 都会清零，所以 ${verdict.runs} 次意味着自 ${installedAt}（上一次装系统 daemon）以来它已经死了 ${verdict.runs - 1} 次，`
          + `而那距今只有 ${describeElapsed(verdict.sinceInstallMs)}。`
          + `此刻 state = running 只是 launchd 刚把它拉起来的瞬间，不代表它可用。${logs}`
      )];
    case "restarted_many_times":
      // Round-7 K6. Same count, no window to call it a loop in - say which of
      // the two facts is missing rather than picking the louder claim.
      return [warn(
        `launchd-jobs.${job.slug}.restarted_many_times`,
        `launchd 任务 ${job.label} 自上次安装以来已经被拉起 ${verdict.runs} 次（${where.replace(/^，/u, "")}）——它是常驻服务，`
          + `每多一次就是它死过一次。`
          + `${verdict.sinceInstallMs === null
            ? `但这台机器上没有「上次装系统 daemon 是什么时候」的收据，所以无法判断这是崩溃重启循环、还是几个月里偶尔重启攒出来的。`
              + `跑一遍 zsh apps/openclaw-config/scripts/deploy.sh 会把计数清零并留下时间戳，之后同样的次数才判定得了。`
            : `不过距上次安装已经 ${describeElapsed(verdict.sinceInstallMs)}，摊到这个跨度上不算崩溃重启循环`
              + `（那要求 ${describeElapsed(RESIDENT_CRASH_LOOP_WINDOW_MS)}之内 ${RESIDENT_CRASH_LOOP_RUNS} 次）。`}`
          + `${logs}`
      )];
    case "restarted_after_failure":
      return [warn(
        `launchd-jobs.${job.slug}.restarted_after_failure`,
        `launchd 任务 ${job.label} 现在在运行，但它上一次退出是异常的（${where.replace(/^，/u, "")}）——KeepAlive 把它拉起来了，`
          + `说明它至少崩过一次。${logs}`
      )];
    case "last_run_failed":
      return [error(
        `launchd-jobs.${job.slug}.last_run_failed`,
        `launchd 任务 ${job.label} 最近一次运行异常退出（${where.replace(/^，/u, "")}）——它是周期任务，`
          + `"state = not running" 本身正常，但上一次执行确实失败了。${logs}`
      )];
    default:
      return [];
  }
}

/** `3 小时` / `12 天` - Chinese half of launchd-health's describeElapsedHours. */
function describeElapsed(elapsedMs) {
  if (elapsedMs === null || elapsedMs === undefined) {
    return "时间不详";
  }
  const hours = elapsedMs / (60 * 60 * 1000);
  if (hours < 1) {
    return `${Math.max(1, Math.round(elapsedMs / 60000))} 分钟`;
  }
  if (hours < 48) {
    return `${Math.round(hours)} 小时`;
  }
  return `${Math.round(hours / 24)} 天`;
}

// Whether launchd currently holds this label in ANY domain, per the same
// snapshot rows checkLaunchdJobs reads. The artifact/row-freshness probes
// below gate on this: "runtime/backups has no backup from the last two days"
// only means something on a machine where com.alphaloop.daily-backup is
// actually installed - on a dev box it would be a permanent false alarm, and
// the `not_loaded` warning already covers that case honestly.
function isLaunchdJobLoaded(snapshot, label) {
  const row = (Array.isArray(snapshot.launchdJobs) ? snapshot.launchdJobs : [])
    .find((entry) => String(entry?.label) === label);
  return Array.isArray(row?.loadedDomains) && row.loadedDomains.length > 0;
}

// Round-5 finding D2 - the reason the acceptance gate could not fail.
//
// MEASURED, against this module's own analyzeOpenClawRuntimeSnapshot: a
// resident daemon that is crash-looping, sampled just after launchd relaunched
// it (state = running, last exit code = 1, runs = 918) with its /health
// refusing ECONNREFUSED, produced `ok: true`, doctor exit 0, and not one error
// finding - separately for platform-app and for broker-executor. Runbook step 8
// tells the operator to trust that answer.
//
// Two independent causes, both fixed here:
//
//   1. The severity of "the health endpoint did not answer" was a property of
//      the CHECK ("a dev machine legitimately does not run this service"), when
//      it is a property of the MACHINE. On a box where launchd is holding the
//      label - i.e. an installer ran and the daemon is supposed to be up right
//      now - a refused loopback connection is not ambiguous, it is the service
//      being dead. Only when launchd holds the label NOWHERE is "unreachable"
//      the ordinary dev-machine state, and only then is it a warn.
//   2. `state = running` + a failed last exit was reported as
//      `restarted_after_failure`, a warn, which is exactly the sample a crash
//      loop hands you: launchd relaunches, the doctor looks, the process is
//      briefly alive, the previous exit is still recorded as a failure.
//
// This helper answers question 1 for every loopback probe, so the four of them
// cannot drift apart again.
function probeSeverityFor(snapshot, label) {
  return isLaunchdJobLoaded(snapshot, label) ? error : warn;
}

// Round-6 finding S3a. The same "severity is a property of the MACHINE"
// reasoning as probeSeverityFor, for the questions that are about the machine
// as a whole rather than one label: has anything ever been deployed here?
//
// Three independent signals, any one of which is enough. None of them is true
// of a developer's laptop, and each of them is true of a machine that ran the
// installers even once:
//
//   1. a deploy ledger exists (deploy.sh or install-system-daemons.sh wrote a
//      receipt here);
//   2. at least one of the manifest's labels is loaded in some launchd domain;
//   3. a plist for one of the manifest's labels is sitting in
//      /Library/LaunchDaemons or ~/Library/LaunchAgents.
//
// Signal 3 matters on its own: after a failed install the plists are on disk
// and nothing is loaded, which is precisely the state the old unconditional
// `warn` was blindest to.
export function deployFootprint(snapshot) {
  const reasons = [];

  // Round-8 finding L3: this used to be `entries.length > 0`, so `chmod 0222`
  // or `rm` on the ledger did not merely hide the receipts - it unmade the
  // footprint, and with it the severity every other check derives from being on
  // a deploy target. The file (or the directory that only recordDeployStep
  // creates) EXISTING is the signal; whether it can be read is a separate
  // question that checkDeployLedger answers on its own.
  const ledger = readLedgerState(snapshot);
  if (ledger.entries.length > 0) {
    reasons.push("这台机器上有部署收据（runtime/deploy/steps.jsonl）");
  } else if (ledger.fileExists || ledger.dirExists) {
    reasons.push("这台机器上有部署账本留下的痕迹（runtime/deploy/），只是现在读不出收据");
  }

  const rows = Array.isArray(snapshot.launchdJobs) ? snapshot.launchdJobs : [];
  const loaded = rows.filter((row) => Array.isArray(row?.loadedDomains) && row.loadedDomains.length > 0);
  if (loaded.length > 0) {
    reasons.push(`${loaded.length} 个受管标签当前已加载在 launchd 里`);
  }

  const plists = snapshot.launchdPlists ?? {};
  const managed = new Set(REQUIRED_LAUNCHD_JOBS.map((job) => job.label));
  const onDisk = [
    ...(Array.isArray(plists.system) ? plists.system : []),
    ...(Array.isArray(plists.user) ? plists.user : [])
  ].filter((label) => managed.has(String(label)));
  if (onDisk.length > 0) {
    reasons.push(`磁盘上已经有 ${onDisk.length} 个受管标签的 plist`);
  }

  return { deployed: reasons.length > 0, reasons };
}

function deployTargetSeverityFor(snapshot) {
  return deployFootprint(snapshot).deployed ? error : warn;
}

function describeDeployFootprint(snapshot) {
  return deployFootprint(snapshot).reasons.join("；") || "无部署痕迹";
}

// The ledger, from wherever the caller supplies it: an explicit array (tests,
// and any future caller that has already read it) or the real file under the
// runtime root. Reading is failure-tolerant by construction - see
// readDeployLedgerResult - so a corrupt line degrades to "fewer receipts",
// never to a throw inside a health check.
//
// `fromFile` is what lets the caller tell "there is no ledger file" from "this
// caller handed me the rows directly": a snapshot carrying `deployLedger` says
// nothing about any file, so the file-shaped findings below stay silent for it.
function readLedgerState(snapshot) {
  if (Array.isArray(snapshot.deployLedger) || !snapshot.runtimeRoot) {
    return {
      entries: Array.isArray(snapshot.deployLedger) ? snapshot.deployLedger : [],
      path: null,
      fileExists: false,
      dirExists: false,
      readable: null,
      error: null,
      fromFile: false
    };
  }
  return { ...readDeployLedgerResult(snapshot.runtimeRoot), fromFile: true };
}

function readLedgerEntries(snapshot) {
  return readLedgerState(snapshot).entries;
}

// Round-6, the mechanism check: "a step of this deploy failed" is a fact that
// has to survive until the gate runs, because every one of round 5's confirmed
// criticals was a failure that had already been printed, loudly, minutes
// earlier - and the gate looked only at what it could still observe.
//
// See deploy-ledger.mjs's judgeDeployLedger for the severity split and why
// missing/stale receipts are reported without being called failures.
function checkDeployLedger(snapshot) {
  const ledger = readLedgerState(snapshot);
  const entries = ledger.entries;
  const findings = [];

  // Round-7 finding K1, and it is deliberately the FIRST thing said here: if
  // receipts cannot be appended, every receipt below is evidence about some
  // earlier deploy and none of it is evidence about the latest one.
  //
  // MEASURED: clean deploy (nine `exitCode: 0` rows) -> `chmod 444` on the
  // ledger, which is what one prior sudo run leaves behind -> a deploy whose
  // build step fails. The failure could not be recorded, the nine green rows
  // stayed, and this gate answered ok=true with zero errors.
  //
  // This probe needs no cooperation from the writer that failed - it asks the
  // kernel whether this process could append, and writes nothing itself. With
  // no runtime root (callers that hand this analyzer a ledger array directly)
  // there is no path to judge, and nothing is claimed.
  const writability = snapshot.runtimeRoot
    ? probeDeployLedgerWritable(snapshot.runtimeRoot)
    : { writable: null, path: null, checked: null };
  if (writability.writable === false) {
    const severity = deployTargetSeverityFor(snapshot);
    findings.push(severity(
      "deploy-ledger.unwritable",
      `部署账本写不进去：${writability.error}（检查的路径是 ${writability.checked}）。`
        + `${entries.length > 0
          ? `这个文件里现在有 ${entries.length} 条收据，但它们只能证明【上一次能写进去的那次部署】——`
            + `此后任何一次部署的成败都记不下来，包括失败。`
          : "也就是说接下来任何一次部署的成败都记不下来。"}`
        + `所以下面关于部署步骤的结论一律不作数，先把它修回可写：`
        + `ls -l ${writability.path}；sudo chown -R "$(id -un)":staff ${dirname(writability.path)}。`
    ));
  }

  // Round-8 finding L3, the read half. `readDeployLedger` answered `[]` for a
  // ledger it could not open, and `[]` means `deployed: false`, which is at
  // most a warn - so `chmod 0222` on one file turned a recorded failure
  // (receipt `3:1`) into a green gate with ZERO deploy-ledger findings.
  // Reported before anything else and on its own: the rows cannot be read, so
  // there is nothing else here to say.
  if (ledger.readable === false) {
    findings.push(error(
      "deploy-ledger.unreadable",
      `部署账本存在但读不出来：${ledger.error}（文件是 ${ledger.path}）。`
        + `这台机器上每一步部署的成败都记在这个文件里，读不到它就等于这道门看不见【任何一次部署】——`
        + `包括刚刚失败的那一次。先修权限再重跑本体检：`
        + `ls -l ${ledger.path}；sudo chown -R "$(id -un)":staff ${dirname(String(ledger.path))}。`
    ));
    return findings;
  }

  const verdict = judgeDeployLedger(entries, { head: snapshot.gitHead ?? null });
  if (!verdict.deployed) {
    // Round-8 finding L3, the other way a ledger becomes "no receipts": it was
    // deleted or emptied. `runtime/deploy/` exists on this machine only because
    // recordDeployStep's mkdirSync created it to append a receipt, so the
    // directory outliving the file is not the normal state of anything - and a
    // ledger file that parses to zero rows is not either. MEASURED: `rm
    // steps.jsonl` after a deploy whose step 3 failed left the gate green with
    // one warn. Deleting one file must not be a way to pass.
    if (ledger.fromFile && (ledger.fileExists || ledger.dirExists)) {
      findings.push(error(
        "deploy-ledger.lost",
        `${ledger.fileExists
          ? `部署账本 ${ledger.path} 在，但里面一条可用的收据都没有（空文件，或每一行都不是合法 JSON）。`
          : `部署账本 ${ledger.path} 不见了，但它的目录 ${join(String(snapshot.runtimeRoot ?? "runtime"), "deploy")} 还在——`
            + `那个目录只有写收据的时候才会被建出来，所以这台机器写过账本，现在文件没了。`}`
          + `账本是"上一次部署到底成没成"唯一还留着的证据，它没了，这道门就无法否认一次失败的部署——`
          + `删掉一个文件不该等于通过验收。`
          + `请重跑一遍完整部署把每一步的收据补上：DEPLOY_ACK_GATEWAY_RESTART=yes zsh apps/openclaw-config/scripts/deploy.sh`
      ));
      return findings;
    }
    // No receipts at all. On a machine with a deploy footprint this is worth
    // saying (the runbook was followed by hand, or predates the ledger); on a
    // dev box it is simply the normal state and nothing is reported.
    if (!deployFootprint(snapshot).deployed) {
      return findings;
    }
    findings.push(warn(
      "deploy-ledger.absent",
      `这台机器有部署痕迹，但没有任何部署收据（${join(String(snapshot.runtimeRoot ?? "runtime"), "deploy", "steps.jsonl")} 不存在）。`
        + `照 README 的 0→8 一步步手敲也会是这个结果——用 zsh apps/openclaw-config/scripts/deploy.sh 跑一遍，`
        + `每一步的退出码就会被记下来，这道门也才拦得住"某一步失败了但没人发现"。`
    ));
    return findings;
  }

  for (const step of verdict.failedSteps) {
    findings.push(error(
      `deploy-ledger.step_${step.step}_failed`,
      `部署第 ${step.step} 步（${step.title}）以退出码 ${step.exitCode} 失败，时间 ${step.finishedAt ?? "未知"}，commit ${step.head ?? "未知"}。`
        // The writer's own note, when it left one. deploy.sh's signal traps put
        // 「SIGHUP 中断：…」 here, and without it an operator reading 「退出码
        // 129 失败」 has no way to tell a crashed step from a dropped ssh.
        + (step.detail ? `收据备注：${step.detail}。` : "")
        + `失败之后没有任何一条成功记录覆盖它，所以这台机器现在是"部署到一半"的状态。`
        + `请照那一步自己打印的原因修掉再重跑：DEPLOY_ACK_GATEWAY_RESTART=yes DEPLOY_FROM_STEP=${step.step} zsh apps/openclaw-config/scripts/deploy.sh`
    ));
  }
  if (verdict.missingSteps.length > 0) {
    findings.push(warn(
      "deploy-ledger.incomplete",
      `以下部署步骤没有留下收据，无法确认它们跑过：${verdict.missingSteps.map((step) => `第 ${step.step} 步（${step.title}）`).join("、")}。`
        + `"没有证据"不等于"失败"——但也不等于做过。用 zsh apps/openclaw-config/scripts/deploy.sh 跑完整流程可以把它们补齐。`
    ));
  }
  if (verdict.staleSteps.length > 0) {
    // Round-7 finding K2. This was a warn, on the grounds that "the doctor's
    // own git check is what calls a stale checkout an error". It is not:
    // checkDeployCheckout errors only when the checkout is BEHIND origin.
    // MEASURED with a real local origin and two real commits - deploy at A,
    // origin advances to B, the operator pulls by hand and never re-runs
    // deploy.sh: behind = 0, this was the only complaint, it was a warn, and
    // the gate exited 0 while dist and all eight daemons were still running A.
    // That is precisely 「跑的不是你 push 的代码」, which cannot be a warning.
    findings.push(error(
      "deploy-ledger.stale",
      `以下步骤上一次成功是在别的 commit 上跑的（当前检出 ${snapshot.gitHead ?? "未知"}）：`
        + `${verdict.staleSteps.map((step) => `第 ${step.step} 步 @ ${step.head}`).join("、")}。`
        + `工作区已经换了代码，但这些步骤没有在新代码上跑过——dist 产物和 launchd 里跑着的仍然是旧那份。`
        + `手动 git pull 不会更新这些收据，也不会重启任何服务；`
        + `重跑一遍 DEPLOY_ACK_GATEWAY_RESTART=yes zsh apps/openclaw-config/scripts/deploy.sh 才会。`
    ));
  }
  return findings;
}

/**
 * The newest receipt that proves this machine's checkout came from origin: step
 * 0 is `git fetch origin && git pull --ff-only origin main`, so an exit-0
 * receipt for it, recorded against the commit that is checked out NOW, is the
 * only evidence in the ledger that a real conversation with origin produced
 * this working tree. A receipt from another commit proves nothing about this
 * one (and raises deploy-ledger.stale on its own).
 *
 * @returns {Record<string, any>|null}
 */
function lastVerifiedPull(snapshot, head) {
  if (!head) {
    return null;
  }
  const receipts = readLedgerEntries(snapshot).filter((entry) =>
    Number(entry?.step) === 0 && Number(entry?.exitCode) === 0 && String(entry?.head ?? "") === String(head));
  return receipts.length === 0 ? null : receipts.at(-1);
}

// Round-6 finding S3b: `git pull --ff-only` aborting is the one failure that
// makes every LATER step meaningless - they all run, they all succeed, and they
// all run the old code. Measured: a single dirty tracked file on the deploy
// machine was enough, and steps 1-8 then ran to completion on the previous
// commit with a green gate at the end.
//
// This asks git directly rather than trusting the ledger, so it also catches
// the machine that was never deployed through deploy.sh at all.
function checkDeployCheckout(snapshot) {
  const git = snapshot.git;
  if (!git || !git.head) {
    return [];
  }
  const findings = [];
  // "Behind" and "not identical" are different facts, and only the first is a
  // deploy failure. Measured by running this CLI on the machine the code is
  // WRITTEN on: HEAD there is ahead of origin/main by design, and an
  // equality test alone reported that as "this is not the code you pushed".
  const behind = Number.isFinite(git.behind) ? git.behind : null;
  const ahead = Number.isFinite(git.ahead) ? git.ahead : null;

  // Round-7 finding K7, and it is checked BEFORE `behind`, because `behind` is
  // computed from the local origin/main ref and on the machine this matters
  // most that ref was five commits out of date and said 0. `remoteTip` is what
  // origin answered just now (see readGitCheckout's ls-remote); a commit that
  // is not even in this object store cannot be what is checked out here.
  if (git.remoteTip && git.remoteTip !== git.head && git.remoteTipKnownLocally === false) {
    findings.push(error(
      "deploy-checkout.never_fetched",
      `origin/main 现在是 ${git.remoteTip}，而这台机器上【连这个 commit 都没有】——`
        + `本地那份 origin/main 引用停在 ${git.remoteHead ?? "未知"}，从来没有 fetch 过新的。`
        + `所以"落后 ${behind ?? "?"} 个提交"这种话在这台机器上算不出真值：它跑的不是你 push 的代码。`
        + `跑 zsh apps/openclaw-config/scripts/deploy.sh（第 0 步会 fetch + pull，后面的步骤才会把新代码真正装上去）。`
    ));
    return findings;
  }
  if (git.remoteTip && git.remoteTipKnownLocally && Number(git.behindRemoteTip) > 0) {
    findings.push(error(
      "deploy-checkout.behind_origin",
      `这台机器的检出停在 ${git.head}，而 origin/main 现在是 ${git.remoteTip}，落后 ${git.behindRemoteTip} 个提交`
        + `${ahead ? `（同时还领先 ${ahead} 个，历史已经分叉）` : ""}——`
        + `也就是说这里跑的不是你 push 的代码。部署第 0 步（git pull --ff-only）没有真正完成。`
        + `${git.dirtyFiles?.length ? `工作区还有本地改动挡着：${git.dirtyFiles.slice(0, 5).join("、")}。` : ""}`
    ));
    return findings;
  }
  if (!git.remoteTip && git.remoteTipError && deployFootprint(snapshot).deployed) {
    // Round-8 finding L4: K7 replaced the untrustworthy local ref with a live
    // `ls-remote`, and then fell straight back to that same ref - as a WARN -
    // whenever ls-remote could not answer. MEASURED with the deploy target's
    // exact git state (HEAD = local origin/main = 14b1202, behind = 0, tree
    // clean, real origin five commits ahead) plus an unreachable origin: gate
    // ok=TRUE, zero errors, two warns. A machine running code that was never
    // fetched passed the gate whenever the network was down.
    //
    // So the severity now depends on whether anything CORROBORATES the local
    // ref. Step 0's receipt does exactly that and nothing else does: it is
    // `git fetch origin && git pull --ff-only origin main`, so an exit-0
    // receipt for step 0 recorded at the commit checked out right now is proof
    // that a real fetch reached origin and landed here. Without one, "not
    // behind" is a statement about a ref of unknown age, and this is the one
    // check whose entire job is 「跑的不是你 push 的代码」.
    const verifiedPull = lastVerifiedPull(snapshot, git.head);
    findings.push((verifiedPull ? warn : error)(
      "deploy-checkout.remote_unverified",
      `没能向 origin 核对 main 的真实位置（${git.remoteTipError}），所以下面这些结论只基于本地那份 origin/main 引用`
        + `（${git.remoteHead ?? "无"}）——它可能比真正的 origin/main 旧很多，而那种情况下"没落后"是假的。`
        + (verifiedPull
          ? `不过账本里有一条第 0 步的成功收据，就是在当前这个检出 ${git.head} 上跑的`
            + `（${verifiedPull.finishedAt ?? "时间未知"}）：那一次 fetch + pull 确实连上了 origin，`
            + `所以截至那一刻这里就是 origin/main。之后 origin 有没有再往前走，这次核不了。`
            + `网络/凭据恢复后重跑本体检，或先手动 git fetch origin。`
          : `而这台机器上【没有】任何一条"在当前检出 ${git.head} 上成功跑过第 0 步"的收据，`
            + `也就是说没有任何证据表明这个检出是真的从 origin 拉下来的。`
            + `第 7 轮在部署目标上实测到的正是这种：本地 origin/main 和 HEAD 都停在 14b1202、算出来"落后 0 个提交"，`
            + `而真正的 origin/main 已经在五个提交之后。这种状态不能给绿灯。`
            + `恢复到 origin 的连接后重跑本体检；或者直接跑一次完整部署，第 0 步会 fetch + pull，`
            + `后面的步骤才会把新代码真正装上去。`)
    ));
  }

  if (behind !== null && behind > 0) {
    findings.push(error(
      "deploy-checkout.behind_origin",
      `这台机器的检出停在 ${git.head}，而 origin/main 是 ${git.remoteHead}，落后 ${behind} 个提交`
        + `${ahead ? `（同时还领先 ${ahead} 个，历史已经分叉）` : ""}——`
        + `也就是说这里跑的不是你 push 的代码。部署第 0 步（git pull --ff-only）没有真正完成。`
        + `${git.dirtyFiles?.length ? `工作区还有本地改动挡着：${git.dirtyFiles.slice(0, 5).join("、")}。` : ""}`
    ));
  } else if (ahead !== null && ahead > 0) {
    findings.push(warn(
      "deploy-checkout.ahead_of_origin",
      `这台机器的检出（${git.head}）领先 origin/main（${git.remoteHead}）${ahead} 个提交。`
        + `写代码的那台机器上这是正常的；部署机上出现就说明有人在它上面直接改了东西。`
    ));
  } else if (git.dirtyFiles?.length) {
    findings.push(warn(
      "deploy-checkout.dirty",
      `工作区有已跟踪文件的本地改动（${git.dirtyFiles.slice(0, 5).join("、")}），下一次 git pull --ff-only 会因此中止。`
    ));
  }
  return findings;
}

// Round-6 finding S3d. install-system-daemons.sh archives a user-level plist
// only after its daemon is verified up, and reports the ones it had to keep -
// but "reported and exited 1" was invisible to this gate, and the consequence
// is not visible in the launchd job table either: the agent has been booted
// out, so nothing is loaded twice RIGHT NOW. It is at the next login that
// launchd bootstraps every plist in ~/Library/LaunchAgents and the machine ends
// up running both copies of six services on one database and one port.
//
// So this looks at the DISK, which is where that future is already decided.
function checkStrayUserPlists(snapshot) {
  const onDisk = new Set((snapshot.launchdPlists?.user ?? []).map(String));
  const stray = REQUIRED_LAUNCHD_JOBS
    .filter((job) => job.domain === "system" && onDisk.has(job.label))
    .map((job) => job.label);
  if (stray.length === 0) {
    return [];
  }
  return [error(
    "launchd-plists.stray_user_copy",
    `${stray.length} 个系统域标签在 ~/Library/LaunchAgents 里还留着用户级 plist：${stray.join("、")}。`
      + `现在它们没有加载，所以 launchd 任务表看不出问题；但下次登录时 launchd 会把它们全部 bootstrap 起来，`
      + `于是同一个服务同时跑两份，抢同一个端口和同一份 trading.sqlite。`
      + `这通常是 install-system-daemons.sh 归档失败留下的（它绝不删除，只会原地保留并报错）。`
      + `修法：sudo chown -R "$(id -un)":staff ~/Library/LaunchAgents.disabled 之后重跑 sudo zsh apps/openclaw-config/scripts/install-system-daemons.sh。`
  )];
}

// Round-6 finding S3g. The five report pipelines ARE the product, and they are
// dispatched by openclaw cron, not by launchd - so none of the thirteen checks
// this doctor had could see whether a single one of them existed. Measured:
// `openclaw cron add` failing (GatewayTransportError/ECONNREFUSED) left zero of
// five jobs installed and the gate still went green.
//
// `snapshot.openclawCron` is what the CLI got out of `openclaw cron list
// --json`; see openclaw-runtime-doctor.mjs for how it is collected and why the
// query is bounded.
function checkOpenClawCronJobs(snapshot) {
  const expected = buildManagedOpenClawCronJobs(snapshot.repoRoot ?? process.cwd()).map((job) => job.name);
  const registry = snapshot.openclawCron;
  if (!registry) {
    return [];
  }

  if (!registry.ok) {
    const severity = deployTargetSeverityFor(snapshot);
    return [severity(
      "openclaw-cron.unreadable",
      `无法读取 openclaw cron 任务表：${registry.error ?? "未知错误"}。`
        + (severity === error
          ? `这台机器已经部署过（${describeDeployFootprint(snapshot)}），日报/周报/个股分析这 5 条流水线全靠 openclaw cron 派发，`
            + `读不到就等于无法确认它们是否存在。gateway 没起来时最常见——先确认 ai.openclaw.system.gateway 在跑，再重跑 pnpm openclaw:cron:install。`
          : `开发机上没有配 gateway 凭据是正常的。`)
    )];
  }

  const findings = [];
  const installed = new Set((registry.names ?? []).map(String));
  // Round-7 finding K8, second half: `openclaw cron list` hides disabled jobs
  // unless asked (`--all`, which the CLI now passes), so a job that exists but
  // will never fire used to read as "missing". Both are broken; they are not
  // the same repair, and the message has to say which one this is.
  const disabled = new Set((registry.disabledNames ?? []).map(String));
  const missing = expected.filter((name) => !installed.has(name) && !disabled.has(name));
  const disabledExpected = expected.filter((name) => disabled.has(name));

  if (disabledExpected.length > 0) {
    findings.push(error(
      "openclaw-cron.jobs_disabled",
      `openclaw cron 里有 ${disabledExpected.length}/${expected.length} 个报告类任务处于 disabled：${disabledExpected.join("、")}。`
        + `任务还在，但 disabled 的任务不会被派发——效果和不存在一样。`
        + `用 openclaw cron enable <name> 打开，或重跑 pnpm openclaw:cron:install 重建。`
    ));
  }

  if (missing.length === 0) {
    return findings;
  }

  // Round-7 finding K8, first half. The envelope carries {total, offset, limit,
  // hasMore, nextOffset} and this gateway also serves the operator's personal
  // 186-agent fleet - so a truncated page is a real possibility, and "not in
  // the page I was given" is not "not installed". Measured read-only on the
  // deploy target (2026-07-29): the query the CLI now sends is scoped with
  // `--agent control --all`, and it answers total=5, limit=5, hasMore=false,
  // with all five managed jobs present - so this branch is about the future
  // shape, not today's.
  if (registry.truncated) {
    findings.push(warn(
      "openclaw-cron.list_truncated",
      `openclaw cron 任务表被截断了（这次拿到 ${registry.names?.length ?? 0} 条，总数 ${registry.total ?? "未知"}，hasMore=true），`
        + `所以没能确认这 ${missing.length} 个报告类任务在不在：${missing.join("、")}。`
        + `这不是"它们不存在"，是"这次没看全"——请手动确认：openclaw cron list --agent control --all | grep openclaw-trading。`
    ));
    return findings;
  }

  findings.push(error(
    "openclaw-cron.jobs_missing",
    `openclaw cron 里缺 ${missing.length}/${expected.length} 个报告类任务：${missing.join("、")}。`
      + `这 5 条任务就是日报、周报和个股分析本身——少一条就是那条流水线在这台机器上根本不会触发。`
      + `请重跑 pnpm openclaw:cron:install，并确认它这次以退出码 0 结束。`
  ));
  return findings;
}

// Round-6 finding S3h: every public report card can be delivered "successfully"
// into one person's DM, with no link back to the platform, and nothing in this
// doctor ever asked. On the deploy target both variables below are currently
// unset (verified read-only; their values are never read or printed here - only
// whether they are configured).
//
// The snapshot deliberately carries BOOLEANS only, because this CLI prints its
// whole snapshot as JSON and a chat id is a credential-adjacent identifier.
function checkNotificationRouting(snapshot) {
  const routing = snapshot.notificationRouting;
  if (!routing) {
    return [];
  }
  const findings = [];
  const severity = deployTargetSeverityFor(snapshot);

  if (!routing.groupChatIdConfigured) {
    findings.push(severity(
      "notification-routing.no_group_chat",
      `FEISHU_GROUP_CHAT_ID 没有配置。圈子公共报告（日报/周报/个股分析）因此`
        + (routing.fallbackTargetConfigured
          ? `会改投默认单聊——群里一张卡都收不到，而投递结果仍然是"已发送"。`
          // Honest about what was and was not checked: resolveFeishuAppTarget
          // also consults a target stored in the trading database and can
          // WRITE one back (storeFeishuTarget), so this doctor does not call
          // it - observing must not change what is being observed.
          : `很可能根本发不出去：这里检查的两个兜底环境变量（FEISHU_NOTIFY_CHAT_ID / FEISHU_NOTIFY_OPEN_ID）也都没配。`
            + `另外还有一个"存在库里的默认目标"，doctor 不去解析它——那个解析函数在找到目标时会回写数据库，而体检不该改动被体检的系统。`)
        + `请在 .env.local 里把它设成圈子群的 chat id。`
    ));
  }

  if (!routing.publicBaseUrlConfigured) {
    findings.push(severity(
      "notification-routing.no_public_base_url",
      `PLATFORM_PUBLIC_BASE_URL 没有配置。报告卡的正文在平台上，卡片上那个按钮就是唯一入口——`
        + `没有这个变量，卡片发出去也点不进任何页面。请设成对外可达的地址（mini 上是 cloudflared 那条）。`
    ));
  }

  // Round-7 finding K5. This check was `error`-severity and could not fire.
  //
  // It read `groupFallback === true` off the newest state entry that HAS a
  // `deliveredAt`. After J2 that combination stopped existing: a circle-public
  // report with no group chat is REFUSED by the delivery layer, so
  // `groupFallback: true` now always arrives with `sent: false`, and
  // scheduled-report.mjs's refusal branch (the only one that runs then) writes
  // `deliveryFailedAt`, never `deliveredAt`. An error-severity check that
  // nothing can trigger is worse than no check, because the code list reads as
  // coverage.
  //
  // Both halves were fixed rather than deleting it: scheduled-report.mjs now
  // records `groupFallback`/`groupFallbackReason` on the refusal too (its own
  // comment already claimed it did), and the CLI ranks entries by
  // `deliveredAt ?? deliveryFailedAt`, carrying `lastDeliverySent` so this can
  // tell the two outcomes apart instead of assuming one.
  if (routing.lastDeliveryGroupFallback) {
    const when = `${routing.lastDeliveryLabel ?? "未知窗口"}，${routing.lastDeliveryAt ?? "时间未知"}`;
    findings.push(error(
      "notification-routing.last_delivery_missed_group",
      routing.lastDeliverySent === false
        ? `最近一次报告投递（${when}）被投递层拒发：${routing.lastDeliveryReason ?? "报告投递状态里记着 groupFallback=true"}。`
          + `报告本身生成了、也在磁盘上，但圈子群里一张卡都没有——`
          + `这条流水线在配好 FEISHU_GROUP_CHAT_ID 之前每一轮都会这样结束。`
        : `最近一次报告投递（${when}）是"群改单聊"的降级投递：`
          + `${routing.lastDeliveryReason ?? "报告投递状态里记着 groupFallback=true"}。`
          + `也就是说圈子里没有人在群里看到那张卡。`
    ));
  }

  return findings;
}

// Appended to an unreachable-probe message when launchd IS holding the label:
// says why this is being called a failure rather than a dev-machine warning.
const LOADED_BUT_UNREACHABLE_SUFFIX = "（launchd 当前持有这个标签，也就是说这台机器上它本应正在运行——"
  + "『已加载但探针不通』说明进程起来了又崩、或崩溃重启循环中，不是开发机没装服务。）";

function describeDomains(domains) {
  return domains.map((domain) => (domain === "system" ? "系统域" : "用户域")).join("、");
}

// Phase 3 Task 8 - "platform-app-health" check: launchd-jobs above only
// proves a job is *loaded*, not that the process it launched is actually
// answering requests (KeepAlive services can load and then crash-loop, or
// load fine but deadlock). This hits platform-app's own `/health` route
// directly over loopback HTTP.
//
// Port resolution mirrors apps/platform-app/src/index.ts's own
// `process.env.PLATFORM_APP_PORT ?? 4314` exactly - `snapshot.platformAppPort`
// is an additional injection point ahead of both, used only by tests (real
// callers, i.e. openclaw-runtime-doctor.mjs, never set it, so production
// behavior is unaffected).
//
// Severity split (task brief): a dev machine legitimately does not run this
// service at all, so connection failure/timeout is only a `warn`, with the
// hint naming both `pnpm platform:dev` (manual dev run) and the installer
// that really owns it. Round-3 finding F2: that installer is
// install-system-daemons.sh, NOT `pnpm launchd:install-backup-alerts` -
// com.alphaloop.platform-app moved to /Library/LaunchDaemons in ac741d8, and
// install-launchd.sh now skips any label the ownership manifest does not
// scope `user`, so the old hint pointed at a script that installs it
// nowhere. A response that DOES arrive but is wrong (non-200, or a 200 whose
// body isn't the expected `{ok:true, service:"platform-app"}` shape) means
// the process is up but broken - that is an `error`, not a warn.
//
// Never throws/rejects on its own - every failure path below returns a
// finding array instead, so this is safe to call directly even without
// runChecksFailureIsolated's outer safety net (task brief: "don't rely on
// [failure isolation] alone").
async function checkPlatformAppHealth(snapshot) {
  const port = Number(
    snapshot.platformAppPort ?? process.env.PLATFORM_APP_PORT ?? PLATFORM_APP_HEALTH_DEFAULT_PORT
  );
  const url = `http://127.0.0.1:${port}/health`;
  const timeoutMs = Number(snapshot.platformAppHealthTimeoutMs ?? PLATFORM_APP_HEALTH_TIMEOUT_MS);
  const fetchImpl = typeof snapshot.fetchImpl === "function" ? snapshot.fetchImpl : fetch;

  let response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    response = await fetchImpl(url, { signal: controller.signal });
  } catch (fetchError) {
    // Round-5 finding D2: error when launchd is holding com.alphaloop.platform-app
    // (the daemon is supposed to be serving this port right now), warn when it
    // is loaded nowhere (an ordinary dev machine).
    const severity = probeSeverityFor(snapshot, "com.alphaloop.platform-app");
    return [severity(
      "platform-app-health.unreachable",
      `platform-app 健康检查不可达（${url}）：${describeError(fetchError)}。`
        + (severity === error
          ? `${LOADED_BUT_UNREACHABLE_SUFFIX}请看 logs/platform-app.err.log，并用 sudo launchctl kickstart -k system/com.alphaloop.platform-app 重启。`
          : `开发机上尚未起服务是正常的——本地手动起服务请跑 pnpm platform:dev；`
            + `需要常驻运行请跑 ${LAUNCHD_INSTALL_COMMAND.system} 安装 com.alphaloop.platform-app（它是系统域 daemon，pnpm launchd:install-backup-alerts 装不上它）。`)
    )];
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    return [error(
      "platform-app-health.unexpected_status",
      `platform-app 健康检查返回非预期状态码（${url}）：HTTP ${response.status} ${response.statusText}。进程在跑但可能已经异常，请检查 platform-app 日志。`
    )];
  }

  let body;
  try {
    body = await response.json();
  } catch (parseError) {
    return [error(
      "platform-app-health.unexpected_body",
      `platform-app 健康检查响应无法解析为 JSON（${url}）：${describeError(parseError)}。`
    )];
  }

  if (!body || body.ok !== true || body.service !== "platform-app") {
    return [error(
      "platform-app-health.unexpected_body",
      `platform-app 健康检查响应内容不符合预期（${url}），期望 {"ok":true,"service":"platform-app"}，实际收到：${JSON.stringify(body)}。`
    )];
  }

  return [];
}

function parseMemorydMcpEvent(text) {
  const source = String(text ?? "").trim();
  if (!source) throw new Error("empty MCP response");
  if (source.startsWith("{")) return JSON.parse(source);
  for (const line of source.split(/\r?\n/u)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (data) return JSON.parse(data);
  }
  throw new Error("response contained no JSON MCP event");
}

function requireLoopbackMemorydMcpUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new Error(`memoryd MCP URL is invalid: ${String(value)}`);
  }
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (parsed.protocol !== "http:" || !loopbackHosts.has(parsed.hostname)) {
    throw new Error(`memoryd MCP URL must use loopback HTTP, received ${parsed.origin}`);
  }
  return parsed.toString();
}

export async function probeMemorydMcp({
  url = process.env.MEMORYD_MCP_URL ?? MEMORYD_MCP_DEFAULT_URL,
  fetchImpl = fetch,
  timeoutMs = MEMORYD_MCP_HEALTH_TIMEOUT_MS
} = {}) {
  const configuredTimeout = Number(timeoutMs);
  const boundedTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : MEMORYD_MCP_HEALTH_TIMEOUT_MS;
  let targetUrl;
  try {
    targetUrl = requireLoopbackMemorydMcpUrl(url);
  } catch (configurationError) {
    return { ok: false, kind: "unreachable", url: String(url), reason: describeError(configurationError) };
  }
  const fetchBounded = async (init) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), boundedTimeoutMs);
    try {
      return await fetchImpl(targetUrl, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  };
  let sessionId = null;
  try {
    const response = await fetchBounded({
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "alphaloop-doctor", version: "1" }
        }
      })
    });
    if (!response.ok) {
      return { ok: false, kind: "status", url: targetUrl, status: response.status, statusText: response.statusText };
    }
    sessionId = response.headers?.get?.("mcp-session-id") ?? null;
    const message = parseMemorydMcpEvent(await response.text());
    const serverName = message?.result?.serverInfo?.name;
    if (message?.error || serverName !== "memoryd" || !sessionId) {
      return { ok: false, kind: "body", url: targetUrl, serverName, sessionId: Boolean(sessionId) };
    }
    return { ok: true, url: targetUrl, serverName, sessionId: true };
  } catch (probeError) {
    return { ok: false, kind: "unreachable", url: targetUrl, reason: describeError(probeError) };
  } finally {
    if (sessionId) {
      try {
        await fetchBounded({
          method: "DELETE",
          headers: {
            accept: "application/json, text/event-stream",
            "mcp-session-id": sessionId
          }
        });
      } catch {
        // The initialized response already proved service health. Session
        // cleanup failure is not a daemon-health failure.
      }
    }
  }
}

async function checkMemorydHealth(snapshot) {
  const probe = snapshot.memorydMcpProbe ?? await probeMemorydMcp({
    url: snapshot.memorydMcpUrl ?? process.env.MEMORYD_MCP_URL ?? MEMORYD_MCP_DEFAULT_URL,
    fetchImpl: typeof snapshot.fetchImpl === "function" ? snapshot.fetchImpl : fetch,
    timeoutMs: snapshot.memorydMcpHealthTimeoutMs ?? MEMORYD_MCP_HEALTH_TIMEOUT_MS
  });
  if (probe?.ok) return [];

  if (probe?.kind === "status") {
    return [error(
      "memoryd-health.unexpected_status",
      `memoryd MCP 健康检查返回非预期状态（${probe.url}）：HTTP ${probe.status} ${probe.statusText ?? ""}。`
    )];
  }
  if (probe?.kind === "body") {
    return [error(
      "memoryd-health.unexpected_body",
      `memoryd MCP initialize 响应不符合预期（${probe.url}）：server=${probe.serverName ?? "missing"}，session=${probe.sessionId ? "present" : "missing"}。`
    )];
  }

  const severity = probeSeverityFor(snapshot, "com.alphaloop.memoryd");
  return [severity(
    "memoryd-health.unreachable",
    `memoryd MCP 健康检查不可达（${probe?.url ?? MEMORYD_MCP_DEFAULT_URL}）：${probe?.reason ?? "unknown error"}。`
      + (severity === error
        ? `${LOADED_BUT_UNREACHABLE_SUFFIX}请看 logs/memoryd.err.log，并确认 pnpm memoryd:install-runtime 已完成。`
        : "开发机上尚未安装 memoryd 是正常的；部署前请运行 pnpm memoryd:install-runtime。")
  )];
}

// Round-4 finding I5 - "broker-executor-health" check. broker-executor was
// one of the four daemons with NO health probe at all: the doctor knew only
// that launchd held its label, which stayed true while the process
// crash-looped. It is a KeepAlive HTTP service like platform-app, so
// "working" has the same observable meaning - its own /health route answers
// over loopback - and this check is deliberately the same shape as
// checkPlatformAppHealth rather than a second dialect.
//
// Port mirrors apps/broker-executor/src/index.ts's own
// `process.env.BROKER_EXECUTOR_PORT ?? 4312`. The route is served before any
// authentication (server.ts's first branch), so this needs no shared secret
// and never sees order data.
//
// Severity split matches platform-app's: unreachable is a `warn` (a dev
// machine legitimately does not run it), while a response that ARRIVES but
// is wrong is an `error` - the process is up and broken, which is exactly
// the state "loaded" could never distinguish.
const BROKER_EXECUTOR_HEALTH_DEFAULT_PORT = 4312;
const BROKER_EXECUTOR_HEALTH_TIMEOUT_MS = 1500;

async function checkBrokerExecutorHealth(snapshot) {
  const port = Number(
    snapshot.brokerExecutorPort ?? process.env.BROKER_EXECUTOR_PORT ?? BROKER_EXECUTOR_HEALTH_DEFAULT_PORT
  );
  const url = `http://127.0.0.1:${port}/health`;
  const timeoutMs = Number(snapshot.brokerExecutorHealthTimeoutMs ?? BROKER_EXECUTOR_HEALTH_TIMEOUT_MS);
  const fetchImpl = typeof snapshot.fetchImpl === "function" ? snapshot.fetchImpl : fetch;

  let response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    response = await fetchImpl(url, { signal: controller.signal });
  } catch (fetchError) {
    const severity = probeSeverityFor(snapshot, "com.openclaw.system.trading.broker-executor");
    return [severity(
      "broker-executor-health.unreachable",
      `broker-executor 健康检查不可达（${url}）：${describeError(fetchError)}。`
        + (severity === error
          ? `${LOADED_BUT_UNREACHABLE_SUFFIX}最常见的原因是缺 BROKER_EXECUTOR_SHARED_SECRET——缺它时进程会在绑定端口前就退出，`
            + `而 launchd 里仍然显示「已加载」。请看 ~/.openclaw/system-logs/broker-executor.system.err.log。`
          : `开发机上没起这个服务是正常的；部署机器上请跑 ${LAUNCHD_INSTALL_COMMAND.system} `
            + `安装 com.openclaw.system.trading.broker-executor（系统域 daemon），并确认 BROKER_EXECUTOR_SHARED_SECRET 已配置。`)
    )];
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    return [error(
      "broker-executor-health.unexpected_status",
      `broker-executor 健康检查返回非预期状态码（${url}）：HTTP ${response.status} ${response.statusText}。进程在跑但可能已经异常，请检查 broker-executor 日志。`
    )];
  }

  let body;
  try {
    body = await response.json();
  } catch (parseError) {
    return [error(
      "broker-executor-health.unexpected_body",
      `broker-executor 健康检查响应无法解析为 JSON（${url}）：${describeError(parseError)}。`
    )];
  }

  if (!body || body.ok !== true || body.service !== "broker-executor") {
    return [error(
      "broker-executor-health.unexpected_body",
      `broker-executor 健康检查响应内容不符合预期（${url}），期望 {"ok":true,"service":"broker-executor"}，实际收到：${JSON.stringify(body)}。`
    )];
  }

  return [];
}

// Round-4 finding I5 - "daily-backup-health" check. daily-backup is the
// second of the four unprobed daemons, and unlike the KeepAlive services it
// has no port and writes no run_log row: the only thing that proves it did
// its job is the ARTIFACT it produces, `runtime/backups/trading-<日期>.sqlite`
// (see backup-trading-data.mjs's runBackup). So "working" here means "the
// newest backup file is dated today or yesterday".
//
// The date comes from parseBackupFileDate/formatLocalDate imported from that
// same producer module rather than a second copy of its file-name pattern
// and time zone - a doctor that parsed the file name slightly differently
// from the writer would silently read every backup as missing.
//
// Threshold rationale, chosen so it can NEVER false-alarm on timing: the job
// runs at 05:30 local daily (install-system-daemons.sh's
// SCHEDULE_DAILY_BACKUP). At 05:29 the newest backup is legitimately
// yesterday's, so a one-day gap is normal all day long; two days means at
// least one scheduled run was missed with a further full day of slack on top.
// Hence `>= 2` and not `>= 1`. A machine that has never produced a backup at
// all is a `warn`, not an error - a freshly installed daemon really has
// nothing yet, and its first run lands within a day.
const DAILY_BACKUP_STALE_DAYS = 2;
const DAILY_BACKUP_TIMEZONE = "Asia/Shanghai";

function checkDailyBackupHealth(snapshot, nowMs) {
  if (!snapshot.runtimeRoot || !isLaunchdJobLoaded(snapshot, "com.alphaloop.daily-backup")) {
    return [];
  }

  const backupsDir = join(snapshot.runtimeRoot, "backups");
  const stamps = existsSync(backupsDir)
    ? readdirSync(backupsDir)
      .filter((name) => name.startsWith("trading-"))
      .map((name) => parseBackupFileDate(name))
      .filter(Boolean)
      .sort()
    : [];
  const newest = stamps.at(-1) ?? null;

  if (!newest) {
    return [warn(
      "daily-backup-health.never_ran",
      `com.alphaloop.daily-backup 已加载，但 ${backupsDir} 里没有任何 trading-<日期>.sqlite 备份——这个任务从未成功产出过。`
        + `可以手动跑一次 pnpm backup:daily 看它报什么错。`
    )];
  }

  const todayStamp = formatLocalDate(new Date(nowMs), DAILY_BACKUP_TIMEZONE);
  const ageDays = Math.round(
    (Date.parse(`${todayStamp}T00:00:00Z`) - Date.parse(`${newest}T00:00:00Z`)) / 86_400_000
  );
  if (Number.isFinite(ageDays) && ageDays >= DAILY_BACKUP_STALE_DAYS) {
    return [error(
      "daily-backup-health.stale",
      `每日备份已经 ${ageDays} 天没有产出：${backupsDir} 里最新的一份是 trading-${newest}.sqlite，今天是 ${todayStamp}。`
        + `com.alphaloop.daily-backup 每天 05:30 跑一次，隔两天就说明至少漏了一次。请看 logs/daily-backup.err.log，或手动跑 pnpm backup:daily 复现。`
    )];
  }

  return [];
}

// 2026-07-30 - "stock-analysis-health" check.
//
// The gap this closes is one an operator hit head-on: on 2026-07-30 the site
// was serving the 2026-07-27 batch's support level for TSM.US (398.37, against
// a real price near 375) and NOTHING anywhere said the batch was three days
// old. The cron job was registered and firing daily; every firing skipped
// `not_due` and exited 0, so run_log, the cron runner's result files and the
// runner's own failure/halt machinery all recorded health. A pipeline that
// stops by SKIPPING is invisible to a failure counter.
//
// So this check does not look at exit codes at all. It reads what is ON
// DISPLAY - the newest delivered `stock_analysis_runs` row, whose
// markdown_path names the very report file the platform app renders - and
// judges its age against the cadence (stock-analysis-freshness.mjs owns both
// the reading and the threshold, so /health and the job's own stall alert can
// never disagree about whether the pipeline is stalled).
//
// Gated on the pool actually having symbols in it: `runScheduled` refuses to
// produce anything when `stock_analysis_targets` has no active row, so on a
// machine where nobody has configured a watchlist, "no batch" is the correct
// state and complaining about it would be noise. That gate is read from the
// db, not assumed.
function checkStockAnalysisHealth(snapshot, nowMs) {
  if (!snapshot.dbPath) {
    return [];
  }

  return withReadOnlyTradingDb(snapshot.dbPath, "stock-analysis-health", "个股分析产出", (db) => {
    const targets = db
      .prepare("SELECT COUNT(*) AS n FROM stock_analysis_targets WHERE active = 1")
      .get();
    if (Number(targets?.n ?? 0) === 0) {
      return [];
    }

    const freshness = computeStockAnalysisFreshness(db, new Date(nowMs));
    if (!freshness.stale) {
      return [];
    }
    if (freshness.latestLabel === null) {
      return [warn(
        "stock-analysis-health.never_ran",
        `${describeStockAnalysisFreshness(freshness)}`
          + `标的池里有 ${Number(targets?.n ?? 0)} 只在用标的，但 stock_analysis_runs 表里没有任何一次交付记录。`
          + `可以手动跑一次 pnpm stock-analysis:run 看它报什么错。`
      )];
    }
    return [error(
      "stock-analysis-health.stale",
      `${describeStockAnalysisFreshness(freshness)}`
        + `openclaw-trading-stock-analysis 每天 21:00 触发一次，隔这么久没产出说明它每次都跳过或每次都失败了。`
        + `请看 runtime/openclaw-cron-runner/ 里最近的 *-stock-analysis.json（stdoutTail 会写明 skipped 的原因），`
        + `以及 run_log 里 job='stock-analysis' 的行。`
    )];
  });
}

// Round-4 finding I5 - "official-paper-health" check, covering the last two
// unprobed daemons (com.openclaw.trading.official-paper.poll and .pnl).
// Neither writes run_log and neither binds a port; what each one produces is
// a ROW in official_paper_snapshots tagged with its own `reason` (see
// official-paper-monitor.mjs's saveSnapshot call sites: "hourly_poll" for the
// poll job, "post_open_pnl" for the pnl job). So "working" = "a row carrying
// my reason exists, and it is recent".
//
// Both jobs fire on the clock but no-op outside their window (the plists run
// them hourly; the scripts' own shouldRunOfficialPaperHourlyPoll /
// shouldRunOfficialPaperPnlReport return false and print `{"skipped":true}`),
// so freshness is only judgeable DURING US regular market hours - and only
// once enough of the session has elapsed that a run was actually due:
//
//   poll - hourly from 09:30 ET. Judged from 2 hours after the open, by which
//          point the 09:30 and 10:30 runs have both come and gone, so a
//          newest row older than 2 hours means two consecutive misses. Before
//          then the newest row is legitimately yesterday's and judging it
//          would fire every single morning.
//   pnl  - only ever acts at 10:00 ET. Judged from 11:00 ET, when today's run
//          is an hour past due; the row must then be under 24h old, which is
//          false exactly when today's 10:00 run did not happen (yesterday's
//          is 25h+ old by 11:00, and Friday's is 73h+ old by Monday 11:00).
//
// Outside those windows this check reports nothing rather than guessing - the
// launchd exit-code assertion above is what covers these two jobs at other
// hours.
const OFFICIAL_PAPER_POLL_STALE_MS = 2 * 60 * 60_000;
const OFFICIAL_PAPER_POLL_JUDGE_AFTER_MINUTES = 120;
const OFFICIAL_PAPER_PNL_STALE_MS = 24 * 60 * 60_000;
const OFFICIAL_PAPER_PNL_JUDGE_FROM_HOUR = 11;
// Mirrors trading-schedule.mjs's own NEW_YORK_TIMEZONE (not exported there);
// same "mirror the constant with a comment, don't import the module graph"
// rule the platform-app/rsshub checks already follow.
const NEW_YORK_TIMEZONE = "America/New_York";

function checkOfficialPaperHealth(snapshot, nowMs) {
  const pollLoaded = isLaunchdJobLoaded(snapshot, "com.openclaw.trading.official-paper.poll");
  const pnlLoaded = isLaunchdJobLoaded(snapshot, "com.openclaw.trading.official-paper.pnl");
  if (!snapshot.dbPath || (!pollLoaded && !pnlLoaded)) {
    return [];
  }

  let marketHours;
  try {
    marketHours = isUsRegularMarketHours(new Date(nowMs));
  } catch (calendarError) {
    // Same failure mode checkStaleHeartbeatMarketHours already guards
    // against: trading-schedule.mjs throws for any year missing from its
    // hardcoded NYSE calendar. Say we could not judge; never claim health
    // that was not observed.
    const year = describeError(calendarError).match(/year (\d{4})/u)?.[1] ?? "当前";
    return [warn(
      "official-paper-health.calendar_uncovered",
      `无法判断当前是否处于交易时段（交易日历未覆盖 ${year} 年），因此没有检查官方模拟盘轮询/收支任务的新鲜度。请更新 trading-schedule.mjs 的交易日历。`
    )];
  }

  if (!marketHours) {
    return [];
  }

  const parts = getZonedParts(new Date(nowMs), NEW_YORK_TIMEZONE);
  const minutesSinceOpen = parts.hour * 60 + parts.minute - (9 * 60 + 30);
  const judgePoll = pollLoaded && minutesSinceOpen >= OFFICIAL_PAPER_POLL_JUDGE_AFTER_MINUTES;
  const judgePnl = pnlLoaded && parts.hour >= OFFICIAL_PAPER_PNL_JUDGE_FROM_HOUR;
  if (!judgePoll && !judgePnl) {
    return [];
  }

  return withReadOnlyTradingDb(snapshot.dbPath, "official-paper-health", "官方模拟盘轮询/收支任务", (db) => {
    const findings = [];
    if (judgePoll) {
      findings.push(...checkOfficialPaperReason(db, nowMs, {
        reason: "hourly_poll",
        code: "poll",
        job: "com.openclaw.trading.official-paper.poll",
        description: "官方模拟盘每小时轮询",
        staleMs: OFFICIAL_PAPER_POLL_STALE_MS,
        staleText: "2 小时"
      }));
    }
    if (judgePnl) {
      const pnlFindings = checkOfficialPaperReason(db, nowMs, {
        reason: "post_open_pnl",
        code: "pnl",
        job: "com.openclaw.trading.official-paper.pnl",
        description: "官方模拟盘开盘后收支报告",
        staleMs: OFFICIAL_PAPER_PNL_STALE_MS,
        staleText: "24 小时"
      });
      findings.push(...pnlFindings);
      if (pnlFindings.length === 0 && snapshot.repoRoot) {
        findings.push(...checkOfficialPaperPnlArtifact(db, snapshot.repoRoot));
      }
    }
    return findings;
  });
}

function checkOfficialPaperReason(db, nowMs, options) {
  const row = db
    .prepare(`SELECT COUNT(*) AS row_count, MAX(fetched_at) AS latest FROM official_paper_snapshots WHERE reason = ?`)
    .get(options.reason);

  if (Number(row?.row_count ?? 0) === 0) {
    return [warn(
      `official-paper-health.${options.code}.never_ran`,
      `${options.job} 已加载，但 official_paper_snapshots 里没有任何 reason=${options.reason} 的记录——${options.description}从未成功写入过数据。`
        + `请检查长桥凭据与该任务的错误日志。`
    )];
  }

  const latest = row?.latest ? String(row.latest) : null;
  const latestMs = latest ? Date.parse(latest) : Number.NaN;
  // A non-empty table whose MAX(fetched_at) is unusable counts as stale, for
  // the same reason checkNewsEngineHealth treats an all-NULL timestamp column
  // that way: "we cannot prove freshness" must never pass as "fresh".
  if (!Number.isFinite(latestMs) || Number(nowMs) - latestMs > options.staleMs) {
    return [error(
      `official-paper-health.${options.code}.stale`,
      `${options.description}已经超过${options.staleText}没有新记录（当前处于美股常规交易时段，最近一次 reason=${options.reason} 的 fetched_at=${latest ?? "未知"}）。`
        + `${options.job} 很可能正在失败——请看它的错误日志。`
    )];
  }

  return [];
}

// The pnl job writes its snapshot row FIRST and renders
// reports/official-paper/<日期>-post-open.md afterwards (official-paper-
// monitor.mjs's sendPnlReport), so a fresh row with no matching markdown is
// exactly the half-finished run a row-only probe would call healthy. The date
// is derived the way the producer derives it: `fetchedAt.slice(0, 10)`.
function checkOfficialPaperPnlArtifact(db, repoRoot) {
  const row = db
    .prepare(`SELECT MAX(fetched_at) AS latest FROM official_paper_snapshots WHERE reason = 'post_open_pnl'`)
    .get();
  const latest = row?.latest ? String(row.latest) : null;
  if (!latest) {
    return [];
  }
  const markdownPath = join(repoRoot, "reports", "official-paper", `${latest.slice(0, 10)}-post-open.md`);
  if (existsSync(markdownPath)) {
    return [];
  }
  return [error(
    "official-paper-health.pnl.report_missing",
    `官方模拟盘收支任务写入了 ${latest} 的快照，但对应的报告文件不存在（${markdownPath}）——这一次运行只完成了一半，`
      + `报告渲染或投递环节失败了。请看 runtime/launchd/com.openclaw.trading.official-paper.pnl.err.log。`
  )];
}

// Phase 4 Task 8 (news engine deployment wiring) - "rsshub-health" check:
// hits the rsshub Docker container's own health route directly over
// loopback HTTP, exactly mirroring checkPlatformAppHealth's shape above
// (reachable-ok / reachable-but-broken / unreachable) plus one RSSHub-
// specific wrinkle: it tries `/healthz` first and falls back to `/` only on
// a 404 (older RSSHub builds never grew a dedicated health route and only
// ever answer on `/`) - any OTHER non-200 (500, timeout, etc.) is reported
// as-is without a fallback attempt, since that already proves the process is
// reachable but unhealthy rather than "this route doesn't exist here".
//
// Base URL resolution mirrors the task's own spec text
// (`${RSSHUB_BASE_URL ?? http://127.0.0.1:1200}`) and matches how
// checkPlatformAppHealth resolves its port: `snapshot.rsshubBaseUrl` is a
// test-only injection point ahead of both (real callers, i.e.
// openclaw-runtime-doctor.mjs, never set it, so production behavior reads
// straight from the env var with the documented default).
//
// Severity split (task brief): a dev machine legitimately has never run P10
// (the container doesn't exist yet, or Docker itself isn't running) - that
// is only a `warn`, naming the actual one-time creation command so an
// operator gets the real next step instead of a vague "it's down". A
// response that DOES arrive but isn't 200 (after the `/healthz` -> `/`
// fallback) means the process is up but broken - that's an `error`.
//
// Never throws/rejects on its own, same contract as checkPlatformAppHealth.
async function checkRsshubHealth(snapshot) {
  const baseUrl = String(snapshot.rsshubBaseUrl ?? process.env.RSSHUB_BASE_URL ?? RSSHUB_HEALTH_DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/u, "") || RSSHUB_HEALTH_DEFAULT_BASE_URL;
  const timeoutMs = Number(snapshot.rsshubHealthTimeoutMs ?? RSSHUB_HEALTH_TIMEOUT_MS);
  const fetchImpl = typeof snapshot.fetchImpl === "function" ? snapshot.fetchImpl : fetch;

  async function fetchWithTimeout(path) {
    const url = `${baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return { url, response: await fetchImpl(url, { signal: controller.signal }) };
    } finally {
      clearTimeout(timeout);
    }
  }

  let attempt;
  try {
    attempt = await fetchWithTimeout("/healthz");
    if (attempt.response.status === 404) {
      attempt = await fetchWithTimeout("/");
    }
  } catch (fetchError) {
    // com.alphaloop.rsshub is the one user-domain label here. Loaded means the
    // agent ran `docker start rsshub` at login: the container should be
    // answering on 1200, and "it is not" is the failure that agent exists to
    // prevent (measured on the mini: last exit code = 1, i.e. `docker start`
    // failed and nothing noticed).
    const severity = probeSeverityFor(snapshot, "com.alphaloop.rsshub");
    return [severity(
      "rsshub-health.unreachable",
      `RSSHub 健康检查不可达（${baseUrl}）：${describeError(fetchError)}。`
        + (severity === error
          ? `${LOADED_BUT_UNREACHABLE_SUFFIX}com.alphaloop.rsshub 只负责 docker start，不会创建容器；`
            + `请看 logs/rsshub.err.log，容器不存在时用 ${RSSHUB_P10_CONTAINER_COMMAND} 重建（必须走 login shell）。`
          : `如果这台机器还没有创建过 rsshub 容器，请先完成 P10 点火：${RSSHUB_P10_CONTAINER_COMMAND}；`
            + `如果容器已经创建过、只是这次重启后没跟着起，请跑 pnpm launchd:install-backup-alerts 安装 com.alphaloop.rsshub 任务（负责 docker start rsshub）。`)
    )];
  }

  if (!attempt.response.ok) {
    return [error(
      "rsshub-health.unexpected_status",
      `RSSHub 健康检查返回非预期状态码（${attempt.url}）：HTTP ${attempt.response.status} ${attempt.response.statusText}。容器进程可能在跑但已经异常，请检查 docker logs rsshub。`
    )];
  }

  return [];
}

// Phase 4 Task 8 (news engine deployment wiring) - "news-engine-health"
// check: news_events going quiet for 48h+ while the table genuinely already
// has data means the collection pipeline (RSSHub/Finnhub/openclaw cron) has
// silently stopped - as opposed to a fresh install that has simply never
// collected anything yet.
//
// Reuses news-store.mjs's newsEngineHealthStats (not raw SQL here) per that
// module's own header rule that all SQL/JSON access to the news tables
// funnels through it; opens/closes its own trading-db connection
// independently of checkAlertsPollerHealth's (failure isolation - one must
// not depend on, or be starved by, the other).
//
// eventCount === 0 (fresh install, migration ran but nothing collected yet)
// is deliberately NOT a finding at all - "no news yet" and "news stopped
// arriving" need different signals, and this check only has one to give.
// A non-empty table whose MAX(last_published_at) is NULL (every stored
// event's own last_published_at is unknown, i.e. every source's
// published_at was unknown) is treated as stale too: SQL aggregates ignore
// NULL, so this is indistinguishable from "we cannot prove freshness" - the
// same "never assume freshness when time is unknown" principle the plan's
// Global Constraints apply to report rendering (recency sort/7-day window)
// applies here too, just inverted (default to "investigate", not "silently
// pass").
function checkNewsEngineHealth(snapshot, nowMs) {
  if (!snapshot.dbPath) {
    return [];
  }

  return withReadOnlyTradingDb(snapshot.dbPath, "news-engine-health", "新闻引擎状态", (db) => {
    const stats = newsEngineHealthStats(db);
    if (stats.eventCount === 0) {
      return [];
    }

    const lastMs = stats.lastPublishedAt ? Date.parse(stats.lastPublishedAt) : NaN;
    const isStale = !Number.isFinite(lastMs) || nowMs - lastMs > NEWS_ENGINE_STALE_THRESHOLD_MS;
    if (isStale) {
      return [warn(
        "news-engine-health.stale",
        `新闻引擎超过 48 小时无新事件（news_events 共 ${stats.eventCount} 条事件，最近一次 last_published_at=${stats.lastPublishedAt ?? "未知"}）。请检查 RSSHub/Finnhub 采集与 openclaw cron 是否正常运行。`
      )];
    }

    return [];
  });
}

// "login-delivery-health" (2026-07-30, J4 follow-up): are login codes that
// members request actually ARRIVING?
//
// By design (routes/login.ts's anti-enumeration rule) the member always sees
// the same 「已发送」 page, the throttle slot is reserved BEFORE the send is
// attempted, and a failed delivery is only a stderr line plus a throttled
// Feishu alert - and the dominant failure mode IS Feishu being down, in which
// case that alert rides the broken channel. This check is the layer that needs
// no Feishu: it reads the trading db read-only and compares the two ledgers
// the login route writes:
//
//   login_send_log      one row per RESERVED send (written before the attempt;
//                       includes addresses that match no member).
//   login_delivery_log  one row per delivery ATTEMPT at a real active member
//                       (v19 migration), success or failure.
//
// Reservations are tied back to members by recomputing each ACTIVE member's
// email hash (loginEmailKeyHash above - the same sha256 login_send_log
// stores); reservations that match no member are stranger-controlled traffic
// and are deliberately ignored, so probing the form cannot make this check
// (or bury this check in) noise.
//
// Failure conditions, exactly:
//   .delivery_failing (error)  some member's LATEST outcome in the last 24h is
//                              a failure - their codes are not arriving right
//                              now (a later success clears it per member).
//   .missing_outcomes (error)  a member-linked reservation older than 5
//                              minutes has FEWER outcome rows than
//                              reservations for that member - the delivery job
//                              died (or the process was killed) between
//                              reserving the slot and recording any outcome.
//   .recent_failures (warn)    failures happened in the window but every
//                              member's latest attempt succeeded - recovered,
//                              still worth an operator's glance.
//   .table_missing (warn)      members ARE requesting codes but the db has no
//                              login_delivery_log table yet (schema older than
//                              v19) - the machine cannot vouch for delivery at
//                              all until the migration lands.
function checkLoginDeliveryHealth(snapshot, nowMs) {
  if (!snapshot.dbPath) {
    return [];
  }

  return withReadOnlyTradingDb(snapshot.dbPath, "login-delivery-health", "登录验证码投递", (db) => {
    const tables = new Set(
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('members', 'login_send_log', 'login_delivery_log')`)
        .all()
        .map((row) => String(row.name))
    );
    if (!tables.has("members") || !tables.has("login_send_log")) {
      // Pre-v15 schema: the email-code login does not exist here at all.
      return [];
    }

    const windowStartIso = new Date(nowMs - LOGIN_DELIVERY_WINDOW_MS).toISOString();
    const activeMembers = db
      .prepare(`SELECT id, email FROM members WHERE status = 'active' AND id <> ? AND email IS NOT NULL AND email <> ''`)
      .all(LOGIN_LEGACY_SYSTEM_MEMBER_ID);
    if (activeMembers.length === 0) {
      return [];
    }
    const memberIdByEmailHash = new Map(
      activeMembers.map((member) => [loginEmailKeyHash(member.email), String(member.id)])
    );

    const memberReservations = db
      .prepare(`SELECT key_hash, created_at FROM login_send_log WHERE scope = 'email' AND created_at >= ?`)
      .all(windowStartIso)
      .filter((row) => memberIdByEmailHash.has(String(row.key_hash)));

    if (!tables.has("login_delivery_log")) {
      if (memberReservations.length === 0) {
        return [];
      }
      return [warn(
        "login-delivery-health.table_missing",
        `最近 24 小时内成员请求过 ${memberReservations.length} 次登录验证码，但数据库还没有 login_delivery_log 表`
          + `（schema 早于 v19），无法判断验证码是否真的送达。请部署包含 v19 迁移的最新代码并重启 platform-app。`
      )];
    }

    const outcomes = db
      .prepare(`SELECT member_id, email_hash, ok, reason, created_at FROM login_delivery_log WHERE created_at >= ? ORDER BY created_at ASC`)
      .all(windowStartIso);

    const findings = [];

    // Latest outcome per email hash: a member whose most recent attempt failed
    // is failing NOW; an earlier failure a later success papered over is only
    // history. Rows are grouped by email_hash (always present - the crash path
    // has no member_id) and displayed by member id where one is known.
    const latestByHash = new Map();
    let failureCount = 0;
    for (const row of outcomes) {
      latestByHash.set(String(row.email_hash), row);
      if (Number(row.ok) !== 1) {
        failureCount += 1;
      }
    }
    const failingNow = [...latestByHash.entries()].filter(([, row]) => Number(row.ok) !== 1);
    if (failingNow.length > 0) {
      const described = failingNow.map(([hash, row]) => {
        const memberId = row.member_id ? String(row.member_id) : memberIdByEmailHash.get(hash) ?? "成员未知";
        return `${memberId}（最近一次 ${row.created_at}，原因 ${row.reason ?? "未知"}）`;
      });
      findings.push(error(
        "login-delivery-health.delivery_failing",
        `登录验证码正在投递失败：最近 24 小时共 ${failureCount} 次失败，其中 ${failingNow.length} 个账号`
          + `最后一次尝试仍是失败——${described.join("；")}。成员侧只会看到「已发送」，不会有任何报错。`
          + `请检查飞书应用凭据与通道，并 grep platform-app err.log 中的 LOGIN-DELIVERY-FAILED。`
      ));
    } else if (failureCount > 0) {
      findings.push(warn(
        "login-delivery-health.recent_failures",
        `最近 24 小时内有 ${failureCount} 次登录验证码投递失败，但相关账号最后一次投递均已成功（已自行恢复）。`
          + `失败明细见 platform-app err.log 的 LOGIN-DELIVERY-FAILED 行。`
      ));
    }

    // Reservation-vs-outcome comparison, per member-linked email hash: a
    // reservation is a promise that a delivery was attempted, so (allowing the
    // settle grace for in-flight sends) each hash must have at least as many
    // outcome rows as settled reservations. Fewer means the background job
    // died before recording ANYTHING - the one failure shape the outcome
    // ledger itself cannot report.
    const settleCutoffIso = new Date(nowMs - LOGIN_DELIVERY_SETTLE_GRACE_MS).toISOString();
    const settledReservationsByHash = new Map();
    for (const row of memberReservations) {
      if (String(row.created_at) > settleCutoffIso) {
        continue;
      }
      const hash = String(row.key_hash);
      settledReservationsByHash.set(hash, (settledReservationsByHash.get(hash) ?? 0) + 1);
    }
    const outcomeCountByHash = new Map();
    for (const row of outcomes) {
      const hash = String(row.email_hash);
      outcomeCountByHash.set(hash, (outcomeCountByHash.get(hash) ?? 0) + 1);
    }
    let missingCount = 0;
    const missingMembers = new Set();
    for (const [hash, reserved] of settledReservationsByHash) {
      const recorded = outcomeCountByHash.get(hash) ?? 0;
      if (recorded < reserved) {
        missingCount += reserved - recorded;
        missingMembers.add(memberIdByEmailHash.get(hash) ?? "成员未知");
      }
    }
    if (missingCount > 0) {
      findings.push(error(
        "login-delivery-health.missing_outcomes",
        `最近 24 小时内有 ${missingCount} 次成员验证码请求只留下了 login_send_log 预约、没有任何投递结果记录`
          + `（涉及：${[...missingMembers].join("、")}）。这说明后台投递任务在记录结果前就中断了`
          + `（进程崩溃/重启、数据库不可写，或成员在请求后才被激活）。请查看 platform-app err.log 并让该成员重试。`
      ));
    }

    return findings;
  });
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

  findings.push(...withReadOnlyTradingDb(snapshot.dbPath, "alerts-poller-health", "提醒器 run_log", (db) => {
    const dbFindings = [];
    const lastRun = lastRunAt(db, CRON_JOB_MARKET_ALERTS);
    if (lastRun === null) {
      dbFindings.push(warn("alerts-poller-health.never_ran", "提醒器从未运行过（run_log 中没有 market-alerts 记录）。"));
    } else {
      const lastRunMs = Date.parse(lastRun);
      const isStale = Number.isFinite(lastRunMs) && nowMs - lastRunMs > ALERTS_STALE_HEARTBEAT_MS;
      if (isStale) {
        dbFindings.push(...checkStaleHeartbeatMarketHours(lastRun, nowMs));
      }
    }

    const consecutiveFailures = consecutiveFailureCount(db, CRON_JOB_MARKET_ALERTS);
    if (consecutiveFailures >= ALERTS_CONSECUTIVE_FAILURE_THRESHOLD) {
      dbFindings.push(error(
        "alerts-poller-health.consecutive_failures",
        `提醒器连续失败 ${consecutiveFailures} 次（阈值 ${ALERTS_CONSECUTIVE_FAILURE_THRESHOLD}）。`
      ));
    }
    return dbFindings;
  }));

  return findings;
}

// Task 24 (2026-07-28 spec-drift remediation) - "scheduled-job-heartbeat".
//
// checkAlertsPollerHealth above did this for exactly one job, `market-alerts`,
// because until this task that was the only SCHEDULED launchd job that wrote
// run_log rows at all. Measured read-only on the live mini on 2026-07-29:
// run_log held rows for market-alerts / proposal-sweep / daily / stock-analysis
// / weekly and NOTHING for com.alphaloop.daily-backup or the two official-paper
// daemons, so "launchd never fired it" and "it threw on every tick for a week"
// were the same observation - no rows.
//
// This is the run_log half for the other three. It is deliberately NOT a
// replacement for daily-backup-health / official-paper-health, which read the
// ARTIFACTS those jobs are supposed to produce: a job can tick happily and
// still produce nothing (checkStockAnalysisHealth's own header documents that
// exact failure), and conversely a job can be un-fired by launchd while
// yesterday's artifact still looks fresh. The two halves answer different
// questions and both are needed.
//
// Gated on the label actually being loaded in launchd, like every other job
// check here - on a machine that never installed the daemons, "no heartbeat"
// is the correct state, not a symptom.
function checkScheduledJobHeartbeats(snapshot, nowMs) {
  if (!snapshot.dbPath) {
    return [];
  }
  const loaded = SCHEDULED_LAUNCHD_JOBS.filter((entry) => isLaunchdJobLoaded(snapshot, entry.label));
  if (loaded.length === 0) {
    return [];
  }

  return withReadOnlyTradingDb(snapshot.dbPath, "scheduled-job-heartbeat", "定时任务 run_log", (db) => {
    const findings = [];
    for (const entry of loaded) {
      const lastRun = lastRunAt(db, entry.job);
      if (lastRun === null) {
        findings.push(warn(
          `scheduled-job-heartbeat.${entry.job}.never_ran`,
          `${entry.label} 已加载，但 run_log 里没有任何 job=${entry.job} 的记录——launchd 可能从未真正触发过它，`
            + `也可能它每次都在写心跳之前就崩了。请看该任务的 launchd 错误日志。`
        ));
        continue;
      }

      const lastRunMs = Date.parse(lastRun);
      if (!Number.isFinite(lastRunMs) || nowMs - lastRunMs > entry.staleAfterMs) {
        findings.push(warn(
          `scheduled-job-heartbeat.${entry.job}.stale`,
          `${entry.displayName}（${entry.label}）最近一次 run_log 心跳是 ${lastRun}，`
            + `已超过 ${Math.round(entry.staleAfterMs / 3_600_000)} 小时没有新记录——该任务可能已停止运行。`
        ));
      }

      const consecutiveFailures = consecutiveFailureCount(db, entry.job);
      if (consecutiveFailures >= SCHEDULED_JOB_ESCALATION_THRESHOLD) {
        findings.push(error(
          `scheduled-job-heartbeat.${entry.job}.consecutive_failures`,
          `${entry.displayName}（${entry.label}）已连续失败 ${consecutiveFailures} 次`
            + `（阈值 ${SCHEDULED_JOB_ESCALATION_THRESHOLD}）。该任务自己也应该已经发出过升级卡片。`
        ));
      }
    }
    return findings;
  });
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

// v2 persona deployment fix (the #1 user complaint: the deployed Feishu bot
// answered as vanilla Codex) - "control-persona" check: the control agent's
// workspace AGENTS.md is the persona/instructions file the embedded codex
// harness reads, and with `skipBootstrap: true` NOTHING else ever writes it -
// only render-openclaw-config.mjs's installControlPersona does. A missing or
// empty file means the bot is running with no persona at all, silently
// answering as a vanilla assistant while every other health signal stays
// green - severity `error`, because the runtime is up but functionally wrong.
//
// Path resolution: `snapshot.controlWorkspaceAgentsPath` is a test-only
// injection point (mirrors platformAppPort/rsshubBaseUrl above - real
// callers, i.e. openclaw-runtime-doctor.mjs, never set it); the production
// default mirrors buildAgents()'s own `workspace: "~/.openclaw/workspaces/
// control"` in render-openclaw-config.mjs.
function checkControlPersona(snapshot) {
  const path = snapshot.controlWorkspaceAgentsPath
    ?? join(homedir(), ".openclaw", "workspaces", "control", "AGENTS.md");

  if (!existsSync(path)) {
    return [error(
      "control-persona.missing",
      `control agent 工作区缺少人设文件（${path} 不存在）——飞书机器人会以无人设的 vanilla Codex 应答。`
        + `请执行 node apps/openclaw-config/scripts/render-openclaw-config.mjs 部署人设（skipBootstrap=true，没有其它任何流程会写这个文件）。`
    )];
  }

  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch (readError) {
    return [error(
      "control-persona.unreadable",
      `control agent 人设文件存在但无法读取（${path}）：${describeError(readError)}。`
        + `请执行 node apps/openclaw-config/scripts/render-openclaw-config.mjs 重新部署。`
    )];
  }

  if (content.trim().length === 0) {
    return [error(
      "control-persona.empty",
      `control agent 人设文件为空（${path}）——飞书机器人会以无人设的 vanilla Codex 应答。`
        + `请执行 node apps/openclaw-config/scripts/render-openclaw-config.mjs 重新部署人设。`
    )];
  }

  return [];
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
