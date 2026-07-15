import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApiTokenRepository, MemberRepository, createId, migrate, type Member } from "@packages/shared-types";

import { createPlatformServer } from "../server.js";

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function makeMember(overrides: Partial<Member> = {}): Member {
  return {
    id: "member_1",
    email: "member1@example.com",
    displayName: "Member One",
    riskTags: [],
    stockTags: [],
    showPerformance: true,
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

interface SeedProposalOpts {
  id?: string;
  ownerId: string;
  symbol?: string;
  side?: string;
  quantity?: number;
  orderType?: string;
  limitPrice?: number | null;
  reason?: string;
  evidence?: unknown;
  disciplineReport?: unknown;
  status?: string;
  decidedAt?: string | null;
  decidedBy?: string | null;
  consumedAt?: string | null;
  outcome?: string | null;
  createdAt?: string;
  expiresAt?: string;
}

function seedProposal(db: DatabaseSync, opts: SeedProposalOpts): string {
  const id = opts.id ?? createId("proposal");
  db.prepare(`
    INSERT INTO proposals (
      id, owner_id, symbol, side, quantity, order_type, limit_price, reason, evidence,
      discipline_report, status, decided_at, decided_by, consumed_at, outcome, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.ownerId,
    opts.symbol ?? "NVDA.US",
    opts.side ?? "buy",
    opts.quantity ?? 10,
    opts.orderType ?? "limit",
    opts.limitPrice ?? null,
    opts.reason ?? "测试理由",
    JSON.stringify(opts.evidence ?? [{ note: "evidence-1" }]),
    JSON.stringify(opts.disciplineReport ?? [{ rule: "rule-1", passed: true }]),
    opts.status ?? "pending",
    opts.decidedAt ?? null,
    opts.decidedBy ?? null,
    opts.consumedAt ?? null,
    opts.outcome ?? null,
    opts.createdAt ?? "2026-07-10T00:00:00.000Z",
    opts.expiresAt ?? "2026-07-11T00:00:00.000Z"
  );
  return id;
}

describe("proposal route (GET /proposal/<id>)", () => {
  let repoRoot: string;
  let db: DatabaseSync;
  let server: ReturnType<typeof createPlatformServer>;
  let baseUrl: string;

  const NOW = () => new Date("2026-07-14T12:00:00.000Z");

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "platform-app-proposal-route-"));
    mkdirSync(join(repoRoot, "reports"), { recursive: true });
    db = memoryDb();
    server = createPlatformServer({ db, repoRoot, now: NOW });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function seedMemberWithToken(overrides: Partial<Member> = {}): { member: Member; token: string } {
    const member = makeMember(overrides);
    new MemberRepository(db).upsert(member);
    const token = new ApiTokenRepository(db).issue(member.id, "test").token;
    return { member, token };
  }

  function authed(path: string, token: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  }

  it("returns 401 without any identity", async () => {
    const response = await fetch(`${baseUrl}/proposal/does-not-exist`);
    expect(response.status).toBe(401);
  });

  it("returns 404 for an id that doesn't exist (empty table today)", async () => {
    const { token } = seedMemberWithToken();
    const response = await authed("/proposal/no-such-id", token);
    expect(response.status).toBe(404);
  });

  it("owner sees 200 with the full skeleton for their own proposal", async () => {
    const { member, token } = seedMemberWithToken();
    const id = seedProposal(db, {
      ownerId: member.id,
      symbol: "NVDA.US",
      side: "buy",
      quantity: 15,
      reason: "财报后加仓",
      evidence: [{ url: "https://example.com/a", note: "证据A" }],
      disciplineReport: [{ rule: "单票不超过20%", passed: true }],
      status: "approved",
      decidedAt: "2026-07-10T01:00:00.000Z",
      decidedBy: "member_admin",
      consumedAt: "2026-07-10T02:00:00.000Z",
      outcome: "+3.2%"
    });

    const response = await authed(`/proposal/${id}`, token);
    expect(response.status).toBe(200);
    const body = await response.text();

    expect(body).toContain("NVDA.US");
    expect(body).toContain("财报后加仓");
    expect(body).toContain("证据A");
    expect(body).toContain("单票不超过20%");
    expect(body).toContain("member_admin");
    expect(body).toContain("+3.2%");
  });

  it("non-owner gets 403 for an existing row that belongs to someone else (distinct from 404)", async () => {
    const memberA = makeMember({ id: "member_a", email: "a@example.com" });
    new MemberRepository(db).upsert(memberA);
    const id = seedProposal(db, { ownerId: "member_a" });

    const { token: tokenB } = seedMemberWithToken({ id: "member_b", email: "b@example.com" });
    const response = await authed(`/proposal/${id}`, tokenB);
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).toContain("403 无权访问");
    expect(body).toContain("这是其他成员的私有内容");
  });

  it("resolves the row BEFORE the ownership check: a non-existent id 404s even for a member who owns nothing", async () => {
    const { token } = seedMemberWithToken();
    const response = await authed("/proposal/still-does-not-exist", token);
    expect(response.status).toBe(404); // never 403 for a row that doesn't exist
  });

  describe("all status badges render their Chinese label", () => {
    const cases: Array<{ status: string; label: string }> = [
      { status: "pending", label: "待审批" },
      { status: "approved", label: "已批准" },
      { status: "approved_half", label: "部分批准" },
      { status: "rejected", label: "已拒绝" },
      { status: "expired", label: "已过期" },
      { status: "executed", label: "已批准·已成交" },
      { status: "failed", label: "熔断暂停" }
    ];

    for (const { status, label } of cases) {
      it(`status=${status} -> ${label}`, async () => {
        const { member, token } = seedMemberWithToken();
        const id = seedProposal(db, { ownerId: member.id, status });
        const response = await authed(`/proposal/${id}`, token);
        const body = await response.text();
        expect(body).toContain(label);
      });
    }
  });

  it("renders 待 P6/P9 完善 when outcome is null", async () => {
    const { member, token } = seedMemberWithToken();
    const id = seedProposal(db, { ownerId: member.id, outcome: null });
    const response = await authed(`/proposal/${id}`, token);
    const body = await response.text();
    expect(body).toContain("待 P6/P9 完善");
  });

  it("carries the CSP nonce and makes no third-party requests", async () => {
    const { member, token } = seedMemberWithToken();
    const id = seedProposal(db, { ownerId: member.id });
    const response = await authed(`/proposal/${id}`, token);
    const csp = response.headers.get("content-security-policy") ?? "";
    const nonceMatch = /nonce-([^']+)/u.exec(csp);
    expect(nonceMatch).not.toBeNull();
    const body = await response.text();
    expect(body).toContain(`nonce="${nonceMatch?.[1]}"`);
    expect(body).not.toMatch(/https?:\/\//iu);
  });

  // Phase 6 Task 6 (2026-07-15 plan): approved_half must render distinctly
  // AND its timeline must show the half-quantity - since the proposals DDL
  // is frozen, the half quantity is never a stored column; it is recomputed
  // at display time from the original quantity via Math.max(1,
  // Math.floor(quantity/2)) (the exact rounding rule the approve-half CLI
  // command itself applies).
  describe("approved_half rendering (Phase 6 Task 6)", () => {
    it("renders the 部分批准 pill distinctly from plain 已批准", async () => {
      const { member, token } = seedMemberWithToken();
      const id = seedProposal(db, { ownerId: member.id, status: "approved_half" });
      const response = await authed(`/proposal/${id}`, token);
      const body = await response.text();
      expect(body).toContain("部分批准");
      expect(body).not.toContain(">已批准<");
    });

    it("the timeline shows the half quantity computed from the original request (qty=15 -> 7)", async () => {
      const { member, token } = seedMemberWithToken();
      const id = seedProposal(db, {
        ownerId: member.id,
        quantity: 15,
        status: "approved_half",
        decidedAt: "2026-07-10T01:00:00.000Z",
        decidedBy: "member_admin"
      });

      const response = await authed(`/proposal/${id}`, token);
      const body = await response.text();

      expect(body).toContain("数量减半至 7 股");
      expect(body).toContain("原申请 15 股");
    });

    it("qty=1 halves to 1, not 0 (Math.max(1, Math.floor(1/2)))", async () => {
      const { member, token } = seedMemberWithToken();
      const id = seedProposal(db, {
        ownerId: member.id,
        quantity: 1,
        status: "approved_half",
        decidedAt: "2026-07-10T01:00:00.000Z",
        decidedBy: "member_admin"
      });

      const response = await authed(`/proposal/${id}`, token);
      const body = await response.text();

      expect(body).toContain("数量减半至 1 股");
    });

    it("a plain 已批准 (not approved_half) proposal shows no half-quantity note", async () => {
      const { member, token } = seedMemberWithToken();
      const id = seedProposal(db, {
        ownerId: member.id,
        quantity: 15,
        status: "approved",
        decidedAt: "2026-07-10T01:00:00.000Z",
        decidedBy: "member_admin"
      });

      const response = await authed(`/proposal/${id}`, token);
      const body = await response.text();

      expect(body).not.toContain("数量减半");
    });
  });

  // Phase 6 Task 6: lifecycle-derived timeline events. The lifecycle row is
  // located by `ticket_prop_<proposalId>` - the exact same deterministic id
  // apps/broker-executor/src/server.ts's deriveTicketId produces.
  describe("timeline: lifecycle events (Phase 6 Task 6)", () => {
    function seedLifecycleRow(
      targetDb: DatabaseSync,
      opts: {
        proposalId: string;
        ownerId: string;
        symbol?: string;
        side?: string;
        quantity?: number;
        brokerStatus?: string;
        lifecycleStage?: string;
        submittedAt?: string;
        lastObservedAt?: string;
      }
    ): void {
      targetDb
        .prepare(`
          INSERT INTO official_paper_order_lifecycle
            (id, ticket_id, external_order_id, provider, environment, account_mode, symbol, asset_class,
             side, quantity, limit_price, broker_status, local_status, lifecycle_stage, submitted_at,
             last_observed_at, raw, notes, owner_id)
          VALUES (?, ?, NULL, 'longbridge-paper', 'paper', 'paper', ?, 'stock', ?, ?, NULL, ?, 'pending', ?, ?, ?, 'null', '[]', ?)
        `)
        .run(
          createId("lifecycle"),
          `ticket_prop_${opts.proposalId}`,
          opts.symbol ?? "NVDA.US",
          opts.side ?? "buy",
          opts.quantity ?? 10,
          opts.brokerStatus ?? "New",
          opts.lifecycleStage ?? "submitted",
          opts.submittedAt ?? "2026-07-10T01:05:00.000Z",
          opts.lastObservedAt ?? "2026-07-10T01:10:00.000Z",
          opts.ownerId
        );
    }

    it("adds a submission event and a latest-observed-state event when a lifecycle row exists", async () => {
      const { member, token } = seedMemberWithToken();
      const id = seedProposal(db, { ownerId: member.id, status: "approved" });
      seedLifecycleRow(db, {
        proposalId: id,
        ownerId: member.id,
        brokerStatus: "New",
        lifecycleStage: "submitted",
        submittedAt: "2026-07-10T01:05:00.000Z",
        lastObservedAt: "2026-07-10T01:10:00.000Z"
      });

      const response = await authed(`/proposal/${id}`, token);
      const body = await response.text();

      expect(body).toContain("2026-07-10T01:05:00.000Z");
      expect(body).toContain("已提交至券商");
      expect(body).toContain("2026-07-10T01:10:00.000Z");
      expect(body).toContain("最新状态");
      expect(body).toContain("New");
    });

    it("does not add lifecycle events when no matching lifecycle row exists (e.g. a rejected proposal)", async () => {
      const { member, token } = seedMemberWithToken();
      const id = seedProposal(db, { ownerId: member.id, status: "rejected" });

      const response = await authed(`/proposal/${id}`, token);
      const body = await response.text();

      expect(body).not.toContain("已提交至券商");
      expect(body).not.toContain("最新状态");
    });

    it("does not leak another proposal's lifecycle row (ticket ids are per-proposal)", async () => {
      const { member, token } = seedMemberWithToken();
      const id = seedProposal(db, { ownerId: member.id, status: "approved" });
      const otherId = seedProposal(db, { ownerId: member.id, status: "approved" });
      seedLifecycleRow(db, { proposalId: otherId, ownerId: member.id, symbol: "TSLA.US" });

      const response = await authed(`/proposal/${id}`, token);
      const body = await response.text();

      expect(body).not.toContain("已提交至券商");
      expect(body).not.toContain("TSLA.US");
    });
  });
});
