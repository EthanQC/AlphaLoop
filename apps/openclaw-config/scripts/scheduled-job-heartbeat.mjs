// Task 24 (2026-07-28 spec-drift remediation): run_log heartbeats + the
// consecutive-failure escalation for the SCHEDULED launchd jobs.
//
// The problem this fixes, measured read-only on the live mini (2026-07-29):
//
//   sqlite> SELECT job, COUNT(*), MAX(started_at) FROM run_log GROUP BY job;
//   market-alerts   605  2026-07-29T18:40:34Z
//   proposal-sweep   83  2026-07-29T18:04:00Z
//   daily            21  2026-07-29T14:33:59Z
//   stock-analysis   10  2026-07-29T13:00:30Z
//   weekly           13  2026-07-28T02:53:21Z
//
// Three of the machine's scheduled daemons are missing from that list
// entirely: com.alphaloop.daily-backup, com.openclaw.trading.official-paper.
// poll and .pnl. They had NO run_log row of any kind, so nothing could tell
// "ran fine" from "launchd never fired it" from "it has been throwing every
// hour for a week" - the only trace was a launchd stderr log nobody reads.
// The doctor's alerts-poller-health check (openclaw-runtime-doctor-core.mjs)
// already knew how to turn run_log into a heartbeat/streak finding, but it
// only ever looked at `market-alerts`, because that was the only scheduled
// job that wrote rows.
//
// This module is the shared wrapper those three now run inside. It is
// deliberately much smaller than market-alerts-poll.mjs's own escalation
// machine and does NOT copy its file-based fallback counter or its
// ALERTER-DOWN artifact: those exist because the alerter is the thing that
// tells you about everything else, so its own blindness has to survive an
// unopenable database. These three jobs are ordinary scheduled work - when
// their database cannot be opened they simply fail, and the failure is
// reported by whatever opened the db in the first place.
//
// What it does provide, reusing job-run-log.mjs's existing storage rather
// than forking it:
//
//   1. one run_log row per invocation (ok, failed, or neutral/not-due), which
//      proves process liveness without erasing the last due run's health;
//   2. an operator escalation card once a job has failed
//      SCHEDULED_JOB_ESCALATION_THRESHOLD times in a row, throttled to one
//      card per SCHEDULED_JOB_ESCALATION_THROTTLE_MS while the outage stays
//      open, marked `escalation_sent` in that row's evidence;
//   3. a recovery card on the first success after an escalation, marked
//      `recovery_sent`.
//
// Marker semantics are byte-identical to the HARD-FAILURE pair market-alerts-
// poll.mjs drives (lastEscalationAt/lastRecoveryAt over the evidence array),
// so one reader understands both.

import {
  consecutiveFailureCount,
  lastEscalationAt,
  lastRecoveryAt,
  recordJobRun
} from "./job-run-log.mjs";

/** run_log `job` values. Distinct from openclaw-cron-runner-state.mjs's
 * CRON_JOB_* names on purpose: those are jobs the cron runner dispatches over
 * HTTP, these are launchd daemons that run their own process. */
export const SCHEDULED_JOB_DAILY_BACKUP = "daily-backup";
export const SCHEDULED_JOB_OFFICIAL_PAPER_POLL = "official-paper-poll";
export const SCHEDULED_JOB_OFFICIAL_PAPER_PNL = "official-paper-pnl";

/** Same threshold/throttle as market-alerts-poll.mjs's hard-failure pair -
 * three strikes, then at most one card every 12h for as long as the outage
 * stays open. Deliberately the same numbers: an operator should not have to
 * remember two different escalation cadences. */
export const SCHEDULED_JOB_ESCALATION_THRESHOLD = 3;
export const SCHEDULED_JOB_ESCALATION_THROTTLE_MS = 12 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;

/**
 * The scheduled launchd jobs that write a heartbeat, and how long a gap
 * between heartbeats is still normal for each.
 *
 * `label` is the launchd label from install-launchd-ownership.txt - the two
 * lists are cross-checked by this module's test, so adding a scheduled daemon
 * there without a heartbeat here (or vice versa) fails the suite instead of
 * silently producing an unmonitored job.
 *
 * `staleAfterMs` is derived from each job's own StartCalendarInterval in
 * install-system-daemons.sh, with slack for a machine that was asleep:
 *   - daily-backup runs once a day at 05:30 -> 24h + 6h slack;
 *   - official-paper poll runs hourly at :30, but its body no-ops outside the
 *     US hourly-poll window (trading-schedule.mjs), and a no-op still writes a
 *     heartbeat row, so hourly + 2h slack is right;
 *   - official-paper pnl runs hourly at :00 under the same rule.
 */
export const SCHEDULED_LAUNCHD_JOBS = Object.freeze([
  Object.freeze({
    job: SCHEDULED_JOB_DAILY_BACKUP,
    label: "com.alphaloop.daily-backup",
    displayName: "每日备份",
    staleAfterMs: 30 * HOUR_MS
  }),
  Object.freeze({
    job: SCHEDULED_JOB_OFFICIAL_PAPER_POLL,
    label: "com.openclaw.trading.official-paper.poll",
    displayName: "官方模拟盘轮询",
    staleAfterMs: 3 * HOUR_MS
  }),
  Object.freeze({
    job: SCHEDULED_JOB_OFFICIAL_PAPER_PNL,
    label: "com.openclaw.trading.official-paper.pnl",
    displayName: "官方模拟盘盈亏播报",
    staleAfterMs: 3 * HOUR_MS
  })
]);

/**
 * Whether an escalation card is due now: the streak has crossed the
 * threshold AND either nothing has ever been escalated for this job, or the
 * last escalation is older than the throttle window, or a recovery has landed
 * since it (a NEW outage always escalates immediately, it does not inherit the
 * previous outage's throttle).
 */
export function isScheduledEscalationDue(now, consecutiveFailures, lastEscalation, lastRecovery) {
  if (consecutiveFailures < SCHEDULED_JOB_ESCALATION_THRESHOLD) {
    return false;
  }
  if (!lastEscalation) {
    return true;
  }
  const escalatedAtMs = Date.parse(lastEscalation);
  if (!Number.isFinite(escalatedAtMs)) {
    // An unparseable marker must not wedge the escalation shut forever.
    return true;
  }
  const recoveredAtMs = lastRecovery ? Date.parse(lastRecovery) : NaN;
  if (Number.isFinite(recoveredAtMs) && recoveredAtMs > escalatedAtMs) {
    return true;
  }
  return now.getTime() - escalatedAtMs >= SCHEDULED_JOB_ESCALATION_THROTTLE_MS;
}

/**
 * Whether a recovery card is due on THIS successful run: only when an
 * escalation was actually sent and no recovery has been sent since it. A job
 * that never escalated never announces a recovery.
 */
export function isScheduledRecoveryDue(lastEscalation, lastRecovery) {
  if (!lastEscalation) {
    return false;
  }
  const escalatedAtMs = Date.parse(lastEscalation);
  if (!Number.isFinite(escalatedAtMs)) {
    return false;
  }
  if (!lastRecovery) {
    return true;
  }
  const recoveredAtMs = Date.parse(lastRecovery);
  return !Number.isFinite(recoveredAtMs) || recoveredAtMs < escalatedAtMs;
}

/** Operator-facing escalation card copy. Pure, so the exact Chinese wording
 * is assertable without a transport. */
export function buildScheduledFailureCard({ displayName, label, consecutiveFailures, errorSummary }) {
  return {
    title: `⚠ 定时任务连续失败：${displayName}`,
    lines: [
      `launchd 任务 ${label} 已连续 ${consecutiveFailures} 次运行失败。`,
      `最近一次错误：${errorSummary || "未知错误"}`,
      "该任务的产出在修复前不会更新，请检查 launchd 日志与运行环境。",
      "修复后下一次成功运行会自动发送恢复通知，无需手动复位。"
    ]
  };
}

/** Operator-facing recovery card copy - the twin of the card above. */
export function buildScheduledRecoveryCard({ displayName, label }) {
  return {
    title: `✅ 定时任务已恢复：${displayName}`,
    lines: [
      `launchd 任务 ${label} 已重新成功运行，此前的连续失败告警可以关闭了。`
    ]
  };
}

/** Trims a thrown error down to one bounded, single-line summary. */
function describeError(error) {
  const text = error instanceof Error ? error.message : String(error ?? "");
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return collapsed.length > 400 ? `${collapsed.slice(0, 400)}…` : collapsed;
}

/**
 * Runs one invocation of a scheduled launchd job, writing exactly one run_log
 * heartbeat row for it and driving the consecutive-failure escalation.
 *
 * The body's own return value is passed straight back to the caller on
 * success; a throw is recorded as a failed run and then RETHROWN, so each
 * job's existing CLI error envelope/exit code is unchanged - this wrapper
 * only adds bookkeeping, it never swallows a failure.
 *
 * Bookkeeping failures (the run_log INSERT itself throwing, the card send
 * throwing) are logged to stderr and otherwise ignored: a job must never fail
 * BECAUSE its heartbeat could not be written.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   job: string,
 *   now?: () => Date,
 *   sendCard?: (card: {title: string, lines: string[]}) => Promise<{ok: boolean, error?: string}>,
 *   inputs?: unknown[]
 * }} options
 * @param {() => unknown | Promise<unknown>} body
 */
export async function runScheduledJobWithHeartbeat(db, options, body) {
  const { job, now = () => new Date(), sendCard = null, inputs = [] } = options ?? {};
  if (!job) {
    throw new Error("runScheduledJobWithHeartbeat: `job` is required.");
  }
  const definition = SCHEDULED_LAUNCHD_JOBS.find((entry) => entry.job === job);
  if (!definition) {
    throw new Error(
      `runScheduledJobWithHeartbeat: unknown scheduled job "${job}" `
        + `(expected one of ${SCHEDULED_LAUNCHD_JOBS.map((entry) => entry.job).join(", ")}).`
    );
  }

  const startedAt = now().toISOString();
  // Read BEFORE the body runs: this run's own row does not exist yet, so the
  // streak below is "how many failures preceded this invocation".
  const previousFailures = consecutiveFailureCount(db, job);

  let result;
  let failure = null;
  try {
    result = await body();
  } catch (error) {
    failure = error;
  }

  const finishedAtDate = now();
  const ok = failure === null;
  const neutral = ok
    && result !== null
    && typeof result === "object"
    && result.skipped === true;
  const consecutiveFailures = ok ? 0 : previousFailures + 1;
  const evidence = neutral
    ? [{ event: "scheduled_not_due", at: finishedAtDate.toISOString(), reason: String(result.reason ?? "not_due") }]
    : [];

  if (sendCard && !neutral) {
    // Marker lookups only matter when a card might actually be sent; skipping
    // them otherwise keeps the no-transport path (tests, ad-hoc CLI runs) to a
    // single INSERT.
    const escalatedAt = lastEscalationAt(db, job);
    const recoveredAt = lastRecoveryAt(db, job);
    if (!ok && isScheduledEscalationDue(finishedAtDate, consecutiveFailures, escalatedAt, recoveredAt)) {
      const sent = await trySendCard(
        sendCard,
        buildScheduledFailureCard({
          displayName: definition.displayName,
          label: definition.label,
          consecutiveFailures,
          errorSummary: describeError(failure)
        }),
        job
      );
      if (sent) {
        evidence.push({ event: "escalation_sent", at: finishedAtDate.toISOString() });
      }
    } else if (ok && isScheduledRecoveryDue(escalatedAt, recoveredAt)) {
      const sent = await trySendCard(
        sendCard,
        buildScheduledRecoveryCard({ displayName: definition.displayName, label: definition.label }),
        job
      );
      if (sent) {
        evidence.push({ event: "recovery_sent", at: finishedAtDate.toISOString() });
      }
    }
  }

  try {
    recordJobRun(db, {
      job,
      startedAt,
      finishedAt: finishedAtDate.toISOString(),
      ok,
      inputs,
      actions: [],
      failedStep: ok ? null : "run",
      evidence
    });
  } catch (bookkeepingError) {
    console.error(
      `scheduled-job-heartbeat: could not write the run_log heartbeat for "${job}": ${describeError(bookkeepingError)}`
    );
  }

  if (failure !== null) {
    throw failure;
  }
  return result;
}

async function trySendCard(sendCard, card, job) {
  try {
    const send = await sendCard(card);
    if (send && send.ok) {
      return true;
    }
    console.error(
      `scheduled-job-heartbeat: operator card for "${job}" was not delivered: ${send?.error ?? "unknown error"}`
    );
    return false;
  } catch (error) {
    console.error(`scheduled-job-heartbeat: sending the operator card for "${job}" threw: ${describeError(error)}`);
    return false;
  }
}
