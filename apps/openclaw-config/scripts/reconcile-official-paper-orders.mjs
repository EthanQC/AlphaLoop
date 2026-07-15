#!/usr/bin/env node
// Phase 6 Task 5 (2026-07-15 plan): full rewrite - "lifecycle-based
// reconciliation with unified broker status map". This replaces the
// pre-Task-5 version's three confirmed audit findings:
//
//   #1 (title-mismatch lookup): the old `findRecentTicketId` correlated a
//      broker order to a ticket by looking up the MOST RECENT
//      execution_reports row whose TITLE happened to equal
//      `Execution report for ${symbol}` - a title no writer in this codebase
//      has ever produced (broker-executor's own report title is
//      `${symbol} 执行报告`), so this lookup always returned null. DELETED
//      entirely, not patched - lifecycle rows now carry their own ticket_id
//      from the moment broker-executor's record-before-execute INSERT
//      happens (Task 4); reconcile only ever needs to (a) refresh a row it
//      can already find by external_order_id, or (b) correlate a genuine
//      orphan against OTHER lifecycle rows directly (see below) - it never
//      needs to go excavate a ticket id out of execution_reports again.
//   #2 (symbol-only COALESCE-overwrite linkage): the old upsert's
//      `ON CONFLICT` clause used `COALESCE(excluded.ticket_id,
//      official_paper_order_lifecycle.ticket_id)` - NEW value wins if
//      non-null - combined with ticket_id coming from the broken lookup
//      above, this direction meant a DIFFERENT order for the same symbol
//      could silently steal/overwrite an already-correct ticket_id. Fixed
//      structurally, not by flipping the COALESCE: a row matched by
//      external_order_id (updateMatchedLifecycleRow below) NEVER mentions
//      ticket_id in its SET clause at all - it is physically impossible for
//      a routine status refresh to change it. The only two paths that ever
//      write ticket_id are broker-executor's own insertSubmitting (Task 4,
//      unchanged) and this file's claimOrphanLifecycleRow (adoption, only
//      into a row where ticket_id is ALREADY the value being "carried
//      over", not overwritten) - see the finding-#2 regression test in
//      reconcile-official-paper-orders.test.ts.
//   #6 (double execution_report write): the old script wrote BOTH an
//      official_paper_order_lifecycle row AND an
//      `execution_reports` (category 'trade') row per observed order, on
//      every run - a second, parallel "trade happened" record with no
//      lifecycle awareness, and (being an idempotent INSERT OR REPLACE
//      keyed by external_order_id) a second write on every subsequent
//      reconcile pass too. DELETED: this file never writes execution_reports
//      any more. Every discrepancy/decision it makes goes to audit_log only.
//
// Finding #5 (cancel-status mapping - WaitToCancel/PendingCancel silently
// falling into "unknown" instead of a real in-progress-cancel stage) is
// fixed by importing the shared broker-status-map module (Task 5's other
// deliverable) instead of this file's own inline copy of the old,
// incomplete table.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AuditLogRepository,
  openTradingDatabase,
  ProposalRepository
} from "../../../packages/shared-types/dist/index.js";
import { mapBrokerStatusToStage } from "./broker-status-map.mjs";
import { runLongbridgeJson } from "./_longbridge.mjs";
import { repoRoot } from "./repo-root.mjs";

// Global Constraint ("对账重建规则"): orphan ticket_id correlation only ever
// infers from OTHER lifecycle rows (symbol+side+quantity+submission-time
// proximity) - never from anything broker-side. 30 minutes mirrors the exact
// window named in the Task 5 deliverable.
export const DEFAULT_ORPHAN_CORRELATION_WINDOW_MS = 30 * 60 * 1000;

// How long a 'submit_unconfirmed' row (broker-executor's CLI call
// errored/timed out - Task 4's Global Constraint ⑥) is allowed to sit
// unresolved before reconcile gives up waiting for the broker's own
// day-order list to show it and adjudicates it 'failed'. 30 minutes gives
// the broker's own reporting pipeline generous room to catch up (the same
// order of magnitude as the orphan correlation window above) before this
// file concludes the order never reached the broker at all.
export const DEFAULT_SUBMIT_UNCONFIRMED_TIMEOUT_MS = 30 * 60 * 1000;

// Mirrors apps/broker-executor/src/server.ts's own `deriveTicketId` (that
// file derives `ticket_prop_<proposalId>`, deterministically, with no DB
// read) - this is the exact inverse, used ONLY to find a proposal to
// mark-failed when a submit_unconfirmed row times out. A ticket_id that does
// not match this shape (e.g. a hand-seeded fixture, or the retired manual
// `manual_<timestamp>` scheme) simply has no proposal to notify - "if
// linked", per the Task 5 deliverable, not an error.
const PROPOSAL_TICKET_PREFIX = "ticket_prop_";

function proposalIdFromTicketId(ticketId) {
  if (typeof ticketId !== "string" || !ticketId.startsWith(PROPOSAL_TICKET_PREFIX)) {
    return null;
  }
  const proposalId = ticketId.slice(PROPOSAL_TICKET_PREFIX.length);
  return proposalId.length > 0 ? proposalId : null;
}

/**
 * Core reconciliation pass. Dependency-injected (fetchOrders/fetchExecutions/
 * now) so replay tests can drive it with scripted, deterministic fixtures -
 * no real broker, no wall clock.
 */
export async function reconcileOfficialPaperOrders(db, options = {}) {
  const {
    fetchOrders = () => runLongbridgeJson("trade", ["order"]),
    fetchExecutions = () => runLongbridgeJson("trade", ["order", "executions"]),
    now = () => new Date(),
    symbolFilters = new Set(),
    orphanCorrelationWindowMs = DEFAULT_ORPHAN_CORRELATION_WINDOW_MS,
    submitUnconfirmedTimeoutMs = DEFAULT_SUBMIT_UNCONFIRMED_TIMEOUT_MS
  } = options;

  const audit = new AuditLogRepository(db);
  const proposals = new ProposalRepository(db);

  const ordersPayload = await fetchOrders();
  const executionsPayload = await fetchExecutions();
  const orders = asArray(ordersPayload)
    .filter((order) => symbolFilters.size === 0 || symbolFilters.has(String(order.symbol ?? "").toUpperCase()));
  const executions = asArray(executionsPayload);
  const observedAt = now().toISOString();

  const matched = [];
  const adopted = [];
  const deferredInFlight = [];
  const orphaned = [];

  for (const order of orders) {
    const externalOrderId = String(order.order_id ?? order.orderId ?? order.id ?? "");
    if (!externalOrderId) {
      continue;
    }

    const symbol = String(order.symbol ?? "");
    const side = normalizeSide(order.side);
    const quantity = toNumber(order.quantity) ?? 0;
    const limitPrice = toNumber(order.price);
    const brokerStatusRaw = String(order.status ?? "unknown");
    const { stage, localStatus } = mapBrokerStatusToStage(brokerStatusRaw);
    const submittedAt = String(order.created_at ?? order.createdAt ?? observedAt);
    const submittedAtMs = new Date(submittedAt).getTime();
    const matchingExecutions = executions.filter((execution) => {
      const executionOrderId = String(execution.order_id ?? execution.orderId ?? "");
      return executionOrderId === externalOrderId;
    });
    const raw = { order, executions: matchingExecutions };
    const notes = [
      "Official Longbridge Demo A/C paper order observed via CLI reconciliation.",
      "This is an equity/ETF paper lifecycle record; options automation remains disabled.",
      "No real-money order was submitted by this reconciliation.",
      `Broker status: ${brokerStatusRaw} -> lifecycle stage: ${stage}.`
    ];

    // ---- 1. Already known: matched by external_order_id -----------------
    const existingByExternalId = getLifecycleByExternalOrderId(db, externalOrderId);
    if (existingByExternalId) {
      updateMatchedLifecycleRow(db, externalOrderId, { brokerStatus: brokerStatusRaw, localStatus, stage, observedAt, raw, notes });
      matched.push({
        externalOrderId,
        ticketId: existingByExternalId.ticket_id ?? null,
        symbol,
        side,
        quantity,
        brokerStatus: brokerStatusRaw,
        lifecycleStage: stage,
        localStatus
      });
      continue;
    }

    // ---- 2. Orphan (no lifecycle row yet, by external_order_id) --------
    const correlation = findOrphanCorrelationCandidate(db, {
      symbol,
      side,
      quantity,
      orderSubmittedAtMs: submittedAtMs,
      windowMs: orphanCorrelationWindowMs
    });

    if (correlation?.kind === "adopt") {
      const candidate = correlation.row;
      claimOrphanLifecycleRow(db, candidate.id, { externalOrderId, brokerStatus: brokerStatusRaw, localStatus, stage, observedAt, raw, notes });
      audit.write("reconcile", "orphan_broker_order_adopted", {
        externalOrderId,
        ticketId: candidate.ticket_id,
        symbol,
        side,
        quantity,
        lifecycleStage: stage
      });
      adopted.push({
        externalOrderId,
        ticketId: candidate.ticket_id ?? null,
        symbol,
        side,
        quantity,
        brokerStatus: brokerStatusRaw,
        lifecycleStage: stage,
        localStatus
      });
      continue;
    }

    if (correlation?.kind === "defer") {
      // reconcile-before-executor-callback: a 'submitting' row (Global
      // Constraint ⑤ - broker-executor already inserted it, but its own CLI
      // call has not returned yet) matches this broker order within the
      // correlation window. Adopting it here would race broker-executor's
      // own upcoming finalizeExecution UPDATE (keyed by ticket_id) writing
      // this SAME external_order_id - and inserting a brand-new orphan row
      // for it instead would permanently collide with that later UPDATE on
      // the external_order_id UNIQUE constraint. Correct move: do nothing to
      // the lifecycle table at all and let broker-executor's own callback
      // complete the row normally; audit-log the observation for visibility.
      const candidate = correlation.row;
      audit.write("reconcile", "broker_order_deferred_inflight_submitting", {
        externalOrderId,
        candidateTicketId: candidate.ticket_id,
        symbol,
        side,
        quantity
      });
      deferredInFlight.push({ externalOrderId, candidateTicketId: candidate.ticket_id ?? null, symbol, side, quantity });
      continue;
    }

    // ---- 3. Genuine orphan: no correlation candidate -> ticket_id NULL --
    insertOrphanLifecycleRow(db, {
      externalOrderId,
      symbol,
      side,
      quantity,
      limitPrice,
      brokerStatus: brokerStatusRaw,
      localStatus,
      stage,
      submittedAt,
      observedAt,
      raw,
      notes
    });
    audit.write("reconcile", "orphan_broker_order", {
      externalOrderId,
      symbol,
      side,
      quantity,
      lifecycleStage: stage,
      reason: "no lifecycle row matched by external_order_id, and no submit_unconfirmed/submitting lifecycle row correlates within the adoption window"
    });
    orphaned.push({ externalOrderId, ticketId: null, symbol, side, quantity, brokerStatus: brokerStatusRaw, lifecycleStage: stage, localStatus });
  }

  // ---- submit_unconfirmed adjudication (timeout direction) -------------
  // Rows still 'submit_unconfirmed' with no external_order_id after the loop
  // above (i.e. NOT adopted by any observed broker order this pass) are
  // candidates for "broker never got it" - but only past the timeout window,
  // so a submit_unconfirmed row from moments ago (broker reporting lag is
  // normal) is left alone for a later reconcile pass to resolve.
  const nowMs = now().getTime();
  const timedOut = [];
  const stillUnconfirmed = db
    .prepare(`SELECT * FROM official_paper_order_lifecycle WHERE lifecycle_stage = 'submit_unconfirmed' AND external_order_id IS NULL`)
    .all();

  for (const row of stillUnconfirmed) {
    const submittedAtMs = new Date(String(row.submitted_at)).getTime();
    if (!Number.isFinite(submittedAtMs) || nowMs - submittedAtMs < submitUnconfirmedTimeoutMs) {
      continue;
    }

    const reason = `对账超时：券商当日订单列表中未观察到该工单（提交于 ${row.submitted_at}），已超过 ${Math.round(submitUnconfirmedTimeoutMs / 60000)} 分钟裁决窗口，判定为提交失败。`;
    db.prepare(`
      UPDATE official_paper_order_lifecycle
      SET lifecycle_stage = 'failed', local_status = 'rejected', last_observed_at = ?, notes = ?
      WHERE id = ?
    `).run(observedAt, JSON.stringify([reason]), row.id);

    audit.write("reconcile", "submit_unconfirmed_timeout_failed", {
      ticketId: row.ticket_id,
      symbol: row.symbol,
      side: row.side,
      quantity: row.quantity,
      submittedAt: row.submitted_at
    });

    const proposalId = proposalIdFromTicketId(row.ticket_id);
    if (proposalId) {
      try {
        proposals.markFailed(proposalId, reason);
      } catch (error) {
        audit.write("reconcile", "submit_unconfirmed_timeout_markfailed_error", {
          proposalId,
          ticketId: row.ticket_id,
          error: String(error?.message ?? error)
        });
      }
    }

    timedOut.push({ ticketId: row.ticket_id ?? null, symbol: row.symbol, proposalId });
  }

  return { observedAt, matched, adopted, deferredInFlight, orphaned, timedOut };
}

function getLifecycleByExternalOrderId(db, externalOrderId) {
  return db
    .prepare(`SELECT * FROM official_paper_order_lifecycle WHERE external_order_id = ? LIMIT 1`)
    .get(externalOrderId) ?? null;
}

// Finding #2 fix: this UPDATE never mentions ticket_id - a row matched by
// external_order_id can NEVER have its ticket_id changed by a routine status
// refresh, structurally, not via a COALESCE direction that could later be
// flipped back by accident.
function updateMatchedLifecycleRow(db, externalOrderId, { brokerStatus, localStatus, stage, observedAt, raw, notes }) {
  db.prepare(`
    UPDATE official_paper_order_lifecycle
    SET broker_status = ?, local_status = ?, lifecycle_stage = ?, last_observed_at = ?, raw = ?, notes = ?
    WHERE external_order_id = ?
  `).run(brokerStatus, localStatus, stage, observedAt, JSON.stringify(raw), JSON.stringify(notes), externalOrderId);
}

// Adoption: fills in external_order_id (guaranteed NULL on a
// submit_unconfirmed row by construction - neither insertSubmitting nor
// markSubmitUnconfirmed in packages/shared-types/src/database.ts ever sets
// it) and the freshly observed status/stage. ticket_id is NEVER part of this
// SET clause - the row's own pre-existing ticket_id (the whole reason it was
// adoptable) passes through completely untouched, it is only ever READ back
// out by the caller for the adopted-event payload.
function claimOrphanLifecycleRow(db, rowId, { externalOrderId, brokerStatus, localStatus, stage, observedAt, raw, notes }) {
  const result = db.prepare(`
    UPDATE official_paper_order_lifecycle
    SET external_order_id = ?, broker_status = ?, local_status = ?, lifecycle_stage = ?, last_observed_at = ?, raw = ?, notes = ?
    WHERE id = ? AND external_order_id IS NULL
  `).run(externalOrderId, brokerStatus, localStatus, stage, observedAt, JSON.stringify(raw), JSON.stringify(notes), rowId);

  if (Number(result.changes) !== 1) {
    throw new Error(`Failed to claim lifecycle row ${rowId} for external order ${externalOrderId} (already claimed or missing).`);
  }
}

// Brand-new row for a broker order nothing in the lifecycle table can be
// correlated to - ticket_id is NULL, permanently (nothing here ever guesses
// one). Idempotent across reruns via ON CONFLICT(external_order_id): a
// second reconcile pass over the SAME broker order finds it already exists
// (by external_order_id) via getLifecycleByExternalOrderId ABOVE and takes
// the "matched" branch instead, so in practice this ON CONFLICT branch is a
// defensive no-op - kept anyway as a second layer of the same finding-#2
// protection (it, too, never touches ticket_id).
function insertOrphanLifecycleRow(db, { externalOrderId, symbol, side, quantity, limitPrice, brokerStatus, localStatus, stage, submittedAt, observedAt, raw, notes }) {
  db.prepare(`
    INSERT INTO official_paper_order_lifecycle
    (id, ticket_id, external_order_id, provider, environment, account_mode, symbol, asset_class,
     side, quantity, limit_price, broker_status, local_status, lifecycle_stage, submitted_at,
     last_observed_at, raw, notes)
    VALUES (?, NULL, ?, 'longbridge-paper', 'paper', 'paper', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(external_order_id) DO UPDATE SET
      broker_status = excluded.broker_status,
      local_status = excluded.local_status,
      lifecycle_stage = excluded.lifecycle_stage,
      last_observed_at = excluded.last_observed_at,
      raw = excluded.raw,
      notes = excluded.notes
  `).run(
    `lb_order_${externalOrderId}`,
    externalOrderId,
    symbol,
    guessAssetClass(symbol),
    side,
    quantity,
    limitPrice ?? null,
    brokerStatus,
    localStatus,
    stage,
    submittedAt,
    observedAt,
    JSON.stringify(raw),
    JSON.stringify(notes)
  );
}

// Orphan correlation: candidates are lifecycle rows with no external_order_id
// yet, matching symbol+side+quantity, in EITHER of the two stages a
// not-yet-externally-confirmed row can be in - 'submit_unconfirmed'
// (adoptable: the CLI call already errored/timed out, so this row is
// genuinely waiting for reconcile to resolve it one way or the other) or
// 'submitting' (NOT adoptable - broker-executor's own request for it is
// still in flight; see the "defer" branch's own comment above for why
// adopting here would race broker-executor's callback). Closest submitted_at
// within the window wins; 'submit_unconfirmed' candidates are preferred over
// 'submitting' ones since adoption is the more actionable outcome.
function findOrphanCorrelationCandidate(db, { symbol, side, quantity, orderSubmittedAtMs, windowMs }) {
  const rows = db.prepare(`
    SELECT * FROM official_paper_order_lifecycle
    WHERE symbol = ? AND side = ? AND quantity = ?
      AND external_order_id IS NULL
      AND lifecycle_stage IN ('submit_unconfirmed', 'submitting')
  `).all(symbol, side, quantity);

  const withinWindow = rows
    .map((row) => ({ row, deltaMs: Math.abs(new Date(String(row.submitted_at)).getTime() - orderSubmittedAtMs) }))
    .filter(({ deltaMs }) => Number.isFinite(deltaMs) && deltaMs <= windowMs)
    .sort((a, b) => a.deltaMs - b.deltaMs);

  const adoptable = withinWindow.find(({ row }) => row.lifecycle_stage === "submit_unconfirmed");
  if (adoptable) {
    return { kind: "adopt", row: adoptable.row };
  }

  const inFlight = withinWindow.find(({ row }) => row.lifecycle_stage === "submitting");
  if (inFlight) {
    return { kind: "defer", row: inFlight.row };
  }

  return null;
}

function asArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (Array.isArray(value?.orders)) {
    return value.orders;
  }
  if (Array.isArray(value?.executions)) {
    return value.executions;
  }
  return [];
}

function normalizeSide(value) {
  const normalized = String(value ?? "").toLowerCase();
  return normalized === "sell" ? "sell" : "buy";
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function guessAssetClass(symbol) {
  return ["SPY.US", "QQQ.US", "IWM.US", "DIA.US"].includes(symbol) ? "etf" : "stock";
}

// ---------------------------------------------------------------------------
// CLI entry point. Guarded by isMainModule so importing this module (tests)
// never opens the real runtime db, calls the real Longbridge CLI, or
// dispatches as a side effect of `import` - mirrors official-paper-
// monitor.mjs/market-alerts-poll.mjs's existing testable-CLI pattern.
// ---------------------------------------------------------------------------

async function main() {
  if (process.env.LONGBRIDGE_ACCOUNT_MODE !== "paper") {
    console.error("Refusing to reconcile official paper orders unless LONGBRIDGE_ACCOUNT_MODE=paper.");
    process.exit(1);
  }

  if (process.env.ALLOW_LIVE_EXECUTION === "true") {
    console.error("Refusing to reconcile official paper orders while ALLOW_LIVE_EXECUTION=true.");
    process.exit(1);
  }

  mkdirSync(join(repoRoot, "runtime"), { recursive: true });
  const dbPath = join(repoRoot, "runtime", "trading.sqlite");
  const db = openTradingDatabase(dbPath);
  const symbolFilters = new Set(process.argv.slice(2).map((entry) => entry.toUpperCase()));

  try {
    const result = await reconcileOfficialPaperOrders(db, { symbolFilters });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    db.close();
  }
}

const isMainModule = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  await main();
}
