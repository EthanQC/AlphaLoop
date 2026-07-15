import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { openTradingDatabase } from "../../../packages/shared-types/dist/index.js";
import { consecutiveFailureCount, lastRunAt } from "./job-run-log.mjs";
import { newsEngineHealthStats } from "./news-store.mjs";
import { CRON_JOB_MARKET_ALERTS } from "./openclaw-cron-runner-state.mjs";
import { isUsRegularMarketHours } from "./trading-schedule.mjs";

// task H2 (Phase 2.5 hardening), extended in Phase 3 Task 8, extended again
// in Phase 4 Task 8: the launchd jobs install-launchd.sh wires up (see that
// script) - a dev machine legitimately runs none of them, so missing any one
// is a warn, not a fail (see `warn()` below - only "error" severity flips
// `ok` to false). com.alphaloop.platform-app (Phase 3 Task 8) and
// com.alphaloop.rsshub (Phase 4 Task 8) each joined this list the moment
// their own `.plist.template` was added alongside the rest -
// install-launchd.sh's glob (`*.plist.template`) already covers new files
// without modification, so this list is the only place that needed the
// addition either time.
const REQUIRED_LAUNCHD_JOBS = [
  { label: "com.alphaloop.daily-backup", slug: "daily-backup" },
  { label: "com.alphaloop.market-alerts", slug: "market-alerts" },
  { label: "com.alphaloop.platform-app", slug: "platform-app" },
  { label: "com.alphaloop.rsshub", slug: "rsshub" }
];

// Phase 3 Task 8 - "platform-app-health" check: platform-app is a KeepAlive
// server (unlike the periodic backup/alerts jobs above), so "is it loaded"
// is a weaker signal than "does its /health endpoint actually answer" - this
// check hits that endpoint directly. Port mirrors src/index.ts's own
// `process.env.PLATFORM_APP_PORT ?? 4314` fallback exactly, so the doctor
// checks whatever port the real process would actually bind to.
const PLATFORM_APP_HEALTH_DEFAULT_PORT = 4314;
const PLATFORM_APP_HEALTH_TIMEOUT_MS = 1500;

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
    { name: "launchd-jobs", run: () => checkLaunchdJobs(snapshot) },
    { name: "alerts-poller-health", run: () => checkAlertsPollerHealth(snapshot, nowMs) },
    { name: "platform-app-health", run: () => checkPlatformAppHealth(snapshot) },
    { name: "rsshub-health", run: () => checkRsshubHealth(snapshot) },
    { name: "news-engine-health", run: () => checkNewsEngineHealth(snapshot, nowMs) }
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
// hint naming both `pnpm platform:dev` (manual dev run) and
// `pnpm launchd:install-backup-alerts` (the same install-launchd.sh that
// installs the other two launchd jobs above - its `*.plist.template` glob
// already covers com.alphaloop.platform-app.plist.template with no changes
// needed, see REQUIRED_LAUNCHD_JOBS's own comment). A response that DOES
// arrive but is wrong (non-200, or a 200 whose body isn't the expected
// `{ok:true, service:"platform-app"}` shape) means the process is up but
// broken - that is an `error`, not a warn.
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
    return [warn(
      "platform-app-health.unreachable",
      `platform-app 健康检查不可达（${url}）：${describeError(fetchError)}。开发机上尚未起服务是正常的——本地手动起服务请跑 pnpm platform:dev；需要常驻运行请跑 pnpm launchd:install-backup-alerts 安装 launchd 任务（会一并装上 com.alphaloop.platform-app）。`
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
    return [warn(
      "rsshub-health.unreachable",
      `RSSHub 健康检查不可达（${baseUrl}）：${describeError(fetchError)}。如果这台机器还没有创建过 rsshub 容器，请先完成 P10 点火：`
        + `${RSSHUB_P10_CONTAINER_COMMAND}；如果容器已经创建过、只是这次重启后没跟着起，请跑 pnpm launchd:install-backup-alerts 安装 com.alphaloop.rsshub 任务（负责 docker start rsshub）。`
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

  let db;
  try {
    db = openTradingDatabase(snapshot.dbPath);
  } catch (openError) {
    return [error(
      "news-engine-health.db_unreachable",
      `无法打开交易数据库以检查新闻引擎状态：${describeError(openError)}`
    )];
  }

  try {
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
  } finally {
    db.close();
  }
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
