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

  describe("all five status badges render their Chinese label", () => {
    const cases: Array<{ status: string; label: string }> = [
      { status: "pending", label: "待审批" },
      { status: "approved", label: "已批准" },
      { status: "rejected", label: "已拒绝" },
      { status: "expired", label: "已过期" },
      { status: "executed", label: "已批准·已成交" }
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
});
