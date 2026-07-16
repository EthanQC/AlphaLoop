// Phase 6 Task 5 (2026-07-15 plan): replay tests for the rewritten
// reconcile-official-paper-orders.mjs - the delivery-gate component this
// task's completion is judged on. Every scenario is a scripted, deterministic
// sequence against a disposable temp db (mkdtempSync) with fixture broker
// order/execution payloads injected via reconcileOfficialPaperOrders'
// dependency-injected fetchOrders/fetchExecutions/now - no real broker CLI,
// no wall clock.
//
// Covers, one describe block per scenario named in the task brief:
//   - normal fill / partial fill / cancel-in-progress (WaitToCancel maps to
//     'pending', never 'unknown' - finding #5)
//   - reconcile-before-executor-callback (a 'submitting' row must be left
//     alone, never adopted/duplicated - see reconcile's own "defer" comment)
//   - orphan adoption via submit_unconfirmed correlation (ticket_id carried
//     over, never invented)
//   - orphan with no correlation match -> ticket_id NULL + audit warning
//   - submit_unconfirmed -> failed on timeout (+ proposals.markFailed if
//     linked), and the NOT-yet-timed-out case left alone
//   - idempotent reconcile (rerun -> row count / ticket_ids / zero
//     execution_reports all unchanged - finding #6)
//   - the finding #2 regression: an existing non-null ticket_id is never
//     overwritten by a later same-symbol broker order
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { ExecutionReportRepository, MemberRepository, openTradingDatabase, ProposalRepository } from "../../../packages/shared-types/dist/index.js";

const reconcileModule = await import("./reconcile-official-paper-orders.mjs");
const { reconcileOfficialPaperOrders, DEFAULT_ORPHAN_CORRELATION_WINDOW_MS, DEFAULT_SUBMIT_UNCONFIRMED_TIMEOUT_MS } = reconcileModule;

const tempDirs: string[] = [];

function makeDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-reconcile-"));
  tempDirs.push(dir);
  return openTradingDatabase(join(dir, "trading.sqlite"));
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function seedMember(db: DatabaseSync, id: string): void {
  new MemberRepository(db).upsert({
    id,
    email: `${id}@example.com`,
    displayName: id,
    riskTags: [],
    stockTags: [],
    showPerformance: true,
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z"
  });
}

function seedProposal(db: DatabaseSync, overrides: Partial<{ ownerId: string; symbol: string; side: "buy" | "sell"; quantity: number; limitPrice: number }> = {}) {
  return new ProposalRepository(db).create({
    ownerId: overrides.ownerId ?? "member_1",
    symbol: overrides.symbol ?? "AAPL.US",
    side: overrides.side ?? "buy",
    quantity: overrides.quantity ?? 10,
    orderType: "limit",
    limitPrice: overrides.limitPrice ?? 100,
    reason: "test proposal",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  });
}

interface LifecycleRowOverrides {
  id?: string;
  ticketId?: string | null;
  externalOrderId?: string | null;
  symbol?: string;
  side?: "buy" | "sell";
  quantity?: number;
  limitPrice?: number | null;
  brokerStatus?: string;
  localStatus?: string;
  lifecycleStage?: string;
  submittedAt?: string;
  lastObservedAt?: string;
}

function insertLifecycleRow(db: DatabaseSync, overrides: LifecycleRowOverrides = {}): string {
  const id = overrides.id ?? `row_${Math.random().toString(36).slice(2)}`;
  const submittedAt = overrides.submittedAt ?? "2026-07-15T14:00:00.000Z";
  db.prepare(`
    INSERT INTO official_paper_order_lifecycle
    (id, ticket_id, external_order_id, provider, environment, account_mode, symbol, asset_class,
     side, quantity, limit_price, broker_status, local_status, lifecycle_stage, submitted_at,
     last_observed_at, raw, notes)
    VALUES (?, ?, ?, 'longbridge-paper', 'paper', 'paper', ?, 'stock', ?, ?, ?, ?, ?, ?, ?, ?, 'null', '[]')
  `).run(
    id,
    overrides.ticketId ?? null,
    overrides.externalOrderId ?? null,
    overrides.symbol ?? "AAPL.US",
    overrides.side ?? "buy",
    overrides.quantity ?? 10,
    overrides.limitPrice ?? null,
    overrides.brokerStatus ?? "pending_submission",
    overrides.localStatus ?? "pending",
    overrides.lifecycleStage ?? "submitting",
    submittedAt,
    overrides.lastObservedAt ?? submittedAt
  );
  return id;
}

function getRow(db: DatabaseSync, id: string): Record<string, unknown> {
  const row = db.prepare(`SELECT * FROM official_paper_order_lifecycle WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error(`Expected lifecycle row ${id} to exist.`);
  }
  return row;
}

function getRowByExternalOrderId(db: DatabaseSync, externalOrderId: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM official_paper_order_lifecycle WHERE external_order_id = ?`).get(externalOrderId) as Record<string, unknown> | undefined;
}

function allRows(db: DatabaseSync): Array<Record<string, unknown>> {
  return db.prepare(`SELECT * FROM official_paper_order_lifecycle ORDER BY id`).all() as Array<Record<string, unknown>>;
}

function auditActions(db: DatabaseSync): string[] {
  const rows = db.prepare(`SELECT action FROM audit_log ORDER BY created_at`).all() as Array<{ action: string }>;
  return rows.map((row) => row.action);
}

function executionReportsCount(db: DatabaseSync): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM execution_reports`).get() as { c: number };
  return Number(row.c);
}

function brokerOrder(overrides: Partial<{ order_id: string; symbol: string; side: string; quantity: number; price: number; status: string; created_at: string }> = {}) {
  return {
    order_id: overrides.order_id ?? "EXT_DEFAULT",
    symbol: overrides.symbol ?? "AAPL.US",
    side: overrides.side ?? "Buy",
    quantity: overrides.quantity ?? 10,
    price: overrides.price ?? 100,
    status: overrides.status ?? "New",
    created_at: overrides.created_at ?? "2026-07-15T14:00:00.000Z"
  };
}

async function runReconcile(db: DatabaseSync, orders: unknown[], options: Record<string, unknown> = {}) {
  return reconcileOfficialPaperOrders(db, {
    fetchOrders: async () => orders,
    fetchExecutions: async () => [],
    now: () => new Date(options.nowIso as string ?? "2026-07-15T14:10:00.000Z"),
    ...options
  });
}

describe("normal fill / partial fill / cancel-in-progress", () => {
  it("normal fill: an already-matched row is refreshed to 'filled', ticket_id untouched", async () => {
    const db = makeDb();
    insertLifecycleRow(db, {
      id: "row_fill", ticketId: "ticket_prop_p1", externalOrderId: "EXT1",
      lifecycleStage: "submitted", brokerStatus: "New", localStatus: "submitted",
      submittedAt: "2026-07-15T14:00:00.000Z"
    });

    const result = await runReconcile(db, [brokerOrder({ order_id: "EXT1", status: "Filled" })]);

    const row = getRow(db, "row_fill");
    expect(row.lifecycle_stage).toBe("filled");
    expect(row.local_status).toBe("accepted");
    expect(row.ticket_id).toBe("ticket_prop_p1");
    expect(result.matched).toHaveLength(1);
  });

  it("partial fill: maps to 'pending', not 'accepted'", async () => {
    const db = makeDb();
    insertLifecycleRow(db, { id: "row_partial", ticketId: "ticket_prop_p2", externalOrderId: "EXT2", lifecycleStage: "submitted" });

    await runReconcile(db, [brokerOrder({ order_id: "EXT2", status: "PartialFilled" })]);

    const row = getRow(db, "row_partial");
    expect(row.lifecycle_stage).toBe("pending");
    expect(row.local_status).toBe("pending");
  });

  it("cancel-in-progress: WaitToCancel maps to 'pending', never 'unknown' (finding #5)", async () => {
    const db = makeDb();
    insertLifecycleRow(db, { id: "row_cancel", ticketId: "ticket_prop_p3", externalOrderId: "EXT3", lifecycleStage: "submitted" });

    await runReconcile(db, [brokerOrder({ order_id: "EXT3", status: "WaitToCancel" })]);

    const row = getRow(db, "row_cancel");
    expect(row.lifecycle_stage).toBe("pending");
    expect(row.lifecycle_stage).not.toBe("unknown");
    expect(row.lifecycle_stage).not.toBe("unknown_broker_status");
  });
});

describe("reconcile-before-executor-callback", () => {
  it("a 'submitting' row (executor's own callback has not run yet) is left completely untouched - deferred, not adopted or duplicated", async () => {
    const db = makeDb();
    insertLifecycleRow(db, {
      id: "row_inflight", ticketId: "ticket_prop_p4", externalOrderId: null,
      symbol: "MSFT.US", side: "buy", quantity: 5, lifecycleStage: "submitting",
      submittedAt: "2026-07-15T14:00:00.000Z"
    });

    const result = await runReconcile(db, [
      brokerOrder({ order_id: "EXT4", symbol: "MSFT.US", side: "Buy", quantity: 5, status: "New", created_at: "2026-07-15T14:00:05.000Z" })
    ]);

    expect(allRows(db)).toHaveLength(1);
    const row = getRow(db, "row_inflight");
    expect(row.lifecycle_stage).toBe("submitting");
    expect(row.external_order_id).toBeNull();
    expect(row.ticket_id).toBe("ticket_prop_p4");
    expect(result.deferredInFlight).toHaveLength(1);
    expect(result.orphaned).toHaveLength(0);
    expect(result.adopted).toHaveLength(0);

    // Now simulate broker-executor's own finalizeExecution callback finally
    // returning (keyed by ticket_id) - it must succeed with NO unique
    // constraint collision, because reconcile never created a competing row
    // for EXT4 above.
    expect(() => {
      db.prepare(`UPDATE official_paper_order_lifecycle SET external_order_id = ?, lifecycle_stage = 'submitted', local_status = 'submitted' WHERE ticket_id = ?`)
        .run("EXT4", "ticket_prop_p4");
    }).not.toThrow();

    // A later reconcile pass over the SAME broker order now matches by
    // external_order_id cleanly.
    const second = await runReconcile(db, [
      brokerOrder({ order_id: "EXT4", symbol: "MSFT.US", side: "Buy", quantity: 5, status: "Filled", created_at: "2026-07-15T14:00:05.000Z" })
    ]);
    expect(allRows(db)).toHaveLength(1);
    expect(second.matched).toHaveLength(1);
    expect(getRow(db, "row_inflight").lifecycle_stage).toBe("filled");
    expect(getRow(db, "row_inflight").ticket_id).toBe("ticket_prop_p4");
  });
});

describe("orphan adoption via submit_unconfirmed correlation", () => {
  it("adopts a submit_unconfirmed row within the correlation window, carrying its ticket_id", async () => {
    const db = makeDb();
    insertLifecycleRow(db, {
      id: "row_unconfirmed", ticketId: "ticket_prop_p5", externalOrderId: null,
      symbol: "TSLA.US", side: "sell", quantity: 3, lifecycleStage: "submit_unconfirmed",
      brokerStatus: "unconfirmed", localStatus: "pending",
      submittedAt: "2026-07-15T14:00:00.000Z"
    });

    const before = getRow(db, "row_unconfirmed");

    const result = await runReconcile(db, [
      brokerOrder({ order_id: "EXT5", symbol: "TSLA.US", side: "Sell", quantity: 3, status: "New", created_at: "2026-07-15T14:05:00.000Z" })
    ]);

    const after = getRow(db, "row_unconfirmed");

    expect(allRows(db)).toHaveLength(1);
    expect(after.external_order_id).toBe("EXT5");
    expect(after.ticket_id).toBe("ticket_prop_p5");
    expect(after.lifecycle_stage).toBe("submitted");
    expect(result.adopted).toEqual([{
      externalOrderId: "EXT5", ticketId: "ticket_prop_p5", symbol: "TSLA.US", side: "sell", quantity: 3,
      brokerStatus: "New", lifecycleStage: "submitted", localStatus: "submitted"
    }]);
    expect(auditActions(db)).toContain("orphan_broker_order_adopted");

    // eslint-disable-next-line no-console -- test-visible before/after paste for the live-check requirement
    console.log("ORPHAN ADOPTION before:", JSON.stringify(before), "\nORPHAN ADOPTION after:", JSON.stringify(after));
  });

  it("does not adopt a submit_unconfirmed row outside the correlation window", async () => {
    const db = makeDb();
    insertLifecycleRow(db, {
      id: "row_far", ticketId: "ticket_prop_p6", externalOrderId: null,
      symbol: "TSLA.US", side: "sell", quantity: 3, lifecycleStage: "submit_unconfirmed",
      submittedAt: "2026-07-15T14:00:00.000Z"
    });

    const farAwayMs = DEFAULT_ORPHAN_CORRELATION_WINDOW_MS + 60_000;
    const createdAt = new Date(new Date("2026-07-15T14:00:00.000Z").getTime() + farAwayMs).toISOString();

    await runReconcile(db, [
      brokerOrder({ order_id: "EXT6", symbol: "TSLA.US", side: "Sell", quantity: 3, status: "New", created_at: createdAt })
    ], { nowIso: createdAt });

    expect(allRows(db)).toHaveLength(2);
    expect(getRow(db, "row_far").external_order_id).toBeNull();
    expect(getRow(db, "row_far").ticket_id).toBe("ticket_prop_p6");
    const newRow = getRowByExternalOrderId(db, "EXT6");
    expect(newRow?.ticket_id).toBeNull();
  });
});

describe("orphan with no correlation match -> ticket_id NULL + audit", () => {
  it("inserts a new row with ticket_id NULL and logs an 'orphan_broker_order' audit warning", async () => {
    const db = makeDb();

    const result = await runReconcile(db, [
      brokerOrder({ order_id: "EXT7", symbol: "NVDA.US", side: "Buy", quantity: 2, status: "New" })
    ]);

    expect(allRows(db)).toHaveLength(1);
    const row = getRowByExternalOrderId(db, "EXT7");
    expect(row?.ticket_id).toBeNull();
    expect(row?.symbol).toBe("NVDA.US");
    expect(result.orphaned).toEqual([{
      externalOrderId: "EXT7", ticketId: null, symbol: "NVDA.US", side: "buy", quantity: 2,
      brokerStatus: "New", lifecycleStage: "submitted", localStatus: "submitted"
    }]);
    expect(auditActions(db)).toContain("orphan_broker_order");
  });
});

describe("submit_unconfirmed adjudication (both directions)", () => {
  it("transitions to 'failed' and calls proposals.markFailed once the timeout window elapses", async () => {
    const db = makeDb();
    seedMember(db, "member_1");
    const proposal = seedProposal(db, { symbol: "AMD.US", side: "buy", quantity: 4 });
    const ticketId = `ticket_prop_${proposal.id}`;
    const oldSubmittedAt = "2026-07-15T13:00:00.000Z"; // 70 minutes before "now" below
    insertLifecycleRow(db, {
      id: "row_timeout", ticketId, externalOrderId: null,
      symbol: "AMD.US", side: "buy", quantity: 4, lifecycleStage: "submit_unconfirmed",
      submittedAt: oldSubmittedAt
    });

    const result = await runReconcile(db, [], { nowIso: "2026-07-15T14:10:00.000Z" });

    const row = getRow(db, "row_timeout");
    expect(row.lifecycle_stage).toBe("failed");
    expect(row.local_status).toBe("rejected");
    expect(result.timedOut).toEqual([{ ticketId, symbol: "AMD.US", proposalId: proposal.id }]);

    const updatedProposal = new ProposalRepository(db).getById(proposal.id);
    expect(updatedProposal?.status).toBe("failed");
  });

  it("leaves a submit_unconfirmed row alone when it has not yet exceeded the timeout window", async () => {
    const db = makeDb();
    seedMember(db, "member_1");
    const proposal = seedProposal(db, { symbol: "AMD.US", side: "buy", quantity: 4 });
    const ticketId = `ticket_prop_${proposal.id}`;
    insertLifecycleRow(db, {
      id: "row_recent", ticketId, externalOrderId: null,
      symbol: "AMD.US", side: "buy", quantity: 4, lifecycleStage: "submit_unconfirmed",
      submittedAt: "2026-07-15T14:00:00.000Z"
    });

    const result = await runReconcile(db, [], { nowIso: "2026-07-15T14:05:00.000Z" });

    expect(getRow(db, "row_recent").lifecycle_stage).toBe("submit_unconfirmed");
    expect(result.timedOut).toHaveLength(0);
    expect(new ProposalRepository(db).getById(proposal.id)?.status).toBe("pending");
  });

  it("does not crash when a timed-out row's ticket_id has no derivable/linked proposal", async () => {
    const db = makeDb();
    insertLifecycleRow(db, {
      id: "row_unlinked", ticketId: "manual_1234567890", externalOrderId: null,
      symbol: "IBM.US", side: "buy", quantity: 1, lifecycleStage: "submit_unconfirmed",
      submittedAt: "2026-07-15T12:00:00.000Z"
    });

    const result = await runReconcile(db, [], { nowIso: "2026-07-15T14:10:00.000Z" });

    expect(getRow(db, "row_unlinked").lifecycle_stage).toBe("failed");
    expect(result.timedOut).toEqual([{ ticketId: "manual_1234567890", symbol: "IBM.US", proposalId: null }]);
  });
});

describe("idempotent reconcile (finding #6: no execution_reports, ever)", () => {
  it("running the same fixture twice leaves row count, ticket_ids, and execution_reports (0) unchanged", async () => {
    const db = makeDb();
    insertLifecycleRow(db, {
      id: "row_a", ticketId: "ticket_prop_a", externalOrderId: "EXT_A", lifecycleStage: "submitted",
      symbol: "AAPL.US", side: "buy", quantity: 10, submittedAt: "2026-07-15T14:00:00.000Z"
    });
    insertLifecycleRow(db, {
      id: "row_b", ticketId: "ticket_prop_b", externalOrderId: null, lifecycleStage: "submit_unconfirmed",
      symbol: "MSFT.US", side: "buy", quantity: 6, submittedAt: "2026-07-15T14:00:00.000Z"
    });
    const orders = [
      brokerOrder({ order_id: "EXT_A", symbol: "AAPL.US", side: "Buy", quantity: 10, status: "Filled" }),
      brokerOrder({ order_id: "EXT_B", symbol: "MSFT.US", side: "Buy", quantity: 6, status: "New", created_at: "2026-07-15T14:00:10.000Z" }),
      brokerOrder({ order_id: "EXT_C", symbol: "GOOG.US", side: "Buy", quantity: 1, status: "New" })
    ];

    const first = await runReconcile(db, orders);
    const rowsAfterFirst = allRows(db);
    const before = JSON.stringify(rowsAfterFirst.map((row) => ({ id: row.id, ticket_id: row.ticket_id, external_order_id: row.external_order_id, lifecycle_stage: row.lifecycle_stage })));

    const second = await runReconcile(db, orders);
    const rowsAfterSecond = allRows(db);
    const after = JSON.stringify(rowsAfterSecond.map((row) => ({ id: row.id, ticket_id: row.ticket_id, external_order_id: row.external_order_id, lifecycle_stage: row.lifecycle_stage })));

    expect(rowsAfterSecond).toHaveLength(rowsAfterFirst.length);
    expect(after).toBe(before);
    expect(executionReportsCount(db)).toBe(0);
    expect(first.adopted).toHaveLength(1);
    expect(second.adopted).toHaveLength(0); // already matched by external_order_id on the second pass
    expect(second.matched.length + second.orphaned.length).toBeGreaterThan(0);

    // eslint-disable-next-line no-console -- test-visible before/after paste for the live-check requirement
    console.log("IDEMPOTENT RERUN before:", before, "\nIDEMPOTENT RERUN after:", after);
  });
});

// FIX 1: an order that ACTUALLY reached the broker and filled must not leave
// its proposal stuck at 'failed' forever. Scenario: broker-executor's own CLI
// call threw/timed out (or returned no order_id) -> markFailed(proposal) +
// lifecycle 'submit_unconfirmed', but the order really did reach Longbridge.
// The next reconcile pass finds it in the broker's day-order list and adopts
// it (correlated by symbol+side+quantity+time) - the adopt branch must ALSO
// transition the linked proposal off 'failed' to 'executed' (only for a
// filled/live adopted stage, never for cancelled/rejected) and write a
// 'trade' execution_reports row mirroring broker-executor's own success path.
describe("FIX 1: adopting a filled broker order un-sticks its proposal from 'failed'", () => {
  it("transitions the linked proposal 'failed' -> 'executed', links ticket_id, and writes one trade execution report", async () => {
    const db = makeDb();
    seedMember(db, "member_1");
    const proposal = seedProposal(db, { symbol: "NVDA.US", side: "buy", quantity: 7, limitPrice: 120 });
    const ticketId = `ticket_prop_${proposal.id}`;
    new ProposalRepository(db).markFailed(proposal.id, "执行未确认（submit_unconfirmed）：模拟超时。");

    insertLifecycleRow(db, {
      id: "row_stuck_failed", ticketId, externalOrderId: null,
      symbol: "NVDA.US", side: "buy", quantity: 7, limitPrice: 120,
      lifecycleStage: "submit_unconfirmed", brokerStatus: "unconfirmed", localStatus: "pending",
      submittedAt: "2026-07-15T14:00:00.000Z"
    });

    const result = await runReconcile(db, [
      brokerOrder({ order_id: "EXT_FILLED", symbol: "NVDA.US", side: "Buy", quantity: 7, price: 120, status: "Filled", created_at: "2026-07-15T14:02:00.000Z" })
    ]);

    expect(result.adopted).toHaveLength(1);

    const lifecycleRow = getRow(db, "row_stuck_failed");
    expect(lifecycleRow.lifecycle_stage).toBe("filled");
    expect(lifecycleRow.external_order_id).toBe("EXT_FILLED");

    const updatedProposal = new ProposalRepository(db).getById(proposal.id);
    expect(updatedProposal?.status).toBe("executed");
    expect(updatedProposal?.ticketId).toBe(ticketId);

    const reports = new ExecutionReportRepository(db).listRecent(10, ["trade"]);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.metadata?.ticketId).toBe(ticketId);
    expect(reports[0]?.metadata?.proposalId).toBe(proposal.id);
  });

  it("does NOT transition the proposal when the adopted stage is cancelled/rejected", async () => {
    const db = makeDb();
    seedMember(db, "member_1");
    const proposal = seedProposal(db, { symbol: "AMD.US", side: "buy", quantity: 2, limitPrice: 90 });
    const ticketId = `ticket_prop_${proposal.id}`;
    new ProposalRepository(db).markFailed(proposal.id, "执行未确认（submit_unconfirmed）：模拟超时。");

    insertLifecycleRow(db, {
      id: "row_stuck_rejected", ticketId, externalOrderId: null,
      symbol: "AMD.US", side: "buy", quantity: 2, limitPrice: 90,
      lifecycleStage: "submit_unconfirmed", brokerStatus: "unconfirmed", localStatus: "pending",
      submittedAt: "2026-07-15T14:00:00.000Z"
    });

    await runReconcile(db, [
      brokerOrder({ order_id: "EXT_REJECTED", symbol: "AMD.US", side: "Buy", quantity: 2, price: 90, status: "Rejected", created_at: "2026-07-15T14:02:00.000Z" })
    ]);

    const updatedProposal = new ProposalRepository(db).getById(proposal.id);
    expect(updatedProposal?.status).toBe("failed");
    expect(new ExecutionReportRepository(db).listRecent(10, ["trade"])).toHaveLength(0);
  });

  it("is idempotent: a second reconcile pass over the same now-matched order does not write a second execution report", async () => {
    const db = makeDb();
    seedMember(db, "member_1");
    const proposal = seedProposal(db, { symbol: "MSFT.US", side: "buy", quantity: 3, limitPrice: 200 });
    const ticketId = `ticket_prop_${proposal.id}`;
    new ProposalRepository(db).markFailed(proposal.id, "执行未确认（submit_unconfirmed）：模拟超时。");

    insertLifecycleRow(db, {
      id: "row_stuck_msft", ticketId, externalOrderId: null,
      symbol: "MSFT.US", side: "buy", quantity: 3, limitPrice: 200,
      lifecycleStage: "submit_unconfirmed", brokerStatus: "unconfirmed", localStatus: "pending",
      submittedAt: "2026-07-15T14:00:00.000Z"
    });

    const orders = [
      brokerOrder({ order_id: "EXT_MSFT", symbol: "MSFT.US", side: "Buy", quantity: 3, price: 200, status: "Filled", created_at: "2026-07-15T14:02:00.000Z" })
    ];

    await runReconcile(db, orders);
    await runReconcile(db, orders, { nowIso: "2026-07-15T14:20:00.000Z" });

    const updatedProposal = new ProposalRepository(db).getById(proposal.id);
    expect(updatedProposal?.status).toBe("executed");
    expect(new ExecutionReportRepository(db).listRecent(10, ["trade"])).toHaveLength(1);
  });
});

// FIX 1a (matched-branch un-stick): an order adopted while the broker reports
// an UNMAPPED status lands at stage 'unknown_broker_status' - excluded from
// the live/filled un-stick set, so the adopt-branch un-stick correctly does
// nothing. But when a LATER pass sees the same order 'Filled', that pass goes
// through the matched-by-external_order_id branch - which must ALSO invoke
// the un-stick, or the proposal stays 'failed' forever for really-bought
// shares.
describe("FIX 1a: matched-branch un-stick after adoption at an unmapped broker status", () => {
  it("adopt at unknown status leaves proposal failed; next pass observing Filled un-sticks it to executed", async () => {
    const db = makeDb();
    seedMember(db, "member_1");
    const proposal = seedProposal(db, { symbol: "NVDA.US", side: "buy", quantity: 7, limitPrice: 120 });
    const ticketId = `ticket_prop_${proposal.id}`;
    new ProposalRepository(db).markFailed(proposal.id, "执行未确认（submit_unconfirmed）：模拟超时。");

    insertLifecycleRow(db, {
      id: "row_unmapped_then_filled", ticketId, externalOrderId: null,
      symbol: "NVDA.US", side: "buy", quantity: 7, limitPrice: 120,
      lifecycleStage: "submit_unconfirmed", brokerStatus: "unconfirmed", localStatus: "pending",
      submittedAt: "2026-07-15T14:00:00.000Z"
    });

    // Pass 1: broker reports a status this codebase's map does not know.
    const first = await runReconcile(db, [
      brokerOrder({ order_id: "EXT_UNMAPPED", symbol: "NVDA.US", side: "Buy", quantity: 7, price: 120, status: "SomeBrandNewBrokerStatus", created_at: "2026-07-15T14:02:00.000Z" })
    ]);
    expect(first.adopted).toHaveLength(1);
    expect(getRow(db, "row_unmapped_then_filled").lifecycle_stage).toBe("unknown_broker_status");
    expect(new ProposalRepository(db).getById(proposal.id)?.status).toBe("failed");
    expect(new ExecutionReportRepository(db).listRecent(10, ["trade"])).toHaveLength(0);

    // Pass 2: same order now reported Filled -> MATCHED branch must un-stick.
    const second = await runReconcile(db, [
      brokerOrder({ order_id: "EXT_UNMAPPED", symbol: "NVDA.US", side: "Buy", quantity: 7, price: 120, status: "Filled", created_at: "2026-07-15T14:02:00.000Z" })
    ], { nowIso: "2026-07-15T14:20:00.000Z" });
    expect(second.matched).toHaveLength(1);

    const updatedProposal = new ProposalRepository(db).getById(proposal.id);
    expect(updatedProposal?.status).toBe("executed");
    expect(updatedProposal?.ticketId).toBe(ticketId);
    expect(new ExecutionReportRepository(db).listRecent(10, ["trade"])).toHaveLength(1);
    expect(allRows(db)).toHaveLength(1);
  });

  it("matched-branch un-stick stays idempotent: a third pass over the same Filled order writes no second report", async () => {
    const db = makeDb();
    seedMember(db, "member_1");
    const proposal = seedProposal(db, { symbol: "AMD.US", side: "buy", quantity: 4, limitPrice: 90 });
    const ticketId = `ticket_prop_${proposal.id}`;
    new ProposalRepository(db).markFailed(proposal.id, "执行未确认（submit_unconfirmed）：模拟超时。");
    insertLifecycleRow(db, {
      id: "row_matched_idem", ticketId, externalOrderId: null,
      symbol: "AMD.US", side: "buy", quantity: 4, limitPrice: 90,
      lifecycleStage: "submit_unconfirmed", brokerStatus: "unconfirmed", localStatus: "pending",
      submittedAt: "2026-07-15T14:00:00.000Z"
    });

    await runReconcile(db, [
      brokerOrder({ order_id: "EXT_IDEM", symbol: "AMD.US", side: "Buy", quantity: 4, price: 90, status: "SomeBrandNewBrokerStatus", created_at: "2026-07-15T14:02:00.000Z" })
    ]);
    const filledOrder = [brokerOrder({ order_id: "EXT_IDEM", symbol: "AMD.US", side: "Buy", quantity: 4, price: 90, status: "Filled", created_at: "2026-07-15T14:02:00.000Z" })];
    await runReconcile(db, filledOrder, { nowIso: "2026-07-15T14:20:00.000Z" });
    await runReconcile(db, filledOrder, { nowIso: "2026-07-15T14:30:00.000Z" });

    expect(new ProposalRepository(db).getById(proposal.id)?.status).toBe("executed");
    expect(new ExecutionReportRepository(db).listRecent(10, ["trade"])).toHaveLength(1);
  });
});

// FIX 1b (post-timeout adoption): the 30-minute submit_unconfirmed timeout
// flips the lifecycle row to stage 'failed' + proposal markFailed. If the
// broker's day-order list only shows the order on a LATER pass, the orphan
// correlation must still find that timeout-failed row (same symbol/side/
// quantity/time-window rules) instead of inserting a permanent ticketless
// orphan next to it.
describe("FIX 1b: broker order first observed after the submit_unconfirmed timeout is adopted, not orphaned", () => {
  it("timeout flips row+proposal to failed; a later pass observing the Filled order adopts it and un-sticks the proposal", async () => {
    const db = makeDb();
    seedMember(db, "member_1");
    const proposal = seedProposal(db, { symbol: "TSLA.US", side: "sell", quantity: 3, limitPrice: 250 });
    const ticketId = `ticket_prop_${proposal.id}`;
    insertLifecycleRow(db, {
      id: "row_late_broker", ticketId, externalOrderId: null,
      symbol: "TSLA.US", side: "sell", quantity: 3, limitPrice: 250,
      lifecycleStage: "submit_unconfirmed", brokerStatus: "unconfirmed", localStatus: "pending",
      submittedAt: "2026-07-15T13:00:00.000Z"
    });

    // Pass 1 (14:10, no broker orders visible yet): timeout adjudication.
    const first = await runReconcile(db, [], { nowIso: "2026-07-15T14:10:00.000Z" });
    expect(first.timedOut).toHaveLength(1);
    expect(getRow(db, "row_late_broker").lifecycle_stage).toBe("failed");
    expect(new ProposalRepository(db).getById(proposal.id)?.status).toBe("failed");

    // Pass 2 (14:20): the broker's day list finally shows the order, created
    // back at 13:02 - within the correlation window of the row's submitted_at.
    const second = await runReconcile(db, [
      brokerOrder({ order_id: "EXT_LATE", symbol: "TSLA.US", side: "Sell", quantity: 3, price: 250, status: "Filled", created_at: "2026-07-15T13:02:00.000Z" })
    ], { nowIso: "2026-07-15T14:20:00.000Z" });

    expect(second.adopted).toHaveLength(1);
    expect(second.orphaned).toHaveLength(0);
    expect(allRows(db)).toHaveLength(1);

    const row = getRow(db, "row_late_broker");
    expect(row.external_order_id).toBe("EXT_LATE");
    expect(row.ticket_id).toBe(ticketId);
    expect(row.lifecycle_stage).toBe("filled");

    const updatedProposal = new ProposalRepository(db).getById(proposal.id);
    expect(updatedProposal?.status).toBe("executed");
    expect(updatedProposal?.ticketId).toBe(ticketId);
    expect(new ExecutionReportRepository(db).listRecent(10, ["trade"])).toHaveLength(1);
  });

  it("does not adopt a timeout-failed row outside the correlation window, and never touches a failed row that already has an external_order_id", async () => {
    const db = makeDb();
    insertLifecycleRow(db, {
      id: "row_failed_far", ticketId: "ticket_prop_far", externalOrderId: null,
      symbol: "IBM.US", side: "buy", quantity: 2,
      lifecycleStage: "failed", brokerStatus: "unconfirmed", localStatus: "rejected",
      submittedAt: "2026-07-15T09:00:00.000Z"
    });

    await runReconcile(db, [
      brokerOrder({ order_id: "EXT_FAR", symbol: "IBM.US", side: "Buy", quantity: 2, status: "Filled", created_at: "2026-07-15T14:00:00.000Z" })
    ], { nowIso: "2026-07-15T14:10:00.000Z" });

    // 5 hours apart: NOT adopted - the broker order becomes a normal orphan.
    expect(getRow(db, "row_failed_far").external_order_id).toBeNull();
    expect(getRow(db, "row_failed_far").lifecycle_stage).toBe("failed");
    expect(getRowByExternalOrderId(db, "EXT_FAR")?.ticket_id).toBeNull();
    expect(allRows(db)).toHaveLength(2);
  });
});

// FIX 2: WaitToCancel/PendingCancel map to stage 'pending' (a cancel REQUEST
// in flight - the order is still open, so 'pending' is the right lifecycle
// stage), but "a cancel is being requested" is NOT evidence the trade went
// through - the un-stick must not fire for those raw statuses. And when the
// un-stick DOES fire for a merely-live (submitted/pending) order, its report
// must not hard-code a 成交 (filled) claim.
describe("FIX 2: cancel-in-flight never un-sticks, and un-stick report wording reflects the actual stage", () => {
  it("adopting a WaitToCancel order does NOT un-stick the failed proposal (and writes no trade report)", async () => {
    const db = makeDb();
    seedMember(db, "member_1");
    const proposal = seedProposal(db, { symbol: "GOOG.US", side: "buy", quantity: 5, limitPrice: 150 });
    const ticketId = `ticket_prop_${proposal.id}`;
    new ProposalRepository(db).markFailed(proposal.id, "执行未确认（submit_unconfirmed）：模拟超时。");
    insertLifecycleRow(db, {
      id: "row_cancel_inflight", ticketId, externalOrderId: null,
      symbol: "GOOG.US", side: "buy", quantity: 5, limitPrice: 150,
      lifecycleStage: "submit_unconfirmed", brokerStatus: "unconfirmed", localStatus: "pending",
      submittedAt: "2026-07-15T14:00:00.000Z"
    });

    const result = await runReconcile(db, [
      brokerOrder({ order_id: "EXT_W2C", symbol: "GOOG.US", side: "Buy", quantity: 5, price: 150, status: "WaitToCancel", created_at: "2026-07-15T14:02:00.000Z" })
    ]);

    expect(result.adopted).toHaveLength(1);
    expect(getRow(db, "row_cancel_inflight").lifecycle_stage).toBe("pending");
    expect(new ProposalRepository(db).getById(proposal.id)?.status).toBe("failed");
    expect(new ExecutionReportRepository(db).listRecent(10, ["trade"])).toHaveLength(0);
  });

  it("a 'submitted'-stage un-stick report does not claim 成交; a 'filled'-stage one does", async () => {
    const db = makeDb();
    seedMember(db, "member_1");
    const proposal = seedProposal(db, { symbol: "AMZN.US", side: "buy", quantity: 6, limitPrice: 180 });
    const ticketId = `ticket_prop_${proposal.id}`;
    new ProposalRepository(db).markFailed(proposal.id, "执行未确认（submit_unconfirmed）：模拟超时。");
    insertLifecycleRow(db, {
      id: "row_submitted_unstick", ticketId, externalOrderId: null,
      symbol: "AMZN.US", side: "buy", quantity: 6, limitPrice: 180,
      lifecycleStage: "submit_unconfirmed", brokerStatus: "unconfirmed", localStatus: "pending",
      submittedAt: "2026-07-15T14:00:00.000Z"
    });

    await runReconcile(db, [
      brokerOrder({ order_id: "EXT_LIVE", symbol: "AMZN.US", side: "Buy", quantity: 6, price: 180, status: "New", created_at: "2026-07-15T14:02:00.000Z" })
    ]);

    expect(new ProposalRepository(db).getById(proposal.id)?.status).toBe("executed");
    const liveReports = new ExecutionReportRepository(db).listRecent(10, ["trade"]);
    expect(liveReports).toHaveLength(1);
    expect(liveReports[0]?.body).not.toContain("已确认成交");
    expect(liveReports[0]?.body).toContain("已提交");

    // Contrast: a genuinely filled un-stick still reports 成交.
    const db2 = makeDb();
    seedMember(db2, "member_1");
    const proposal2 = seedProposal(db2, { symbol: "AMZN.US", side: "buy", quantity: 6, limitPrice: 180 });
    const ticketId2 = `ticket_prop_${proposal2.id}`;
    new ProposalRepository(db2).markFailed(proposal2.id, "执行未确认（submit_unconfirmed）：模拟超时。");
    insertLifecycleRow(db2, {
      id: "row_filled_unstick", ticketId: ticketId2, externalOrderId: null,
      symbol: "AMZN.US", side: "buy", quantity: 6, limitPrice: 180,
      lifecycleStage: "submit_unconfirmed", brokerStatus: "unconfirmed", localStatus: "pending",
      submittedAt: "2026-07-15T14:00:00.000Z"
    });
    await runReconcile(db2, [
      brokerOrder({ order_id: "EXT_FILL2", symbol: "AMZN.US", side: "Buy", quantity: 6, price: 180, status: "Filled", created_at: "2026-07-15T14:02:00.000Z" })
    ]);
    const filledReports = new ExecutionReportRepository(db2).listRecent(10, ["trade"]);
    expect(filledReports).toHaveLength(1);
    expect(filledReports[0]?.body).toContain("已确认成交");
  });
});

describe("finding #2 regression: an existing non-null ticket_id is never overwritten", () => {
  it("a second same-symbol/side/quantity broker order never steals the first order's ticket_id", async () => {
    const db = makeDb();
    insertLifecycleRow(db, {
      id: "row_correct", ticketId: "ticket_prop_correct", externalOrderId: "EXT_OLD",
      symbol: "AAPL.US", side: "buy", quantity: 10, lifecycleStage: "filled", localStatus: "accepted",
      brokerStatus: "Filled", submittedAt: "2026-07-15T09:00:00.000Z"
    });

    await runReconcile(db, [
      brokerOrder({ order_id: "EXT_NEW", symbol: "AAPL.US", side: "Buy", quantity: 10, status: "New", created_at: "2026-07-15T14:00:00.000Z" })
    ]);

    const originalRow = getRow(db, "row_correct");
    expect(originalRow.ticket_id).toBe("ticket_prop_correct");
    expect(originalRow.external_order_id).toBe("EXT_OLD");
    expect(originalRow.lifecycle_stage).toBe("filled");

    const newRow = getRowByExternalOrderId(db, "EXT_NEW");
    expect(newRow?.ticket_id).toBeNull();
    expect(allRows(db)).toHaveLength(2);
  });
});
