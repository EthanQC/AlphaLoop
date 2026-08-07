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

import {
  ExecutionReportRepository,
  MemberRepository,
  OfficialPaperOrderLifecycleRepository,
  openTradingDatabase,
  ProposalRepository
} from "../../../packages/shared-types/dist/index.js";

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
  ownerId?: string | null;
}

function insertLifecycleRow(db: DatabaseSync, overrides: LifecycleRowOverrides = {}): string {
  const id = overrides.id ?? `row_${Math.random().toString(36).slice(2)}`;
  const submittedAt = overrides.submittedAt ?? "2026-07-15T14:00:00.000Z";
  db.prepare(`
    INSERT INTO official_paper_order_lifecycle
    (id, ticket_id, external_order_id, provider, environment, account_mode, symbol, asset_class,
     side, quantity, limit_price, broker_status, local_status, lifecycle_stage, submitted_at,
     last_observed_at, raw, notes, owner_id)
    VALUES (?, ?, ?, 'longbridge-paper', 'paper', 'paper', ?, 'stock', ?, ?, ?, ?, ?, ?, ?, ?, 'null', '[]', ?)
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
    overrides.lastObservedAt ?? submittedAt,
    overrides.ownerId ?? null
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
      ownerId: "__shared__",
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

  it("does not move an already-filled order past a newer snapshot when reconcile observes it again", async () => {
    const db = makeDb();
    seedMember(db, "member_a");
    insertLifecycleRow(db, {
      id: "row_historical_fill", ticketId: "ticket_historical_fill",
      externalOrderId: "EXT_HISTORICAL_FILL", ownerId: "member_a",
      symbol: "AAPL.US", side: "sell", quantity: 50, limitPrice: 100,
      lifecycleStage: "filled", brokerStatus: "Filled", localStatus: "accepted",
      submittedAt: "2026-07-15T13:30:00.000Z",
      lastObservedAt: "2026-07-15T13:50:00.000Z"
    });
    insertLifecycleRow(db, {
      id: "row_historical_buy_fill", ticketId: "ticket_historical_buy_fill",
      externalOrderId: "EXT_HISTORICAL_BUY_FILL", ownerId: "member_a",
      symbol: "MSFT.US", side: "buy", quantity: 5, limitPrice: 200,
      lifecycleStage: "filled", brokerStatus: "Filled", localStatus: "accepted",
      submittedAt: "2026-07-15T13:35:00.000Z",
      lastObservedAt: "2026-07-15T13:55:00.000Z"
    });

    await runReconcile(db, [
      brokerOrder({
        order_id: "EXT_HISTORICAL_FILL", symbol: "AAPL.US", side: "Sell", quantity: 50,
        price: 100, status: "Filled", created_at: "2026-07-15T13:30:00.000Z"
      }),
      brokerOrder({
        order_id: "EXT_HISTORICAL_BUY_FILL", symbol: "MSFT.US", side: "Buy", quantity: 5,
        price: 200, status: "Filled", created_at: "2026-07-15T13:35:00.000Z"
      })
    ], {
      explicitOwnerId: "member_a",
      nowIso: "2026-07-15T14:10:00.000Z"
    });

    const row = getRow(db, "row_historical_fill");
    expect(row.last_observed_at).toBe("2026-07-15T13:50:00.000Z");
    expect(getRow(db, "row_historical_buy_fill").last_observed_at).toBe("2026-07-15T13:55:00.000Z");
    const lifecycle = new OfficialPaperOrderLifecycleRepository(db);
    const snapshotFetchedAt = "2026-07-15T14:00:00.000Z";
    expect(lifecycle.sumOpenNotionalForOwner("member_a", snapshotFetchedAt)).toBe(0);
    expect(lifecycle.sumOpenSellQuantityForOwnerSymbol("member_a", "AAPL.US", snapshotFetchedAt)).toBe(0);
  });

  it("partial fill: maps to 'pending', not 'accepted'", async () => {
    const db = makeDb();
    insertLifecycleRow(db, { id: "row_partial", ticketId: "ticket_prop_p2", externalOrderId: "EXT2", ownerId: "__shared__", lifecycleStage: "submitted" });

    await runReconcile(db, [brokerOrder({ order_id: "EXT2", status: "PartialFilled" })]);

    const row = getRow(db, "row_partial");
    expect(row.lifecycle_stage).toBe("pending");
    expect(row.local_status).toBe("pending");
  });

  it("cancel-in-progress: WaitToCancel maps to 'pending', never 'unknown' (finding #5)", async () => {
    const db = makeDb();
    insertLifecycleRow(db, { id: "row_cancel", ticketId: "ticket_prop_p3", externalOrderId: "EXT3", ownerId: "__shared__", lifecycleStage: "submitted" });

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
      ownerId: "__shared__",
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
      ownerId: "__shared__",
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

  it("backfills a legacy NULL owner from the linked proposal in both adoption and matched refreshes", async () => {
    const db = makeDb();
    seedMember(db, "member_owner");
    const proposal = seedProposal(db, {
      ownerId: "member_owner", symbol: "AMZN.US", side: "buy", quantity: 6, limitPrice: 200
    });
    const ticketId = `ticket_prop_${proposal.id}`;
    insertLifecycleRow(db, {
      id: "row_owner_backfill", ticketId, externalOrderId: null,
      symbol: "AMZN.US", side: "buy", quantity: 6, limitPrice: 200,
      lifecycleStage: "submit_unconfirmed", brokerStatus: "unconfirmed", localStatus: "pending",
      submittedAt: "2026-07-15T14:00:00.000Z"
    });

    await runReconcile(db, [
      brokerOrder({
        order_id: "EXT_OWNER_BACKFILL", symbol: "AMZN.US", side: "Buy", quantity: 6,
        price: 200, status: "New", created_at: "2026-07-15T14:02:00.000Z"
      })
    ]);
    expect(getRow(db, "row_owner_backfill").owner_id).toBe("member_owner");

    // Recreate a legacy NULL on the now-matched row to cover the other branch.
    db.prepare(`UPDATE official_paper_order_lifecycle SET owner_id = NULL WHERE id = ?`).run("row_owner_backfill");
    await runReconcile(db, [
      brokerOrder({
        order_id: "EXT_OWNER_BACKFILL", symbol: "AMZN.US", side: "Buy", quantity: 6,
        price: 200, status: "Filled", created_at: "2026-07-15T14:02:00.000Z"
      })
    ]);
    expect(getRow(db, "row_owner_backfill").owner_id).toBe("member_owner");
  });

  it("prefers an exact-owner failed row over a historical NULL-owner submit_unconfirmed row", async () => {
    const db = makeDb();
    seedMember(db, "member_a");
    const legacyProposal = seedProposal(db, {
      ownerId: "member_a", symbol: "NFLX.US", side: "buy", quantity: 2, limitPrice: 500
    });
    insertLifecycleRow(db, {
      id: "row_exact_failed", ticketId: "ticket_exact_failed", ownerId: "member_a",
      symbol: "NFLX.US", side: "buy", quantity: 2, limitPrice: 500,
      lifecycleStage: "failed", brokerStatus: "unconfirmed", localStatus: "rejected",
      submittedAt: "2026-07-15T14:00:00.000Z"
    });
    insertLifecycleRow(db, {
      id: "row_legacy_unconfirmed", ticketId: `ticket_prop_${legacyProposal.id}`, ownerId: null,
      symbol: "NFLX.US", side: "buy", quantity: 2, limitPrice: 500,
      lifecycleStage: "submit_unconfirmed", brokerStatus: "unconfirmed", localStatus: "pending",
      submittedAt: "2026-07-15T14:00:01.000Z"
    });

    const result = await runReconcile(db, [
      brokerOrder({
        order_id: "EXT_EXACT_FAILED", symbol: "NFLX.US", side: "Buy", quantity: 2,
        price: 500, status: "New", created_at: "2026-07-15T14:00:02.000Z"
      })
    ], { explicitOwnerId: "member_a" });

    expect(getRow(db, "row_exact_failed").external_order_id).toBe("EXT_EXACT_FAILED");
    expect(getRow(db, "row_legacy_unconfirmed").external_order_id).toBeNull();
    expect(result.adopted).toHaveLength(1);
    expect(result.adopted[0]?.ticketId).toBe("ticket_exact_failed");
  });

  it("defers an exact-owner submitting row instead of adopting a historical NULL-owner submit_unconfirmed row", async () => {
    const db = makeDb();
    seedMember(db, "member_a");
    const legacyProposal = seedProposal(db, {
      ownerId: "member_a", symbol: "META.US", side: "buy", quantity: 3, limitPrice: 600
    });
    insertLifecycleRow(db, {
      id: "row_exact_submitting", ticketId: "ticket_exact_submitting", ownerId: "member_a",
      symbol: "META.US", side: "buy", quantity: 3, limitPrice: 600,
      lifecycleStage: "submitting", brokerStatus: "pending_submission", localStatus: "pending",
      submittedAt: "2026-07-15T14:00:00.000Z"
    });
    insertLifecycleRow(db, {
      id: "row_legacy_unconfirmed_for_inflight", ticketId: `ticket_prop_${legacyProposal.id}`, ownerId: null,
      symbol: "META.US", side: "buy", quantity: 3, limitPrice: 600,
      lifecycleStage: "submit_unconfirmed", brokerStatus: "unconfirmed", localStatus: "pending",
      submittedAt: "2026-07-15T14:00:01.000Z"
    });

    const result = await runReconcile(db, [
      brokerOrder({
        order_id: "EXT_EXACT_SUBMITTING", symbol: "META.US", side: "Buy", quantity: 3,
        price: 600, status: "New", created_at: "2026-07-15T14:00:02.000Z"
      })
    ], { explicitOwnerId: "member_a" });

    expect(getRow(db, "row_exact_submitting").external_order_id).toBeNull();
    expect(getRow(db, "row_legacy_unconfirmed_for_inflight").external_order_id).toBeNull();
    expect(result.deferredInFlight).toHaveLength(1);
    expect(result.deferredInFlight[0]?.candidateTicketId).toBe("ticket_exact_submitting");
    expect(result.adopted).toHaveLength(0);
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
    expect(row?.owner_id).toBe("__shared__");
    expect(result.orphaned).toEqual([{
      externalOrderId: "EXT7", ticketId: null, symbol: "NVDA.US", side: "buy", quantity: 2,
      brokerStatus: "New", lifecycleStage: "submitted", localStatus: "submitted"
    }]);
    expect(auditActions(db)).toContain("orphan_broker_order");
  });

  it("attributes a shared-account orphan to the sole active member", async () => {
    const db = makeDb();
    seedMember(db, "member_only");

    await runReconcile(db, [
      brokerOrder({ order_id: "EXT_OWNER_ONLY", symbol: "META.US" })
    ]);

    expect(getRowByExternalOrderId(db, "EXT_OWNER_ONLY")?.owner_id).toBe("member_only");
  });

  it("uses the explicit shared sentinel instead of guessing when multiple members are active", async () => {
    const db = makeDb();
    seedMember(db, "member_a");
    seedMember(db, "member_b");

    await runReconcile(db, [
      brokerOrder({ order_id: "EXT_OWNER_SHARED", symbol: "GOOG.US" })
    ]);

    expect(getRowByExternalOrderId(db, "EXT_OWNER_SHARED")?.owner_id).toBe("__shared__");
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

  it("only adjudicates submit_unconfirmed rows selected by the symbol filter", async () => {
    const db = makeDb();
    insertLifecycleRow(db, {
      id: "row_aapl_outside_filter", ticketId: "manual_aapl", externalOrderId: null,
      ownerId: "__shared__", symbol: "AAPL.US", side: "buy", quantity: 1,
      lifecycleStage: "submit_unconfirmed", submittedAt: "2026-07-15T12:00:00.000Z"
    });
    insertLifecycleRow(db, {
      id: "row_tsla_selected", ticketId: "manual_tsla", externalOrderId: null,
      ownerId: "__shared__", symbol: "TSLA.US", side: "buy", quantity: 1,
      lifecycleStage: "submit_unconfirmed", submittedAt: "2026-07-15T12:00:00.000Z"
    });

    const result = await runReconcile(db, [], {
      nowIso: "2026-07-15T14:10:00.000Z",
      symbolFilters: new Set(["TSLA.US"])
    });

    expect(getRow(db, "row_aapl_outside_filter").lifecycle_stage).toBe("submit_unconfirmed");
    expect(getRow(db, "row_tsla_selected").lifecycle_stage).toBe("failed");
    expect(result.timedOut).toEqual([{ ticketId: "manual_tsla", symbol: "TSLA.US", proposalId: null }]);
  });

  it("fails closed on an invalid broker orders payload instead of treating it as an empty list", async () => {
    const db = makeDb();
    insertLifecycleRow(db, {
      id: "row_invalid_payload", ticketId: "manual_invalid_payload", externalOrderId: null,
      ownerId: "__shared__", symbol: "AAPL.US", side: "buy", quantity: 1,
      lifecycleStage: "submit_unconfirmed", submittedAt: "2026-07-15T12:00:00.000Z"
    });

    await expect(reconcileOfficialPaperOrders(db, {
      fetchOrders: async () => ({ error: "upstream response shape changed" }),
      fetchExecutions: async () => [],
      now: () => new Date("2026-07-15T14:10:00.000Z")
    })).rejects.toThrow(/orders payload.*invalid/iu);

    expect(getRow(db, "row_invalid_payload").lifecycle_stage).toBe("submit_unconfirmed");
  });

  it("fails closed when an orders array contains a malformed element", async () => {
    const db = makeDb();
    insertLifecycleRow(db, {
      id: "row_invalid_order_element", ticketId: "manual_invalid_order_element", externalOrderId: null,
      ownerId: "__shared__", symbol: "AAPL.US", side: "buy", quantity: 1,
      lifecycleStage: "submit_unconfirmed", submittedAt: "2026-07-15T12:00:00.000Z"
    });

    await expect(reconcileOfficialPaperOrders(db, {
      fetchOrders: async () => [{ error: "upstream changed each row shape" }],
      fetchExecutions: async () => [],
      now: () => new Date("2026-07-15T14:10:00.000Z")
    })).rejects.toThrow(/orders payload element.*invalid/iu);

    expect(getRow(db, "row_invalid_order_element").lifecycle_stage).toBe("submit_unconfirmed");
  });

  it("does not use a new trading day's today-orders list to fail yesterday's unconfirmed order", async () => {
    const db = makeDb();
    insertLifecycleRow(db, {
      id: "row_previous_trading_day", ticketId: "manual_previous_day", externalOrderId: null,
      ownerId: "__shared__", symbol: "AAPL.US", side: "buy", quantity: 1,
      lifecycleStage: "submit_unconfirmed", submittedAt: "2026-07-15T19:50:00.000Z"
    });

    const result = await runReconcile(db, [], { nowIso: "2026-07-16T14:10:00.000Z" });

    expect(getRow(db, "row_previous_trading_day").lifecycle_stage).toBe("submit_unconfirmed");
    expect(result.timedOut).toHaveLength(0);
  });

  it("recovers a previous-day unconfirmed order from bounded broker history", async () => {
    const db = makeDb();
    insertLifecycleRow(db, {
      id: "row_previous_day_recovered", ticketId: "manual_previous_day_recovered", externalOrderId: null,
      ownerId: "__shared__", symbol: "AAPL.US", side: "buy", quantity: 1, limitPrice: 100,
      lifecycleStage: "submit_unconfirmed", submittedAt: "2026-07-15T19:50:00.000Z"
    });
    const historyCalls: Array<{ startAt: string; endAt: string; symbol?: string }> = [];

    const result = await runReconcile(db, [], {
      nowIso: "2026-07-16T14:10:00.000Z",
      fetchHistoricalOrders: async (window: { startAt: string; endAt: string }) => {
        historyCalls.push(window);
        return [brokerOrder({
          order_id: "EXT_FROM_HISTORY", symbol: "AAPL.US", side: "Buy", quantity: 1,
          price: 100, status: "Filled", created_at: "2026-07-15T19:50:10.000Z"
        })];
      },
      fetchHistoricalExecutions: async () => []
    });

    expect(historyCalls).toHaveLength(1);
    expect(new Date(historyCalls[0]!.startAt).getTime()).toBeLessThanOrEqual(new Date("2026-07-15T19:50:00.000Z").getTime());
    expect(new Date(historyCalls[0]!.endAt).getTime()).toBeLessThanOrEqual(
      new Date("2026-07-15T19:50:00.000Z").getTime() + DEFAULT_ORPHAN_CORRELATION_WINDOW_MS
    );
    expect(historyCalls[0]).toMatchObject({ symbol: "AAPL.US" });
    expect(getRow(db, "row_previous_day_recovered")).toMatchObject({
      external_order_id: "EXT_FROM_HISTORY",
      lifecycle_stage: "filled"
    });
    expect(result.adopted).toHaveLength(1);
    expect(result.timedOut).toHaveLength(0);
  });

  it("uses a successful covering history query to adjudicate a missing previous-day order", async () => {
    const db = makeDb();
    insertLifecycleRow(db, {
      id: "row_previous_day_absent", ticketId: "manual_previous_day_absent", externalOrderId: null,
      ownerId: "__shared__", symbol: "AAPL.US", side: "buy", quantity: 1,
      lifecycleStage: "submit_unconfirmed", submittedAt: "2026-07-15T19:50:00.000Z"
    });

    const result = await runReconcile(db, [], {
      nowIso: "2026-07-16T14:10:00.000Z",
      fetchHistoricalOrders: async () => [],
      fetchHistoricalExecutions: async () => []
    });

    expect(getRow(db, "row_previous_day_absent").lifecycle_stage).toBe("failed");
    expect(result.timedOut).toEqual([{
      ticketId: "manual_previous_day_absent", symbol: "AAPL.US", proposalId: null
    }]);
  });

  it("fails closed without mutating cross-day rows when history retrieval fails", async () => {
    const db = makeDb();
    insertLifecycleRow(db, {
      id: "row_history_failure", ticketId: "manual_history_failure", externalOrderId: null,
      ownerId: "__shared__", symbol: "AAPL.US", side: "buy", quantity: 1,
      lifecycleStage: "submit_unconfirmed", submittedAt: "2026-07-15T19:50:00.000Z"
    });

    await expect(runReconcile(db, [], {
      nowIso: "2026-07-16T14:10:00.000Z",
      fetchHistoricalOrders: async () => { throw new Error("history upstream unavailable"); },
      fetchHistoricalExecutions: async () => []
    })).rejects.toThrow(/history upstream unavailable/u);

    expect(getRow(db, "row_history_failure").lifecycle_stage).toBe("submit_unconfirmed");
  });

  it("refuses timeout adjudication when a history page reaches the SDK's 1000-row truncation boundary", async () => {
    const db = makeDb();
    insertLifecycleRow(db, {
      id: "row_history_truncated", ticketId: "manual_history_truncated", externalOrderId: null,
      ownerId: "__shared__", symbol: "AAPL.US", side: "buy", quantity: 1,
      lifecycleStage: "submit_unconfirmed", submittedAt: "2026-07-15T19:50:00.000Z"
    });
    const fullPage = Array.from({ length: 1000 }, (_, index) => brokerOrder({
      order_id: `EXT_PAGE_${index}`, symbol: "AAPL.US", side: "Sell", quantity: 1,
      status: "Filled", created_at: `2026-07-15T19:${String(index % 60).padStart(2, "0")}:00.000Z`
    }));

    await expect(runReconcile(db, [], {
      nowIso: "2026-07-16T14:10:00.000Z",
      fetchHistoricalOrders: async () => fullPage,
      fetchHistoricalExecutions: async () => []
    })).rejects.toThrow(/1000|truncat|完整覆盖/iu);

    expect(getRow(db, "row_history_truncated").lifecycle_stage).toBe("submit_unconfirmed");
  });

  it("queries far-apart unresolved submissions in separate bounded windows", async () => {
    const db = makeDb();
    for (const [id, submittedAt] of [
      ["row_history_older", "2026-06-15T19:50:00.000Z"],
      ["row_history_newer", "2026-07-15T19:50:00.000Z"]
    ] as const) {
      insertLifecycleRow(db, {
        id, ticketId: `manual_${id}`, externalOrderId: null, ownerId: "__shared__",
        symbol: "AAPL.US", side: "buy", quantity: 1,
        lifecycleStage: "submit_unconfirmed", submittedAt
      });
    }
    const historyCalls: Array<{ startAt: string; endAt: string }> = [];

    await runReconcile(db, [], {
      nowIso: "2026-07-16T14:10:00.000Z",
      fetchHistoricalOrders: async (window: { startAt: string; endAt: string }) => {
        historyCalls.push(window);
        return [];
      },
      fetchHistoricalExecutions: async () => []
    });

    expect(historyCalls).toHaveLength(2);
    for (const window of historyCalls) {
      expect(new Date(window.endAt).getTime() - new Date(window.startAt).getTime())
        .toBe(2 * DEFAULT_ORPHAN_CORRELATION_WINDOW_MS);
    }
  });
});

describe("stale submitting recovery", () => {
  it("adopts a broker order after the in-flight grace period and completes its approved proposal", async () => {
    const db = makeDb();
    seedMember(db, "member_1");
    const proposal = seedProposal(db, { ownerId: "member_1", symbol: "NVDA.US", quantity: 2, limitPrice: 120 });
    new ProposalRepository(db).consumeApproval(proposal.approvalToken!, {
      decision: "approved",
      decidedBy: "member_1",
      decidedAt: "2026-07-15T12:59:00.000Z"
    });
    insertLifecycleRow(db, {
      id: "row_stale_submitting_with_order", ticketId: `ticket_prop_${proposal.id}`,
      ownerId: "member_1", symbol: "NVDA.US", side: "buy", quantity: 2, limitPrice: 120,
      lifecycleStage: "submitting", submittedAt: "2026-07-15T13:00:00.000Z"
    });

    const result = await runReconcile(db, [brokerOrder({
      order_id: "EXT_STALE_SUBMITTING",
      symbol: "NVDA.US",
      quantity: 2,
      price: 120,
      status: "Filled",
      created_at: "2026-07-15T13:01:00.000Z"
    })], { nowIso: "2026-07-15T14:10:00.000Z" });

    expect(result.adopted).toHaveLength(1);
    expect(result.deferredInFlight).toHaveLength(0);
    expect(getRow(db, "row_stale_submitting_with_order")).toMatchObject({
      external_order_id: "EXT_STALE_SUBMITTING",
      lifecycle_stage: "filled"
    });
    expect(new ProposalRepository(db).getById(proposal.id)).toMatchObject({
      status: "executed",
      ticketId: `ticket_prop_${proposal.id}`
    });
    expect(executionReportsCount(db)).toBe(1);
  });

  it("fails a same-day stale submitting row only after a valid empty broker list and the timeout", async () => {
    const db = makeDb();
    seedMember(db, "member_1");
    const proposal = seedProposal(db, { ownerId: "member_1", symbol: "AMD.US", quantity: 2 });
    new ProposalRepository(db).consumeApproval(proposal.approvalToken!, {
      decision: "approved",
      decidedBy: "member_1",
      decidedAt: "2026-07-15T12:59:00.000Z"
    });
    insertLifecycleRow(db, {
      id: "row_stale_submitting_without_order", ticketId: `ticket_prop_${proposal.id}`,
      ownerId: "member_1", symbol: "AMD.US", side: "buy", quantity: 2,
      lifecycleStage: "submitting", submittedAt: "2026-07-15T13:00:00.000Z"
    });

    const result = await runReconcile(db, [], { nowIso: "2026-07-15T14:10:00.000Z" });

    expect(getRow(db, "row_stale_submitting_without_order").lifecycle_stage).toBe("failed");
    expect(result.timedOut).toHaveLength(1);
    expect(new ProposalRepository(db).getById(proposal.id)?.status).toBe("failed");
  });

  it("records a rejected broker attempt and closes its approved proposal exactly once", async () => {
    const db = makeDb();
    seedMember(db, "member_1");
    const proposal = seedProposal(db, { ownerId: "member_1", symbol: "NVDA.US", quantity: 2, limitPrice: 120 });
    new ProposalRepository(db).consumeApproval(proposal.approvalToken!, {
      decision: "approved",
      decidedBy: "member_1",
      decidedAt: "2026-07-15T12:59:00.000Z"
    });
    insertLifecycleRow(db, {
      id: "row_stale_submitting_rejected", ticketId: `ticket_prop_${proposal.id}`,
      ownerId: "member_1", symbol: "NVDA.US", side: "buy", quantity: 2, limitPrice: 120,
      lifecycleStage: "submitting", submittedAt: "2026-07-15T13:00:00.000Z"
    });
    const orders = [brokerOrder({
      order_id: "EXT_STALE_REJECTED",
      symbol: "NVDA.US",
      quantity: 2,
      price: 120,
      status: "Rejected",
      created_at: "2026-07-15T13:01:00.000Z"
    })];

    await runReconcile(db, orders, { nowIso: "2026-07-15T14:10:00.000Z" });
    await runReconcile(db, orders, { nowIso: "2026-07-15T14:11:00.000Z" });

    expect(getRow(db, "row_stale_submitting_rejected")).toMatchObject({
      external_order_id: "EXT_STALE_REJECTED",
      lifecycle_stage: "rejected"
    });
    expect(new ProposalRepository(db).getById(proposal.id)).toMatchObject({
      status: "executed",
      ticketId: `ticket_prop_${proposal.id}`
    });
    expect(executionReportsCount(db)).toBe(1);
  });

  it("rolls back the lifecycle timeout when the linked proposal cannot be marked failed", async () => {
    const db = makeDb();
    seedMember(db, "member_1");
    const proposal = seedProposal(db, { ownerId: "member_1", symbol: "AMD.US", quantity: 2 });
    new ProposalRepository(db).consumeApproval(proposal.approvalToken!, {
      decision: "approved",
      decidedBy: "member_1",
      decidedAt: "2026-07-15T12:59:00.000Z"
    });
    insertLifecycleRow(db, {
      id: "row_timeout_atomic", ticketId: `ticket_prop_${proposal.id}`,
      ownerId: "member_1", symbol: "AMD.US", side: "buy", quantity: 2,
      lifecycleStage: "submit_unconfirmed", submittedAt: "2026-07-15T13:00:00.000Z"
    });
    db.exec(`
      CREATE TRIGGER fail_timeout_proposal_update
      BEFORE UPDATE OF status ON proposals
      WHEN NEW.status = 'failed'
      BEGIN
        SELECT RAISE(ABORT, 'injected proposal timeout failure');
      END;
    `);

    await expect(runReconcile(db, [], { nowIso: "2026-07-15T14:10:00.000Z" }))
      .rejects.toThrow(/injected proposal timeout failure/);
    expect(getRow(db, "row_timeout_atomic").lifecycle_stage).toBe("submit_unconfirmed");
    expect(new ProposalRepository(db).getById(proposal.id)?.status).toBe("approved");

    db.exec(`DROP TRIGGER fail_timeout_proposal_update;`);
    const recovered = await runReconcile(db, [], { nowIso: "2026-07-15T14:11:00.000Z" });
    expect(recovered.timedOut).toHaveLength(1);
    expect(getRow(db, "row_timeout_atomic").lifecycle_stage).toBe("failed");
    expect(new ProposalRepository(db).getById(proposal.id)?.status).toBe("failed");
  });
});

describe("per-member account reconciliation isolation", () => {
  it("does not reuse an unattributed legacy row when another account has the same broker order id", async () => {
    const db = makeDb();
    seedMember(db, "member_b");
    insertLifecycleRow(db, {
      id: "row_legacy_account_local_id", ticketId: null, externalOrderId: "EXT_ACCOUNT_LOCAL_COLLISION",
      ownerId: null, symbol: "OLD.US", side: "sell", quantity: 7,
      lifecycleStage: "submitted", brokerStatus: "New", localStatus: "submitted"
    });

    await runReconcile(db, [
      brokerOrder({
        order_id: "EXT_ACCOUNT_LOCAL_COLLISION", symbol: "NEW.US", side: "Buy", quantity: 2,
        status: "Filled", created_at: "2026-07-15T13:02:00.000Z"
      })
    ], { explicitOwnerId: "member_b" });

    const collidingRows = allRows(db).filter((row) => row.external_order_id === "EXT_ACCOUNT_LOCAL_COLLISION");
    expect(collidingRows).toHaveLength(2);
    expect(collidingRows.find((row) => row.id === "row_legacy_account_local_id")).toMatchObject({
      owner_id: null,
      symbol: "OLD.US",
      side: "sell",
      quantity: 7,
      lifecycle_stage: "submitted"
    });
    expect(collidingRows.find((row) => row.owner_id === "member_b")).toMatchObject({
      symbol: "NEW.US",
      side: "buy",
      quantity: 2,
      lifecycle_stage: "filled"
    });
  });

  it("does not adopt or time out an unattributed legacy unconfirmed row during explicit member reconciliation", async () => {
    const db = makeDb();
    seedMember(db, "member_b");
    insertLifecycleRow(db, {
      id: "row_legacy_unconfirmed_other_account", ticketId: "manual_legacy", externalOrderId: null,
      ownerId: null, symbol: "AAPL.US", side: "buy", quantity: 10,
      lifecycleStage: "submit_unconfirmed", submittedAt: "2026-07-15T13:00:00.000Z"
    });

    const result = await runReconcile(db, [
      brokerOrder({
        order_id: "EXT_MEMBER_B_AAPL", symbol: "AAPL.US", side: "Buy", quantity: 10,
        status: "New", created_at: "2026-07-15T13:02:00.000Z"
      })
    ], {
      explicitOwnerId: "member_b",
      nowIso: "2026-07-15T14:10:00.000Z"
    });

    expect(getRow(db, "row_legacy_unconfirmed_other_account")).toMatchObject({
      owner_id: null,
      external_order_id: null,
      lifecycle_stage: "submit_unconfirmed"
    });
    expect(getRowByExternalOrderId(db, "EXT_MEMBER_B_AAPL")?.owner_id).toBe("member_b");
    expect(result.adopted).toHaveLength(0);
    expect(result.orphaned).toHaveLength(1);
    expect(result.timedOut).toHaveLength(0);
  });

  it("attributes new broker orphans to the explicit account owner", async () => {
    const db = makeDb();
    seedMember(db, "member_a");
    seedMember(db, "member_b");

    await runReconcile(db, [brokerOrder({ order_id: "EXT_MEMBER_A" })], {
      explicitOwnerId: "member_a"
    });

    expect(getRowByExternalOrderId(db, "EXT_MEMBER_A")?.owner_id).toBe("member_a");
  });

  it("never adopts or times out another account owner's lifecycle rows", async () => {
    const db = makeDb();
    insertLifecycleRow(db, {
      id: "row_member_a", ticketId: "ticket_prop_a", ownerId: "member_a",
      symbol: "AAPL.US", side: "buy", quantity: 10,
      lifecycleStage: "submit_unconfirmed", submittedAt: "2026-07-15T13:00:00.000Z"
    });
    insertLifecycleRow(db, {
      id: "row_member_b", ticketId: "ticket_prop_b", ownerId: "member_b",
      symbol: "AAPL.US", side: "buy", quantity: 10,
      lifecycleStage: "submit_unconfirmed", submittedAt: "2026-07-15T13:00:00.000Z"
    });

    const result = await runReconcile(db, [
      brokerOrder({ order_id: "EXT_MEMBER_A_ADOPT", created_at: "2026-07-15T13:02:00.000Z" })
    ], {
      explicitOwnerId: "member_a",
      nowIso: "2026-07-15T14:10:00.000Z"
    });

    expect(getRow(db, "row_member_a").external_order_id).toBe("EXT_MEMBER_A_ADOPT");
    expect(getRow(db, "row_member_b").external_order_id).toBeNull();
    expect(getRow(db, "row_member_b").lifecycle_stage).toBe("submit_unconfirmed");
    expect(result.adopted).toHaveLength(1);
    expect(result.timedOut).toHaveLength(0);
  });

  it("keeps legacy-account reconciliation scoped to its active owner", async () => {
    const db = makeDb();
    seedMember(db, "member_a");
    insertLifecycleRow(db, {
      id: "row_dormant_member_b", ticketId: "ticket_prop_b", ownerId: "member_b",
      symbol: "AAPL.US", side: "buy", quantity: 10,
      lifecycleStage: "submit_unconfirmed", submittedAt: "2026-07-15T13:00:00.000Z"
    });

    const result = await runReconcile(db, [
      brokerOrder({ order_id: "EXT_LEGACY_MEMBER_A", created_at: "2026-07-15T13:02:00.000Z" })
    ], {
      nowIso: "2026-07-15T14:10:00.000Z"
    });

    expect(getRow(db, "row_dormant_member_b").external_order_id).toBeNull();
    expect(getRow(db, "row_dormant_member_b").lifecycle_stage).toBe("submit_unconfirmed");
    expect(getRowByExternalOrderId(db, "EXT_LEGACY_MEMBER_A")?.owner_id).toBe("member_a");
    expect(result.adopted).toHaveLength(0);
    expect(result.orphaned).toHaveLength(1);
    expect(result.timedOut).toHaveLength(0);
  });

  it("does not claim a historical null-owner row linked to another member's proposal", async () => {
    const db = makeDb();
    seedMember(db, "member_a");
    seedMember(db, "member_b");
    db.prepare(`UPDATE members SET status = 'revoked' WHERE id = ?`).run("member_b");
    const proposalB = seedProposal(db, { ownerId: "member_b" });
    insertLifecycleRow(db, {
      id: "row_null_owner_member_b", ticketId: `ticket_prop_${proposalB.id}`, ownerId: null,
      symbol: "AAPL.US", side: "buy", quantity: 10,
      lifecycleStage: "submit_unconfirmed", submittedAt: "2026-07-15T13:00:00.000Z"
    });

    const result = await runReconcile(db, [
      brokerOrder({ order_id: "EXT_LEGACY_NULL_MEMBER_A", created_at: "2026-07-15T13:02:00.000Z" })
    ], {
      nowIso: "2026-07-15T14:10:00.000Z"
    });

    expect(getRow(db, "row_null_owner_member_b").external_order_id).toBeNull();
    expect(getRow(db, "row_null_owner_member_b").lifecycle_stage).toBe("submit_unconfirmed");
    expect(getRowByExternalOrderId(db, "EXT_LEGACY_NULL_MEMBER_A")?.owner_id).toBe("member_a");
    expect(result.adopted).toHaveLength(0);
    expect(result.orphaned).toHaveLength(1);
    expect(result.timedOut).toHaveLength(0);
  });

  it("fails closed for a historical null-owner row whose proposal is missing", async () => {
    const db = makeDb();
    seedMember(db, "member_a");
    insertLifecycleRow(db, {
      id: "row_null_owner_missing_proposal", ticketId: "ticket_prop_missing", ownerId: null,
      symbol: "AAPL.US", side: "buy", quantity: 10,
      lifecycleStage: "submit_unconfirmed", submittedAt: "2026-07-15T13:00:00.000Z"
    });

    const result = await runReconcile(db, [
      brokerOrder({ order_id: "EXT_LEGACY_MISSING_PROPOSAL", created_at: "2026-07-15T13:02:00.000Z" })
    ], {
      nowIso: "2026-07-15T14:10:00.000Z"
    });

    expect(getRow(db, "row_null_owner_missing_proposal").external_order_id).toBeNull();
    expect(getRow(db, "row_null_owner_missing_proposal").lifecycle_stage).toBe("submit_unconfirmed");
    expect(getRowByExternalOrderId(db, "EXT_LEGACY_MISSING_PROPOSAL")?.owner_id).toBe("member_a");
    expect(result.adopted).toHaveLength(0);
    expect(result.orphaned).toHaveLength(1);
    expect(result.timedOut).toHaveLength(0);
  });

  it("updates only the selected account when two owners have the same broker order id", async () => {
    const db = makeDb();
    insertLifecycleRow(db, {
      id: "row_same_id_a", ticketId: "ticket_a", externalOrderId: "EXT_ACCOUNT_LOCAL",
      ownerId: "member_a", lifecycleStage: "submitted", brokerStatus: "New", localStatus: "submitted"
    });
    insertLifecycleRow(db, {
      id: "row_same_id_b", ticketId: "ticket_b", externalOrderId: "EXT_ACCOUNT_LOCAL",
      ownerId: "member_b", lifecycleStage: "submitted", brokerStatus: "New", localStatus: "submitted"
    });

    await runReconcile(db, [
      brokerOrder({ order_id: "EXT_ACCOUNT_LOCAL", status: "Filled" })
    ], { explicitOwnerId: "member_a" });

    expect(getRow(db, "row_same_id_a").lifecycle_stage).toBe("filled");
    expect(getRow(db, "row_same_id_b").lifecycle_stage).toBe("submitted");
    expect(getRow(db, "row_same_id_b").broker_status).toBe("New");
  });
});

describe("idempotent reconcile (finding #6: no execution_reports, ever)", () => {
  it("running the same fixture twice leaves row count, ticket_ids, and execution_reports (0) unchanged", async () => {
    const db = makeDb();
    insertLifecycleRow(db, {
      id: "row_a", ticketId: "ticket_prop_a", externalOrderId: "EXT_A", lifecycleStage: "submitted",
      ownerId: "__shared__",
      symbol: "AAPL.US", side: "buy", quantity: 10, submittedAt: "2026-07-15T14:00:00.000Z"
    });
    insertLifecycleRow(db, {
      id: "row_b", ticketId: "ticket_prop_b", externalOrderId: null, lifecycleStage: "submit_unconfirmed",
      ownerId: "__shared__",
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

  it("atomically retries a failed report write without leaving the proposal executed and reportless", async () => {
    const db = makeDb();
    seedMember(db, "member_1");
    const proposal = seedProposal(db, { ownerId: "member_1", symbol: "NVDA.US", quantity: 2, limitPrice: 120 });
    new ProposalRepository(db).markFailed(proposal.id, "执行未确认");
    insertLifecycleRow(db, {
      id: "row_reconcile_report_retry", ticketId: `ticket_prop_${proposal.id}`,
      ownerId: "member_1", symbol: "NVDA.US", side: "buy", quantity: 2, limitPrice: 120,
      lifecycleStage: "submit_unconfirmed", submittedAt: "2026-07-15T13:00:00.000Z"
    });
    const orders = [brokerOrder({
      order_id: "EXT_RECONCILE_REPORT_RETRY",
      symbol: "NVDA.US",
      quantity: 2,
      price: 120,
      status: "Filled",
      created_at: "2026-07-15T13:01:00.000Z"
    })];
    db.exec(`
      CREATE TRIGGER fail_reconcile_report_insert
      BEFORE INSERT ON execution_reports
      BEGIN
        SELECT RAISE(ABORT, 'injected reconcile report failure');
      END;
    `);

    await expect(runReconcile(db, orders, { nowIso: "2026-07-15T14:10:00.000Z" }))
      .rejects.toThrow(/injected reconcile report failure/);
    expect(new ProposalRepository(db).getById(proposal.id)?.status).toBe("failed");
    expect(executionReportsCount(db)).toBe(0);

    db.exec(`DROP TRIGGER fail_reconcile_report_insert;`);
    await runReconcile(db, orders, { nowIso: "2026-07-15T14:11:00.000Z" });
    await runReconcile(db, orders, { nowIso: "2026-07-15T14:12:00.000Z" });

    expect(new ProposalRepository(db).getById(proposal.id)).toMatchObject({
      status: "executed",
      ticketId: `ticket_prop_${proposal.id}`
    });
    expect(executionReportsCount(db)).toBe(1);
  });

  // N2 (2026-07-28 verifier): this writer used to call reports.save() with no
  // ownerId at all, so a reconciled REAL fill was written with owner_id NULL.
  // The owner-scoped read (selectExecutionReports, `WHERE owner_id = ?`) then
  // could never return it, so the member's own weekly §3.3 section did not show
  // their own reconciled trade - it appeared only inside the anonymous
  // "未按成员归属" count. Asserted against the raw column, not the type.
  it("stamps the reconciled report with the proposal's owner, so the owner-scoped read can see it", async () => {
    const db = makeDb();
    seedMember(db, "member_1");
    const proposal = seedProposal(db, { ownerId: "member_1", symbol: "NVDA.US", side: "sell", quantity: 4, limitPrice: 130 });
    const ticketId = `ticket_prop_${proposal.id}`;
    new ProposalRepository(db).markFailed(proposal.id, "执行未确认（submit_unconfirmed）：模拟超时。");

    insertLifecycleRow(db, {
      id: "row_owner_stamp", ticketId, externalOrderId: null,
      symbol: "NVDA.US", side: "sell", quantity: 4, limitPrice: 130,
      lifecycleStage: "submit_unconfirmed", brokerStatus: "unconfirmed", localStatus: "pending",
      submittedAt: "2026-07-15T14:00:00.000Z"
    });

    await runReconcile(db, [
      brokerOrder({ order_id: "EXT_OWNED", symbol: "NVDA.US", side: "Sell", quantity: 4, price: 130, status: "Filled", created_at: "2026-07-15T14:02:00.000Z" })
    ]);

    const stored = db
      .prepare(`SELECT owner_id FROM execution_reports WHERE category = 'trade'`)
      .all() as Array<{ owner_id: string | null }>;
    expect(stored).toEqual([{ owner_id: "member_1" }]);
  });

  it("records a rejected execution attempt instead of leaving it reportless", async () => {
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
    expect(updatedProposal?.status).toBe("executed");
    expect(updatedProposal?.ticketId).toBe(ticketId);
    const reports = new ExecutionReportRepository(db).listRecent(10, ["trade"]);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.body).toContain("已拒绝/过期");
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

// FIX 1a (matched-branch refresh): an unmapped broker status still proves an
// execution attempt exists and therefore gets one conservative report. A
// later Filled observation refreshes lifecycle truth without duplicating it.
describe("FIX 1a: matched-branch un-stick after adoption at an unmapped broker status", () => {
  it("adopt at unknown status closes the attempt conservatively; later Filled refresh stays idempotent", async () => {
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
    expect(new ProposalRepository(db).getById(proposal.id)?.status).toBe("executed");
    const unknownReports = new ExecutionReportRepository(db).listRecent(10, ["trade"]);
    expect(unknownReports).toHaveLength(1);
    expect(unknownReports[0]?.body).toContain("状态值尚未识别");

    // Pass 2: same order now reported Filled -> MATCHED branch must un-stick.
    const second = await runReconcile(db, [
      brokerOrder({ order_id: "EXT_UNMAPPED", symbol: "NVDA.US", side: "Buy", quantity: 7, price: 120, status: "Filled", created_at: "2026-07-15T14:02:00.000Z" })
    ], { nowIso: "2026-07-15T14:20:00.000Z" });
    expect(second.matched).toHaveLength(1);

    const updatedProposal = new ProposalRepository(db).getById(proposal.id);
    expect(updatedProposal?.status).toBe("executed");
    expect(updatedProposal?.ticketId).toBe(ticketId);
    const filledReports = new ExecutionReportRepository(db).listRecent(10, ["trade"]);
    expect(filledReports).toHaveLength(1);
    expect(filledReports[0]?.body).toContain("已确认成交");
    expect(filledReports[0]?.body).not.toContain("状态值尚未识别");
    expect(filledReports[0]?.metadata).toMatchObject({ lifecycleStage: "filled", brokerStatus: "Filled" });
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

// FIX 2: WaitToCancel/PendingCancel map to pending, so the report must record
// the execution attempt without claiming a fill.
describe("FIX 2: report wording reflects the actual broker lifecycle stage", () => {
  it("adopting a WaitToCancel order records the attempt without claiming a fill", async () => {
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
    expect(new ProposalRepository(db).getById(proposal.id)?.status).toBe("executed");
    const reports = new ExecutionReportRepository(db).listRecent(10, ["trade"]);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.body).toContain("已提交");
    expect(reports[0]?.body).not.toContain("已确认成交");
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

// ---------------------------------------------------------------------------
// F4/F5 (2026-07-28 round 3). These do NOT assert against a hand-written row
// shape: they run the REAL reconcileOfficialPaperOrders against a real temp
// sqlite db, read the row it actually wrote back out of the table, and hand
// that row to the REAL scheduled-report.mjs functions the owner's weekly
// personal page renders through. A row shape invented here to match the reader
// would prove nothing - that is exactly the fixture dishonesty that let F4 ship
// under a green suite.
//
// F4: classifyExecutionStatus tested the row's PROSE with
// /failed|API error|token empty|not valid JSON|Unexpected token/iu. Every body
// this writer emits ends with the constant line 「- 已将提案状态由 failed 更正为
// executed，并补记一条交易执行报告。」, so the English word `failed` inside that
// Chinese success sentence matched and the owner was told
// 「写入或回查失败，未确认为新成交。」 about a confirmed fill, 100% of the time.
// F5: the writer received limitPrice, spent it on notionalUsd, and stored it
// nowhere - so the same fill rendered with no price at all.
// ---------------------------------------------------------------------------
const scheduledReport = await import("./scheduled-report.mjs");

async function reconcileOneFilledOrder(
  db: DatabaseSync,
  over: { symbol: string; side: "buy" | "sell"; quantity: number; limitPrice: number; status?: string }
) {
  seedMember(db, "member_1");
  const proposal = seedProposal(db, { ownerId: "member_1", ...over });
  const ticketId = `ticket_prop_${proposal.id}`;
  new ProposalRepository(db).markFailed(proposal.id, "执行未确认（submit_unconfirmed）：模拟超时。");
  insertLifecycleRow(db, {
    id: "row_f4", ticketId, externalOrderId: null,
    symbol: over.symbol, side: over.side, quantity: over.quantity, limitPrice: over.limitPrice,
    lifecycleStage: "submit_unconfirmed", brokerStatus: "unconfirmed", localStatus: "pending",
    submittedAt: "2026-07-15T14:00:00.000Z"
  });
  await runReconcile(db, [
    brokerOrder({
      order_id: "EXT_F4",
      symbol: over.symbol,
      side: over.side === "sell" ? "Sell" : "Buy",
      quantity: over.quantity,
      price: over.limitPrice,
      status: over.status ?? "Filled",
      created_at: "2026-07-15T14:02:00.000Z"
    })
  ]);
  const row = db.prepare(`SELECT * FROM execution_reports WHERE category = 'trade'`).get() as Record<string, unknown>;
  expect(row).toBeTruthy();
  return row;
}

describe("F4: a reconciled fill is not reported to its owner as a failure", () => {
  it("classifies the REAL writer's row from its structured stage, not from the word 'failed' in its Chinese prose", async () => {
    const db = makeDb();
    const row = await reconcileOneFilledOrder(db, { symbol: "AAPL.US", side: "sell", quantity: 10, limitPrice: 210 });

    // The trigger string is still in the body - the fix is that it is no
    // longer what decides the verdict. If this assertion ever fails the test
    // below stops proving anything, so it is pinned deliberately.
    expect(String(row.body)).toContain("已将提案状态由 failed 更正为 executed");

    const summary = scheduledReport.summarizeExecutionRow(row);
    expect(summary.status).toBe("券商已确认成交。");
    expect(summary.status).not.toContain("失败");
  });

  it("a merely-live (submitted) reconciled order is not upgraded to a 成交 claim either", async () => {
    const db = makeDb();
    const row = await reconcileOneFilledOrder(db, { symbol: "AMZN.US", side: "buy", quantity: 6, limitPrice: 180, status: "New" });

    const summary = scheduledReport.summarizeExecutionRow(row);
    expect(summary.status).toBe("订单已提交至券商并存活，尚未观察到成交。");
  });
});

describe("F5: the reconciled report carries the price the writer already had", () => {
  it("stores limitPrice structurally and prints it as 限价 - never as a fill price", async () => {
    const db = makeDb();
    const row = await reconcileOneFilledOrder(db, { symbol: "AAPL.US", side: "sell", quantity: 10, limitPrice: 210 });

    const metadata = JSON.parse(String(row.metadata)) as Record<string, unknown>;
    expect(metadata.limitPrice).toBe(210);
    expect(metadata.fillPrice).toBeUndefined();
    expect(String(row.body)).toContain("限价：210.00");
    expect(String(row.body)).not.toContain("成交价");

    const facts = scheduledReport.extractExecutionFacts(row);
    expect(facts.price).toBe("210");
    expect(facts.priceKind).toBe("限价");
    expect(facts.sources.price).toBe("metadata");

    // What the owner's weekly page actually prints for this fill.
    expect(scheduledReport.summarizeExecutionRow(row, facts).summary)
      .toBe("标的 AAPL.US；方向 卖出；数量 10；限价 210。");
  });

  it("omits the price entirely when the broker order carried none, rather than printing a zero", async () => {
    const db = makeDb();
    seedMember(db, "member_1");
    const proposal = seedProposal(db, { ownerId: "member_1", symbol: "MSFT.US", side: "buy", quantity: 3 });
    const ticketId = `ticket_prop_${proposal.id}`;
    new ProposalRepository(db).markFailed(proposal.id, "执行未确认（submit_unconfirmed）：模拟超时。");
    insertLifecycleRow(db, {
      id: "row_f5_nopx", ticketId, externalOrderId: null,
      symbol: "MSFT.US", side: "buy", quantity: 3,
      lifecycleStage: "submit_unconfirmed", brokerStatus: "unconfirmed", localStatus: "pending",
      submittedAt: "2026-07-15T14:00:00.000Z"
    });
    await runReconcile(db, [
      { order_id: "EXT_NOPX", symbol: "MSFT.US", side: "Buy", quantity: 3, status: "Filled", created_at: "2026-07-15T14:02:00.000Z" }
    ]);

    const row = db.prepare(`SELECT * FROM execution_reports WHERE category = 'trade'`).get() as Record<string, unknown>;
    expect(String(row.body)).not.toContain("限价");
    expect(JSON.parse(String(row.metadata)).limitPrice).toBeUndefined();
    expect(scheduledReport.extractExecutionFacts(row).price).toBeNull();
  });
});
