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
//      reconcile pass too. DELETED: the per-observed-order write is gone, and
//      every discrepancy/decision this file makes goes to audit_log.
//      F6 (2026-07-28 round 3) correction: this used to read "this file never
//      writes execution_reports any more ... audit_log ONLY", which stopped
//      being true the moment FIX 1 below added reconcileStuckFailedProposal.
//      That function DOES write exactly one execution_reports row - but only
//      on the narrow path where it also moves a proposal off 'failed', i.e.
//      once per corrected proposal, never once per observed order, and never
//      on a routine status refresh (the proposal-status check makes a replay a
//      no-op). See its own doc comment for the four conditions.
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
  ExecutionReportRepository,
  MemberRepository,
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
export const DEFAULT_SUBMITTING_GRACE_MS = 30 * 60 * 1000;

// Shared-account reconciliation has the same owner semantics as the snapshot
// writer: exactly one active member is attributable; zero or multiple active
// members are explicitly shared rather than silently written as a new NULL
// owner. Historical NULL rows remain legal, but every fresh reconciliation
// write now satisfies schema v4's "new writes carry owner_id" contract.
export const RECONCILE_SHARED_OWNER_SENTINEL = "__shared__";

export function resolveReconciliationOwnerId(db) {
  const activeMembers = new MemberRepository(db).listActive();
  return activeMembers.length === 1 ? activeMembers[0].id : RECONCILE_SHARED_OWNER_SENTINEL;
}

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
    execOptions = {},
    now = () => new Date(),
    symbolFilters = new Set(),
    explicitOwnerId,
    orphanCorrelationWindowMs = DEFAULT_ORPHAN_CORRELATION_WINDOW_MS,
    submitUnconfirmedTimeoutMs = DEFAULT_SUBMIT_UNCONFIRMED_TIMEOUT_MS,
    submittingGraceMs = DEFAULT_SUBMITTING_GRACE_MS
  } = options;

  const audit = new AuditLogRepository(db);
  const proposals = new ProposalRepository(db);
  const reports = new ExecutionReportRepository(db);
  const accountOwnerId = explicitOwnerId ?? resolveReconciliationOwnerId(db);
  // Broker order ids are account-local. Only legacy/global reconciliation may
  // migrate pre-v20 NULL-owner rows. An explicit member account must use an
  // exact owner row or create its own lifecycle record.
  const allowUnattributedLegacyRows = explicitOwnerId === undefined;
  const observedDate = now();
  const observedAt = observedDate.toISOString();
  const nowMs = observedDate.getTime();
  const fetchOrders = options.fetchOrders ?? (() => runLongbridgeJson("trade", ["order"], execOptions));
  const fetchExecutions = options.fetchExecutions ?? (() => runLongbridgeJson("trade", ["order", "executions"], execOptions));
  // Unit callers that inject today's list remain explicitly history-blind
  // unless they also inject the history seam. Production (no injection)
  // always enables the pinned SDK's bounded history APIs.
  const fetchHistoricalOrders = options.fetchHistoricalOrders
    ?? (options.fetchOrders === undefined
      ? ({ startAt, endAt, symbol }) => runLongbridgeJson(
        "trade",
        ["order", "history", "--symbol", symbol, "--start", startAt, "--end", endAt],
        execOptions
      )
      : null);
  const fetchHistoricalExecutions = options.fetchHistoricalExecutions
    ?? (options.fetchExecutions === undefined
      ? ({ startAt, endAt, symbol }) => runLongbridgeJson(
        "trade",
        ["order", "history", "executions", "--symbol", symbol, "--start", startAt, "--end", endAt],
        execOptions
      )
      : null);

  const unresolvedBeforeFetch = listUnconfirmedRows(
    db,
    proposals,
    accountOwnerId,
    symbolFilters,
    allowUnattributedLegacyRows
  );
  const crossDayRows = unresolvedBeforeFetch.filter((row) => {
    const submittedAtMs = new Date(String(row.submitted_at)).getTime();
    return Number.isFinite(submittedAtMs)
      && nowMs - submittedAtMs >= submitUnconfirmedTimeoutMs
      && tradingDateKey(submittedAtMs) !== tradingDateKey(nowMs);
  });
  const historyCoveredRowIds = new Set();
  let historicalOrders = [];
  let historicalExecutions = [];
  if (crossDayRows.length > 0 && fetchHistoricalOrders) {
    for (const row of crossDayRows) {
      const submittedAtMs = new Date(String(row.submitted_at)).getTime();
      const historyWindow = {
        startAt: new Date(submittedAtMs - orphanCorrelationWindowMs).toISOString(),
        endAt: new Date(Math.min(nowMs, submittedAtMs + orphanCorrelationWindowMs)).toISOString(),
        symbol: String(row.symbol).toUpperCase()
      };
      const orderPage = validateBrokerOrders(requireBrokerArrayPayload(
        await fetchHistoricalOrders(historyWindow),
        "historical orders"
      ));
      // Longbridge's history endpoint is capped at 1000 rows, while the
      // pinned Node SDK discards the upstream `has_more` bit and exposes only
      // Order[]. A full page therefore cannot prove absence; fail closed
      // before any lifecycle write instead of releasing budget on truncation.
      if (orderPage.length >= 1000) {
        throw new Error(`Longbridge historical orders returned ${orderPage.length} rows; completeness cannot be proven at the 1000-row truncation boundary.`);
      }
      const relevantOrders = orderPage.filter((order) => historicalOrderMatchesUnconfirmedRow(
        order,
        [row],
        orphanCorrelationWindowMs
      ));
      const selectedOrderIds = new Set(relevantOrders.map((order) => brokerExternalOrderId(order)));
      historicalOrders.push(...relevantOrders);

      if (fetchHistoricalExecutions) {
        const executionPage = validateBrokerExecutions(requireBrokerArrayPayload(
          await fetchHistoricalExecutions(historyWindow),
          "historical executions"
        ));
        if (executionPage.length >= 1000) {
          throw new Error(`Longbridge historical executions returned ${executionPage.length} rows; completeness cannot be proven at the 1000-row truncation boundary.`);
        }
        historicalExecutions.push(...executionPage.filter((execution) => selectedOrderIds.has(brokerExternalOrderId(execution))));
      }
      historyCoveredRowIds.add(row.id);
    }
  }

  const ordersPayload = await fetchOrders();
  const executionsPayload = await fetchExecutions();
  const orders = dedupeBrokerRows([
    ...validateBrokerOrders(requireBrokerArrayPayload(ordersPayload, "orders")),
    ...historicalOrders
  ]).filter((order) => symbolFilters.size === 0 || symbolFilters.has(String(order.symbol ?? "").toUpperCase()));
  const executions = dedupeBrokerRows([
    ...validateBrokerExecutions(requireBrokerArrayPayload(executionsPayload, "executions")),
    ...historicalExecutions
  ], true);

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
    const existingByExternalId = getLifecycleByExternalOrderId(
      db,
      externalOrderId,
      accountOwnerId,
      proposals,
      allowUnattributedLegacyRows
    );
    if (existingByExternalId) {
      const ownerId = resolveLifecycleOwnerId(proposals, existingByExternalId, accountOwnerId);
      updateMatchedLifecycleRow(db, existingByExternalId.id, { brokerStatus: brokerStatusRaw, localStatus, stage, observedAt, raw, notes, ownerId });
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

      // FIX 1a: the un-stick must ALSO run on the matched branch, not just on
      // adoption. Reachable scenario: an order adopted while the broker
      // reported an UNMAPPED status landed at stage 'unknown_broker_status'
      // (correctly excluded from the un-stick set), and only a LATER pass -
      // which matches by external_order_id, i.e. THIS branch - observes it
      // 'Filled'. Without the call here the proposal stays 'failed' forever
      // for really-bought shares. reconcileStuckFailedProposal is idempotent
      // (proposal status !== 'failed' is a no-op), so routine matched
      // refreshes of healthy orders cost one proposal lookup and change
      // nothing.
      reconcileStuckFailedProposal(db, proposals, reports, audit, {
        ticketId: existingByExternalId.ticket_id,
        stage,
        symbol,
        side,
        quantity,
        limitPrice,
        externalOrderId,
        brokerStatusRaw,
        localStatus,
        observedAt
      });
      continue;
    }

    // ---- 2. Orphan (no lifecycle row yet, by external_order_id) --------
    const correlation = findOrphanCorrelationCandidate(db, {
      symbol,
      side,
      quantity,
      orderSubmittedAtMs: submittedAtMs,
      windowMs: orphanCorrelationWindowMs,
      nowMs,
      submittingGraceMs,
      ownerId: accountOwnerId,
      proposals,
      allowUnattributedLegacyRows
    });

    if (correlation?.kind === "adopt") {
      const candidate = correlation.row;
      const ownerId = resolveLifecycleOwnerId(proposals, candidate, accountOwnerId);
      claimOrphanLifecycleRow(db, candidate.id, { externalOrderId, brokerStatus: brokerStatusRaw, localStatus, stage, observedAt, raw, notes, ownerId });
      audit.write("reconcile", "orphan_broker_order_adopted", {
        externalOrderId,
        ticketId: candidate.ticket_id,
        ownerId,
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

      // FIX 1: an adopted order that ACTUALLY reached the broker and is
      // filled/live must not leave its linked proposal stuck at 'failed' -
      // broker-executor's own submit_unconfirmed handler already called
      // markFailed on the very proposal this ticket_id derives from, on the
      // (incorrect, in this scenario) assumption the order never got
      // through. Reconcile is the ONLY place that later learns the truth.
      reconcileStuckFailedProposal(db, proposals, reports, audit, {
        ticketId: candidate.ticket_id,
        stage,
        symbol,
        side,
        quantity,
        limitPrice,
        externalOrderId,
        brokerStatusRaw,
        localStatus,
        observedAt
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
      // the account-scoped external-order UNIQUE constraint. Correct move: do nothing to
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
      notes,
      ownerId: accountOwnerId
    });
    audit.write("reconcile", "orphan_broker_order", {
      externalOrderId,
      symbol,
      side,
      quantity,
      ownerId: accountOwnerId,
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
  const timedOut = [];
  const stillUnconfirmed = listUnconfirmedRows(
    db,
    proposals,
    accountOwnerId,
    symbolFilters,
    allowUnattributedLegacyRows
  );

  for (const row of stillUnconfirmed) {
    const submittedAtMs = new Date(String(row.submitted_at)).getTime();
    if (!Number.isFinite(submittedAtMs) || nowMs - submittedAtMs < submitUnconfirmedTimeoutMs) {
      continue;
    }

    // A cross-session timeout requires a successfully retrieved history
    // window that starts before the unresolved submission. Without that
    // evidence the lease stays conservatively unresolved and counted in risk.
    if (tradingDateKey(submittedAtMs) !== tradingDateKey(nowMs)
      && !historyCoveredRowIds.has(row.id)) {
      audit.write("reconcile", "unconfirmed_cross_day_deferred", {
        ticketId: row.ticket_id,
        symbol: row.symbol,
        lifecycleStage: row.lifecycle_stage,
        submittedAt: row.submitted_at
      });
      continue;
    }

    const evidenceLabel = tradingDateKey(submittedAtMs) === tradingDateKey(nowMs)
      ? "同一交易日订单列表"
      : "覆盖提交时点的历史订单窗口";
    const reason = `对账超时：券商${evidenceLabel}中未观察到该工单（提交于 ${row.submitted_at}），已超过 ${Math.round(submitUnconfirmedTimeoutMs / 60000)} 分钟裁决窗口，判定为提交失败。`;
    const proposalId = proposalIdFromTicketId(row.ticket_id);
    db.exec("BEGIN IMMEDIATE;");
    try {
      const update = db.prepare(`
        UPDATE official_paper_order_lifecycle
        SET lifecycle_stage = 'failed', local_status = 'rejected', last_observed_at = ?, notes = ?
        WHERE id = ? AND lifecycle_stage IN ('submit_unconfirmed', 'submitting') AND external_order_id IS NULL
      `).run(observedAt, JSON.stringify([reason]), row.id);
      if (Number(update.changes) !== 1) {
        throw new Error(`Lifecycle row ${row.id} changed during timeout adjudication; refusing partial commit.`);
      }

      audit.write("reconcile", "submit_unconfirmed_timeout_failed", {
        ticketId: row.ticket_id,
        symbol: row.symbol,
        side: row.side,
        quantity: row.quantity,
        submittedAt: row.submitted_at
      });

      if (proposalId) {
        proposals.markFailed(proposalId, reason);
      }
      db.exec("COMMIT;");
    } catch (error) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // Preserve the first persistence failure; the unresolved lifecycle
        // row remains the replay lease whenever rollback succeeds.
      }
      throw error;
    }

    timedOut.push({ ticketId: row.ticket_id ?? null, symbol: row.symbol, proposalId });
  }

  return { observedAt, matched, adopted, deferredInFlight, orphaned, timedOut };
}

// FIX 1: transitions a proposal OFF 'failed' -> 'executed' (linking
// ticket_id) and writes a single 'trade' execution_reports row, mirroring
// broker-executor server.ts's own success path (title `${symbol} 执行报告`,
// category 'trade') - but ONLY when:
//   (a) the adopted lifecycle row's ticket_id resolves to a real proposal
//       (the `ticket_prop_<proposalId>` shape - see deriveTicketId's mirror
//       proposalIdFromTicketId above), AND
//   (b) that proposal is currently 'failed' (idempotent: a second reconcile
//       pass over the same already-adopted order finds status 'executed'
//       already and is a no-op here - no second report), AND
//   (c) a broker order with an external id was actually observed. The exact
//       lifecycle stage changes the report wording and risk treatment, but
//       never whether the constitution-required execution-attempt report
//       exists (including rejected/cancelled/cancel-in-flight/unknown).
// Called from BOTH the adopt branch (order correlated to a
// submit_unconfirmed / timeout-failed row this pass) and the matched branch
// (order already known by external_order_id whose freshly observed stage is
// what finally proves it live/filled - FIX 1a).
//
// The three repository parameters are annotated (G3, 2026-07-28) because a
// plain .mjs parameter is `any`, and `reports.save({...})` below is the exact
// call that shipped without an ownerId (73177f0). With the annotation,
// check-repository-writes.mjs can see the declared payload type and fail the
// build if a required field goes missing again; without it the write is
// invisible to every static check in this repo.
/**
 * @param {unknown} db
 * @param {import("../../../packages/shared-types/dist/index.js").ProposalRepository} proposals
 * @param {import("../../../packages/shared-types/dist/index.js").ExecutionReportRepository} reports
 * @param {import("../../../packages/shared-types/dist/index.js").AuditLogRepository} audit
 * @param {Record<string, any>} input
 */
function reconcileStuckFailedProposal(db, proposals, reports, audit, input) {
  const { ticketId, stage, symbol, side, quantity, limitPrice, externalOrderId, brokerStatusRaw, localStatus, observedAt } = input;

  const proposalId = proposalIdFromTicketId(ticketId);
  if (!proposalId) {
    return;
  }

  let proposal;
  try {
    proposal = proposals.getById(proposalId);
  } catch (error) {
    audit.write("reconcile", "adopted_failed_proposal_lookup_error", {
      proposalId,
      ticketId,
      error: String(error?.message ?? error)
    });
    return;
  }

  if (!proposal) {
    return;
  }
  const repairableStatuses = new Set(["approved", "approved_half", "failed", "executed"]);
  if (!repairableStatuses.has(proposal.status)) {
    // Broker truth is not authority to consume a pending/rejected/expired
    // human decision. Only an already-approved execution, the known
    // submit_unconfirmed failure state, or an executed row missing its report
    // can be completed here.
    return;
  }

  const deterministicReportId = `report_reconcile_${proposalId}`;
  const existingReport = db.prepare(`
    SELECT id, created_at,
      json_extract(metadata, '$.lifecycleStage') AS lifecycle_stage,
      json_extract(metadata, '$.brokerStatus') AS broker_status
    FROM execution_reports
    WHERE category = 'trade' AND owner_id = ?
      AND (
        id = ?
        OR json_extract(metadata, '$.ticketId') = ?
        OR json_extract(metadata, '$.proposalId') = ?
      )
    ORDER BY created_at ASC
    LIMIT 1
  `).get(proposal.ownerId, deterministicReportId, ticketId, proposalId);
  const reportId = existingReport?.id ?? deterministicReportId;
  const reportNeedsRefresh = !existingReport
    || existingReport.lifecycle_stage !== stage
    || existingReport.broker_status !== brokerStatusRaw;
  if (proposal.status === "executed" && proposal.ticketId === ticketId && !reportNeedsRefresh) {
    return;
  }

  const notionalUsd = typeof limitPrice === "number" ? limitPrice * quantity : undefined;
  // F5 (2026-07-28 round 3): the price was received, used for notionalUsd, and
  // then thrown away - neither the body nor the metadata carried it, so
  // scheduled-report.mjs's extractExecutionFacts found no price and a
  // reconciled fill rendered as 「方向 卖出；数量 10。」 next to a broker-executor
  // fill that showed its own. It is carried through now, labelled 限价 and
  // stored under `limitPrice`, because that is what it IS: `order.price` off
  // the broker's day-order list is the LIMIT the order was placed at, not the
  // price it filled at. extractExecutionFacts keys 「成交价」 off `fillPrice`
  // and 「限价」 off `limitPrice`, so a limit price can never be shown to the
  // owner as if the trade had executed there. This file does not compute a
  // fill price at all and must not invent one.
  const hasLimitPrice = typeof limitPrice === "number" && Number.isFinite(limitPrice);
  // FIX 2: only a 'filled' stage may claim 成交 - a merely-live order
  // (submitted/pending) is alive at the broker but NOT filled yet, and the
  // report must say so instead of hard-coding a fill claim.
  const statusLine = stage === "filled"
    ? "状态：对账已确认成交（此前误判为提交未确认）"
    : stage === "cancelled"
      ? "状态：对账确认券商已取消订单（执行尝试已完成）"
      : stage === "rejected"
        ? "状态：对账确认券商已拒绝/过期订单（执行尝试已完成）"
        : stage === "unknown_broker_status"
          ? "状态：对账已找到券商订单，但状态值尚未识别（成交状态未知，继续占用风险预算）"
          : "状态：对账确认订单已提交并在券商侧存活（尚未观察到成交）";
  db.exec("BEGIN IMMEDIATE;");
  try {
    if (reportNeedsRefresh) {
      reports.save({
        id: reportId,
        category: "trade",
        // The proposal is the server-side owner of record. Never infer the
        // report recipient from the broker payload or ambient account.
        ownerId: proposal.ownerId,
        title: `${symbol} 执行报告`,
        body: [
          `工单：${ticketId}`,
          statusLine,
          "执行方：长桥官方模拟盘",
          `外部订单号：${externalOrderId}`,
          `券商状态：${brokerStatusRaw}`,
          `生命周期阶段：${stage}`,
          ...(hasLimitPrice ? [`限价：${limitPrice.toFixed(2)}`] : []),
          "",
          "原因：",
          "- reconcile 在券商订单或历史订单列表中发现该工单，本地提交回调或后续持久化此前未完整收口。",
          proposal.status === "failed"
            ? "- 已将提案状态由 failed 更正为 executed，并补记一条幂等交易执行报告。"
            : "- 已将提案状态收口为 executed，并补记一条幂等交易执行报告。"
        ].join("\n"),
        metadata: {
          ticketId,
          proposalId,
          environment: "paper",
          assetClass: "stock",
          symbol,
          side,
          quantity,
          ...(hasLimitPrice ? { limitPrice } : {}),
          ...(notionalUsd !== undefined ? { notionalUsd } : {}),
          externalOrderId,
          brokerStatus: brokerStatusRaw,
          localStatus,
          lifecycleStage: stage,
          source: "reconcile-official-paper-orders",
          note: "对账补记（adopt 或 matched 分支）：券商已确认订单，现原子收口提案状态与执行报告。"
        },
        // Refresh the same report in place as broker truth becomes more
        // specific (unknown/pending -> filled/cancelled/etc.). Keep the
        // original report timestamp and id so this remains exactly one
        // constitutional per-trade report, never a misleading stale one.
        createdAt: existingReport?.created_at ?? observedAt
      });
    }

    proposals.markExecuted(proposalId, ticketId);
    audit.write("reconcile", "adopted_order_unstuck_failed_proposal", {
      proposalId,
      ticketId,
      externalOrderId,
      lifecycleStage: stage,
      reportId
    });
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Keep the original persistence failure. The lifecycle broker truth is
      // durable and the next reconcile pass will retry this idempotently.
    }
    throw error;
  }
}

function getLifecycleByExternalOrderId(db, externalOrderId, ownerId, proposals, allowUnattributedLegacyRows) {
  const scoped = db
    .prepare(`SELECT * FROM official_paper_order_lifecycle WHERE external_order_id = ? AND owner_id = ? LIMIT 1`)
    .get(externalOrderId, ownerId) ?? null;
  if (scoped) return scoped;
  if (!allowUnattributedLegacyRows) return null;
  // v20 preserves unattributed pre-account rows as NULL. A first account-
  // scoped observation may claim exactly that legacy row; all fresh writes
  // carry owner_id and never enter this fallback.
  const historical = db
    .prepare(`SELECT * FROM official_paper_order_lifecycle WHERE external_order_id = ? AND (owner_id IS NULL OR owner_id = '') LIMIT 1`)
    .get(externalOrderId) ?? null;
  return historical && lifecycleRowBelongsToAccount(proposals, historical, ownerId) ? historical : null;
}

/**
 * @param {import("../../../packages/shared-types/dist/index.js").ProposalRepository} proposals
 * @param {Record<string, unknown>} lifecycleRow
 * @param {string} accountOwnerId
 */
function lifecycleRowBelongsToAccount(proposals, lifecycleRow, accountOwnerId, allowUnattributedLegacyRows = true) {
  const existingOwnerId = String(lifecycleRow?.owner_id ?? "").trim();
  if (existingOwnerId) return existingOwnerId === accountOwnerId;
  if (!allowUnattributedLegacyRows) return false;

  // A truly unattributed historical/manual row can be claimed by the current
  // account. A proposal-shaped ticket is different: its proposal is the only
  // trustworthy account attribution, so a missing proposal must fail closed.
  const proposalId = proposalIdFromTicketId(lifecycleRow?.ticket_id);
  if (!proposalId) return true;
  const proposal = proposals.getById(proposalId);
  return proposal?.ownerId === accountOwnerId;
}

/**
 * @param {import("../../../packages/shared-types/dist/index.js").ProposalRepository} proposals
 * @param {Record<string, unknown>} lifecycleRow
 * @param {string} sharedAccountOwnerId
 */
function resolveLifecycleOwnerId(proposals, lifecycleRow, sharedAccountOwnerId) {
  const existingOwnerId = String(lifecycleRow?.owner_id ?? "").trim();
  if (existingOwnerId) return existingOwnerId;

  const proposalId = proposalIdFromTicketId(lifecycleRow?.ticket_id);
  if (proposalId) {
    try {
      const proposal = proposals.getById(proposalId);
      if (proposal?.ownerId) return proposal.ownerId;
    } catch {
      // Reconciliation still has the explicit shared-account attribution
      // below; a stale/broken proposal lookup cannot stop broker truth from
      // being recorded.
    }
  }
  return sharedAccountOwnerId;
}

// Finding #2 fix: this UPDATE never mentions ticket_id - a row matched by
// external_order_id can NEVER have its ticket_id changed by a routine status
// refresh, structurally, not via a COALESCE direction that could later be
// flipped back by accident.
function updateMatchedLifecycleRow(db, rowId, { brokerStatus, localStatus, stage, observedAt, raw, notes, ownerId }) {
  db.prepare(`
    UPDATE official_paper_order_lifecycle
    SET broker_status = ?, local_status = ?, lifecycle_stage = ?,
        last_observed_at = CASE
          WHEN lifecycle_stage = 'filled' AND ? = 'filled' THEN last_observed_at
          ELSE ?
        END,
        raw = ?, notes = ?,
        owner_id = COALESCE(NULLIF(owner_id, ''), ?)
    WHERE id = ?
  `).run(brokerStatus, localStatus, stage, stage, observedAt, JSON.stringify(raw), JSON.stringify(notes), ownerId, rowId);
}

// Adoption: fills in external_order_id (guaranteed NULL on a
// submit_unconfirmed row by construction - neither insertSubmitting nor
// markSubmitUnconfirmed in packages/shared-types/src/database.ts ever sets
// it) and the freshly observed status/stage. ticket_id is NEVER part of this
// SET clause - the row's own pre-existing ticket_id (the whole reason it was
// adoptable) passes through completely untouched, it is only ever READ back
// out by the caller for the adopted-event payload.
function claimOrphanLifecycleRow(db, rowId, { externalOrderId, brokerStatus, localStatus, stage, observedAt, raw, notes, ownerId }) {
  const result = db.prepare(`
    UPDATE official_paper_order_lifecycle
    SET external_order_id = ?, broker_status = ?, local_status = ?, lifecycle_stage = ?, last_observed_at = ?, raw = ?, notes = ?,
        owner_id = COALESCE(NULLIF(owner_id, ''), ?)
    WHERE id = ? AND external_order_id IS NULL
  `).run(externalOrderId, brokerStatus, localStatus, stage, observedAt, JSON.stringify(raw), JSON.stringify(notes), ownerId, rowId);

  if (Number(result.changes) !== 1) {
    throw new Error(`Failed to claim lifecycle row ${rowId} for external order ${externalOrderId} (already claimed or missing).`);
  }
}

// Brand-new row for a broker order nothing in the lifecycle table can be
// correlated to - ticket_id is NULL, permanently (nothing here ever guesses
// one). Idempotent across reruns via the account-scoped conflict key: a
// second reconcile pass over the SAME broker order finds it already exists
// (by external_order_id) via getLifecycleByExternalOrderId ABOVE and takes
// the "matched" branch instead, so in practice this ON CONFLICT branch is a
// defensive no-op - kept anyway as a second layer of the same finding-#2
// protection (it, too, never touches ticket_id).
function insertOrphanLifecycleRow(db, { externalOrderId, symbol, side, quantity, limitPrice, brokerStatus, localStatus, stage, submittedAt, observedAt, raw, notes, ownerId }) {
  db.prepare(`
    INSERT INTO official_paper_order_lifecycle
    (id, ticket_id, external_order_id, provider, environment, account_mode, symbol, asset_class,
     side, quantity, limit_price, broker_status, local_status, lifecycle_stage, submitted_at,
     last_observed_at, raw, notes, owner_id)
    VALUES (?, NULL, ?, 'longbridge-paper', 'paper', 'paper', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_id, external_order_id) DO UPDATE SET
      broker_status = excluded.broker_status,
      local_status = excluded.local_status,
      lifecycle_stage = excluded.lifecycle_stage,
      last_observed_at = excluded.last_observed_at,
      raw = excluded.raw,
      notes = excluded.notes,
      owner_id = COALESCE(NULLIF(official_paper_order_lifecycle.owner_id, ''), excluded.owner_id)
  `).run(
    `lb_order_${ownerId}_${externalOrderId}`,
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
    JSON.stringify(notes),
    ownerId
  );
}

// Orphan correlation: candidates are lifecycle rows with no external_order_id
// yet, matching symbol+side+quantity, in one of the three stages a
// not-yet-externally-confirmed row can be in:
//   - 'submit_unconfirmed' (adoptable: the CLI call already errored/timed
//     out, so this row is genuinely waiting for reconcile to resolve it one
//     way or the other);
//   - 'failed' + local_status 'rejected' (adoptable - FIX 1b): EXACTLY the
//     pair the submit_unconfirmed timeout adjudication above writes, and per
//     domain.ts's OfficialPaperOrderLifecycleStage doc the 'failed' stage is
//     only ever written by that adjudication (broker refusals are 'rejected',
//     a different stage). A broker order first observed in the day list
//     AFTER the 30-minute timeout already flipped its row to 'failed' must
//     still correlate here - otherwise it becomes a permanent ticketless
//     orphan sitting next to a row that is its own ticket. The local_status
//     check is defense in depth so any future 'failed' writer with different
//     semantics does not silently become adoptable;
//   - 'submitting' (NOT adoptable - broker-executor's own request for it is
//     still in flight; see the "defer" branch's own comment above for why
//     adopting here would race broker-executor's callback).
// Closest submitted_at within the window wins (the timeout adjudication
// never touches submitted_at, so the same time-window rule applies unchanged
// to timeout-failed rows); 'submit_unconfirmed' candidates are preferred
// over timeout-'failed' ones (still-open adjudication beats correcting a
// closed one), and both are preferred over 'submitting' since adoption is
// the more actionable outcome.
function findOrphanCorrelationCandidate(db, {
  symbol,
  side,
  quantity,
  orderSubmittedAtMs,
  windowMs,
  nowMs,
  submittingGraceMs,
  ownerId,
  proposals,
  allowUnattributedLegacyRows
}) {
  const rows = db.prepare(`
    SELECT * FROM official_paper_order_lifecycle
    WHERE symbol = ? AND side = ? AND quantity = ?
      AND (owner_id = ? OR owner_id IS NULL OR owner_id = '')
      AND external_order_id IS NULL
      AND (
        lifecycle_stage IN ('submit_unconfirmed', 'submitting')
        OR (lifecycle_stage = 'failed' AND local_status = 'rejected')
      )
  `).all(symbol, side, quantity, ownerId)
    .filter((row) => lifecycleRowBelongsToAccount(
      proposals,
      row,
      ownerId,
      allowUnattributedLegacyRows
    ));

  const withinWindow = rows
    .map((row) => ({
      row,
      ownerRank: String(row.owner_id ?? "").trim() === ownerId ? 0 : 1,
      deltaMs: Math.abs(new Date(String(row.submitted_at)).getTime() - orderSubmittedAtMs)
    }))
    .filter(({ deltaMs }) => Number.isFinite(deltaMs) && deltaMs <= windowMs)
    .sort((a, b) => a.ownerRank - b.ownerRank || a.deltaMs - b.deltaMs);

  // Account attribution outranks lifecycle-stage preference. Once an exact
  // owner row exists, a historical NULL/blank row must not be adopted merely
  // because submit_unconfirmed is normally more actionable than failed or
  // submitting. Mixing the two ranks can claim the legacy row while the
  // executor is still finalizing the exact row, causing state divergence and
  // an account-scoped external-order uniqueness collision.
  const bestOwnerRank = withinWindow[0]?.ownerRank;
  const accountCandidates = bestOwnerRank === undefined
    ? []
    : withinWindow.filter(({ ownerRank }) => ownerRank === bestOwnerRank);

  const adoptable = accountCandidates.find(({ row }) => row.lifecycle_stage === "submit_unconfirmed")
    ?? accountCandidates.find(({ row }) => row.lifecycle_stage === "failed");
  if (adoptable) {
    return { kind: "adopt", row: adoptable.row };
  }

  const inFlight = accountCandidates.find(({ row }) => row.lifecycle_stage === "submitting");
  if (inFlight) {
    const submittedAtMs = new Date(String(inFlight.row.submitted_at)).getTime();
    if (Number.isFinite(submittedAtMs) && nowMs - submittedAtMs >= submittingGraceMs) {
      // The executor is synchronous after it records `submitting`; a row that
      // remains there beyond the grace period is a crashed/lost callback, not
      // an active race. Broker truth may safely claim that exact row, after
      // which the normal proposal/report repair path completes local state.
      return { kind: "adopt", row: inFlight.row };
    }
    return { kind: "defer", row: inFlight.row };
  }

  return null;
}

function listUnconfirmedRows(db, proposals, accountOwnerId, symbolFilters, allowUnattributedLegacyRows) {
  return db.prepare(`
    SELECT * FROM official_paper_order_lifecycle
    WHERE lifecycle_stage IN ('submit_unconfirmed', 'submitting') AND external_order_id IS NULL
      AND (owner_id = ? OR owner_id IS NULL OR owner_id = '')
  `).all(accountOwnerId)
    .filter((row) => lifecycleRowBelongsToAccount(
      proposals,
      row,
      accountOwnerId,
      allowUnattributedLegacyRows
    ))
    // A symbol-scoped pass has no evidence about rows outside its scope.
    .filter((row) => symbolFilters.size === 0 || symbolFilters.has(String(row.symbol ?? "").toUpperCase()));
}

function brokerExternalOrderId(row) {
  return String(row?.order_id ?? row?.orderId ?? row?.id ?? "").trim();
}

function dedupeBrokerRows(rows, executions = false) {
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    const orderId = brokerExternalOrderId(row);
    const key = executions
      ? String(row?.trade_id ?? row?.tradeId ?? `${orderId}|${row?.trade_done_at ?? row?.tradeDoneAt ?? ""}|${row?.quantity ?? ""}|${row?.price ?? ""}`)
      : orderId;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }
  return result;
}

function historicalOrderMatchesUnconfirmedRow(order, rows, windowMs) {
  const orderSubmittedAtMs = new Date(String(order.created_at ?? order.createdAt ?? "")).getTime();
  if (!Number.isFinite(orderSubmittedAtMs)) return false;
  const symbol = String(order.symbol ?? "").toUpperCase();
  const side = normalizeSide(order.side);
  const quantity = toNumber(order.quantity);
  return rows.some((row) => {
    const rowSubmittedAtMs = new Date(String(row.submitted_at)).getTime();
    return String(row.symbol ?? "").toUpperCase() === symbol
      && normalizeSide(row.side) === side
      && toNumber(row.quantity) === quantity
      && Number.isFinite(rowSubmittedAtMs)
      && Math.abs(orderSubmittedAtMs - rowSubmittedAtMs) <= windowMs;
  });
}

function tradingDateKey(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "invalid";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const part = (type) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function requireBrokerArrayPayload(value, expectedKey) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === "object" && Array.isArray(value[expectedKey])) {
    return value[expectedKey];
  }
  throw new Error(`Longbridge ${expectedKey} payload is invalid; refusing fail-open reconciliation.`);
}

function validateBrokerOrders(orders) {
  for (const [index, order] of orders.entries()) {
    const objectLike = order && typeof order === "object" && !Array.isArray(order);
    const externalOrderId = objectLike ? String(order.order_id ?? order.orderId ?? order.id ?? "").trim() : "";
    const symbol = objectLike ? String(order.symbol ?? "").trim() : "";
    const side = objectLike ? String(order.side ?? "").trim().toLowerCase() : "";
    const quantity = objectLike ? Number(order.quantity) : Number.NaN;
    const status = objectLike ? String(order.status ?? "").trim() : "";
    const createdAtMs = objectLike ? new Date(String(order.created_at ?? order.createdAt ?? "")).getTime() : Number.NaN;
    if (!objectLike || !externalOrderId || !symbol || !["buy", "sell"].includes(side)
      || !Number.isFinite(quantity) || quantity <= 0 || !status || !Number.isFinite(createdAtMs)) {
      throw new Error(`Longbridge orders payload element ${index} is invalid; refusing timeout adjudication.`);
    }
  }
  return orders;
}

function validateBrokerExecutions(executions) {
  for (const [index, execution] of executions.entries()) {
    const objectLike = execution && typeof execution === "object" && !Array.isArray(execution);
    const externalOrderId = objectLike ? String(execution.order_id ?? execution.orderId ?? "").trim() : "";
    if (!objectLike || !externalOrderId) {
      throw new Error(`Longbridge executions payload element ${index} is invalid; refusing reconciliation.`);
    }
  }
  return executions;
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
