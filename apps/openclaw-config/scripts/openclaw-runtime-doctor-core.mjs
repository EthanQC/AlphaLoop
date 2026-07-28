import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { openTradingDatabase } from "../../../packages/shared-types/dist/index.js";
import { readLaunchdOwnership } from "./install-launchd-ownership.mjs";
import { consecutiveFailureCount, lastRunAt } from "./job-run-log.mjs";
import { newsEngineHealthStats } from "./news-store.mjs";
import { CRON_JOB_MARKET_ALERTS } from "./openclaw-cron-runner-state.mjs";
import { isUsRegularMarketHours } from "./trading-schedule.mjs";

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
export function readLaunchdJobStates(requiredJobs = REQUIRED_LAUNCHD_JOBS, launchctl = runLaunchctl) {
  const userLabels = readUserDomainLaunchdLabels(launchctl);
  const uid = process.getuid?.();
  return requiredJobs.map((job) => {
    const loadedDomains = [];
    let userState = null;
    let systemState = null;

    if (userLabels.has(job.label)) {
      loadedDomains.push("user");
      userState = uid === undefined ? "unknown" : readLaunchdJobState(`gui/${uid}/${job.label}`, launchctl);
    }
    systemState = readLaunchdJobState(`system/${job.label}`, launchctl);
    if (systemState !== null) {
      loadedDomains.push("system");
    }

    return {
      label: job.label,
      expectedDomain: job.domain,
      loadedDomains,
      // Prefer the state from the domain that is supposed to own the job, so
      // a correctly installed machine reports the state that matters.
      state: (job.domain === "system" ? systemState ?? userState : userState ?? systemState) ?? null
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

// Returns the `state = ...` value when the job exists in that domain, `null`
// when it does not - so "exists" and "is currently executing" stay
// distinguishable (a periodic job between runs is legitimately loaded and not
// running, which must not be reported as missing).
function readLaunchdJobState(target, launchctl) {
  const output = launchctl(["print", target]);
  if (output === null) {
    return null;
  }
  return String(output).match(/^\s*state\s*=\s*(.+?)\s*$/mu)?.[1] ?? "unknown";
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
    { name: "news-engine-health", run: () => checkNewsEngineHealth(snapshot, nowMs) },
    { name: "control-persona", run: () => checkControlPersona(snapshot) }
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
function checkLaunchdJobs(snapshot) {
  const rows = Array.isArray(snapshot.launchdJobs) ? snapshot.launchdJobs : [];
  const byLabel = new Map(rows.map((row) => [String(row?.label), row]));
  const findings = [];

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
      findings.push(warn(
        `launchd-jobs.${job.slug}.not_loaded`,
        `launchd 任务 ${job.label} 未加载（${domainLabel} 与另一个域都没有命中）。部署机器上请执行 ${install} 安装；开发机上可以忽略。`
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
  }

  return findings;
}

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
    return [warn(
      "platform-app-health.unreachable",
      `platform-app 健康检查不可达（${url}）：${describeError(fetchError)}。开发机上尚未起服务是正常的——本地手动起服务请跑 pnpm platform:dev；`
        + `需要常驻运行请跑 ${LAUNCHD_INSTALL_COMMAND.system} 安装 com.alphaloop.platform-app（它是系统域 daemon，pnpm launchd:install-backup-alerts 装不上它）。`
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
