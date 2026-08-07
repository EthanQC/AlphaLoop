import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  OfficialPaperOrderLifecycleRepository,
  ProposalRepository,
  createId,
  migrate,
  nowIso,
  type NewProposal,
  type Proposal
} from "@packages/shared-types";

import { createBrokerExecutorServer, deriveTicketId, type BrokerExecutorServerDeps } from "./server.js";
import type { LongbridgeExecFn } from "./longbridge-paper.js";

const SHARED_SECRET = "test-shared-secret-do-not-use-in-prod";
const AUTH_HEADERS = { "X-AlphaLoop-Broker-Secret": SHARED_SECRET, "content-type": "application/json" };

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function seedMember(db: DatabaseSync, id: string): void {
  db
    .prepare(`
      INSERT INTO members (id, email, feishu_open_id, display_name, risk_tags, stock_tags, show_performance, status, created_at)
      VALUES (?, ?, ?, ?, '[]', '[]', 1, 'active', ?)
    `)
    .run(id, `${id}@example.com`, `ou_${id}`, id, nowIso());
}

function seedSnapshot(
  db: DatabaseSync,
  opts: {
    ownerId: string | null;
    netAssets: number;
    marketValue: number;
    fetchedAt?: string;
    reason?: string;
    reportingCurrency?: string | null;
    cashInfos?: Array<{ currency: string; available_cash: string }>;
    positions?: Array<{
      symbol: string;
      quantity: number;
      available?: number;
      currency?: string;
      priceSource?: string;
      price?: number;
    }>;
  }
): void {
  const positions = (opts.positions ?? []).map((position) => ({ currency: "USD", ...position }));
  const primaryAsset = {
    net_assets: String(opts.netAssets),
    total_cash: "0",
    ...(opts.reportingCurrency === null ? {} : { currency: opts.reportingCurrency ?? "USD" }),
    ...(opts.cashInfos === undefined ? {} : { cash_infos: opts.cashInfos })
  };
  db
    .prepare(`
      INSERT INTO official_paper_snapshots
      (id, fetched_at, reason, net_assets, total_cash, market_value, positions, raw, owner_id)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
    `)
    .run(
      createId("snapshot"),
      opts.fetchedAt ?? nowIso(),
      opts.reason ?? "hourly_poll",
      opts.netAssets,
      opts.marketValue,
      JSON.stringify(positions),
      JSON.stringify({ primaryAsset, positions }),
      opts.ownerId
    );
}

function createApprovedProposal(
  db: DatabaseSync,
  // `Partial<NewProposal>` alone rejects an EXPLICIT `undefined` under this
  // repo's exactOptionalPropertyTypes, and the "approved proposal with no
  // limit price" case below overrides exactly that way - so limitPrice, and
  // only limitPrice, accepts it.
  overrides: Omit<Partial<NewProposal>, "limitPrice"> & { limitPrice?: number | undefined } = {},
  decision: "approved" | "approved_half" = "approved"
): Proposal {
  const repo = new ProposalRepository(db);
  // limitPrice is peeled off and re-added conditionally: NewProposal declares
  // it `limitPrice?: number`, and under exactOptionalPropertyTypes an explicit
  // `undefined` is NOT the same as absent. Absence is therefore expressed the
  // way production expresses it (see server.ts's finalizeExecution call), and
  // `"limitPrice" in overrides` is what distinguishes "caller wants no limit
  // price" from "caller said nothing, use the default".
  const { limitPrice: limitPriceOverride, ...restOverrides } = overrides;
  const limitPrice = "limitPrice" in overrides ? limitPriceOverride : 100;
  const created = repo.create({
    ownerId: "mem_owner",
    symbol: "AAPL.US",
    side: "buy",
    quantity: 10,
    orderType: "limit",
    reason: "test proposal",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    ...restOverrides,
    ...(limitPrice === undefined ? {} : { limitPrice })
  });

  const consumeResult = repo.consumeApproval(created.approvalToken as string, {
    decision,
    decidedBy: created.ownerId,
    decidedAt: nowIso()
  });

  if (!consumeResult.consumed || !consumeResult.proposal) {
    throw new Error("test setup: failed to approve proposal");
  }

  return consumeResult.proposal;
}

// A fake exec function that counts invocations and returns a fixed payload
// for the order-submission call; readOrderDetail's follow-up call gets the
// same payload back too (fine - both are JSON, both parse the same way).
function makeCountingExec(payload: Record<string, unknown>): { fn: LongbridgeExecFn; callCount: () => number } {
  let count = 0;
  const fn: LongbridgeExecFn = () => {
    count += 1;
    return JSON.stringify(payload);
  };
  return { fn, callCount: () => count };
}

function makeThrowingExec(message: string): { fn: LongbridgeExecFn; callCount: () => number } {
  let count = 0;
  const fn: LongbridgeExecFn = () => {
    count += 1;
    throw new Error(message);
  };
  return { fn, callCount: () => count };
}

describe("createBrokerExecutorServer", () => {
  describe("Global Constraint ① - fail-loud startup on missing shared secret", () => {
    it("throws synchronously when sharedSecret is empty", () => {
      const db = memoryDb();
      expect(() => createBrokerExecutorServer({ db, sharedSecret: "" })).toThrow(
        /BROKER_EXECUTOR_SHARED_SECRET/
      );
    });

    it("throws synchronously when sharedSecret is whitespace-only", () => {
      const db = memoryDb();
      expect(() => createBrokerExecutorServer({ db, sharedSecret: "   " })).toThrow();
    });

    it("does not throw when sharedSecret is set", () => {
      const db = memoryDb();
      expect(() => createBrokerExecutorServer({ db, sharedSecret: SHARED_SECRET })).not.toThrow();
    });
  });

  describe("HTTP negative matrix and record-before-execute sequence", () => {
    let db: DatabaseSync;
    let server: ReturnType<typeof createBrokerExecutorServer>;
    let previousMode: string | undefined;
    let previousEnabled: string | undefined;
    let previousLive: string | undefined;

    function startServer(deps: Partial<BrokerExecutorServerDeps> = {}) {
      server = createBrokerExecutorServer({
        db,
        sharedSecret: SHARED_SECRET,
        executionContextResolver: () => ({ mode: "legacy-global", env: { ...process.env } }),
        ...deps
      });
      return new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
      });
    }

    beforeEach(async () => {
      db = memoryDb();
      seedMember(db, "mem_owner");
      seedMember(db, "mem_other");
      // executeLongbridgePaperOrder's own guard (longbridge-paper.ts,
      // validateOfficialPaperGuard) requires these three env vars regardless
      // of execFn injection - without them it returns a normal "rejected"
      // result (no order_id) BEFORE ever calling the injected fake exec fn,
      // which this suite's success-path tests would misread as
      // submit_unconfirmed. Real production wiring sets these in
      // .env.local; tests set them here explicitly.
      previousMode = process.env.LONGBRIDGE_ACCOUNT_MODE;
      previousEnabled = process.env.LONGBRIDGE_OFFICIAL_PAPER_ENABLED;
      previousLive = process.env.ALLOW_LIVE_EXECUTION;
      process.env.LONGBRIDGE_ACCOUNT_MODE = "paper";
      process.env.LONGBRIDGE_OFFICIAL_PAPER_ENABLED = "true";
      process.env.ALLOW_LIVE_EXECUTION = "false";
    });

    afterEach(async () => {
      if (previousMode === undefined) {
        delete process.env.LONGBRIDGE_ACCOUNT_MODE;
      } else {
        process.env.LONGBRIDGE_ACCOUNT_MODE = previousMode;
      }
      if (previousEnabled === undefined) {
        delete process.env.LONGBRIDGE_OFFICIAL_PAPER_ENABLED;
      } else {
        process.env.LONGBRIDGE_OFFICIAL_PAPER_ENABLED = previousEnabled;
      }
      if (previousLive === undefined) {
        delete process.env.ALLOW_LIVE_EXECUTION;
      } else {
        process.env.ALLOW_LIVE_EXECUTION = previousLive;
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("401s when the X-AlphaLoop-Broker-Secret header is missing", async () => {
      await startServer();
      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposalId: "whatever" })
      });
      expect(response.status).toBe(401);
    });

    it("401s when the X-AlphaLoop-Broker-Secret header is wrong", async () => {
      await startServer();
      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-AlphaLoop-Broker-Secret": "wrong-secret" },
        body: JSON.stringify({ proposalId: "whatever" })
      });
      expect(response.status).toBe(401);
    });

    it("403s when proposalId is missing from the body (also covers the retired direct-ticket body shape)", async () => {
      await startServer();
      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          ticket: { id: "manual_1", symbol: "AAPL.US", side: "buy", quantity: 1 }
        })
      });
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toMatch(/proposalId/);
    });

    it("403s with a distinct message when the proposal does not exist", async () => {
      await startServer();
      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: "proposal_does_not_exist" })
      });
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toMatch(/不存在/);
    });

    it("403s with a distinct message when the proposal is still pending (never approved)", async () => {
      await startServer();
      const repo = new ProposalRepository(db);
      const pending = repo.create({
        ownerId: "mem_owner",
        symbol: "AAPL.US",
        side: "buy",
        quantity: 1,
        orderType: "limit",
        limitPrice: 100,
        reason: "still pending",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString()
      });

      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: pending.id })
      });
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toMatch(/状态不允许执行/);
      expect(body.error).toMatch(/pending/);
    });

    it("403s with a distinct message when the proposal was rejected", async () => {
      await startServer();
      const rejected = createApprovedProposal(db, {}, "approved");
      // Flip a SEPARATE proposal to rejected via the normal channel.
      const repo = new ProposalRepository(db);
      const created = repo.create({
        ownerId: "mem_owner",
        symbol: "MSFT.US",
        side: "buy",
        quantity: 1,
        orderType: "limit",
        limitPrice: 50,
        reason: "will be rejected",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString()
      });
      repo.consumeApproval(created.approvalToken as string, {
        decision: "rejected",
        decidedBy: created.ownerId,
        decidedAt: nowIso()
      });

      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: created.id })
      });
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toMatch(/rejected/);
      // Sanity: the untouched approved proposal from this test is not involved.
      expect(rejected.status).toBe("approved");
    });

    it("403s with a distinct 'already has a ticket' message when the proposal's ticket_id is already set (defense in depth beyond the replay path)", async () => {
      await startServer();
      const approved = createApprovedProposal(db);
      // Simulate a corrupted/edge-case state: ticket_id set but status never
      // moved past approved (markExecuted always sets both together in the
      // real write path - this covers the defensive branch regardless).
      db.prepare(`UPDATE proposals SET ticket_id = 'ticket_prop_some_other_id' WHERE id = ?`).run(approved.id);

      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: approved.id })
      });
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toMatch(/已关联工单/);
    });

    it("400s when the approved proposal has no limit price (cannot risk-gate a market order)", async () => {
      await startServer();
      const approved = createApprovedProposal(db, { limitPrice: undefined });

      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: approved.id })
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toMatch(/限价/);
    });

    it("400s when the risk budget is exceeded (missing/stale account snapshot -> untrusted facts -> block)", async () => {
      await startServer();
      const approved = createApprovedProposal(db);
      // No snapshot seeded at all - evaluateRisk blocks paper buys with no
      // trusted official-paper facts.

      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: approved.id })
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(Array.isArray(body.reasons)).toBe(true);
    });

    it("200s on success: executes exactly once, records the lifecycle row, marks the proposal executed, saves a report", async () => {
      seedSnapshot(db, { ownerId: "mem_owner", netAssets: 100_000, marketValue: 0 });
      const { fn, callCount } = makeCountingExec({ order_id: "ext_success_1", status: "Filled", executed_price: "100.00" });
      await startServer({ execFn: fn });

      const approved = createApprovedProposal(db, { quantity: 1, limitPrice: 100 });

      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: approved.id })
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.externalOrderId).toBe("ext_success_1");
      expect(body.ticketId).toBe(deriveTicketId(approved.id));
      // Two calls: submit + the follow-up order-detail lookup - both count
      // as ONE logical execution, not a re-execution.
      expect(callCount()).toBe(2);

      const proposalsRepo = new ProposalRepository(db);
      const finalProposal = proposalsRepo.getById(approved.id);
      expect(finalProposal?.status).toBe("executed");
      expect(finalProposal?.ticketId).toBe(deriveTicketId(approved.id));

      const lifecycleRow = db
        .prepare(`SELECT * FROM official_paper_order_lifecycle WHERE ticket_id = ?`)
        .get(deriveTicketId(approved.id)) as Record<string, unknown>;
      expect(lifecycleRow.external_order_id).toBe("ext_success_1");
      expect(lifecycleRow.owner_id).toBe("mem_owner");

      const reportCount = (
        db.prepare(`SELECT COUNT(*) c FROM execution_reports`).get() as { c: number }
      ).c;
      expect(reportCount).toBe(1);
    });

    // C1 (2026-07-28 adversarial review): execution_reports rows are written
    // HERE, after one specific member's proposal fills - and until v17 they
    // carried no owner at all, which is why the public daily/weekly could
    // print every member's fills with no owner dimension to filter on. An
    // unstamped row is unattributable forever (nothing downstream can recover
    // who placed it), so the stamp has to happen at the write.
    it("stamps the execution report with the proposal's owner, so the row is attributable to exactly one member", async () => {
      seedSnapshot(db, { ownerId: "mem_owner", netAssets: 100_000, marketValue: 0 });
      const { fn } = makeCountingExec({ order_id: "ext_owner_1", status: "Filled", executed_price: "100.00" });
      await startServer({ execFn: fn });

      const approved = createApprovedProposal(db, { quantity: 1, limitPrice: 100 });
      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: approved.id })
      });
      expect(response.status).toBe(200);
      const body = await response.json();

      const reportRow = db
        .prepare(`SELECT owner_id, category FROM execution_reports WHERE id = ?`)
        .get(body.reportId) as { owner_id: string | null; category: string };
      expect(reportRow.category).toBe("trade");
      expect(reportRow.owner_id).toBe("mem_owner");
      // No unattributed row may be produced by this path at all.
      expect(
        (db.prepare(`SELECT COUNT(*) c FROM execution_reports WHERE owner_id IS NULL`).get() as { c: number }).c
      ).toBe(0);
    });

    it("idempotent replay: two identical POSTs for the same proposal execute the broker call exactly once (200 both times)", async () => {
      seedSnapshot(db, { ownerId: "mem_owner", netAssets: 100_000, marketValue: 0 });
      const { fn, callCount } = makeCountingExec({ order_id: "ext_replay_1", status: "Filled" });
      await startServer({ execFn: fn });

      const approved = createApprovedProposal(db, { quantity: 1, limitPrice: 100 });
      const requestInit = {
        method: "POST" as const,
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: approved.id })
      };

      const first = await fetch(`${baseUrl(server)}/v1/tickets`, requestInit);
      expect(first.status).toBe(200);
      const firstBody = await first.json();
      expect(firstBody.replay).toBeUndefined();

      const callsAfterFirst = callCount();
      expect(callsAfterFirst).toBeGreaterThan(0);

      const second = await fetch(`${baseUrl(server)}/v1/tickets`, requestInit);
      expect(second.status).toBe(200);
      const secondBody = await second.json();
      expect(secondBody.replay).toBe(true);
      expect(secondBody.externalOrderId).toBe("ext_replay_1");

      // THE core idempotency assertion: the underlying exec fn was NOT
      // called again on the replay.
      expect(callCount()).toBe(callsAfterFirst);
    });

    it("repairs the report and proposal on replay after a post-submit local write failure without re-submitting", async () => {
      seedSnapshot(db, { ownerId: "mem_owner", netAssets: 100_000, marketValue: 0 });
      const { fn, callCount } = makeCountingExec({
        order_id: "ext_repair_after_report_failure",
        status: "Filled",
        executed_price: "100.00"
      });
      await startServer({ execFn: fn });

      const approved = createApprovedProposal(db, { quantity: 1, limitPrice: 100 });
      const requestInit = {
        method: "POST" as const,
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: approved.id })
      };
      db.exec(`
        CREATE TRIGGER fail_execution_report_insert
        BEFORE INSERT ON execution_reports
        BEGIN
          SELECT RAISE(ABORT, 'injected execution report write failure');
        END;
      `);

      const first = await fetch(`${baseUrl(server)}/v1/tickets`, requestInit);
      expect(first.status).toBe(500);
      expect(callCount()).toBeGreaterThan(0);
      const callsAfterBrokerAccepted = callCount();
      const lifecycleAfterFailure = db
        .prepare(`SELECT external_order_id, lifecycle_stage FROM official_paper_order_lifecycle WHERE ticket_id = ?`)
        .get(deriveTicketId(approved.id)) as { external_order_id: string | null; lifecycle_stage: string };
      expect(lifecycleAfterFailure).toMatchObject({
        external_order_id: "ext_repair_after_report_failure",
        lifecycle_stage: "filled"
      });
      expect(new ProposalRepository(db).getById(approved.id)?.status).toBe("approved");
      expect((db.prepare(`SELECT COUNT(*) AS count FROM execution_reports`).get() as { count: number }).count).toBe(0);

      db.exec(`DROP TRIGGER fail_execution_report_insert;`);
      const replay = await fetch(`${baseUrl(server)}/v1/tickets`, requestInit);
      expect(replay.status).toBe(200);
      const replayBody = await replay.json();
      expect(replayBody).toMatchObject({
        replay: true,
        externalOrderId: "ext_repair_after_report_failure"
      });
      expect(typeof replayBody.reportId).toBe("string");
      expect(callCount()).toBe(callsAfterBrokerAccepted);
      expect(new ProposalRepository(db).getById(approved.id)).toMatchObject({
        status: "executed",
        ticketId: deriveTicketId(approved.id)
      });
      expect((db.prepare(`SELECT COUNT(*) AS count FROM execution_reports`).get() as { count: number }).count).toBe(1);
    });

    it("submit_unconfirmed (507) when the CLI call throws, marks lifecycle stage submit_unconfirmed and the proposal failed - and does NOT re-execute on replay", async () => {
      seedSnapshot(db, { ownerId: "mem_owner", netAssets: 100_000, marketValue: 0 });
      const { fn, callCount } = makeThrowingExec("spawn ENOENT: longbridge binary not found");
      await startServer({ execFn: fn });

      const approved = createApprovedProposal(db, { quantity: 1, limitPrice: 100 });
      const requestInit = {
        method: "POST" as const,
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: approved.id })
      };

      const first = await fetch(`${baseUrl(server)}/v1/tickets`, requestInit);
      expect(first.status).toBe(507);
      const firstBody = await first.json();
      expect(firstBody.unconfirmed).toBe(true);

      const lifecycleRow = db
        .prepare(`SELECT lifecycle_stage, external_order_id FROM official_paper_order_lifecycle WHERE ticket_id = ?`)
        .get(deriveTicketId(approved.id)) as Record<string, unknown>;
      expect(lifecycleRow.lifecycle_stage).toBe("submit_unconfirmed");
      expect(lifecycleRow.external_order_id).toBeNull();

      const proposalsRepo = new ProposalRepository(db);
      expect(proposalsRepo.getById(approved.id)?.status).toBe("failed");

      const callsAfterFirst = callCount();

      // Replay: must NOT call the broker again.
      const second = await fetch(`${baseUrl(server)}/v1/tickets`, requestInit);
      expect(second.status).toBe(507);
      const secondBody = await second.json();
      expect(secondBody.replay).toBe(true);
      expect(callCount()).toBe(callsAfterFirst);
    });

    // FIX 5: the throw/timeout path (submit_unconfirmed, 507) previously put
    // the raw (error as Error).message straight into the HTTP response AND
    // into proposals.markFailed's persisted `outcome` column - unlike the
    // success path (sanitizeExecutionResult) and the missing-order-id path,
    // this one skipped redactSensitiveText entirely, so a secret-shaped
    // token captured in execFileSync stderr would leak out both live and at
    // rest.
    it("redacts a secret-shaped token out of the HTTP response AND the persisted proposal/lifecycle rows when the CLI call throws", async () => {
      seedSnapshot(db, { ownerId: "mem_owner", netAssets: 100_000, marketValue: 0 });
      const secretToken = "sk-testtoken1234567890abcdef";
      const { fn } = makeThrowingExec(`spawn failed, leaked token=${secretToken} in stderr`);
      await startServer({ execFn: fn });

      const approved = createApprovedProposal(db, { quantity: 1, limitPrice: 100 });
      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: approved.id })
      });

      expect(response.status).toBe(507);
      const body = await response.json();
      expect(body.error).not.toContain(secretToken);

      const lifecycleRow = db
        .prepare(`SELECT notes FROM official_paper_order_lifecycle WHERE ticket_id = ?`)
        .get(deriveTicketId(approved.id)) as Record<string, unknown>;
      expect(String(lifecycleRow.notes)).not.toContain(secretToken);

      const proposalsRepo = new ProposalRepository(db);
      expect(proposalsRepo.getById(approved.id)?.outcome ?? "").not.toContain(secretToken);
    });

    it("submit_unconfirmed (507) on a timeout-shaped throw (killed/SIGTERM), same as a generic throw", async () => {
      seedSnapshot(db, { ownerId: "mem_owner", netAssets: 100_000, marketValue: 0 });
      const timeoutError = Object.assign(new Error("Command timed out"), { killed: true, signal: "SIGTERM" });
      const fn: LongbridgeExecFn = () => {
        throw timeoutError;
      };
      await startServer({ execFn: fn });

      const approved = createApprovedProposal(db, { quantity: 1, limitPrice: 100 });
      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: approved.id })
      });

      expect(response.status).toBe(507);
      const body = await response.json();
      expect(body.unconfirmed).toBe(true);
      expect(body.error).toMatch(/timed out/);

      const lifecycleRow = db
        .prepare(`SELECT lifecycle_stage FROM official_paper_order_lifecycle WHERE ticket_id = ?`)
        .get(deriveTicketId(approved.id)) as Record<string, unknown>;
      expect(lifecycleRow.lifecycle_stage).toBe("submit_unconfirmed");
    });

    it("budget gate with open orders: two 9.5% orders for the same owner - the second is blocked (400) because the first's still-open notional counts against the same account snapshot", async () => {
      // net_assets 100,000; each order is 95 shares * $100 = $9,500 = 9.5%.
      seedSnapshot(db, { ownerId: "mem_owner", netAssets: 100_000, marketValue: 0 });
      // First order's fake broker response reports "Pending" -> maps to
      // lifecycle_stage 'pending', which DOES count as an open order in the
      // budget sum (Global Constraint ④: stage IN submitting/accepted/pending).
      const { fn } = makeCountingExec({ order_id: "ext_budget_1", status: "Pending" });
      await startServer({ execFn: fn });

      const firstProposal = createApprovedProposal(db, { symbol: "AAPL.US", quantity: 95, limitPrice: 100 });
      const firstResponse = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: firstProposal.id })
      });
      expect(firstResponse.status).toBe(200);

      const secondProposal = createApprovedProposal(db, { symbol: "MSFT.US", quantity: 95, limitPrice: 100 });
      const secondResponse = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: secondProposal.id })
      });

      expect(secondResponse.status).toBe(400);
      const secondBody = await secondResponse.json();
      expect(secondBody.reasons.join(" ")).toMatch(/含未成交挂单/);

      // The second proposal must NOT have been executed or recorded.
      const secondProposalAfter = new ProposalRepository(db).getById(secondProposal.id);
      expect(secondProposalAfter?.status).toBe("approved");
      const secondLifecycle = db
        .prepare(`SELECT 1 FROM official_paper_order_lifecycle WHERE ticket_id = ?`)
        .get(deriveTicketId(secondProposal.id));
      expect(secondLifecycle).toBeUndefined();
    });

    it("fails closed when a broker-observed active order has no trustworthy price", async () => {
      seedSnapshot(db, { ownerId: "mem_owner", netAssets: 100_000, marketValue: 0 });
      const lifecycle = new OfficialPaperOrderLifecycleRepository(db);
      lifecycle.insertSubmitting({
        ticketId: "external_unpriced", ownerId: "mem_owner", symbol: "IBM.US", assetClass: "stock",
        side: "buy", quantity: 100, submittedAt: nowIso()
      });
      lifecycle.finalizeExecution("external_unpriced", {
        externalOrderId: "ext_unpriced", brokerStatus: "New", localStatus: "submitted",
        lifecycleStage: "submitted", notes: [], observedAt: nowIso()
      });
      const { fn, callCount } = makeCountingExec({ order_id: "must_not_execute", status: "New" });
      await startServer({ execFn: fn });

      const proposal = createApprovedProposal(db, { symbol: "AAPL.US", quantity: 1, limitPrice: 100 });
      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: proposal.id })
      });

      expect(response.status).toBe(400);
      expect(callCount()).toBe(0);
      expect((await response.json()).reasons.join(" ")).toMatch(/新鲜可信/);
    });

    // FIX 2 end-to-end: a sell-to-open (owner holds no position) over the
    // 10% budget must be BLOCKED at the HTTP layer, wiring the snapshot's
    // positions JSON through to risk.ts's heldQuantityForSymbol gate.
    it("blocks a naked-short sell (no held position) over the 10% budget end-to-end", async () => {
      seedSnapshot(db, { ownerId: "mem_owner", netAssets: 100_000, marketValue: 0, positions: [] });
      const { fn } = makeCountingExec({ order_id: "ext_short", status: "New" });
      await startServer({ execFn: fn });

      // 200 shares * $100 = $20,000 = 20% of net liq, no held position at all.
      const proposal = createApprovedProposal(db, {
        symbol: "TSLA.US",
        side: "sell",
        quantity: 200,
        limitPrice: 100
      });
      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: proposal.id })
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.reasons.join(" ")).toMatch(/单个想法暴露/);
    });

    it("fails closed on a below-budget sell-to-open because short exposure is not yet observable", async () => {
      seedSnapshot(db, { ownerId: "mem_owner", netAssets: 100_000, marketValue: 0, positions: [] });
      const { fn, callCount } = makeCountingExec({ order_id: "ext_small_short", status: "New" });
      await startServer({ execFn: fn });

      const proposal = createApprovedProposal(db, {
        symbol: "TSLA.US",
        side: "sell",
        quantity: 10,
        limitPrice: 100
      });
      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: proposal.id })
      });

      expect(response.status).toBe(400);
      expect(((await response.json()) as { reasons: string[] }).reasons.join(" ")).toMatch(/卖空|多头持仓/u);
      expect(callCount()).toBe(0);
    });

    it("blocks a buy when a fresh snapshot contains a cost/zero-priced position", async () => {
      seedSnapshot(db, {
        ownerId: "mem_owner",
        netAssets: 100_000,
        marketValue: 0,
        positions: [{ symbol: "NVDA.US", quantity: 10, priceSource: "zero", price: 0 }]
      });
      const { fn, callCount } = makeCountingExec({ order_id: "ext_degraded_buy", status: "New" });
      await startServer({ execFn: fn });

      const proposal = createApprovedProposal(db, { symbol: "AAPL.US", quantity: 1, limitPrice: 100 });
      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: proposal.id })
      });

      expect(response.status).toBe(400);
      expect(((await response.json()) as { reasons: string[] }).reasons.join(" ")).toMatch(/估值|实时价格/u);
      expect(callCount()).toBe(0);
    });

    it("rebuilds a HKD-reporting account on a USD basis before applying the USD ticket cap", async () => {
      seedSnapshot(db, {
        ownerId: "mem_owner",
        netAssets: 860_613.64,
        marketValue: 721.89,
        reportingCurrency: "HKD",
        cashInfos: [
          { currency: "USD", available_cash: "122079.05" },
          { currency: "HKD", available_cash: "0.00" }
        ],
        positions: [
          { symbol: "QQQ.US", currency: "USD", quantity: 1, priceSource: "live", price: 721.89 }
        ]
      });
      const { fn, callCount } = makeCountingExec({ order_id: "must_not_execute_fx_mixed", status: "New" });
      await startServer({ execFn: fn });

      // $13,000 is only 1.51% if the HKD number 860,613.64 is incorrectly
      // treated as USD, but exceeds 10% of the verifiable USD basis:
      // 122,079.05 cash + 721.89 QQQ = 122,800.94 USD.
      const proposal = createApprovedProposal(db, { symbol: "AAPL.US", quantity: 130, limitPrice: 100 });
      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: proposal.id })
      });

      expect(response.status).toBe(400);
      expect(((await response.json()) as { reasons: string[] }).reasons.join(" ")).toMatch(/官方模拟盘预算/u);
      expect(callCount()).toBe(0);
    });

    it("rejects an approved HK-market proposal before creating an execution lease or calling the broker", async () => {
      seedSnapshot(db, {
        ownerId: "mem_owner",
        netAssets: 100_000,
        marketValue: 0,
        reportingCurrency: "USD",
        positions: []
      });
      const { fn, callCount } = makeCountingExec({ order_id: "must_not_execute_hkd_ticket", status: "New" });
      await startServer({ execFn: fn });

      const proposal = createApprovedProposal(db, { symbol: "0700.HK", quantity: 100, limitPrice: 300 });
      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: proposal.id })
      });

      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toMatch(/美股|\.US|美元/u);
      expect(callCount()).toBe(0);
      expect(
        db.prepare("SELECT 1 FROM official_paper_order_lifecycle WHERE ticket_id = ?")
          .get(deriveTicketId(proposal.id))
      ).toBeUndefined();
    });

    it("fails closed for new USD risk when a non-USD account has no trustworthy conversion basis", async () => {
      seedSnapshot(db, {
        ownerId: "mem_owner",
        netAssets: 860_613.64,
        marketValue: 721.89,
        reportingCurrency: "HKD",
        // Both buckets are funded, but raw carries no broker FX quote that
        // can translate the HKD amount into the USD ticket basis.
        cashInfos: [
          { currency: "USD", available_cash: "122079.05" },
          { currency: "HKD", available_cash: "1000.00" }
        ],
        positions: [
          { symbol: "QQQ.US", currency: "USD", quantity: 1, priceSource: "live", price: 721.89 }
        ]
      });
      const { fn, callCount } = makeCountingExec({ order_id: "must_not_execute_fx_unknown", status: "New" });
      await startServer({ execFn: fn });

      const proposal = createApprovedProposal(db, { symbol: "AAPL.US", quantity: 1, limitPrice: 100 });
      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: proposal.id })
      });

      expect(response.status).toBe(400);
      expect(((await response.json()) as { reasons: string[] }).reasons.join(" ")).toMatch(/币种|美元|估值/u);
      expect(callCount()).toBe(0);
    });

    it("keeps a covered sell available when currency conversion is unavailable", async () => {
      seedSnapshot(db, {
        ownerId: "mem_owner",
        netAssets: 860_613.64,
        marketValue: 20_000,
        reportingCurrency: "HKD",
        positions: [
          { symbol: "TSLA.US", currency: "USD", quantity: 200, available: 200, priceSource: "live", price: 100 }
        ]
      });
      const { fn } = makeCountingExec({ order_id: "ext_fx_unknown_derisk", status: "New" });
      await startServer({ execFn: fn });

      const proposal = createApprovedProposal(db, {
        symbol: "TSLA.US",
        side: "sell",
        quantity: 200,
        limitPrice: 100
      });
      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: proposal.id })
      });

      expect(response.status).toBe(200);
    });

    it("keeps same-USD snapshots on the normal budget path", async () => {
      seedSnapshot(db, {
        ownerId: "mem_owner",
        netAssets: 100_000,
        marketValue: 0,
        reportingCurrency: "USD",
        positions: []
      });
      const { fn } = makeCountingExec({ order_id: "ext_same_usd", status: "New" });
      await startServer({ execFn: fn });

      const proposal = createApprovedProposal(db, { symbol: "AAPL.US", quantity: 1, limitPrice: 100 });
      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: proposal.id })
      });

      expect(response.status).toBe(200);
    });

    it("recomputes gross exposure from mixed long/short positions instead of trusting a net market_value", async () => {
      seedSnapshot(db, {
        ownerId: "mem_owner",
        netAssets: 100_000,
        // Simulates a historical/netted row: +8k long and -4k short were
        // persisted as 4k. Gross is 12k, already over the 10% cap.
        marketValue: 4_000,
        positions: [
          { symbol: "AAPL.US", quantity: 80, priceSource: "live", price: 100 },
          { symbol: "TSLA.US", quantity: -40, priceSource: "live", price: 100 }
        ]
      });
      const { fn, callCount } = makeCountingExec({ order_id: "ext_netted_buy", status: "New" });
      await startServer({ execFn: fn });

      const proposal = createApprovedProposal(db, { symbol: "NVDA.US", quantity: 1, limitPrice: 100 });
      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: proposal.id })
      });

      expect(response.status).toBe(400);
      expect(((await response.json()) as { reasons: string[] }).reasons.join(" ")).toMatch(/官方模拟盘预算/u);
      expect(callCount()).toBe(0);
    });

    it("never lowers a larger recorded exposure when the position array is empty", async () => {
      seedSnapshot(db, {
        ownerId: "mem_owner",
        netAssets: 100_000,
        marketValue: 9_000,
        positions: []
      });
      const { fn, callCount } = makeCountingExec({ order_id: "ext_preserve_exposure", status: "New" });
      await startServer({ execFn: fn });

      const proposal = createApprovedProposal(db, { symbol: "NVDA.US", quantity: 20, limitPrice: 100 });
      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: proposal.id })
      });

      expect(response.status).toBe(400);
      expect(((await response.json()) as { reasons: string[] }).reasons.join(" ")).toMatch(/官方模拟盘预算/u);
      expect(callCount()).toBe(0);
    });

    // Companion: a sell fully within the held long is NOT blocked, even
    // though the same notional would be over budget for a naked short.
    it("allows a de-risking sell within the held long over the same notional that would block a naked short", async () => {
      seedSnapshot(db, {
        ownerId: "mem_owner",
        netAssets: 100_000,
        marketValue: 20_000,
        positions: [{ symbol: "TSLA.US", quantity: 200, available: 200 }]
      });
      const { fn } = makeCountingExec({ order_id: "ext_derisk", status: "New" });
      await startServer({ execFn: fn });

      const proposal = createApprovedProposal(db, {
        symbol: "TSLA.US",
        side: "sell",
        quantity: 200,
        limitPrice: 100
      });
      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: proposal.id })
      });

      expect(response.status).toBe(200);
    });

    it("sums duplicate positive position rows for the same symbol before evaluating a covered sell", async () => {
      seedSnapshot(db, {
        ownerId: "mem_owner",
        netAssets: 100_000,
        marketValue: 15_000,
        positions: [
          { symbol: "TSLA.US", quantity: 60, available: 60 },
          { symbol: "TSLA.US", quantity: 40, available: 40 }
        ]
      });
      const { fn } = makeCountingExec({ order_id: "ext_duplicate_positive", status: "New" });
      await startServer({ execFn: fn });

      const proposal = createApprovedProposal(db, {
        symbol: "TSLA.US",
        side: "sell",
        quantity: 100,
        limitPrice: 150
      });
      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: proposal.id })
      });

      expect(response.status).toBe(200);
    });

    it("nets mixed-sign duplicate position rows before allowing a covered sell", async () => {
      seedSnapshot(db, {
        ownerId: "mem_owner",
        netAssets: 100_000,
        marketValue: 7_000,
        positions: [
          { symbol: "TSLA.US", quantity: 40, available: 10 },
          { symbol: "TSLA.US", quantity: -30, available: 0 }
        ]
      });
      const { fn, callCount } = makeCountingExec({ order_id: "must_not_sell_mixed_position", status: "New" });
      await startServer({ execFn: fn });

      const proposal = createApprovedProposal(db, {
        symbol: "TSLA.US",
        side: "sell",
        quantity: 40,
        limitPrice: 100
      });
      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: proposal.id })
      });

      expect(response.status).toBe(400);
      expect(((await response.json()) as { reasons: string[] }).reasons.join(" ")).toMatch(/卖空|多头持仓/u);
      expect(callCount()).toBe(0);
    });

    it("does not treat frozen shares with available zero as covered-sell capacity", async () => {
      seedSnapshot(db, {
        ownerId: "mem_owner",
        netAssets: 100_000,
        marketValue: 10_000,
        positions: [{ symbol: "AAPL.US", quantity: 100, available: 0 }]
      });
      const { fn, callCount } = makeCountingExec({ order_id: "must_not_sell_frozen", status: "New" });
      await startServer({ execFn: fn });

      const proposal = createApprovedProposal(db, {
        symbol: "AAPL.US", side: "sell", quantity: 100, limitPrice: 100
      });
      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: proposal.id })
      });

      expect(response.status).toBe(400);
      expect(callCount()).toBe(0);
    });

    it("caps covered-sell capacity at available when it is below total quantity", async () => {
      seedSnapshot(db, {
        ownerId: "mem_owner",
        netAssets: 100_000,
        marketValue: 10_000,
        positions: [{ symbol: "AAPL.US", quantity: 100, available: 25 }]
      });
      const { fn, callCount } = makeCountingExec({ order_id: "must_not_sell_beyond_available", status: "New" });
      await startServer({ execFn: fn });

      const proposal = createApprovedProposal(db, {
        symbol: "AAPL.US", side: "sell", quantity: 50, limitPrice: 100
      });
      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: proposal.id })
      });

      expect(response.status).toBe(400);
      expect(callCount()).toBe(0);
    });

    // FIX 1 (order-splitting naked short): the sell exemption must not
    // double-spend the SAME held shares across sequential sells. Hold 150 ->
    // sell A 150 (within held, exempt, resting at the broker) -> sell B 150
    // minutes later: the snapshot still says held=150 (it does not see the
    // resting sell), so without deducting the owner's own open sell orders
    // the second full-size sell also reads as exempt and the account nets
    // short 150 with zero risk flags.
    it("blocks the second sell of the full held quantity while the first sell is still resting (open sells deducted from the snapshot's held quantity)", async () => {
      seedSnapshot(db, {
        ownerId: "mem_owner",
        netAssets: 100_000,
        marketValue: 15_000,
        positions: [{ symbol: "TSLA.US", quantity: 150, available: 150 }]
      });
      // A single owner/account cannot reuse an external broker order id.
      let orderCounter = 0;
      const fn: LongbridgeExecFn = () => {
        orderCounter += 1;
        return JSON.stringify({ order_id: `ext_split_${orderCounter}`, status: "New" });
      };
      await startServer({ execFn: fn });

      // Sell A: 150 shares, fully within the held 150 -> risk-reducing, allowed.
      const sellA = createApprovedProposal(db, {
        symbol: "TSLA.US",
        side: "sell",
        quantity: 150,
        limitPrice: 100
      });
      const responseA = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: sellA.id })
      });
      expect(responseA.status).toBe(200);

      // Sell B: the SAME 150 held shares again while sell A rests ('New' ->
      // stage 'submitted'). Effective held = 150 - 150 open sells = 0, so the
      // full $15,000 (15% of net liq) counts as risk-increasing -> blocked.
      const sellB = createApprovedProposal(db, {
        symbol: "TSLA.US",
        side: "sell",
        quantity: 150,
        limitPrice: 100
      });
      const responseB = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: sellB.id })
      });

      expect(responseB.status).toBe(400);
      const bodyB = await responseB.json();
      expect(bodyB.reasons.join(" ")).toMatch(/单个想法暴露/);

      // Sell B must NOT have been recorded or executed.
      const sellBLifecycle = db
        .prepare(`SELECT 1 FROM official_paper_order_lifecycle WHERE ticket_id = ?`)
        .get(deriveTicketId(sellB.id));
      expect(sellBLifecycle).toBeUndefined();
    });

    // FIX 2 (symbol-format mismatch): snapshots hold Longbridge-suffixed
    // symbols ('AAPL.US') while a proposal may carry a bare 'AAPL'. The held
    // lookup must normalize both sides, or a legitimate full de-risking sell
    // reads held=undefined -> conservative 0 -> 400-blocked.
    it("finds the held position for a bare-symbol proposal ('AAPL' vs snapshot 'AAPL.US') and allows the de-risking sell within it", async () => {
      seedSnapshot(db, {
        ownerId: "mem_owner",
        netAssets: 100_000,
        marketValue: 15_000,
        positions: [{ symbol: "AAPL.US", quantity: 100, available: 100 }]
      });
      const cliCalls: string[][] = [];
      const fn: LongbridgeExecFn = (_command, args) => {
        cliCalls.push([...args]);
        return JSON.stringify({ order_id: "ext_bare_symbol", status: "New" });
      };
      await startServer({ execFn: fn });

      // 100 shares * $150 = $15,000 = 15% of net liq: over the 10% cap for a
      // naked short, fine as a de-risking sell of the held 100 - IF the bare
      // 'AAPL' is matched against the snapshot's 'AAPL.US'.
      const proposal = createApprovedProposal(db, {
        symbol: "AAPL",
        side: "sell",
        quantity: 100,
        limitPrice: 150
      });
      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: proposal.id })
      });

      expect(response.status).toBe(200);
      expect(cliCalls[0]?.[2]).toBe("AAPL.US");
      expect(
        db.prepare("SELECT symbol FROM official_paper_order_lifecycle WHERE ticket_id = ?")
          .get(deriveTicketId(proposal.id))
      ).toEqual({ symbol: "AAPL.US" });
    });

    it("per-owner risk isolation: a DIFFERENT owner's open order does not count against this owner's budget", async () => {
      seedSnapshot(db, { ownerId: "mem_owner", netAssets: 100_000, marketValue: 0 });
      seedSnapshot(db, { ownerId: "mem_other", netAssets: 100_000, marketValue: 0 });
      // Mint realistic distinct broker ids for the two submitted orders.
      let orderCounter = 0;
      const fn: LongbridgeExecFn = () => {
        orderCounter += 1;
        return JSON.stringify({ order_id: `ext_isolation_${orderCounter}`, status: "Pending" });
      };
      await startServer({ execFn: fn });

      const otherOwnerProposal = createApprovedProposal(db, {
        ownerId: "mem_other",
        symbol: "AAPL.US",
        quantity: 95,
        limitPrice: 100
      });
      const otherResponse = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: otherOwnerProposal.id })
      });
      expect(otherResponse.status).toBe(200);

      const ownerProposal = createApprovedProposal(db, {
        ownerId: "mem_owner",
        symbol: "MSFT.US",
        quantity: 95,
        limitPrice: 100
      });
      const ownerResponse = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: ownerProposal.id })
      });

      // mem_owner's own budget is untouched by mem_other's open order.
      expect(ownerResponse.status).toBe(200);
    });

    it("blocks each same-owner 6% naked short before filled short exposure can disappear", async () => {
      seedSnapshot(db, { ownerId: "mem_owner", netAssets: 100_000, marketValue: 0 });
      let orderCounter = 0;
      const fn: LongbridgeExecFn = () => {
        orderCounter += 1;
        return JSON.stringify({ order_id: `ext_same_owner_short_${orderCounter}`, status: "Pending" });
      };
      await startServer({ execFn: fn });

      const first = createApprovedProposal(db, {
        ownerId: "mem_owner",
        symbol: "TSLA.US",
        side: "sell",
        quantity: 60,
        limitPrice: 100
      });
      const firstResponse = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: first.id })
      });
      expect(firstResponse.status).toBe(400);
      expect(((await firstResponse.json()) as { reasons: string[] }).reasons.join(" ")).toMatch(/卖空|多头持仓/u);

      const second = createApprovedProposal(db, {
        ownerId: "mem_owner",
        symbol: "NVDA.US",
        side: "sell",
        quantity: 60,
        limitPrice: 100
      });
      const secondResponse = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: second.id })
      });

      expect(secondResponse.status).toBe(400);
      const body = await secondResponse.json();
      expect(body.reasons.join(" ")).toMatch(/卖空|多头持仓/u);
      expect(orderCounter).toBe(0);
    });

    it("counts an immediately filled buy until a newer snapshot absorbs it", async () => {
      seedSnapshot(db, {
        ownerId: "mem_owner",
        netAssets: 100_000,
        marketValue: 0,
        fetchedAt: new Date(Date.now() - 60_000).toISOString(),
        positions: []
      });
      let orderCounter = 0;
      const fn: LongbridgeExecFn = () => {
        orderCounter += 1;
        return JSON.stringify({ order_id: `ext_filled_buy_${orderCounter}`, status: "Filled" });
      };
      await startServer({ execFn: fn });

      const first = createApprovedProposal(db, { symbol: "AAPL.US", quantity: 60, limitPrice: 100 });
      const firstResponse = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: first.id })
      });
      expect(firstResponse.status).toBe(200);

      const second = createApprovedProposal(db, { symbol: "MSFT.US", quantity: 60, limitPrice: 100 });
      const secondResponse = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: second.id })
      });

      expect(secondResponse.status).toBe(400);
      expect(((await secondResponse.json()) as { reasons: string[] }).reasons.join(" ")).toMatch(/官方模拟盘预算/u);
    });

    it("deducts an immediately filled sell from stale snapshot holdings before another sell", async () => {
      seedSnapshot(db, {
        ownerId: "mem_owner",
        netAssets: 100_000,
        marketValue: 10_000,
        fetchedAt: new Date(Date.now() - 60_000).toISOString(),
        positions: [{ symbol: "TSLA.US", quantity: 100, available: 100, priceSource: "live", price: 100 }]
      });
      let orderCounter = 0;
      const fn: LongbridgeExecFn = () => {
        orderCounter += 1;
        return JSON.stringify({ order_id: `ext_filled_sell_${orderCounter}`, status: "Filled" });
      };
      await startServer({ execFn: fn });

      const first = createApprovedProposal(db, { symbol: "TSLA.US", side: "sell", quantity: 100, limitPrice: 100 });
      const firstResponse = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: first.id })
      });
      expect(firstResponse.status).toBe(200);

      const second = createApprovedProposal(db, { symbol: "TSLA.US", side: "sell", quantity: 100, limitPrice: 100 });
      const secondResponse = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: second.id })
      });

      expect(secondResponse.status).toBe(400);
      expect(((await secondResponse.json()) as { reasons: string[] }).reasons.join(" ")).toMatch(/卖空|多头持仓/u);
    });

    it("threads ownerId/proposalId onto the lifecycle row from the server-built ticket (never trusts the request body's fields)", async () => {
      seedSnapshot(db, { ownerId: "mem_owner", netAssets: 100_000, marketValue: 0 });
      const { fn } = makeCountingExec({ order_id: "ext_thread_1", status: "Filled" });
      await startServer({ execFn: fn });

      const approved = createApprovedProposal(db, { ownerId: "mem_owner", symbol: "AAPL.US", quantity: 3, limitPrice: 100 });

      // Body claims a DIFFERENT owner/symbol/quantity - must be ignored.
      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          proposalId: approved.id,
          ownerId: "mem_other",
          symbol: "TSLA.US",
          side: "sell",
          quantity: 999
        })
      });

      expect(response.status).toBe(200);
      const lifecycleRow = db
        .prepare(`SELECT owner_id, symbol, side, quantity FROM official_paper_order_lifecycle WHERE ticket_id = ?`)
        .get(deriveTicketId(approved.id)) as Record<string, unknown>;
      expect(lifecycleRow.owner_id).toBe("mem_owner");
      expect(lifecycleRow.symbol).toBe("AAPL.US");
      expect(lifecycleRow.side).toBe("buy");
      expect(lifecycleRow.quantity).toBe(3);
    });

    it("resolves the execution environment from proposal.ownerId and passes it to both broker CLI calls", async () => {
      seedSnapshot(db, {
        ownerId: "mem_owner",
        netAssets: 100_000,
        marketValue: 0,
        reason: "hourly_poll_per_member"
      });
      const resolvedOwners: string[] = [];
      const seenTokens: Array<string | undefined> = [];
      const fn: LongbridgeExecFn = (_command, args, options) => {
        seenTokens.push(options.env.LONGBRIDGE_ACCESS_TOKEN);
        return args[1] === "detail"
          ? JSON.stringify({ status: "Pending" })
          : JSON.stringify({ order_id: "ext_owner_env", status: "New" });
      };
      await startServer({
        execFn: fn,
        executionContextResolver: (ownerId) => {
          resolvedOwners.push(ownerId);
          return {
            mode: "member",
            env: {
              ...process.env,
              LONGBRIDGE_ACCESS_TOKEN: `token-for-${ownerId}`,
              LONGBRIDGE_ACCOUNT_MODE: "paper",
              LONGBRIDGE_OFFICIAL_PAPER_ENABLED: "true",
              ALLOW_LIVE_EXECUTION: "false"
            }
          };
        }
      });
      const proposal = createApprovedProposal(db, { ownerId: "mem_owner" });

      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: proposal.id })
      });

      expect(response.status).toBe(200);
      expect(resolvedOwners).toEqual(["mem_owner"]);
      expect(seenTokens).toEqual(["token-for-mem_owner", "token-for-mem_owner"]);
    });

    it("fails closed before recording or calling the broker when owner credentials cannot be resolved", async () => {
      seedSnapshot(db, { ownerId: "mem_owner", netAssets: 100_000, marketValue: 0 });
      let execCalls = 0;
      await startServer({
        execFn: () => {
          execCalls += 1;
          return "{}";
        },
        executionContextResolver: () => {
          throw new Error("owner-specific credentials are missing");
        }
      });
      const proposal = createApprovedProposal(db, { ownerId: "mem_owner" });

      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: proposal.id })
      });

      expect(response.status).toBe(503);
      expect(execCalls).toBe(0);
      expect(db.prepare("SELECT COUNT(*) AS c FROM official_paper_order_lifecycle").get()).toEqual({ c: 0 });
    });

    it("never uses a legacy shared snapshot to authorize a member-account sell", async () => {
      seedSnapshot(db, {
        ownerId: null,
        netAssets: 100_000,
        marketValue: 10_000,
        positions: [{ symbol: "TSLA.US", quantity: 100 }]
      });
      let execCalls = 0;
      await startServer({
        execFn: () => {
          execCalls += 1;
          return JSON.stringify({ order_id: "must_not_submit" });
        },
        executionContextResolver: () => ({
          mode: "member",
          env: {
            ...process.env,
            LONGBRIDGE_ACCESS_TOKEN: "owner-token",
            LONGBRIDGE_ACCOUNT_MODE: "paper",
            LONGBRIDGE_OFFICIAL_PAPER_ENABLED: "true",
            ALLOW_LIVE_EXECUTION: "false"
          }
        })
      });
      const proposal = createApprovedProposal(db, {
        ownerId: "mem_owner",
        symbol: "TSLA.US",
        side: "sell",
        quantity: 50,
        limitPrice: 100
      });

      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: proposal.id })
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.reasons.join(" ")).toMatch(/新鲜可信官方模拟盘账户快照/u);
      expect(execCalls).toBe(0);
    });

    it("never uses a same-owner legacy snapshot to authorize a member-account order", async () => {
      seedSnapshot(db, {
        ownerId: "mem_owner",
        netAssets: 100_000,
        marketValue: 0,
        reason: "hourly_poll"
      });
      let execCalls = 0;
      await startServer({
        execFn: () => {
          execCalls += 1;
          return JSON.stringify({ order_id: "wrong-account" });
        },
        executionContextResolver: () => ({
          mode: "member",
          env: {
            ...process.env,
            LONGBRIDGE_ACCESS_TOKEN: "owner-token",
            LONGBRIDGE_ACCOUNT_MODE: "paper",
            LONGBRIDGE_OFFICIAL_PAPER_ENABLED: "true",
            ALLOW_LIVE_EXECUTION: "false"
          }
        })
      });
      const proposal = createApprovedProposal(db, { ownerId: "mem_owner" });

      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: proposal.id })
      });

      expect(response.status).toBe(400);
      expect(execCalls).toBe(0);
    });

    it("never uses a same-owner per-member snapshot after switching back to legacy execution", async () => {
      seedSnapshot(db, {
        ownerId: "mem_owner",
        netAssets: 100_000,
        marketValue: 0,
        reason: "hourly_poll_per_member"
      });
      const { fn, callCount } = makeCountingExec({ order_id: "wrong-account", status: "Pending" });
      await startServer({ execFn: fn });
      const proposal = createApprovedProposal(db, { ownerId: "mem_owner" });

      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: proposal.id })
      });

      expect(response.status).toBe(400);
      expect(callCount()).toBe(0);
    });

    it("allows the legacy single-account context to use its shared snapshot", async () => {
      seedSnapshot(db, { ownerId: null, netAssets: 100_000, marketValue: 0 });
      const { fn, callCount } = makeCountingExec({ order_id: "ext_legacy_shared", status: "Pending" });
      await startServer({ execFn: fn });
      const proposal = createApprovedProposal(db, {
        ownerId: "mem_owner",
        symbol: "AAPL.US",
        side: "buy",
        quantity: 10,
        limitPrice: 100
      });

      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ proposalId: proposal.id })
      });

      expect(response.status).toBe(200);
      expect(callCount()).toBe(2);
    });

    it("400s when a malformed (non-JSON) body is sent, after the secret check but before touching the database", async () => {
      await startServer();
      const response = await fetch(`${baseUrl(server)}/v1/tickets`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: "not json {{{"
      });
      expect(response.status).toBe(400);
    });
  });
});

function baseUrl(server: ReturnType<typeof createBrokerExecutorServer>): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}
