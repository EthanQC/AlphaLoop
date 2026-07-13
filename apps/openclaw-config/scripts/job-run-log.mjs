// Store wrapper over the `run_log` table (task H1, Phase 2.5 hardening).
//
// The table itself was created by shared-types' migration index 2 (see
// database.ts's MIGRATIONS[2]: id/job/started_at/finished_at/ok/inputs/
// actions/failed_step/retries/call_count/evidence) but nothing wrote to it
// until this task. DDL is frozen for this task - no new columns - so the
// escalation/recovery bookkeeping this module's callers need (market-alerts-
// poll.mjs's failure-escalation state machine) is encoded entirely inside
// the existing `evidence` JSON column rather than a new column:
//
//   Whenever a card is actually sent, the run_log row for the run that
//   triggered the send carries one extra marker object in its `evidence`
//   array: `{ event: "escalation_sent", at: <ISO> }` on the FAILING row
//   that crossed the escalation threshold, or `{ event: "recovery_sent",
//   at: <ISO> }` on the SUCCEEDING row that ended the outage. Every other
//   row's evidence is just `[]` (or whatever else the caller passes).
//
//   lastEscalationAt/lastRecoveryAt scan run_log rows for `job` newest-first
//   (by rowid, which - since run_log's TEXT PRIMARY KEY does not opt out of
//   SQLite's implicit rowid via WITHOUT ROWID - tracks insertion order) and
//   return the `at` field off the first row whose evidence contains that
//   marker. Since each marker is only ever written once per send, the first
//   (newest) row found IS the most recent send - no need to scan every row
//   and compare timestamps.
//
// task H1 fix round (killing the "silently dead alerter" resurrection
// paths a review found): market-alerts-poll.mjs now also encodes a handful
// of OTHER marker events through this same evidence-array mechanism -
// `escalation_undeliverable` (an escalation was DUE but no card actually
// reached anyone - zero reachable recipients or every send failed, see that
// module's sendOperatorCard), `delivery_health_bad`/`delivery_escalation_
// sent`/`delivery_recovery_sent` (a SEPARATE state machine for "alerts fire
// but no card is ever delivered", tracked independently of the ok/fail
// column since a delivery-blind cycle still returns ok:true), and
// `delivery_counts` (the cycle's real evaluated/fires/sent/failed/skipped
// numbers, for operator visibility). `lastMarkerAt`/`consecutiveMarkerCount`
// below are generic over the marker's `event` string precisely so
// market-alerts-poll.mjs can reuse one throttle/recovery/streak
// implementation for both the original escalation_sent/recovery_sent pair
// and this newer delivery_escalation_sent/delivery_recovery_sent pair,
// instead of forking near-duplicate logic per marker type.
//
// This module is intentionally storage-only: it has no idea what a "card"
// or an "escalation" is, and never imports notifications.js. All of that
// policy (thresholds, throttle window, card copy, who to send to) lives in
// market-alerts-poll.mjs; this module only knows how to read/write rows.

import { createId } from "../../../packages/shared-types/dist/index.js";

/**
 * Insert one run_log row for a completed (or failed) job run.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   job: string,
 *   startedAt: string,
 *   finishedAt?: string | null,
 *   ok: boolean,
 *   inputs?: unknown[],
 *   actions?: unknown[],
 *   failedStep?: string | null,
 *   retries?: number,
 *   callCount?: number,
 *   evidence?: unknown[]
 * }} entry
 * @returns {{ id: string }}
 */
export function recordJobRun(db, entry) {
  const {
    job,
    startedAt,
    finishedAt = null,
    ok,
    inputs = [],
    actions = [],
    failedStep = null,
    retries = 0,
    callCount = 0,
    evidence = []
  } = entry ?? {};

  if (!job) {
    throw new Error("recordJobRun: `job` is required.");
  }
  if (!startedAt) {
    throw new Error("recordJobRun: `startedAt` is required.");
  }

  const id = createId("run_log");
  db.prepare(`
    INSERT INTO run_log
      (id, job, started_at, finished_at, ok, inputs, actions, failed_step, retries, call_count, evidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    String(job),
    String(startedAt),
    finishedAt ? String(finishedAt) : null,
    ok ? 1 : 0,
    JSON.stringify(inputs ?? []),
    JSON.stringify(actions ?? []),
    failedStep ? String(failedStep) : null,
    Math.max(0, Number(retries ?? 0)),
    Math.max(0, Number(callCount ?? 0)),
    JSON.stringify(evidence ?? [])
  );

  return { id };
}

/**
 * The most recent `limit` FAILED (ok=0) runs for `job`, newest first.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job
 * @param {number} [limit]
 */
export function recentFailures(db, job, limit = 10) {
  const rows = db
    .prepare(`SELECT * FROM run_log WHERE job = ? AND ok = 0 ORDER BY rowid DESC LIMIT ?`)
    .all(String(job), Math.max(1, Number(limit ?? 10)));
  return rows.map(mapRunLogRow);
}

/**
 * How many runs in a row (counting back from the LATEST run for `job`) have
 * failed. A success resets this to 0 - i.e. this is the length of the
 * unbroken run of ok=0 rows at the tail of `job`'s history, not a lifetime
 * failure count.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job
 * @returns {number}
 */
export function consecutiveFailureCount(db, job) {
  const rows = db.prepare(`SELECT ok FROM run_log WHERE job = ? ORDER BY rowid DESC`).all(String(job));
  let count = 0;
  for (const row of rows) {
    if (Number(row.ok) === 1) {
      break;
    }
    count += 1;
  }
  return count;
}

/**
 * ISO timestamp of the most recent "escalation_sent" evidence marker for
 * `job` across ALL of its run_log rows (ok or not) - see module header for
 * the encoding. `null` if no escalation card has ever been sent for `job`.
 */
export function lastEscalationAt(db, job) {
  return lastMarkerAt(db, job, "escalation_sent");
}

/**
 * ISO timestamp of the most recent "recovery_sent" evidence marker for
 * `job` - mirrors lastEscalationAt. `null` if no recovery card has ever
 * been sent for `job`.
 */
export function lastRecoveryAt(db, job) {
  return lastMarkerAt(db, job, "recovery_sent");
}

/**
 * ISO timestamp of the most recent evidence marker matching `event` for
 * `job`, generic over the event name - see module header. Exported (unlike
 * the original private helper this generalizes) so market-alerts-poll.mjs
 * can drive its OWN, independent escalation/recovery marker pairs (e.g.
 * "delivery_escalation_sent"/"delivery_recovery_sent" for the delivery-
 * health state machine, task H1 fix round) through the same lookup instead
 * of a forked copy per marker pair. `lastEscalationAt`/`lastRecoveryAt`
 * above are unchanged, kept as the two named convenience wrappers existing
 * callers/tests already use.
 */
export function lastMarkerAt(db, job, event) {
  const rows = db.prepare(`SELECT evidence FROM run_log WHERE job = ? ORDER BY rowid DESC`).all(String(job));
  for (const row of rows) {
    const markers = parseJsonArray(row.evidence);
    const hit = markers.find((marker) => marker && typeof marker === "object" && marker.event === event);
    if (hit && typeof hit.at === "string") {
      return hit.at;
    }
  }
  return null;
}

/**
 * How many of the MOST RECENT runs for `job` (newest first) carry a marker
 * `{ event: markerEvent, ... }` somewhere in their evidence array, counting
 * back until the first run whose evidence does NOT carry it - generalizes
 * consecutiveFailureCount (which counts by the `ok` column) to count by an
 * arbitrary evidence marker instead. Needed because a "delivery is
 * generating alerts but none are being delivered" cycle (task H1 fix
 * round's Fix 3) still returns ok:true from the poller - consecutiveFailure-
 * Count's ok=0 streak can't see it, so market-alerts-poll.mjs tracks its own
 * "delivery_health_bad" marker streak through this instead, with the same
 * break-on-first-miss semantics (a healthy cycle OR a hard failure resets
 * the streak to 0, since neither carries the marker).
 */
export function consecutiveMarkerCount(db, job, markerEvent) {
  const rows = db.prepare(`SELECT evidence FROM run_log WHERE job = ? ORDER BY rowid DESC`).all(String(job));
  let count = 0;
  for (const row of rows) {
    const markers = parseJsonArray(row.evidence);
    const hasMarker = markers.some((marker) => marker && typeof marker === "object" && marker.event === markerEvent);
    if (!hasMarker) {
      break;
    }
    count += 1;
  }
  return count;
}

function mapRunLogRow(row) {
  return {
    id: String(row.id),
    job: String(row.job),
    startedAt: String(row.started_at),
    finishedAt: row.finished_at != null ? String(row.finished_at) : null,
    ok: Number(row.ok) === 1,
    inputs: parseJsonArray(row.inputs),
    actions: parseJsonArray(row.actions),
    failedStep: row.failed_step != null ? String(row.failed_step) : null,
    retries: Number(row.retries ?? 0),
    callCount: Number(row.call_count ?? 0),
    evidence: parseJsonArray(row.evidence)
  };
}

function parseJsonArray(raw) {
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
