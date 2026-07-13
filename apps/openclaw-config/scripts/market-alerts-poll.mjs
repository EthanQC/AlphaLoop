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
//
// task H1 THIRD fix round (this task - a review of the SECOND round found
// its own Fix 5 optimization above re-broke Fix 1 above it, plus two more
// silent-death paths in the escalation machinery itself):
//
//   Fix 1 - Fix 5's bounded LIMIT (200 rows) re-broke Fix 1's own sticky
//   counter for the DELIVERY pair specifically: real alert fires are sparse
//   by design (once_daily rule frequency, a 30/day quota), and at this
//   poller's StartInterval-300s cadence, 200 rows is barely 2.5 TRADING days
//   (78 rows/trading day during the 6.5h US regular session) - three bad
//   delivery attempts spaced only slightly more than a trading day apart can
//   already span more than 200 rows and silently age the earliest one(s) out
//   of the window, pinning the sticky count at 1-2 forever. The DELIVERY-pair
//   scans (consecutiveStickyMarkerCount, and the lastMarkerAt lookups
//   isEscalationDue/isRecoveryDue make for delivery escalation/recovery
//   markers) are now bounded by WALL-CLOCK TIME instead (job-run-log.mjs's
//   consecutiveStickyMarkerCountSince/lastMarkerAtSince: `started_at >= now -
//   30 days`, with only a runaway-guard LIMIT of 5000 that cannot bite inside
//   that window). The HARD-FAILURE pair keeps its existing 200-row bound
//   UNCHANGED - a review verified that property actually holds for it (an
//   open hard-failure outage re-escalates every 12h BY DEFINITION, so its own
//   most recent escalation marker is always <12h old, comfortably inside 200
//   rows of a failing-every-5-minutes job's own history - see
//   job-run-log.mjs's module header for the full derivation). Do not
//   "optimize" the HARD-FAILURE pair's scans onto the same time bound - it
//   doesn't need it, and it would just be unnecessary code churn against a
//   property that's already been separately verified.
//
//   Fix 2 - logFailureWithFreshDb used to be `try { db = openTradingDatabase
//   (dbPath); } catch { return; }` - if the db can't even be OPENED (corrupt
//   sqlite file, a read-only runtime dir, disk full, a failing migration -
//   one of this task's three named motivating scenarios), the round-3 file
//   counter lives INSIDE recordFailureRun, unreachable from this path, so the
//   poller threw the SAME open error every cycle forever with nothing but a
//   stderr line - 100% silent, defeating the entire point of this task a
//   THIRD time. escalateWithoutDb now does the whole escalation without a db
//   handle at all: it reads/bumps the SAME poller-state.json file Fix 4 (task
//   H1 second fix round) already introduced (pure fs, no db needed) and, on
//   the 3rd+ consecutive failure (honoring the identical 12h throttle), sends
//   the escalation card straight to the `{}` fallback target - which also
//   needs no db (see sendInteractiveCard/notifications.ts's
//   defaultCardTransport: an empty target resolves via
//   resolveFeishuUserPluginBotChatId(), independent of the members table).
//
//   Fix 3 - for `reason === "send_failed"` the delivery escalation card says
//   the likely cause is Feishu auth expiry - but the member send AND the `{}`
//   fallback both go through the same Feishu channel, so the escalation card
//   itself fails to send too. The outage is by construction unreportable
//   through Feishu - only a marker in run_log that nothing external reads.
//   Fixed by a LOUD out-of-band artifact, runtime/market-alerts/
//   ALERTER-DOWN.json (`{since, consecutiveFailures, lastError, reason,
//   lastAttemptAt}`), written/refreshed by markAlerterDown on every cycle an
//   escalation of ANY kind (hard-failure, delivery-health, OR Fix 2's
//   db-open-failure path above) ends up undeliverable, and deleted by
//   clearAlerterDown the moment ANY card - an escalation retry that finally
//   gets through, or a recovery - actually delivers. A later doctor/ops check
//   can poll for this file's mere existence with zero db access (see
//   resolveAlerterDownPath/markAlerterDown/clearAlerterDown below). Also:
//   while the artifact exists, runMarketAlertsPoll's result carries
//   `alerterDown: true` even on an otherwise-"ok" cycle, and main() turns
//   that into a non-zero process.exitCode - so launchd/ops tooling watching
//   this poller's own exit status sees the outage too, not just a doctor
//   check that happens to look at the artifact file.
//
//   Fix 4 - writePollerState (and now markAlerterDown) used to be a plain
//   writeFileSync with no tmp+rename - a crash mid-write corrupts the JSON,
//   and readPollerState's own catch-all silently maps a corrupt file to
//   `{consecutiveFailures: 0}`, resetting the streak in exactly the scenario
//   the file exists to survive (a db unwritable for the WHOLE outage).
//   writeJsonAtomic now writes to a sibling `.tmp` path and renameSync's it
//   over the real path - mirrors backup-trading-data.mjs's
//   backupTradingDatabase, which uses the identical tmp+rename pattern for
//   the same atomicity guarantee. Applies to both poller-state.json and
//   ALERTER-DOWN.json.
//
// task H1 FOURTH fix round (this task - a final review of the THIRD round
// found two more ways the counters/artifact could go silently dead, plus
// three smaller gaps in the same machinery):
//
//   Fix A - a full disk or a read-only runtime dir fails BOTH failure
//   counters AT ONCE: the db INSERT throws (recordJobRun/recordFailureRun),
//   AND writeJsonAtomic's write of poller-state.json (or, in
//   escalateWithoutDb's db-can't-even-open path, the ONLY counter that
//   exists at all) ALSO fails - silently, since writeJsonAtomic used to just
//   console.error and return nothing. Every cycle then reads back the same
//   stuck state (dbFailures/fileState.consecutiveFailures never advance),
//   so `consecutiveCount >= ESCALATION_THRESHOLD` can never become true -
//   100% silent, forever, on exactly the disk-full/read-only scenario this
//   whole task exists to catch. Fixed by: (1) writeJsonAtomic now returns
//   `true`/`false` instead of swallowing silently; (2) recordFailureRun now
//   catches recordJobRun's own throw locally (previously left to propagate,
//   which aborted the function before it could ever notice); (3) when
//   THIS cycle's own attempt proves NEITHER backstop can persist the
//   counter (db insert failed AND the file write failed, and the normal
//   threshold path hasn't already escalated), forceEscalateUnpersistable
//   sends the ⚠ 提醒器状态无法持久化（磁盘/权限故障） card immediately -
//   on the very first such cycle, not the 3rd. The normal 12h throttle can't
//   be trusted here either (it lives in the exact file/db state that just
//   proved unwritable), so this throttles instead via a SEPARATE marker in
//   os.tmpdir() (very often a different filesystem/mount than the runtime
//   dir, so it has a real chance of surviving the SAME failure) - and if
//   even THAT write fails, every cycle sends. Per this task's guiding
//   principle (noisy beats silent): a machine this broken deserves a card
//   every cycle rather than risk a second silent-forever failure mode
//   stacked on top of the first.
//
//   Fix B - every clearAlerterDown call site required a DELIVERED operator
//   card (a genuine `*_sent` marker), but an escalation that itself could
//   not reach anyone (the whole Feishu channel is dead - the exact scenario
//   the artifact exists to report) writes only an `*_undeliverable` marker
//   and never touches lastEscalationAt/lastRecoveryAt in a way
//   recoveryDueFrom/isRecoveryDue can see - so once the outage ends,
//   "no escalation on record" (from the marker-search's point of view) means
//   no recovery card is ever due, the two existing clearAlerterDown call
//   sites are never entered, and the artifact - the one out-of-band channel
//   Fix 3 (task H1 THIRD fix round) built specifically so a doctor/ops check
//   could read it with no db access - latches `alerterDown: true` and a
//   non-zero exit code FOREVER. recordSuccessRun now also clears the
//   artifact (sending a best-effort ✅ 提醒器已恢复 notice first, unless one
//   of the two existing marker-based branches already sent one this same
//   cycle) on ANY cycle that PROVES the alerter is healthy by a DIFFERENT
//   route than "a marker says so": a real delivery this cycle (`sent > 0`),
//   or a poll success that ends a hard-failure streak which was in
//   progress (dbFailures/fileState.consecutiveFailures > 0 before this
//   success). `since` is preserved across repeated markAlerterDown rewrites
//   exactly as before; clearAlerterDown deleting the file is what makes the
//   NEXT genuinely new outage start a fresh `since` (existsSync is false, so
//   markAlerterDown's own since-preservation check falls through to `now`).
//
//   Fix C - DELIVERY_LOOKBACK_GUARD_LIMIT (job-run-log.mjs) was 5,000 while
//   its own comment derived an ~8,640-8,700 row/30-day worst case - 5,000 <
//   8,640, so the "guard" could in fact truncate the very window it claimed
//   to never bite, exactly the class of wrong-safety-argument bound that
//   caused the round-3 regression in the first place. Raised to 50,000 (see
//   job-run-log.mjs's own doc comment for the corrected derivation).
//
//   Fix D - logFailureWithFreshDb's contract comment says it must NEVER
//   throw (every caller unconditionally `throw error`s the ORIGINAL failure
//   right after calling it), but it awaited escalateWithoutDb unguarded - a
//   throw there would propagate out and mask that original error, exactly
//   the invariant Fix 4 (task H1 fix round) established for every OTHER
//   bookkeeping call in this file. Wrapped in the same try/catch-and-log
//   pattern as its sibling below.
//
//   Fix E (minor) - (1) a throwing sendEscalationCard (e.g.
//   MemberRepository.listActive() itself throwing) was caught and logged but
//   never called markAlerterDown, even though the escalation is just as
//   undeliverable as an ok:false send - added to both the hard-failure and
//   delivery-health twins. (2) the off-hours early return used to happen
//   BEFORE any alerterDown check, so launchd/ops tooling watching this
//   poller's exit code saw a false "all clear" for the ~17.5 hours/day
//   outside US regular market hours even while the alerter was down -
//   isAlerterDownArtifactPresent is now checked before that early return
//   too. (3) the phase-2.5 hardening plan's Task 2 doctor spec never named
//   this artifact as something a doctor check should read - amended to say
//   so explicitly (see that file).
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  consecutiveStickyMarkerCountSince,
  lastMarkerAt,
  lastMarkerAtSince,
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
    // Fix E bullet 2 (task H1 FOURTH fix round, this task): checked BEFORE
    // this early return, not after, so launchd/ops tooling watching this
    // poller's exit code still sees the outage during the ~17.5 hours/day
    // outside US regular market hours - isAlerterDownArtifactPresent is a
    // pure fs.existsSync check (see its own doc comment), so this costs
    // nothing extra even on the overwhelmingly common off-hours tick.
    if (isAlerterDownArtifactPresent(dbPath)) {
      return { ok: true, skipped: "off-hours", alerterDown: true };
    }
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
      // Fix 3 (task H1 THIRD fix round, this task): the ALERTER-DOWN.json
      // artifact may still be present from an earlier cycle's undeliverable
      // escalation even though THIS cycle itself is otherwise "ok" (e.g. a
      // neutral fires===0 cycle that never attempted delivery at all, or a
      // recovery that itself failed to send) - surfaced here so main()'s CLI
      // entry point can exit non-zero for launchd/ops tooling even on an
      // "ok" result, without needing this function to throw and turn a
      // genuinely successful poll cycle into a rejection.
      if (isAlerterDownArtifactPresent(dbPath)) {
        return { ...result, alerterDown: true };
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
  } catch (openError) {
    // Fix 2 (task H1 THIRD fix round, this task): openTradingDatabase itself
    // can throw - corrupt sqlite file, a read-only runtime dir, disk full, a
    // failing migration - one of this task's three named motivating
    // scenarios. This used to just `return` here: with no db to hand
    // recordFailureRun (whose file counter lives INSIDE it, reached only
    // after a db handle already exists), the poller would throw the SAME
    // open error every single cycle forever with nothing but a stderr line -
    // 100% silent. escalateWithoutDb does the escalation entirely without a
    // db: both the file counter (poller-state.json, Fix 4's own file - see
    // its doc comment) and the `{}` fallback Feishu send work with no db
    // handle at all.
    //
    // Fix D (task H1 FOURTH fix round, this task): this function's own
    // contract (see every caller - they all unconditionally `throw error`
    // the ORIGINAL failure right after calling this) says it must NEVER
    // throw. escalateWithoutDb used to be awaited unguarded here - wrapped
    // now, mirroring the identical try/catch-and-log pattern used for
    // recordFailureRun just below.
    try {
      await escalateWithoutDb(dbPath, { now, error, openError, transport });
    } catch (escalateError) {
      console.error(
        `market-alerts-poll: escalateWithoutDb threw (the ORIGINAL error will still be rethrown by the caller): ${describeError(escalateError)}`
      );
    }
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

// Fix 2 (task H1 THIRD fix round, this task) - see logFailureWithFreshDb's
// call site above for the full motivation. Bumps/reads the SAME
// poller-state.json file Fix 4 (task H1 second fix round) already
// introduced as the HARD-failure pair's file-based fallback counter - both
// the counter and the escalation send below work with zero db access, which
// is exactly the property this path needs (there is, by definition, no db
// handle available here at all). Honors the identical 12h throttle/recovery
// semantics as recordFailureRun (escalationDueFrom), just fed the file's OWN
// lastEscalationAt/lastRecoveryAt directly since there is no db-side view to
// merge with.
async function escalateWithoutDb(dbPath, { now, error, openError, transport }) {
  const pollerStatePath = resolvePollerStatePath(dbPath);
  const fileState = readPollerState(pollerStatePath);
  const consecutiveCount = fileState.consecutiveFailures + 1;
  const errorSummary = sanitizeAlertText(
    `数据库无法打开：${describeError(openError)}；原始错误：${describeError(error)}`,
    500
  );

  let escalationSentAt = fileState.lastEscalationAt;
  let escalated = false;
  const normalDue =
    consecutiveCount >= ESCALATION_THRESHOLD &&
    escalationDueFrom(now, fileState.lastEscalationAt, fileState.lastRecoveryAt);
  if (normalDue) {
    const card = {
      title: "⚠ 提醒器数据库不可用",
      lines: [
        `已连续 ${consecutiveCount} 次轮询失败，交易数据库无法打开。`,
        `错误：${errorSummary || "未知错误"}`,
        "提醒功能当前完全不可用（连状态都无法读写），请尽快检查数据库文件是否损坏、运行目录权限、磁盘空间等。",
        "修复后下一次轮询成功会自动发送恢复通知，无需手动复位。"
      ]
    };
    // No db handle exists at all here, so this bypasses sendOperatorCard
    // (which needs one for MemberRepository) and sends straight to the `{}`
    // fallback target - resolveFeishuUserPluginBotChatId() via
    // sendInteractiveCard's default transport, same as sendOperatorCard's
    // own fallback tier (see that function's doc comment).
    try {
      const send = await sendInteractiveCard(card, {}, transport);
      if (send.ok) {
        escalationSentAt = now.toISOString();
        clearAlerterDown(dbPath);
      } else {
        console.error(
          `market-alerts-poll: db-open-failure escalation fallback send failed: ${send.error ?? "unknown error"}`
        );
        markAlerterDown(dbPath, {
          now,
          consecutiveFailures: consecutiveCount,
          lastError: errorSummary,
          reason: "db_unreachable"
        });
      }
    } catch (sendError) {
      console.error(
        `market-alerts-poll: sending the db-open-failure escalation card threw: ${describeError(sendError)}`
      );
      markAlerterDown(dbPath, {
        now,
        consecutiveFailures: consecutiveCount,
        lastError: errorSummary,
        reason: "db_unreachable"
      });
    }
    escalated = true;
  }

  // Written even below the 3-failure threshold - mirrors recordFailureRun's
  // own file write, which always happens on every real run regardless of
  // whether this cycle itself escalated.
  const fileWriteOk = writePollerState(pollerStatePath, {
    consecutiveFailures: consecutiveCount,
    lastEscalationAt: escalationSentAt,
    lastRecoveryAt: fileState.lastRecoveryAt
  });

  // Fix A (task H1 FOURTH fix round, this task): the db is ALREADY known
  // unavailable in this path (openTradingDatabase itself threw to get here)
  // - if the state-file write just above ALSO failed, NEITHER backstop can
  // persist this cycle's counter, so `fileState.consecutiveFailures` (read
  // from the SAME file) can never grow past whatever it's stuck at and the
  // normal `consecutiveCount >= ESCALATION_THRESHOLD` check above can never
  // fire again. Force an escalation now via the last-resort path instead of
  // waiting for a threshold this cycle just proved unreachable - unless the
  // normal path already escalated above (avoid double-sending in one cycle).
  if (!escalated && !fileWriteOk) {
    await forceEscalateUnpersistable(dbPath, { now, transport, errorSummary, consecutiveCount });
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

// Fix 4 (task H1 THIRD fix round, this task): a crash mid-write used to leave
// a half-written poller-state.json - readPollerState's own JSON.parse throws
// on a truncated/corrupt file and its catch silently maps that to
// `{consecutiveFailures: 0}`, resetting the streak in EXACTLY the scenario
// this file exists to survive (a db that's been unwritable for the whole
// outage). Mirrors backup-trading-data.mjs's backupTradingDatabase: write the
// full JSON to a sibling `.tmp` path first, then renameSync it over the real
// path - a rename is atomic at the filesystem level, so a crash can only ever
// leave the OLD file fully intact or the NEW one fully written, never a
// half-written one. Shared by poller-state.json and ALERTER-DOWN.json below
// (Fix 3) - both are small JSON state files with the identical corruption
// risk.
// Fix A (task H1 FOURTH fix round, this task): now returns `true`/`false`
// instead of swallowing a write failure silently - callers need to KNOW
// whether this cycle's own counter update actually persisted, so they can
// tell "the normal threshold/throttle mechanism can still see this outage"
// apart from "it just went blind" (see recordFailureRun/escalateWithoutDb's
// own use of this return value below).
function writeJsonAtomic(path, data) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmpPath = `${path}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    renameSync(tmpPath, path);
    return true;
  } catch (error) {
    // Best-effort: if even the FALLBACK file can't be written (disk full,
    // read-only runtime dir), degrade to db-only behavior for this cycle
    // rather than throwing out of bookkeeping - logged so a double-outage
    // stays visible on stderr instead of silently disappearing. The boolean
    // return (see above) is what lets callers react instead of just relying
    // on this stderr line.
    console.error(`market-alerts-poll: failed to atomically write ${path}: ${describeError(error)}`);
    return false;
  }
}

function writePollerState(path, state) {
  return writeJsonAtomic(path, state);
}

// ---------------------------------------------------------------------------
// Out-of-band "alerter is down" artifact (Fix 3, task H1 THIRD fix round)
// ---------------------------------------------------------------------------
//
// Fix 1/Fix 2 above make an undeliverable escalation keep RETRYING every
// cycle and stay VISIBLE in run_log's evidence markers - but for
// `reason === "send_failed"` the escalation card itself rides the exact same
// Feishu channel it's reporting as broken (see sendOperatorCard's own doc
// comment on the member-then-fallback chain), so the outage is by
// construction unreportable through Feishu: nothing external ever reads
// run_log today. This file is the out-of-band channel - written/refreshed on
// every cycle where an escalation of ANY kind (hard-failure OR delivery,
// AND the Fix 2 db-open-failure path below, which has no db to write a
// run_log row into at all) ends up undeliverable, and deleted the moment ANY
// card (an escalation retry OR a recovery) actually gets through. A later
// doctor/ops check can poll for this file's mere EXISTENCE with no db access
// needed at all - see runMarketAlertsPoll's own `alerterDown` result field
// and main()'s exit-code handling below for the other half of this fix
// (launchd/ops tooling must see a non-zero exit even on an otherwise-"ok"
// cycle while this file exists).
function resolveAlerterDownPath(dbPath) {
  return join(dirname(dbPath), "market-alerts", "ALERTER-DOWN.json");
}

function markAlerterDown(dbPath, { now, consecutiveFailures, lastError, reason }) {
  const path = resolveAlerterDownPath(dbPath);
  // Preserve the ORIGINAL onset time across repeated rewrites of an ongoing
  // outage - `since` must answer "how long has this been down", not "when
  // was this file last touched".
  let since = now.toISOString();
  try {
    if (existsSync(path)) {
      const existing = JSON.parse(readFileSync(path, "utf8"));
      if (typeof existing?.since === "string") {
        since = existing.since;
      }
    }
  } catch {
    // Corrupt/unreadable prior artifact - treat this as a fresh onset rather
    // than crash the escalation path over a file that's about to be
    // overwritten anyway.
  }
  writeJsonAtomic(path, {
    since,
    consecutiveFailures,
    lastError,
    reason,
    lastAttemptAt: now.toISOString()
  });
}

function clearAlerterDown(dbPath) {
  const path = resolveAlerterDownPath(dbPath);
  try {
    if (existsSync(path)) {
      rmSync(path, { force: true });
    }
  } catch (error) {
    console.error(`market-alerts-poll: failed to delete ALERTER-DOWN.json: ${describeError(error)}`);
  }
}

function isAlerterDownArtifactPresent(dbPath) {
  return existsSync(resolveAlerterDownPath(dbPath));
}

// ---------------------------------------------------------------------------
// Last-resort throttle + forced escalation when NEITHER backstop can persist
// the failure counter (Fix A, task H1 FOURTH fix round)
// ---------------------------------------------------------------------------
//
// escalateWithoutDb (db could not even be opened - the "db" side of "neither
// db nor file" is a given there) and recordFailureRun (db opened fine but
// THIS cycle's own INSERT still threw, e.g. disk full) both call
// forceEscalateUnpersistable the moment they've proven this cycle's failure
// count cannot be recorded anywhere durable: the normal
// `consecutiveCount >= ESCALATION_THRESHOLD` check depends on a NEXT cycle
// being able to see THIS cycle's failure reflected in either the db or
// poller-state.json - if neither persisted, every future cycle reads back
// the exact same stuck state and that threshold can never be crossed again.
//
// The normal 12h throttle can't be trusted here either - it lives in the
// exact file/db state that just proved unwritable. Throttled instead via a
// SEPARATE marker file in os.tmpdir(), which is very often a different
// filesystem/mount than the runtime dir (a full root disk doesn't
// necessarily fill /tmp, and vice versa) and so has a real chance of
// surviving the SAME failure that broke the primary backstops. Namespaced by
// a sanitized `dbPath` so unrelated runtime dirs (or, in tests, unrelated
// temp dirs from different test cases) never share one throttle marker.
//
// If even THIS write fails, `lastResortThrottleDue` reads back "never sent"
// every time (readLastResortThrottle's own catch-all - see below) and this
// escalates on EVERY cycle rather than risk trusting an unpersistable
// throttle - per this task's guiding principle (noisy beats silent), a
// machine this broken deserves a card every cycle over a second silent-
// forever failure mode stacked on top of the first.
function resolveLastResortThrottlePath(dbPath) {
  const key = resolve(dbPath).replace(/[^a-zA-Z0-9]+/g, "_");
  return join(tmpdir(), `alphaloop-market-alerts-last-resort-throttle-${key}.json`);
}

function readLastResortThrottle(dbPath) {
  try {
    const path = resolveLastResortThrottlePath(dbPath);
    if (!existsSync(path)) {
      return { lastEscalationAt: null };
    }
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return { lastEscalationAt: typeof parsed?.lastEscalationAt === "string" ? parsed.lastEscalationAt : null };
  } catch {
    // Corrupt/unreadable marker - same "fresh state is the safe direction"
    // reasoning as readPollerState's own catch-all above.
    return { lastEscalationAt: null };
  }
}

function writeLastResortThrottle(dbPath, now) {
  return writeJsonAtomic(resolveLastResortThrottlePath(dbPath), { lastEscalationAt: now.toISOString() });
}

function lastResortThrottleDue(dbPath, now) {
  const state = readLastResortThrottle(dbPath);
  // No "recovery" concept for this marker (it isn't tracking a full outage
  // lifecycle, just "did we already send one in the last 12h") - fed `null`
  // for the recovery side of escalationDueFrom.
  return escalationDueFrom(now, state.lastEscalationAt, null);
}

// Shared by escalateWithoutDb and recordFailureRun's hard-failure path - see
// this section's own header comment above for the full rationale. `card` is
// built here (rather than passed in) since both callers want the identical
// wording; `errorSummary`/`consecutiveCount` are already sanitized/computed
// by the caller.
async function forceEscalateUnpersistable(dbPath, { now, transport, errorSummary, consecutiveCount }) {
  if (!lastResortThrottleDue(dbPath, now)) {
    return;
  }
  const card = {
    title: "⚠ 提醒器状态无法持久化（磁盘/权限故障）",
    lines: [
      `已连续 ${consecutiveCount} 次轮询失败，且数据库与状态文件均无法写入，失败计数机制本身已失效。`,
      `最近一次错误：${errorSummary || "未知错误"}`,
      "提醒功能当前完全不可用，请立即检查磁盘空间与运行目录（含数据库所在目录）权限。",
      "本卡片可能会重复发送（状态无法持久化，无法可靠去重/节流）；磁盘/权限恢复后会自动停止。"
    ]
  };
  try {
    const send = await sendInteractiveCard(card, {}, transport);
    if (send.ok) {
      clearAlerterDown(dbPath);
      writeLastResortThrottle(dbPath, now);
    } else {
      console.error(
        `market-alerts-poll: forced unpersistable-counter escalation send failed: ${send.error ?? "unknown error"}`
      );
      markAlerterDown(dbPath, {
        now,
        consecutiveFailures: consecutiveCount,
        lastError: errorSummary,
        reason: "state_unpersistable"
      });
    }
  } catch (sendError) {
    console.error(
      `market-alerts-poll: sending the forced unpersistable-counter escalation card threw: ${describeError(sendError)}`
    );
    markAlerterDown(dbPath, {
      now,
      consecutiveFailures: consecutiveCount,
      lastError: errorSummary,
      reason: "state_unpersistable"
    });
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
  // Fix A (task H1 FOURTH fix round, this task): tracks whether the NORMAL
  // threshold path attempted an escalation this cycle at all, so the forced
  // path below (unpersistable counter) never double-sends in the same cycle.
  let escalated = false;
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
        // Fix 3: a successful escalation delivery proves the alerter is
        // reachable again - clear the out-of-band artifact (a no-op if it
        // was never set).
        clearAlerterDown(dbPath);
      } else {
        // Fix 3: the escalation was due but could not be delivered to ANYONE
        // (see marker.reason - "no_recipients" or "send_failed") - the
        // outage is by construction unreportable through Feishu itself, so
        // write the out-of-band artifact a doctor/ops check can find without
        // any db access.
        markAlerterDown(dbPath, {
          now,
          consecutiveFailures: consecutiveCount,
          lastError: errorSummary,
          reason: marker.reason ?? "send_failed"
        });
      }
    } catch (sendError) {
      console.error(
        `market-alerts-poll: sending the hard-failure escalation card threw (the run_log heartbeat row will still be written): ${describeError(sendError)}`
      );
      // Fix E bullet 1 (task H1 FOURTH fix round, this task): a throw here
      // is JUST as undeliverable as an ok:false send (the marker.reason
      // branch above) - the pre-fix code logged this and moved on without
      // marking the artifact, even though nobody was told anything either
      // way.
      markAlerterDown(dbPath, {
        now,
        consecutiveFailures: consecutiveCount,
        lastError: errorSummary,
        reason: "send_failed"
      });
    }
    escalated = true;
  }

  // Fix 4: written BEFORE recordJobRun below, which may itself throw (the
  // exact scenario this fix exists for) - the file must stay the source of
  // truth for the NEXT cycle even when this cycle's own db row never lands.
  const fileWriteOk = writePollerState(pollerStatePath, {
    consecutiveFailures: consecutiveCount,
    lastEscalationAt: escalationSentAt ?? fileState.lastEscalationAt,
    lastRecoveryAt: fileState.lastRecoveryAt
  });

  // Fix A (this task): recordJobRun's own INSERT can throw for the SAME
  // reason poller-state.json's write can fail (disk full, read-only runtime
  // dir) - previously left unguarded here, so a throw aborted this function
  // immediately and the forced-escalation check below never ran at all. The
  // ORIGINAL poll error this whole failure cycle is about was already
  // captured in `error`/`errorSummary` above and is rethrown by
  // runMarketAlertsPoll's own caller - never by this function - so catching
  // this locally does not risk masking it.
  let dbWriteOk = true;
  try {
    recordJobRun(db, {
      job: CRON_JOB_MARKET_ALERTS,
      startedAt,
      finishedAt,
      ok: false,
      actions: ["poll"],
      failedStep,
      evidence
    });
  } catch (dbError) {
    dbWriteOk = false;
    console.error(
      `market-alerts-poll: recordJobRun insert failed (this cycle's failure could not be persisted to the db either): ${describeError(dbError)}`
    );
  }

  // Fix A (this task): if THIS cycle proved it can persist its counter via
  // NEITHER the db (the INSERT above just failed) NOR the file
  // (poller-state.json also just failed to write), the normal threshold
  // mechanism - which depends on ONE of those two eventually reflecting the
  // growing streak - can never reach ESCALATION_THRESHOLD; every future
  // cycle would read back this exact same stuck state. Escalate NOW instead
  // of waiting for a threshold this cycle just proved unreachable, unless
  // the normal path above already attempted one this same cycle.
  if (!escalated && !dbWriteOk && !fileWriteOk) {
    await forceEscalateUnpersistable(dbPath, { now, transport, errorSummary, consecutiveCount });
  }
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

  // Fix B (task H1 FOURTH fix round, this task): read BEFORE this success's
  // own row lands - `true` means a hard-failure streak WAS in progress and
  // this success cycle just ended it, one of the two independent proofs of
  // health the belt-and-suspenders block near the end of this function
  // relies on (see its own comment for why "a delivered marker exists" is
  // not the only acceptable proof).
  const dbFailuresBeforeThisRun = consecutiveFailureCount(db, CRON_JOB_MARKET_ALERTS);
  const hardFailureStreakEnding = dbFailuresBeforeThisRun > 0 || fileState.consecutiveFailures > 0;

  const previousEscalation = newerIso(
    lastMarkerAt(db, CRON_JOB_MARKET_ALERTS, HARD_ESCALATION_EVENT),
    fileState.lastEscalationAt
  );
  const previousRecovery = newerIso(
    lastMarkerAt(db, CRON_JOB_MARKET_ALERTS, HARD_RECOVERY_EVENT),
    fileState.lastRecoveryAt
  );

  // Fix B: whether EITHER of the two marker-based recovery branches below
  // actually delivered a card this cycle - used purely to avoid a DUPLICATE
  // "recovered" notice from the belt-and-suspenders block further down; it
  // does not gate clearing the artifact itself.
  let recoveryNoticeSent = false;

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
        recoveryNoticeSent = true;
        // Fix 3 (task H1 THIRD fix round, this task): a delivered recovery
        // card proves the alerter is reachable again - clear the artifact
        // (no-op if it was never set).
        clearAlerterDown(dbPath);
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

    const priorDeliveryFailures = consecutiveStickyMarkerCountSince(
      db,
      CRON_JOB_MARKET_ALERTS,
      "delivery_health_bad",
      "delivery_attempted",
      now
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
        const deliveryMarker = await sendEscalationCard(db, transport, now, card, DELIVERY_ESCALATION_EVENT);
        evidence.push(deliveryMarker);
        // Fix 3 (task H1 THIRD fix round, this task): same mark/clear
        // convention as the hard-failure escalation above - an escalation of
        // ANY kind that ends up undeliverable writes the out-of-band
        // artifact; one that gets through clears it.
        if (deliveryMarker.event === DELIVERY_ESCALATION_EVENT) {
          clearAlerterDown(dbPath);
        } else {
          markAlerterDown(dbPath, {
            now,
            consecutiveFailures: deliveryConsecutiveCount,
            lastError: `card 投递持续失败 (${reason})`,
            reason: deliveryMarker.reason ?? reason
          });
        }
      } catch (sendError) {
        console.error(
          `market-alerts-poll: sending the delivery-health escalation card threw (the run_log heartbeat row will still be written): ${describeError(sendError)}`
        );
        // Fix E bullet 1 (task H1 FOURTH fix round, this task): the
        // hard-failure twin above marks the artifact on a send throw too -
        // this branch used to log and move on without doing the same, even
        // though a throw here is exactly as undeliverable as an ok:false
        // send (the deliveryMarker.reason branch above).
        markAlerterDown(dbPath, {
          now,
          consecutiveFailures: deliveryConsecutiveCount,
          lastError: `card 投递持续失败 (${reason})`,
          reason
        });
      }
    }
  } else if (deliveredSuccessfully && isRecoveryDue(db, now, DELIVERY_ESCALATION_EVENT, DELIVERY_RECOVERY_EVENT)) {
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
        recoveryNoticeSent = true;
        // Fix 3 (task H1 THIRD fix round, this task)
        clearAlerterDown(dbPath);
      }
    } catch (sendError) {
      console.error(
        `market-alerts-poll: sending the delivery-health recovery card threw (the run_log heartbeat row will still be written): ${describeError(sendError)}`
      );
    }
  }

  // Fix B (task H1 FOURTH fix round, this task): every clearAlerterDown call
  // site ABOVE requires a genuinely DELIVERED marker-based recovery/retry -
  // but an escalation that never reached anyone (the whole Feishu channel is
  // dead - precisely the scenario the artifact exists to report) writes only
  // an `*_undeliverable` marker, never touches lastEscalationAt in a way
  // recoveryDueFrom/isRecoveryDue can see, and so - once the outage ends -
  // "no escalation on record" makes every branch above conclude no recovery
  // is due at all. None of them ever run, the artifact is never cleared, and
  // `alerterDown: true` / a non-zero exit code latch FOREVER even though the
  // system is demonstrably healthy again.
  //
  // This cycle itself is called ONLY on a successful poll - so "proof of
  // health" here does not need a delivered MARKER at all: `sent > 0` (a real
  // alert reached the user this cycle) or `hardFailureStreakEnding` (this
  // success just ended a hard-failure streak that was in progress) are each
  // independently sufficient proof, regardless of what run_log's markers
  // say about the outage that originally set the artifact. If neither
  // marker-based branch above already sent a notice this cycle, make one
  // best-effort attempt here (a distinct ARTIFACT_RECOVERY_EVENT marker, so
  // it can never be mistaken for a delivered recovery of either specific
  // outage kind) - then clear the artifact regardless of whether even THIS
  // attempt itself delivers: the PROOF of health is this cycle's own poll
  // outcome, not whether Feishu happens to cooperate for this one card too.
  if (isAlerterDownArtifactPresent(dbPath) && (deliveredSuccessfully || hardFailureStreakEnding)) {
    if (!recoveryNoticeSent) {
      try {
        const marker = await sendRecoveryCard(db, transport, now, {
          title: "✅ 提醒器已恢复",
          lines: [
            "提醒器已恢复正常运行 - 此前的故障提示因未能送达而一直未清除，现已确认系统恢复并解除。"
          ]
        }, ARTIFACT_RECOVERY_EVENT);
        if (marker) {
          evidence.push(marker);
        }
      } catch (sendError) {
        console.error(
          `market-alerts-poll: sending the artifact-clearing recovery notice threw (the artifact is still cleared - this cycle's own success is independent proof of health): ${describeError(sendError)}`
        );
      }
    }
    clearAlerterDown(dbPath);
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
// Fix B (task H1 FOURTH fix round, this task) - a THIRD, purely
// informational marker: recorded only on recordSuccessRun's belt-and-
// suspenders artifact-clearing notice (see that function's own comment),
// which fires independently of - and does not feed into - either marker pair
// above's own due-checks. Kept distinct from HARD_RECOVERY_EVENT/
// DELIVERY_RECOVERY_EVENT so that notice can never be mistaken for a real
// recovery of either specific outage kind when a later cycle scans evidence.
const ARTIFACT_RECOVERY_EVENT = "alerter_down_cleared";

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

// task H1 THIRD fix round (this task) - Fix 1: isEscalationDue/isRecoveryDue
// are used EXCLUSIVELY by the DELIVERY pair (DELIVERY_ESCALATION_EVENT/
// DELIVERY_RECOVERY_EVENT below) - the HARD-FAILURE pair is fed pre-resolved,
// file-fallback-merged timestamps directly by recordFailureRun/
// recordSuccessRun via escalationDueFrom/recoveryDueFrom and never calls
// these two functions at all. That split is deliberate: the DELIVERY pair
// must use the TIME-bounded lastMarkerAtSince (job-run-log.mjs's module
// header - "task H1 THIRD fix round" - has the full rationale: 200 rows is
// barely 2.5 trading days at this poller's cadence, and real delivery-outage
// attempts are sparse enough to routinely span more rows than that), while
// the HARD-FAILURE pair's own lookups stay row-bounded (job-run-log.mjs's
// RUN_LOG_LOOKBACK_LIMIT doc comment explains why that one's fine as-is).
// Do NOT redirect the HARD pair through these two functions "for
// consistency" - it would silently lose the Fix 4 file-fallback merge these
// two never do.
function isEscalationDue(db, now, escalationEvent, recoveryEvent) {
  return escalationDueFrom(
    now,
    lastMarkerAtSince(db, CRON_JOB_MARKET_ALERTS, escalationEvent, now),
    lastMarkerAtSince(db, CRON_JOB_MARKET_ALERTS, recoveryEvent, now)
  );
}

function isRecoveryDue(db, now, escalationEvent, recoveryEvent) {
  return recoveryDueFrom(
    lastMarkerAtSince(db, CRON_JOB_MARKET_ALERTS, escalationEvent, now),
    lastMarkerAtSince(db, CRON_JOB_MARKET_ALERTS, recoveryEvent, now)
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
    // Fix 3 (task H1 THIRD fix round, this task): an otherwise-"ok" cycle
    // must still make launchd/ops tooling see a failure while the
    // ALERTER-DOWN.json artifact persists (an escalation that could not be
    // delivered to anyone) - see runMarketAlertsPoll's own doc comment on
    // this field.
    if (result?.alerterDown) {
      process.exitCode = 1;
    }
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
