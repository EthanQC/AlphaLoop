#!/usr/bin/env node
// Poller for the alert system (task P2-6, the final task wiring T1-T5
// together). Meant to run under launchd every StartInterval seconds (see the
// sibling .plist.template - StartInterval MUST stay <= ~300s: the engine's
// spike_5m window (market-alerts-engine.mjs's SPIKE_WINDOW_MAX_MS) assumes a
// poll cadence of roughly this order, and a slower interval silently starves
// the spike history window, never firing spike alerts at all).
//
// Flow per cycle:
//   assertCalendarCoverage(now) -> isUsRegularMarketHours(now) false ->
//   {ok:true, skipped:"off-hours"} -> load enabled rules (none -> quick
//   exit) -> isolate per-rule config errors (see below) -> fetch quotes once
//   (shared across owners, market-wide data) -> for EACH owner: resolve
//   THEIR OWN latest official_paper_snapshots row (falling back to the
//   legacy shared owner_id=NULL row only when the owner has none of their
//   own - see loadLatestSnapshotForOwner), build that owner's sample, and
//   call evaluateAll for just that owner's rules -> merge fires/skips/
//   runtimes/quotas across owners -> (unless --dry-run) persist runtimes/
//   events/quota bumps for the WHOLE cycle atomically (store.persistCycle,
//   one BEGIN IMMEDIATE transaction) -> enrich fires with threshold+eventId
//   -> composeAlertCards per owner (each owner's own positions, since cards'
//   positions param is flat-by-symbol and would collide across owners once
//   per-owner snapshots exist) -> deliverAlertCards once for the merged
//   batches -> one-line JSON summary, exit 0. Any throw anywhere in this
//   path produces a one-line {ok:false, error} + exit 1 - launchd's own
//   StartInterval retry is the only retry mechanism; this script
//   deliberately has none of its own (see market-alerts-cards.mjs's
//   no-retry rationale, same principle).
//
// Per-owner snapshot resolution (spec-owner decision, task P2-6 fix round):
// positions/exposure used to come from ONE globally-latest snapshot row
// shared across every owner in the cycle. That's inert today (only
// owner_id=NULL rows exist - a single shared Longbridge paper account), but
// Phase 6 introduces per-member paper accounts - the moment a non-NULL
// owner_id row exists, owner A's rules would silently evaluate against
// owner B's snapshot (wrong costPrice for unrealized_pnl, wrong
// exposureRatio, wrong share count on A's card). Fixed by resolving the
// snapshot PER OWNER and calling evaluateAll once per owner (the engine
// itself still takes exactly one flat sample per call - see
// market-alerts-engine.mjs's documented shape - so "per owner" means one
// call per owner, not a change to the engine's contract).
//
// Atomic persistence (reviewer-flagged finding, task P2-6 fix round):
// saveRuntimes/recordEvents/bumpQuota used to be three separate implicit
// transactions - a crash or a throw between them left state permanently
// corrupted (e.g. saveRuntimes commits `lastFiredTradingDay`, then
// recordEvents throws: the once_daily rule is marked as already-fired today
// with no alert_events row and no card ever sent, silently losing that
// alert for the rest of the trading day; the reverse ordering under-counts
// the quota instead, causing over-alerting). Fixed by store.persistCycle,
// which wraps all three in one BEGIN IMMEDIATE transaction (mirroring
// deleteRule's existing precedent) - the poller stays orchestration-only,
// the transaction lives with the SQL. Card DELIVERY deliberately stays
// OUTSIDE this transaction (network IO; the existing "delivery failure
// leaves message_id NULL, no retry" behavior is preserved unchanged).
//
// Per-rule config-error isolation (reviewer-flagged in task P2-3's report,
// binding for this task): market-alerts-engine.mjs's evaluateAll throws for
// the WHOLE batch the instant it hits one rule whose `frequency` disagrees
// with its `rule_type` (a config bug, not a runtime condition) - there is no
// way to recover a partial result from a thrown evaluateAll call. So this
// poller filters those rows out BEFORE they ever reach evaluateAll, and
// reports them as skipped (`reason: "config_error"`) instead of letting one
// bad row silence every other owner's alerting for the whole cycle.
//
// Heartbeat / run_log / failure escalation (task H1, Phase 2.5 hardening):
// before this task, a persistently failing poller (expired Longbridge auth,
// a trading calendar that has run out of covered years, a locked db) just
// exited 1 every 5 minutes forever and wrote its own log file - nobody was
// ever notified, even though notifying people is this poller's entire
// purpose. Every REAL run (anything past the off-hours/--dry-run early
// exits below) now writes exactly one row to job-run-log.mjs's run_log
// wrapper, ok or not. `failedStep` is a best-effort label of which phase
// threw (see the stepSync/stepAsync helpers below) so an operator reading
// run_log can tell "calendar_coverage" (the calendar fix is stale) from
// "fetch_quotes" (Longbridge auth expired) from "persist" (db contention)
// at a glance, without reading a stack trace. On the 3rd+ consecutive
// failure, throttled to at most one card per 12h (see recordFailureRun),
// this poller sends every active member with a linked Feishu account an
// escalation card - an operator alert, not a per-rule alert, so it goes to
// everyone rather than being scoped to one rule's owner (a dead alerter
// affects every member's alerts, not just one). The first success after an
// escalation sends a matching recovery card. See job-run-log.mjs's module
// header for exactly how the escalation/recovery timestamps are encoded
// inside run_log's frozen schema (no new column).
//
// task H1 fix round (a review found three ways the FIRST version of this
// escalation machinery could itself go silently dead - defeating the
// entire point of this task):
//
//   Fix 1 - a failed/zero-recipient send used to still write the
//   "escalation_sent" marker (sendInteractiveCard never throws, it returns
//   {ok:false}), throttling the NEXT 12h of retries even though nobody was
//   actually told. sendOperatorCard now only reports delivered:true when at
//   least one card genuinely sent (member first, then a fallback to the
//   fixed channel openclaw-cron-runner.mjs's own failure alert resolves
//   independent of the members table); recordFailureRun/recordSuccessRun
//   only write "..._sent" on that, otherwise "..._undeliverable" (reason
//   "no_recipients" | "send_failed") so the attempt stays visible AND keeps
//   retrying every cycle (see sendEscalationCard).
//
//   Fix 2 - the 12h throttle used to ignore recoveries entirely: a
//   flapping failure -> escalate -> recover -> fail-again-inside-12h
//   sequence suppressed the new outage's escalation AND (since no new
//   escalation marker was written) then also suppressed ITS eventual
//   recovery card. isEscalationDue/isRecoveryDue now treat a recovery
//   strictly after the last escalation as ending that outage, so a NEW
//   outage's 3rd-consecutive-failure escalates immediately regardless of
//   the throttle window.
//
//   Fix 3 - deliverAlertCards deliberately swallows delivery failures (by
//   design, see that module - no retry, no storm), but a poller that only
//   ever records ok:true/false on the CYCLE never notices "fires happened,
//   zero were delivered" - the textbook silently-dead-alerter. recordSuccessRun
//   now records real {evaluated,fires,sent,failed,skipped} counters every
//   cycle and runs a SECOND, independent escalation/recovery state machine
//   (same threshold/throttle machinery, different evidence markers) keyed
//   on "3+ consecutive cycles with fires>0 && sent===0 && failed>0".
//
//   Fix 4 - any throw from the bookkeeping itself (writing run_log, sending
//   a card) used to mask the original poll error/turn a successful run into
//   a rejection. Every bookkeeping call in runMarketAlertsPoll is now
//   wrapped in its own try/catch that logs to stderr and never rethrows -
//   see the top-level try/catch below and logFailureWithFreshDb.
//
// task H1 second fix round (a review found the delivery-health detector
// Fix 3 above ADDED was itself INERT in production - defeating the entire
// point of this task a second time):
//
//   Fix 1 - the delivery-health streak (consecutiveMarkerCount) broke on the
//   very first row lacking the `delivery_health_bad` marker, including a
//   `fires === 0` row - which never attempted delivery at all and so never
//   carries the marker either way. Real alert fires are sparse (once_daily
//   rules, a daily quota), so an expired Feishu token produced "bad, empty,
//   bad, empty, bad, ..." forever and the streak never reached the
//   threshold. recordSuccessRun now treats delivery health as STICKY
//   (job-run-log.mjs's consecutiveStickyMarkerCount): a `fires === 0` cycle
//   is NEUTRAL (skipped, neither extends nor resets the streak); only a
//   cycle that actually delivered something (`sent > 0`) clears it.
//
//   Fix 2 - `fires > 0 && sent === 0 && failed === 0 && skipped > 0` (a fire
//   for a member with no feishuOpenId - today's actual production shape:
//   zero active members have one) used to count as HEALTHY, so the user
//   received nothing, forever, with no escalation ever raised. `sent === 0`
//   is now unhealthy regardless of whether the misses were `failed` or
//   `skipped`, with a distinct card text for each: a pure no-recipient
//   outage points at binding a Feishu account, not at Feishu auth.
//
//   Fix 3 - the first `fires === 0` cycle after a delivery escalation used
//   to take the recovery branch anyway (the old health check was just
//   `!deliveryUnhealthy`, true for an empty cycle too) and send a FALSE
//   "recovered" card with no card ever actually delivered - which also reset
//   the throttle, letting the machine loop escalate -> false-recover ->
//   escalate. The recovery card now fires ONLY on a cycle with `sent > 0`.
//
//   Fix 4 - a write-blocked db (this task's "db 锁" scenario) means
//   recordJobRun's INSERT throws on every cycle even though the db opened
//   fine - no row ever lands, so consecutiveFailureCount (a pure SELECT)
//   never advances and the 3-failure escalation threshold is never reached.
//   recordFailureRun/recordSuccessRun now also maintain a small file-based
//   fallback counter (runtime/market-alerts/poller-state.json, written on
//   EVERY run - see resolvePollerStatePath/readPollerState/writePollerState)
//   and take max(dbCount, fileCount) / the newer of the two escalation
//   timestamps, so an unwritable db no longer masks the outage.
//
//   Fix 5 (minor) - sendEscalationCard/sendRecoveryCard's own send attempt is
//   now wrapped in its own try/catch inside recordFailureRun/
//   recordSuccessRun so a throw from MemberRepository.listActive() can't
//   also cost the cycle its run_log heartbeat row; every run_log scan keyed
//   on this job (consecutiveFailureCount, lastMarkerAt,
//   consecutiveStickyMarkerCount) now takes a bounded LIMIT (default 200 -
//   see job-run-log.mjs's module header for why) instead of scanning the
//   job's entire history every cycle.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MemberRepository,
  loadLocalEnv,
  openTradingDatabase,
  resolveRuntimePaths,
  sendInteractiveCard
} from "../../../packages/shared-types/dist/index.js";
import { runLongbridgeJsonWithRetry } from "./_longbridge.mjs";
import {
  consecutiveFailureCount,
  consecutiveStickyMarkerCount,
  lastMarkerAt,
  recordJobRun
} from "./job-run-log.mjs";
import { buildPositionsForCards, composeAlertCards, deliverAlertCards } from "./market-alerts-cards.mjs";
import { EXPOSURE_SYMBOL, RULE_TYPE_FREQUENCY, evaluateAll } from "./market-alerts-engine.mjs";
import * as store from "./market-alerts-store.mjs";
import { sanitizeAlertText } from "./openclaw-cron-runner-alerts.mjs";
import { CRON_JOB_MARKET_ALERTS } from "./openclaw-cron-runner-state.mjs";
import { computeExposure } from "./portfolio-exposure.mjs";
import { toNumber } from "./report-data.mjs";
import { assertCalendarCoverage, currentUsEasternTradingDay, isUsRegularMarketHours } from "./trading-schedule.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
loadLocalEnv(repoRoot);

// 3 consecutive failures halts confidence in the poller entirely (mirrors
// openclaw-cron-runner-state.mjs's own HALT_THRESHOLD, though this poller
// has no halt/retry-suppression behavior of its own - launchd keeps
// retrying every StartInterval regardless; only the ALERT is gated).
const ESCALATION_THRESHOLD = 3;
// At most one escalation card per 12h so a persistently failing poller
// alerts once, not every 5 minutes forever (an alert storm is its own
// failure mode).
const ESCALATION_THROTTLE_MS = 12 * 60 * 60 * 1000;

/**
 * Run one poll cycle. Every side-effecting collaborator (db access path,
 * quote provider, card transport, wall clock) is an option so tests can
 * inject fakes/a real temp SQLite file without touching production state.
 *
 * @param {{
 *   now?: Date,
 *   dryRun?: boolean,
 *   dbPath?: string,
 *   quoteProvider?: (symbols: string[]) => Promise<Record<string, {price?: number, prevClose?: number, volume?: number}>>,
 *   transport?: import('../../../packages/shared-types/dist/index.js').CardTransport
 * }} [options]
 */
export async function runMarketAlertsPoll(options = {}) {
  const now = options.now ?? new Date();
  const dryRun = Boolean(options.dryRun);
  const quoteProvider = options.quoteProvider ?? defaultQuoteProvider;
  const dbPath = options.dbPath ?? resolveRuntimePaths(repoRoot).dbPath;
  const transport = options.transport;

  // isUsRegularMarketHours already calls assertCalendarCoverage internally;
  // this explicit call just documents the flow the task brief names
  // (calendar check, then market-hours check) and stays cheap/harmless even
  // if that internal detail ever changes.
  //
  // Deliberately still runs BEFORE opening any db handle (see below) - off
  // hours is the overwhelmingly common outcome of any given tick (most of
  // the day/week is outside US regular market hours), so opening SQLite on
  // every one of those ticks for nothing would be wasted IO/lock contention.
  // A calendar-coverage failure (the trading calendar has no data for
  // `now`'s year - trading-schedule.mjs) is the one exception: unlike a
  // plain off-hours tick this IS a real failure - one of this task's three
  // named motivating scenarios (expired Longbridge auth / calendar year
  // expiry / db lock, see module header) - so it still gets a run_log row
  // and an escalation check, just via its own separately-opened db (never
  // reusing the off-hours path, which touches no db at all).
  try {
    assertCalendarCoverage(now);
  } catch (error) {
    tagStep(error, "calendar_coverage");
    if (!dryRun) {
      await logFailureWithFreshDb(dbPath, { now, error, transport });
    }
    throw error;
  }

  if (!isUsRegularMarketHours(now)) {
    return { ok: true, skipped: "off-hours" };
  }

  let db;
  try {
    db = openTradingDatabase(dbPath);
  } catch (error) {
    // Can't open the primary db - e.g. task brief's "db lock" scenario. Best
    // effort: try to log the failure via a fresh connection to the SAME
    // path; if that also throws (the lock is real, not transient),
    // logFailureWithFreshDb swallows it rather than masking the original
    // error - the next launchd tick will retry both the poll and the log.
    if (!dryRun) {
      await logFailureWithFreshDb(dbPath, { now, error, transport });
    }
    throw error;
  }

  try {
    const result = await pollOnce(db, { now, dryRun, quoteProvider, transport });
    if (!dryRun) {
      // Fix 4 (reviewer-flagged, task H1 fix round): a REAL run that
      // succeeded must exit 0 with its summary even if the bookkeeping
      // (writing the run_log row / sending a recovery card) itself throws -
      // e.g. the exact "db lock" scenario this task exists for. Swallow and
      // log rather than let a bookkeeping throw replace a genuine success
      // with a rejection.
      try {
        await recordSuccessRun(db, { now, transport, result, dbPath });
      } catch (bookkeepingError) {
        console.error(
          `market-alerts-poll: recordSuccessRun bookkeeping failed (the poll cycle itself still succeeded): ${describeError(bookkeepingError)}`
        );
      }
    }
    return result;
  } catch (error) {
    if (!dryRun) {
      // Same principle as above, mirrored for the failure path: a
      // bookkeeping throw here must never mask the ORIGINAL error being
      // thrown below - an operator seeing "db lock" masked by a secondary
      // "cannot write run_log" exception is strictly worse than seeing the
      // real cause with a stderr note that bookkeeping also failed.
      try {
        await recordFailureRun(db, { now, error, transport, dbPath });
      } catch (bookkeepingError) {
        console.error(
          `market-alerts-poll: recordFailureRun bookkeeping failed (rethrowing the ORIGINAL error, not this one): ${describeError(bookkeepingError)}`
        );
      }
    }
    throw error;
  } finally {
    db.close();
  }
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Heartbeat / run_log / failure escalation (task H1)
// ---------------------------------------------------------------------------

// Tags an error with which phase of the poll threw, WITHOUT wrapping it in a
// new Error (that would risk changing `.message`, breaking callers/tests
// that match on it, e.g. the calendar-coverage rejection's /calendar/i
// match) - just annotates the same thrown object in place. Never overwrites
// an already-tagged step (defensive against double-tagging if a tagged
// error bubbles through a second tagStep/tagStepAsync call).
function tagStep(error, step) {
  if (error && typeof error === "object" && !("jobStep" in error)) {
    error.jobStep = step;
  }
  return error;
}

function stepSync(step, fn) {
  try {
    return fn();
  } catch (error) {
    throw tagStep(error, step);
  }
}

async function stepAsync(step, fn) {
  try {
    return await fn();
  } catch (error) {
    throw tagStep(error, step);
  }
}

async function logFailureWithFreshDb(dbPath, { now, error, transport }) {
  let db;
  try {
    db = openTradingDatabase(dbPath);
  } catch {
    // Genuinely can't open a db to log into - give up silently rather than
    // let a secondary failure mask the original one being thrown by the
    // caller.
    return;
  }
  try {
    await recordFailureRun(db, { now, error, transport, dbPath });
  } catch (bookkeepingError) {
    // Fix 4: never let a bookkeeping throw (e.g. the SAME db lock that
    // caused the original failure, now also blocking the write of the
    // failure row) propagate out of here - every caller of
    // logFailureWithFreshDb runs it, then unconditionally `throw error`s the
    // ORIGINAL failure next; this function itself must never throw instead.
    console.error(`market-alerts-poll: logFailureWithFreshDb bookkeeping failed: ${describeError(bookkeepingError)}`);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// File-based failure-counter fallback (Fix 4, task H1 second fix round)
// ---------------------------------------------------------------------------
//
// recordJobRun's own INSERT can throw even though the db opened fine and
// every SELECT against it still works - e.g. a concurrent long-running
// transaction holding a write lock (this task's "db 锁" scenario, distinct
// from openTradingDatabase failing to open at all, which
// logFailureWithFreshDb above already handles). When that happens, EVERY
// consecutive failing cycle throws before its own row ever lands -
// consecutiveFailureCount (a pure SELECT) then never sees a new row to
// extend its streak, so it stays wherever it already was and the
// 3-consecutive-failure escalation threshold is never crossed. Only stderr
// ever records the outage - exactly the silent failure this whole task
// exists to catch.
//
// Fixed by a small JSON state file - runtime/market-alerts/poller-state.json
// - mirroring openclaw-cron-runner.mjs's own processed-runs.json precedent
// (see that module and openclaw-cron-runner-state.mjs for the read/write
// pattern this borrows), written on EVERY real run regardless of whether the
// db write itself succeeds: {consecutiveFailures, lastEscalationAt,
// lastRecoveryAt}. When the db IS writable this file just mirrors it (no
// divergence, no change in observed behavior - every existing test above
// covers exactly that case); when it is not,
// recordFailureRun/recordSuccessRun below take max(dbCount, fileCount) for
// the failure count and the NEWER of the two escalation/recovery timestamps
// (newerIso) for the throttle, so a db that has been unwritable for the
// entire outage still escalates correctly and a db that recovers mid-outage
// doesn't lose track either. Scoped to the HARD-failure pair only (task
// brief's named scenario) - the delivery-health pair a few paragraphs down
// stays db-only.
function resolvePollerStatePath(dbPath) {
  return join(dirname(dbPath), "market-alerts", "poller-state.json");
}

function readPollerState(path) {
  try {
    if (!existsSync(path)) {
      return { consecutiveFailures: 0, lastEscalationAt: null, lastRecoveryAt: null };
    }
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return {
      consecutiveFailures: Math.max(0, Number(parsed?.consecutiveFailures ?? 0)),
      lastEscalationAt: typeof parsed?.lastEscalationAt === "string" ? parsed.lastEscalationAt : null,
      lastRecoveryAt: typeof parsed?.lastRecoveryAt === "string" ? parsed.lastRecoveryAt : null
    };
  } catch {
    // Corrupt/unreadable state file - never let a bad file crash the poller
    // or silently masquerade as "no history"; falling back to a fresh state
    // is the safe direction (worst case: one redundant escalation resend).
    return { consecutiveFailures: 0, lastEscalationAt: null, lastRecoveryAt: null };
  }
}

function writePollerState(path, state) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch (error) {
    // Best-effort: if even the FALLBACK file can't be written (disk full,
    // read-only runtime dir), degrade to db-only behavior for this cycle
    // rather than throwing out of bookkeeping - logged so a double-outage
    // stays visible on stderr instead of silently disappearing.
    console.error(`market-alerts-poll: failed to write poller-state.json: ${describeError(error)}`);
  }
}

// Whichever of the two ISO timestamps is newer; either side may be
// null/undefined ("no marker from that source yet").
function newerIso(a, b) {
  if (!a) {
    return b ?? null;
  }
  if (!b) {
    return a;
  }
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

// Records a failing run and, on the 3rd+ consecutive failure (throttled to
// one card per ESCALATION_THROTTLE_MS unless a recovery has since ended the
// prior outage - see escalationDueFrom below), sends the escalation card
// BEFORE writing the row so the resulting evidence marker lands on the exact
// row that triggered the send (see job-run-log.mjs's module header for the
// encoding).
//
// Fix 4: the consecutive-failure count and the escalation/recovery throttle
// timestamps are each resolved as the db-derived view MERGED with the
// file-based fallback's own view (see above) - so a db that has silently
// stopped accepting writes for this whole outage still crosses the
// threshold and still respects the throttle, exactly as if every write had
// succeeded.
async function recordFailureRun(db, { now, error, transport, dbPath }) {
  const startedAt = now.toISOString();
  const finishedAt = new Date().toISOString();
  const failedStep = (error && typeof error === "object" && error.jobStep) || "unknown";
  const errorSummary = sanitizeAlertText(error instanceof Error ? error.message : String(error), 500);

  const pollerStatePath = resolvePollerStatePath(dbPath);
  const fileState = readPollerState(pollerStatePath);

  const dbFailures = consecutiveFailureCount(db, CRON_JOB_MARKET_ALERTS);
  const consecutiveCount = Math.max(dbFailures, fileState.consecutiveFailures) + 1;

  const previousEscalation = newerIso(
    lastMarkerAt(db, CRON_JOB_MARKET_ALERTS, HARD_ESCALATION_EVENT),
    fileState.lastEscalationAt
  );
  const previousRecovery = newerIso(
    lastMarkerAt(db, CRON_JOB_MARKET_ALERTS, HARD_RECOVERY_EVENT),
    fileState.lastRecoveryAt
  );

  const evidence = [];
  let escalationSentAt = null;
  if (consecutiveCount >= ESCALATION_THRESHOLD && escalationDueFrom(now, previousEscalation, previousRecovery)) {
    // Fix 5: a throw from sendEscalationCard's own collaborators (e.g.
    // MemberRepository.listActive()) must not ALSO cost this cycle its
    // run_log heartbeat row below - caught locally rather than left to
    // propagate and skip recordJobRun entirely.
    try {
      const marker = await sendEscalationCard(db, transport, now, {
        title: "⚠ 提醒器连续失败",
        lines: [
          `已连续失败 ${consecutiveCount} 次。`,
          `最近一次错误：${errorSummary || "未知错误"}`,
          "提醒功能当前不可用，盘中价格/持仓/敞口告警暂时不会发送。",
          "请检查长桥登录状态、交易日历数据、数据库占用等常见原因；修复后下一次轮询成功会自动发送恢复通知，无需手动复位。"
        ]
      }, HARD_ESCALATION_EVENT);
      evidence.push(marker);
      if (marker.event === HARD_ESCALATION_EVENT) {
        escalationSentAt = marker.at;
      }
    } catch (sendError) {
      console.error(
        `market-alerts-poll: sending the hard-failure escalation card threw (the run_log heartbeat row will still be written): ${describeError(sendError)}`
      );
    }
  }

  // Fix 4: written BEFORE recordJobRun below, which may itself throw (the
  // exact scenario this fix exists for) - the file must stay the source of
  // truth for the NEXT cycle even when this cycle's own db row never lands.
  writePollerState(pollerStatePath, {
    consecutiveFailures: consecutiveCount,
    lastEscalationAt: escalationSentAt ?? fileState.lastEscalationAt,
    lastRecoveryAt: fileState.lastRecoveryAt
  });

  recordJobRun(db, {
    job: CRON_JOB_MARKET_ALERTS,
    startedAt,
    finishedAt,
    ok: false,
    actions: ["poll"],
    failedStep,
    evidence
  });
}

// Records a successful run - exactly one row, matching recordFailureRun's
// contract (see module header: one run_log row per real run, no exceptions
// for the row a recovery card happens to ride along on). Two INDEPENDENT
// escalation/recovery state machines share this one row's evidence array:
//
//   1. The hard-failure recovery: ends the OUTAGE that recordFailureRun's
//      escalation started, via HARD_ESCALATION_EVENT/HARD_RECOVERY_EVENT
//      markers, merged with the Fix 4 file-based fallback exactly as
//      recordFailureRun does.
//   2. The delivery-health escalation/recovery (task H1 second fix round's
//      Fix 1/2/3): this poll cycle's OWN evaluated/fires/sent/failed/skipped
//      counters - recorded into evidence unconditionally (`delivery_counts`,
//      for operator visibility) - can themselves indicate an outage (fires
//      generated, none delivered) even though the cycle as a whole returned
//      ok:true. Tracked via its own DELIVERY_ESCALATION_EVENT/
//      DELIVERY_RECOVERY_EVENT marker pair and its own STICKY
//      consecutive-attempt counter (job-run-log.mjs's
//      consecutiveStickyMarkerCount - see Fix 1 below for why the plain
//      streak-based consecutiveMarkerCount this used to call was unsound),
//      sharing the same ESCALATION_THRESHOLD/ESCALATION_THROTTLE_MS/
//      isEscalationDue-isRecoveryDue machinery as #1 (db-only - this pair
//      does NOT use the Fix 4 file fallback, which is scoped to hard
//      failures only per the task brief).
async function recordSuccessRun(db, { now, transport, result, dbPath }) {
  const startedAt = now.toISOString();
  const evidence = [];

  // --- Hard-failure recovery (Fix 4: merged with the file-based fallback) ---
  const pollerStatePath = resolvePollerStatePath(dbPath);
  const fileState = readPollerState(pollerStatePath);

  const previousEscalation = newerIso(
    lastMarkerAt(db, CRON_JOB_MARKET_ALERTS, HARD_ESCALATION_EVENT),
    fileState.lastEscalationAt
  );
  const previousRecovery = newerIso(
    lastMarkerAt(db, CRON_JOB_MARKET_ALERTS, HARD_RECOVERY_EVENT),
    fileState.lastRecoveryAt
  );

  let recoverySentAt = fileState.lastRecoveryAt;
  if (recoveryDueFrom(previousEscalation, previousRecovery)) {
    try {
      const marker = await sendRecoveryCard(db, transport, now, {
        title: "✅ 提醒器已恢复",
        lines: ["提醒器已恢复正常运行，盘中价格/持仓/敞口告警已重新生效。"]
      }, HARD_RECOVERY_EVENT);
      if (marker) {
        evidence.push(marker);
        recoverySentAt = marker.at;
      }
    } catch (sendError) {
      console.error(
        `market-alerts-poll: sending the hard-failure recovery card threw (the run_log heartbeat row will still be written): ${describeError(sendError)}`
      );
    }
  }

  // Fix 4: a success always resets the file's failure counter to 0,
  // mirroring consecutiveFailureCount's own db-side reset-on-success
  // semantics exactly.
  writePollerState(pollerStatePath, {
    consecutiveFailures: 0,
    lastEscalationAt: fileState.lastEscalationAt,
    lastRecoveryAt: recoverySentAt
  });

  // --- Delivery-health escalation/recovery (task H1 second fix round) ---
  //
  // Populate the run_log row's evidence with this cycle's REAL delivery
  // counters unconditionally - an operator (or a later doctor check) reading
  // run_log must be able to see "alerts fired but nothing was delivered" at
  // a glance, the same way failed_step already surfaces a hard failure's
  // phase at a glance.
  const evaluated = Number(result?.evaluated ?? 0);
  const fires = Number(result?.fires ?? 0);
  const sent = Number(result?.sent ?? 0);
  const failed = Number(result?.failed ?? 0);
  const skipped = Number(result?.skipped ?? 0);
  evidence.push({ event: "delivery_counts", evaluated, fires, sent, failed, skipped });

  // Fix 1: only a cycle that actually ATTEMPTED delivery (fires > 0) is
  // meaningful to this state machine at all - a fires===0 cycle is NEUTRAL,
  // not evidence of health OR of an outage, and must neither extend nor
  // break either streak. See job-run-log.mjs's consecutiveStickyMarkerCount
  // and its module-header rationale for why the plain streak-based
  // consecutiveMarkerCount this used to call was unsound here: real alert
  // fires are sparse (once_daily rules, a daily quota), so an expired
  // Feishu token used to produce "bad, empty, bad, empty, ..." forever and
  // never crossed the escalation threshold - poller says ok, user gets
  // nothing, nobody is told.
  const isDeliveryAttempt = fires > 0;
  // Fix 2: `sent === 0` is unhealthy regardless of WHY nothing was sent.
  // `skipped` (a fire for a member with no feishuOpenId on file - today's
  // actual production shape: zero active members have one) is exactly as
  // silent to the user as `failed` (a real send attempt that errored). Only
  // an ACTUAL send (sent > 0) counts as healthy, even if other owners in the
  // same cycle were skipped/failed (see the "partial success is not this
  // failure mode" note this replaces).
  const deliveredSuccessfully = sent > 0;
  const deliveryUnhealthy = isDeliveryAttempt && !deliveredSuccessfully;

  if (isDeliveryAttempt) {
    evidence.push({ event: "delivery_attempted", at: now.toISOString() });
  }

  if (deliveryUnhealthy) {
    // Fix 2: which of the two card texts to use depends on WHY nothing was
    // sent this cycle - a real `failed` send attempt (most likely a Feishu
    // auth problem) takes precedence over a pure `skipped` miss (no
    // reachable recipient at all, most likely a member with no bound Feishu
    // account) when a single cycle somehow has both, since an actual failed
    // send is the stronger of the two signals.
    const reason = failed > 0 ? "send_failed" : "no_recipients";
    evidence.push({ event: "delivery_health_bad", at: now.toISOString(), reason });

    const priorDeliveryFailures = consecutiveStickyMarkerCount(
      db,
      CRON_JOB_MARKET_ALERTS,
      "delivery_health_bad",
      "delivery_attempted"
    );
    const deliveryConsecutiveCount = priorDeliveryFailures + 1;

    if (
      deliveryConsecutiveCount >= ESCALATION_THRESHOLD &&
      isEscalationDue(db, now, DELIVERY_ESCALATION_EVENT, DELIVERY_RECOVERY_EVENT)
    ) {
      const card =
        reason === "no_recipients"
          ? {
              title: "⚠ 提醒无法送达：无可达收件人",
              lines: [
                `已连续 ${deliveryConsecutiveCount} 次轮询生成了提醒但一条都未能送达。`,
                "提醒规则本身评估正常、条件也确实触发了，但触发规则的会员都没有绑定飞书账号，卡片无处可发。",
                "请为相关会员绑定飞书账号（feishuOpenId）；绑定后下一次投递成功会自动发送恢复通知。"
              ]
            }
          : {
              title: "⚠ 提醒卡片投递持续失败",
              lines: [
                `已连续 ${deliveryConsecutiveCount} 次轮询生成了提醒但一条都未能送达。`,
                "提醒规则本身评估正常、条件也确实触发了，但卡片始终无法发出 - 用户实际上什么提醒都收不到。",
                "最可能的原因是飞书应用鉴权过期或 user-plugin 进程异常，请检查；修复后下一次投递成功会自动发送恢复通知。"
              ]
            };
      try {
        evidence.push(await sendEscalationCard(db, transport, now, card, DELIVERY_ESCALATION_EVENT));
      } catch (sendError) {
        console.error(
          `market-alerts-poll: sending the delivery-health escalation card threw (the run_log heartbeat row will still be written): ${describeError(sendError)}`
        );
      }
    }
  } else if (deliveredSuccessfully && isRecoveryDue(db, DELIVERY_ESCALATION_EVENT, DELIVERY_RECOVERY_EVENT)) {
    // Fix 3: recovery fires ONLY on a cycle that actually delivered
    // something (sent > 0) - an empty (fires === 0) cycle right after an
    // escalation is neutral (Fix 1), not evidence of recovery, and must not
    // send a false "recovered" card (which would also reset the throttle
    // and let the machine loop escalate -> false-recover -> escalate).
    try {
      const marker = await sendRecoveryCard(db, transport, now, {
        title: "✅ 提醒卡片投递已恢复",
        lines: ["提醒卡片投递已恢复正常，此前生成的提醒现在可以正常送达。"]
      }, DELIVERY_RECOVERY_EVENT);
      if (marker) {
        evidence.push(marker);
      }
    } catch (sendError) {
      console.error(
        `market-alerts-poll: sending the delivery-health recovery card threw (the run_log heartbeat row will still be written): ${describeError(sendError)}`
      );
    }
  }

  recordJobRun(db, {
    job: CRON_JOB_MARKET_ALERTS,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: true,
    actions: ["poll"],
    evidence
  });
}

// ---------------------------------------------------------------------------
// Escalation/recovery state machine (shared by the hard-failure pair from
// Fix 1/2 and the delivery-health pair from Fix 3 - see recordSuccessRun's
// doc comment)
// ---------------------------------------------------------------------------

const HARD_ESCALATION_EVENT = "escalation_sent";
const HARD_RECOVERY_EVENT = "recovery_sent";
const DELIVERY_ESCALATION_EVENT = "delivery_escalation_sent";
const DELIVERY_RECOVERY_EVENT = "delivery_recovery_sent";

// Fix 2 (task H1 fix round): a recovery ENDS the outage its matching
// escalation was about. Once `recoveryEvent` has fired more recently than
// `escalationEvent`, the 12h throttle window from that stale escalation must
// not suppress a BRAND NEW outage's own 3rd-consecutive-failure escalation -
// so this returns true (escalation is due) whenever there has never been an
// escalation, OR the most recent escalation was already ended by a later
// recovery, OR the throttle window since the still-open escalation has
// elapsed (>=, not >: Fix 5's exact-boundary case resends right at the 12h
// mark, not only after it).
//
// escalationDueFrom/recoveryDueFrom (task H1 second fix round) are the pure
// core of isEscalationDue/isRecoveryDue below, taking already-resolved
// timestamps directly instead of reading them from the db themselves. Pulled
// out so recordFailureRun/recordSuccessRun's HARD-failure pair can feed it
// the Fix 4 file-fallback-MERGED timestamps (see newerIso above), while
// isEscalationDue/isRecoveryDue stay the plain db-only lookup the
// delivery-health pair still uses unchanged.
function escalationDueFrom(now, previousEscalationIso, previousRecoveryIso) {
  if (!previousEscalationIso) {
    return true;
  }
  const outageAlreadyEnded =
    previousRecoveryIso && Date.parse(previousRecoveryIso) > Date.parse(previousEscalationIso);
  if (outageAlreadyEnded) {
    return true;
  }
  const elapsedMs = now.getTime() - Date.parse(previousEscalationIso);
  return elapsedMs >= ESCALATION_THROTTLE_MS;
}

// A recovery is due exactly when an escalation was sent and no recovery has
// been sent for it YET (recoveryEvent older than - or entirely absent
// versus - escalationEvent). The common "no outage to recover from" path
// (no escalation on record at all) returns false without ever touching
// sendOperatorCard.
function recoveryDueFrom(previousEscalationIso, previousRecoveryIso) {
  if (!previousEscalationIso) {
    return false;
  }
  const alreadyRecovered =
    previousRecoveryIso && Date.parse(previousRecoveryIso) >= Date.parse(previousEscalationIso);
  return !alreadyRecovered;
}

function isEscalationDue(db, now, escalationEvent, recoveryEvent) {
  return escalationDueFrom(
    now,
    lastMarkerAt(db, CRON_JOB_MARKET_ALERTS, escalationEvent),
    lastMarkerAt(db, CRON_JOB_MARKET_ALERTS, recoveryEvent)
  );
}

function isRecoveryDue(db, escalationEvent, recoveryEvent) {
  return recoveryDueFrom(
    lastMarkerAt(db, CRON_JOB_MARKET_ALERTS, escalationEvent),
    lastMarkerAt(db, CRON_JOB_MARKET_ALERTS, recoveryEvent)
  );
}

// Sends an escalation card and returns the evidence marker to push for it -
// Fix 1: `escalation_sent` (or its delivery-health twin) is ONLY recorded
// when sendOperatorCard actually reached someone; otherwise an
// `..._undeliverable` marker is recorded instead so the outage keeps
// retrying next cycle (isEscalationDue only ever suppresses on a genuine
// `_sent` marker) while still being visible to an operator/doctor check.
async function sendEscalationCard(db, transport, now, card, escalationEvent) {
  const send = await sendOperatorCard(db, transport, card);
  if (send.delivered) {
    return { event: escalationEvent, at: now.toISOString() };
  }
  return { event: `${escalationEvent.replace(/_sent$/u, "")}_undeliverable`, reason: send.reason, at: now.toISOString() };
}

// Mirrors sendEscalationCard for the recovery side. A recovery that fails to
// deliver is logged (inside sendOperatorCard) but intentionally does NOT
// record an "undeliverable" marker of its own: isRecoveryDue would keep
// retrying it every cycle regardless (no marker means "not yet recovered"),
// and the outage is already over by definition once we reach here - there
// is no throttle/urgency concern symmetric to the escalation side.
async function sendRecoveryCard(db, transport, now, card, recoveryEvent) {
  const send = await sendOperatorCard(db, transport, card);
  return send.delivered ? { event: recoveryEvent, at: now.toISOString() } : null;
}

// Operator alerts (escalation/recovery) are not scoped to one rule's owner -
// a dead alerter silences every member's alerts, not just one - so they go
// to every active member with a linked Feishu account, per the task brief's
// recommendation. Delivery failures are logged and otherwise swallowed,
// mirroring market-alerts-cards.mjs's deliverAlertCards: no retry here
// either, the next poll cycle is the natural retry point.
//
// Fix 1: production currently has ZERO active members with a feishuOpenId,
// and even when members exist, a send can fail (expired Feishu token,
// network blip). Neither case may be silently treated as "delivered" - both
// fall through to a FALLBACK send to the fixed channel
// openclaw-cron-runner.mjs's own failure-alert path resolves independent of
// the members table (see notifications.ts's defaultCardTransport:
// sendInteractiveCard with neither chatId nor openId set falls back to
// resolveFeishuUserPluginBotChatId(), the exact same bot chat id
// deliverReportToFeishu ultimately posts cron failure/halt alerts to - so
// passing an EMPTY target here reuses that same resolution rather than
// re-implementing it). Only if that also fails/there is nothing to fall
// back to do we report `delivered: false`.
async function sendOperatorCard(db, transport, card) {
  const reachableMembers = new MemberRepository(db).listActive().filter((member) => member.feishuOpenId);
  let anyDelivered = false;
  // Fix 5 (task H1 second fix round): this loop deliberately keeps going
  // through every reachable member even after one send succeeds, and never
  // retries a member whose own send failed - one successful send out of N is
  // enough to mark the whole escalation "delivered" (see the `anyDelivered`
  // check below). That is intentional for an OPERATOR alert: the point is
  // that at least one human sees it, not that every recipient's copy is
  // guaranteed, and a stuck member's send failing repeatedly must never by
  // itself keep the alert stuck at "undeliverable" while everyone else got
  // it fine.
  for (const member of reachableMembers) {
    const result = await sendInteractiveCard(card, { openId: member.feishuOpenId }, transport);
    if (result.ok) {
      anyDelivered = true;
    } else {
      console.error(
        `market-alerts-poll: operator card delivery failed for member ${member.id}: ${result.error ?? "unknown error"}`
      );
    }
  }

  if (anyDelivered) {
    return { delivered: true };
  }

  const reason = reachableMembers.length === 0 ? "no_recipients" : "send_failed";
  const fallback = await sendInteractiveCard(card, {}, transport);
  if (fallback.ok) {
    return { delivered: true };
  }

  console.error(
    `market-alerts-poll: operator card fallback delivery also failed (${reason}): ${fallback.error ?? "unknown error"}`
  );
  return { delivered: false, reason };
}

async function pollOnce(db, { now, dryRun, quoteProvider, transport }) {
  const rules = stepSync("load_rules", () => store.listEnabledRules(db));
  if (rules.length === 0) {
    return {
      ok: true,
      dryRun,
      evaluated: 0,
      fires: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      skippedRules: [],
      quotaBlocked: 0
    };
  }

  const { validRules, skippedRules } = partitionConfigErrors(rules);

  const tradingDay = currentUsEasternTradingDay(now);
  const atIso = now.toISOString();
  const symbols = Array.from(
    new Set(validRules.map((rule) => rule.symbol).filter((symbol) => symbol !== EXPOSURE_SYMBOL))
  );
  // Quotes are market-wide, not owner-scoped, so fetched exactly once per
  // cycle and shared across every owner's evaluation below.
  const quotes = await stepAsync("fetch_quotes", () => quoteProvider(symbols));

  const ownerIds = Array.from(new Set(validRules.map((rule) => rule.ownerId)));
  const rulesByOwner = new Map();
  for (const rule of validRules) {
    const list = rulesByOwner.get(rule.ownerId) ?? [];
    list.push(rule);
    rulesByOwner.set(rule.ownerId, list);
  }

  // Fetched once for every valid rule regardless of owner (a plain SELECT
  // keyed by rule_id - evaluateAll only reads the entries for the rules it's
  // actually given, so handing it the full map per owner call below is safe
  // and avoids re-querying per owner).
  const runtimes = store.getRuntimes(db, validRules.map((rule) => rule.id));
  const quotaByOwner = {};
  for (const ownerId of ownerIds) {
    quotaByOwner[ownerId] = store.getQuota(db, ownerId, tradingDay);
  }

  // Evaluate one owner at a time so each owner's positions/exposure come
  // from THEIR OWN latest snapshot (see loadLatestSnapshotForOwner) instead
  // of one row shared by the whole batch - see the module header's Fix 2
  // rationale. ruleIds are globally unique, so merging fires/skips/
  // newRuntimes across owners is a plain concatenation/assign; each
  // per-owner evaluateAll call only ever touches that one owner's quota key.
  const fires = [];
  const skips = [];
  const newRuntimes = {};
  const newQuotas = {};
  const samplesByOwner = {};

  for (const ownerId of ownerIds) {
    const ownerRules = rulesByOwner.get(ownerId) ?? [];
    const snapshotRow = stepSync("load_snapshot", () => store.loadLatestSnapshotForOwner(db, ownerId));
    const exposureResult = computeExposure({
      netAssets: snapshotRow ? toNumber(snapshotRow.net_assets) ?? null : null,
      marketValue: snapshotRow ? toNumber(snapshotRow.market_value) ?? 0 : 0,
      positions: snapshotRow ? parseSnapshotPositions(snapshotRow.positions) : []
    });

    const ownerSample = {
      atIso,
      tradingDay,
      quotes,
      positions: buildEnginePositions(snapshotRow, quotes),
      exposure: { exposureRatio: exposureResult.exposureRatio, overBudget: exposureResult.overBudget }
    };
    samplesByOwner[ownerId] = ownerSample;

    const ownerEvaluation = stepSync("evaluate", () =>
      evaluateAll(ownerRules, runtimes, ownerSample, { [ownerId]: quotaByOwner[ownerId] ?? 0 })
    );

    fires.push(...ownerEvaluation.fires);
    skips.push(...ownerEvaluation.skips);
    Object.assign(newRuntimes, ownerEvaluation.newRuntimes);
    newQuotas[ownerId] = ownerEvaluation.newQuotas[ownerId] ?? quotaByOwner[ownerId] ?? 0;
  }

  const quotaBlocked = skips.filter((skip) => skip.reason === "quota").length;

  if (dryRun) {
    // Contract: --dry-run evaluates but performs NO db writes and NO
    // delivery at all - not persistCycle, not composeAlertCards/
    // deliverAlertCards. Return before any of those.
    return {
      ok: true,
      dryRun: true,
      evaluated: validRules.length,
      fires: fires.length,
      wouldFire: fires.map((fire) => ({
        ruleId: fire.ruleId,
        ownerId: fire.ownerId,
        symbol: fire.symbol,
        ruleType: fire.ruleType,
        value: fire.value,
        triggeredAt: fire.triggeredAt
      })),
      skippedRules,
      quotaBlocked
    };
  }

  // Fix 1: saveRuntimes/recordEvents/bumpQuota persist as ONE atomic unit
  // (store.persistCycle, one BEGIN IMMEDIATE transaction) instead of three
  // separate implicit transactions - see the module header. `createdEvents`
  // preserves `fires`' order, which the eventId zip below depends on.
  const events = fires.map((fire) => ({
    ruleId: fire.ruleId,
    ownerId: fire.ownerId,
    value: fire.value,
    triggeredAt: fire.triggeredAt
  }));
  // newQuotas is the running per-owner fired_count already reflecting this
  // batch (see evaluateAll's doc comment) - bump only the delta actually
  // applied this cycle, per owner, so a repeated poll never double-counts
  // (persistCycle itself also ignores non-positive deltas defensively).
  const quotaBumps = ownerIds.map((ownerId) => ({
    ownerId,
    tradingDay,
    delta: (newQuotas[ownerId] ?? 0) - (quotaByOwner[ownerId] ?? 0)
  }));

  const createdEvents = stepSync("persist", () => store.persistCycle(db, { runtimes: newRuntimes, events, quotaBumps }));

  const ruleById = new Map(validRules.map((rule) => [rule.id, rule]));
  const enrichedFires = fires.map((fire, index) => ({
    ...fire,
    threshold: ruleById.get(fire.ruleId)?.threshold,
    eventId: createdEvents[index]?.id
  }));

  // MemberRepository (P1) is the source of feishuOpenId, not
  // market-alerts-store's own getMemberById (which only returns {id,
  // status} for the CLI's actor-validation use case). listActive() is used
  // rather than a per-id lookup (MemberRepository has none) - a rule owner
  // who has since gone inactive simply has no entry here and is reported by
  // composeAlertCards as a no_open_id skip rather than crashing.
  const memberById = stepSync("load_members", () =>
    Object.fromEntries(new MemberRepository(db).listActive().map((member) => [member.id, member]))
  );

  // Fix 2 (cont'd): compose cards per owner too, not once for every owner's
  // fires together - composeAlertCards' `positions` parameter is flat by
  // symbol with no per-owner nesting (see that module's header), so a
  // single merged positions map would collide the moment two owners hold
  // the same symbol in different quantities/at different cost prices
  // (post-Phase-6). Calling it once per owner with that owner's own
  // ownerSample-derived positions keeps every owner's card correct without
  // changing market-alerts-cards.mjs's contract at all.
  const batches = [];
  const skippedDelivery = [];
  for (const ownerId of ownerIds) {
    const ownerFires = enrichedFires.filter((fire) => fire.ownerId === ownerId);
    if (ownerFires.length === 0) {
      continue;
    }
    const composed = stepSync("compose_cards", () =>
      composeAlertCards(ownerFires, memberById, buildPositionsForCards(samplesByOwner[ownerId]))
    );
    batches.push(...composed.batches);
    skippedDelivery.push(...composed.skipped);
  }

  const delivery = await stepAsync("deliver_cards", () => deliverAlertCards(db, { batches, skipped: skippedDelivery }, transport));

  return {
    ok: true,
    dryRun: false,
    evaluated: validRules.length,
    fires: fires.length,
    sent: delivery.sent,
    failed: delivery.failed,
    skipped: delivery.skipped,
    skippedRules,
    quotaBlocked
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function partitionConfigErrors(rules) {
  const validRules = [];
  const skippedRules = [];
  for (const rule of rules) {
    const expected = RULE_TYPE_FREQUENCY[rule.ruleType];
    if (expected && rule.frequency !== expected) {
      skippedRules.push({ ruleId: rule.id, reason: "config_error" });
      continue;
    }
    validRules.push(rule);
  }
  return { validRules, skippedRules };
}

// I2 fix (whole-branch-review finding, task P2-6 fix round): this used to be
// a private copy of "resolve the latest snapshot for ONE owner, preferring
// that owner's OWN row over the legacy shared owner_id=NULL row whenever one
// exists - regardless of which is more recent." market-alerts-store.mjs's
// isSymbolInPositions had its OWN, DIFFERENT precedence ("OR owner_id IS
// NULL ORDER BY fetched_at DESC LIMIT 1" - newest across both sets wins),
// which agreed with this one only by coincidence (every row today has
// owner_id NULL) and would silently diverge the moment Phase 6 adds
// per-member accounts. store.loadLatestSnapshotForOwner is now the ONE
// shared implementation both this poller and the store's CLI-facing
// validation use - see that function's doc comment for the full precedence
// rationale, and market-alerts-poll.test.ts's "(a)"/"(c)" regression tests
// and market-alerts-store.test.ts's loadLatestSnapshotForOwner tests.
function parseSnapshotPositions(raw) {
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Builds evaluateAll's sample.positions ({ [symbol]: { quantity, costPrice,
// marketValue } }) from the snapshot's stored positions (already normalized
// to camelCase by report-data.mjs's normalizeOfficialPosition at save time -
// see official-paper-monitor.mjs's saveSnapshot). marketValue is a
// best-effort estimate (this cycle's quote price times quantity, falling
// back to cost basis) - nothing downstream actually reads it today (the
// engine only reads costPrice; buildPositionsForCards only reads quantity),
// but it's included to match the documented sample shape.
function buildEnginePositions(snapshotRow, quotes) {
  const positions = {};
  for (const row of parseSnapshotPositions(snapshotRow?.positions)) {
    const symbol = String(row?.symbol ?? "").toUpperCase();
    if (!symbol) {
      continue;
    }
    const quantity = toNumber(row.quantity);
    const costPrice = toNumber(row.costPrice ?? row.cost_price);
    const price = quotes[symbol]?.price ?? costPrice;
    positions[symbol] = {
      quantity,
      costPrice,
      marketValue: Number.isFinite(quantity) && Number.isFinite(price) ? quantity * price : undefined
    };
  }
  return positions;
}

// Default quote provider: mirrors longbridge-quote.mjs's existing pattern
// (runLongbridgeJsonWithRetry("quote", ["quote", ...symbols])) and the same
// field-fallback chain stock-analysis.mjs's buildDeterministicAnalysis
// already uses (last/last_done/lastDone, prev_close/prevClose,
// volume/turnover_volume). POINT OF IGNITION: this exact path is never
// exercised by any test in market-alerts-poll.test.ts (every test injects a
// fake quoteProvider) and must be manually verified against the real
// Longbridge CLI (`pnpm alerts:poll -- --dry-run` during market hours)
// before this poller is trusted to run unattended.
async function defaultQuoteProvider(symbols) {
  if (!symbols || symbols.length === 0) {
    return {};
  }

  const payload = await runLongbridgeJsonWithRetry("quote", ["quote", ...symbols], {
    label: "Longbridge 提醒轮询行情"
  });
  // Mirrors report-data.mjs's normalizeQuotePayload fallback chain: the CLI
  // can return a bare single object (not wrapped in an array) - most likely
  // for a single-symbol request - in addition to an array or {quotes:[...]}.
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.quotes)
      ? payload.quotes
      : payload && typeof payload === "object"
        ? [payload]
        : [];

  const quotes = {};
  for (const row of rows) {
    const symbol = String(row?.symbol ?? "").toUpperCase();
    if (!symbol) {
      continue;
    }
    quotes[symbol] = {
      price: toNumber(row.last ?? row.last_done ?? row.lastDone),
      prevClose: toNumber(row.prev_close ?? row.prevClose),
      volume: toNumber(row.volume ?? row.turnover_volume)
    };
  }
  return quotes;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");

  try {
    const result = await runMarketAlertsPoll({ dryRun });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}

const isMainModule = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  await main();
}
