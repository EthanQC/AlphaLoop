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
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MemberRepository,
  loadLocalEnv,
  openTradingDatabase,
  resolveRuntimePaths
} from "../../../packages/shared-types/dist/index.js";
import { runLongbridgeJsonWithRetry } from "./_longbridge.mjs";
import { buildPositionsForCards, composeAlertCards, deliverAlertCards } from "./market-alerts-cards.mjs";
import { EXPOSURE_SYMBOL, RULE_TYPE_FREQUENCY, evaluateAll } from "./market-alerts-engine.mjs";
import * as store from "./market-alerts-store.mjs";
import { computeExposure } from "./portfolio-exposure.mjs";
import { toNumber } from "./report-data.mjs";
import { assertCalendarCoverage, currentUsEasternTradingDay, isUsRegularMarketHours } from "./trading-schedule.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
loadLocalEnv(repoRoot);

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

  // isUsRegularMarketHours already calls assertCalendarCoverage internally;
  // this explicit call just documents the flow the task brief names
  // (calendar check, then market-hours check) and stays cheap/harmless even
  // if that internal detail ever changes.
  assertCalendarCoverage(now);

  if (!isUsRegularMarketHours(now)) {
    return { ok: true, skipped: "off-hours" };
  }

  const dryRun = Boolean(options.dryRun);
  const quoteProvider = options.quoteProvider ?? defaultQuoteProvider;
  const dbPath = options.dbPath ?? resolveRuntimePaths(repoRoot).dbPath;
  const db = openTradingDatabase(dbPath);

  try {
    return await pollOnce(db, { now, dryRun, quoteProvider, transport: options.transport });
  } finally {
    db.close();
  }
}

async function pollOnce(db, { now, dryRun, quoteProvider, transport }) {
  const rules = store.listEnabledRules(db);
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
  const quotes = await quoteProvider(symbols);

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
    const snapshotRow = store.loadLatestSnapshotForOwner(db, ownerId);
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

    const ownerEvaluation = evaluateAll(ownerRules, runtimes, ownerSample, { [ownerId]: quotaByOwner[ownerId] ?? 0 });

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

  const createdEvents = store.persistCycle(db, { runtimes: newRuntimes, events, quotaBumps });

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
  const memberById = Object.fromEntries(new MemberRepository(db).listActive().map((member) => [member.id, member]));

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
    const composed = composeAlertCards(ownerFires, memberById, buildPositionsForCards(samplesByOwner[ownerId]));
    batches.push(...composed.batches);
    skippedDelivery.push(...composed.skipped);
  }

  const delivery = await deliverAlertCards(db, { batches, skipped: skippedDelivery }, transport);

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
