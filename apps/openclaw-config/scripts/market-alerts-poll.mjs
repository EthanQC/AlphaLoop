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
//   exit) -> isolate per-rule config errors (see below) -> build sample
//   (quotes via an injectable provider, positions/exposure from the latest
//   official_paper_snapshots row via computeExposure) -> evaluateAll ->
//   (unless --dry-run) persist runtimes/events/quota -> enrich fires with
//   threshold+eventId -> composeAlertCards -> deliverAlertCards -> one-line
//   JSON summary, exit 0. Any throw anywhere in this path produces a
//   one-line {ok:false, error} + exit 1 - launchd's own StartInterval retry
//   is the only retry mechanism; this script deliberately has none of its
//   own (see market-alerts-cards.mjs's no-retry rationale, same principle).
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
  const quotes = await quoteProvider(symbols);

  // Single shared Longbridge paper-trading account behind the whole system
  // (see market-alerts-cards.mjs's module header) - sample.exposure/
  // sample.positions are ONE flat object for the entire batch, not per
  // owner, so there is exactly one snapshot query per cycle regardless of
  // how many distinct owners have rules. The "owner OR NULL" shape mirrors
  // market-alerts-store.mjs's isSymbolInPositions precedent, generalized to
  // every owner appearing in this cycle's rules.
  const ownerIds = Array.from(new Set(validRules.map((rule) => rule.ownerId)));
  const snapshotRow = loadLatestSnapshotRow(db, ownerIds);
  const exposureResult = computeExposure({
    netAssets: snapshotRow ? toNumber(snapshotRow.net_assets) ?? null : null,
    marketValue: snapshotRow ? toNumber(snapshotRow.market_value) ?? 0 : 0,
    positions: snapshotRow ? parseSnapshotPositions(snapshotRow.positions) : []
  });

  const sample = {
    atIso,
    tradingDay,
    quotes,
    positions: buildEnginePositions(snapshotRow, quotes),
    exposure: { exposureRatio: exposureResult.exposureRatio, overBudget: exposureResult.overBudget }
  };

  const runtimes = store.getRuntimes(db, validRules.map((rule) => rule.id));
  const quotaByOwner = {};
  for (const ownerId of ownerIds) {
    quotaByOwner[ownerId] = store.getQuota(db, ownerId, tradingDay);
  }

  const evaluation = evaluateAll(validRules, runtimes, sample, quotaByOwner);
  const quotaBlocked = evaluation.skips.filter((skip) => skip.reason === "quota").length;

  if (dryRun) {
    // Contract: --dry-run evaluates but performs NO db writes and NO
    // delivery at all - not saveRuntimes, not recordEvents, not bumpQuota,
    // not composeAlertCards/deliverAlertCards. Return before any of those.
    return {
      ok: true,
      dryRun: true,
      evaluated: validRules.length,
      fires: evaluation.fires.length,
      wouldFire: evaluation.fires.map((fire) => ({
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

  store.saveRuntimes(db, evaluation.newRuntimes);
  const createdEvents = store.recordEvents(
    db,
    evaluation.fires.map((fire) => ({
      ruleId: fire.ruleId,
      ownerId: fire.ownerId,
      value: fire.value,
      triggeredAt: fire.triggeredAt
    }))
  );

  // newQuotas is the running per-owner fired_count already reflecting this
  // batch (see evaluateAll's doc comment) - bumpQuota only the delta actually
  // applied this cycle, per owner, so a repeated poll never double-counts.
  for (const ownerId of Object.keys(evaluation.newQuotas)) {
    const delta = evaluation.newQuotas[ownerId] - (quotaByOwner[ownerId] ?? 0);
    if (delta > 0) {
      store.bumpQuota(db, ownerId, tradingDay, delta);
    }
  }

  const ruleById = new Map(validRules.map((rule) => [rule.id, rule]));
  const enrichedFires = evaluation.fires.map((fire, index) => ({
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

  const composed = composeAlertCards(enrichedFires, memberById, buildPositionsForCards(sample));
  const delivery = await deliverAlertCards(db, composed, transport);

  return {
    ok: true,
    dryRun: false,
    evaluated: validRules.length,
    fires: evaluation.fires.length,
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

// Raw SQL against official_paper_snapshots lives here (not in
// market-alerts-store.mjs, which scopes itself to the alert_* tables plus
// the P2-4 CLI's cross-table reads) - mirroring how official-paper-monitor.mjs
// already queries this same table directly for its own purposes.
function loadLatestSnapshotRow(db, ownerIds) {
  const ids = (ownerIds ?? []).filter((id) => id !== null && id !== undefined);
  const whereClause = ids.length > 0
    ? `owner_id IN (${ids.map(() => "?").join(", ")}) OR owner_id IS NULL`
    : "owner_id IS NULL";
  const row = db
    .prepare(`
      SELECT net_assets, market_value, positions
      FROM official_paper_snapshots
      WHERE ${whereClause}
      ORDER BY fetched_at DESC
      LIMIT 1
    `)
    .get(...ids);
  return row ?? null;
}

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
