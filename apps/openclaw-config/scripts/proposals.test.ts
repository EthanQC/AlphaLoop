import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  CircuitBreakerRepository,
  MemberRepository,
  ProposalRepository,
  createId,
  openTradingDatabase,
  type CardTransport
} from "../../../packages/shared-types/dist/index.js";

const cli = await import("./proposals.mjs");

// A URL nothing listens on: port 1 requires root to BIND, but any process
// may attempt to CONNECT to it, which the OS refuses immediately - this
// gives every "executor unreachable" test a deterministic, fast ECONNREFUSED
// without depending on port 4312 (the real default) happening to be free.
const UNREACHABLE_EXECUTOR_URL = "http://127.0.0.1:1";

const tempDirs: string[] = [];

function makeDb(): { db: DatabaseSync; dbPath: string; options: { dbPath: string } } {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-proposals-cli-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "trading.sqlite");
  const db = openTradingDatabase(dbPath);
  return { db, dbPath, options: { dbPath } };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function seedMember(db: DatabaseSync, id: string, overrides: Partial<{ feishuOpenId: string; status: "active" | "revoked" }> = {}) {
  new MemberRepository(db).upsert({
    id,
    email: `${id}@example.com`,
    ...(overrides.feishuOpenId ? { feishuOpenId: overrides.feishuOpenId } : {}),
    displayName: `Display-${id}`,
    riskTags: [],
    stockTags: [],
    showPerformance: true,
    status: overrides.status ?? "active",
    createdAt: "2026-07-01T00:00:00.000Z"
  });
}

function seedSnapshot(db: DatabaseSync, opts: { ownerId: string; netAssets: number; marketValue: number; fetchedAt?: string }) {
  db.prepare(`
    INSERT INTO official_paper_snapshots
      (id, fetched_at, reason, net_assets, total_cash, market_value, positions, raw, owner_id)
    VALUES (?, ?, 'manual', ?, NULL, ?, '[]', '{}', ?)
  `).run(createId("snapshot"), opts.fetchedAt ?? "2026-07-15T12:00:00.000Z", opts.netAssets, opts.marketValue, opts.ownerId);
}

function seedDisciplineRule(db: DatabaseSync, opts: { ownerId: string; ruleText: string; enforcement: "hard" | "proposal_check" | "self" }) {
  db.prepare(`
    INSERT INTO discipline_rules (id, owner_id, rule_text, enforcement, linked_strategy, enabled, created_at, disabled_at)
    VALUES (?, ?, ?, ?, NULL, 1, ?, NULL)
  `).run(createId("rule"), opts.ownerId, opts.ruleText, opts.enforcement, "2026-07-01T00:00:00.000Z");
}

function countProposals(db: DatabaseSync): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM proposals`).get() as { n: number }).n;
}

function makeFakeTransport(): { transport: CardTransport; sent: Array<{ target: unknown; card: unknown }>; updated: Array<{ messageId: string; card: unknown }> } {
  const sent: Array<{ target: unknown; card: unknown }> = [];
  const updated: Array<{ messageId: string; card: unknown }> = [];
  let counter = 0;
  const transport: CardTransport = {
    async sendCard(target, cardJson) {
      sent.push({ target, card: cardJson });
      counter += 1;
      return { ok: true, messageId: `om_fake_${counter}` };
    },
    async updateCard(messageId, cardJson) {
      updated.push({ messageId, card: cardJson });
      return { ok: true };
    }
  };
  return { transport, sent, updated };
}

const baseCreateFlags = {
  owner: "member_1",
  symbol: "NVDA.US",
  side: "buy",
  quantity: "2",
  reason: "test reason"
};

describe("runCreate", () => {
  it("creates a pending proposal with expires_at = created + 24h", async () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");

    const before = Date.now();
    const result = await cli.runCreate(baseCreateFlags, options);
    const after = Date.now();

    expect(result.ok).toBe(true);
    expect(result.proposal.status).toBe("pending");
    expect(result.proposal.ownerId).toBe("member_1");
    const expiresAtMs = new Date(result.proposal.expiresAt).getTime();
    const createdAtMs = new Date(result.proposal.createdAt).getTime();
    expect(expiresAtMs - createdAtMs).toBeCloseTo(24 * 60 * 60 * 1000, -2);
    expect(createdAtMs).toBeGreaterThanOrEqual(before);
    expect(createdAtMs).toBeLessThanOrEqual(after);
  });

  // FIX 2 (symbol-format mismatch): official_paper_snapshots positions hold
  // Longbridge-suffixed symbols ('AAPL.US'), but --symbol used to flow into
  // the proposal row verbatim - a bare 'AAPL' then missed the executor's
  // held-position lookup entirely (held=undefined -> conservative 0), so a
  // legitimate full de-risking sell got 400-blocked. Normalize at creation
  // (same convention as report-data.mjs's normalizeSymbol).
  it("normalizes a bare --symbol to the Longbridge-suffixed convention at creation ('aapl' -> 'AAPL.US')", async () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");

    const result = await cli.runCreate({ ...baseCreateFlags, symbol: "aapl" }, options);

    expect(result.ok).toBe(true);
    expect(result.proposal.symbol).toBe("AAPL.US");
    // The persisted row too, not just the returned object.
    const row = db.prepare(`SELECT symbol FROM proposals WHERE id = ?`).get(result.proposal.id) as { symbol: string };
    expect(row.symbol).toBe("AAPL.US");

    // An already-suffixed symbol is left unchanged.
    const suffixed = await cli.runCreate({ ...baseCreateFlags, symbol: "0700.HK" }, options);
    expect(suffixed.proposal.symbol).toBe("0700.HK");
  });

  it("rejects an unknown owner", async () => {
    const { options } = makeDb();
    await expect(cli.runCreate(baseCreateFlags, options)).rejects.toThrow(/不存在/);
  });

  it("rejects a revoked owner", async () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1", { status: "revoked" });
    await expect(cli.runCreate(baseCreateFlags, options)).rejects.toThrow(/吊销/);
  });

  it("rejects invalid --side/--quantity/--confidence", async () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    await expect(cli.runCreate({ ...baseCreateFlags, side: "long" }, options)).rejects.toThrow(/--side/);
    await expect(cli.runCreate({ ...baseCreateFlags, quantity: "0" }, options)).rejects.toThrow(/--quantity/);
    await expect(cli.runCreate({ ...baseCreateFlags, quantity: "-5" }, options)).rejects.toThrow(/--quantity/);
    await expect(cli.runCreate({ ...baseCreateFlags, confidence: "extreme" }, options)).rejects.toThrow(/--confidence/);
  });

  it("circuit-paused owner: create is rejected and writes NO row", async () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    new CircuitBreakerRepository(db).trip("member_1", {
      pausedUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      reason: "本交易周亏损 5.00%，超过熔断阈值 -3%"
    });

    await expect(cli.runCreate(baseCreateFlags, options)).rejects.toThrow(/熔断暂停中/);
    expect(countProposals(db)).toBe(0);
  });

  it("a hard discipline violation writes NO row and the error lists the violation(s)", async () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedSnapshot(db, { ownerId: "member_1", netAssets: 100000, marketValue: 8000 }); // currentExposurePct=8
    seedDisciplineRule(db, { ownerId: "member_1", ruleText: "仓位 ≤ 10%", enforcement: "hard" });

    // quantity 10 * limitPrice 500 = notional 5000 -> budgetImpactPct 5 ->
    // projected exposure 8 + 5 = 13% > 10% cap -> hard violation.
    await expect(
      cli.runCreate({ ...baseCreateFlags, quantity: "10", "limit-price": "500" }, options)
    ).rejects.toThrow(/纪律硬检查未通过/);
    expect(countProposals(db)).toBe(0);
  });

  it("a proposal_check (non-hard) violation does NOT block - the row is written with the violation on the report", async () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedSnapshot(db, { ownerId: "member_1", netAssets: 100000, marketValue: 8000 });
    seedDisciplineRule(db, { ownerId: "member_1", ruleText: "仓位 ≤ 10%", enforcement: "proposal_check" });

    const result = await cli.runCreate(
      { ...baseCreateFlags, quantity: "10", "limit-price": "500" },
      options
    );

    expect(result.ok).toBe(true);
    expect(result.proposal.disciplineReport).toEqual([
      expect.objectContaining({ enforcement: "proposal_check", pass: false })
    ]);
  });

  it("budget preview: computes budgetImpact from quantity*limitPrice/netAssets when a snapshot and limit price exist", async () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedSnapshot(db, { ownerId: "member_1", netAssets: 100000, marketValue: 0 });

    const result = await cli.runCreate(
      { ...baseCreateFlags, quantity: "2", "limit-price": "845" },
      options
    );

    // notional = 2 * 845 = 1690; 1690 / 100000 * 100 = 1.69
    expect(result.proposal.budgetImpact).toBeCloseTo(1.69, 6);
  });

  it("missing snapshot: does NOT block creation, records a note instead", async () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");

    const result = await cli.runCreate(baseCreateFlags, options);

    expect(result.ok).toBe(true);
    expect(result.proposal.budgetImpact).toBeUndefined();
    expect(result.warnings?.join(" ")).toMatch(/预算无法核算（无快照）/);
  });

  it("delivers the card to the owner's Feishu DM via the injected transport and backfills card_message_id", async () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1", { feishuOpenId: "ou_member_1" });
    const { transport, sent } = makeFakeTransport();

    const result = await cli.runCreate(baseCreateFlags, { ...options, transport });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.target).toEqual({ openId: "ou_member_1" });
    expect(result.deliver).toEqual({ ok: true, messageId: "om_fake_1" });
    expect(new ProposalRepository(db).getById(result.proposal.id)?.cardMessageId).toBe("om_fake_1");
  });

  it("no feishuOpenId on file: proposal still stands, delivery is skipped with a warning", async () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1"); // no feishuOpenId
    const result = await cli.runCreate(baseCreateFlags, options);

    expect(result.ok).toBe(true);
    expect(result.deliver).toEqual({ skipped: "no_open_id" });
    expect(result.warnings?.join(" ")).toMatch(/飞书卡片未发送/);
    void db;
  });

  it("a card-send failure leaves the proposal standing, with a warning - does not roll back", async () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1", { feishuOpenId: "ou_member_1" });
    const transport: CardTransport = {
      sendCard: async () => ({ ok: false, error: "rate limited" }),
      updateCard: async () => ({ ok: true })
    };

    const result = await cli.runCreate(baseCreateFlags, { ...options, transport });

    expect(result.ok).toBe(true);
    expect(countProposals(db)).toBe(1);
    expect(result.warnings?.join(" ")).toMatch(/飞书卡片发送失败/);
  });

  it("writes an audit_log row categorized 'proposals'", async () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    const result = await cli.runCreate(baseCreateFlags, options);

    const rows = db.prepare(`SELECT action, payload FROM audit_log WHERE category = 'proposals' AND action = 'create'`).all() as Array<{ action: string; payload: string }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload).proposalId).toBe(result.proposal.id);
  });
});

describe("approve / approve-half / reject: owner-only enforcement (THE negative test)", () => {
  async function createPending(db: DatabaseSync, options: { dbPath: string }) {
    seedMember(db, "member_a");
    seedMember(db, "member_b");
    const result = await cli.runCreate({ ...baseCreateFlags, owner: "member_a" }, options);
    return result.proposal as { approvalToken: string; id: string };
  }

  it("approve: a non-owner actor is refused (non-zero-exit shape via buildCliResult)", async () => {
    const { db, options } = makeDb();
    const proposal = await createPending(db, options);

    await expect(
      cli.runApprove({ token: proposal.approvalToken, actor: "member_b" }, options)
    ).rejects.toThrow(/非本人操作被拒/);

    const result = await cli.buildCliResult(["approve", "--token", proposal.approvalToken, "--actor", "member_b"], options);
    expect(result.ok).toBe(false);

    // The proposal must remain pending - a wrong actor's attempt never
    // consumes the token.
    expect(new ProposalRepository(db).getById(proposal.id)?.status).toBe("pending");
  });

  it("approve-half: a non-owner actor is refused", async () => {
    const { db, options } = makeDb();
    const proposal = await createPending(db, options);

    await expect(
      cli.runApproveHalf({ token: proposal.approvalToken, actor: "member_b" }, options)
    ).rejects.toThrow(/非本人操作被拒/);
    expect(new ProposalRepository(db).getById(proposal.id)?.status).toBe("pending");
  });

  it("reject: a non-owner actor is refused", async () => {
    const { db, options } = makeDb();
    const proposal = await createPending(db, options);

    await expect(
      cli.runReject({ token: proposal.approvalToken, actor: "member_b" }, options)
    ).rejects.toThrow(/非本人操作被拒/);
    expect(new ProposalRepository(db).getById(proposal.id)?.status).toBe("pending");
  });

  it("the real owner CAN still approve after a rejected non-owner attempt", async () => {
    const { db, options } = makeDb();
    const proposal = await createPending(db, options);

    await expect(cli.runApprove({ token: proposal.approvalToken, actor: "member_b" }, options)).rejects.toThrow();

    const result = await cli.runApprove({ token: proposal.approvalToken, actor: "member_a", "no-execute": true }, options);
    expect(result.ok).toBe(true);
    expect(result.proposal.status).toBe("approved");
  });
});

describe("approve / reject: consume semantics", () => {
  it("double consume: a second approve on an already-approved token is refused", async () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    const created = await cli.runCreate({ ...baseCreateFlags, owner: "member_1" }, options);
    const token = created.proposal.approvalToken;

    const first = await cli.runApprove({ token, actor: "member_1", "no-execute": true }, options);
    expect(first.ok).toBe(true);

    await expect(cli.runApprove({ token, actor: "member_1", "no-execute": true }, options)).rejects.toThrow(
      /该提案已处理或已过期/
    );
    void db;
  });

  it("expired-then-click: after sweep marks a proposal expired, approving it is refused with the same message", async () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    const created = await cli.runCreate(
      { ...baseCreateFlags, owner: "member_1" },
      options
    );
    // Force immediate expiry by rewriting expires_at directly (repo has no
    // "create in the past" seam - this is a DB-level backdate, not a CLI call).
    db.prepare(`UPDATE proposals SET expires_at = ? WHERE id = ?`).run("2000-01-01T00:00:00.000Z", created.proposal.id);

    const sweepResult = await cli.runSweep({}, options);
    expect(sweepResult.swept).toBe(1);

    await expect(
      cli.runApprove({ token: created.proposal.approvalToken, actor: "member_1", "no-execute": true }, options)
    ).rejects.toThrow(/该提案已处理或已过期/);
  });

  it("approve-half halves the quantity via Math.max(1, Math.floor(q/2)), persisted onto the proposal row", async () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    const created = await cli.runCreate({ ...baseCreateFlags, owner: "member_1", quantity: "7" }, options);

    const result = await cli.runApproveHalf({ token: created.proposal.approvalToken, actor: "member_1", "no-execute": true }, options);

    expect(result.proposal.quantity).toBe(3); // floor(7/2) = 3
    expect(new ProposalRepository(db).getById(created.proposal.id)?.quantity).toBe(3);
  });

  it("approve-half with quantity=1 stays 1 (never rounds down to 0)", async () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    const created = await cli.runCreate({ ...baseCreateFlags, owner: "member_1", quantity: "1" }, options);

    const result = await cli.runApproveHalf({ token: created.proposal.approvalToken, actor: "member_1", "no-execute": true }, options);

    expect(result.proposal.quantity).toBe(1);
    void db;
  });

  it("reject transitions status to rejected and does not call the executor", async () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    const created = await cli.runCreate({ ...baseCreateFlags, owner: "member_1" }, options);

    const result = await cli.runReject(
      { token: created.proposal.approvalToken, actor: "member_1" },
      { ...options, executorUrl: UNREACHABLE_EXECUTOR_URL }
    );

    expect(result.proposal.status).toBe("rejected");
    expect(result.warnings).toBeUndefined(); // no executor call attempted for a rejection
    void db;
  });
});

describe("approve / approve-half: card update + executor call", () => {
  it("re-renders the card via composeDecisionUpdate when card_message_id is present", async () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1", { feishuOpenId: "ou_member_1" });
    const { transport, updated } = makeFakeTransport();
    const created = await cli.runCreate({ ...baseCreateFlags, owner: "member_1" }, { ...options, transport });

    await cli.runApprove(
      { token: created.proposal.approvalToken, actor: "member_1", "no-execute": true },
      { ...options, transport }
    );

    expect(updated).toHaveLength(1);
    expect(updated[0]?.messageId).toBe("om_fake_1");
    const card = updated[0]?.card as { header?: { title?: { content?: string } } };
    expect(JSON.stringify(card)).toContain("已批准");
    void db;
  });

  it("skips the card update entirely when no card_message_id exists (no_open_id at create time)", async () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1"); // no feishuOpenId -> no card_message_id
    const created = await cli.runCreate({ ...baseCreateFlags, owner: "member_1" }, options);
    const { transport, updated } = makeFakeTransport();

    const result = await cli.runApprove(
      { token: created.proposal.approvalToken, actor: "member_1", "no-execute": true },
      { ...options, transport }
    );

    expect(result.ok).toBe(true);
    expect(updated).toHaveLength(0);
    void db;
  });

  it("--no-execute skips the executor call entirely (no warning even against an unreachable URL)", async () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    const created = await cli.runCreate({ ...baseCreateFlags, owner: "member_1" }, options);

    const result = await cli.runApprove(
      { token: created.proposal.approvalToken, actor: "member_1", "no-execute": true },
      { ...options, executorUrl: UNREACHABLE_EXECUTOR_URL }
    );

    expect(result.ok).toBe(true);
    expect(result.warnings).toBeUndefined();
    void db;
  });

  it("executor-unreachable approve keeps the proposal approved and surfaces a warning (no rollback)", async () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    const created = await cli.runCreate({ ...baseCreateFlags, owner: "member_1" }, options);

    const result = await cli.runApprove(
      { token: created.proposal.approvalToken, actor: "member_1" },
      { ...options, executorUrl: UNREACHABLE_EXECUTOR_URL }
    );

    expect(result.ok).toBe(true);
    expect(result.proposal.status).toBe("approved");
    expect(result.warnings?.join(" ")).toMatch(/执行器不可达/);
    expect(new ProposalRepository(db).getById(created.proposal.id)?.status).toBe("approved");
  });

  it("executor-unreachable approve-half keeps approved_half (with the halved quantity) and warns", async () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    const created = await cli.runCreate({ ...baseCreateFlags, owner: "member_1", quantity: "5" }, options);

    const result = await cli.runApproveHalf(
      { token: created.proposal.approvalToken, actor: "member_1" },
      { ...options, executorUrl: UNREACHABLE_EXECUTOR_URL }
    );

    expect(result.proposal.status).toBe("approved_half");
    expect(result.proposal.quantity).toBe(2); // floor(5/2)
    expect(result.warnings?.join(" ")).toMatch(/执行器不可达/);
  });
});

describe("runList", () => {
  it("lists only the given owner's proposals, optionally filtered by status", async () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");
    const p1 = await cli.runCreate({ ...baseCreateFlags, owner: "member_1", symbol: "AAPL.US" }, options);
    await cli.runCreate({ ...baseCreateFlags, owner: "member_1", symbol: "MSFT.US" }, options);
    await cli.runCreate({ ...baseCreateFlags, owner: "member_2", symbol: "TSLA.US" }, options);
    await cli.runApprove({ token: p1.proposal.approvalToken, actor: "member_1", "no-execute": true }, options);

    const all = await cli.runList({ owner: "member_1" }, options);
    expect(all.proposals).toHaveLength(2);

    const approvedOnly = await cli.runList({ owner: "member_1", status: "approved" }, options);
    expect(approvedOnly.proposals.map((p: { id: string }) => p.id)).toEqual([p1.proposal.id]);

    const other = await cli.runList({ owner: "member_2" }, options);
    expect(other.proposals).toHaveLength(1);
    void db;
  });

  it("rejects an invalid --status value", async () => {
    const { options } = makeDb();
    await expect(cli.runList({ owner: "member_1", status: "bogus" }, options)).rejects.toThrow(/--status/);
  });
});

describe("runSweep", () => {
  it("expires every pending proposal past its expires_at, updates the card, and audits", async () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1", { feishuOpenId: "ou_member_1" });
    const { transport, sent, updated } = makeFakeTransport();
    const created = await cli.runCreate({ ...baseCreateFlags, owner: "member_1" }, { ...options, transport });
    expect(sent).toHaveLength(1);
    db.prepare(`UPDATE proposals SET expires_at = ? WHERE id = ?`).run("2000-01-01T00:00:00.000Z", created.proposal.id);

    const result = await cli.runSweep({}, { ...options, transport });

    expect(result.ok).toBe(true);
    expect(result.swept).toBe(1);
    expect(new ProposalRepository(db).getById(created.proposal.id)?.status).toBe("expired");
    expect(updated).toHaveLength(1);
    expect(JSON.stringify(updated[0]?.card)).toContain("已过期");

    const auditRows = db.prepare(`SELECT action FROM audit_log WHERE category = 'proposals' AND action = 'expired'`).all();
    expect(auditRows).toHaveLength(1);
  });

  it("does not touch proposals that are not yet expired", async () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    await cli.runCreate({ ...baseCreateFlags, owner: "member_1" }, options);

    const result = await cli.runSweep({}, options);

    expect(result.swept).toBe(0);
    void db;
  });

  it("race with a concurrent click: a pre-consumed row is skipped gracefully, not treated as an error", async () => {
    // Seam test (plan: "race with sweep = atomic consume ... pre-consumed row
    // → sweep skips gracefully"). True concurrent interleaving can't be
    // driven from a single-threaded synchronous test, so the race window is
    // reproduced directly: listPendingExpired's WHERE clause only checks
    // `status = 'pending'`, so a row a concurrent click already consumed
    // BETWEEN the sweep's listPendingExpired read and its own
    // consumeApproval call would still have been handed to this sweep by
    // that same read (this is exactly the real race window - Task 1's
    // consumeApproval is what actually adjudicates it). Setting
    // `consumed_at` directly while leaving `status = 'pending'` reproduces
    // that in-flight state (otherwise unreachable through the app's own
    // write path, since consumeApproval always sets both together) so the
    // sweep's OWN consumeApproval call is guaranteed to lose, exercising its
    // {consumed:false} handling.
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    const created = await cli.runCreate({ ...baseCreateFlags, owner: "member_1" }, options);
    db.prepare(`UPDATE proposals SET expires_at = ?, consumed_at = ? WHERE id = ?`).run(
      "2000-01-01T00:00:00.000Z",
      "2026-07-15T00:00:00.000Z",
      created.proposal.id
    );

    const result = await cli.runSweep({}, options);

    expect(result.ok).toBe(true);
    expect(result.swept).toBe(0);
    expect(result.results).toEqual([{ proposalId: created.proposal.id, skipped: "already_consumed" }]);
    // Status is untouched by the sweep's failed consume attempt - still
    // whatever it was before (pending, in this reproduction).
    expect(new ProposalRepository(db).getById(created.proposal.id)?.status).toBe("pending");
  });
});

describe("buildCliResult / dispatch", () => {
  it("rejects an unknown command", async () => {
    const { options } = makeDb();
    const result = await cli.buildCliResult(["frobnicate"], options);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/未知子命令/);
  });

  it("per-command flag allowlist: a create-only flag is rejected on list (H6 pattern)", () => {
    expect(() => cli.parseFlags(["--owner", "x", "--symbol", "NVDA"], "list")).toThrow(/未知参数：--symbol/);
  });

  it("per-command flag allowlist: --no-execute is rejected on reject", () => {
    expect(() => cli.parseFlags(["--token", "t", "--actor", "a", "--no-execute"], "reject")).toThrow(
      /未知参数：--no-execute/
    );
  });

  it("a full create -> approve-half -> list round trip via buildCliResult", async () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");

    const created = await cli.buildCliResult(
      ["create", "--owner", "member_1", "--symbol", "NVDA.US", "--side", "buy", "--quantity", "4", "--reason", "r"],
      options
    );
    expect(created.ok).toBe(true);

    const approved = await cli.buildCliResult(
      ["approve-half", "--token", created.proposal.approvalToken, "--actor", "member_1", "--no-execute"],
      options
    );
    expect(approved.ok).toBe(true);
    expect(approved.proposal.quantity).toBe(2);

    const listed = await cli.buildCliResult(["list", "--owner", "member_1"], options);
    expect(listed.proposals).toHaveLength(1);
    expect(listed.proposals[0].status).toBe("approved_half");
  });
});
