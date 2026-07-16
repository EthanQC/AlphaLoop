import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
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
    positions?: Array<{ symbol: string; quantity: number }>;
  }
): void {
  db
    .prepare(`
      INSERT INTO official_paper_snapshots
      (id, fetched_at, reason, net_assets, total_cash, market_value, positions, raw, owner_id)
      VALUES (?, ?, 'scheduled', ?, 0, ?, ?, '{}', ?)
    `)
    .run(
      createId("snapshot"),
      opts.fetchedAt ?? nowIso(),
      opts.netAssets,
      opts.marketValue,
      JSON.stringify(opts.positions ?? []),
      opts.ownerId
    );
}

function createApprovedProposal(
  db: DatabaseSync,
  overrides: Partial<NewProposal> = {},
  decision: "approved" | "approved_half" = "approved"
): Proposal {
  const repo = new ProposalRepository(db);
  const created = repo.create({
    ownerId: "mem_owner",
    symbol: "AAPL.US",
    side: "buy",
    quantity: 10,
    orderType: "limit",
    limitPrice: 100,
    reason: "test proposal",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    ...overrides
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
      server = createBrokerExecutorServer({ db, sharedSecret: SHARED_SECRET, ...deps });
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

    // Companion: a sell fully within the held long is NOT blocked, even
    // though the same notional would be over budget for a naked short.
    it("allows a de-risking sell within the held long over the same notional that would block a naked short", async () => {
      seedSnapshot(db, {
        ownerId: "mem_owner",
        netAssets: 100_000,
        marketValue: 20_000,
        positions: [{ symbol: "TSLA.US", quantity: 200 }]
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
        positions: [{ symbol: "TSLA.US", quantity: 150 }]
      });
      // external_order_id is UNIQUE - mint a fresh id per execution.
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
        positions: [{ symbol: "AAPL.US", quantity: 100 }]
      });
      const { fn } = makeCountingExec({ order_id: "ext_bare_symbol", status: "New" });
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
    });

    it("per-owner risk isolation: a DIFFERENT owner's open order does not count against this owner's budget", async () => {
      seedSnapshot(db, { ownerId: "mem_owner", netAssets: 100_000, marketValue: 0 });
      seedSnapshot(db, { ownerId: "mem_other", netAssets: 100_000, marketValue: 0 });
      // external_order_id is UNIQUE across the whole lifecycle table, so this
      // fake must mint a DIFFERENT id per call (two real orders in this test,
      // one per owner) - a fixed literal would collide on the second insert.
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
