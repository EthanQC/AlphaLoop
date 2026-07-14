import { sanitizeAlertText } from "./openclaw-cron-runner-alerts.mjs";

// Jobs whose consecutive same-class failure count reaches this threshold are halted: the runner
// stops attempting further runs for that job until an operator resets it via cron-runner-reset.mjs.
export const HALT_THRESHOLD = 3;

// Single source of truth for every cron-ish job name this system recognizes
// (task H1, Phase 2.5 hardening - closes the dual-source bug where
// openclaw-cron-runner.mjs's allowedJobs/cronJobNames literals and this
// module's KNOWN_CRON_JOB_NAMES each hardcoded "daily"/"weekly"/
// "stock-analysis" as SEPARATE string literals, free to drift). This module
// is the lower-level one (openclaw-cron-runner.mjs already imports several
// functions FROM it, so the reverse dependency would be circular) - the
// runner now imports these constants and uses them as its allowedJobs/
// cronJobNames `name` fields instead of re-typing the strings.
//
// CRON_JOB_MARKET_ALERTS is NOT routed through the runner's HTTP job map at
// all - the market-alerts poller runs under launchd via its own
// StartInterval poll loop (see market-alerts-poll.mjs), never through
// openclaw-cron-runner.mjs's allowedJobs. It still needs a recognized name
// here so cron-runner-reset.mjs's KNOWN_CRON_JOB_NAMES whitelist accepts it
// as a resettable job name. (job-run-log.mjs itself does NOT consult
// KNOWN_CRON_JOB_NAMES at all - it is storage-only and will happily read/
// write a run_log row for any `job` string a caller passes it, known or
// not; this constant is for cron-runner-reset.mjs's CLI validation only.)
export const CRON_JOB_DAILY = "daily";
export const CRON_JOB_WEEKLY = "weekly";
export const CRON_JOB_STOCK_ANALYSIS = "stock-analysis";
export const CRON_JOB_MARKET_ALERTS = "market-alerts";

export const KNOWN_CRON_JOB_NAMES = Object.freeze([
  CRON_JOB_DAILY,
  CRON_JOB_WEEKLY,
  CRON_JOB_STOCK_ANALYSIS,
  CRON_JOB_MARKET_ALERTS
]);

export function normalizeRunnerState(value = {}) {
  return {
    processedRunKeys: uniqueStrings(value.processedRunKeys),
    failedRunAttempts: normalizeFailedRunAttempts(value.failedRunAttempts),
    alertedRunKeys: uniqueStrings(value.alertedRunKeys),
    jobFailureState: normalizeJobFailureState(value.jobFailureState)
  };
}

// Failure "class" groups errors that are likely the same root cause together, so unrelated
// failures (e.g. a one-off network blip followed by a real bug) don't accumulate into the same
// halt counter. Class key = jobName + normalized first line of the error message.
export function classifyFailure(jobName, errorMessage) {
  return `${String(jobName)}:${normalizeErrorFirstLine(errorMessage)}`;
}

export function shouldAttemptRun(state, runKey, nowMs = Date.now(), options = {}) {
  const normalized = normalizeRunnerState(state);
  const key = String(runKey);
  if (normalized.processedRunKeys.includes(key)) {
    return false;
  }

  const jobName = stringOrUndefined(options.jobName);
  if (jobName && normalized.jobFailureState[jobName]?.halted) {
    return false;
  }

  const failure = normalized.failedRunAttempts[key];
  if (!failure?.nextRetryAt) {
    return true;
  }
  const retryAtMs = Date.parse(failure.nextRetryAt);
  return !Number.isFinite(retryAtMs) || nowMs >= retryAtMs;
}

export function recordRunResult(state, runKey, result, nowMs = Date.now(), options = {}) {
  const normalized = normalizeRunnerState(state);
  const key = String(runKey);
  const jobName = resolveJobName(key, result, options);

  if (result?.ok) {
    normalized.processedRunKeys = pushUnique(normalized.processedRunKeys, key).slice(-limit(options.limit));
    delete normalized.failedRunAttempts[key];
    normalized.alertedRunKeys = normalized.alertedRunKeys.filter((value) => value !== key);
    normalized.jobFailureState[jobName] = createEmptyJobFailureState();
    return normalized;
  }

  const previous = normalized.failedRunAttempts[key];
  const attempts = Number(previous?.attempts ?? 0) + 1;
  const delayMs = retryDelayMs(attempts, options);
  const errorMessage = result?.error ?? result?.stderrTail ?? previous?.lastError;
  const failureClass = classifyFailure(jobName, errorMessage);

  const previousJobFailure = normalized.jobFailureState[jobName] ?? createEmptyJobFailureState();
  const sameClass = previousJobFailure.failureClass === failureClass;
  const consecutiveCount = sameClass ? previousJobFailure.consecutiveCount + 1 : 1;
  const halted = previousJobFailure.halted || consecutiveCount >= HALT_THRESHOLD;
  // The escalation alert is only ever sent once, right when a job transitions into halted; mark
  // it pending here (rather than after a successful send) so a crash/restart between "halted" and
  // "alert delivered" still leaves a durable pending flag for the next poll cycle to retry.
  const justHalted = !previousJobFailure.halted && halted;
  // Mirrors justHalted/escalationPending above, for the OTHER alert level getFailureAlertLevel
  // reports (the 1st-same-class-failure "notice"): a failed notice send used to have no retry
  // mechanism at all - shouldAlertFailure/recordFailureAlerted only mark it DELIVERED, never
  // "still owed" - so a notice whose send failed (network blip) was gone forever, unlike the
  // halt escalation which retries every cycle via escalationPending/getPendingEscalationJobs.
  // `justNoticed` fires exactly once per fresh same-class streak (consecutiveCount transitioning
  // to 1), matching getFailureAlertLevel's own `count === 1` check for "notice".
  const justNoticed = consecutiveCount === 1;
  normalized.jobFailureState[jobName] = {
    failureClass,
    consecutiveCount,
    halted,
    escalationPending: justHalted ? true : previousJobFailure.escalationPending,
    noticePending: justNoticed ? true : previousJobFailure.noticePending,
    lastResultPath: stringOrUndefined(result?.resultPath) ?? previousJobFailure.lastResultPath
  };

  normalized.failedRunAttempts[key] = {
    attempts,
    lastAttemptAt: new Date(nowMs).toISOString(),
    nextRetryAt: new Date(nowMs + delayMs).toISOString(),
    lastResultPath: stringOrUndefined(result?.resultPath ?? previous?.lastResultPath),
    lastError: stringOrUndefined(errorMessage)
  };
  return normalized;
}

// Which failure alert (if any) should be reported for the state of `jobName` right after a
// recordRunResult call. Only the 1st same-class failure (a heads-up) and the 3rd (the one that
// halts the job) get an alert; everything in between or after halting is silent.
export function getFailureAlertLevel(state, jobName) {
  const normalized = normalizeRunnerState(state);
  const entry = normalized.jobFailureState[String(jobName)];
  const count = Number(entry?.consecutiveCount ?? 0);
  if (count === 1) {
    return "notice";
  }
  if (count === HALT_THRESHOLD) {
    return "escalation";
  }
  return "none";
}

// Used by cron-runner-reset.mjs to clear a halted job's counters/flag after an operator has
// investigated and fixed the underlying issue.
export function resetJobFailureState(state, jobName) {
  const normalized = normalizeRunnerState(state);
  normalized.jobFailureState[String(jobName)] = createEmptyJobFailureState();
  return normalized;
}

// Called by the runner after an escalation alert (the halting failure, or a retry of it) is
// delivered successfully, so the poll-cycle retry loop stops retrying it.
export function clearEscalationPending(state, jobName) {
  const normalized = normalizeRunnerState(state);
  const name = String(jobName);
  const existing = normalized.jobFailureState[name];
  if (existing) {
    normalized.jobFailureState[name] = { ...existing, escalationPending: false };
  }
  return normalized;
}

// Called by the runner after a notice alert (the 1st-same-class-failure heads-up, or a retry of
// it) is delivered successfully - the notice-level counterpart to clearEscalationPending above.
export function clearNoticePending(state, jobName) {
  const normalized = normalizeRunnerState(state);
  const name = String(jobName);
  const existing = normalized.jobFailureState[name];
  if (existing) {
    normalized.jobFailureState[name] = { ...existing, noticePending: false };
  }
  return normalized;
}

// Jobs that are halted and whose escalation alert has not yet been confirmed delivered. The
// runner calls this once per poll cycle (independent of any new run-log activity, since a halted
// job's shouldAttemptRun gate means it produces no new run results to piggyback a retry on) and
// retries sending the escalation for each one.
export function getPendingEscalationJobs(state) {
  const normalized = normalizeRunnerState(state);
  return Object.entries(normalized.jobFailureState)
    .filter(([, jobFailure]) => jobFailure.halted && jobFailure.escalationPending)
    .map(([jobName, jobFailure]) => ({ jobName, jobFailure }));
}

// Notice-level counterpart of getPendingEscalationJobs above: jobs whose 1st-same-class-failure
// notice has not yet been confirmed delivered. Unlike escalation, this is NOT gated on `halted` -
// a notice fires well before a job reaches the halt threshold.
export function getPendingNoticeJobs(state) {
  const normalized = normalizeRunnerState(state);
  return Object.entries(normalized.jobFailureState)
    .filter(([, jobFailure]) => jobFailure.noticePending)
    .map(([jobName, jobFailure]) => ({ jobName, jobFailure }));
}

export function shouldAlertFailure(state, runKey) {
  const normalized = normalizeRunnerState(state);
  return !normalized.alertedRunKeys.includes(String(runKey));
}

export function recordFailureAlerted(state, runKey, options = {}) {
  const normalized = normalizeRunnerState(state);
  normalized.alertedRunKeys = pushUnique(normalized.alertedRunKeys, String(runKey)).slice(-limit(options.limit));
  return normalized;
}

export function serializeRunnerState(state, options = {}) {
  const normalized = normalizeRunnerState(state);
  normalized.processedRunKeys = normalized.processedRunKeys.slice(-limit(options.limit));
  normalized.alertedRunKeys = normalized.alertedRunKeys.slice(-limit(options.limit));
  return normalized;
}

function retryDelayMs(attempts, options) {
  const base = Math.max(1, Number(options.retryBaseMs ?? 60_000));
  const max = Math.max(base, Number(options.retryMaxMs ?? 30 * 60_000));
  return Math.min(max, base * 2 ** Math.max(0, attempts - 1));
}

function normalizeFailedRunAttempts(value) {
  const entries = value && typeof value === "object" ? Object.entries(value) : [];
  return Object.fromEntries(entries.flatMap(([key, raw]) => {
    if (!raw || typeof raw !== "object") {
      return [];
    }
    const attempts = Math.max(0, Number(raw.attempts ?? 0));
    return [[String(key), {
      attempts,
      lastAttemptAt: stringOrUndefined(raw.lastAttemptAt),
      nextRetryAt: stringOrUndefined(raw.nextRetryAt),
      lastResultPath: stringOrUndefined(raw.lastResultPath),
      lastError: stringOrUndefined(raw.lastError)
    }]];
  }));
}

// Backward compatible with state files written before the halt-after-3-same-class-failures
// machine existed: a missing/malformed jobFailureState is simply treated as "no job has ever
// failed" (count 0, not halted) rather than crashing.
function normalizeJobFailureState(value) {
  const entries = value && typeof value === "object" ? Object.entries(value) : [];
  return Object.fromEntries(entries.flatMap(([jobName, raw]) => {
    if (!raw || typeof raw !== "object") {
      return [];
    }
    return [[String(jobName), {
      failureClass: stringOrUndefined(raw.failureClass),
      consecutiveCount: Math.max(0, Number(raw.consecutiveCount ?? 0)),
      halted: Boolean(raw.halted),
      // Missing on state files written before the escalation-retry machine existed: treat as
      // false (no pending escalation) rather than crashing.
      escalationPending: Boolean(raw.escalationPending),
      // Missing on state files written before the notice-retry machine existed (this task): same
      // backward-compatible treatment as escalationPending above.
      noticePending: Boolean(raw.noticePending),
      lastResultPath: stringOrUndefined(raw.lastResultPath)
    }]];
  }));
}

function createEmptyJobFailureState() {
  return {
    failureClass: undefined,
    consecutiveCount: 0,
    halted: false,
    escalationPending: false,
    noticePending: false,
    lastResultPath: undefined
  };
}

// The runner always passes the job's stable label via result.job; fall back to the options hint
// or the runKey's leading segment so callers that don't set result.job (e.g. older tests) still
// get a stable-ish grouping instead of throwing.
function resolveJobName(runKey, result, options) {
  return (
    stringOrUndefined(result?.job) ??
    stringOrUndefined(options?.jobName) ??
    String(runKey).split(":")[0]
  );
}

function normalizeErrorFirstLine(errorMessage) {
  const firstLine = String(errorMessage ?? "").split(/\r?\n/u)[0] ?? "";
  // Redact secrets/tokens before this text is persisted to the state file or shown in an alert,
  // the same way the Feishu alert body is sanitized.
  const sanitized = sanitizeAlertText(firstLine, 500);
  return stripVolatileTokens(sanitized)
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 80);
}

// Strips the volatile, run-specific bits (timestamps, retry counters, pids, byte counts, ...) that
// vary between attempts of the SAME underlying failure but carry no information about WHICH root
// cause it is. Without this, an error like "Longbridge unavailable at 2026-07-14T10:23:45.123Z"
// classifies as a DIFFERENT class on every single attempt (a fresh timestamp every time) and the
// halt-after-3-same-class-failures machine (HALT_THRESHOLD above) can never reach 3, no matter how
// long the exact same failure persists - the one scenario it exists to catch.
function stripVolatileTokens(text) {
  return text
    // ISO-8601-ish timestamps: date, optional time-of-day, optional fractional seconds/zone.
    .replace(/\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?)?/giu, "<ts>")
    // Any other standalone run of digits (ports, pids, byte counts, epoch ms, attempt counters).
    .replace(/\d+/gu, "<n>");
}

function uniqueStrings(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean)));
}

function pushUnique(values, value) {
  return Array.from(new Set([...values, value].filter(Boolean)));
}

function stringOrUndefined(value) {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function limit(value) {
  return Math.max(1, Number(value ?? 1000));
}
