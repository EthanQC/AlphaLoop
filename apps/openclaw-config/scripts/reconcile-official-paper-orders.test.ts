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

import { MemberRepository, openTradingDatabase, ProposalRepository } from "../../../packages/shared-types/dist/index.js";

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
